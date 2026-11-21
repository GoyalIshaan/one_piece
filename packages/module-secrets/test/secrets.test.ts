import { testHarness } from "@one-piece/core/testing";
import { describe, expect, it } from "vitest";
import { secretsModule } from "../src/index.ts";

describe("secrets broker", () => {
	it("inherits grants downward, never widens them, and redacts values", async () => {
		const { harness, root, tree, bus, store } = testHarness();
		const module = secretsModule({ secrets: [{ name: "gpu.modal", env: "MODAL_TOKEN" }, { name: "api.x", env: "X_KEY" }], rootGrants: ["gpu.modal"], lookup: (n) => `value-of-${n}-0123456789` });
		await module.setup!(harness);
		const broker = harness.services.require("secrets");
		const child = tree.create({ runId: root.runId, epoch: 1, role: "leaf", parentId: root.id, goal: { title: "c", text: "c" }, budget: {} });
		expect(broker.grantsOf(child.id)).toEqual(["gpu.modal"]);
		expect(() => broker.grant(child.id, ["api.x"])).toThrow(/does not hold/);
		expect(() => broker.envFor(child.id, ["api.x"])).toThrow(/not granted/);
		const env = broker.envFor(child.id, ["gpu.modal"]);
		expect(env.MODAL_TOKEN).toBe("value-of-gpu.modal-0123456789");
		bus.emit(root.runId, "log", { text: `leaked ${env.MODAL_TOKEN}` });
		const logged = store.events(root.runId, { types: ["log"] })[0];
		expect(JSON.stringify(logged.data)).not.toContain("value-of-gpu.modal");
		expect(store.events(root.runId, { types: ["secrets.used"] }).length).toBe(1);
	});
});
