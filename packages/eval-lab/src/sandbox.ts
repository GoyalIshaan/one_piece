import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import type { CanonicalEvent, EvalSandboxProfile, HarnessFault, HarnessRunReceipt } from "./contracts.ts";

export interface EvalSandboxOptions {
	command: string;
	cwd: string;
	profile: EvalSandboxProfile;
	/** Additional directories the command may read (used in eval-isolated-shards). */
	readableDirs?: readonly string[];
	/** Directories explicitly denied for reads (hidden graders, DBs, sibling shards). */
	deniedDirs?: readonly string[];
	/** Per-invocation isolated temp directory (defaults to `<cwd>/.eval-tmp`). */
	tmpDir?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
	env?: Record<string, string>;
	signal?: AbortSignal;
}

export interface EvalCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	wallClockMs: number;
	cpuSeconds: number;
	timedOut: boolean;
	sandboxed: boolean;
}

const IGNORED_HASH_DIRS = new Set([
	".git",
	"__pycache__",
	".pytest_cache",
	"node_modules",
	".eval-tmp",
	".eval-exec",
	".onepiece-eval.patch",
	".onepiece-snapshot.json",
]);

function hashSingleFile(filePath: string, size: number): string {
	const h = createHash("sha256");
	if (size <= 8 * 1024 * 1024) {
		h.update(readFileSync(filePath));
		return h.digest("hex");
	}
	const fd = openSync(filePath, "r");
	const buf = Buffer.allocUnsafe(1024 * 1024);
	try {
		let bytesRead = 0;
		while ((bytesRead = readSync(fd, buf, 0, buf.length, null)) > 0) {
			h.update(buf.subarray(0, bytesRead));
		}
	} finally {
		closeSync(fd);
	}
	return h.digest("hex");
}

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function quoteSeatbeltPath(path: string): string {
	return `(subpath "${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
}

/**
 * Deterministic recursive SHA-256 over relative paths + file contents + symlink targets.
 * Excludes VCS metadata and Python bytecode caches so identical workspaces hash identically.
 * Uses streaming reads for files > 8 MiB (safe on multi-GB ML datasets) and hashes symlinks
 * by target path without duplicating or reading multi-GB linked data directories.
 */
export function sha256Dir(folder: string): string {
	const hash = createHash("sha256");
	if (!existsSync(folder)) return hash.digest("hex");
	function visit(current: string): void {
		const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (IGNORED_HASH_DIRS.has(entry.name)) continue;
			const full = join(current, entry.name);
			const rel = relative(folder, full).replace(/\\/g, "/");
			if (entry.isSymbolicLink()) {
				hash.update(`L:${rel}:${readlinkSync(full)}\n`);
			} else if (entry.isDirectory()) {
				hash.update(`D:${rel}\n`);
				visit(full);
			} else if (entry.isFile()) {
				const st = lstatSync(full);
				const contentHash = hashSingleFile(full, st.size);
				hash.update(`F:${rel}:${contentHash}\n`);
			}
		}
	}
	visit(folder);
	return hash.digest("hex");
}

export function sha256Text(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Build a strict offline macOS Seatbelt profile for eval workers and graders.
 * Both profiles unconditionally deny all network access (`(deny network*)`).
 * `eval-isolated-shards` additionally denies global file-read-data and allowlists only
 * the worker's own workspace, its assigned private shard(s), and standard OS runtimes.
 */
export function buildEvalSeatbeltProfile(options: {
	profile: EvalSandboxProfile;
	workspaceDir: string;
	tmpDir: string;
	readableDirs?: readonly string[];
	deniedDirs?: readonly string[];
}): string {
	const workspace = real(options.workspaceDir);
	const tmp = real(options.tmpDir);
	const denied = [...new Set((options.deniedDirs ?? []).map(real))];
	const denyReads = denied.length ? `(deny file-read* ${denied.map(quoteSeatbeltPath).join(" ")})` : "";
	const allowWrites = [
		quoteSeatbeltPath(workspace),
		quoteSeatbeltPath(tmp),
		'(literal "/dev/null")',
		'(literal "/dev/zero")',
		'(literal "/dev/tty")',
		'(literal "/dev/stdout")',
		'(literal "/dev/stderr")',
		'(regex #"^/dev/fd/")',
	].join(" ");

	if (options.profile === "eval-isolated-shards") {
		const extraReads = [...new Set((options.readableDirs ?? []).map(real))].map(quoteSeatbeltPath);
		const systemReads = [
			'(literal "/")',
			'(require-all (subpath "/System") (require-not (subpath "/System/Volumes")))',
			quoteSeatbeltPath("/usr"),
			quoteSeatbeltPath("/bin"),
			quoteSeatbeltPath("/sbin"),
			quoteSeatbeltPath("/dev"),
			quoteSeatbeltPath("/opt/homebrew"),
			quoteSeatbeltPath("/Library/Frameworks"),
			quoteSeatbeltPath("/Library/Developer"),
			quoteSeatbeltPath("/private/etc"),
			quoteSeatbeltPath(workspace),
			quoteSeatbeltPath(tmp),
			...extraReads,
		].join(" ");
		return [
			"(version 1)",
			"(allow default)",
			"(deny network*)",
			"(deny process-info*)",
			"(allow process-info* (target self))",
			"(deny appleevent-send)",
			"(deny file-write*)",
			`(allow file-write* ${allowWrites})`,
			"(deny file-read-data)",
			`(allow file-read-data ${systemReads})`,
			denyReads,
		].filter(Boolean).join("\n");
	}

	return [
		"(version 1)",
		"(allow default)",
		"(deny network*)",
		"(deny file-write*)",
		`(allow file-write* ${allowWrites})`,
		denyReads,
	].filter(Boolean).join("\n");
}

function captureBounded(limit: number) {
	const headSize = Math.floor(limit / 4);
	const tailSize = limit - headSize;
	let head = "";
	let tail = "";
	let truncated = false;
	return {
		append(chunk: string): void {
			if (head.length < headSize) {
				const take = headSize - head.length;
				head += chunk.slice(0, take);
				tail += chunk.slice(take);
			} else {
				tail += chunk;
			}
			if (tail.length > tailSize) {
				truncated = true;
				tail = tailSize > 0 ? tail.slice(-tailSize) : "";
			}
		},
		text(): string {
			return head + (truncated ? "\n[output truncated]\n" : "") + tail;
		},
	};
}

/**
 * Parse POSIX `/usr/bin/time -p` stderr tail (`real X\nuser Y\nsys Z\n`) into CPU seconds
 * and return the cleaned stderr without timing lines.
 */
function parsePosixTime(stderr: string): { cpuSeconds: number; cleanedStderr: string } {
	const match = /(?:^|\n)real\s+([0-9.]+)\s*\nuser\s+([0-9.]+)\s*\nsys\s+([0-9.]+)\s*$/.exec(stderr);
	if (!match) return { cpuSeconds: 0, cleanedStderr: stderr };
	const user = Number(match[2]);
	const sys = Number(match[3]);
	const cleaned = stderr.slice(0, match.index);
	return {
		cpuSeconds: Number.isFinite(user + sys) ? user + sys : 0,
		cleanedStderr: cleaned,
	};
}

/**
 * Run a shell command inside the strict offline eval sandbox (macOS Seatbelt) and measure
 * both wall-clock ms and actual user+sys CPU seconds.
 */
export function runSandboxedEvalCommand(options: EvalSandboxOptions): Promise<EvalCommandResult> {
	if (options.signal?.aborted) {
		return Promise.resolve({
			exitCode: 137,
			stdout: "",
			stderr: "Aborted before start",
			wallClockMs: 0,
			cpuSeconds: 0,
			timedOut: false,
			sandboxed: false,
		});
	}
	if (process.platform !== "darwin") {
		throw new Error(
			`Eval sandbox profile "${options.profile}" requires macOS Seatbelt or an explicit container runner (current platform: ${process.platform}).`,
		);
	}
	const tmpDir = options.tmpDir ?? join(options.cwd, ".eval-tmp");
	mkdirSync(tmpDir, { recursive: true });
	const rules = buildEvalSeatbeltProfile({
		profile: options.profile,
		workspaceDir: options.cwd,
		tmpDir,
		readableDirs: options.readableDirs,
		deniedDirs: options.deniedDirs,
	});
	const useTime = existsSync("/usr/bin/time");
	const innerCmd = useTime
		? ["/usr/bin/time", "-p", "/bin/bash", "-c", options.command]
		: ["/bin/bash", "-c", options.command];
	const executable = "/usr/bin/sandbox-exec";
	const args = ["-p", rules, ...innerCmd];
	const maxBytes = options.maxOutputBytes ?? 64_000;
	const timeoutMs = options.timeoutMs ?? 120_000;
	const began = Date.now();

	return new Promise((resolve) => {
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: {
				PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
				HOME: options.cwd,
				TMPDIR: tmpDir,
				LANG: "en_US.UTF-8",
				PYTHONDONTWRITEBYTECODE: "1",
				...options.env,
			},
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const stdout = captureBounded(maxBytes);
		const stderr = captureBounded(maxBytes);
		type SandboxProcessState =
			| { readonly kind: "running"; readonly timedOut: boolean }
			| { readonly kind: "settled" };
		let procState: SandboxProcessState = { kind: "running", timedOut: false };

		const killTree = () => {
			if (procState.kind === "settled") return;
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};

		const timer = setTimeout(() => {
			if (procState.kind === "settled") return;
			procState = { kind: "running", timedOut: true };
			killTree();
		}, timeoutMs);

		const onAbort = () => killTree();
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => stdout.append(chunk));
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => stderr.append(chunk));
		child.on("error", (err) => stderr.append(err.message));
		child.on("close", (code) => {
			if (procState.kind === "settled") return;
			const wasTimedOut = procState.timedOut;
			procState = { kind: "settled" };
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			const wallClockMs = Date.now() - began;
			const rawErr = stderr.text();
			const { cpuSeconds, cleanedStderr } = useTime
				? parsePosixTime(rawErr)
				: { cpuSeconds: 0, cleanedStderr: rawErr };
			resolve({
				exitCode: code ?? 137,
				stdout: stdout.text(),
				stderr: cleanedStderr,
				wallClockMs,
				cpuSeconds,
				timedOut: wasTimedOut,
				sandboxed: true,
			});
		});
	});
}

/** Read current git HEAD SHA and dirty-diff digest for reproducibility envelopes. */
export function gitReproducibility(cwd: string): { harnessGitSha: string; dirtyDiffSha: string } {
	const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 3000 });
	let diff = spawnSync("git", ["diff", "HEAD"], { cwd, encoding: "utf8", timeout: 8000, maxBuffer: 64 * 1024 * 1024 });
	if (diff.status !== 0) {
		diff = spawnSync("git", ["diff", "--raw", "HEAD"], { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 10 * 1024 * 1024 });
	}
	return {
		harnessGitSha: head.status === 0 ? head.stdout.trim() : "unknown",
		dirtyDiffSha: diff.status === 0 ? sha256Text(diff.stdout) : "unknown",
	};
}

const MISSING_EDIT_CMD_RE = /(apply_patch|patch|ed):\s*(command not found|not found|No such file)/i;
const SANDBOX_BREACH_RE = /sandbox-exec|Operation not permitted.*(hidden|private-inputs)/i;

/**
 * Inspect canonical events + run receipt for silent infrastructure/harness bugs.
 * Any detected fault marks `hasHarnessFault = true` so infrastructure breakage is never
 * misclassified as a `0.0` agent failure.
 */
export function detectHarnessFaults(
	events: readonly CanonicalEvent[],
	receipt: HarnessRunReceipt,
	recordedLedgerTokens?: number,
): HarnessFault[] {
	const faults: HarnessFault[] = [...receipt.harnessFaults];

	// 1. Missing terminal event
	if (!events.some((e) => e.type === "run.finished")) {
		faults.push({ code: "MISSING_TERMINAL_EVENT", message: "Run event log has no run.finished event." });
	}

	// 2. Token ledger conservation check (supports v1 model.call and v2 budget.charged)
	const modelCallEvents = events.filter((e) => e.type === "model.call");
	const callTokens = modelCallEvents.length
		? modelCallEvents.reduce((sum, e) => sum + Number(e.data.totalTokens ?? 0), 0)
		: events
				.filter((e) => e.type === "budget.charged")
				.reduce((sum, e) => sum + Number(e.data.tokens ?? 0), 0);
	if (recordedLedgerTokens !== undefined && callTokens !== recordedLedgerTokens) {
		faults.push({
			code: "TOKEN_LEDGER_MISMATCH",
			message: `Recorded call/turn charges sum to ${callTokens} tokens but ledger recorded ${recordedLedgerTokens}.`,
		});
	}

	// 3. Silent exit-0 patch/edit failure masking (documented recurring v1 failure)
	for (const e of events) {
		if (e.type !== "tool.result" && e.type !== "mcp.tool_result" && e.type !== "driver.tool_result") continue;
		const isError = Boolean(e.data.isError);
		const text = String(e.data.text ?? e.data.output ?? e.data.outputPreview ?? "");
		if (!isError && MISSING_EDIT_CMD_RE.test(text)) {
			faults.push({
				code: "SILENT_PATCH_NOOP",
				message: `Tool ${String(e.data.tool ?? "unknown")} returned non-error despite missing edit command.`,
				seq: e.seq,
			});
		}
		if (SANDBOX_BREACH_RE.test(text) && e.data.breachConfirmed === true) {
			faults.push({
				code: "SANDBOX_BREACH",
				message: `Confirmed sandbox policy breach at seq ${e.seq}.`,
				seq: e.seq,
			});
		}
	}

	// 4. Stale verdict applied to a newer revision
	const latestRevision = new Map<string, number>();
	for (const e of events) {
		if (e.type === "finding.reported") {
			const id = String(e.data.findingId ?? "");
			const rev = Number(e.data.revision ?? 0);
			if (id && rev > (latestRevision.get(id) ?? 0)) latestRevision.set(id, rev);
		} else if (e.type === "finding.verdict" && e.data.verdict === "accepted") {
			const id = String(e.data.findingId ?? "");
			const rev = Number(e.data.revision ?? 0);
			const appliedTo = Number(e.data.appliedToRevision ?? rev);
			const current = latestRevision.get(id) ?? rev;
			if (id && rev < current && appliedTo === current) {
				faults.push({
					code: "STALE_VERDICT_APPLIED",
					message: `Accepted verdict from revision ${rev} of finding ${id} was applied to revision ${current}.`,
					seq: e.seq,
				});
			}
		}
	}

	// 5. Duplicate job billing check (same jobId finalized & charged twice)
	const billedJobs = new Set<string>();
	for (const e of events) {
		if (e.type === "job.finished" && e.data.charged !== false) {
			const jobId = String(e.data.jobId ?? "");
			if (jobId && billedJobs.has(jobId)) {
				faults.push({
					code: "DUPLICATE_JOB_CHARGE",
					message: `Job ${jobId} was finalized and charged more than once.`,
					seq: e.seq,
				});
			}
			if (jobId) billedJobs.add(jobId);
		}
	}

	// 6. Orphan active agents still running/parked after run finished
	const agentStatus = new Map<string, string>();
	for (const e of events) {
		if ((e.type === "agent.status" || e.type === "node.status") && e.agentId) {
			agentStatus.set(e.agentId, String(e.data.status ?? ""));
		}
	}
	const orphans = [...agentStatus.entries()].filter(([, st]) => st === "running" || st === "parked" || st === "pending");
	if (orphans.length) {
		faults.push({
			code: "ORPHAN_ACTIVE_AGENT",
			message: `${orphans.length} agent(s) remained non-terminal after run close: ${orphans.map(([id, st]) => `${id}=${st}`).join(", ")}`,
		});
	}

	// 7. Provider auth/catalog outage or unmasked run-level failure (never misclassify outages as 0.0 agent scores)
	const drainedEvents = events.filter((e) => e.type === "quota.drained");
	const hardAuthTurns = events.filter((e) => e.type === "agent.turn" && e.data.quotaErrorKind === "hard_auth_or_cap");
	if (drainedEvents.length > 0 || hardAuthTurns.length > 0) {
		const first = drainedEvents[0] ?? hardAuthTurns[0]!;
		faults.push({
			code: "PROVIDER_AUTH_FAILURE",
			message: `Provider drained or hit hard auth/model error: ${String(first.data.reason ?? first.data.error ?? "unknown").slice(0, 240)}`,
			seq: first.seq,
		});
	} else {
		const turnEvents = events.filter((e) => e.type === "agent.turn");
		const allTurnsErrored =
			turnEvents.length > 0 &&
			turnEvents.every((e) => e.data.status === "failed" || e.data.status === "rate_limited");
		if (receipt.status === "failed" || (allTurnsErrored && callTokens === 0)) {
			const firstErr = turnEvents.find((e) => e.data.error);
			faults.push({
				code: "RUNNER_CRASH",
				message: `Run failed with ${turnEvents.length} turn(s) and ${callTokens} billed tokens${firstErr ? `: ${String(firstErr.data.error).slice(0, 240)}` : "."}`,
				seq: firstErr?.seq,
			});
		} else if (receipt.status === "stopped" && turnEvents.length === 0 && modelCallEvents.length === 0 && callTokens === 0) {
			faults.push({
				code: "RUNNER_CRASH",
				message: "Run stopped with 0 completed model turns and 0 tokens (likely spawn deadlock or startup abort).",
			});
		}
	}

	return faults;
}
