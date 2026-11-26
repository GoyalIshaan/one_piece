import { describe, expect, it } from "vitest";
import { EventBus, MemoryStore, Redactor, type ToolContext } from "@one-piece/core";
import { SqliteStore } from "@one-piece/store";
import { BoardError, boardTools, SwarmBoardService } from "../src/index.ts";

function makeCtx(runId: string, agentId: string, signal = new AbortController().signal): ToolContext {
	return { runId, agentId, role: "worker", signal };
}

describe("SwarmBoardService v2 & 4-tool MCP surface", () => {
	it("supports prefix/stem fallback, real citations on empty queries, active topics on 0 hits, and explicit truncation banners", () => {
		const store = new MemoryStore();
		const bus = new EventBus(store, new Redactor());
		const board = new SwarmBoardService(bus);
		const tools = new Map(boardTools(board, { resolveHandle: (id) => `handle-${id}` }).map((t) => [t.name, t]));
		const runId = "run-search";

		const p1 = board.publish({
			runId,
			authorAgentId: "a1",
			authorHandle: "peer-1",
			topic: "shard-subtotal",
			summary: "Seat 0 subtotal is 312",
			body: `Seat 0 subtotal = 312. ${"detailed-payload ".repeat(45)}`,
			labels: { seat: "0", state: "ready" },
		});
		const p2 = board.publish({
			runId,
			authorAgentId: "a2",
			authorHandle: "peer-2",
			topic: "shard-subtotal",
			summary: "Seat 1 subtotal is 405",
			body: "Seat 1 subtotal = 405 (cites seat 0)",
			references: [{ postId: p1.id, reason: "builds_on" }],
			labels: { seat: "1", state: "ready" },
		});
		// Self-citation must not inflate peer citation count
		board.publish({
			runId,
			authorAgentId: "a1",
			authorHandle: "peer-1",
			topic: "notes",
			summary: "Self note",
			references: [{ postId: p1.id, reason: "self" }],
		});

		// Empty query still computes real citations & totalMatches
		const emptyRes = board.query(runId, { query: "", k: 1 });
		expect(emptyRes.totalMatches).toBe(3);
		expect(emptyRes.hits).toHaveLength(1);
		expect(emptyRes.cursor).toBe(3);
		const allEmpty = board.query(runId, { query: "", k: 10 });
		const hit1 = allEmpty.hits.find((h) => h.post.id === p1.id);
		expect(hit1?.citations).toBe(1); // cited by a2 only, not self-citation from a1

		// Prefix/stem fallback: "subtot" matches "subtotal"
		const stemRes = board.query(runId, { query: "subtot", k: 5 });
		expect(stemRes.hits.map((h) => h.post.id)).toContain(p1.id);
		expect(stemRes.hits.map((h) => h.post.id)).toContain(p2.id);

		// Topic + label + after cursor filtering
		const filtered = board.query(runId, { topic: "shard-subtotal", labels: ["seat=1"], afterSeq: p1.seq });
		expect(filtered.hits.map((h) => h.post.id)).toEqual([p2.id]);

		// Tool output: truncation banner + pagination footer
		const searchTool = tools.get("board_search")!;
		const page1 = searchTool.execute({ query: "subtot", k: 1, offset: 0 }, makeCtx(runId, "a2")) as { text: string };
		expect(page1.text).toContain("Showing 1-1 of 2 matches");
		expect(page1.text).toContain("Next page: offset=1");
		expect(page1.text).toContain("Topics: ");
		expect(page1.text).toContain("shard-subtotal(2)");

		// Explicit truncation banner + summary preserved even when body differs from summary
		const longSearch = searchTool.execute({ topic: "shard-subtotal", labels: ["seat=0"] }, makeCtx(runId, "a2")) as { text: string };
		expect(longSearch.text).toContain("by peer-1");
		expect(longSearch.text).toContain("Summary: Seat 0 subtotal is 312");
		expect(longSearch.text).toContain(`call board_visit("${p1.id}") for full body`);

		const visitTool = tools.get("board_visit")!;
		const visitedP1 = visitTool.execute({ post_id: p1.id }, makeCtx(runId, "a2")) as { text: string };
		expect(visitedP1.text).toContain("Summary: Seat 0 subtotal is 312");

		// Zero-match still reveals active topics
		const zeroRes = searchTool.execute({ query: "zzzz_nonexistent" }, makeCtx(runId, "a2")) as { text: string };
		expect(zeroRes.text).toContain("No matching posts");
		expect(zeroRes.text).toContain("Active topics:");
		expect(zeroRes.text).toContain("shard-subtotal(2)");
	});

	it("enforces threading, if_latest_id optimistic concurrency, idempotency_key, supersedes folding, and reserved os:* labels", () => {
		const store = new SqliteStore(":memory:");
		try {
			const bus = new EventBus(store, new Redactor());
			const board = new SwarmBoardService(bus);
			const tools = new Map(boardTools(board, { resolveHandle: (id) => (id === "a1" ? "peer-1" : "peer-2") }).map((t) => [t.name, t]));
			const runId = "run-ergo";

			// Reserved os:* label blocked for workers
			const pubTool = tools.get("board_publish")!;
			const spoofed = pubTool.execute(
				{ topic: "result", summary: "Fake verified", labels: { "os:verified": "true" } },
				makeCtx(runId, "a1"),
			) as { isError?: boolean; text: string; data?: Record<string, unknown> };
			expect(spoofed.isError).toBe(true);
			expect(spoofed.data?.code).toBe("reserved_label");

			const spoofed2 = pubTool.execute(
				{ topic: "result", summary: "Fake verified", labels: { verified: "true" } },
				makeCtx(runId, "a1"),
			) as { isError?: boolean };
			expect(spoofed2.isError).toBe(true);

			// Idempotent publish returns the same post on retry
			const first = board.publish({
				runId,
				authorAgentId: "a1",
				authorHandle: "peer-1",
				topic: "design",
				summary: "Initial draft v1",
				idempotencyKey: "draft-1",
			});
			const retry = board.publish({
				runId,
				authorAgentId: "a1",
				authorHandle: "peer-1",
				topic: "design",
				summary: "Initial draft v1",
				idempotencyKey: "draft-1",
			});
			expect(retry.id).toBe(first.id);
			expect(board.query(runId).totalMatches).toBe(1);

			// Thread replies + if_latest_id optimistic concurrency
			const reply1 = board.publish({
				runId,
				authorAgentId: "a2",
				authorHandle: "peer-2",
				topic: "design",
				summary: "Reply 1",
				threadId: first.id,
				ifLatestId: first.id,
			});
			expect(reply1.threadId).toBe(first.id);

			// Stale if_latest_id rejected with newer_message
			let caught: unknown;
			try {
				board.publish({
					runId,
					authorAgentId: "a1",
					topic: "design",
					summary: "Stale reply",
					threadId: first.id,
					ifLatestId: first.id,
				});
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(BoardError);
			expect((caught as BoardError).code).toBe("newer_message");

			// Thread view via board_search(thread_id)
			const searchTool = tools.get("board_search")!;
			const threadOut = searchTool.execute({ thread_id: first.id }, makeCtx(runId, "a1")) as { text: string; data?: Record<string, unknown> };
			expect(threadOut.text).toContain(`Thread ${first.id}`);
			expect(threadOut.text).toContain("Reply 1");
			expect(threadOut.data?.newestId).toBe(reply1.id);

			// Supersedes folds older post out of default search, while OS actor can stamp os:verified
			const v2 = board.publish({
				runId,
				authorAgentId: "a1",
				authorHandle: "peer-1",
				topic: "design",
				summary: "Updated draft v2",
				supersedes: first.id,
			});
			const defaultIds = board.query(runId, { topic: "design" }).hits.map((h) => h.post.id);
			expect(defaultIds).not.toContain(first.id);
			expect(defaultIds).toContain(v2.id);

			const withSuperseded = board.query(runId, { topic: "design", includeSuperseded: true }).hits.map((h) => h.post.id);
			expect(withSuperseded).toContain(first.id);

			// Atomic CAS labeling on SqliteStore
			const osStamp = board.label(v2.id, {
				set: { "os:verified": "true", state: "open" },
				ifMatch: { state: null },
				actorId: "trust-layer",
				isOsActor: true,
			});
			expect(osStamp.ok).toBe(true);

			const conflict = board.label(v2.id, {
				set: { state: "claimed" },
				ifMatch: { state: null },
				actorId: "a2",
				isOsActor: false,
			});
			expect(conflict.ok).toBe(false);
			if (!conflict.ok) expect(conflict.reason).toBe("conflict");

			const visitTool = tools.get("board_visit")!;
			const visited = visitTool.execute({ post_id: v2.id }, makeCtx(runId, "a2")) as { text: string };
			expect(visited.text).toContain("os:verified=true");
		} finally {
			store.close();
		}
	});

	it("wakes board_wait reactively on min_posts barrier without polling and honors AbortSignal", async () => {
		const store = new MemoryStore();
		const bus = new EventBus(store, new Redactor());
		const board = new SwarmBoardService(bus);
		const tools = new Map(boardTools(board).map((t) => [t.name, t]));
		const waitTool = tools.get("board_wait")!;
		const runId = "run-wait";

		const startedAt = Date.now();
		const waitPromise = waitTool.execute(
			{ topic: "shard-subtotal", min_posts: 3, timeout_seconds: 10 },
			makeCtx(runId, "peer-0"),
		) as Promise<{ text: string; data?: Record<string, unknown> }>;

		setTimeout(() => {
			board.publish({ runId, authorAgentId: "p0", authorHandle: "peer-1", topic: "shard-subtotal", summary: "s0=10" });
			board.publish({ runId, authorAgentId: "p1", authorHandle: "peer-2", topic: "shard-subtotal", summary: "s1=20" });
			board.publish({ runId, authorAgentId: "p2", authorHandle: "peer-3", topic: "shard-subtotal", summary: "s2=30" });
		}, 25);

		const res = await waitPromise;
		const elapsed = Date.now() - startedAt;
		expect(elapsed).toBeLessThan(2000);
		expect(res.data?.timedOut).toBe(false);
		expect(res.data?.count).toBe(3);
		expect(res.text).toContain("Matched 3 posts");
		expect(res.text).toContain("s2=30");

		// Timeout / abort resolves cleanly
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 30);
		const abortedRes = (await waitTool.execute(
			{ after: Number(res.data?.cursor ?? 0), topic: "shard-subtotal", min_posts: 1, timeout_seconds: 10 },
			makeCtx(runId, "peer-0", ac.signal),
		)) as { data?: Record<string, unknown> };
		expect(abortedRes.data?.timedOut).toBe(true);
		expect(abortedRes.data?.count).toBe(0);
	});
});
