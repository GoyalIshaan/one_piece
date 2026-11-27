import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export class DockerUnavailableError extends Error {
	constructor(detail: string) {
		super(
			`Strict Docker-only benchmark execution requires a running Docker daemon (${detail}). ` +
				`Start Docker Desktop / OrbStack / Colima and verify with \`docker info\`.`,
		);
		this.name = "DockerUnavailableError";
	}
}

export interface DockerMount {
	readonly hostPath: string;
	readonly containerPath: string;
	readonly readOnly?: boolean;
}

export interface DockerRunOptions {
	readonly image: string;
	readonly command: readonly string[];
	readonly workdir?: string;
	readonly mounts?: readonly DockerMount[];
	readonly env?: Record<string, string>;
	/** Hard offline isolation (`--network=none`, default true). */
	readonly networkDisabled?: boolean;
	readonly memoryLimit?: string;
	readonly cpus?: string;
	readonly pidsLimit?: number;
	readonly platform?: string;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
	readonly signal?: AbortSignal;
}

export type DockerRunResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly wallClockMs: number;
	readonly containerName: string;
} & (
	| { readonly outcome: "exited"; readonly exitCode: number; readonly timedOut: false }
	| { readonly outcome: "timed_out"; readonly exitCode: 124 | 137; readonly timedOut: true }
	| { readonly outcome: "aborted"; readonly exitCode: 137; readonly timedOut: false }
);

type DockerContainerLifecycle =
	| { readonly phase: "running" }
	| { readonly phase: "timing_out" }
	| { readonly phase: "aborted" }
	| { readonly phase: "settled" };

export function checkDockerDaemon(): { available: true; serverVersion: string } | { available: false; reason: string } {
	const res = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
		encoding: "utf8",
		timeout: 5_000,
	});
	if (res.status === 0 && res.stdout.trim()) {
		return { available: true, serverVersion: res.stdout.trim() };
	}
	return {
		available: false,
		reason: (res.stderr || res.stdout || "docker info failed").trim().slice(0, 240),
	};
}

export function assertDockerDaemon(): string {
	const check = checkDockerDaemon();
	if (!check.available) {
		throw new DockerUnavailableError(check.reason);
	}
	return check.serverVersion;
}

export function resolveHostDockerArch(): "arm64" | "x86_64" {
	return process.arch === "arm64" ? "arm64" : "x86_64";
}

export function dockerPlatformForArch(arch: "arm64" | "x86_64"): "linux/arm64" | "linux/amd64" {
	return arch === "arm64" ? "linux/arm64" : "linux/amd64";
}

export function hasLocalDockerImage(image: string): boolean {
	const res = spawnSync("docker", ["image", "inspect", image], {
		encoding: "utf8",
		timeout: 5_000,
	});
	return res.status === 0;
}

export function ensureDockerImage(image: string, opts: { pullIfMissing?: boolean; platform?: string } = {}): void {
	assertDockerDaemon();
	if (hasLocalDockerImage(image)) return;
	if (opts.pullIfMissing === false) {
		throw new Error(`Required Docker image "${image}" is not present locally and pullIfMissing=false.`);
	}
	const args = ["pull"];
	if (opts.platform) args.push("--platform", opts.platform);
	args.push(image);
	const res = spawnSync("docker", args, {
		encoding: "utf8",
		timeout: 15 * 60_000,
	});
	if (res.status !== 0) {
		throw new Error(`Failed to pull Docker image "${image}": ${(res.stderr || res.stdout).slice(0, 400)}`);
	}
}

/**
 * Resolve & ensure a Docker image from an ordered preference list (e.g., native `arm64` first on
 * Apple Silicon, falling back cleanly to `x86_64` via Rosetta if an instance only publishes amd64).
 */
