import { testHarness } from "@one-piece/core/testing";
import { describe, expect, it } from "vitest";
import { Scheduler } from "../src/index.ts";

describe("resource scheduler", () => {
	it("runs jobs, charges budgets, caches identical jobs and refuses failed gates", async () => {
		const { harness, root, tree } = testHarness({ budget: { tokens: 1000, cpu_seconds: 100 } });
		const leaf = tree.create({ runId: root.runId, epoch: 1, role: "leaf", parentId: root.id, goal: { title: "l", text: "l" }, budget: { tokens: 500, cpu_seconds: 50 } });
		const s = new Scheduler(harness, [{ name: "cpu", unit: "cpu_seconds", capacity: 1, kind: "local" }]);
		const job = s.submit(leaf.id, { pool: "cpu", command: "echo ok" });
		const done = await s.wait(job.id);
		expect(done.status).toBe("succeeded");
		expect(done.stdout).toContain("ok");
		expect(tree.require(leaf.id).spent.cpu_seconds).toBeGreaterThan(0);
		const again = s.submit(leaf.id, { pool: "cpu", command: "echo ok" });
		expect(again.status).toBe("cached");
		const gated = s.submit(leaf.id, { pool: "cpu", command: "echo never", gate: "exit 1" });
		const gatedDone = await s.wait(gated.id);
		expect(gatedDone.status).toBe("failed");
		expect(gatedDone.stderr).toContain("Gate failed");
	});

	it("refuses jobs over budget or over the pool cap", () => {
		const { harness, root, tree } = testHarness({ budget: { gpu_minutes: 10 } });
		const leaf = tree.create({ runId: root.runId, epoch: 1, role: "leaf", parentId: root.id, goal: { title: "l", text: "l" }, budget: { gpu_minutes: 2 } });
		const s = new Scheduler(harness, [{ name: "gpu", unit: "gpu_minutes", capacity: 1, kind: "command", capUnits: 5 }]);
		expect(() => s.submit(leaf.id, { pool: "gpu", command: "true", units: 3 })).toThrow(/budget/);
		expect(() => s.submit(root.id, { pool: "gpu", command: "true", units: 6 })).toThrow(/cap/);
	});

	it("serves promising, under-served branches first", async () => {
		const { harness, root, tree } = testHarness({ budget: { tokens: 1000 } });
		const a = tree.create({ runId: root.runId, epoch: 1, role: "leaf", parentId: root.id, goal: { title: "a", text: "a" }, budget: { tokens: 500 } });
		const b = tree.create({ runId: root.runId, epoch: 1, role: "leaf", parentId: root.id, goal: { title: "b", text: "b" }, budget: { tokens: 500 } });
		tree.update(b.id, { promise: 0.95 });
		tree.update(a.id, { promise: 0.1 });
		const s = new Scheduler(harness, [{ name: "cpu", unit: "cpu_seconds", capacity: 1, kind: "local" }]);
		const blocker = s.submit(a.id, { pool: "cpu", command: "sleep 0.3" });
		const fromA = s.submit(a.id, { pool: "cpu", command: "echo a", idempotencyKey: "1" });
		const fromB = s.submit(b.id, { pool: "cpu", command: "echo b", idempotencyKey: "2" });
		await s.wait(blocker.id);
		const [ja, jb] = await Promise.all([s.wait(fromA.id), s.wait(fromB.id)]);
		expect(jb.startedAt!).toBeLessThanOrEqual(ja.startedAt!);
	});

	it("cancels a cut branch's queued jobs", async () => {
		const { harness, root, tree } = testHarness();
		const leaf = tree.create({ runId: root.runId, epoch: 1, role: "leaf", parentId: root.id, goal: { title: "l", text: "l" }, budget: {} });
		const s = new Scheduler(harness, [{ name: "cpu", unit: "cpu_seconds", capacity: 1, kind: "local" }]);
		const running = s.submit(root.id, { pool: "cpu", command: "sleep 0.2" });
		const queued = s.submit(leaf.id, { pool: "cpu", command: "echo x" });
		s.cancelSubtree(leaf.id);
		expect((await s.wait(queued.id)).status).toBe("cancelled");
		await s.wait(running.id);
	});
});
