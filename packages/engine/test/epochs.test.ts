import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { type Epoch, MemoryStore, type Report } from "@one-piece/core";
import { Router } from "@one-piece/router";
import { describe, expect, it } from "vitest";
import { createHarness, simPolicy } from "../src/index.ts";

describe("epochs", () => {
	it("the root reviewer can start a new epoch that carries a branch and archives the rest", async () => {
		let started = false;
		const policy: FauxResponseFactory = (context, options, state, model) => {
			const text = JSON.stringify(context.messages);
			if (text.includes("ROLE: root_reviewer") && !started) {
				const carry = /- (node-[\w-]+) \[internal\]/.exec(text)?.[1];
				if (carry) {
					started = true;
					return fauxAssistantMessage(
						[fauxToolCall("decide_epoch", { start: true, trigger: "A_saturation", mode: "mix", carry: [carry], handoff: "## Known\n- baseline verified\n## Next\n- push the alternative mechanism", reason: "test" })],
						{ stopReason: "toolUse" },
					);
				}
			}
			return simPolicy(context, options, state, model);
		};
		const store = new MemoryStore();
		const runDir = mkdtempSync(join(tmpdir(), "op-epoch-"));
		const router = new Router({ providers: [{ id: "sim", models: { default: "sim-a" }, maxConcurrent: 8, requestsPerMinute: 100000 }], simPolicy: policy });
		const harness = createHarness({ store, router, config: { runDir, maxConcurrentAgents: 6, epochCheckpoints: [0.02, 0.5] } });
		const run = await harness.start({ title: "Epoch test", text: "Find the value." }, { tokens: 1_000_000 });
		await harness.done;

		const epochs = store.list<Epoch>("epochs", { runId: run.id });
		expect(started).toBe(true);
		expect(epochs.length).toBe(2);
		const second = epochs.find((e) => e.number === 2)!;
		expect(second.mode).toBe("mix");
		expect(second.carried.length).toBe(1);
		const roots = harness.tree.all().filter((n) => n.role === "root");
		expect(roots.find((r) => r.epoch === 1)!.status).toBe("archived");
		expect(roots.find((r) => r.epoch === 2)!.status).toBe("done");
		// The carried branch now hangs under the new root.
		expect(harness.tree.require(second.carried[0]).parentId).toBe(second.rootNodeId);
		expect(store.list<Report>("reports", { runId: run.id }).some((r) => r.kind === "handoff")).toBe(true);
		expect(harness.run().epoch).toBe(2);
	});
});
