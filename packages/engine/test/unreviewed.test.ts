import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { type Finding, MemoryStore } from "@one-piece/core";
import { Router } from "@one-piece/router";
import { describe, expect, it } from "vitest";
import { createHarness, simPolicy } from "../src/index.ts";

describe("run end", () => {
	it("closes findings still waiting for review as unreviewed instead of leaving them pending", async () => {
		// The claims reviewer is slow: the run ends while it is still thinking.
		const policy: FauxResponseFactory = async (context, options, state, model) => {
			if (JSON.stringify(context.messages).includes("ROLE: claims_reviewer")) {
				await new Promise((r) => setTimeout(r, 400));
				return fauxAssistantMessage([fauxText("still checking")], { stopReason: "stop" });
			}
			return simPolicy(context, options, state, model);
		};
		const router = new Router({ providers: [{ id: "sim", models: { default: "sim-a" }, maxConcurrent: 8, requestsPerMinute: 100000 }], simPolicy: policy });
		const store = new MemoryStore();
		const harness = createHarness({ store, router, config: { runDir: mkdtempSync(join(tmpdir(), "op-unrev-")), reviewFractions: [], epochCheckpoints: [] } });
		await harness.start({ title: "Unreviewed", text: "Find the value." }, { tokens: 400_000 });
		await harness.done;
		const findings = store.list<Finding>("findings", { runId: harness.run().id });
		expect(findings.length).toBeGreaterThan(0);
		expect(findings.some((f) => f.status === "pending_review")).toBe(false);
	});
});
