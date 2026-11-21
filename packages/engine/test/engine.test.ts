import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { type Finding, MemoryStore, type Recommendation, type Report } from "@one-piece/core";
import { Router } from "@one-piece/router";
import { describe, expect, it } from "vitest";
import { createHarness, simPolicy } from "../src/index.ts";

function simRouter(policy: FauxResponseFactory = simPolicy) {
	return new Router({
		providers: [
			{ id: "sim", models: { default: "sim-a" }, maxConcurrent: 8, requestsPerMinute: 100000 },
		],
		simPolicy: policy,
	});
}

describe("engine with the simulator", () => {
	it("allows an explorer to spawn another explorer with its own workers", async () => {
		const policy: FauxResponseFactory = (context, options, state, model) => {
			const messages = JSON.stringify(context.messages);
			if (messages.includes("ROLE: internal") && messages.includes("# Your goal: Alternative mechanism") && !messages.includes('"toolName":"spawn_children"')) {
				return fauxAssistantMessage([fauxToolCall("spawn_children", { children: [
					{ title: "Subproblem explorer", goal: "Coordinate independent checks", kind: "explore", budget_share: 0.6 },
				] })], { stopReason: "toolUse" });
			}
			return simPolicy(context, options, state, model);
		};
		const store = new MemoryStore();
		const harness = createHarness({ store, router: simRouter(policy), config: { runDir: mkdtempSync(join(tmpdir(), "op-depth-")), caps: { maxChildren: 3, maxDepth: 3 } } });
		const run = await harness.start({ title: "Recursive delegation", text: "Find the value." }, { tokens: 1_000_000 });
		await harness.done;
		const nested = harness.tree.all().find((node) => node.role === "internal" && node.depth === 2)!;
		expect(nested.goal.title).toBe("Subproblem explorer");
		expect(harness.tree.require(nested.parentId!).role).toBe("internal");
		expect(harness.tree.children(nested.id).map((node) => [node.role, node.depth])).toEqual([["leaf", 3], ["leaf", 3]]);
		expect(store.events(run.id, { nodeId: nested.id, types: ["tree.spawned"] })).toHaveLength(1);
	});

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

		// Accounting: every model call is counted once, on the agent that made it. Reviewers keep
		// their own spend, and the reviewed agent records it separately as oversight.
		const calls = store.events(run.id, { types: ["model.call"] }).reduce((a, e) => a + Number(e.data.totalTokens), 0);
		const own = nodes.reduce((a, n) => a + (n.spent.tokens ?? 0), 0);
		const reviewers = nodes.filter((n) => n.role.endsWith("reviewer"));
		const reviewerOwn = reviewers.reduce((a, n) => a + (n.spent.tokens ?? 0), 0);
		const oversight = nodes.reduce((a, n) => a + (n.oversight.tokens ?? 0), 0);
		expect(own).toBe(calls);
		expect(reviewerOwn).toBeGreaterThan(0);
		expect(oversight).toBe(reviewerOwn);
		const leaf = leaves[0];
		const leafCalls = store.events(run.id, { types: ["model.call"], nodeId: leaf.id }).reduce((a, e) => a + Number(e.data.totalTokens), 0);
		expect(leaf.spent.tokens).toBe(leafCalls);
	});
});
