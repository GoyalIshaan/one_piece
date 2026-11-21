import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { type Finding, MemoryStore } from "@one-piece/core";
import { Router } from "@one-piece/router";
import { describe, expect, it } from "vitest";
import { createHarness, simPolicy } from "../src/index.ts";

describe("resilience", () => {
	it("retries temporary provider errors with backoff instead of giving up", async () => {
		let failed = 0;
		const policy: FauxResponseFactory = (context, options, state, model) => {
			if (failed < 2 && JSON.stringify(context.messages).includes("ROLE: leaf")) {
				failed += 1;
				return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Our servers are currently overloaded. Please try again later." });
			}
			return simPolicy(context, options, state, model);
		};
		const store = new MemoryStore();
		const router = new Router({ providers: [{ id: "sim", models: { default: "sim-a" }, maxConcurrent: 8, requestsPerMinute: 100000 }], simPolicy: policy });
		const harness = createHarness({ store, router, config: { runDir: mkdtempSync(join(tmpdir(), "op-res-")), retryBaseMs: 5 } });
		const run = await harness.start({ title: "Resilience", text: "Find the value." }, { tokens: 300_000 });
		await harness.done;
		expect(failed).toBe(2);
		expect(store.events(run.id, { types: ["agent.retry"] }).length).toBe(2);
		expect(store.list<Finding>("findings", { runId: run.id }).filter((f) => f.status === "accepted").length).toBe(4);
	});

	it("spaces hidden reviews out instead of reviewing a fast spender back to back", async () => {
		const store = new MemoryStore();
		const router = new Router({ providers: [{ id: "sim", models: { default: "sim-a" }, maxConcurrent: 8, requestsPerMinute: 100000 }], simPolicy });
		const harness = createHarness({ store, router, config: { runDir: mkdtempSync(join(tmpdir(), "op-rev-")) } });
		const run = await harness.start({ title: "Reviews", text: "Find the value." }, { tokens: 120_000 });
		await harness.done;
		const leaves = harness.tree.all().filter((n) => n.role === "leaf");
		for (const leaf of leaves) {
			const reviews = harness.tree.all().filter((n) => n.role === "hidden_reviewer" && n.targetNodeId === leaf.id);
			expect(reviews.length).toBeLessThanOrEqual(Math.ceil(leaf.turns / harness.config.reviewCooldownTurns) + 1);
		}
		expect(store.events(run.id, { types: ["run.finished"] }).length).toBe(1);
	});
});
