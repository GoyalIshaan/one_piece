import {
	applyBoardPostLabels,
	type BoardLabelInput,
	type BoardPost,
	type BoardPostKind,
	type BoardPostLabelResult,
	type BoardPublishInput,
	type BoardQueryOptions,
	type BoardQueryResult,
	type BoardSearchHit,
	type BoardService,
	type BoardThreadView,
	type BoardTopicSummary,
	type BoardVisibility,
	type BoardWaitOptions,
	type BoardWaitResult,
	type EventBus,
	newId,
	type ToolDefinition,
	transitionSupersedePost,
} from "@one-piece/core";
import {
	computeCitationCounts,
	rankedBoardPostsDetailed,
	searchExcerpt,
	searchExcerptDetailed,
} from "./search.ts";

export {
	computeCitationCounts,
	rankedBoardPosts,
	rankedBoardPostsDetailed,
	searchExcerpt,
	searchExcerptDetailed,
} from "./search.ts";

const DEFAULT_BOARD = "swarm";
const MAX_WAIT_MS = 25_000;
const DEFAULT_WAIT_MS = 20_000;

export type BoardErrorCode = "reserved_label" | "newer_message" | "label_conflict" | "not_found" | "invalid_input";

export class BoardError extends Error {
	readonly code: BoardErrorCode;
	readonly data?: Record<string, unknown>;

	constructor(code: BoardErrorCode, message: string, data?: Record<string, unknown>) {
		super(message);
		this.name = "BoardError";
		this.code = code;
		this.data = data;
	}
}

export function isReservedBoardLabel(key: string): boolean {
	const lower = key.trim().toLowerCase();
	return lower.startsWith("os:") || lower === "verified";
}

function sanitizeLabels(
	labels: Record<string, string> | undefined,
	isOsActor: boolean,
): Record<string, string> | undefined {
	if (!labels) return undefined;
	const clean: Record<string, string> = {};
	for (const [rawKey, rawVal] of Object.entries(labels)) {
		const key = rawKey.trim();
		if (!key) continue;
		if (!isOsActor && isReservedBoardLabel(key)) {
			throw new BoardError(
				"reserved_label",
				`Label "${key}" is reserved for OS verification services and cannot be written by workers.`,
				{ label: key },
			);
		}
		clean[key] = String(rawVal).trim().slice(0, 120);
	}
	return Object.keys(clean).length ? clean : undefined;
}

function parseLabelFilters(labels?: readonly string[]): Array<{ key: string; value?: string }> {
	if (!labels?.length) return [];
	const out: Array<{ key: string; value?: string }> = [];
	for (const raw of labels) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq > 0) {
			out.push({ key: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1).trim() });
		} else {
			out.push({ key: trimmed });
		}
	}
	return out;
}

function matchesLabelFilters(post: BoardPost, filters: readonly { key: string; value?: string }[]): boolean {
	if (!filters.length) return true;
	const labels = post.labels ?? {};
	for (const f of filters) {
		if (!Object.prototype.hasOwnProperty.call(labels, f.key)) return false;
		if (f.value !== undefined && labels[f.key] !== f.value) return false;
	}
	return true;
}

function postSeq(post: BoardPost): number {
	return post.seq ?? 0;
}

function formatLabels(labels?: Record<string, string>): string {
	if (!labels) return "";
	const entries = Object.entries(labels);
	if (!entries.length) return "";
	return `, labels={${entries.map(([k, v]) => `${k}=${v}`).join(", ")}}`;
}

function formatTopics(topics: readonly BoardTopicSummary[]): string {
	if (!topics.length) return "(none)";
	return topics.slice(0, 8).map((t) => `${t.topic}(${t.count})`).join(", ");
}

/**
 * Engineered v2 Swarm Message Board (ScaleMAS bounded reads + Vercel Board ergonomics
 * + OS-enforced label integrity).
 */
export class SwarmBoardService implements BoardService {
	private readonly bus: EventBus;
	private readonly seqByRun = new Map<string, number>();

	constructor(bus: EventBus) {
		this.bus = bus;
	}

	private allRunPosts(runId: string, board?: string): BoardPost[] {
		const posts = this.bus.store.listBoardPosts
			? this.bus.store.listBoardPosts(runId, board)
			: this.bus.store.list("posts", { runId }).filter((p) => !board || (p.board ?? DEFAULT_BOARD) === board);
		return posts.sort((a, b) => postSeq(a) - postSeq(b) || a.createdAt - b.createdAt);
	}

	private nextSeq(runId: string): number {
		let cur = this.seqByRun.get(runId);
		if (cur === undefined) {
			cur = 0;
			for (const p of this.bus.store.list("posts", { runId })) {
				if ((p.seq ?? 0) > cur) cur = p.seq!;
			}
		}
		const next = cur + 1;
		this.seqByRun.set(runId, next);
		return next;
	}

