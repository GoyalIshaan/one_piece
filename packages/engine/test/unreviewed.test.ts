import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { type Finding, MemoryStore } from "@one-piece/core";
import { Router } from "@one-piece/router";
import { describe, expect, it } from "vitest";
import { createHarness, simPolicy } from "../src/index.ts";

describe("run end", () => {
	it("enforces the run budget for the root and writes a fallback report", async () => {
		const store = new MemoryStore();
		const runDir = mkdtempSync(join(tmpdir(), "op-hard-cap-"));
		const router = new Router({ providers: [{ id: "sim", models: { default: "sim-a" }, maxConcurrent: 8, requestsPerMinute: 100000 }], simPolicy });
		const harness = createHarness({ store, router, config: { runDir } });
		const run = await harness.start({ title: "Budget test", text: "Find the value." }, { tokens: 300_000 });
		harness.tree.charge(run.rootNodeId, { tokens: 300_000 });
		await harness.done;
		expect(run.status).toBe("stopped");
		expect(harness.tree.isTerminal(run.rootNodeId)).toBe(true);
		expect(store.events(run.id, { types: ["budget.report_reserve", "run.finished"] }).map((event) => event.type)).toEqual(["budget.report_reserve", "run.finished"]);
		expect(readFileSync(join(runDir, "report.md"), "utf8")).toContain("run budget exhausted");
	});

	it("closes findings still waiting for review as unreviewed instead of leaving them pending", async () => {
		const reviewerStarted = Promise.withResolvers<void>();
		const releaseReview = Promise.withResolvers<void>();
		const policy: FauxResponseFactory = async (context, options, state, model) => {
			if (JSON.stringify(context.messages).includes("ROLE: claims_reviewer")) {
				reviewerStarted.resolve();
				await releaseReview.promise;
				return fauxAssistantMessage([fauxText("still checking")], { stopReason: "stop" });
			}
			return simPolicy(context, options, state, model);
		};
		const router = new Router({ providers: [{ id: "sim", models: { default: "sim-a" }, maxConcurrent: 8, requestsPerMinute: 100000 }], simPolicy: policy });
		const store = new MemoryStore();
		const runDir = mkdtempSync(join(tmpdir(), "op-unrev-"));
		const harness = createHarness({ store, router, config: { runDir, reviewFractions: [], epochCheckpoints: [] } });
		await harness.start({ title: "Unreviewed", text: "Find the value." }, { tokens: 400_000 });
		await reviewerStarted.promise;
		harness.finishRun("stopped", "eval time limit");
		releaseReview.resolve();
		await harness.done;
		const run = harness.run();
		const findings = store.list<Finding>("findings", { runId: run.id });
		expect(run.status).toBe("stopped");
		expect(findings.some((f) => f.status === "unreviewed")).toBe(true);
		expect(findings.some((f) => f.status === "pending_review")).toBe(false);
		expect(harness.tree.all().every((n) => harness.tree.isTerminal(n.id))).toBe(true);
		expect(readFileSync(join(runDir, "report.md"), "utf8")).toContain("Appendix: evidence trail");
	});
});
