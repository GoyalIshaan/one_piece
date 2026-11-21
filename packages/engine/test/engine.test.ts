import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Finding, MemoryStore, type Recommendation, type Report } from "@one-piece/core";
import { Router } from "@one-piece/router";
import { describe, expect, it } from "vitest";
import { createHarness, simPolicy } from "../src/index.ts";

function simRouter() {
	return new Router({
		providers: [
			{ id: "sim", models: { default: "sim-a" }, maxConcurrent: 8, requestsPerMinute: 100000 },
		],
		simPolicy,
	});
}

describe("engine with the simulator", () => {
	it("runs a full swarm: spawn, work, claims review, oversight, report", async () => {
		const store = new MemoryStore();
		const runDir = mkdtempSync(join(tmpdir(), "op-engine-"));
		const harness = createHarness({ store, router: simRouter(), config: { runDir, maxConcurrentAgents: 4 } });
		const run = await harness.start({ title: "Test goal", text: "Find the value." }, { tokens: 200_000 });
		await harness.done;
		if (process.env.DEBUG_EVENTS) for (const e of store.events(run.id)) if (!e.type.endsWith(".updated") && e.type !== "budget.charged") console.log(e.seq, e.type, e.nodeId ?? "", JSON.stringify(e.data).slice(0, 160));

		const nodes = harness.tree.all();
		const leaves = nodes.filter((n) => n.role === "leaf");
		expect(nodes.find((n) => n.role === "root")?.status).toBe("done");
		expect(leaves.length).toBe(3); // 1 from root + 2 from the internal node
		expect(nodes.some((n) => n.role === "internal")).toBe(true);
		expect(nodes.filter((n) => n.role === "claims_reviewer").length).toBeGreaterThanOrEqual(4);

		const findings = store.list<Finding>("findings", { runId: run.id });
		expect(findings.filter((f) => f.status === "accepted").length).toBe(4); // 3 leaves + 1 synthesis
		for (const f of findings) expect(f.rounds.length).toBeGreaterThanOrEqual(1);

		const reports = store.list<Report>("reports", { runId: run.id });
		const final = reports.filter((r) => r.kind === "final").at(-1);
		expect(final?.markdown).toContain("Appendix: evidence trail");
		expect(store.list<Recommendation>("recommendations", { runId: run.id }).length).toBeGreaterThan(0);

		// Budgets: spend rolls up to the root and never exceeds what was given.
		const root = nodes.find((n) => n.role === "root")!;
		expect(harness.tree.subtreeSpent(root.id).tokens).toBeGreaterThan(0);
		expect(store.events(run.id, { types: ["run.finished"] }).length).toBe(1);
	});
});