	private currentCursor(posts: readonly BoardPost[]): number {
		let max = 0;
		for (const p of posts) {
			if ((p.seq ?? 0) > max) max = p.seq!;
		}
		return max;
	}

	private computeTopics(posts: readonly BoardPost[]): BoardTopicSummary[] {
		const map = new Map<string, BoardTopicSummary>();
		for (const p of posts) {
			if (p.supersededBy) continue;
			const cur = map.get(p.topic);
			const seq = postSeq(p);
			if (cur) {
				cur.count += 1;
				if (seq > cur.latestSeq) cur.latestSeq = seq;
			} else {
				map.set(p.topic, { topic: p.topic, count: 1, latestSeq: seq });
			}
		}
		return [...map.values()].sort((a, b) => b.latestSeq - a.latestSeq || b.count - a.count || a.topic.localeCompare(b.topic));
	}

	publish(input: BoardPublishInput): BoardPost {
		const isOsActor = input.isOsActor === true;
		const cleanLabels = sanitizeLabels(input.labels, isOsActor);
		const boardName = input.board?.trim() || DEFAULT_BOARD;

		// 1. Idempotency deduplication
		const idemKey = input.idempotencyKey?.trim() || undefined;
		if (idemKey) {
			const existing = this.bus.store.findBoardPostByIdempotencyKey
				? this.bus.store.findBoardPostByIdempotencyKey(input.runId, idemKey)
				: this.bus.store.list("posts", { runId: input.runId }).find((p) => p.idempotencyKey === idemKey);
			if (existing) return existing;
		}

		// 2. Thread resolution (normalize reply-to-reply onto the root threadId)
		let resolvedThreadId: string | undefined;
		let topic = input.topic.trim() || "general";
		if (input.threadId?.trim()) {
			const target = this.bus.store.get("posts", input.threadId.trim());
			if (!target || target.runId !== input.runId) {
				throw new BoardError("not_found", `Thread target post not found: ${input.threadId}`);
			}
			resolvedThreadId = target.threadId ?? target.id;
			if (!input.topic.trim()) topic = target.topic;
		}

		// 3. Optimistic concurrency (`ifLatestId`)
		if (input.ifLatestId?.trim()) {
			const expected = input.ifLatestId.trim();
			const scopePosts = this.allRunPosts(input.runId, boardName).filter((p) =>
				resolvedThreadId
					? p.id === resolvedThreadId || p.threadId === resolvedThreadId
					: p.topic.toLowerCase() === topic.toLowerCase(),
			);
			const newest = scopePosts.at(-1);
			if (newest && newest.id !== expected) {
				throw new BoardError(
					"newer_message",
					`Newer message ${newest.id} (seq=${postSeq(newest)}) arrived after ${expected}. Re-read before replying.`,
					{ newestId: newest.id, expectedId: expected, cursor: postSeq(newest) },
				);
			}
		}

		// 4. Resolve supersedes target (if provided)
		let supersedesId: string | undefined;
		let supersededTarget: BoardPost | undefined;
		if (input.supersedes?.trim()) {
			const target = this.bus.store.get("posts", input.supersedes.trim());
			if (!target || target.runId !== input.runId) {
				throw new BoardError("not_found", `Supersedes target post not found: ${input.supersedes}`);
			}
			if (target.supersededBy) {
				throw new BoardError("invalid_input", `Post ${target.id} was already superseded by ${target.supersededBy}`, {
					supersededBy: target.supersededBy,
				});
			}
			supersedesId = target.id;
			supersededTarget = target;
		}

		// 5. Assign monotonic sequence & persist post BEFORE emitting board.posted so reactive listeners see it immediately
		const seq = this.nextSeq(input.runId);
		const authorAgent = this.bus.store.get("agents", input.authorAgentId);
		const authorHandle = input.authorHandle?.trim() || authorAgent?.handle || undefined;
		const resolvedSubtreeId = input.subtreeId?.trim() || authorAgent?.subtreeId || undefined;
		const resolvedVisibility: BoardVisibility =
			input.visibility ?? (authorAgent?.role === "worker" && resolvedSubtreeId ? "subtree" : "global");

		const post: BoardPost = {
			id: newId("post"),
			runId: input.runId,
			board: boardName,
			topic,
			kind: input.kind,
			subtreeId: resolvedSubtreeId,
			visibility: resolvedVisibility,
			authorAgentId: input.authorAgentId,
			authorHandle,
			summary: input.summary.trim().slice(0, 400),
			body: (input.body ?? input.summary).trim(),
			references: input.references?.length ? input.references : undefined,
			artifactIds: input.artifactIds?.length ? input.artifactIds : undefined,
			parentPostId: input.parentPostId ?? resolvedThreadId,
			threadId: resolvedThreadId,
			labels: cleanLabels,
			supersedes: supersedesId,
			seq,
			idempotencyKey: idemKey,
			createdAt: Date.now(),
		};

		this.bus.save("posts", post, input.authorAgentId);

		if (supersededTarget) {
			const supOutcome = transitionSupersedePost(supersededTarget, post.id);
			if (supOutcome.ok) {
				this.bus.save("posts", supOutcome.updated, input.authorAgentId);
			}
		}

		this.bus.emit(
			input.runId,
			"board.posted",
			{
				postId: post.id,
				topic: post.topic,
				authorAgentId: post.authorAgentId,
				authorHandle: post.authorHandle,
				threadId: post.threadId,
				supersedes: post.supersedes,
				labels: post.labels,
			},
			input.authorAgentId,
			{ causalParents: post.references?.map((r) => r.postId) },
		);
		return post;
	}