export function ensureFirstAvailableDockerImage(
	candidates: readonly { readonly image: string; readonly platform: "linux/arm64" | "linux/amd64"; readonly arch: "arm64" | "x86_64" }[],
	opts: { pullIfMissing?: boolean } = {},
): { readonly image: string; readonly platform: "linux/arm64" | "linux/amd64"; readonly arch: "arm64" | "x86_64" } {
	assertDockerDaemon();
	// 1. Prefer any candidate already cached locally (zero network pulls)
	for (const c of candidates) {
		if (hasLocalDockerImage(c.image)) return c;
	}
	// 2. Otherwise try pulling in preference order
	const errors: string[] = [];
	for (const c of candidates) {
		try {
			ensureDockerImage(c.image, { pullIfMissing: opts.pullIfMissing, platform: c.platform });
			return c;
		} catch (err) {
			errors.push(`${c.image}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	throw new Error(`Failed to resolve any Docker image candidate:\n${errors.join("\n")}`);
}

/**
 * Build deterministic `docker run` argument vector with strict offline isolation,
 * bounded RAM/CPU/PIDs, read-only mounts where specified, and unique container name for leak-free cleanup.
 */
export function buildDockerRunArgs(opts: DockerRunOptions, containerName: string): string[] {
	const args: string[] = ["run", "--rm", "--name", containerName];
	if (opts.networkDisabled !== false) args.push("--network=none");
	if (opts.platform) args.push("--platform", opts.platform);
	if (opts.memoryLimit) args.push("--memory", opts.memoryLimit);
	if (opts.cpus) args.push("--cpus", opts.cpus);
	args.push("--pids-limit", String(opts.pidsLimit ?? 512));
	if (opts.workdir) args.push("-w", opts.workdir);
	for (const m of opts.mounts ?? []) {
		const host = resolve(m.hostPath);
		args.push("-v", `${host}:${m.containerPath}${m.readOnly ? ":ro" : ""}`);
	}
	for (const [k, v] of Object.entries(opts.env ?? {})) {
		args.push("-e", `${k}=${v}`);
	}
	args.push(opts.image, ...opts.command);
	return args;
}

/**
 * Execute a command strictly inside an isolated Linux Docker container with hard timeout & force-removal cleanup.
 */
export function runDockerContainer(opts: DockerRunOptions): Promise<DockerRunResult> {
	assertDockerDaemon();
	const containerName = `onepiece-eval-${randomBytes(5).toString("hex")}`;
	const args = buildDockerRunArgs(opts, containerName);
	const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
	const maxBytes = opts.maxOutputBytes ?? 256_000;
	const began = Date.now();

	return new Promise((resolvePromise) => {
		const child = spawn("docker", args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let lifecycle: DockerContainerLifecycle = { phase: "running" };

		const appendBounded = (buf: string, chunk: string): string => {
			const next = buf + chunk;
			return next.length > maxBytes ? next.slice(-maxBytes) : next;
		};

		const forceKill = (targetPhase: "timing_out" | "aborted") => {
			if (lifecycle.phase !== "running") return;
			lifecycle = { phase: targetPhase };
			try {
				spawnSync("docker", ["rm", "-f", containerName], { timeout: 5_000, stdio: "ignore" });
			} catch {
				// Ignore cleanup errors
			}
			child.kill("SIGKILL");
		};

		const timer = setTimeout(() => forceKill("timing_out"), timeoutMs);

		const onAbort = () => forceKill("aborted");
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
			stdout = appendBounded(stdout, chunk);
		});
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderr = appendBounded(stderr, chunk);
		});
		child.on("error", (err) => {
			stderr = appendBounded(stderr, err.message);
		});
		child.on("close", (code) => {
			if (lifecycle.phase === "settled") return;
			const finalPhase = lifecycle.phase;
			lifecycle = { phase: "settled" };
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			const base = {
				stdout,
				stderr,
				wallClockMs: Date.now() - began,
				containerName,
			};
			if (finalPhase === "timing_out") {
				resolvePromise({ ...base, outcome: "timed_out", exitCode: 124, timedOut: true });
			} else if (finalPhase === "aborted") {
				resolvePromise({ ...base, outcome: "aborted", exitCode: 137, timedOut: false });
			} else {
				resolvePromise({ ...base, outcome: "exited", exitCode: code ?? 137, timedOut: false });
			}
		});
	});
}

/**
 * Copy a directory out of a Docker image (`docker create` -> `docker cp` -> `docker rm`)
 * without starting any untrusted container entrypoint.
 */
export function copyFromDockerImage(image: string, containerSrcPath: string, hostDestDir: string, platform?: string): void {
	assertDockerDaemon();
	const createArgs = ["create"];
	if (platform) createArgs.push("--platform", platform);
	createArgs.push(image, "true");
	const created = execFileSync("docker", createArgs, { encoding: "utf8", timeout: 30_000 }).trim();
	try {
		execFileSync("docker", ["cp", `${created}:${containerSrcPath}/.`, resolve(hostDestDir)], {
			timeout: 120_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} finally {
		spawnSync("docker", ["rm", "-f", created], { timeout: 10_000, stdio: "ignore" });
	}
}

/**
 * Anti-Cheat Git History Scrubber:
 * Checks out `baseCommit` (if provided) and replaces `.git` with a brand-new single-commit
 * orphan repository containing ONLY the exact working tree at `baseCommit`.
 * Guarantees zero future commits, tags, reflogs, remotes, or gold/test patches can ever be
 * recovered via `git log --all`, `git rev-list`, or `git cat-file`.
 */
export function scrubGitRepoHistory(repoDir: string, baseCommit?: string): void {
	const absDir = resolve(repoDir);
	if (baseCommit) {
		execFileSync("git", ["checkout", "--force", baseCommit], { cwd: absDir, stdio: "ignore" });
		execFileSync("git", ["clean", "-fdx"], { cwd: absDir, stdio: "ignore" });
	}
	// Completely destroy original .git object database so no future commit objects exist on disk!
	rmSync(join(absDir, ".git"), { recursive: true, force: true });
	execFileSync("git", ["init", "-q"], { cwd: absDir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "eval-base@onepiece.dev"], { cwd: absDir, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "EvalBase"], { cwd: absDir, stdio: "ignore" });
	execFileSync("git", ["add", "-A"], { cwd: absDir, stdio: "ignore" });
	execFileSync("git", ["commit", "-q", "-m", `Base snapshot${baseCommit ? ` (${baseCommit.slice(0, 12)})` : ""}`], {
		cwd: absDir,
		stdio: "ignore",
	});
}

/**
 * Atomically populate a shared, already-scrubbed base git repository cache from a Docker image
 * so multi-arm / multi-seed campaigns NEVER re-extract or re-scrub `/testbed` from Docker.
 */
export function ensureScrubbedDockerRepoCache(opts: {
	image: string;
	containerSrcPath: string;
	baseCommit?: string;
	cacheDir: string;
	platform?: string;
}): string {
	const absCache = resolve(opts.cacheDir);
	if (existsSync(join(absCache, ".git", "HEAD"))) {
		return absCache;
	}
	mkdirSync(dirname(absCache), { recursive: true });
	const tmpDir = `${absCache}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
	mkdirSync(tmpDir, { recursive: true });
	try {
		copyFromDockerImage(opts.image, opts.containerSrcPath, tmpDir, opts.platform);
		scrubGitRepoHistory(tmpDir, opts.baseCommit);
		if (!existsSync(join(absCache, ".git", "HEAD"))) {
			renameSync(tmpDir, absCache);
		} else {
			rmSync(tmpDir, { recursive: true, force: true });
		}
		return absCache;
	} catch (error) {
		rmSync(tmpDir, { recursive: true, force: true });
		throw error;
	}
}

/**
 * Extract a complete unified git diff against the root base commit — including committed,
 * staged, unstaged, AND newly created untracked non-ignored files — using a throwaway
 * `GIT_INDEX_FILE` so the workspace's own git index is NEVER mutated.
 * Strictly requires `repoDir/.git` to exist (NEVER walks up to a parent repository!).
 */
export function extractFullGitPatch(
	repoDir: string,
	excludePaths: readonly string[] = [
		"ISSUE.md",
		".eval-exec",
		".eval-tmp",
		".swarm",
		".one_piece",
		".gemini",
		".grok",
		".onepiece-eval.patch",
		".onepiece-snapshot.json",
	],
): string {
	const abs = resolve(repoDir);
	if (!existsSync(join(abs, ".git"))) {
		throw new Error(`Cannot extract git patch: "${abs}" is not a git repository root (missing .git).`);
	}
	const baseSha = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
		cwd: abs,
		encoding: "utf8",
		timeout: 10_000,
		stdio: ["ignore", "pipe", "pipe"],
	})
		.trim()
		.split("\n")[0];
	if (!baseSha) {
		throw new Error(`Cannot extract git patch: no root commit found in "${abs}".`);
	}
	const tmpIndex = join(tmpdir(), `op-patch-idx-${process.pid}-${randomBytes(6).toString("hex")}`);
	const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
	const excludeSpecs = excludePaths.map((p) => `:(exclude)${p}`);
	try {
		execFileSync("git", ["read-tree", "HEAD"], { cwd: abs, env, timeout: 15_000, stdio: "ignore" });
		execFileSync("git", ["add", "-A", "--", "."], { cwd: abs, env, timeout: 30_000, stdio: "ignore" });
		return execFileSync(
			"git",
			["diff", "--cached", baseSha, "--", ".", ...excludeSpecs],
			{
				cwd: abs,
				env,
				encoding: "utf8",
				timeout: 20_000,
				maxBuffer: 32 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} finally {
		rmSync(tmpIndex, { force: true });
	}
}
