import { type Assumption, type Question } from "@one-piece/core";
import { testHarness } from "@one-piece/core/testing";
import { describe, expect, it } from "vitest";
import { questionsModule } from "../src/index.ts";

function tool(module: ReturnType<typeof questionsModule>, harness: any, node: any, name: string) {
	const t = module.tools!({ node, harness }).find((x) => x.name === name);
	if (!t) throw new Error(`no tool ${name}`);
	return (params: any) => t.execute("id", params).then((r: any) => r.content[0].text as string);
}

describe("questions", () => {
	it("non-blocking questions take the default and log an assumption", async () => {
		const { harness, root, tree, store } = testHarness();
		const module = questionsModule({ pollMs: 20 });
		await module.setup!(harness);
		const leaf = tree.create({ runId: root.runId, epoch: 1, role: "leaf", parentId: root.id, goal: { title: "l", text: "l" }, budget: {} });
		const out = await tool(module, harness, leaf, "ask")({ kind: "clarification", question: "Which size?", context: "c", default: "small" });
		expect(out).toContain("Proceeding with your default");
		expect(store.list<Assumption>("assumptions", { runId: root.runId }).length).toBe(1);
		expect((harness as any).delivered[0].nodeId).toBe(root.id);
		module.dispose!();
	});

	it("escalates up the chain to the user and waits for the user's answer", async () => {
		const { harness, root, tree, store } = testHarness();
		const module = questionsModule({ pollMs: 20 });
		await module.setup!(harness);
		const mid = tree.create({ runId: root.runId, epoch: 1, role: "internal", parentId: root.id, goal: { title: "m", text: "m" }, budget: {} });
		const leaf = tree.create({ runId: root.runId, epoch: 1, role: "leaf", parentId: mid.id, goal: { title: "l", text: "l" }, budget: {} });
		const pending = tool(module, harness, leaf, "ask")({ kind: "decision", question: "Spend more GPU?", context: "c", default: "no", blocking: true });
		await new Promise((r) => setTimeout(r, 10));
		const qid = store.list<Question>("questions", { runId: root.runId })[0].id;
		await tool(module, harness, mid, "escalate_question")({ question_id: qid });
		await tool(module, harness, root, "escalate_question")({ question_id: qid });
		expect(store.get<Question>("questions", qid)!.holder).toBe("user");
		(harness as any).endTurn(mid.id); // the deadline no longer applies once the user holds it
		store.put("user_answers", { id: qid, runId: root.runId, answer: "yes, up to $5" });
		expect(await pending).toContain("yes, up to $5");
		expect(store.get<Question>("questions", qid)!.answeredBy).toBe("user");
		module.dispose!();
	});

	it("a blocking question falls back to its default after the parent's next turn", async () => {
		const { harness, root, tree, store } = testHarness();
		const module = questionsModule({ pollMs: 20 });
		await module.setup!(harness);
		const leaf = tree.create({ runId: root.runId, epoch: 1, role: "leaf", parentId: root.id, goal: { title: "l", text: "l" }, budget: {} });
		const pending = tool(module, harness, leaf, "ask")({ kind: "blocker", question: "Q?", context: "c", default: "plan B", blocking: true });
		await new Promise((r) => setTimeout(r, 10));
		(harness as any).endTurn(root.id);
		expect(await pending).toContain("plan B");
		expect(store.list<Question>("questions", { runId: root.runId })[0].status).toBe("defaulted");
		module.dispose!();
	});
});
