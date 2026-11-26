// Provider-agnostic System-1 calibrated decision model contracts (zero SDK imports in core).

export type DecisionQuestion =
	| {
		readonly type: "noul";
		readonly instructions: string;
	}
	| {
		readonly type: "choice";
		readonly instructions: string;
		/** Map of discrete option keys -> crisp descriptions (up to 255 options). */
		readonly criteria: Record<string, string>;
	}
	| {
		readonly type: "score";
		readonly instructions: string;
		/** Linearly ordered rubric level descriptions (index 0 .. k-1). */
		readonly criteria: readonly string[];
	};

export type DecisionAnswer =
	| {
		readonly type: "noul";
		/** Calibrated probability P(yes) in [0, 1]. */
		readonly noul: number;
		/** Calibrated confidence in [0, 1] (derived as |2*p - 1| if provider omits it). */
		readonly confidence: number;
	}
	| {
		readonly type: "choice";
		readonly choice: string;
		readonly confidence: number;
		readonly probabilities: Record<string, number>;
	}
	| {
		readonly type: "score";
		/** Probability-weighted expected rubric score over level indices. */
		readonly score: number;
		readonly confidence: number;
		readonly legend: Record<string, string>;
		readonly probabilities: Record<string, number>;
	};

export interface DecisionRequest {
	/** Shared state evaluated once across all questions in a single forward pass. */
	readonly state: string | Record<string, unknown>;
	/** Named closed-set questions evaluated in parallel over `state`. */
	readonly questions: Record<string, DecisionQuestion>;
	/** Enable provider long-context mode (e.g., up to 262k tokens on TypeSafe Jev). */
	readonly longContext?: boolean;
	readonly signal?: AbortSignal;
}

export interface DecisionResponse {
	readonly answers: Record<string, DecisionAnswer>;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly latencyMs: number;
	readonly provider: string;
	readonly model: string;
}

export interface DecisionModelClient {
	readonly provider: string;
	readonly model: string;
	decide(req: DecisionRequest): Promise<DecisionResponse>;
}

export function getNoulAnswer(
	answers: Record<string, DecisionAnswer>,
	key: string,
): { p: number; confidence: number } | undefined {
	const ans = answers[key];
	if (!ans || ans.type !== "noul") return undefined;
	return { p: ans.noul, confidence: ans.confidence };
}

export function getChoiceAnswer(
	answers: Record<string, DecisionAnswer>,
	key: string,
): { choice: string; confidence: number; probabilities: Record<string, number> } | undefined {
	const ans = answers[key];
	if (!ans || ans.type !== "choice") return undefined;
	return { choice: ans.choice, confidence: ans.confidence, probabilities: ans.probabilities };
}

export function getScoreAnswer(
	answers: Record<string, DecisionAnswer>,
	key: string,
): { score: number; confidence: number; legend: Record<string, string>; probabilities: Record<string, number> } | undefined {
	const ans = answers[key];
	if (!ans || ans.type !== "score") return undefined;
	return { score: ans.score, confidence: ans.confidence, legend: ans.legend, probabilities: ans.probabilities };
}
