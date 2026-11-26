import { describe, expect, it } from "vitest";
import { SqliteStore } from "../src/index.ts";

describe("SqliteStore v2", () => {
	it("deduplicates events by idempotencyKey and preserves causalParents", () => {
		const store = new SqliteStore(":memory:");
		try {
			const s1 = store.appendEvent({
				ts: 1000,
				runId: "r1",
				type: "task.created",
				nodeId: "planner",
				causalParents: ["evt-0"],
				idempotencyKey: "k-task-1",
				data: { taskId: "t1" },
			});
			const s2 = store.appendEvent({
				ts: 1001,
				runId: "r1",
				type: "task.created",
				nodeId: "planner",
				idempotencyKey: "k-task-1",
				data: { taskId: "t1" },
			});
			expect(s1).toBe(s2);
			const events = store.events("r1");
			expect(events).toHaveLength(1);
			expect(events[0]!.causalParents).toEqual(["evt-0"]);
		} finally {
			store.close();
		}
	});

	it("enforces atomic task leases with monotonic fencing tokens and expiry reclamation", () => {
		const store = new SqliteStore(":memory:");
		try {
			store.put("tasks", {
				id: "t1",
				runId: "r1",
				title: "Build parser",
				description: "Implement parser",
				status: "open",
				dependsOn: [],
				fencingToken: 0,
				createdBy: "planner",
				createdAt: 1000,
				updatedAt: 1000,
			});

			const c1 = store.claimTaskLease("r1", "t1", "agt-1", 5_000, 10_000);
			expect(c1.claimed).toBe(true);
			expect(c1.task?.fencingToken).toBe(1);

			// Concurrent claim before expiry fails
			const c2 = store.claimTaskLease("r1", "t1", "agt-2", 5_000, 12_000);
			expect(c2.claimed).toBe(false);

			// Reclaim after lease expiry increments fencingToken
			const c3 = store.claimTaskLease("r1", "t1", "agt-2", 5_000, 16_000);
			expect(c3.claimed).toBe(true);
			expect(c3.task?.fencingToken).toBe(2);
			expect(c3.task?.leaseOwner).toBe("agt-2");

			// Stale fencing token from agt-1 cannot release or complete task
			expect(store.releaseTaskLease("t1", "agt-1", 1, "done", { result: "stale" }, 17_000)).toBe(false);

			// Valid fencing token from agt-2 succeeds
			expect(store.releaseTaskLease("t1", "agt-2", 2, "done", { result: "clean" }, 17_000)).toBe(true);
			expect(store.get("tasks", "t1")?.status).toBe("done");
		} finally {
			store.close();
		}
	});
});
