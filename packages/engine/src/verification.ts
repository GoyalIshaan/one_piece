import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	constants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	readSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { EventBus, Finding, FindingSubmission, FindingVerifier, VerificationReceipt } from "@one-piece/core";

const IGNORED_DIRS = new Set([
	".git",
	"__pycache__",
	".one_piece",
	".swarm",
	".gemini",
	".grok",
	"node_modules",
	".eval-tmp",
	".onepiece-eval.patch",
	".onepiece-snapshot.json",
]);

const PATCH_EXCLUDE_SPECS = [
	":(exclude)ISSUE.md",
	":(exclude).eval-exec",
	":(exclude).eval-tmp",
	":(exclude).swarm",
	":(exclude).one_piece",
	":(exclude).gemini",
	":(exclude).grok",
	":(exclude).onepiece-eval.patch",
	":(exclude).onepiece-snapshot.json",
];

const FULL_SNAPSHOT_MAX_ENTRIES = 2_048;
const FULL_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
const NON_GIT_MAX_ENTRIES = 16_384;
const NON_GIT_MAX_BYTES = 256 * 1024 * 1024;
const MAX_STORED_PATCH_BYTES = 32 * 1024 * 1024;

function hashFileStreaming(filePath: string, size: number): Buffer {
	const fileHash = createHash("sha256");
	if (size <= 8 * 1024 * 1024) {
		fileHash.update(readFileSync(filePath));
		return fileHash.digest();
	}
	const fd = openSync(filePath, "r");
	const buf = Buffer.allocUnsafe(1024 * 1024);
	try {
		let bytesRead = 0;
		while ((bytesRead = readSync(fd, buf, 0, buf.length, null)) > 0) {
			fileHash.update(buf.subarray(0, bytesRead));
		}
	} finally {
		closeSync(fd);
	}
	return fileHash.digest();
}

function copyFileCow(src: string, dst: string): void {
	try {
		copyFileSync(src, dst, constants.COPYFILE_FICLONE);
	} catch {
		copyFileSync(src, dst);
	}
}

function extractGitWorkspaceDelta(workspace: string): {
	baseSha: string;
	headSha: string;
	changedFiles: string[];
	patch: string;
} | undefined {
	const abs = resolve(workspace);
	if (!existsSync(join(abs, ".git"))) return undefined;
	const tmpIndex = join(tmpdir(), `op-snap-idx-${process.pid}-${randomBytes(6).toString("hex")}`);
	const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
	try {
		const baseSha = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
			cwd: abs,
			encoding: "utf8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "pipe"],
		})
			.trim()
			.split("\n")[0];
		if (!baseSha) return undefined;
		const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: abs,
			encoding: "utf8",
			timeout: 5_000,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();

		// Stage committed + unstaged + untracked non-ignored files into a throwaway index (zero mutation to workspace)
		execFileSync("git", ["read-tree", "HEAD"], { cwd: abs, env, timeout: 15_000, stdio: "ignore" });
		execFileSync("git", ["add", "-A", "--", "."], { cwd: abs, env, timeout: 30_000, stdio: "ignore" });

		const changedRaw = execFileSync(
			"git",
			["diff", "--cached", "--name-only", baseSha, "--", ".", ...PATCH_EXCLUDE_SPECS],
			{ cwd: abs, env, encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
		);
		const changedFiles = changedRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

		let patch = "";
		try {
			patch = execFileSync(
				"git",
				["diff", "--cached", "--binary", baseSha, "--", ".", ...PATCH_EXCLUDE_SPECS],
				{ cwd: abs, env, encoding: "utf8", timeout: 20_000, maxBuffer: MAX_STORED_PATCH_BYTES, stdio: ["ignore", "pipe", "pipe"] },
			);
		} catch {
			// If binary diff exceeds MAX_STORED_PATCH_BYTES (e.g., huge ML prediction CSV), fall back to non-binary or skip inline patch.
			try {
				patch = execFileSync(
					"git",
					["diff", "--cached", baseSha, "--", ".", ...PATCH_EXCLUDE_SPECS],
					{ cwd: abs, env, encoding: "utf8", timeout: 20_000, maxBuffer: MAX_STORED_PATCH_BYTES, stdio: ["ignore", "pipe", "pipe"] },
				);
			} catch {
				patch = "";
			}
		}

		return { baseSha, headSha, changedFiles, patch };
	} catch {
		return undefined;
	} finally {
		rmSync(tmpIndex, { force: true });
	}
}

