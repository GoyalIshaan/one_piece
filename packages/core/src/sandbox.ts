import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

// Worker and job commands have workspace write restrictions. Jobs run offline.
// Isolated handoff commands also restrict reads to their own workspace and system tools.

export type SandboxProfile = "worker" | "job" | "isolated";

const DENY: Array<[RegExp, string]> = [
	[/(^|[\s;&|(])sudo(\s|$)/, "root commands are not allowed"],
	[/(^|[\s;&|(])(su|doas)\s/, "switching user is not allowed"],
	[/\brm\s+(-[a-zA-Z]*\s+)*(\/|~|\$HOME|\/Users|\/home)(\s|\/?$|\/\*)/, "deleting outside the workspace is not allowed"],
	[/\bgit\s+push\b[^\n]*(--force|-f\b)/, "force-pushing is not allowed"],
	[/\b(shutdown|reboot|halt|mkfs|diskutil|launchctl|systemsetup|csrutil|defaults\s+write)\b/, "system commands are not allowed"],
	[/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bombs are not allowed"],
];

/** Toolchain variables passed through to sandboxed commands (never secrets). */
const PASSTHROUGH = ["SDKROOT", "DEVELOPER_DIR", "CC", "CXX", "CFLAGS", "CXXFLAGS", "LDFLAGS", "CPATH", "LIBRARY_PATH", "PKG_CONFIG_PATH", "RUSTUP_HOME", "CARGO_HOME", "JAVA_HOME", "GOROOT", "GOPATH", "VIRTUAL_ENV", "CONDA_PREFIX", "PYTHONPATH", "CUDA_HOME"];

function passthroughEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of PASSTHROUGH) if (process.env[key]) out[key] = process.env[key]!;
	return out;
}

/** Returns a refusal reason, or undefined when the command may run. */
export function commandPolicy(command: string): string | undefined {
	for (const [pattern, reason] of DENY) if (pattern.test(command)) return reason;
	return undefined;
}

interface CommandOptions {
	command: string;
	cwd: string;
	profile: SandboxProfile;
	env?: Record<string, string>;
	/** Folders writable besides cwd and temp. */
	writeRoots?: string[];
	/** Per-invocation paths blocked from reading (preferred over process-global deny lists). */
	deniedReadPaths?: readonly string[];
	/** Keep temporary writes inside the scratch workspace. */
	isolatedWrites?: boolean;
	/** Explicitly block all outbound network even on the worker profile. */
	networkOff?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
	maxOutput?: number;
	onOutput?: (stdout: string, stderr: string) => void;
}

type Admission =
	| { readyTimeoutMs?: never; commandPrefix?: readonly string[]; admissionCheck?: never; onReady?: never; leasedMacGpu?: false }
	| ({ readyTimeoutMs: number; commandPrefix: readonly [string, ...string[]]; onReady?: () => void } & (
		| { admissionCheck: () => string | undefined; leasedMacGpu?: boolean }
		| { admissionCheck?: never; leasedMacGpu?: false }
	));
export type RunOptions = CommandOptions & Admission;

export interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
	sandboxed: boolean;
}

function outputCapture(limit: number) {
	const headSize = Math.floor(limit / 4);
	const tailSize = limit - headSize;
	let head = "", tail = "", truncated = false;
	return {
		append(chunk: string) {
			const take = headSize - head.length;
			head += chunk.slice(0, take);
			tail += chunk.slice(take);
			if (tail.length > tailSize) {
				truncated = true;
				tail = tailSize ? tail.slice(-tailSize) : "";
			}
		},
		text: () => head + (truncated ? "\n[output truncated]\n" : "") + tail,
	};
}

type WaitingCommand = { phase: "admitting" | "executing"; since: number; deadline: ReturnType<typeof setTimeout> };
type StopReason = "deadline" | "aborted" | "admission_failed";
type CommandState = WaitingCommand | { phase: "stopping"; since: number; reason: StopReason } | { phase: "closed" };

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * @deprecated Process-global mutable deny list. Prefer passing immutable `deniedReadPaths` per spawn/command.
 * Retained as a ref-counted compatibility shim for legacy callers and tests.
 */
