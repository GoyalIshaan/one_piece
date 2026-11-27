import {
	type BoardPost,
	type BoardService,
	type DecisionModelClient,
	type DecisionQuestion,
	type EventBus,
	type Exclusive,
	getNoulAnswer,
} from "@one-piece/core";

interface TriageScores {
	readonly postId: string;
	readonly isNovel: number;
	readonly contradictsIncumbent: number;
	readonly broadcastProb: number;
	readonly crossoverProb: number;
	readonly confidence: number;
}

/**
 * Exhaustive Board v2 triage evaluation:
 * - Promoted posts ALWAYS carry `visibility: "global"` and a concrete `promotionReason`.
 * - Non-promoted posts ALWAYS remain `visibility: "subtree"` and never leak a promotion reason.
 */
export type TriageEvaluation = TriageScores & Exclusive<
	| { readonly promoted: true; readonly visibility: "global"; readonly promotionReason: string }
	| { readonly promoted: false; readonly visibility: "subtree" }
>;

export interface BoardTriageOptions {
	readonly runId: string;
	readonly board: BoardService;
	readonly bus: EventBus;
	readonly decisionClient?: DecisionModelClient;
	/** Minimum calibrated P(worth_broadcasting_globally) to promote a subtree post (default 0.72). */
	readonly broadcastThreshold?: number;
	/** Minimum confidence required before auto-promoting (default 0.55). */
	readonly minConfidence?: number;
	/** Minimum P(worth_crossover) to tag post as a crossover candidate (default 0.65). */
	readonly crossoverThreshold?: number;
}

/**
 * Decision-Model-Powered Board Triage & Interestingness Promotion Service.
 * Evaluates newly published `subtree`-scoped epistemic claims in a single batched System-1 pass
 * (~200ms, 0 output tokens) and automatically promotes genuinely novel / cross-branch discoveries
 * to `visibility: "global"` with calibrated OS curation labels (`os:promoted`, `os:novelty`,
 * `os:crossover_candidate`). Falls back cleanly to deterministic claim-kind heuristics when offline.
 */
export class BoardTriageService {
	private readonly runId: string;
	private readonly board: BoardService;
	private readonly bus: EventBus;
	private readonly decisionClient?: DecisionModelClient;
	private readonly broadcastThreshold: number;
	private readonly minConfidence: number;
	private readonly crossoverThreshold: number;
	private readonly evaluated = new Set<string>();

	constructor(opts: BoardTriageOptions) {
		this.runId = opts.runId;
		this.board = opts.board;
		this.bus = opts.bus;
		this.decisionClient = opts.decisionClient;
		this.broadcastThreshold = opts.broadcastThreshold ?? 0.72;
		this.minConfidence = opts.minConfidence ?? 0.55;
		this.crossoverThreshold = opts.crossoverThreshold ?? 0.65;
	}