function measureTreeScale(workspace: string, maxEntries: number, maxBytes: number): { exceeds: boolean; entries: number; bytes: number } {
	let entries = 0;
	let bytes = 0;
	function scan(relDir: string): boolean {
		for (const name of readdirSync(join(workspace, relDir))) {
			if (IGNORED_DIRS.has(name)) continue;
			const rel = join(relDir, name);
			const stat = lstatSync(join(workspace, rel));
			if (stat.isSymbolicLink()) continue;
			entries += 1;
			if (stat.isFile()) bytes += stat.size;
			if (entries > maxEntries || bytes > maxBytes) return true;
			if (stat.isDirectory() && scan(rel)) return true;
		}
		return false;
	}
	const exceeds = scan("");
	return { exceeds, entries, bytes };
}

/**
 * Freeze a workspace snapshot BEFORE async verification/review so an author cannot mutate
 * files underneath a reviewer. Returns a deterministic SHA-256 tree hash.
 *
 * Efficiency guarantees:
 * - Preserves symlinks via `symlinkSync` (0 bytes copied/read — e.g. multi-GB read-only MLE-bench `data/`).
 * - Uses APFS/Btrfs copy-on-write (`COPYFILE_FICLONE`) for zero-duplicate-block file snapshots.
 * - For git repositories, captures `.onepiece-eval.patch` cleanly (including untracked files via temp index).
 * - For large git repositories (> 2,048 entries or > 32 MiB, e.g. Django / SymPy / scikit-learn),
 *   uses a fast sparse git-delta snapshot (changed/untracked files + top-level symlinks + `.onepiece-eval.patch`)
 *   instead of failing or copying thousands of untouched repository files.
 */
export function captureFrozenSnapshot(workspace: string, destination: string): string {
	const absWorkspace = resolve(workspace);
	const hash = createHash("sha256");

	try {
		if (!lstatSync(absWorkspace).isDirectory()) throw new Error("Workspace is not a directory");

		const gitDelta = extractGitWorkspaceDelta(absWorkspace);
		const scale = measureTreeScale(absWorkspace, FULL_SNAPSHOT_MAX_ENTRIES, FULL_SNAPSHOT_MAX_BYTES);

		if (gitDelta && scale.exceeds) {
			// Fast sparse git-delta frozen snapshot for large repos (SWE-bench Django/SymPy/etc., large ML repos)
			mkdirSync(destination, { recursive: true });
			hash.update(`GIT_SPARSE:${gitDelta.baseSha}\n`);

			// Mirror top-level symlinks (e.g. MLE-bench `data -> /path/to/public`) with 0 bytes copied
			for (const name of readdirSync(absWorkspace).sort()) {
				if (IGNORED_DIRS.has(name)) continue;
				const src = join(absWorkspace, name);
				const st = lstatSync(src);
				if (st.isSymbolicLink()) {
					const target = readlinkSync(src);
					symlinkSync(target, join(destination, name));
					hash.update(JSON.stringify([name, "symlink", target]));
				}
			}

			// Copy every changed/untracked file via CoW clone preserving relative paths
			for (const rel of gitDelta.changedFiles.sort()) {
				const src = join(absWorkspace, rel);
				if (!existsSync(src)) {
					hash.update(JSON.stringify([rel, "deleted"]));
					continue;
				}
				const st = lstatSync(src);
				const dst = join(destination, rel);
				mkdirSync(dirname(dst), { recursive: true });
				if (st.isSymbolicLink()) {
					const target = readlinkSync(src);
					symlinkSync(target, dst);
					hash.update(JSON.stringify([rel, "symlink", target]));
				} else if (st.isFile()) {
					copyFileCow(src, dst);
					hash.update(JSON.stringify([rel, "file"]));
					hash.update(hashFileStreaming(dst, st.size));
				}
			}

			writeFileSync(join(destination, ".onepiece-eval.patch"), gitDelta.patch, "utf8");
			writeFileSync(
				join(destination, ".onepiece-snapshot.json"),
				JSON.stringify(
					{
						mode: "git-sparse",
						baseSha: gitDelta.baseSha,
						headSha: gitDelta.headSha,
						changedFiles: gitDelta.changedFiles,
					},
					null,
					2,
				) + "\n",
				"utf8",
			);
			hash.update(createHash("sha256").update(gitDelta.patch, "utf8").digest());
			return hash.digest("hex");
		}

		// Standard full APFS CoW frozen snapshot (with symlink preservation & streaming hash)
		let bytes = 0;
		let entries = 0;

		function visit(relDir: string): void {
			mkdirSync(join(destination, relDir), { recursive: true });
			for (const name of readdirSync(join(absWorkspace, relDir)).sort()) {
				if (IGNORED_DIRS.has(name)) continue;
				const rel = join(relDir, name);
				const src = join(absWorkspace, rel);
				const stat = lstatSync(src);
				if (stat.isSymbolicLink()) {
					const target = readlinkSync(src);
					symlinkSync(target, join(destination, rel));
					hash.update(JSON.stringify([rel, "symlink", target]));
					continue;
				}
				entries += 1;
				bytes += stat.isFile() ? stat.size : 0;
				if (entries > NON_GIT_MAX_ENTRIES || bytes > NON_GIT_MAX_BYTES) {
					throw new Error(`Submission exceeds snapshot limit (${NON_GIT_MAX_ENTRIES} entries / 256 MiB)`);
				}
				hash.update(JSON.stringify([rel, stat.isDirectory() ? "dir" : "file"]));
				if (stat.isDirectory()) {
					visit(rel);
				} else if (stat.isFile()) {
					const dst = join(destination, rel);
					copyFileCow(src, dst);
					hash.update(hashFileStreaming(dst, stat.size));
				}
			}
		}

		visit("");
		if (gitDelta) {
			writeFileSync(join(destination, ".onepiece-eval.patch"), gitDelta.patch, "utf8");
		}
		return hash.digest("hex");
	} catch (error) {
		rmSync(destination, { recursive: true, force: true });
		throw error;
	}
}

