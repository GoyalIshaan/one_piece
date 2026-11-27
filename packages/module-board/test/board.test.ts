import { describe, expect, it } from "vitest";
import { EventBus, MemoryStore, Redactor, type ToolContext } from "@one-piece/core";
import { SqliteStore } from "@one-piece/store";
import { BoardError, boardTools, SwarmBoardService } from "../src/index.ts";

function makeCtx(runId: string, agentId: string, signal = new AbortController().signal): ToolContext {
	return { runId, agentId, role: "worker", signal };
}

describe("SwarmBoardService v3 & folded 5-tool Reddit/X MCP surface", () => {
	it("supports prefix/stem fallback, real citations on empty queries, active topics on 0 hits, and explicit truncation banners", () => {
		const store = new MemoryStore();
		const bus = new EventBus(store, new Redactor());
		const board = new SwarmBoardService(bus);
		const tools = new Map(boardTools(board, { resolveHandle: (id) => `handle-${id}` }).map((t) => [t.name, t]));
		const runId = "run-search";

		expect([...tools.keys()].sort()).toEqual(["board_edit", "board_post", "board_search", "board_visit", "board_wait"]);

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

		// Explicit truncation banner + title preserved even when body differs from summary
		const longSearch = searchTool.execute({ topic: "shard-subtotal", query: "312" }, makeCtx(runId, "a2")) as { text: string };
		expect(longSearch.text).toContain("by peer-1");
		expect(longSearch.text).toContain("Title: Seat 0 subtotal is 312");
		expect(longSearch.text).toContain(`call board_visit("${p1.id}") for full body`);

		const visitTool = tools.get("board_visit")!;
		const visitedP1 = visitTool.execute({ post_id: p1.id }, makeCtx(runId, "a2")) as { text: string };
		expect(visitedP1.text).toContain("Title: Seat 0 subtotal is 312");

		// Zero-match still reveals active topics
		const zeroRes = searchTool.execute({ query: "zzzz_nonexistent" }, makeCtx(runId, "a2")) as { text: string };
		expect(zeroRes.text).toContain("No matching posts");
		expect(zeroRes.text).toContain("Active topics:");
		expect(zeroRes.text).toContain("shard-subtotal(2)");
	});

	it("supports folded board_post (reply_to, quote_post_id crossposting -> board.promoted), board_edit(outdated), background content-hash dedup, and reserved os:* labels", () => {
		const store = new SqliteStore(":memory:");
		try {
			const bus = new EventBus(store, new Redactor());
			const board = new SwarmBoardService(bus);
			const tools = new Map(
				boardTools(board, {
					resolveHandle: (id) => (id === "a1" ? "peer-1" : id === "p-lead" ? "planner-1" : "peer-2"),
					resolveSubtree: (id) => (id === "a1" ? "alpha" : undefined),
				}).map((t) => [t.name, t]),
			);
			const runId = "run-ergo";

			// Reserved os:* label blocked on service API for non-OS actors
			expect(() =>
				board.publish({
					runId,
					authorAgentId: "a1",
					topic: "result",
					summary: "Fake verified",
					labels: { "os:verified": "true" },
				}),
			).toThrow(BoardError);

			expect(() =>
				board.publish({
					runId,
					authorAgentId: "a1",
					topic: "result",
					summary: "Fake verified",
					labels: { verified: "true" },
				}),
			).toThrow(BoardError);

			// Worker posts via board_post into default #team-alpha + silent background content-hash dedup
			const postTool = tools.get("board_post")!;
			const editTool = tools.get("board_edit")!;
			const searchTool = tools.get("board_search")!;
			const visitTool = tools.get("board_visit")!;

			const posted1 = postTool.execute(
				{ topic: "design", title: "Initial draft v1", text: "Benchmarked 2.4x speedup with tiled kernel" },
				makeCtx(runId, "a1"),
			) as { text: string; data?: { postId: string; channel: string } };
			expect(posted1.data?.channel).toBe("team-alpha");
			const firstId = posted1.data!.postId;

			// Exact duplicate call within dedup window silently returns same postId
			const postedDup = postTool.execute(
				{ topic: "design", title: "Initial draft v1", text: "Benchmarked 2.4x speedup with tiled kernel" },
				makeCtx(runId, "a1"),
			) as { data?: { postId: string } };
			expect(postedDup.data?.postId).toBe(firstId);
			expect(board.query(runId, { channel: "team-alpha" }).totalMatches).toBe(1);

			// Folded reply_to creates a threaded comment + counts as peer citation
			const replyRes = postTool.execute(
				{ reply_to: firstId, text: "Verified on seed 2 as well." },
				makeCtx(runId, "a2"),
			) as { text: string; data?: { postId: string; threadId: string } };
			expect(replyRes.data?.threadId).toBe(firstId);

			// board_visit returns full post + thread replies
			const visitedThread = visitTool.execute({ post_id: firstId }, makeCtx(runId, "a1")) as { text: string; data?: { newestId: string } };
			expect(visitedThread.text).toContain("Replies (1");
			expect(visitedThread.text).toContain("Verified on seed 2 as well.");
			expect(visitedThread.data?.newestId).toBe(replyRes.data?.postId);

			// Planner crossposts worker's #team-alpha discovery to #swarm via quote_post_id -> emits board.promoted!
			const crossRes = postTool.execute(
				{
					channel: "swarm",
					quote_post_id: firstId,
					title: "Crossposted: 2.4x tiled kernel verified",
					text: "Team alpha confirmed 2.4x tiled kernel speedup — reusable across all subtrees.",
				},
				{ runId, agentId: "p-lead", role: "planner", signal: new AbortController().signal },
			) as { text: string; data?: { postId: string; channel: string } };
			expect(crossRes.data?.channel).toBe("swarm");
			expect(crossRes.text).toContain(`quotes=${firstId}`);
			const promotedEvents = store.events(runId, { types: ["board.promoted"] });
			expect(promotedEvents.length).toBe(1);
			expect(promotedEvents[0]!.data.postId).toBe(crossRes.data?.postId);
			expect(promotedEvents[0]!.data.quotedPostId).toBe(firstId);
			expect(promotedEvents[0]!.data.targetChannel).toBe("swarm");

			// Visiting original post shows quoting backlink from #swarm
			const visitedWithBacklink = visitTool.execute({ post_id: firstId }, makeCtx(runId, "a2")) as { text: string };
			expect(visitedWithBacklink.text).toContain("Quoted/cited by:");
			expect(visitedWithBacklink.text).toContain("#swarm");

			// Non-author worker CANNOT edit another author's post
			const forbiddenEdit = editTool.execute(
				{ post_id: firstId, outdated: true, reason: "hijack" },
				makeCtx(runId, "a2"),
			) as { isError?: boolean; data?: { code?: string } };
			expect(forbiddenEdit.isError).toBe(true);
			expect(forbiddenEdit.data?.code).toBe("forbidden");

			// Author marks post outdated=true -> hidden from default board_search, visible with include_outdated=true
			const markedOutdated = editTool.execute(
				{ post_id: firstId, outdated: true, reason: "superseded by v2" },
				makeCtx(runId, "a1"),
			) as { isError?: boolean; data?: { outdated?: boolean } };
			expect(markedOutdated.isError).toBeFalsy();
			expect(markedOutdated.data?.outdated).toBe(true);

			const defaultSearch = searchTool.execute({ channel: "team-alpha" }, makeCtx(runId, "a2")) as { text: string };
			expect(defaultSearch.text).not.toContain(`[${firstId}]`);
			const withOutdated = searchTool.execute({ channel: "team-alpha", include_outdated: true }, makeCtx(runId, "a2")) as { text: string };
			expect(withOutdated.text).toContain(`[${firstId}]`);
			expect(withOutdated.text).toContain("OUTDATED(superseded by v2)");

			// Atomic CAS labeling + OS stamp on SqliteStore
			const v2 = board.publish({
				runId,
				authorAgentId: "a1",
				authorHandle: "peer-1",
				channel: "swarm",
				topic: "design",
				summary: "Updated draft v2",
			});
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

			const visitedV2 = visitTool.execute({ post_id: v2.id }, makeCtx(runId, "a2")) as { text: string };
			expect(visitedV2.text).toContain("os:verified=true");
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