	search(runId: string, query: string, opts: { k?: number; board?: string } = {}): BoardSearchHit[] {
		return this.query(runId, { query, k: opts.k ?? 5, board: opts.board }).hits;
	}

	query(runId: string, opts: BoardQueryOptions = {}): BoardQueryResult {
		const k = Math.max(1, Math.min(15, Math.floor(opts.k ?? 8)));
		const offset = Math.max(0, Math.floor(opts.offset ?? 0));
		const allPosts = this.allRunPosts(runId, opts.board);
		const cursor = this.currentCursor(allPosts);
		const topics = this.computeTopics(allPosts);
		const labelFilters = parseLabelFilters(opts.labels);
		const topicFilter = opts.topic?.trim().toLowerCase();

		const filtered = allPosts.filter((p) => {
			if (!opts.includeSuperseded && p.supersededBy) return false;
			if (opts.afterSeq !== undefined && postSeq(p) <= opts.afterSeq) return false;
			if (topicFilter && p.topic.toLowerCase() !== topicFilter) return false;
			if (opts.kind && p.kind !== opts.kind) return false;
			if (opts.visibility && (p.visibility ?? "global") !== opts.visibility) return false;
			if (opts.subtreeId && (p.visibility ?? "global") === "subtree" && p.subtreeId !== opts.subtreeId) return false;
			if (opts.threadId && p.id !== opts.threadId && p.threadId !== opts.threadId) return false;
			if (!matchesLabelFilters(p, labelFilters)) return false;
			return true;
		});

		const ranked = rankedBoardPostsDetailed(filtered, allPosts, opts.query ?? "", { limit: k, offset });
		return {
			hits: ranked.hits,
			totalMatches: ranked.totalMatches,
			cursor,
			topics,
		};
	}

	topics(runId: string, board?: string): BoardTopicSummary[] {
		return this.computeTopics(this.allRunPosts(runId, board));
	}

	visit(postId: string): { post: BoardPost; citedBy: BoardPost[]; replies?: BoardPost[]; newestId?: string; cursor?: number } | undefined {
		const post = this.bus.store.get("posts", postId);
		if (!post) return undefined;
		const allPosts = this.allRunPosts(post.runId);
		const citedBy = this.bus.store.listBoardPosts
			? this.bus.store.listBoardPosts(post.runId, undefined, post.id)
			: allPosts.filter((p) => p.references?.some((r) => r.postId === post.id));
		const rootId = post.threadId ?? post.id;
		const replies = allPosts.filter((p) => p.threadId === rootId);
		const newestId = replies.at(-1)?.id ?? rootId;
		return {
			post,
			citedBy,
			replies: replies.length ? replies : undefined,
			newestId,
			cursor: this.currentCursor(allPosts),
		};
	}

	thread(postId: string, opts: { latest?: number } = {}): BoardThreadView | undefined {
		const target = this.bus.store.get("posts", postId);
		if (!target) return undefined;
		const rootId = target.threadId ?? target.id;
		const root = rootId === target.id ? target : this.bus.store.get("posts", rootId);
		if (!root) return undefined;
		const allPosts = this.allRunPosts(root.runId, root.board);
		const allReplies = allPosts.filter((p) => p.threadId === root.id);
		const latest = opts.latest !== undefined ? Math.max(1, Math.min(50, Math.floor(opts.latest))) : allReplies.length;
		const earlierReplies = Math.max(0, allReplies.length - latest);
		const replies = earlierReplies > 0 ? allReplies.slice(-latest) : allReplies;
		return {
			root,
			replies,
			earlierReplies,
			newestId: allReplies.at(-1)?.id ?? root.id,
			cursor: this.currentCursor(allPosts),
		};
	}

