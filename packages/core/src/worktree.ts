import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { WorktreeHandle, WorktreeManager } from "./topology.ts";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/**
 * Return true ONLY when `dir` itself is a git repository root with a valid HEAD commit.
 * Never walks up to a parent repository (preventing non-git task workspaces nested inside
 * `.one_piece/` from polluting the parent repo with stray worktrees and branches).
 */
function isGitRepoRoot(dir: string): boolean {
	if (!existsSync(join(dir, ".git"))) return false;
	try {
		return git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true" && Boolean(git(dir, ["rev-parse", "--verify", "HEAD"]));
	} catch {
		return false;
	}
}

/**
 * Manages isolated per-worker git worktrees (or standalone initialized git clones for non-git seeds)
 * so no two concurrent writers ever mutate the same working directory.
 */
export class GitWorktreeManager implements WorktreeManager {
	readonly repoRoot: string;
	readonly baseSha: string;
	private readonly worktreeRoot: string;
	private readonly runId: string;
	private _trunkPath?: string;

	constructor(sourceWorkspace: string, runDir: string, runId: string) {
		this.runId = runId;
		this.worktreeRoot = resolve(runDir, "worktrees");
		mkdirSync(this.worktreeRoot, { recursive: true });

		const resolvedSource = resolve(sourceWorkspace);
		if (isGitRepoRoot(resolvedSource)) {
			this.repoRoot = resolvedSource;
			this.baseSha = git(this.repoRoot, ["rev-parse", "HEAD"]);
		} else {
			// Seed a local origin repo inside runDir so non-git workspaces still get full worktree isolation.
			const seedRepo = resolve(runDir, "seed-repo");
			mkdirSync(seedRepo, { recursive: true });
			if (existsSync(resolvedSource)) {
				cpSync(resolvedSource, seedRepo, {
					recursive: true,
					filter: (src) => {
						const rel = relative(resolvedSource, src);
						if (!rel) return true;
						const parts = rel.split(/[\\/]/);
						return !parts.includes(".one_piece") && !parts.includes("node_modules") && !parts.includes(".git");
					},
				});
			}
			git(seedRepo, ["init", "-b", "main"]);
			git(seedRepo, ["config", "user.name", "one-piece"]);
			git(seedRepo, ["config", "user.email", "one-piece@local"]);
			git(seedRepo, ["add", "-A"]);
			git(seedRepo, ["commit", "--allow-empty", "-m", "one-piece initial seed"]);
			this.repoRoot = seedRepo;
			this.baseSha = git(seedRepo, ["rev-parse", "HEAD"]);
		}
	}

	/** Dedicated isolated trunk worktree so Refinery merges never mutate the user's live checked-out branch. */
	get trunkPath(): string {
		if (!this._trunkPath || !existsSync(this._trunkPath)) {
			const trunk = this.create("trunk", this.baseSha);
			this._trunkPath = trunk.path;
		}
		return this._trunkPath;
	}

	create(agentId: string, baseRef = this.baseSha): WorktreeHandle {
		const safeId = agentId.replace(/[^a-zA-Z0-9._-]/g, "-");
		const branch = `one-piece/${this.runId}/${safeId}`;
		const worktreePath = join(this.worktreeRoot, safeId);
		if (existsSync(worktreePath)) {
			this.remove(worktreePath);
		}
		try {
			git(this.repoRoot, ["branch", "-D", branch]);
		} catch {
			// Branch did not exist yet.
		}
		git(this.repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
		this.writeGitExclude(worktreePath, [".swarm/", ".gemini/settings.json", ".grok/config.toml", ".one_piece/"]);
		return { path: worktreePath, branch, baseSha: baseRef };
	}

	writeGitExclude(worktreePath: string, patterns: readonly string[]): void {
		try {
			const gitDir = resolve(worktreePath, git(worktreePath, ["rev-parse", "--git-dir"]));
			const infoDir = join(gitDir, "info");
			mkdirSync(infoDir, { recursive: true });
			const excludeFile = join(infoDir, "exclude");
			const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
			const existing = new Set(current.split(/\r?\n/).map((line) => line.trim()));
			const missing = patterns.filter((p) => !existing.has(p));
			if (missing.length) {
				const prefix = current.length && !current.endsWith("\n") ? "\n" : "";
				appendFileSync(excludeFile, `${prefix}${missing.join("\n")}\n`, "utf8");
			}
		} catch {
			// Best-effort ignore update.
		}
	}

	commitWip(worktreePath: string, message: string): string | undefined {
		try {
			const status = git(worktreePath, ["status", "--porcelain"]);
			if (!status) return undefined;
			git(worktreePath, ["add", "-A"]);
			git(worktreePath, [
				"-c", "user.name=one-piece",
				"-c", "user.email=one-piece@local",
				"commit", "-m", message, "--no-verify",
			]);
			return git(worktreePath, ["rev-parse", "HEAD"]);
		} catch {
			return undefined;
		}
	}

	headSha(worktreePath: string): string | undefined {
		try {
			return git(worktreePath, ["rev-parse", "HEAD"]);
		} catch {
			return undefined;
		}
	}

	diffStat(worktreePath: string, baseRef = this.baseSha): string {
		try {
			const committed = git(worktreePath, ["diff", "--stat", `${baseRef}...HEAD`]);
			const working = git(worktreePath, ["diff", "--stat"]);
			return [committed, working].filter(Boolean).join("\n") || "(no changes)";
		} catch {
			return "(diff unavailable)";
		}
	}

	diffSha(worktreePath: string): string {
		try {
			const head = git(worktreePath, ["rev-parse", "HEAD"]);
			const status = git(worktreePath, ["status", "--porcelain"]);
			const diff = git(worktreePath, ["diff"]);
			return createHash("sha256").update(head).update("\0").update(status).update("\0").update(diff).digest("hex").slice(0, 16);
		} catch {
			return "unknown";
		}
	}

	mergeIntoTrunk(branch: string, opts: { message?: string } = {}): { ok: boolean; commitSha?: string; error?: string } {
		const trunk = this.trunkPath;
		try {
			git(trunk, [
				"-c", "user.name=one-piece",
				"-c", "user.email=one-piece@local",
				"merge", "--no-ff", "-m", opts.message ?? `one-piece merge ${branch}`, branch,
			]);
			return { ok: true, commitSha: git(trunk, ["rev-parse", "HEAD"]) };
		} catch (error) {
			try {
				git(trunk, ["merge", "--abort"]);
			} catch {
				// No merge in progress.
			}
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	remove(worktreePath: string): void {
		try {
			git(this.repoRoot, ["worktree", "remove", "--force", worktreePath]);
		} catch {
			rmSync(worktreePath, { recursive: true, force: true });
		}
	}
}