const deniedReadCounts = new Map<string, number>();

/** @deprecated Prefer passing immutable `deniedReadPaths` per command/worker. */
export function denySandboxReads(paths: string[]): void {
	for (const p of paths) {
		const key = real(p);
		deniedReadCounts.set(key, (deniedReadCounts.get(key) ?? 0) + 1);
	}
}

/** @deprecated Prefer passing immutable `deniedReadPaths` per command/worker. */
export function allowSandboxReads(paths: string[]): void {
	for (const p of paths) {
		const key = real(p);
		const count = deniedReadCounts.get(key) ?? 0;
		if (count <= 1) deniedReadCounts.delete(key);
		else deniedReadCounts.set(key, count - 1);
	}
}

const operatorArchive = join(homedir(), ".one_piece", "archives.noindex");

/** Native workspace tools run in the harness process, outside the shell profile. */
export function isOperatorArchivePath(path: string): boolean {
	const canonical = real(path);
	const archive = real(operatorArchive);
	return canonical === archive || canonical.startsWith(archive + "/");
}

/**
 * Pure per-call read-denial check combining operator archives, an immutable per-worker/per-command
 * `deniedReadPaths` list, and any legacy process-global entries.
 */
export function isPathBlocked(path: string, deniedReadPaths?: readonly string[]): boolean {
	const canonical = real(path);
	if (isOperatorArchivePath(canonical)) return true;
	if (deniedReadPaths?.length) {
		for (const raw of deniedReadPaths) {
			if (!raw) continue;
			const root = real(raw);
			if (canonical === root || canonical.startsWith(root + "/")) return true;
		}
	}
	return [...deniedReadCounts.keys()].some(root => canonical === root || canonical.startsWith(root + "/"));
}

/** @deprecated Use `isPathBlocked(path, deniedReadPaths)` with explicit immutable paths. */
export function isSandboxReadBlocked(path: string): boolean {
	return isPathBlocked(path);
}

function seatbeltProfile(
	profile: SandboxProfile,
	roots: string[],
	archive: string | undefined,
	unrestricted: boolean,
	leasedMacGpu: boolean,
	networkOff = false,
	deniedReadPaths?: readonly string[],
): string {
	const quote = (r: string) => `(subpath "${r.replace(/"/g, '\\"')}")`;
	const privateArchive = archive ? `(deny file-read* file-write* ${quote(archive)})` : "";
	const gpuPolicy = leasedMacGpu ? "" : [
		"(deny iokit-open)",
		'(deny process-exec (regex #"/(llama-bench|llama-cli|llama-server)$"))',
		'(deny network-outbound (remote ip "localhost:*") (remote unix-socket))',
		profile === "worker" && !networkOff ? '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))' : "",
	].join("\n");
	const combinedDenied = new Set<string>(deniedReadCounts.keys());
	for (const raw of deniedReadPaths ?? []) {
		if (!raw) continue;
		combinedDenied.add(raw);
		combinedDenied.add(real(raw));
	}
	const privateReads = combinedDenied.size ? `(deny file-read* ${[...combinedDenied].map(quote).join(" ")})` : "";
	if (unrestricted && profile !== "isolated") return ["(version 1)", "(allow default)", privateReads, privateArchive, gpuPolicy].join("\n");
	const writes = roots.map(quote).join(" ");
	const isolatedReads = profile === "isolated" ? [
		"(deny process-info*)",
		"(allow process-info* (target self))",
		"(deny appleevent-send)",
		"(deny file-read-data)",
		`(allow file-read-data (literal "/") (require-all ${quote("/System")} (require-not ${quote("/System/Volumes")})) ${[roots[0]!, "/usr", "/bin", "/sbin", "/dev", "/Library/Frameworks", "/Library/Developer"].map(quote).join(" ")})`,
	].join("\n") : "";
	const netPolicy = profile === "isolated" || networkOff
		? "(deny network*)"
		: profile === "job"
			? '(deny network*) (allow network* (local unix))'
			: "";
	return [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		`(allow file-write* ${writes} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/"))`,
		isolatedReads,
		privateReads,
		privateArchive,
		netPolicy,
		gpuPolicy,
	].join("");
}