	/**
	 * Score a batch of untriaged `subtree` posts (or explicit post IDs) in one forward pass,
	 * stamping OS novelty/crossover labels and promoting high-signal discoveries to global visibility.
	 */
	async triagePosts(
		opts: {
			goal?: string;
			incumbentSummary?: string;
			postIds?: readonly string[];
			signal?: AbortSignal;
		} = {},
	): Promise<TriageEvaluation[]> {
		const candidates: BoardPost[] = opts.postIds?.length
			? opts.postIds
				.map((id) => this.bus.store.get("posts", id))
				.filter((p): p is BoardPost => Boolean(p && p.runId === this.runId && !p.supersededBy))
			: this.board
				.query(this.runId, { visibility: "subtree", k: 15 })
				.hits.map((h) => h.post)
				.filter((p) => !this.evaluated.has(p.id) && p.labels?.["os:promoted"] !== "true");

		if (!candidates.length) return [];

		const recentGlobals = this.board
			.query(this.runId, { visibility: "global", k: 8 })
			.hits.map((h) => `[${h.post.id} ${h.post.topic}${h.post.kind ? `/${h.post.kind}` : ""}] ${h.post.summary}`)
			.join("\n");

		if (!this.decisionClient) {
			return candidates.map((post) => this.heuristicTriage(post));
		}

		const batch = candidates.slice(0, 12);
		const stateLines = [
			opts.goal ? `Goal: ${opts.goal}` : "",
			opts.incumbentSummary ? `Current Best Incumbent: ${opts.incumbentSummary}` : "",
			recentGlobals ? `Existing Global Board Posts:\n${recentGlobals}` : "Existing Global Board Posts: (none)",
			"",
			"Candidate Subtree Posts To Triage:",
			...batch.map(
				(p, i) =>
					`POST_${i} [id=${p.id}, topic=${p.topic}, kind=${p.kind ?? "update"}, subtree=${p.subtreeId ?? "unknown"}]: ${p.summary}\n${p.body.slice(0, 600)}`,
			),
		].filter(Boolean).join("\n");

		const questions: Record<string, DecisionQuestion> = {};
		for (let i = 0; i < batch.length; i++) {
			questions[`p${i}_novel`] = {
				type: "noul",
				instructions: `Does POST_${i} report a genuinely novel discovery, invariant, failure mode, or optimization not already covered by Existing Global Board Posts?`,
			};
			questions[`p${i}_contradict`] = {
				type: "noul",
				instructions: `Does POST_${i} contradict, falsify, or reveal a flaw in the Current Best Incumbent or prior assumptions?`,
			};
			questions[`p${i}_broadcast`] = {
				type: "noul",
				instructions: `Would independent Planners working in other subtrees benefit immediately from seeing POST_${i} promoted globally?`,
			};
			questions[`p${i}_crossover`] = {
				type: "noul",
				instructions: `Does POST_${i} contain a concrete technique or partial insight worth combining via crossover with the Current Best Incumbent?`,
			};
		}

		try {
			const res = await this.decisionClient.decide({
				state: stateLines,
				questions,
				signal: opts.signal,
			});
			this.bus.emit(this.runId, "decision.evaluated", {
				purpose: "board_triage",
				provider: res.provider,
				model: res.model,
				questionCount: Object.keys(questions).length,
				inputTokens: res.inputTokens,
				latencyMs: res.latencyMs,
			});

			const out: TriageEvaluation[] = [];
			for (let i = 0; i < batch.length; i++) {
				const post = batch[i]!;
				this.evaluated.add(post.id);
				const novel = getNoulAnswer(res.answers, `p${i}_novel`) ?? { p: 0.5, confidence: 0 };
				const contradict = getNoulAnswer(res.answers, `p${i}_contradict`) ?? { p: 0.5, confidence: 0 };
				const broadcast = getNoulAnswer(res.answers, `p${i}_broadcast`) ?? { p: 0.5, confidence: 0 };
				const crossover = getNoulAnswer(res.answers, `p${i}_crossover`) ?? { p: 0.5, confidence: 0 };

				const shouldPromote =
					(broadcast.p >= this.broadcastThreshold && broadcast.confidence >= this.minConfidence) ||
					(contradict.p >= 0.80 && contradict.confidence >= this.minConfidence);

				const labels: Record<string, string> = {
					"os:novelty": novel.p.toFixed(3),
					"os:broadcast_prob": broadcast.p.toFixed(3),
					"os:crossover_prob": crossover.p.toFixed(3),
				};
				if (crossover.p >= this.crossoverThreshold) {
					labels["os:crossover_candidate"] = "true";
				}

				const promotionReason = `Jev triage: broadcast=${broadcast.p.toFixed(2)}, novelty=${novel.p.toFixed(2)}, contradict=${contradict.p.toFixed(2)}`;
				if (shouldPromote && this.board.promote) {
					this.board.promote(post.id, {
						actorId: "triage-service",
						labels,
						reason: promotionReason,
					});
				} else {
					try {
						this.board.label(post.id, { set: labels, actorId: "triage-service", isOsActor: true });
					} catch {
						// Non-fatal if post vanished.
					}
				}

				const scores: TriageScores = {
					postId: post.id,
					isNovel: novel.p,
					contradictsIncumbent: contradict.p,
					broadcastProb: broadcast.p,
					crossoverProb: crossover.p,
					confidence: broadcast.confidence,
				};
				out.push(
					shouldPromote
						? { ...scores, promoted: true, visibility: "global", promotionReason }
						: { ...scores, promoted: false, visibility: "subtree" },
				);
			}
			return out;
		} catch {
			return batch.map((post) => this.heuristicTriage(post));
		}
	}

	private heuristicTriage(post: BoardPost): TriageEvaluation {
		this.evaluated.add(post.id);
		const highSignalKind = post.kind === "counterexample" || post.kind === "bound_estimate" || post.kind === "discovery";
		const hasRefs = Boolean(post.references && post.references.length > 0);
		const promoted = highSignalKind || post.labels?.["os:verified"] === "true";
		const broadcastProb = promoted ? 0.8 : hasRefs ? 0.55 : 0.35;
		const novelty = highSignalKind ? 0.75 : 0.45;
		const crossoverProb = post.kind === "discovery" ? 0.7 : 0.3;

		const labels: Record<string, string> = {
			"os:novelty": novelty.toFixed(3),
			"os:broadcast_prob": broadcastProb.toFixed(3),
			"os:crossover_prob": crossoverProb.toFixed(3),
		};
		const promotionReason = `Heuristic promotion (kind=${post.kind ?? "update"})`;
		if (promoted && this.board.promote) {
			this.board.promote(post.id, {
				actorId: "triage-service",
				labels,
				reason: promotionReason,
			});
		}
		const scores: TriageScores = {
			postId: post.id,
			isNovel: novelty,
			contradictsIncumbent: post.kind === "counterexample" ? 0.85 : 0.2,
			broadcastProb,
			crossoverProb,
			confidence: 0.6,
		};
		return promoted
			? { ...scores, promoted: true, visibility: "global", promotionReason }
			: { ...scores, promoted: false, visibility: "subtree" };
	}
}