export async function runExecutableCheck(opts: {
	bus: EventBus;
	finding: Finding;
	submission: FindingSubmission;
	verifier: FindingVerifier;
	actorId: string;
	challenge?: string;
	signal: AbortSignal;
}): Promise<VerificationReceipt> {
	const { bus, finding, submission, verifier, actorId, challenge, signal } = opts;
	const start = performance.now();
	const stamp = {
		checker: verifier.name,
		version: verifier.version,
		kind: challenge === undefined ? ("suite" as const) : ("counterexample" as const),
	};
	let receipt: VerificationReceipt;
	try {
		signal.throwIfAborted();
		if (!submission.snapshotDir || !submission.artifactSha256) {
			throw new Error("Submission lacks a frozen snapshot directory or SHA-256 digest");
		}
		const scope = submission.scope ?? verifier.defaultScope;
		const out = await verifier.check({
			workspace: submission.snapshotDir,
			artifactSha256: submission.artifactSha256,
			scope,
			challenge,
			signal,
		});
		if (typeof out.score === "number" && Number.isFinite(out.score)) {
			submission.score = out.score;
			finding.score = out.score;
		}
		const cleanMsg = bus.redactor.redactText(out.message);
		const durationMs = Math.round(performance.now() - start);
		if (out.status === "failed") {
			receipt = { ...stamp, status: "failed", message: cleanMsg, score: out.score, counterexample: out.counterexample, durationMs };
		} else if (out.status === "passed") {
			receipt = { ...stamp, status: "passed", message: cleanMsg, score: out.score, durationMs };
		} else {
			receipt = { ...stamp, status: out.status, message: cleanMsg, score: out.score, durationMs };
		}
	} catch (error) {
		receipt = {
			...stamp,
			status: "error",
			message: bus.redactor.redactText(error instanceof Error ? error.message : String(error)),
			durationMs: Math.round(performance.now() - start),
		};
	}
	submission.checks.push(receipt);
	bus.emit(
		finding.runId,
		"finding.verification",
		{
			findingId: finding.id,
			revision: submission.revision,
			scope: submission.scope ?? verifier.defaultScope,
			status: receipt.status,
			message: receipt.message,
			score: submission.score,
		},
		actorId,
	);
	return receipt;
}
