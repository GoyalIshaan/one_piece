import { createHash } from "node:crypto";
import {
	applyBoardPostLabels,
	type BoardEditInput,
	type BoardLabelInput,
	type BoardPost,
	type BoardPostLabelResult,
	type BoardPublishInput,
	type BoardQueryOptions,
	type BoardQueryResult,
	type BoardReference,
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
	transitionCrosspost,
	transitionMarkOutdatedPost,
	transitionPromotePost,
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

const DEFAULT_CHANNEL = "swarm";
const MAX_WAIT_MS = 25_000;
const DEFAULT_WAIT_MS = 20_000;
const AUTO_DEDUP_WINDOW_MS = 30_000;

export type BoardErrorCode = "reserved_label" | "newer_message" | "label_conflict" | "not_found" | "invalid_input" | "forbidden";

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

export function normalizeChannel(raw?: string): string | undefined {
	if (!raw) return undefined;
	const clean = raw.trim().replace(/^#+/, "").trim();
	return clean || undefined;
}

export function postChannel(post: BoardPost): string {
	const explicit = normalizeChannel(post.channel) ?? normalizeChannel(post.board);
	if (explicit) return explicit;
	if (post.visibility === "subtree" && post.subtreeId) return `team-${post.subtreeId}`;
	return DEFAULT_CHANNEL;
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

function isHiddenPost(post: BoardPost): boolean {
	return Boolean(post.supersededBy || post.outdated);
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

function deriveSummary(titleOrSummary: string | undefined, text: string): string {
	const raw = (titleOrSummary?.trim() || text.trim().split(/\r?\n/)[0] || "update").trim();
	return raw.slice(0, 400);
}

function computeContentFingerprint(parts: {
	runId: string;
	authorAgentId: string;
	channel: string;
	topic: string;
	replyToId?: string;
	quotedPostId?: string;
	summary: string;
	body: string;
}): string {
	return createHash("sha256")
		.update(
			[
				parts.runId,
				parts.authorAgentId,
				parts.channel,
				parts.topic,
				parts.replyToId ?? "",
				parts.quotedPostId ?? "",
				parts.summary,
				parts.body,
			].join("\0"),
		)
		.digest("hex")
		.slice(0, 24);
}

/**
 * Board v3 — Reddit/X-Native Swarm Message Board.
 * - Channels (`#swarm` global, `#team-<subtree>` local) replace opaque visibility flags.
 * - Folded `board_post` (new / reply / quote-crosspost) + `board_edit` (`outdated`) replace epistemic-DAG jargon.
 * - Planners explicitly crosspost verified wins from `#team-X` -> `#swarm` (replacing Jev visibility gating).
 * - OS background layer silently enforces monotonic `seq`, content-hash idempotency, anti-spoofing, and outdated hiding.
 */
export class SwarmBoardService implements BoardService {
	private readonly bus: EventBus;
	private readonly seqByRun = new Map<string, number>();

	constructor(bus: EventBus) {
		this.bus = bus;
	}

	private allRunPosts(runId: string, channel?: string): BoardPost[] {
		const normChan = normalizeChannel(channel);
		const posts = this.bus.store.listBoardPosts
			? this.bus.store.listBoardPosts(runId, normChan)
			: this.bus.store.list("posts", { runId }).filter((p) => !normChan || postChannel(p) === normChan);
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
			if (isHiddenPost(p)) continue;
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
		const authorAgent = this.bus.store.get("agents", input.authorAgentId);
		const authorHandle = input.authorHandle?.trim() || authorAgent?.handle || undefined;
		const resolvedSubtreeId = input.subtreeId?.trim() || authorAgent?.subtreeId || undefined;

		// 1. Explicit idempotency key deduplication
		const idemKey = input.idempotencyKey?.trim() || undefined;
		if (idemKey) {
			const existing = this.bus.store.findBoardPostByIdempotencyKey
				? this.bus.store.findBoardPostByIdempotencyKey(input.runId, idemKey)
				: this.bus.store.list("posts", { runId: input.runId }).find((p) => p.idempotencyKey === idemKey);
			if (existing) return existing;
		}

		// 2. Reply / Thread resolution (normalize reply-to-reply onto the root threadId)
		const rawReplyId = input.replyToId?.trim() || input.threadId?.trim() || undefined;
		let resolvedThreadId: string | undefined;
		let resolvedReplyToId: string | undefined;
		let replyTarget: BoardPost | undefined;
		let topic = input.topic.trim() || "general";
		if (rawReplyId) {
			const target = this.bus.store.get("posts", rawReplyId);
			if (!target || target.runId !== input.runId) {
				throw new BoardError("not_found", `Reply/thread target post not found: ${rawReplyId}`);
			}
			replyTarget = target;
			resolvedReplyToId = target.id;
			resolvedThreadId = target.threadId ?? target.id;
			if (!input.topic.trim()) topic = target.topic;
		}

		// 3. Resolve channel & visibility (Reddit/X model: "swarm" = global, "team-*" = subtree)
		const explicitChannel = normalizeChannel(input.channel) ?? normalizeChannel(input.board);
		let channel: string;
		if (explicitChannel) {
			channel = explicitChannel;
		} else if (replyTarget) {
			channel = postChannel(replyTarget);
		} else if (input.visibility === "subtree" && resolvedSubtreeId) {
			channel = `team-${resolvedSubtreeId}`;
		} else if (input.visibility === "global") {
			channel = DEFAULT_CHANNEL;
		} else if (authorAgent?.role === "worker" && resolvedSubtreeId) {
			channel = `team-${resolvedSubtreeId}`;
		} else {
			channel = DEFAULT_CHANNEL;
		}
		const resolvedVisibility: BoardVisibility =
			input.visibility ?? (channel === DEFAULT_CHANNEL ? "global" : "subtree");

		// 4. Quote / Crosspost resolution (validates via compile-time crosspost state machine)
		let quotedPost: BoardPost | undefined;
		let isCrosspostToSwarm = false;
		let sourceChannelForCrosspost: string | undefined;
		const rawQuotedId = input.quotedPostId?.trim() || undefined;
		if (rawQuotedId) {
			const src = this.bus.store.get("posts", rawQuotedId);
			if (!src || src.runId !== input.runId) {
				throw new BoardError("not_found", `Quoted post not found: ${rawQuotedId}`);
			}
			const xp = transitionCrosspost(src, channel);
			if (!xp.ok) {
				throw new BoardError("invalid_input", `Cannot quote/crosspost ${src.id}: ${xp.reason}`, {
					reason: xp.reason,
					quotedPostId: src.id,
				});
			}
			quotedPost = src;
			sourceChannelForCrosspost = xp.sourceChannel;
			isCrosspostToSwarm =
				channel === DEFAULT_CHANNEL &&
				(xp.sourceChannel !== DEFAULT_CHANNEL || src.visibility === "subtree");
			if (!input.topic.trim()) topic = src.topic;
		}

		// 5. Merge references cleanly (explicit references + reply_to + quote_post_id)
		const refMap = new Map<string, BoardReference>();
		for (const r of input.references ?? []) {
			if (r.postId.trim()) refMap.set(r.postId.trim(), { postId: r.postId.trim(), reason: r.reason || "builds_on" });
		}
		if (resolvedReplyToId && !refMap.has(resolvedReplyToId)) {
			refMap.set(resolvedReplyToId, { postId: resolvedReplyToId, reason: "reply" });
		}
		if (quotedPost && !refMap.has(quotedPost.id)) {
			refMap.set(quotedPost.id, { postId: quotedPost.id, reason: isCrosspostToSwarm ? "crosspost" : "quote" });
		}
		const mergedRefs = refMap.size ? [...refMap.values()] : undefined;

		// 6. Legacy optimistic concurrency (`ifLatestId`) when passed programmatically
		if (input.ifLatestId?.trim()) {
			const expected = input.ifLatestId.trim();
			const scopePosts = this.allRunPosts(input.runId, channel).filter((p) =>
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

		// 7. Resolve legacy supersedes target (if provided)
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

		// 8. Background OS content-hash deduplication window (silent retry protection without exposing idempotency_key)
		const summary = input.summary.trim().slice(0, 400);
		const body = (input.body ?? input.summary).trim();
		const now = Date.now();
		if (!idemKey && !isOsActor) {
			const fp = computeContentFingerprint({
				runId: input.runId,
				authorAgentId: input.authorAgentId,
				channel,
				topic,
				replyToId: resolvedReplyToId,
				quotedPostId: quotedPost?.id,
				summary,
				body,
			});
			const recentDup = this.allRunPosts(input.runId, channel)
				.reverse()
				.find(
					(p) =>
						!isHiddenPost(p) &&
						p.authorAgentId === input.authorAgentId &&
						now - p.createdAt <= AUTO_DEDUP_WINDOW_MS &&
						p.idempotencyKey === `auto:${fp}`,
				);
			if (recentDup) return recentDup;
		}

		const finalIdemKey =
			idemKey ??
			(!isOsActor
				? `auto:${computeContentFingerprint({
					runId: input.runId,
					authorAgentId: input.authorAgentId,
					channel,
					topic,
					replyToId: resolvedReplyToId,
					quotedPostId: quotedPost?.id,
					summary,
					body,
				})}`
				: undefined);

		const finalLabels: Record<string, string> | undefined = isCrosspostToSwarm
			? { ...(cleanLabels ?? {}), "os:promoted": "true" }
			: cleanLabels;

		// 9. Assign monotonic sequence & persist post BEFORE emitting board.posted so reactive listeners see it immediately
		const seq = this.nextSeq(input.runId);
		const post: BoardPost = {
			id: newId("post"),
			runId: input.runId,
			board: channel,
			channel,
			topic,
			kind: input.kind,
			subtreeId: resolvedSubtreeId,
			visibility: resolvedVisibility,
			authorAgentId: input.authorAgentId,
			authorHandle,
			summary,
			body,
			references: mergedRefs,
			artifactIds: input.artifactIds?.length ? input.artifactIds : undefined,
			parentPostId: input.parentPostId ?? resolvedReplyToId ?? resolvedThreadId,
			replyToId: resolvedReplyToId,
			quotedPostId: quotedPost?.id,
			threadId: resolvedThreadId,
			labels: finalLabels,
			supersedes: supersedesId,
			seq,
			idempotencyKey: finalIdemKey,
			createdAt: now,
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
				channel: post.channel,
				authorAgentId: post.authorAgentId,
				authorHandle: post.authorHandle,
				threadId: post.threadId,
				replyToId: post.replyToId,
				quotedPostId: post.quotedPostId,
				supersedes: post.supersedes,
				labels: post.labels,
			},
			input.authorAgentId,
			{ causalParents: post.references?.map((r) => r.postId) },
		);

		if (isCrosspostToSwarm && quotedPost) {
			const actorRole: "planner" | "director" | "os" = isOsActor
				? "os"
				: authorAgent?.role === "planner" || authorAgent?.role === "root"
					? "planner"
					: "director";
			this.bus.emit(
				input.runId,
				"board.promoted",
				{
					postId: post.id,
					actorRole,
					sourceChannel: sourceChannelForCrosspost,
					targetChannel: channel,
					quotedPostId: quotedPost.id,
					reason: `Crossposted ${quotedPost.id} from #${sourceChannelForCrosspost} to #${channel}`,
				},
				input.authorAgentId,
			);
		}

		return post;
	}

	edit(input: BoardEditInput): BoardPost {
		const existing = this.bus.store.get("posts", input.postId);
		if (!existing) {
			throw new BoardError("not_found", `Post not found: ${input.postId}`);
		}
		const isAuthor = existing.authorAgentId === input.authorAgentId;
		if (!isAuthor && !input.isPlannerOrOs) {
			throw new BoardError(
				"forbidden",
				`Only the original author or a Planner/OS actor may edit post ${input.postId}.`,
			);
		}
		const now = Date.now();
		let updated: BoardPost = existing;

		if (input.outdated === true) {
			const res = transitionMarkOutdatedPost(existing, input.outdatedReason, now);
			if (!res.ok) {
				throw new BoardError("invalid_input", `Cannot mark post ${input.postId} outdated: ${res.reason}`, {
					reason: res.reason,
				});
			}
			updated = {
				...res.updated,
				...(input.body !== undefined ? { body: input.body.trim() } : {}),
				...(input.summary !== undefined ? { summary: input.summary.trim().slice(0, 400) } : {}),
			};
			this.bus.save("posts", updated, input.authorAgentId);
			this.bus.emit(
				updated.runId,
				"board.outdated",
				{
					postId: updated.id,
					actorAgentId: input.authorAgentId,
					reason: updated.outdatedReason ?? "Marked outdated",
				},
				input.authorAgentId,
			);
			this.bus.emit(
				updated.runId,
				"board.edited",
				{
					postId: updated.id,
					authorAgentId: input.authorAgentId,
					outdated: true,
					outdatedReason: updated.outdatedReason,
				},
				input.authorAgentId,
			);
			return updated;
		}

		const nextBody = input.body !== undefined ? input.body.trim() : existing.body;
		const nextSummary =
			input.summary !== undefined
				? input.summary.trim().slice(0, 400)
				: input.body !== undefined
					? deriveSummary(undefined, nextBody)
					: existing.summary;
		updated = {
			...existing,
			body: nextBody,
			summary: nextSummary,
			editedAt: now,
		};
		this.bus.save("posts", updated, input.authorAgentId);
		this.bus.emit(
			updated.runId,
			"board.edited",
			{
				postId: updated.id,
				authorAgentId: input.authorAgentId,
				outdated: updated.outdated,
			},
			input.authorAgentId,
		);
		return updated;
	}

	search(runId: string, query: string, opts: { k?: number; board?: string } = {}): BoardSearchHit[] {
		return this.query(runId, { query, k: opts.k ?? 5, board: opts.board }).hits;
	}

	query(runId: string, opts: BoardQueryOptions = {}): BoardQueryResult {
		const k = Math.max(1, Math.min(15, Math.floor(opts.k ?? 8)));
		const offset = Math.max(0, Math.floor(opts.offset ?? 0));
		const chanFilter = normalizeChannel(opts.channel) ?? normalizeChannel(opts.board);
		const allPosts = this.allRunPosts(runId, chanFilter);
		const cursor = this.currentCursor(allPosts);
		const topics = this.computeTopics(allPosts);
		const labelFilters = parseLabelFilters(opts.labels);
		const topicFilter = opts.topic?.trim().toLowerCase();
		const includeHidden = Boolean(opts.includeSuperseded || opts.includeOutdated);

		const filtered = allPosts.filter((p) => {
			if (!includeHidden && isHiddenPost(p)) return false;
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

	recentChannelPosts(runId: string, channel: string, opts: { afterSeq?: number; limit?: number } = {}): BoardPost[] {
		const normChan = normalizeChannel(channel) ?? DEFAULT_CHANNEL;
		const limit = Math.max(1, Math.min(20, opts.limit ?? 6));
		return this.allRunPosts(runId, normChan)
			.filter((p) => !isHiddenPost(p) && (opts.afterSeq === undefined || postSeq(p) > opts.afterSeq))
			.slice(-limit);
	}

	visit(postId: string): { post: BoardPost; citedBy: BoardPost[]; replies?: BoardPost[]; newestId?: string; cursor?: number } | undefined {
		const post = this.bus.store.get("posts", postId);
		if (!post) return undefined;
		const allPosts = this.allRunPosts(post.runId);
		const citedBy = allPosts.filter(
			(p) =>
				p.id !== post.id &&
				(p.quotedPostId === post.id ||
					p.replyToId === post.id ||
					Boolean(p.references?.some((r) => r.postId === post.id))),
		);
		const rootId = post.threadId ?? post.id;
		const replies = allPosts.filter((p) => p.threadId === rootId && p.id !== rootId);
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
		const allPosts = this.allRunPosts(root.runId, postChannel(root));
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
		if (existing.outdated) return undefined;
		const outcome = transitionPromotePost(existing, { labels: input.labels });
		if (!outcome.ok) return undefined;
		const updated: BoardPost = {
			...outcome.updated,
			board: DEFAULT_CHANNEL,
			channel: DEFAULT_CHANNEL,
		};
		this.bus.save("posts", updated, input.actorId);
		this.bus.emit(
			updated.runId,
			"board.promoted",
			{
				postId: updated.id,
				actorRole: "planner",
				sourceChannel: postChannel(existing),
				targetChannel: DEFAULT_CHANNEL,
				reason: input.reason ?? "Promoted to #swarm",
			},
			input.actorId,
		);
		return updated;
	}

	digest(runId: string, boardOrOpts?: string | { board?: string; channel?: string; subtreeId?: string }): string {
		const channel =
			typeof boardOrOpts === "string"
				? normalizeChannel(boardOrOpts)
				: normalizeChannel(boardOrOpts?.channel) ?? normalizeChannel(boardOrOpts?.board);
		const subtreeId = typeof boardOrOpts === "string" ? undefined : boardOrOpts?.subtreeId;
		const allPosts = this.allRunPosts(runId, channel);
		const visible = allPosts.filter((p) => {
			if (isHiddenPost(p)) return false;
			if (!subtreeId || channel) return true;
			return (p.visibility ?? "global") === "global" || postChannel(p) === DEFAULT_CHANNEL || p.subtreeId === subtreeId;
		});
		const cursor = this.currentCursor(allPosts);
		const chanLabel = channel ? `#${channel}` : subtreeId ? `#swarm + #team-${subtreeId}` : "#swarm";
		if (!visible.length) return `Board pulse (${chanLabel}): 0 posts (cursor=${cursor})`;
		const topics = this.computeTopics(visible);
		const crossposts = visible.filter((p) => p.labels?.["os:promoted"] === "true" || Boolean(p.quotedPostId)).length;
		const xpTag = crossposts > 0 ? `, crossposts=${crossposts}` : "";
		return `Board pulse (${chanLabel}): ${visible.length} post${visible.length === 1 ? "" : "s"} [${formatTopics(topics)}]${xpTag} (cursor=${cursor})`;
	}

	async wait(runId: string, opts: BoardWaitOptions = {}): Promise<BoardWaitResult> {
		const minPosts = Math.max(1, Math.floor(opts.minPosts ?? 1));
		const timeoutMs = Math.max(50, Math.min(MAX_WAIT_MS, Math.floor(opts.timeoutMs ?? DEFAULT_WAIT_MS)));
		const labelFilters = parseLabelFilters(opts.labels);
		const topicFilter = opts.topic?.trim().toLowerCase();
		const chanFilter = normalizeChannel(opts.channel) ?? normalizeChannel(opts.board);

		const collectMatching = (): { matching: BoardPost[]; allPosts: BoardPost[]; cursor: number; topics: BoardTopicSummary[] } => {
			const allPosts = this.allRunPosts(runId, chanFilter);
			const matching = allPosts.filter((p) => {
				if (isHiddenPost(p)) return false;
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
				if (ev.type !== "board.posted" && ev.type !== "board.labeled" && ev.type !== "board.edited") return;
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
			.filter((p) => !isHiddenPost(p))
			.reverse()
			.slice(0, limit);
	}
}

export interface BoardToolsOptions {
	/** Resolve an OS-assigned readable handle for an agentId (e.g. "peer-1"). */
	resolveHandle?: (agentId: string) => string | undefined;
	/** Resolve the subtree root ID for an agentId (enables `#team-<subtree>` channel defaults). */
	resolveSubtree?: (agentId: string) => string | undefined;
	/** Explicit default channel ("swarm" or "team-<subtree>"). */
	defaultChannel?: string;
	/** Legacy default visibility fallback. */
	defaultVisibility?: BoardVisibility;
}

function renderPostEntry(post: BoardPost, query: string, citations: number, bodyLimit = 480): string {
	const who = post.authorHandle ?? post.authorAgentId;
	const chan = `#${postChannel(post)}`;
	const threadStr = post.threadId ? `, thread=${post.threadId}` : "";
	const quoteStr = post.quotedPostId ? `, quotes=${post.quotedPostId}` : "";
	const outdatedStr = post.outdated
		? `, OUTDATED(${post.outdatedReason ?? "superseded"})`
		: post.supersededBy
			? `, SUPERSEDED_BY=${post.supersededBy}`
			: "";
	const excerpt = searchExcerptDetailed(post.body, query, bodyLimit);
	const truncHint = excerpt.truncated
		? `\n[truncated: ${excerpt.totalChars} chars — call board_visit("${post.id}") for full body]`
		: "";
	const summaryLine = post.summary && post.body !== post.summary ? `Title: ${post.summary}\n` : "";
	return `[${post.id}] (${chan} · ${post.topic}, by ${who}, seq=${postSeq(post)}, citations=${citations}${formatLabels(post.labels)}${threadStr}${quoteStr}${outdatedStr})\n${summaryLine}${excerpt.text}${truncHint}`;
}

/**
 * 5 ultra-simple Reddit/X-native Swarm Board tools:
 * - `board_post` (new post, threaded `reply_to`, or `quote_post_id` crosspost)
 * - `board_edit` (update text or mark `outdated: true`)
 * - `board_search` (ranked search/listing; hides outdated posts by default)
 * - `board_visit` (full post, replies, and quoting backlinks)
 * - `board_wait` (event-driven reactive wait)
 */
export function boardTools(board: BoardService, opts: BoardToolsOptions = {}): ToolDefinition[] {
	return [
		{
			name: "board_post",
			description:
				"Post to a swarm board channel (#swarm for global, #team-<name> for local). Pass reply_to to comment in a thread, or quote_post_id (with channel='swarm') to quote/crosspost a verified discovery.",
			inputSchema: {
				type: "object",
				properties: {
					text: { type: "string", description: "Post body text (concise findings, evidence, blockers, or reply)" },
					title: { type: "string", description: "Optional 1-line title / summary" },
					channel: { type: "string", description: "Optional channel name (e.g. 'swarm' or 'team-<subtree>')" },
					topic: { type: "string", description: "Optional short topic tag (e.g. 'contracts', 'dead-end', 'speedup')" },
					reply_to: { type: "string", description: "Optional post ID to reply to in its thread" },
					quote_post_id: { type: "string", description: "Optional post ID to quote or crosspost into another channel (e.g. channel='swarm')" },
					artifact_ids: { type: "array", items: { type: "string" }, description: "Optional artifact IDs" },
				},
				required: ["text"],
			},
			execute(args, ctx) {
				const text = typeof args.text === "string" ? args.text.trim() : "";
				if (!text) {
					return { text: "board_post rejected: text is required.", isError: true };
				}
				const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
				const channel = typeof args.channel === "string" ? normalizeChannel(args.channel) : undefined;
				const topic = typeof args.topic === "string" && args.topic.trim() ? args.topic.trim() : "";
				const replyToId = typeof args.reply_to === "string" && args.reply_to.trim() ? args.reply_to.trim() : undefined;
				const quotedPostId = typeof args.quote_post_id === "string" && args.quote_post_id.trim() ? args.quote_post_id.trim() : undefined;
				const artifactIds = Array.isArray(args.artifact_ids)
					? args.artifact_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
					: undefined;
				const subtreeId = opts.resolveSubtree?.(ctx.agentId);
				const effectiveChannel =
					channel ??
					(replyToId || quotedPostId
						? undefined
						: opts.defaultChannel ??
							(opts.defaultVisibility === "global"
								? DEFAULT_CHANNEL
								: subtreeId && ctx.role === "worker"
									? `team-${subtreeId}`
									: DEFAULT_CHANNEL));

				// Check non-blocking stale-thread hint before posting a reply
				let staleHint = "";
				if (replyToId) {
					const tv = board.thread(replyToId, { latest: 50 });
					if (tv && tv.newestId !== replyToId) {
						const idx = tv.replies.findIndex((r) => r.id === replyToId);
						const newer = idx >= 0 ? tv.replies.length - 1 - idx : tv.replies.length;
						if (newer > 0) {
							staleHint = ` Note: ${newer} newer repl${newer === 1 ? "y" : "ies"} arrived in this thread (newest=${tv.newestId}).`;
						}
					}
				}

				try {
					const post = board.publish({
						runId: ctx.runId,
						authorAgentId: ctx.agentId,
						authorHandle: opts.resolveHandle?.(ctx.agentId),
						channel: effectiveChannel,
						topic,
						subtreeId,
						visibility: effectiveChannel ? (effectiveChannel === DEFAULT_CHANNEL ? "global" : "subtree") : opts.defaultVisibility,
						summary: deriveSummary(title, text),
						body: text,
						replyToId,
						quotedPostId,
						artifactIds,
						isOsActor: false,
					});
					const pulse = board.digest(ctx.runId, { channel: postChannel(post), subtreeId });
					const threadSuffix = post.threadId ? `, thread=${post.threadId}` : "";
					const quoteSuffix = post.quotedPostId ? `, quotes=${post.quotedPostId}` : "";
					return {
						text: `Posted ${post.id} in #${postChannel(post)} (topic=${post.topic}, seq=${postSeq(post)}${threadSuffix}${quoteSuffix}).${staleHint} ${pulse}`,
						data: { postId: post.id, channel: postChannel(post), seq: postSeq(post), threadId: post.threadId },
					};
				} catch (error) {
					if (error instanceof BoardError) {
						return {
							text: `board_post rejected (${error.code}): ${error.message}`,
							isError: true,
							data: { code: error.code, ...(error.data ?? {}) },
						};
					}
					return {
						text: `board_post error: ${error instanceof Error ? error.message : String(error)}`,
						isError: true,
					};
				}
			},
		},
		{
			name: "board_edit",
			description: "Edit one of your posts or mark an obsolete/debunked post outdated=true so default searches hide it.",
			inputSchema: {
				type: "object",
				properties: {
					post_id: { type: "string", description: "Post ID to edit or mark outdated" },
					text: { type: "string", description: "Optional updated body text" },
					outdated: { type: "boolean", description: "Set true to mark this post outdated/debunked" },
					reason: { type: "string", description: "Optional short reason when marking outdated" },
				},
				required: ["post_id"],
			},
			execute(args, ctx) {
				const postId = typeof args.post_id === "string" ? args.post_id.trim() : "";
				if (!postId) return { text: "board_edit rejected: post_id is required.", isError: true };
				if (!board.edit) return { text: "board_edit is not supported by this board service.", isError: true };
				const isPlannerOrOs = ctx.role === "planner" || ctx.role === "root" || ctx.role === "integrator";
				try {
					const updated = board.edit({
						postId,
						authorAgentId: ctx.agentId,
						isPlannerOrOs,
						body: typeof args.text === "string" ? args.text : undefined,
						outdated: args.outdated === true ? true : undefined,
						outdatedReason: typeof args.reason === "string" ? args.reason : undefined,
					});
					const tag = updated.outdated ? `marked outdated (${updated.outdatedReason})` : "updated";
					return {
						text: `Post ${updated.id} ${tag}.`,
						data: { postId: updated.id, outdated: Boolean(updated.outdated), editedAt: updated.editedAt },
					};
				} catch (error) {
					if (error instanceof BoardError) {
						return {
							text: `board_edit rejected (${error.code}): ${error.message}`,
							isError: true,
							data: { code: error.code, ...(error.data ?? {}) },
						};
					}
					return {
						text: `board_edit error: ${error instanceof Error ? error.message : String(error)}`,
						isError: true,
					};
				}
			},
		},
		{
			name: "board_search",
			description: "Search or list posts on the board (hides outdated posts by default). Omit query to list latest posts.",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "Optional keywords (omit or empty to list latest posts)" },
					channel: { type: "string", description: "Optional channel filter (e.g. 'swarm' or 'team-<name>')" },
					topic: { type: "string", description: "Optional exact topic filter" },
					after: { type: "number", minimum: 0, description: "Optional cursor: only return posts with seq > after" },
					k: { type: "number", minimum: 1, maximum: 15, description: "Max results (default 8)" },
					offset: { type: "number", minimum: 0, description: "Pagination offset (default 0)" },
					include_outdated: { type: "boolean", description: "Include outdated/superseded posts (default false)" },
				},
			},
			execute(args, ctx) {
				const query = typeof args.query === "string" ? args.query : "";
				const channel = typeof args.channel === "string" ? normalizeChannel(args.channel) : undefined;
				const topic = typeof args.topic === "string" && args.topic.trim() ? args.topic.trim() : undefined;
				const afterSeq = typeof args.after === "number" && Number.isFinite(args.after) ? Math.floor(args.after) : undefined;
				const k = typeof args.k === "number" && Number.isFinite(args.k) ? Math.max(1, Math.min(15, Math.floor(args.k))) : 8;
				const offset = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
				const includeOutdated = args.include_outdated === true;

				const res = board.query(ctx.runId, {
					query,
					channel,
					topic,
					afterSeq,
					k,
					offset,
					includeOutdated,
				});
				const topicList = formatTopics(res.topics);
				if (!res.hits.length) {
					const hint = res.topics.length ? ` — retry with query="" or topic="${res.topics[0]!.topic}"` : "";
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
			name: "board_visit",
			description: "Read the full untruncated body, thread replies, and quoting/citing backlinks of one post by ID.",
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
				const chan = `#${postChannel(res.post)}`;
				const statusBanner = res.post.outdated
					? `\n[OUTDATED: ${res.post.outdatedReason ?? "superseded"}]`
					: res.post.supersededBy
						? `\n[SUPERSEDED BY ${res.post.supersededBy}]`
						: "";
				const quoted = res.post.quotedPostId ? `\nQuotes: ${res.post.quotedPostId}` : "";
				const artifacts = res.post.artifactIds?.length ? `\nArtifacts: ${res.post.artifactIds.join(", ")}` : "";
				const backlinks = res.citedBy.length
					? `\nQuoted/cited by: ${res.citedBy.map((p) => `${p.id} (${p.authorHandle ?? p.authorAgentId} in #${postChannel(p)})`).join(", ")}`
					: "";
				const repliesBlock = res.replies?.length
					? `\n\nReplies (${res.replies.length}, newest_id=${res.newestId}):\n` +
						res.replies
							.map((r) => `- [${r.id}] by ${r.authorHandle ?? r.authorAgentId} (seq=${postSeq(r)}): ${r.body}`)
							.join("\n")
					: "";
				const summaryLine = res.post.summary && res.post.body !== res.post.summary ? `\nTitle: ${res.post.summary}` : "";
				return {
					text: `[${res.post.id}] ${chan} · ${res.post.topic} (by ${who}, seq=${postSeq(res.post)}${formatLabels(res.post.labels)}, cursor=${res.cursor ?? 0})${statusBanner}${summaryLine}\n${res.post.body}${quoted}${artifacts}${backlinks}${repliesBlock}`,
					data: { postId: res.post.id, channel: postChannel(res.post), newestId: res.newestId, cursor: res.cursor },
				};
			},
		},
		{
			name: "board_wait",
			description: "Wait reactively (up to 25s, zero polling) until matching peer posts appear on the board.",
			inputSchema: {
				type: "object",
				properties: {
					channel: { type: "string", description: "Optional channel filter (e.g. 'swarm' or 'team-<name>')" },
					topic: { type: "string", description: "Optional exact topic filter" },
					after: { type: "number", minimum: 0, description: "Optional cursor: only match posts with seq > after" },
					min_posts: { type: "number", minimum: 1, maximum: 32, description: "Wait until at least N matching posts exist (default 1)" },
					timeout_seconds: { type: "number", minimum: 1, maximum: 25, description: "Max seconds to wait (1..25, default 20)" },
				},
			},
			async execute(args, ctx) {
				const channel = typeof args.channel === "string" ? normalizeChannel(args.channel) : undefined;
				const topic = typeof args.topic === "string" && args.topic.trim() ? args.topic.trim() : undefined;
				const afterSeq = typeof args.after === "number" && Number.isFinite(args.after) ? Math.floor(args.after) : undefined;
				const minPosts = typeof args.min_posts === "number" && Number.isFinite(args.min_posts)
					? Math.max(1, Math.min(32, Math.floor(args.min_posts)))
					: 1;
				const timeoutSeconds = typeof args.timeout_seconds === "number" && Number.isFinite(args.timeout_seconds)
					? Math.max(1, Math.min(25, args.timeout_seconds))
					: 20;

				const res = await board.wait(ctx.runId, {
					channel,
					topic,
					afterSeq,
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
