import type { BoardPost, BoardSearchHit } from "@one-piece/core";

export function tokenizeBoardText(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function isPrefixMatch(token: string, term: string): boolean {
	if (token.length < 3 || term.length < 3) return false;
	return token.startsWith(term) || term.startsWith(token);
}

export interface SearchExcerptResult {
	text: string;
	truncated: boolean;
	totalChars: number;
}

export function searchExcerptDetailed(body: string, query: string, limit = 480): SearchExcerptResult {
	const totalChars = body.length;
	if (totalChars <= limit) return { text: body, truncated: false, totalChars };
	const terms = tokenizeBoardText(query);
	const termSet = new Set(terms);
	let start = 0;
	if (terms.length > 0) {
		let fallbackStart = -1;
		for (const word of body.matchAll(/[\p{L}\p{N}]+/gu)) {
			const lower = word[0].toLowerCase();
			if (termSet.has(lower)) {
				start = Math.min(totalChars - limit, Math.max(0, (word.index ?? 0) - 60));
				fallbackStart = -2;
				break;
			}
			if (fallbackStart === -1 && terms.some((t) => isPrefixMatch(lower, t))) {
				fallbackStart = Math.min(totalChars - limit, Math.max(0, (word.index ?? 0) - 60));
			}
		}
		if (fallbackStart >= 0) start = fallbackStart;
	}
	const end = start + limit;
	return {
		text: `${start ? "…" : ""}${body.slice(start, end)}${end < totalChars ? "…" : ""}`,
		truncated: true,
		totalChars,
	};
}

export function searchExcerpt(body: string, query: string, limit = 360): string {
	return searchExcerptDetailed(body, query, limit).text;
}

/**
 * Count distinct peer authors citing each post (self-citations and duplicate peer citations
 * never inflate citation counts).
 */
export function computeCitationCounts(allPosts: readonly BoardPost[]): Map<string, number> {
	const byId = new Map(allPosts.map((p) => [p.id, p]));
	const peers = new Map<string, Set<string>>();
	for (const post of allPosts) {
		for (const ref of post.references ?? []) {
			const target = byId.get(ref.postId);
			if (!target || target.authorAgentId === post.authorAgentId) continue;
			let set = peers.get(target.id);
			if (!set) {
				set = new Set<string>();
				peers.set(target.id, set);
			}
			set.add(post.authorAgentId);
		}
	}
	const out = new Map<string, number>();
	for (const [id, set] of peers) out.set(id, set.size);
	return out;
}

function postOrderKey(post: BoardPost): number {
	return post.seq ?? post.createdAt;
}

export interface RankedBoardResult {
	hits: BoardSearchHit[];
	totalMatches: number;
}

/**
 * ScaleMAS-inspired bounded search with prefix/stem fallback, real citation counts on all
 * queries (including empty queries), supersede down-ranking, and offset pagination.
 */
export function rankedBoardPostsDetailed(
	posts: readonly BoardPost[],
	allPostsForCitations: readonly BoardPost[],
	query: string,
	opts: { limit?: number; offset?: number } = {},
): RankedBoardResult {
	const limit = Math.max(1, Math.floor(opts.limit ?? 8));
	const offset = Math.max(0, Math.floor(opts.offset ?? 0));
	const citationMap = computeCitationCounts(allPostsForCitations);
	const terms = [...new Set(tokenizeBoardText(query))];

	if (!terms.length) {
		const ordered = [...posts]
			.map((post) => {
				const citations = citationMap.get(post.id) ?? 0;
				const penalty = post.supersededBy ? 0.25 : 1;
				const score = ((0.5 * citations) / (citations + 1)) * penalty;
				return { post, score, citations };
			})
			.sort((a, b) => postOrderKey(b.post) - postOrderKey(a.post) || b.post.createdAt - a.post.createdAt);
		return {
			hits: ordered.slice(offset, offset + limit),
			totalMatches: ordered.length,
		};
	}

	const termSet = new Set(terms);
	const frequency = new Map<string, number>();
	const documents = posts.map((post) => {
		const counts = new Map<string, number>();
		const labelText = post.labels
			? Object.entries(post.labels)
				.map(([k, v]) => `${k} ${v}`)
				.join(" ")
			: "";
		const tokens = tokenizeBoardText(`${post.topic} ${post.summary} ${post.body} ${labelText}`);
		for (const token of tokens) {
			if (termSet.has(token)) {
				counts.set(token, (counts.get(token) ?? 0) + 1);
				continue;
			}
			for (const term of terms) {
				if (isPrefixMatch(token, term)) {
					counts.set(term, (counts.get(term) ?? 0) + 0.6);
				}
			}
		}
		for (const term of counts.keys()) frequency.set(term, (frequency.get(term) ?? 0) + 1);
		return { post, counts, length: tokens.length };
	});

	const average = documents.reduce((sum, doc) => sum + doc.length, 0) / (documents.length || 1);
	const matches = documents
		.filter(({ counts }) => counts.size > 0)
		.map(({ post, counts, length }) => {
			const lengthPenalty = 1.2 * (0.25 + (0.75 * length) / (average || 1));
			let relevance = 0;
			for (const [term, count] of counts) {
				const df = frequency.get(term)!;
				const idf = Math.log1p((documents.length - df + 0.5) / (df + 0.5));
				relevance += (idf * (count * 2.2)) / (count + lengthPenalty);
			}
			return { post, relevance, citations: citationMap.get(post.id) ?? 0, score: 0 };
		});

	if (!matches.length) return { hits: [], totalMatches: 0 };

	const bestRelevance = matches.reduce((best, m) => Math.max(best, m.relevance), 0) || 1;
	for (const match of matches) {
		const rawScore = match.relevance / bestRelevance + (0.5 * match.citations) / (match.citations + 1);
		match.score = match.post.supersededBy ? rawScore * 0.25 : rawScore;
	}

	matches.sort((a, b) => b.score - a.score || postOrderKey(b.post) - postOrderKey(a.post));
	return {
		hits: matches.slice(offset, offset + limit).map(({ post, score, citations }) => ({ post, score, citations })),
		totalMatches: matches.length,
	};
}

/** Backwards-compatible bounded BM25 x distinct-peer citation search. */
export function rankedBoardPosts(
	posts: BoardPost[],
	query: string,
	limit = 5,
): BoardSearchHit[] {
	return rankedBoardPostsDetailed(posts, posts, query, { limit, offset: 0 }).hits;
}
