import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { type Finding, MemoryStore } from "@one-piece/core";
import { Router } from "@one-piece/router";
import { describe, expect, it } from "vitest";
import { createHarness, simPolicy } from "../src/index.ts";

describe("budget wrap-up", () => {
	it("warns a worker, and gives a worker that never reported a grace to report", async () => {
		let warned = false;
		const policy: FauxResponseFactory = (context, options, state, model) => {
			const text = JSON.stringify(context.messages);
			if (text.includes("ROLE: leaf")) {
				if (text.includes("budget is used up")) {
					const reported = (context.messages as Array<{ role: string; toolName?: string }>).some((m) => m.role === "toolResult" && m.toolName === "report_finding");
					return reported
						? fauxAssistantMessage([fauxToolCall("finish", { status: "finished", summary: "reported in grace" })], { stopReason: "toolUse" })
						: fauxAssistantMessage([fauxToolCall("report_finding", { claim: "Late result", reasoning: "r", evidence: ["e"], level: "hypothesis" })], { stopReason: "toolUse" });
				}
				if (text.includes("[harness] Budget")) warned = true;
				// Ignore the warning and keep polishing with a bulky checkpoint, burning budget.
				return fauxAssistantMessage([fauxText("polishing"), fauxToolCall("write_checkpoint", { checkpoint: "x".repeat(4000) })], { stopReason: "toolUse" });
			}
			return simPolicy(context, options, state, model);
		};
		const router = new Router({ providers: [{ id: "sim", models: { default: "sim-a" }, maxConcurrent: 8, requestsPerMinute: 100000 }], simPolicy: policy });
		const store = new MemoryStore();
		const harness = createHarness({ store, router, config: { runDir: mkdtempSync(join(tmpdir(), "op-grace-")), reviewFractions: [], epochCheckpoints: [] } });
		await harness.start({ title: "Grace", text: "Find the value." }, { tokens: 400_000 });
		await harness.done;
		expect(warned).toBe(true);
		const findings = store.list<Finding>("findings", { runId: harness.run().id });
		expect(findings.some((f) => f.claim === "Late result")).toBe(true);
		expect(store.events(harness.run().id, { types: ["budget.grace"] }).length).toBeGreaterThan(0);
	});
});