	label(postId: string, input: BoardLabelInput): BoardPostLabelResult {
		const isOsActor = input.isOsActor === true;
		const cleanSet = sanitizeLabels(input.set, isOsActor);
		if (!isOsActor && input.unset?.some((k) => isReservedBoardLabel(k))) {
			const bad = input.unset.find((k) => isReservedBoardLabel(k))!;
			throw new BoardError(
				"reserved_label",
				`Label "${bad}" is reserved for OS verification services and cannot be removed by workers.`,
				{ label: bad },
			);
		}
		const update = { set: cleanSet, unset: input.unset, ifMatch: input.ifMatch };
		const res = this.bus.store.updateBoardPostLabels
			? this.bus.store.updateBoardPostLabels(postId, update)
			: (() => {
				const applied = applyBoardPostLabels(this.bus.store.get("posts", postId), update);
				if (applied.ok) this.bus.store.put("posts", applied.post);
				return applied;
			})();

		if (res.ok) {
			this.bus.emit(
				res.post.runId,
				"board.labeled",
				{
					postId: res.post.id,
					set: cleanSet,
					unset: input.unset ? [...input.unset] : undefined,
					actorId: input.actorId,
				},
				input.actorId,
			);
		}
		return res;
	}

	promote(postId: string, input: { actorId: string; labels?: Record<string, string>; reason?: string }): BoardPost | undefined {
		const existing = this.bus.store.get("posts", postId);
		if (!existing) return undefined;
		const nextLabels: Record<string, string> = {
			...(existing.labels ?? {}),
			...(input.labels ?? {}),
			"os:promoted": "true",
		};
		const updated: BoardPost = {
			...existing,
			visibility: "global",
			labels: nextLabels,
		};
		this.bus.save("posts", updated, input.actorId);
		const novelty = nextLabels["os:novelty"] !== undefined ? Number(nextLabels["os:novelty"]) : undefined;
		const broadcastProb = nextLabels["os:broadcast_prob"] !== undefined ? Number(nextLabels["os:broadcast_prob"]) : undefined;
		const crossoverProb = nextLabels["os:crossover_prob"] !== undefined ? Number(nextLabels["os:crossover_prob"]) : undefined;
		this.bus.emit(
			updated.runId,
			"board.promoted",
			{
				postId: updated.id,
				...(Number.isFinite(novelty) ? { novelty } : {}),
				...(Number.isFinite(broadcastProb) ? { broadcastProb } : {}),
				...(Number.isFinite(crossoverProb) ? { crossoverProb } : {}),
				reason: input.reason ?? "Promoted to global board visibility",
			},
			input.actorId,
		);
		return updated;
	}

	digest(runId: string, boardOrOpts?: string | { board?: string; subtreeId?: string }): string {
		const board = typeof boardOrOpts === "string" ? boardOrOpts : boardOrOpts?.board;
		const subtreeId = typeof boardOrOpts === "string" ? undefined : boardOrOpts?.subtreeId;
		const allPosts = this.allRunPosts(runId, board);
		const visible = allPosts.filter((p) => {
			if (p.supersededBy) return false;
			if (!subtreeId) return true;
			return (p.visibility ?? "global") === "global" || p.subtreeId === subtreeId;
		});
		const cursor = this.currentCursor(allPosts);
		if (!visible.length) return `Board pulse: 0 posts (cursor=${cursor})`;
		const topics = this.computeTopics(visible);
		const promotedCount = visible.filter((p) => p.labels?.["os:promoted"] === "true").length;
		const promotedTag = promotedCount > 0 ? `, promoted=${promotedCount}` : "";
		return `Board pulse: ${visible.length} post${visible.length === 1 ? "" : "s"} [${formatTopics(topics)}]${promotedTag} (cursor=${cursor})`;
	}