/**
 * Wrap an external CLI worker command in a thin macOS Seatbelt read-deny profile
 * so the worker (and any child commands it spawns) can access its cloud API and MCP bus
 * while being kernel-blocked from reading hidden graders or sibling private shards.
 */
export function seatbeltReadDenyCommand(command: string[], deniedPaths: readonly string[]): string[] {
	if (process.platform !== "darwin" || !deniedPaths.length || process.env.ONE_PIECE_NO_SANDBOX) {
		return command;
	}
	const unique = new Set<string>();
	for (const raw of deniedPaths) {
		if (!raw) continue;
		unique.add(raw);
		unique.add(real(raw));
	}
	if (!unique.size) return command;
	const quote = (r: string) => `(subpath "${r.replace(/"/g, '\\"')}")`;
	const rules = [
		"(version 1)",
		"(allow default)",
		`(deny file-read* ${[...unique].map(quote).join(" ")})`,
	].join("\n");
	return ["/usr/bin/sandbox-exec", "-p", rules, ...command];
}

/** Apply the same OS restrictions to shell tools and native subprocesses such as workspace Git. */
export function sandboxCommand(
	command: string[],
	options: Pick<CommandOptions, "cwd" | "profile" | "isolatedWrites" | "writeRoots" | "networkOff" | "deniedReadPaths"> & Admission,
): string[] {
	if (options.leasedMacGpu && (!options.commandPrefix?.length || !Number.isFinite(options.readyTimeoutMs) ||
		options.readyTimeoutMs <= 0 || typeof options.admissionCheck !== "function")) {
		throw new Error("A leased Mac GPU command requires a launcher, readiness deadline and admission check");
	}
	if (process.platform !== "darwin") {
		if (options.profile === "isolated") throw new Error("Isolated workspaces require macOS Seatbelt");
		return command;
	}
	const roots = [real(options.cwd), ...(options.profile === "isolated" || options.isolatedWrites ? [] : [real(tmpdir()), "/private/tmp", "/private/var/folders"]), ...(options.writeRoots ?? []).map(real)];
	const archive = existsSync(operatorArchive) ? real(operatorArchive) : undefined;
	const rules = seatbeltProfile(
		options.profile,
		roots,
		archive,
		Boolean(process.env.ONE_PIECE_NO_SANDBOX),
		options.leasedMacGpu === true,
		options.networkOff === true,
		options.deniedReadPaths,
	);
	return ["/usr/bin/sandbox-exec", "-p", rules, ...command];
}

