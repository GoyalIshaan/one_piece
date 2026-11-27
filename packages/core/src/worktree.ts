import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { MergeTrunkResult, WorktreeHandle, WorktreeManager } from "./topology.ts";

export const WORKTREE_EXCLUDE_PATTERNS: readonly string[] = [
	".swarm/",
	".gemini/settings.json",
	".grok/config.toml",
	".one_piece/",
	".eval-exec",
	".eval-tmp/",
	".onepiece-eval.patch",
	".onepiece-snapshot.json",
	"__pycache__/",
	"*.pyc",
	"*.pyo",
	".pytest_cache/",
	".mypy_cache/",
	".ruff_cache/",
	".DS_Store",
	"*.egg-info/",
];

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

type TrunkWorktreeState =
	| { readonly status: "uninitialized" }
	| { readonly status: "provisioned"; readonly path: string; readonly branch: string };

/**
 * Manages isolated per-worker git worktrees (or standalone initialized git clones for non-git seeds)
 * so no two concurrent writers ever mutate the same working directory.
 */
export class GitWorktreeManager implements WorktreeManager {
	readonly repoRoot: string;
	readonly baseSha: string;
	private readonly worktreeRoot: string;
	private readonly runId: string;
	private trunkState: TrunkWorktreeState = { status: "uninitialized" };

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
						return (
							!parts.includes(".one_piece") &&
							!parts.includes("node_modules") &&
							!parts.includes(".git") &&
							!parts.includes("__pycache__") &&
							!parts.includes(".pytest_cache") &&
							!parts.includes(".DS_Store")
						);
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
		if (this.trunkState.status === "uninitialized" || !existsSync(this.trunkState.path)) {
			const trunk = this.create("trunk", this.baseSha);
			this.trunkState = { status: "provisioned", path: trunk.path, branch: trunk.branch };
		}
		return this.trunkState.path;
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
		this.writeGitExclude(worktreePath, WORKTREE_EXCLUDE_PATTERNS);
		this.mirrorUntrackedWorkspaceLinks(worktreePath);
		return { path: worktreePath, branch, baseSha: baseRef };
	}

	/**
	 * Zero-copy mirror of top-level gitignored read-only symlinks (e.g., MLE-bench `data -> <publicSrc>`)
	 * and the gitignored `.eval-exec` container helper from `repoRoot` into each linked worktree.
	 */
	private mirrorUntrackedWorkspaceLinks(worktreePath: string): void {
		try {
			for (const name of readdirSync(this.repoRoot)) {
				if (name === ".git" || name === ".swarm" || name === ".one_piece") continue;
				const src = join(this.repoRoot, name);
				const dst = join(worktreePath, name);
				if (existsSync(dst)) continue;
				const st = lstatSync(src);
				if (st.isSymbolicLink()) {
					symlinkSync(readlinkSync(src), dst);
				} else if (name === ".eval-exec" && st.isFile()) {
					copyFileSync(src, dst);
					try {
						chmodSync(dst, 0o755);
					} catch {
						// Ignore chmod failure on non-POSIX filesystems.
					}
				}
			}
		} catch {
			// Best-effort mirror.
		}
	}

	writeGitExclude(worktreePath: string, patterns: readonly string[]): void {
		try {
			// Linked git worktrees read exclude patterns from `--git-common-dir`/info/exclude, NOT per-worktree `--git-dir`!
			const gitCommonDir = resolve(worktreePath, git(worktreePath, ["rev-parse", "--git-common-dir"]));
			const infoDir = join(gitCommonDir, "info");
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
			this.writeGitExclude(worktreePath, WORKTREE_EXCLUDE_PATTERNS);
			const status = git(worktreePath, ["status", "--porcelain"]);
			if (!status) return undefined;
			git(worktreePath, ["add", "-A"]);
			// Unstage any cached bytecode/harness artifacts if they were somehow tracked before exclude ran.
			for (const junk of [".swarm", ".one_piece", ".gemini/settings.json", ".grok/config.toml"]) {
				try {
					git(worktreePath, ["reset", "-q", "HEAD", "--", junk]);
				} catch {
					// Not staged.
				}
			}
			const staged = git(worktreePath, ["diff", "--cached", "--name-only"]);
			if (!staged) return undefined;
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

	treeSha(worktreePath: string): string | undefined {
		try {
			return git(worktreePath, ["rev-parse", "HEAD^{tree}"]);
		} catch {
			return undefined;
		}
	}

	hasEditsSince(worktreePath: string, baseRef: string): boolean {
		try {
			const baseCommit = git(worktreePath, ["rev-parse", `${baseRef}^{commit}`]);
			const headCommit = git(worktreePath, ["rev-parse", "HEAD"]);
			if (headCommit !== baseCommit) return true;
			return Boolean(git(worktreePath, ["status", "--porcelain"]));
		} catch {
			const headCommit = this.headSha(worktreePath);
			return Boolean(headCommit && headCommit !== baseRef);
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
			// Hash the git TREE object (`HEAD^{tree}`) rather than the commit SHA so byte-identical
			// workspace states across different commit messages/timestamps yield the exact same digest.
			let tree = "";
			try {
				tree = git(worktreePath, ["rev-parse", "HEAD^{tree}"]);
			} catch {
				tree = git(worktreePath, ["rev-parse", "HEAD"]);
			}
			const status = git(worktreePath, ["status", "--porcelain"]);
			const diff = git(worktreePath, ["diff"]);
			return createHash("sha256").update(tree).update("\0").update(status).update("\0").update(diff).digest("hex").slice(0, 16);
		} catch {
			return "unknown";
		}
	}

	mergeIntoTrunk(branch: string, opts: { message?: string } = {}): MergeTrunkResult {
		const trunk = this.trunkPath;
		try {
			git(trunk, [
				"-c", "user.name=one-piece",
				"-c", "user.email=one-piece@local",
				"merge", "--no-ff", "-m", opts.message ?? `one-piece merge ${branch}`, branch,
			]);
			return { ok: true, commitSha: git(trunk, ["rev-parse", "HEAD"]) };
		} catch (error) {
			let conflictFiles: string[] = [];
			try {
				const unmerged = git(trunk, ["diff", "--name-only", "--diff-filter=U"]);
				conflictFiles = unmerged ? unmerged.split(/\r?\n/).filter(Boolean) : [];
			} catch {
				// Ignore unmerged file inspection failure.
			}
			try {
				git(trunk, ["merge", "--abort"]);
			} catch {
				// No merge in progress.
			}
			return { ok: false, conflictFiles, error: error instanceof Error ? error.message : String(error) };
		}
	}

	mergePreviewDiff(branch: string): { baseSha: string; trunkDiff: string; branchDiff: string } {
		const trunk = this.trunkPath;
		const maxChars = 16_384;
		let baseSha = this.baseSha;
		try {
			baseSha = git(trunk, ["merge-base", "HEAD", branch]) || this.baseSha;
		} catch {
			// Fall back to run baseSha.
		}
		const clip = (raw: string) => (raw.length > maxChars ? `${raw.slice(0, maxChars)}\n... [truncated]` : raw);
		let trunkDiff = "";
		let branchDiff = "";
		try {
			trunkDiff = clip(git(trunk, ["diff", `${baseSha}..HEAD`]));
		} catch {
			trunkDiff = "(trunk diff unavailable)";
		}
		try {
			branchDiff = clip(git(trunk, ["diff", `${baseSha}..${branch}`]));
		} catch {
			branchDiff = "(branch diff unavailable)";
		}
		return { baseSha, trunkDiff, branchDiff };
	}

	resetTrunk(ref: string): boolean {
		const trunk = this.trunkPath;
		try {
			git(trunk, ["reset", "--hard", ref]);
			git(trunk, ["clean", "-fd"]);
			return true;
		} catch {
			return false;
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
