import type { Finding } from "@one-piece/core";
import { testHarness } from "@one-piece/core/testing";
import { describe, expect, it } from "vitest";
import { boardModule } from "../src/index.ts";

describe("family boards", () => {
	it("keeps families separate and requires a peer review before reporting", async () => {
		const { harness, root, tree, bus } = testHarness();
		const module = boardModule();
		await module.setup!(harness);
		const a = tree.create({ runId: root.runId, epoch: 1, role: "internal", parentId: root.id, goal: { title: "a", text: "a" }, budget: {} });
		const a1 = tree.create({ runId: root.runId, epoch: 1, role: "leaf", parentId: a.id, goal: { title: "a1", text: "a1" }, budget: {} });
		const a2 = tree.create({ runId: root.runId, epoch: 1, role: "leaf", parentId: a.id, goal: { title: "a2", text: "a2" }, budget: {} });
		const b1 = tree.create({ runId: root.runId, epoch: 1, role: "leaf", parentId: root.id, goal: { title: "b1", text: "b1" }, budget: {} });
		bus.emit(root.runId, "node.checkpoint", { checkpoint: "a2 found X" }, a2.id);
		const read = (node: any, name: string) => module.tools!({ node, harness }).find((t) => t.name === name)!.execute("id", {}).then((r: any) => r.content[0].text as string);
		expect(await read(a1, "read_board")).toContain("a2 found X");
		expect(await read(b1, "read_board")).not.toContain("a2 found X"); // other family
		expect(await read(a, "read_children_board")).toContain("a2 found X"); // parent may read
		expect(module.tools!({ node: a, harness }).some((t) => t.name === "post_board")).toBe(true); // a posts on its own family
		const finding = { id: "f" } as Finding;
		expect(module.beforeReport!({ node: a1, harness }, finding)).toMatch(/peer_review/);
		const post = module.tools!({ node: a1, harness }).find((t) => t.name === "post_board")!;
		await post.execute("id", { kind: "peer_review", title: "pr", body: "a2: found X -> avoid overlap" });
		expect(module.beforeReport!({ node: a1, harness }, finding)).toBeUndefined();
	});
});
