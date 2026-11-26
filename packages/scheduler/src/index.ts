import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	diagnosticExcerpt,
	type EventBus,
	type FinishedJob,
	type HostProcessSnapshot,
	isFinishedJob,
	type Job,
	jobFailure,
	type JobSpec,
	Mailbox,
	newId,
	type PoolInfo,
	type ResourceScheduler,
	runCommand,
	type SecretBroker,
	type Store,
	type ToolDefinition,
} from "@one-piece/core";
import { compilerSmoke } from "./compiler-smoke.ts";
import { digestInput, digestInputSync } from "./input-files.ts";
import { acquireLease, admit, executionFailure, passGate, succeed, withdraw } from "./job-transitions.ts";
import { fingerprintOutputFile, outputVersion, validateOutputFiles } from "./output-files.ts";

interface PoolFields {
	name: string;
	unit: string;
	capacity: number;
	kind: "local" | "command";
	cache?: boolean;
	capUnits?: number;
	usdPerUnit?: number;
	description?: string;
}

type Launcher = [string, ...string[]];
export type PoolConfig = PoolFields & (
	| { readyTimeoutSeconds?: never; requireQuietHost?: false; commandPrefix?: string[]; hostProcessNames?: string[] }
	| { readyTimeoutSeconds: number; requireQuietHost?: false; commandPrefix: Launcher; hostProcessNames?: string[] }
	| { readyTimeoutSeconds: number; requireQuietHost: true; commandPrefix: Launcher; hostProcessNames: [string, ...string[]] }
);

export interface SchedulerHost {
	readonly runId: string;
	readonly bus: EventBus;
	readonly store: Store;
	readonly secrets?: SecretBroker;
	isRunActive(): boolean;
	workspaceOf(agentId: string): string | undefined;
	taskIdOf?(agentId: string): string | undefined;
	signalOf?(agentId: string): AbortSignal | undefined;
	deniedReadPathsOf?(agentId: string): readonly string[] | undefined;
	availableBudget?(unit: string): number;
	chargeUnits?(agentId: string, usage: Record<string, number>): void;
	priorityOf?(job: Job): number;
}

type Pool = PoolConfig & {
	occupancy: { kind: "exclusive"; jobId: string } | { kind: "shared"; jobs: Set<string> };
	spentUnits: number;
};

type PoolCommand =
	| { type: "dispatch" }
	| { type: "completed"; result: FinishedJob }
	| { type: "release"; jobId: string };

type ExecutionAdmission =
	| { phase: "preflight" }
	| { phase: "admitted"; outputBefore: ReadonlyMap<string, string | undefined> };

type SchedulerLifecycle =
	| { phase: "open" }
	| { phase: "draining"; done: Promise<void> }
	| { phase: "closed" };

interface Entry {
	job: Job;
	waiters: Array<(job: FinishedJob) => void>;
	abort: AbortController;
}

type InputSnapshot = { cwd: string; hashes: Record<string, string> };