	async wait(runId: string, opts: BoardWaitOptions = {}): Promise<BoardWaitResult> {
		const minPosts = Math.max(1, Math.floor(opts.minPosts ?? 1));
		const timeoutMs = Math.max(50, Math.min(MAX_WAIT_MS, Math.floor(opts.timeoutMs ?? DEFAULT_WAIT_MS)));
		const labelFilters = parseLabelFilters(opts.labels);
		const topicFilter = opts.topic?.trim().toLowerCase();

		const collectMatching = (): { matching: BoardPost[]; allPosts: BoardPost[]; cursor: number; topics: BoardTopicSummary[] } => {
			const allPosts = this.allRunPosts(runId, opts.board);
			const matching = allPosts.filter((p) => {
				if (p.supersededBy) return false;
				if (opts.afterSeq !== undefined && postSeq(p) <= opts.afterSeq) return false;
				if (topicFilter && p.topic.toLowerCase() !== topicFilter) return false;
				if (opts.kind && p.kind !== opts.kind) return false;
				if (opts.visibility && (p.visibility ?? "global") !== opts.visibility) return false;
				if (opts.threadId && p.id !== opts.threadId && p.threadId !== opts.threadId) return false;
				if (!matchesLabelFilters(p, labelFilters)) return false;
				return true;
			});
			return {
				matching,
				allPosts,
				cursor: this.currentCursor(allPosts),
				topics: this.computeTopics(allPosts),
			};
		};

		const toWaitResult = (
			snap: { matching: BoardPost[]; cursor: number; topics: BoardTopicSummary[] },
			endReason: "matched" | "timed_out" | "aborted",
		): BoardWaitResult => {
			if (snap.matching.length >= minPosts && snap.matching.length > 0) {
				const [first, ...rest] = snap.matching;
				return {
					status: "matched",
					timedOut: false,
					posts: [first!, ...rest],
					cursor: snap.cursor,
					topics: snap.topics,
				};
			}
			return {
				status: endReason === "aborted" ? "aborted" : "timed_out",
				timedOut: true,
				posts: snap.matching,
				cursor: snap.cursor,
				topics: snap.topics,
			};
		};

		const initial = collectMatching();
		if (initial.matching.length >= minPosts) {
			return toWaitResult(initial, "matched");
		}
		if (opts.signal?.aborted) {
			return toWaitResult(initial, "aborted");
		}

		type WaitLifecycle =
			| {
				readonly kind: "waiting";
				readonly timer: ReturnType<typeof setTimeout>;
				readonly unsub: () => void;
				readonly onAbort: () => void;
			}
			| { readonly kind: "settled" };

		return new Promise<BoardWaitResult>((resolve) => {
			let state: WaitLifecycle;

			const settle = (reason: "matched" | "timed_out" | "aborted") => {
				if (state.kind === "settled") return;
				const prev = state;
				state = { kind: "settled" };
				clearTimeout(prev.timer);
				prev.unsub();
				opts.signal?.removeEventListener("abort", prev.onAbort);
				resolve(toWaitResult(collectMatching(), reason));
			};

			const onAbort = () => settle("aborted");
			const unsub = this.bus.on((ev) => {
				if (ev.runId !== runId) return;
				if (ev.type !== "board.posted" && ev.type !== "board.labeled") return;
				if (collectMatching().matching.length >= minPosts) {
					settle("matched");
				}
			});
			const timer = setTimeout(() => settle("timed_out"), timeoutMs);
			timer.unref?.();
			state = { kind: "waiting", timer, unsub, onAbort };
			opts.signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	recent(runId: string, limit = 10): BoardPost[] {
		return this.allRunPosts(runId)
			.filter((p) => !p.supersededBy)
			.reverse()
			.slice(0, limit);
	}
}

export interface BoardToolsOptions {
	/** Resolve an OS-assigned readable handle for an agentId (e.g. "peer-1"). */
	resolveHandle?: (agentId: string) => string | undefined;
	/** Resolve the subtree root ID for an agentId (enables subtree-scoped digests). */
	resolveSubtree?: (agentId: string) => string | undefined;
	/** Default visibility stamped onto posts created via `board_publish`. */
	defaultVisibility?: BoardVisibility;
}

const VALID_KINDS = new Set<BoardPostKind>(["discovery", "hypothesis", "counterexample", "dead_end", "bound_estimate", "update"]);

function renderPostEntry(post: BoardPost, query: string, citations: number, bodyLimit = 480): string {
	const who = post.authorHandle ?? post.authorAgentId;
	const kindStr = post.kind ? `, kind=${post.kind}` : "";
	const visStr = post.visibility === "subtree" ? `, scope=subtree:${post.subtreeId ?? "local"}` : "";
	const threadStr = post.threadId ? `, thread=${post.threadId}` : "";
	const supStr = post.supersededBy ? `, SUPERSEDED_BY=${post.supersededBy}` : "";
	const excerpt = searchExcerptDetailed(post.body, query, bodyLimit);
	const truncHint = excerpt.truncated
		? `\n[truncated: ${excerpt.totalChars} chars — call board_visit("${post.id}") for full body]`
		: "";
	const summaryLine = post.summary && post.body !== post.summary ? `Summary: ${post.summary}\n` : "";
	return `[${post.id}] (${post.topic}${kindStr}${visStr}, by ${who}, seq=${postSeq(post)}, citations=${citations}${formatLabels(post.labels)}${threadStr}${supStr})\n${summaryLine}${excerpt.text}${truncHint}`;
}

/**
 * 4 lean, high-signal MCP/in-process board tools:
 * `board_search`, `board_publish`, `board_visit`, `board_wait`.
 */
export function boardTools(board: BoardService, opts: BoardToolsOptions = {}): ToolDefinition[] {
	return [
		{
			name: "board_search",
			description: "Search or list posts on the shared swarm board. Supports optional topic/label/thread/cursor filters and always returns active topics.",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "Optional keywords (omit or empty to list latest posts)" },
					topic: { type: "string", description: "Optional exact topic filter" },
					kind: { type: "string", enum: ["discovery", "hypothesis", "counterexample", "dead_end", "bound_estimate", "update"], description: "Optional epistemic claim kind filter" },
					visibility: { type: "string", enum: ["subtree", "global"], description: "Optional visibility scope filter" },
					channel: { type: "string", description: "Optional board channel name (default swarm)" },
					thread_id: { type: "string", description: "Optional thread root post ID to read a thread chronologically" },
					labels: { type: "array", items: { type: "string" }, description: "Optional label filters like ['state=open', 'seat=0']" },
					after: { type: "number", minimum: 0, description: "Optional cursor: only return posts with seq > after" },
					k: { type: "number", minimum: 1, maximum: 15, description: "Max results (default 8)" },
					offset: { type: "number", minimum: 0, description: "Pagination offset (default 0)" },
					include_superseded: { type: "boolean", description: "Include superseded older drafts (default false)" },
				},
			},
			execute(args, ctx) {
				const query = typeof args.query === "string" ? args.query : "";
				const topic = typeof args.topic === "string" && args.topic.trim() ? args.topic.trim() : undefined;
				const kindRaw = typeof args.kind === "string" ? args.kind.trim() : "";
				const kind = VALID_KINDS.has(kindRaw as BoardPostKind) ? (kindRaw as BoardPostKind) : undefined;
				const visibility = args.visibility === "subtree" || args.visibility === "global" ? args.visibility : undefined;
				const channel = typeof args.channel === "string" && args.channel.trim() ? args.channel.trim() : undefined;
				const threadId = typeof args.thread_id === "string" && args.thread_id.trim() ? args.thread_id.trim() : undefined;
				const labels = Array.isArray(args.labels)
					? args.labels.filter((l): l is string => typeof l === "string" && l.trim().length > 0)
					: undefined;
				const afterSeq = typeof args.after === "number" && Number.isFinite(args.after) ? Math.floor(args.after) : undefined;
				const k = typeof args.k === "number" && Number.isFinite(args.k) ? Math.max(1, Math.min(15, Math.floor(args.k))) : 8;
				const offset = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
				const includeSuperseded = args.include_superseded === true;

				// Thread view shortcut when `thread_id` is passed without a keyword query
				if (threadId && !query.trim()) {
					const tv = board.thread(threadId, { latest: k });
					if (!tv) {
						return { text: `Thread not found: ${threadId}`, isError: true };
					}
					const citations = computeCitationCounts([tv.root, ...tv.replies]);
					const header = `Thread ${tv.root.id} (${tv.root.topic}, replies=${tv.replies.length}${tv.earlierReplies ? ` + ${tv.earlierReplies} earlier` : ""}, newest_id=${tv.newestId}, cursor=${tv.cursor})`;
					const lines = [
						header,
						"",
						renderPostEntry(tv.root, "", citations.get(tv.root.id) ?? 0),
						...tv.replies.map((r) => renderPostEntry(r, "", citations.get(r.id) ?? 0)),
					];
					return {
						text: lines.join("\n\n"),
						data: { threadId: tv.root.id, newestId: tv.newestId, cursor: tv.cursor, replyCount: tv.replies.length },
					};
				}

				const res = board.query(ctx.runId, {
					query,
					topic,
					kind,
					visibility,
					board: channel,
					threadId,
					labels,
					afterSeq,
					k,
					offset,
					includeSuperseded,
				});
				const topicList = formatTopics(res.topics);
				if (!res.hits.length) {
					const hint = res.topics.length
						? ` — retry with query="" or topic="${res.topics[0]!.topic}"`
						: "";
					const desc = query.trim() ? ` for "${query.trim()}"` : "";
					return {
						text: `No matching posts${desc} (cursor=${res.cursor}) | Active topics: ${topicList}${hint}`,
						data: { totalMatches: 0, cursor: res.cursor, topics: res.topics },
					};
				}
				const start = offset + 1;
				const end = offset + res.hits.length;
				const moreHint = end < res.totalMatches ? ` | Next page: offset=${end}` : "";
				const header = `Showing ${start}-${end} of ${res.totalMatches} match${res.totalMatches === 1 ? "" : "es"} (cursor=${res.cursor}) | Topics: ${topicList}${moreHint}`;
				const body = res.hits.map(({ post, citations }) => renderPostEntry(post, query, citations)).join("\n\n");
				return {
					text: `${header}\n\n${body}`,
					data: { totalMatches: res.totalMatches, shown: res.hits.length, cursor: res.cursor, topics: res.topics },
				};
			},
		},
		{
			name: "board_publish",
			description: "Publish a discovery, partial result, or thread reply to the shared swarm board (supports labels, supersedes, optimistic concurrency, and idempotency).",
			inputSchema: {
				type: "object",
				properties: {
					topic: { type: "string", description: "Short topic tag (e.g. 'shard-subtotal', 'interface', 'blocker')" },
					kind: { type: "string", enum: ["discovery", "hypothesis", "counterexample", "dead_end", "bound_estimate", "update"], description: "Typed epistemic claim kind on the shared knowledge DAG" },
					visibility: { type: "string", enum: ["subtree", "global"], description: "Optional scope ('subtree' for local branch notes, 'global' for cross-swarm announcements)" },
					summary: { type: "string", description: "1-2 sentence concise summary" },
					body: { type: "string", description: "Optional full note body" },
					channel: { type: "string", description: "Optional board channel name (default swarm)" },
					thread_id: { type: "string", description: "Optional thread root post ID to reply inside a thread" },
					parent_ids: { type: "array", items: { type: "string" }, description: "Optional cited post IDs this builds on" },
					supersedes: { type: "string", description: "Optional older post ID that this post replaces" },
					labels: { type: "object", additionalProperties: { type: "string" }, description: "Optional key-value tags (e.g. { seat: '0', state: 'ready' }); 'os:*' is reserved" },
					if_latest_id: { type: "string", description: "Optional optimistic lock: fail if thread/topic has a newer post" },
					idempotency_key: { type: "string", description: "Optional key to deduplicate retried publishes" },
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
				let labels: Record<string, string> | undefined;
				if (args.labels && typeof args.labels === "object" && !Array.isArray(args.labels)) {
					labels = {};
					for (const [k, v] of Object.entries(args.labels as Record<string, unknown>)) {
						if (v !== undefined && v !== null) labels[k] = String(v);
					}
				}
				const kindRaw = typeof args.kind === "string" ? args.kind.trim() : "";
				const kind = VALID_KINDS.has(kindRaw as BoardPostKind) ? (kindRaw as BoardPostKind) : undefined;
				const requestedVis = args.visibility === "subtree" || args.visibility === "global" ? args.visibility : undefined;
				const subtreeId = opts.resolveSubtree?.(ctx.agentId);
				try {
					const post = board.publish({
						runId: ctx.runId,
						authorAgentId: ctx.agentId,
						authorHandle: opts.resolveHandle?.(ctx.agentId),
						topic: String(args.topic ?? "general"),
						kind,
						subtreeId,
						visibility: requestedVis ?? opts.defaultVisibility,
						summary: String(args.summary ?? ""),
						body: typeof args.body === "string" ? args.body : undefined,
						board: typeof args.channel === "string" && args.channel.trim() ? args.channel.trim() : undefined,
						threadId: typeof args.thread_id === "string" && args.thread_id.trim() ? args.thread_id.trim() : undefined,
						references: refs,
						supersedes: typeof args.supersedes === "string" && args.supersedes.trim() ? args.supersedes.trim() : undefined,
						labels,
						ifLatestId: typeof args.if_latest_id === "string" && args.if_latest_id.trim() ? args.if_latest_id.trim() : undefined,
						idempotencyKey: typeof args.idempotency_key === "string" && args.idempotency_key.trim() ? args.idempotency_key.trim() : undefined,
						artifactIds,
						isOsActor: false,
					});
					const pulse = board.digest(ctx.runId, { board: post.board, subtreeId });
					const threadSuffix = post.threadId ? `, thread=${post.threadId}` : "";
					return {
						text: `Published ${post.id} (topic=${post.topic}, seq=${postSeq(post)}${threadSuffix}). ${pulse}`,
						data: { postId: post.id, seq: postSeq(post), threadId: post.threadId },
					};
				} catch (error) {
					if (error instanceof BoardError) {
						return {
							text: `board_publish rejected (${error.code}): ${error.message}`,
							isError: true,
							data: { code: error.code, ...(error.data ?? {}) },
						};
					}
					return {
						text: `board_publish error: ${error instanceof Error ? error.message : String(error)}`,
						isError: true,
					};
				}
			},
		},
		{
			name: "board_visit",
			description: "Read the full untruncated body, labels, replies, and citing backlinks of one board post by ID.",
			inputSchema: {
				type: "object",
				properties: {
					post_id: { type: "string", description: "Post ID from board_search or board_wait" },
				},
				required: ["post_id"],
			},
			execute(args) {
				const res = board.visit(String(args.post_id ?? ""));
				if (!res) return { text: `Post not found: ${String(args.post_id ?? "")}`, isError: true };
				const who = res.post.authorHandle ?? res.post.authorAgentId;
				const superseded = res.post.supersededBy ? `\n[SUPERSEDED BY ${res.post.supersededBy}]` : "";
				const supersedes = res.post.supersedes ? `\nSupersedes: ${res.post.supersedes}` : "";
				const artifacts = res.post.artifactIds?.length ? `\nArtifacts: ${res.post.artifactIds.join(", ")}` : "";
				const backlinks = res.citedBy.length
					? `\nCited by: ${res.citedBy.map((p) => `${p.id} (${p.authorHandle ?? p.authorAgentId})`).join(", ")}`
					: "";
				const repliesBlock = res.replies?.length
					? `\n\nReplies (${res.replies.length}, newest_id=${res.newestId}):\n` +
						res.replies
							.map((r) => `- [${r.id}] by ${r.authorHandle ?? r.authorAgentId} (seq=${postSeq(r)}): ${r.body}`)
							.join("\n")
					: "";
				const summaryLine = res.post.summary && res.post.body !== res.post.summary ? `\nSummary: ${res.post.summary}` : "";
				return {
					text: `[${res.post.id}] ${res.post.topic} (by ${who}, seq=${postSeq(res.post)}${formatLabels(res.post.labels)}, cursor=${res.cursor ?? 0})${superseded}${summaryLine}\n${res.post.body}${supersedes}${artifacts}${backlinks}${repliesBlock}`,
					data: { postId: res.post.id, newestId: res.newestId, cursor: res.cursor },
				};
			},
		},
		{
			name: "board_wait",
			description: "Wait reactively (up to 25s, zero polling) until matching peer posts appear on the board (use min_posts to wait for all peers to publish).",
			inputSchema: {
				type: "object",
				properties: {
					after: { type: "number", minimum: 0, description: "Optional cursor: only match posts with seq > after" },
					topic: { type: "string", description: "Optional exact topic filter" },
					kind: { type: "string", enum: ["discovery", "hypothesis", "counterexample", "dead_end", "bound_estimate", "update"], description: "Optional epistemic claim kind filter" },
					visibility: { type: "string", enum: ["subtree", "global"], description: "Optional visibility scope filter" },
					channel: { type: "string", description: "Optional board channel name (default swarm)" },
					thread_id: { type: "string", description: "Optional thread root post ID filter" },
					labels: { type: "array", items: { type: "string" }, description: "Optional label filters like ['state=ready']" },
					min_posts: { type: "number", minimum: 1, maximum: 32, description: "Wait until at least N matching posts exist (default 1)" },
					timeout_seconds: { type: "number", minimum: 1, maximum: 25, description: "Max seconds to wait (1..25, default 20)" },
				},
			},
			async execute(args, ctx) {
				const afterSeq = typeof args.after === "number" && Number.isFinite(args.after) ? Math.floor(args.after) : undefined;
				const topic = typeof args.topic === "string" && args.topic.trim() ? args.topic.trim() : undefined;
				const kindRaw = typeof args.kind === "string" ? args.kind.trim() : "";
				const kind = VALID_KINDS.has(kindRaw as BoardPostKind) ? (kindRaw as BoardPostKind) : undefined;
				const visibility = args.visibility === "subtree" || args.visibility === "global" ? args.visibility : undefined;
				const channel = typeof args.channel === "string" && args.channel.trim() ? args.channel.trim() : undefined;
				const threadId = typeof args.thread_id === "string" && args.thread_id.trim() ? args.thread_id.trim() : undefined;
				const labels = Array.isArray(args.labels)
					? args.labels.filter((l): l is string => typeof l === "string" && l.trim().length > 0)
					: undefined;
				const minPosts = typeof args.min_posts === "number" && Number.isFinite(args.min_posts)
					? Math.max(1, Math.min(32, Math.floor(args.min_posts)))
					: 1;
				const timeoutSeconds = typeof args.timeout_seconds === "number" && Number.isFinite(args.timeout_seconds)
					? Math.max(1, Math.min(25, args.timeout_seconds))
					: 20;

				const res = await board.wait(ctx.runId, {
					afterSeq,
					board: channel,
					topic,
					kind,
					visibility,
					threadId,
					labels,
					minPosts,
					timeoutMs: timeoutSeconds * 1000,
					signal: ctx.signal,
				});

				const topicList = formatTopics(res.topics);
				const statusLine = res.timedOut
					? `Timed out after ${timeoutSeconds}s (${res.posts.length}/${minPosts} matching posts, cursor=${res.cursor}) | Topics: ${topicList}`
					: `Matched ${res.posts.length} post${res.posts.length === 1 ? "" : "s"} (cursor=${res.cursor}) | Topics: ${topicList}`;
				if (!res.posts.length) {
					return {
						text: statusLine,
						data: { timedOut: res.timedOut, count: 0, cursor: res.cursor, topics: res.topics },
					};
				}
				const citations = computeCitationCounts(res.posts);
				const entries = res.posts.slice(-15).map((p) => renderPostEntry(p, "", citations.get(p.id) ?? 0));
				return {
					text: `${statusLine}\n\n${entries.join("\n\n")}`,
					data: { timedOut: res.timedOut, count: res.posts.length, cursor: res.cursor, topics: res.topics },
				};
			},
		},
	];
}