/** Run a shell command confined to its folder (macOS Seatbelt when available). */
export function runCommand(options: RunOptions): Promise<RunResult> {
	if (options.signal?.aborted) {
		return Promise.resolve({ exitCode: 137, stdout: "", stderr: "Command cancelled", durationMs: 0, timedOut: false, sandboxed: false });
	}
	const policy = commandPolicy(options.command);
	if (policy) {
		return Promise.resolve({ exitCode: 126, stdout: "", stderr: `Refused by sandbox policy: ${policy}`, durationMs: 0, timedOut: false, sandboxed: true });
	}
	const command = [...(options.commandPrefix ?? []), "/bin/bash", "-c", options.command];
	const [executable, ...args] = sandboxCommand(command, options);
	const isolated = options.profile === "isolated";
	const useSeatbelt = process.platform === "darwin";
	const max = options.maxOutput ?? 20_000;
	const waitForReady = options.readyTimeoutMs !== undefined;
	const admissionEnv = waitForReady
		? { ONE_PIECE_JOB_READY_FD: "3", ...(options.admissionCheck ? { ONE_PIECE_JOB_ADMISSION_ACK: "1" } : {}) }
		: {};
	const executeTimeout = options.timeoutMs ?? 300_000;
	const spawnedAt = Date.now();
	return new Promise((resolve) => {
		const child = spawn(executable!, args, {
			cwd: options.cwd,
			env: isolated
				? { PATH: "/Library/Frameworks/Python.framework/Versions/Current/bin:/usr/bin:/bin", HOME: options.cwd, LANG: "en_US.UTF-8", TMPDIR: options.cwd, PYTHONDONTWRITEBYTECODE: "1" }
				: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? options.cwd, LANG: "en_US.UTF-8", TMPDIR: options.isolatedWrites ? options.cwd : tmpdir(), PYTHONDONTWRITEBYTECODE: "1", ...passthroughEnv(), ...options.env, ...admissionEnv },
			stdio: waitForReady ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const stdout = outputCapture(max), stderr = outputCapture(max);
		let lastOutput = 0, outputTimer: ReturnType<typeof setTimeout> | undefined;
		const publish = () => {
			lastOutput = Date.now();
			outputTimer = undefined;
			options.onOutput?.(stdout.text(), stderr.text());
		};
		const output = (capture: ReturnType<typeof outputCapture>, chunk: string) => {
			capture.append(chunk);
			if (!options.onOutput || outputTimer) return;
			const remaining = 1000 + lastOutput - Date.now();
			if (remaining <= 0) publish();
			else outputTimer = setTimeout(publish, remaining);
		};
		const kill = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const stop = (reason: StopReason) => {
			if (state.phase !== "admitting" && state.phase !== "executing") return;
			clearTimeout(state.deadline);
			state = { phase: "stopping", since: state.since, reason };
			kill();
		};
		const wait = (phase: WaitingCommand["phase"], since: number, timeout: number): WaitingCommand => ({
			phase, since, deadline: setTimeout(() => stop("deadline"), timeout),
		});
		let state: CommandState = wait(waitForReady ? "admitting" : "executing", spawnedAt, options.readyTimeoutMs ?? executeTimeout);
		const abort = () => stop("aborted");
		const ready = child.stdio[3] as Duplex | undefined;
		ready?.on("error", (error) => {
			output(stderr, `\nLease channel failed: ${error.message}\n`);
			stop("admission_failed");
		});
		if (waitForReady) ready?.once("data", () => {
			if (state.phase !== "admitting" || options.signal?.aborted) return;
			let reason: string | undefined;
			try {
				reason = options.admissionCheck?.();
			} catch (error) {
				reason = String(error);
			}
			if (reason) {
				output(stderr, `\nLease admission declined: ${reason}\n`);
				stop("admission_failed");
				return;
			}
			try {
				options.onReady?.();
			} catch (error) {
				output(stderr, `\nLease callback failed: ${error}\n`);
				stop("admission_failed");
				return;
			}
			if (options.signal?.aborted) return;
			clearTimeout(state.deadline);
			state = wait("executing", Date.now(), executeTimeout);
			if (options.admissionCheck) ready.write("1");
		});
		options.signal?.addEventListener("abort", abort, { once: true });
		child.on("error", (error) => output(stderr, error.message));
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => output(stdout, chunk));
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => output(stderr, chunk));
		if (options.leasedMacGpu) child.once("exit", kill);
		child.on("close", (code) => {
			const exit = state;
			if (exit.phase === "closed") return;
			state = { phase: "closed" };
			if (exit.phase !== "stopping") clearTimeout(exit.deadline);
			clearTimeout(outputTimer);
			options.signal?.removeEventListener("abort", abort);
			resolve({
				exitCode: code ?? 137,
				stdout: stdout.text(),
				stderr: stderr.text(),
				durationMs: Date.now() - exit.since,
				timedOut: exit.phase === "stopping" && exit.reason === "deadline",
				sandboxed: useSeatbelt,
			});
		});
	});
}
