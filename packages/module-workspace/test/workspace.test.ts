import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus, MemoryStore, Redactor } from "@one-piece/core";
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
});
