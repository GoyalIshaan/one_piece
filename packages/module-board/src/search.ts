import type { BoardPost } from "@one-piece/core";

function words(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function searchExcerpt(body: string, query: string, limit = 360): string {
	if (body.length <= limit) return body;
	const terms = new Set(words(query));
	let start = 0;
	for (const word of body.matchAll(/[\p{L}\p{N}]+/gu)) {
		if (!terms.has(word[0].toLowerCase())) continue;
		start = Math.min(body.length - limit, Math.max(0, (word.index ?? 0) - 60));
		break;
	}
	const end = start + limit;
	return `${start ? "…" : ""}${body.slice(start, end)}${end < body.length ? "…" : ""}`;
}

/**
 * ScaleMAS-inspired bounded search: BM25 relevance combined with a bounded boost
 * from distinct citing peers (self-citations and duplicate peer citations do not inflate rank).
 */
export function rankedBoardPosts(
	posts: BoardPost[],
	query: string,
	limit = 5,
): Array<{ post: BoardPost; score: number; citations: number }> {
	const terms = new Set(words(query));
	if (!terms.size) {
		return [...posts]
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, limit)
			.map((post) => ({ post, score: 0, citations: 0 }));
	}
	const frequency = new Map<string, number>();
	const documents = posts.map((post) => {
		const counts = new Map<string, number>();
		const tokens = words(`${post.topic} ${post.summary} ${post.body}`);
		for (const token of tokens) {
			if (terms.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
		}
		for (const token of counts.keys()) frequency.set(token, (frequency.get(token) ?? 0) + 1);
		return { post, counts, length: tokens.length };
	});
	const average = documents.reduce((sum, doc) => sum + doc.length, 0) / (documents.length || 1);
	const matches = documents
		.filter(({ counts }) => counts.size > 0)
		.map(({ post, counts, length }) => {
			const lengthPenalty = 1.2 * (0.25 + (0.75 * length) / average);
			let relevance = 0;
			for (const [token, count] of counts) {
				const df = frequency.get(token)!;
				const idf = Math.log1p((documents.length - df + 0.5) / (df + 0.5));
				relevance += (idf * (count * 2.2)) / (count + lengthPenalty);
			}
			return { post, relevance, citations: 0, score: 0 };
		});
	if (!matches.length) return [];

	const targets = new Map(matches.map(({ post }) => [post.id, post]));
	const peers = new Map<string, Set<string>>();
	for (const post of posts) {
		for (const ref of post.references ?? []) {
			const target = targets.get(ref.postId);
			if (!target || target.authorAgentId === post.authorAgentId) continue;
			if (!peers.has(target.id)) peers.set(target.id, new Set());
			peers.get(target.id)!.add(post.authorAgentId);
		}
	}
	const bestRelevance = matches.reduce((best, m) => Math.max(best, m.relevance), 0) || 1;
	for (const match of matches) {
		match.citations = peers.get(match.post.id)?.size ?? 0;
		match.score = match.relevance / bestRelevance + (0.5 * match.citations) / (match.citations + 1);
	}
	return matches
		.sort((a, b) => b.score - a.score || b.post.createdAt - a.post.createdAt)
		.slice(0, limit)
		.map(({ post, score, citations }) => ({ post, score, citations }));
}
