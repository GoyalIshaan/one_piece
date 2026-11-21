import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { arr, bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import {
	defineTool,
	type HarnessApi,
	type HarnessModule,
	type Job,
	type JobSpec,
	newId,
	type NodeContext,
	type PoolInfo,
	type ResourceScheduler,
	runCommand,
	type SwarmNode,
} from "@one-piece/core";

// One scheduler for every scarce resource. Agents submit jobs and park while they wait.
// Queues follow the agent tree (hierarchical fair share), reviewers' promise scores move good
// branches forward, waiting jobs age so nothing starves, and a cheap gate plus a result cache
// keep expensive pools from doing useless or repeated work.

export interface PoolConfig {
	name: string;
	/** Unit charged to budgets: "cpu_seconds", "gpu_minutes"... */
	unit: string;
	/** Jobs that may run at once. */
	capacity: number;
	/** "local" runs in a network-blocked sandbox; "command" runs a command that talks to a remote service (network on). */
	kind: "local" | "command";
	/** Hard cap on units this pool may spend in a run. */
	capUnits?: number;
	/** Dollar cost per unit, charged to `usd`. */
	usdPerUnit?: number;
	description?: string;
}

interface Pool extends PoolConfig {
	running: number;
	exclusive: boolean;
	spentUnits: number;
}

interface Entry {
	job: Job;
	waiters: Array<(job: Job) => void>;
	abort: AbortController;
}

const FINAL = new Set(["succeeded", "failed", "cancelled", "cached"]);

function sha(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export class Scheduler implements ResourceScheduler {
	private readonly poolMap = new Map<string, Pool>();
	private readonly entries = new Map<string, Entry>();
	private readonly harness: HarnessApi;

	constructor(harness: HarnessApi, pools: PoolConfig[]) {
		this.harness = harness;
		for (const p of pools) this.poolMap.set(p.name, { ...p, running: 0, exclusive: false, spentUnits: 0 });
	}

	poolConfigs(): PoolConfig[] {
		return [...this.poolMap.values()];
	}

	submit(nodeId: string, spec: JobSpec): Job {
		const node = this.harness.tree.require(nodeId);
		const pool = this.poolMap.get(spec.pool);
		if (!pool) throw new Error(`Unknown pool ${spec.pool}. Pools: ${[...this.poolMap.keys()].join(", ")}`);
		const units = spec.units ?? 1;
		if (pool.capUnits !== undefined && pool.spentUnits + units > pool.capUnits) throw new Error(`Pool ${pool.name} hit its spend cap (${pool.capUnits} ${pool.unit})`);
		const available = this.harness.tree.available(nodeId, pool.unit);
		if (available < units) throw new Error(`Not enough ${pool.unit} budget (${available} left, ${units} requested); ask your parent`);
		const cwd = this.cwdOf(nodeId, spec.cwd);
		const inputHashes: Record<string, string> = {};
		for (const input of spec.inputs ?? []) {
			const path = join(cwd, input);
			inputHashes[input] = existsSync(path) ? sha(readFileSync(path).toString("base64")) : "missing";
		}
		const cacheKey = sha(JSON.stringify([spec.pool, spec.command, spec.cwd ?? ".", inputHashes, spec.idempotencyKey ?? ""]));
		const now = Date.now();
		const cached = this.harness.store.get<{ id: string; jobId: string }>("job_cache", cacheKey);
		const previous = cached ? this.harness.store.get<Job>("jobs", cached.jobId) : undefined;
		if (previous && previous.status === "succeeded") {
			const hit: Job = { ...previous, id: newId("job"), runId: node.runId, nodeId, status: "cached", queuedAt: now, startedAt: now, finishedAt: now };
			this.harness.bus.save("jobs", hit, nodeId);
			this.harness.bus.emit(node.runId, "job.cached", { jobId: hit.id, from: previous.id, pool: pool.name }, nodeId);
			this.entries.set(hit.id, { job: hit, waiters: [], abort: new AbortController() });
			return hit;
		}
		const job: Job = { id: newId("job"), runId: node.runId, nodeId, spec, status: spec.gate ? "gated" : "queued", cacheKey, queuedAt: now, receipt: { inputHashes, host: hostname(), durationMs: 0 } };
		this.entries.set(job.id, { job, waiters: [], abort: new AbortController() });
		this.harness.bus.save("jobs", job, nodeId);
		this.harness.bus.emit(node.runId, "job.submitted", { jobId: job.id, pool: pool.name, units, gated: !!spec.gate }, nodeId);
		if (spec.gate) void this.runGate(job.id);
		else this.dispatch();
		return job;
	}

	get(jobId: string): Job | undefined {
		return this.entries.get(jobId)?.job ?? this.harness.store.get<Job>("jobs", jobId);
	}

	wait(jobId: string, signal?: AbortSignal): Promise<Job> {
		const entry = this.entries.get(jobId);
		if (!entry) return Promise.reject(new Error(`Unknown job ${jobId}`));
		if (FINAL.has(entry.job.status)) return Promise.resolve(entry.job);
		return new Promise((resolve, reject) => {
			entry.waiters.push(resolve);
			signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
		});
	}

	cancelSubtree(nodeId: string): void {
		const ids = new Set(this.harness.tree.subtree(nodeId).map((n) => n.id));
		for (const entry of this.entries.values()) {
			if (!ids.has(entry.job.nodeId) || FINAL.has(entry.job.status)) continue;
			entry.abort.abort();
			if (entry.job.status !== "running") this.finish(entry, { status: "cancelled" });
		}
	}

	pools(): PoolInfo[] {
		return [...this.poolMap.values()].map((p) => ({
			name: p.name,
			unit: p.unit,
			capacity: p.capacity,
			running: p.running,
			queued: [...this.entries.values()].filter((e) => e.job.spec.pool === p.name && (e.job.status === "queued" || e.job.status === "gated")).length,
			spentUnits: p.spentUnits,
			capUnits: p.capUnits,
		}));
	}

	// ---- internals ----------------------------------------------------------------------

	private cwdOf(nodeId: string, sub?: string): string {
		const base = this.harness.workspaceOf(nodeId) ?? join(process.cwd(), ".one_piece", "jobs", nodeId);
		mkdirSync(base, { recursive: true });
		return sub ? join(base, sub) : base;
	}

	private async runGate(jobId: string): Promise<void> {
		const entry = this.entries.get(jobId)!;
		const result = await runCommand({ command: entry.job.spec.gate!, cwd: this.cwdOf(entry.job.nodeId, entry.job.spec.cwd), profile: "job", timeoutMs: 120_000, signal: entry.abort.signal });
		if (FINAL.has(entry.job.status)) return;
		if (result.exitCode !== 0) {
			this.finish(entry, { status: "failed", exitCode: result.exitCode, stderr: `Gate failed, job never entered the pool:\n${result.stdout}\n${result.stderr}` });
			return;
		}
		entry.job.status = "queued";
		this.harness.bus.save("jobs", entry.job, entry.job.nodeId);
		this.dispatch();
	}

	/** Lower is sooner. Usage relative to the branch's share, minus promise, minus waiting time. */
	private priority(job: Job): number {
		const { tree } = this.harness;
		const node = tree.get(job.nodeId);
		if (!node) return Number.POSITIVE_INFINITY;
		const pool = this.poolMap.get(job.spec.pool)!;
		const lineage = [node, ...tree.ancestors(node.id)].filter((n) => n.parentId);
		let worst = 0;
		for (const member of lineage) {
			const parent = tree.get(member.parentId!);
			const share = parent && parent.budget.tokens ? (member.budget.tokens ?? 0) / parent.budget.tokens : 1;
			const used = this.unitsUsed(member, pool.name);
			const totalUsed = Math.max(1, pool.spentUnits);
			worst = Math.max(worst, used / totalUsed / Math.max(0.01, share));
		}
		const waitedMinutes = (Date.now() - job.queuedAt) / 60_000;
		return worst - 0.5 * node.promise - Math.min(1, waitedMinutes / 10);
	}

	private unitsUsed(node: SwarmNode, pool: string): number {
		const ids = new Set(this.harness.tree.subtree(node.id).map((n) => n.id));
		let used = 0;
		for (const e of this.entries.values()) if (e.job.spec.pool === pool && ids.has(e.job.nodeId)) used += e.job.unitsUsed ?? 0;
		return used;
	}

	private dispatch(): void {
		for (const pool of this.poolMap.values()) {
			const queued = [...this.entries.values()].filter((e) => e.job.spec.pool === pool.name && e.job.status === "queued");
			queued.sort((a, b) => this.priority(a.job) - this.priority(b.job));
			for (const entry of queued) {
				if (pool.exclusive || pool.running >= pool.capacity) break;
				if (entry.job.spec.exclusive && pool.running > 0) break;
				void this.start(pool, entry);
			}
		}
	}

	private async start(pool: Pool, entry: Entry): Promise<void> {
		const { job } = entry;
		pool.running += 1;
		if (job.spec.exclusive) pool.exclusive = true;
		job.status = "running";
		job.startedAt = Date.now();
		this.harness.bus.save("jobs", job, job.nodeId);
		this.harness.bus.emit(job.runId, "job.started", { jobId: job.id, pool: pool.name, exclusive: !!job.spec.exclusive }, job.nodeId);
		let env: Record<string, string> = {};
		try {
			if (job.spec.capabilities?.length) env = this.harness.services.require("secrets").envFor(job.nodeId, job.spec.capabilities);
			const result = await runCommand({
				command: job.spec.command,
				cwd: this.cwdOf(job.nodeId, job.spec.cwd),
				profile: pool.kind === "local" ? "job" : "worker",
				env,
				timeoutMs: (job.spec.timeoutSeconds ?? 600) * 1000,
				signal: entry.abort.signal,
			});
			const seconds = result.durationMs / 1000;
			const units = pool.unit.endsWith("minutes") ? seconds / 60 : seconds;
			const redact = (s: string) => this.harness.bus.redactor.redactText(s);
			this.finish(entry, {
				status: entry.abort.signal.aborted ? "cancelled" : result.exitCode === 0 ? "succeeded" : "failed",
				exitCode: result.exitCode,
				stdout: redact(result.stdout),
				stderr: redact(result.stderr + (result.timedOut ? "\n[timed out]" : "")),
				unitsUsed: units,
			});
			pool.spentUnits += units;
			this.harness.tree.charge(job.nodeId, { [pool.unit]: units, usd: units * (pool.usdPerUnit ?? 0) });
		} catch (error) {
			this.finish(entry, { status: "failed", stderr: String(error) });
		} finally {
			pool.running -= 1;
			if (job.spec.exclusive) pool.exclusive = false;
			this.dispatch();
		}
	}

	private finish(entry: Entry, patch: Partial<Job>): void {
		const job = Object.assign(entry.job, patch, { finishedAt: Date.now() });
		if (job.receipt) job.receipt.durationMs = (job.finishedAt ?? 0) - (job.startedAt ?? job.finishedAt ?? 0);
		this.harness.bus.save("jobs", job, job.nodeId);
		if (job.status === "succeeded") this.harness.store.put("job_cache", { id: job.cacheKey, runId: job.runId, jobId: job.id });
		this.harness.bus.emit(job.runId, "job.finished", { jobId: job.id, status: job.status, exitCode: job.exitCode, units: job.unitsUsed }, job.nodeId);
		for (const wake of entry.waiters.splice(0)) wake(job);
	}
}

function describe(job: Job): string {
	const head = `job ${job.id} [${job.spec.pool}] ${job.status}${job.exitCode !== undefined ? ` exit ${job.exitCode}` : ""}${job.unitsUsed ? `, ${job.unitsUsed.toFixed(2)} units` : ""}`;
	const body = [job.stdout, job.stderr ? `[stderr]\n${job.stderr}` : ""].filter(Boolean).join("\n");
	return body ? `${head}\n${body.slice(0, 8000)}` : head;
}

export function schedulerModule(pools: PoolConfig[]): HarnessModule {
	let scheduler: Scheduler;
	let harness: HarnessApi;
	return {
		manifest: {
			name: "scheduler",
			version: "0.1.0",
			summary: "Queue jobs on constrained resources (CPU, GPU, graders) and wait without spending",
			roles: ["leaf"],
			tools: ["list_pools", "submit_job", "wait_job", "job_status"],
			contextCostTokens: 600,
			pools: pools.map((p) => p.name),
		},
		setup(h) {
			harness = h;
			scheduler = new Scheduler(h, pools);
			h.services.register("scheduler", scheduler);
		},
		prompt() {
			return `Resource pools: ${pools.map((p) => `${p.name} (${p.unit}, ${p.capacity} at once${p.description ? `: ${p.description}` : ""})`).join("; ")}. Submit expensive work with submit_job (add a cheap gate command when you can), then wait_job; waiting costs nothing.`;
		},
		tools(ctx: NodeContext) {
			const { node } = ctx;
			return [
				defineTool({
					name: "list_pools",
					description: "Show resource pools with capacity, queue depth and spend.",
					parameters: obj({}),
					async execute() {
						return scheduler
							.pools()
							.map((p) => `${p.name}: ${p.running}/${p.capacity} running, ${p.queued} queued, spent ${p.spentUnits.toFixed(2)} ${p.unit}${p.capUnits ? ` of ${p.capUnits}` : ""}`)
							.join("\n");
					},
				}),
				defineTool({
					name: "submit_job",
					description: "Queue a command on a resource pool. Returns a job id at once. Identical jobs reuse earlier results.",
					parameters: obj({
						pool: str(),
						command: str(),
						cwd: opt(str()),
						inputs: opt(arr(str(), { description: "Files that identify this job for caching" })),
						units: opt(num({ minimum: 0 })),
						exclusive: opt(bool({ description: "Needs the whole pool, e.g. clean benchmarks" })),
						timeout_seconds: opt(num({ minimum: 1, maximum: 86_400 })),
						capabilities: opt(arr(str())),
						gate: opt(str({ description: "Cheap local check that must pass first" })),
					}),
					async execute(params) {
						const job = scheduler.submit(node.id, {
							pool: params.pool,
							command: params.command,
							cwd: params.cwd,
							inputs: params.inputs,
							units: params.units,
							exclusive: params.exclusive,
							timeoutSeconds: params.timeout_seconds,
							capabilities: params.capabilities,
							gate: params.gate,
						});
						return job.status === "cached" ? `Cached result reused.\n${describe(job)}` : `Submitted ${job.id} (${job.status}). Call wait_job to wait for it.`;
					},
				}),
				defineTool({
					name: "wait_job",
					description: "Wait for a job to finish (you are parked and spend nothing meanwhile). Returns its output.",
					parameters: obj({ job_id: str() }),
					async execute(params) {
						const job = await harness.park(node.id, scheduler.wait(params.job_id, harness.signalOf(node.id)));
						return describe(job);
					},
				}),
				defineTool({
					name: "job_status",
					description: "Current status of a job.",
					parameters: obj({ job_id: str() }),
					async execute(params) {
						const job = scheduler.get(params.job_id);
						return job ? describe(job) : "Unknown job";
					},
				}),
			];
		},
	};
}
