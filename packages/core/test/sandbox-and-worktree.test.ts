import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitWorktreeManager, isPathBlocked, sandboxCommand } from "../src/index.ts";

describe("core immutable sandbox policies and clean worktree staging", () => {
	it("enforces per-call immutable deniedReadPaths without touching process-global state", () => {
		const root = mkdtempSync(join(tmpdir(), "op-core-sbx-"));
		try {
			const shardA = join(root, "shard-a");
			const shardB = join(root, "shard-b");
			const hidden = join(root, "hidden");
			mkdirSync(shardA, { recursive: true });
			mkdirSync(shardB, { recursive: true });
			mkdirSync(hidden, { recursive: true });
			const fileA = join(shardA, "data.json");
			const fileB = join(shardB, "data.json");
			const fileHidden = join(hidden, "answers.json");
			writeFileSync(fileA, "{}");
			writeFileSync(fileB, "{}");
			writeFileSync(fileHidden, "{}");

			const seatADenies = [hidden, shardB];
			const seatBDenies = [hidden, shardA];

			// Seat A can read shardA, blocked from shardB & hidden
			expect(isPathBlocked(fileA, seatADenies)).toBe(false);
			expect(isPathBlocked(fileB, seatADenies)).toBe(true);
			expect(isPathBlocked(fileHidden, seatADenies)).toBe(true);

			// Seat B can simultaneously read shardB, blocked from shardA & hidden
			expect(isPathBlocked(fileB, seatBDenies)).toBe(false);
			expect(isPathBlocked(fileA, seatBDenies)).toBe(true);
			expect(isPathBlocked(fileHidden, seatBDenies)).toBe(true);

			// Zero process-global pollution: an unrelated caller with empty denies sees nothing blocked
			expect(isPathBlocked(fileA, [])).toBe(false);
			expect(isPathBlocked(fileB, [])).toBe(false);
			expect(isPathBlocked(fileHidden, [])).toBe(false);

			if (process.platform === "darwin") {
				const cmdA = sandboxCommand(["/bin/echo", "ok"], { cwd: root, profile: "worker", deniedReadPaths: seatADenies });
				expect(cmdA[0]).toBe("/usr/bin/sandbox-exec");
				expect(cmdA[2]).toContain("shard-b");
				expect(cmdA[2]).not.toContain("shard-a");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("tracks treeSha/hasEditsSince accurately and excludes bytecode & harness dotfiles from commitWip", () => {
		const root = mkdtempSync(join(tmpdir(), "op-core-wt-"));
		try {
			const src = join(root, "src");
			const runDir = join(root, "run");
			mkdirSync(src, { recursive: true });
			writeFileSync(join(src, "app.py"), "print('v0')\n");

			const wt = new GitWorktreeManager(src, runDir, "run-wt-clean");
			const handle = wt.create("worker-1");
			const baseTree = wt.treeSha(handle.path);
			expect(baseTree).toBeTruthy();
			expect(wt.hasEditsSince(handle.path, wt.baseSha)).toBe(false);

			// Drop junk files that must never pollute git commits
			mkdirSync(join(handle.path, "__pycache__"), { recursive: true });
			writeFileSync(join(handle.path, "__pycache__", "app.cpython-312.pyc"), Buffer.from([0, 1, 2, 3]));
			mkdirSync(join(handle.path, ".grok"), { recursive: true });
			writeFileSync(join(handle.path, ".grok", "config.toml"), "url = 'http://127.0.0.1'");
			expect(wt.commitWip(handle.path, "should skip junk")).toBeUndefined();

			// Real source edit IS committed and changes treeSha + hasEditsSince
			writeFileSync(join(handle.path, "app.py"), "print('v1')\n");
			expect(wt.hasEditsSince(handle.path, wt.baseSha)).toBe(true);
			const wipSha = wt.commitWip(handle.path, "real edit");
			expect(wipSha).toBeTruthy();
			expect(wt.treeSha(handle.path)).not.toBe(baseTree);

			// Identical edits in a second worktree produce the exact same treeSha
			const handle2 = wt.create("worker-2");
			writeFileSync(join(handle2.path, "app.py"), "print('v1')\n");
			wt.commitWip(handle2.path, "different commit message");
			expect(wt.treeSha(handle2.path)).toBe(wt.treeSha(handle.path));
			expect(wt.diffSha(handle2.path)).toBe(wt.diffSha(handle.path));
			expect(existsSync(join(handle.path, "app.py"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
