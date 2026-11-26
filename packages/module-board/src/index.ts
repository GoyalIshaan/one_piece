import {
	type BoardPost,
	type BoardService,
	type EventBus,
	newId,
	type ToolDefinition,
} from "@one-piece/core";
import { rankedBoardPosts, searchExcerpt } from "./search.ts";

export { rankedBoardPosts, searchExcerpt } from "./search.ts";

/**
 * Bounded linked-message substrate (ScaleMAS pattern).
 * Exposes O(1) top-k search ranked by BM25 x distinct-peer citations, publish, and visit.
 */
export class SwarmBoardService implements BoardService {
	private readonly bus: EventBus;

	constructor(bus: EventBus) {
		this.bus = bus;
	}

	publish(input: {
		runId: string;
		authorAgentId: string;
		topic: string;
		summary: string;
		body?: string;
		board?: string;
		references?: Array<{ postId: string; reason: string }>;
		artifactIds?: string[];
		parentPostId?: string;
	}): BoardPost {
		const post: BoardPost = {
			id: newId("post"),
			runId: input.runId,
			board: input.board ?? "swarm",
			topic: input.topic.trim() || "general",
			authorAgentId: input.authorAgentId,
			summary: input.summary.trim().slice(0, 400),
			body: (input.body ?? input.summary).trim(),
			references: input.references?.length ? input.references : undefined,
			artifactIds: input.artifactIds?.length ? input.artifactIds : undefined,
			parentPostId: input.parentPostId,
			createdAt: Date.now(),
		};
		this.bus.save("posts", post, input.authorAgentId);
		this.bus.emit(
			input.runId,
			"board.posted",
			{ postId: post.id, topic: post.topic, authorAgentId: post.authorAgentId },
			input.authorAgentId,
			{ causalParents: post.references?.map((r) => r.postId) },
		);
		return post;
	}

	search(runId: string, query: string, opts: { k?: number; board?: string } = {}) {
		const k = Math.max(1, Math.min(10, Math.floor(opts.k ?? 5)));
		const posts = this.bus.store.listBoardPosts
			? this.bus.store.listBoardPosts(runId, opts.board)
			: this.bus.store.list("posts", { runId }).filter((p) => !opts.board || (p.board ?? "swarm") === opts.board);
		return rankedBoardPosts(posts, query, k);
	}

	visit(postId: string): { post: BoardPost; citedBy: BoardPost[] } | undefined {
		const post = this.bus.store.get("posts", postId);
		if (!post) return undefined;
		const citedBy = this.bus.store.listBoardPosts
			? this.bus.store.listBoardPosts(post.runId, undefined, post.id)
			: this.bus.store.list("posts", { runId: post.runId }).filter((p) => p.references?.some((r) => r.postId === post.id));
		return { post, citedBy };
	}

	recent(runId: string, limit = 10): BoardPost[] {
		return this.bus.store
			.list("posts", { runId })
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, limit);
	}
}

/** Ultra-terse (<50 tokens/tool) MCP/in-process board tool definitions. */
export function boardTools(board: BoardService): ToolDefinition[] {
	return [
		{
			name: "board_search",
			description: "Search shared swarm board (returns top-k bounded excerpts ranked by relevance and peer citations).",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "Keywords to search (empty returns latest posts)" },
					k: { type: "number", minimum: 1, maximum: 10, description: "Max results (default 5)" },
				},
				required: ["query"],
			},
			execute(args, ctx) {
				const query = String(args.query ?? "");
				const k = typeof args.k === "number" ? args.k : 5;
				const hits = board.search(ctx.runId, query, { k });
				if (!hits.length) return { text: "(no matching posts)" };
				const lines = hits.map(
					({ post, citations }) =>
						`[${post.id}] (${post.topic}, by ${post.authorAgentId}, citations=${citations})\n${searchExcerpt(post.body, query)}`,
				);
				return { text: lines.join("\n\n") };
			},
		},
		{
			name: "board_publish",
			description: "Publish a concise discovery, design note, or interface update to the shared swarm board.",
			inputSchema: {
				type: "object",
				properties: {
					topic: { type: "string", description: "Short topic tag" },
					summary: { type: "string", description: "1-2 sentence summary" },
					body: { type: "string", description: "Optional full note body" },
					parent_ids: { type: "array", items: { type: "string" }, description: "Optional cited post IDs" },
					artifact_ids: { type: "array", items: { type: "string" }, description: "Optional artifact IDs" },
				},
				required: ["topic", "summary"],
			},
			execute(args, ctx) {
				const refs = Array.isArray(args.parent_ids)
					? args.parent_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((postId) => ({ postId, reason: "builds_on" }))
					: undefined;
				const artifactIds = Array.isArray(args.artifact_ids)
					? args.artifact_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
					: undefined;
				const post = board.publish({
					runId: ctx.runId,
					authorAgentId: ctx.agentId,
					topic: String(args.topic ?? "general"),
					summary: String(args.summary ?? ""),
					body: typeof args.body === "string" ? args.body : undefined,
					references: refs,
					artifactIds,
				});
				return { text: `Published ${post.id} (${post.topic})`, data: { postId: post.id } };
			},
		},
		{
			name: "board_visit",
			description: "Read the full body and citing backlinks of one board post by ID.",
			inputSchema: {
				type: "object",
				properties: {
					post_id: { type: "string", description: "Post ID from board_search" },
				},
				required: ["post_id"],
			},
			execute(args) {
				const res = board.visit(String(args.post_id ?? ""));
				if (!res) return { text: `Post not found: ${String(args.post_id ?? "")}`, isError: true };
				const backlinks = res.citedBy.length ? `\nCited by: ${res.citedBy.map((p) => p.id).join(", ")}` : "";
				const artifacts = res.post.artifactIds?.length ? `\nArtifacts: ${res.post.artifactIds.join(", ")}` : "";
				return { text: `[${res.post.id}] ${res.post.topic} (by ${res.post.authorAgentId})\n${res.post.body}${artifacts}${backlinks}` };
			},
		},
	];
}