function sha(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function hostProcesses(executableNames: string[]): HostProcessSnapshot {
	const sampledAt = Date.now();
	const listing = spawnSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8", timeout: 1500, maxBuffer: 256 * 1024 });
	const snapshot: HostProcessSnapshot = { sampledAt, executableNames, readable: listing.status === 0, processCount: 0, matches: [] };
	if (!snapshot.readable) return snapshot;
	for (const line of listing.stdout.split("\n")) {
		const row = /^\s*(\d+)\s+(.+)$/.exec(line);
		if (!row) continue;
		snapshot.processCount += 1;
		const executable = basename(row[2]!);
		if (executableNames.includes(executable)) snapshot.matches.push({ pid: Number(row[1]), executable });
	}
	return snapshot;
}

/**
 * Topology-agnostic v2 Resource Scheduler.
 * Preserves quiet-host Mac GPU leases (FD-3 handshake), preflight gates, compiler smoke pinning,
 * input hashing, output fingerprinting & staleness checks, idempotency keys, and content-addressed caching.
 */
export class Scheduler implements ResourceScheduler {
	private readonly poolMap = new Map<string, Pool>();
	private readonly entries = new Map<string, Entry>();
	private readonly checkingGates = new Set<string>();
	private readonly hostWaiters = new Set<() => void>();
	private hostPreparations = 0;
	private readonly host: SchedulerHost;
	private lifecycle: SchedulerLifecycle = { phase: "open" };
	private readonly poolActor: Mailbox<PoolCommand>;

	constructor(host: SchedulerHost, pools: PoolConfig[]) {
		this.host = host;
		this.poolActor = new Mailbox<PoolCommand>((message) => this.receivePool(message));
		const history = host.store.list("jobs", { runId: host.runId });
		for (const p of pools) {
			if (!p.name || this.poolMap.has(p.name) || !Number.isSafeInteger(p.capacity) || p.capacity < 1) {
				throw new Error(`Pool ${p.name} needs a unique name and positive integer capacity`);
			}
			if (p.capUnits !== undefined && (!Number.isFinite(p.capUnits) || p.capUnits < 0)) {
				throw new Error(`Pool ${p.name} needs a non-negative spend cap`);
			}
			if (p.readyTimeoutSeconds !== undefined && (!p.commandPrefix?.length || !Number.isFinite(p.readyTimeoutSeconds) || p.readyTimeoutSeconds <= 0)) {
				throw new Error(`Pool ${p.name} needs a command prefix and a positive lease timeout`);
			}
			if (p.requireQuietHost && (p.readyTimeoutSeconds === undefined || !p.hostProcessNames?.length)) {
				throw new Error(`Pool ${p.name} needs a lease handshake and host process names for a quiet-host requirement`);
			}
			const spentUnits = history.reduce((total, job) => total + (job.spec.pool === p.name && job.status !== "cached" ? job.unitsUsed ?? 0 : 0), 0);
			this.poolMap.set(p.name, { ...structuredClone(p), cache: p.cache ?? p.kind === "local", occupancy: { kind: "shared", jobs: new Set() }, spentUnits });
		}
	}

	poolConfigs(): PoolConfig[] {
		return [...this.poolMap.values()].map(({ occupancy: _occ, spentUnits: _spent, ...config }) => structuredClone(config));
	}

	submit(agentId: string, spec: JobSpec, snapshot?: InputSnapshot): Job {
		const key = spec.idempotencyKey;
		const taskId = this.host.taskIdOf?.(agentId);
		if (key !== undefined) {
			if (!key.trim() || key.length > 200) throw new Error("A request key must contain 1 to 200 characters");
			const existing = this.host.store.list("jobs", { runId: this.host.runId }).find(
				(job) => job.nodeId === agentId && job.taskId === taskId && job.spec.idempotencyKey === key && !job.resumesJobId,
			);
			if (existing) {
				if (!isDeepStrictEqual(JSON.parse(JSON.stringify(existing.spec)), JSON.parse(JSON.stringify(spec)))) {
					throw new Error(`Request key already identifies job ${existing.id} with a different specification`);
				}
				return this.get(existing.id)!;
			}
		}
		return this.enqueue(agentId, structuredClone(spec), undefined, snapshot);
	}

	async snapshotInputs(agentId: string, spec: JobSpec, previous?: Job): Promise<InputSnapshot | undefined> {
		if (!spec.inputs?.length) return;
		const cwd = previous ? this.jobDirectory(previous) : this.cwdOf(agentId, spec.cwd);
		const signal = this.host.signalOf?.(agentId) ?? new AbortController().signal;
		const hashes: Record<string, string> = Object.create(null);
		const denied = this.host.deniedReadPathsOf?.(agentId);
		await this.prepareOnHost(signal, async () => {
			for (const path of spec.inputs ?? []) hashes[path] = await digestInput(cwd, path, signal, denied);
		});
		return { cwd, hashes };
	}

	restoreQueued(job: Extract<Job, { status: "queued" }>): boolean {
		if (this.lifecycle.phase !== "open" || !this.host.isRunActive() || job.runId !== this.host.runId || !this.poolMap.has(job.spec.pool)) {
			return false;
		}
		if (this.entries.has(job.id)) return true;
		this.entries.set(job.id, { job: structuredClone(job), waiters: [], abort: new AbortController() });
		this.host.bus.emit(job.runId, "job.recovered", { jobId: job.id, pool: job.spec.pool }, job.nodeId);
		this.poolActor.send({ type: "dispatch" });
		return true;
	}

	withdraw(agentId: string, jobId: string, reason: string, reusedJobId?: string): FinishedJob {
		const entry = this.entries.get(jobId);
		const job = this.get(jobId);
		if (!job || job.runId !== this.host.runId || job.nodeId !== agentId) {
			throw new Error("Choose a pending job you own");
		}
		if (job.status === "cancelled" && job.withdrawal) return job;
		if (!entry || (job.status !== "queued" && job.status !== "gated")) {
			throw new Error(`Job ${jobId} is ${job.status}. Only queued jobs and jobs in preflight can be withdrawn.`);
		}
		const note = reason.trim();
		if (!note || note.length > 500) throw new Error("Give a withdrawal reason of 1 to 500 characters");
		if (reusedJobId !== undefined) {
			const source = this.get(reusedJobId);
			if (!source || source.runId !== this.host.runId || (source.status !== "succeeded" && source.status !== "cached")) {
				throw new Error("Cite a successful or cached job from this run");
			}
		}
		const cancelled = withdraw(job, Date.now(), { reason: this.host.bus.redactor.redactText(note), reusedJobId });
		entry.abort.abort();
		this.finish(entry, cancelled);
		this.poolActor.send({ type: "dispatch" });
		return structuredClone(cancelled);
	}

	resume(agentId: string, jobId: string, changes: { command?: string; gate?: string; compilerSmoke?: boolean } = {}, snapshot?: InputSnapshot): Job {
		const previous = this.get(jobId);
		if (!previous || previous.runId !== this.host.runId || previous.nodeId !== agentId) throw new Error("Unknown job");
		if (previous.status !== "failed" && previous.status !== "cancelled") throw new Error("Only a failed or cancelled job can be resumed");
		const spec = {
			...previous.spec,
			command: changes.command ?? previous.spec.command,
			gate: changes.gate ?? previous.spec.gate,
			compilerSmoke: changes.compilerSmoke ?? previous.spec.compilerSmoke,
		};
		const next = this.host.store.list("jobs", { runId: this.host.runId }).find((job) => job.resumesJobId === jobId);
		if (next) {
			if (next.spec.command === spec.command && next.spec.gate === spec.gate && next.spec.compilerSmoke === spec.compilerSmoke) return this.get(next.id)!;
			throw new Error(`Job ${jobId} already has a recovery attempt ${next.id}; check that receipt first`);
		}
		const recovery = { jobId, cwd: previous.workingDirectory ?? this.cwdOf(agentId, spec.cwd, false) };
		return this.enqueue(agentId, spec, recovery, snapshot);
	}

	private enqueue(agentId: string, spec: JobSpec, recovery?: { jobId: string; cwd: string }, snapshot?: InputSnapshot): Job {
		if (this.lifecycle.phase !== "open" || !this.host.isRunActive()) throw new Error("This run cannot queue work");
		const pool = this.poolMap.get(spec.pool);
		if (!pool) throw new Error(`Unknown pool ${spec.pool}. Pools: ${[...this.poolMap.keys()].join(", ")}`);
		const units = spec.units ?? 1;
		if (!Number.isFinite(units) || units < 0 || (pool.capUnits !== undefined && units === 0)) {
			throw new Error("Supply a valid positive reservation for a capped pool");
		}
		const reserved = this.reservedUnits(pool.name);
		if (pool.capUnits !== undefined && pool.spentUnits + reserved + units > pool.capUnits) {
			throw new Error(`Pool ${pool.name} hit its spend cap (${pool.capUnits} ${pool.unit}, ${reserved} reserved)`);
		}
		const available = this.host.availableBudget?.(pool.unit) ?? Infinity;
		if (available < units + reserved) {
			throw new Error(`Not enough ${pool.unit} budget (${available} left, ${reserved} reserved, ${units} requested)`);
		}
		if (spec.outputFiles) validateOutputFiles(spec.outputFiles);
		if (spec.requireOutputs && !spec.outputFiles?.length) throw new Error("require_outputs needs at least one output_files path");
		const cwd = recovery ? this.existingDirectory(recovery.cwd) : this.cwdOf(agentId, spec.cwd);
		if (snapshot && snapshot.cwd !== cwd) throw new Error("Job directory changed during input verification");
		const resumesJobId = recovery?.jobId;
		const denied = this.host.deniedReadPathsOf?.(agentId);
		const inputHashes = snapshot?.hashes ?? Object.fromEntries((spec.inputs ?? []).map((path) => [path, digestInputSync(cwd, path, denied)]));
		const cacheKey = sha(JSON.stringify(["workspace-v2", this.host.runId, cwd, spec.pool, spec.command, inputHashes, spec.idempotencyKey ?? ""]));
		const now = Date.now();
		const taskId = this.host.taskIdOf?.(agentId);

		const cached = !resumesJobId && this.cacheable(spec, pool) && !Object.values(inputHashes).includes("missing")
			? this.host.store.get("job_cache", cacheKey)
			: undefined;
		const previous = cached ? this.host.store.get("jobs", cached.jobId) : undefined;
		if (previous && previous.status === "succeeded") {
			const hit: Job = { ...previous, id: newId("job"), runId: this.host.runId, nodeId: agentId, taskId, spec, status: "cached", queuedAt: now, startedAt: now, finishedAt: now };
			this.host.bus.save("jobs", hit, agentId);
			this.host.bus.emit(this.host.runId, "job.cached", { jobId: hit.id, from: previous.id, pool: pool.name }, agentId);
			this.entries.set(hit.id, { job: hit, waiters: [], abort: new AbortController() });
			return structuredClone(hit);
		}
		const attempt = {
			id: newId("job"),
			runId: this.host.runId,
			nodeId: agentId,
			taskId,
			resumesJobId,
			workingDirectory: cwd,
			cacheKey,
			queuedAt: now,
			receipt: { inputHashes, inputHashAlgorithm: "sha256" as const, host: hostname(), durationMs: 0 },
		};
		const job: Job = spec.gate
			? { ...attempt, spec: { ...spec, gate: spec.gate }, status: "gated" }
			: spec.compilerSmoke
				? { ...attempt, spec: { ...spec, compilerSmoke: true }, status: "gated" }
				: { ...attempt, spec, status: "queued" };
		this.entries.set(job.id, { job, waiters: [], abort: new AbortController() });
		this.host.bus.save("jobs", job, agentId);
		this.host.bus.emit(this.host.runId, "job.submitted", { jobId: job.id, resumesJobId, pool: pool.name, units, gated: job.status === "gated" }, agentId);
		this.poolActor.send({ type: "dispatch" });
		return structuredClone(this.entries.get(job.id)!.job);
	}

	private cacheable(spec: JobSpec, pool: Pool): boolean {
		return spec.cache === true && pool.cache !== false && !spec.gate && !spec.compilerSmoke && !spec.exclusive
			&& !spec.outputFiles?.length && !spec.capabilities?.length;
	}

	private reservedUnits(poolName: string): number {
		return [...this.entries.values()]
			.filter(({ job }) => !isFinishedJob(job) && job.spec.pool === poolName)
			.reduce((total, { job }) => total + (job.spec.units ?? 1), 0);
	}

	get(jobId: string): Job | undefined {
		const entry = this.entries.get(jobId);
		return entry ? structuredClone(entry.job) : this.host.store.get("jobs", jobId);
	}

	wait(jobId: string, signal?: AbortSignal): Promise<FinishedJob> {
		if (signal?.aborted) return Promise.reject(new Error("stopped"));
		const job = this.get(jobId);
		if (!job) return Promise.reject(new Error(`Unknown job ${jobId}`));
		if (isFinishedJob(job)) return Promise.resolve(job);
		const entry = this.entries.get(jobId);
		if (!entry) return Promise.reject(new Error(`Job ${jobId} was interrupted; its execution state needs reconciliation`));
		return new Promise((resolve, reject) => {
			const wake = (finished: FinishedJob) => {
				signal?.removeEventListener("abort", abort);
				resolve(structuredClone(finished));
			};
			const abort = () => {
				const index = entry.waiters.indexOf(wake);
				if (index !== -1) entry.waiters.splice(index, 1);
				reject(new Error("stopped"));
			};
			entry.waiters.push(wake);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}

	materializeOutputs(jobId: string, paths: readonly string[], workspace: string): string {
		validateOutputFiles(paths);
		const job = this.get(jobId);
		if (job?.status !== "succeeded" || !paths.length) throw new Error("A handoff requires a successful job and at least one output file");
		const cwd = this.jobDirectory(job);
		const inputs = paths.map((path) => {
			const expected = job.receipt?.outputFiles?.find((file) => file.path === path);
			if (!expected || expected.sha256 === undefined) throw new Error(`No output fingerprint for ${path}`);
			let data: Buffer | undefined;
			const current = fingerprintOutputFile(cwd, path, (buffer) => { data = buffer; });
			if (!data || current.sha256 === undefined || current.sha256 !== expected.sha256 || current.bytes !== expected.bytes) {
				throw new Error(`Job output no longer matches its receipt: ${path}`);
			}
			return { path, data };
		});
		const root = mkdtempSync(join(realpathSync(workspace), "job-input-"));
		try {
			for (const { path, data } of inputs) {
				const destination = join(root, path);
				mkdirSync(dirname(destination), { recursive: true });
				writeFileSync(destination, data, { flag: "wx" });
			}
		} catch (error) {
			rmSync(root, { recursive: true, force: true });
			throw error;
		}
		return basename(root);
	}

	cancelOwner(agentId: string): void {
		for (const entry of this.entries.values()) {
			if (entry.job.nodeId !== agentId || isFinishedJob(entry.job)) continue;
			this.cancel(entry);
		}
		this.poolActor.send({ type: "dispatch" });
	}

	close(): Promise<void> {
		return this.dispose();
	}

	dispose(): Promise<void> {
		if (this.lifecycle.phase === "draining") return this.lifecycle.done;
		if (this.lifecycle.phase === "closed") return Promise.resolve();
		const done = Promise.resolve().then(async () => {
			for (const wake of [...this.hostWaiters]) wake();
			const active = [...this.entries.values()].filter((entry) => !isFinishedJob(entry.job));
			const settled = active.map((entry) => this.wait(entry.job.id));
			for (const entry of active) this.cancel(entry);
			await Promise.all(settled);
		}).finally(() => { this.lifecycle = { phase: "closed" }; });
		this.lifecycle = { phase: "draining", done };
		return done;
	}

	pools(): PoolInfo[] {
		return [...this.poolMap.values()].map((p) => ({
			name: p.name,
			unit: p.unit,
			capacity: p.capacity,
			running: [...this.entries.values()].filter((e) => e.job.spec.pool === p.name && e.job.status === "running").length,
			queued: [...this.entries.values()].filter((e) => e.job.spec.pool === p.name && ["queued", "gated", "leasing"].includes(e.job.status)).length,
			spentUnits: p.spentUnits,
			capUnits: p.capUnits,
			description: p.description,
		}));
	}

	private cancel(entry: Entry): void {
		entry.abort.abort();
		if (entry.job.status === "queued" || entry.job.status === "gated") {
			this.finish(entry, { ...entry.job, finishedAt: Date.now(), status: "cancelled" });
		}
	}

	private cwdOf(agentId: string, sub?: string, create = true): string {
		const base = this.host.workspaceOf(agentId) ?? join(process.cwd(), ".one_piece", "jobs", agentId);
		if (create) mkdirSync(base, { recursive: true });
		const root = realpathSync(base);
		const cwd = realpathSync(resolve(root, sub ?? "."));
		const local = relative(root, cwd);
		if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) throw new Error("Job directory must stay inside its workspace");
		if (!statSync(cwd).isDirectory()) throw new Error("Job cwd must name a directory");
		return cwd;
	}

	private existingDirectory(path: string): string {
		if (!existsSync(path) || realpathSync(path) !== path || !statSync(path).isDirectory()) {
			throw new Error("The previous job directory is missing or has moved");
		}
		return path;
	}

	private jobDirectory(job: Job): string {
		return job.resumesJobId && job.workingDirectory
			? this.existingDirectory(job.workingDirectory)
			: this.cwdOf(job.nodeId, job.spec.cwd);
	}

	private async runGate(jobId: string): Promise<void> {
		const entry = this.entries.get(jobId)!;
		const { job } = entry;
		if (job.status !== "gated") return;
		try {
			let toolchain: Record<string, string> | undefined;
			if (job.spec.compilerSmoke) {
				toolchain = await compilerSmoke(entry.abort.signal);
				if (job.receipt) job.receipt.toolchain = toolchain;
			}
			if (job.spec.gate) {
				const result = await runCommand({
					command: job.spec.gate,
					cwd: this.jobDirectory(job),
					profile: "job",
					deniedReadPaths: this.host.deniedReadPathsOf?.(job.nodeId),
					timeoutMs: 120_000,
					signal: entry.abort.signal,
					env: toolchain,
				});
				if (isFinishedJob(entry.job)) return;
				if (result.exitCode !== 0 || result.timedOut) {
					const detail = diagnosticExcerpt(`${result.stdout}\n${result.stderr}`) || `Gate exited ${result.exitCode}. Check: ${job.spec.gate}`;
					this.finish(entry, {
						...job,
						finishedAt: Date.now(),
						status: "failed",
						failureStage: "gate",
						failureDetail: detail,
						exitCode: result.exitCode,
						stderr: `Gate failed, job never entered the pool:\n${result.stdout}\n${result.stderr}`,
					});
					return;
				}
			}
		} catch (error) {
			if (!isFinishedJob(entry.job)) {
				this.finish(entry, { ...job, finishedAt: Date.now(), status: "failed", failureStage: "gate", stderr: String(error) });
			}
			return;
		}
		if (isFinishedJob(entry.job)) return;
		entry.job = passGate(job);
		this.host.bus.save("jobs", entry.job, entry.job.nodeId);
	}

	private locallyContends(pool: Pool): boolean {
		return pool.kind === "local" || pool.name === "deployment";
	}

	private occupied(pool: Pool): boolean {
		return pool.occupancy.kind === "exclusive" || pool.occupancy.jobs.size > 0;
	}

	private macPool(): Pool | undefined {
		const mac = this.poolMap.get("mac-gpu");
		return mac?.requireQuietHost ? mac : undefined;
	}

	private macWaiting(): boolean {
		return !!this.macPool() && [...this.entries.values()].some(({ job }) => job.spec.pool === "mac-gpu" && job.status === "queued");
	}

	private async prepareOnHost<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
		const mac = this.macPool();
		while (mac && (this.occupied(mac) || this.macWaiting())) {
			if (this.lifecycle.phase !== "open") throw new Error("Scheduler is closing");
			signal.throwIfAborted();
			await new Promise<void>((resolve, reject) => {
				const wake = () => { cleanup(); resolve(); };
				const abort = () => { cleanup(); reject(signal.reason); };
				const cleanup = () => {
					this.hostWaiters.delete(wake);
					signal.removeEventListener("abort", abort);
				};
				this.hostWaiters.add(wake);
				signal.addEventListener("abort", abort, { once: true });
			});
		}
		if (this.lifecycle.phase !== "open") throw new Error("Scheduler is closing");
		signal.throwIfAborted();
		this.hostPreparations++;
		try { return await operation(); } finally {
			this.hostPreparations--;
			this.poolActor.send({ type: "dispatch" });
		}
	}

	private launchGates(): void {
		const mac = this.macPool();
		if (mac && (this.occupied(mac) || this.macWaiting())) return;
		const capacity = this.poolMap.get("cpu")?.capacity ?? 1;
		for (const { job } of this.entries.values()) {
			if (this.checkingGates.size >= capacity) break;
			if (job.status !== "gated" || this.checkingGates.has(job.id)) continue;
			this.checkingGates.add(job.id);
			void this.runGate(job.id).finally(() => {
				this.checkingGates.delete(job.id);
				this.poolActor.send({ type: "dispatch" });
			});
		}
	}

	private priority(job: Job): number {
		return this.host.priorityOf?.(job) ?? job.queuedAt;
	}

	private receivePool(command: PoolCommand): undefined {
		if (command.type !== "dispatch") {
			const jobId = command.type === "completed" ? command.result.id : command.jobId;
			const entry = this.entries.get(jobId)!;
			const pool = this.poolMap.get(entry.job.spec.pool)!;
			if (pool.occupancy.kind === "exclusive") {
				if (pool.occupancy.jobId !== jobId) return;
				pool.occupancy = { kind: "shared", jobs: new Set() };
			} else if (!pool.occupancy.jobs.delete(jobId)) return;
			if (command.type === "completed") {
				const units = command.result.unitsUsed;
				if (units !== undefined) pool.spentUnits += units;
				this.finish(entry, command.result);
				if (units !== undefined) {
					this.host.chargeUnits?.(entry.job.nodeId, { [pool.unit]: units, usd: units * (pool.usdPerUnit ?? 0) });
				}
			}
		}
		if (this.lifecycle.phase !== "open" || !this.host.isRunActive()) return;
		this.launchGates();
		const mac = this.macPool();
		for (const pool of this.poolMap.values()) {
			if (mac && pool === mac && (this.hostPreparations || this.checkingGates.size || [...this.poolMap.values()].some((other) => other !== mac && this.locallyContends(other) && this.occupied(other)))) {
				continue;
			}
			if (mac && pool !== mac && this.locallyContends(pool) && (this.occupied(mac) || this.macWaiting())) continue;
			const queued = [...this.entries.values()].filter((e) => e.job.spec.pool === pool.name && e.job.status === "queued");
			queued.sort((a, b) => this.priority(a.job) - this.priority(b.job));
			for (const entry of queued) {
				if (pool.occupancy.kind === "exclusive" || pool.occupancy.jobs.size >= pool.capacity) break;
				const job = entry.job;
				if (job.status !== "queued") continue;
				if (job.spec.exclusive && pool.occupancy.jobs.size > 0) break;
				if (job.spec.exclusive) pool.occupancy = { kind: "exclusive", jobId: job.id };
				else pool.occupancy.jobs.add(job.id);
				void this.execute(pool, entry, job).then((result) =>
					this.poolActor.send(result ? { type: "completed", result } : { type: "release", jobId: job.id }),
				);
			}
		}
		if (!mac || (!this.occupied(mac) && !this.macWaiting())) for (const wake of [...this.hostWaiters]) wake();
	}

	private async execute(pool: Pool, entry: Entry, job: Extract<Job, { status: "queued" }>): Promise<FinishedJob | undefined> {
		const execution: { admission: ExecutionAdmission } = { admission: { phase: "preflight" } };
		const admissionCheck = pool.requireQuietHost
			? () => {
				const snapshot = hostProcesses(pool.hostProcessNames!);
				if (job.receipt) job.receipt.hostProcessSnapshot = snapshot;
				if (!snapshot.readable) return "host process inventory was unavailable";
				if (snapshot.matches.length) return `configured processes are active: ${snapshot.matches.map(({ executable }) => executable).join(", ")}`;
			}
			: undefined;

		try {
			if (pool.readyTimeoutSeconds !== undefined || job.spec.inputs?.length) {
				entry.job = acquireLease(job);
				this.host.bus.save("jobs", entry.job, job.nodeId);
				this.host.bus.emit(job.runId, "job.leasing", { jobId: job.id, pool: pool.name }, job.nodeId);
			}
			const cwd = this.jobDirectory(job);
			if (job.spec.compilerSmoke && !job.receipt?.toolchain) throw new Error("The required compiler smoke check has no saved toolchain");
			if (job.workingDirectory !== undefined && job.workingDirectory !== cwd) throw new Error("Job directory changed after submission");
			const denied = this.host.deniedReadPathsOf?.(job.nodeId);
			for (const input of job.spec.inputs ?? []) {
				const digest = await digestInput(cwd, input, entry.abort.signal, denied);
				if (digest !== job.receipt?.inputHashes[input]) throw new Error(`Job input changed after submission: ${input}`);
			}
			entry.abort.signal.throwIfAborted();
			const unitMs = pool.unit.endsWith("minutes") ? 60_000 : 1000;
			const remainingMs = pool.capUnits === undefined ? Infinity : Math.min(job.spec.units ?? 1, pool.capUnits - pool.spentUnits) * unitMs;
			if (remainingMs <= 0) throw new Error(`Pool ${pool.name} has no remaining spend allowance`);
			const markRunning = () => {
				const pending = entry.job;
				if (pending.status !== "queued" && pending.status !== "leasing") throw new Error("Job is no longer awaiting admission");
				execution.admission = { phase: "admitted", outputBefore: new Map((job.spec.outputFiles ?? []).map((path) => [path, outputVersion(cwd, path)])) };
				entry.job = admit(pending, Date.now());
				if (!admissionCheck && pool.hostProcessNames && job.receipt) job.receipt.hostProcessSnapshot = hostProcesses(pool.hostProcessNames);
				this.host.bus.save("jobs", entry.job, job.nodeId);
				this.host.bus.emit(job.runId, "job.started", { jobId: job.id, pool: pool.name, exclusive: !!job.spec.exclusive }, job.nodeId);
			};
			if (pool.readyTimeoutSeconds === undefined) markRunning();
			let env: Record<string, string> = {};
			if (job.spec.capabilities?.length && this.host.secrets) env = this.host.secrets.envFor(job.nodeId, job.spec.capabilities);
			const result = await runCommand({
				command: job.spec.command,
				...(pool.readyTimeoutSeconds === undefined
					? { commandPrefix: pool.commandPrefix }
					: {
						commandPrefix: pool.commandPrefix,
						readyTimeoutMs: pool.readyTimeoutSeconds * 1000,
						onReady: markRunning,
						...(admissionCheck ? { admissionCheck, leasedMacGpu: pool.name === "mac-gpu" && pool.capacity === 1 } : { admissionCheck: undefined, leasedMacGpu: false as const }),
					}),
				cwd,
				profile: pool.kind === "local" ? "job" : "worker",
				deniedReadPaths: denied,
				env: { ...env, ...job.receipt?.toolchain },
				timeoutMs: Math.min((job.spec.timeoutSeconds ?? 600) * 1000, remainingMs),
				signal: entry.abort.signal,
				onOutput: (stdout, stderr) => {
					if (isFinishedJob(entry.job)) return;
					entry.job = { ...entry.job, stdout: this.host.bus.redactor.redactText(stdout), stderr: this.host.bus.redactor.redactText(stderr) };
					this.host.bus.save("jobs", entry.job, job.nodeId);
				},
			});
			const attempt = entry.job;
			if (attempt.status !== "running" && attempt.status !== "leasing") return;
			const admitted = attempt.status === "running";
			const seconds = admitted ? result.durationMs / 1000 : 0;
			const units = pool.unit.endsWith("minutes") ? seconds / 60 : seconds;
			const redact = (s: string) => this.host.bus.redactor.redactText(s);
			let logDetail = "";
			const admission = execution.admission;
			if (admitted && admission.phase !== "admitted") throw new Error("Missing output baseline at execution admission");
			if (admission.phase === "admitted" && job.receipt && job.spec.outputFiles?.length) {
				job.receipt.outputFiles = job.spec.outputFiles.map((path) => {
					const before = admission.outputBefore.get(path);
					const stale = before !== undefined && before === outputVersion(cwd, path);
					const fingerprint = fingerprintOutputFile(cwd, path, (data) => {
						if (stale || result.exitCode === 0 || logDetail || !/\.(log|txt)$/i.test(path)) return;
						const detail = diagnosticExcerpt(redact(data.subarray(-8192).toString("utf8")));
						if (detail) logDetail = `${path}\n${detail}`;
					});
					return stale && fingerprint.sha256 !== undefined ? { path, status: "stale" } : fingerprint;
				});
			}
			const missing = job.spec.requireOutputs
				? job.spec.outputFiles.filter((path) => !job.receipt?.outputFiles?.some((file) => file.path === path && file.sha256 !== undefined))
				: [];
			const succeeded = admitted && result.exitCode === 0 && !result.timedOut && !missing.length;
			const completed = {
				finishedAt: Date.now(),
				stdout: redact(result.stdout),
				stderr: redact(
					result.stderr +
						(admitted
							? result.timedOut ? "\n[execution timed out]" : ""
							: result.timedOut ? "\n[lease acquisition timed out before execution]" : "\n[launcher exited without admission]"),
				),
				unitsUsed: units,
			};
			if (succeeded && !entry.abort.signal.aborted) return succeed(attempt, completed);
			return {
				...executionFailure(attempt, entry.abort.signal.aborted),
				...completed,
				exitCode: result.exitCode,
				failureDetail: logDetail || (admitted && result.exitCode === 0 && !result.timedOut && missing.length
					? `Required job outputs unavailable: ${missing.join(", ")}`
					: undefined),
			};
		} catch (error) {
			const attempt = entry.job;
			if (attempt.status === "leasing" || attempt.status === "running") {
				return { ...executionFailure(attempt, entry.abort.signal.aborted), stderr: String(error) };
			}
			if (attempt.status === "queued") return { ...attempt, status: "failed", failureStage: "admission", finishedAt: Date.now(), stderr: String(error) };
		}
	}

	private finish(entry: Entry, job: FinishedJob): void {
		if (isFinishedJob(entry.job)) return;
		entry.job = job;
		if (job.receipt) job.receipt.durationMs = job.finishedAt - (job.startedAt ?? job.finishedAt);
		this.host.bus.save("jobs", job, job.nodeId);
		if (job.status === "succeeded" && !job.resumesJobId && this.cacheable(job.spec, this.poolMap.get(job.spec.pool)!)) {
			this.host.store.put("job_cache", { id: job.cacheKey, runId: job.runId, jobId: job.id });
		}
		this.host.bus.emit(job.runId, "job.finished", { jobId: job.id, status: job.status, exitCode: job.exitCode, units: job.unitsUsed }, job.nodeId);
		for (const wake of entry.waiters.splice(0)) wake(job);
	}
}

function describeJob(job: Job, opts?: { artifacts?: import("@one-piece/core").ArtifactStore; createdBy?: string; maxInlineBytes?: number }): string {
	const head = `job ${job.id} [${job.spec.pool}] ${job.status}${job.exitCode !== undefined ? ` exit ${job.exitCode}` : ""}${job.unitsUsed ? `, ${job.unitsUsed.toFixed(2)} units` : ""}`;
	const failure = jobFailure(job);
	const outputs = job.receipt?.outputFiles ? `[outputs] ${JSON.stringify(job.receipt.outputFiles)}` : "";
	const body = [failure && JSON.stringify(failure), outputs, job.stdout, job.stderr ? `[stderr]\n${job.stderr}` : ""].filter(Boolean).join("\n");
	if (!body) return head;
	const limit = opts?.maxInlineBytes ?? 4_096;
	const bytes = Buffer.byteLength(body, "utf8");
	if (bytes <= limit) return `${head}\n${body}`;
	if (opts?.artifacts) {
		const rec = opts.artifacts.put(`job-${job.id}`, body, { mimeType: "text/plain", createdBy: opts.createdBy });
		const sliceLen = Math.floor(limit * 0.42);
		return `${head}\n${body.slice(0, sliceLen)}\n\n... [truncated ${bytes} bytes — full log stored as artifact_id=${rec.id} (sha=${rec.sha256.slice(0, 12)}); call read_artifact to inspect] ...\n\n${body.slice(-sliceLen)}`;
	}
	return `${head}\n${body.slice(0, limit)}`;
}

/** Ultra-terse runtime-agnostic MCP/in-process tools for resource-pool jobs. */
export function schedulerTools(
	scheduler: Scheduler,
	opts?: { artifacts?: import("@one-piece/core").ArtifactStore; maxInlineBytes?: number },
): ToolDefinition[] {
	return [
		{
			name: "list_pools",
			description: "List available compute pools (CPU, Mac GPU, remote), capacities, and current occupancy.",
			inputSchema: { type: "object", properties: {} },
			execute() {
				const pools = scheduler.pools();
				if (!pools.length) return { text: "(no pools configured)" };
				return {
					text: pools.map((p) => `${p.name} (${p.unit}): ${p.running}/${p.capacity} running, ${p.queued} queued, spent=${p.spentUnits.toFixed(2)}${p.capUnits ? `/${p.capUnits}` : ""}`).join("\n"),
				};
			},
		},
		{
			name: "submit_job",
			description: "Submit an experiment or benchmark job to a resource pool (returns job ID).",
			inputSchema: {
				type: "object",
				properties: {
					pool: { type: "string" },
					command: { type: "string" },
					label: { type: "string" },
					cwd: { type: "string" },
					gate: { type: "string" },
					cache: { type: "boolean" },
					exclusive: { type: "boolean" },
					output_files: { type: "array", items: { type: "string" } },
					require_outputs: { type: "boolean" },
					timeout_seconds: { type: "number" },
					wait: { type: "boolean", description: "Wait for completion before returning (default false)" },
				},
				required: ["pool", "command"],
			},
			async execute(args, ctx) {
				const outputFiles = Array.isArray(args.output_files) ? args.output_files.filter((f): f is string => typeof f === "string") : undefined;
				const spec: JobSpec = args.require_outputs && outputFiles?.length
					? {
						pool: String(args.pool),
						command: String(args.command),
						label: typeof args.label === "string" ? args.label : undefined,
						cwd: typeof args.cwd === "string" ? args.cwd : undefined,
						gate: typeof args.gate === "string" ? args.gate : undefined,
						cache: typeof args.cache === "boolean" ? args.cache : undefined,
						exclusive: typeof args.exclusive === "boolean" ? args.exclusive : undefined,
						timeoutSeconds: typeof args.timeout_seconds === "number" ? args.timeout_seconds : undefined,
						requireOutputs: true,
						outputFiles: outputFiles as [string, ...string[]],
					}
					: {
						pool: String(args.pool),
						command: String(args.command),
						label: typeof args.label === "string" ? args.label : undefined,
						cwd: typeof args.cwd === "string" ? args.cwd : undefined,
						gate: typeof args.gate === "string" ? args.gate : undefined,
						cache: typeof args.cache === "boolean" ? args.cache : undefined,
						exclusive: typeof args.exclusive === "boolean" ? args.exclusive : undefined,
						timeoutSeconds: typeof args.timeout_seconds === "number" ? args.timeout_seconds : undefined,
						outputFiles,
					};
				const job = scheduler.submit(ctx.agentId, spec);
				if (args.wait) {
					const finished = await scheduler.wait(job.id, ctx.signal);
					return { text: describeJob(finished, { artifacts: opts?.artifacts, createdBy: ctx.agentId, maxInlineBytes: opts?.maxInlineBytes }), isError: finished.status === "failed", data: { jobId: finished.id, status: finished.status } };
				}
				return { text: `Queued ${job.id} on pool "${spec.pool}" (status=${job.status})`, data: { jobId: job.id, status: job.status } };
			},
		},
		{
			name: "job_status",
			description: "Inspect status, receipt fingerprints, and captured output of a submitted job.",
			inputSchema: {
				type: "object",
				properties: { job_id: { type: "string" } },
				required: ["job_id"],
			},
			execute(args, ctx) {
				const job = scheduler.get(String(args.job_id ?? ""));
				if (!job) return { text: `Unknown job ${String(args.job_id ?? "")}`, isError: true };
				return { text: describeJob(job, { artifacts: opts?.artifacts, createdBy: ctx.agentId, maxInlineBytes: opts?.maxInlineBytes }), isError: job.status === "failed" };
			},
		},
		{
			name: "cancel_job",
			description: "Withdraw a queued or gated job you own.",
			inputSchema: {
				type: "object",
				properties: {
					job_id: { type: "string" },
					reason: { type: "string" },
				},
				required: ["job_id", "reason"],
			},
			execute(args, ctx) {
				const cancelled = scheduler.withdraw(ctx.agentId, String(args.job_id ?? ""), String(args.reason ?? "cancelled"));
				return { text: `Withdrew ${cancelled.id}` };
			},
		},
	];
}
