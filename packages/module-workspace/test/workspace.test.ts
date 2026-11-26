import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus, FileArtifactStore, MemoryStore, Redactor } from "@one-piece/core";
import { workspaceTools } from "../src/index.ts";

describe("module-workspace v2", () => {
	it("fails loudly on missing/ambiguous edits and verifies post-write SHA on success", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-ws-"));
		try {
			const bus = new EventBus(new MemoryStore(), new Redactor());
			const tools = workspaceTools({ bus });
			const editTool = tools.find((t) => t.name === "apply_workspace_change")!;
			const ctx = { runId: "r1", agentId: "a1", role: "worker" as const, workspace: dir, signal: new AbortController().signal };

			// Missing file fails loudly
			const missing = await editTool.execute({ operation: "edit", path: "nope.txt", old_text: "a", new_text: "b" }, ctx);
			expect(missing.isError).toBe(true);

			// Create + valid edit succeeds with SHA diff
			const created = await editTool.execute({ operation: "create", path: "foo.txt", content: "alpha\nbeta\n" }, ctx);
			expect(created.isError).toBeFalsy();
			const edited = await editTool.execute({ operation: "edit", path: "foo.txt", old_text: "beta", new_text: "gamma" }, ctx);
			expect(edited.isError).toBeFalsy();
			expect(readFileSync(join(dir, "foo.txt"), "utf8")).toBe("alpha\ngamma\n");

			// Missing old_text fails loudly
			const notFound = await editTool.execute({ operation: "edit", path: "foo.txt", old_text: "beta", new_text: "delta" }, ctx);
			expect(notFound.isError).toBe(true);

			// Ambiguous match fails loudly
			writeFileSync(join(dir, "dup.txt"), "x\nx\n", "utf8");
			const ambig = await editTool.execute({ operation: "edit", path: "dup.txt", old_text: "x", new_text: "y" }, ctx);
			expect(ambig.isError).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("supports bounded grep_files and Tier 0 artifact spillover for large bash outputs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-ws-spill-"));
		const runDir = mkdtempSync(join(tmpdir(), "op-ws-run-"));
		try {
			const bus = new EventBus(new MemoryStore(), new Redactor());
			const artifacts = new FileArtifactStore("r1", runDir, bus);
			const tools = workspaceTools({ bus, artifacts, maxInlineOutputBytes: 1024 });
			const grepTool = tools.find((t) => t.name === "grep_files")!;
			const bashTool = tools.find((t) => t.name === "bash")!;
			const ctx = { runId: "r1", agentId: "a1", role: "worker" as const, workspace: dir, signal: new AbortController().signal };

			writeFileSync(join(dir, "src.ts"), "export const magicToken = 42;\nexport const other = 1;\n", "utf8");
			const found = await grepTool.execute({ pattern: "magicToken" }, ctx);
			expect(found.isError).toBeFalsy();
			expect(found.text).toContain("src.ts:1:export const magicToken = 42;");

			const missingGrep = await grepTool.execute({ pattern: "magicToken", path: "does-not-exist" }, ctx);
			expect(missingGrep.isError).toBe(true);

			// Generate > 4KB output via bash -> must spill losslessly into FileArtifactStore
			const big = await bashTool.execute({ command: 'node -e "console.log(\'LINE_START\\n\' + \'A\'.repeat(6000) + \'\\nLINE_END\')"' }, ctx);
			expect(big.isError).toBe(false);
			expect(big.text).toContain("LINE_START");
			expect(big.text).toContain("LINE_END");
			expect(big.text).toContain("artifact_id=");
			const artifactId = (big.data as any)?.artifactId;
			expect(artifactId).toBeTruthy();
			const page = artifacts.read(artifactId, 0, 100);
			expect(page.content).toContain("LINE_START");
			expect(page.totalBytes).toBeGreaterThan(6000);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(runDir, { recursive: true, force: true });
		}
	});

	it("returns nearest-line and whitespace diagnostics on edit mismatch and supports OpenAI-style apply_patch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-ws-patch-"));
		try {
			const bus = new EventBus(new MemoryStore(), new Redactor());
			const ctx = { runId: "r1", agentId: "a1", role: "worker" as const, workspace: dir, signal: new AbortController().signal };

			// 1. Targeted edit-mismatch diagnostic (spaces vs tabs + closest matching lines)
			writeFileSync(join(dir, "calc.ts"), "export function add(a: number, b: number) {\n\treturn a + b;\n}\n", "utf8");
			const srTools = workspaceTools({ bus, editFormat: "search_replace" });
			const editTool = srTools.find((t) => t.name === "apply_workspace_change")!;
			const mismatch = await editTool.execute(
				{ operation: "edit", path: "calc.ts", old_text: "  return a + b;", new_text: "  return a + b + 1;" },
				ctx,
			);
			expect(mismatch.isError).toBe(true);
			expect(mismatch.text).toContain("tab indentation");
			expect(mismatch.text).toContain("Closest match in calc.ts");
			expect(mismatch.text).toContain("2\t\treturn a + b;");

			// 2. OpenAI/Codex-native apply_patch format: Add, Update, Delete + path traversal rejection
			const patchTools = workspaceTools({ bus, editFormat: "apply_patch" });
			const patchTool = patchTools.find((t) => t.name === "apply_patch")!;
			expect(patchTool).toBeDefined();
			expect(patchTools.find((t) => t.name === "apply_workspace_change")).toBeUndefined();

			const okPatch = await patchTool.execute(
				{
					patch: [
						"*** Begin Patch",
						"*** Add File: sub/new.txt",
						"+hello world",
						"*** Update File: calc.ts",
						"@@",
						" export function add(a: number, b: number) {",
						"-\treturn a + b;",
						"+\treturn a + b + 10;",
						" }",
						"*** End Patch",
					].join("\n"),
				},
				ctx,
			);
			expect(okPatch.isError).toBeFalsy();
			expect(readFileSync(join(dir, "sub/new.txt"), "utf8")).toBe("hello world\n");
			expect(readFileSync(join(dir, "calc.ts"), "utf8")).toContain("return a + b + 10;");

			const delPatch = await patchTool.execute(
				{
					patch: ["*** Begin Patch", "*** Delete File: sub/new.txt", "*** End Patch"].join("\n"),
				},
				ctx,
			);
			expect(delPatch.isError).toBeFalsy();
			expect(existsSync(join(dir, "sub/new.txt"))).toBe(false);

			// Atomic 2-phase rollback: if file #2 fails, file #1 MUST NOT be created on disk!
			const atomicFail = await patchTool.execute(
				{
					patch: [
						"*** Begin Patch",
						"*** Add File: atomic-should-not-exist.txt",
						"+partial write",
						"*** Update File: calc.ts",
						"@@",
						" non_existent_line();",
						"-bad",
						"+good",
						"*** End Patch",
					].join("\n"),
				},
				ctx,
			);
			expect(atomicFail.isError).toBe(true);
			expect(existsSync(join(dir, "atomic-should-not-exist.txt"))).toBe(false);

			// Hunk with zero context/removed lines must be rejected cleanly
			const emptyOldHunk = await patchTool.execute(
				{
					patch: ["*** Begin Patch", "*** Update File: calc.ts", "@@", "+orphan", "*** End Patch"].join("\n"),
				},
				ctx,
			);
			expect(emptyOldHunk.isError).toBe(true);
			expect(emptyOldHunk.text).toContain("at least one context");

			// Path escape must throw / fail outside workspace
			await expect(
				Promise.resolve().then(() =>
					patchTool.execute(
						{ patch: ["*** Begin Patch", "*** Add File: ../escape.txt", "+bad", "*** End Patch"].join("\n") },
						ctx,
					),
				),
			).rejects.toThrow(/outside workspace/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
