import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MemoryStore } from "@one-piece/core";
import { Router } from "@one-piece/router";
import { describe, expect, it } from "vitest";
import { createHarness, simPolicy } from "../src/index.ts";

describe("model menu", () => {
	it("managers see the menu and can put a child on a cheaper model", async () => {
		let sawMenu = false;
		const policy: FauxResponseFactory = (context, options, state, model) => {
			const text = JSON.stringify(context.messages);
			const isRoot = text.includes("ROLE: root") && !text.includes("ROLE: root_reviewer");
			const spawned = (context.messages as Array<{ role: string; toolName?: string }>).some((m) => m.role === "toolResult" && m.toolName === "spawn_children");
			if (isRoot && !spawned) {
				sawMenu = text.includes("sim:sim-fast");
				return fauxAssistantMessage(
					[fauxToolCall("spawn_children", { children: [{ title: "Cheap worker", goal: "Find the value.", kind: "work", budget_share: 0.5, model: "sim:sim-fast" }] })],
					{ stopReason: "toolUse" },
				);
			}
			return simPolicy(context, options, state, model);
		};
		const router = new Router({
			providers: [{ id: "sim", models: { default: "sim-strong" }, offer: [{ id: "sim-fast", tier: "fast", note: "cheap" }], maxConcurrent: 8, requestsPerMinute: 100000 }],
			simPolicy: policy,
		});
		const store = new MemoryStore();
		const harness = createHarness({ store, router, config: { runDir: mkdtempSync(join(tmpdir(), "op-menu-")) } });
		await harness.start({ title: "Menu", text: "Find the value." }, { tokens: 200_000 });
		await harness.done;
		expect(sawMenu).toBe(true);
		const leaf = harness.tree.all().find((n) => n.role === "leaf")!;
		expect(leaf.model).toEqual({ provider: "sim", id: "sim-fast" });
		const calls = store.events(harness.run().id, { types: ["model.call"], nodeId: leaf.id });
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((e) => e.data.model === "sim-fast")).toBe(true);
	});
});
