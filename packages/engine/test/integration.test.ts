import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testHarness } from "@one-piece/core/testing";
import { ensureWorkspace } from "@one-piece/module-workspace";
import { describe, expect, it } from "vitest";

describe("integrating worker", () => {
	it("starts from another worker's workspace instead of the seed", () => {
		const { harness, root, tree } = testHarness();
		const a = tree.create({ runId: root.runId, epoch: 1, role: "leaf", parentId: root.id, goal: { title: "a", text: "a" }, budget: {} });
		const dirA = ensureWorkspace(harness, a.id);
		writeFileSync(join(dirA, "algos.py"), "fast = True\n");
		const integrator = tree.create({ runId: root.runId, epoch: 1, role: "leaf", parentId: root.id, goal: { title: "i", text: "i" }, budget: {} });
		tree.update(integrator.id, { startFrom: a.id, sources: [a.id] });
		const dirI = ensureWorkspace(harness, integrator.id);
		expect(readFileSync(join(dirI, "algos.py"), "utf8")).toBe("fast = True\n");
		// The copy is independent: its own git history, and the source is untouched by later writes.
		expect(existsSync(join(dirI, ".git"))).toBe(true);
		writeFileSync(join(dirI, "algos.py"), "merged = True\n");
		expect(readFileSync(join(dirA, "algos.py"), "utf8")).toBe("fast = True\n");
	});
});
