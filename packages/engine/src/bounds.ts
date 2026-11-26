import {
	getNoulAnswer,
	type JsonSchema,
	type SwarmOsApi,
} from "@one-piece/core";

export interface TheoreticalBound {
	readonly metricName: string;
	readonly higherIsBetter: boolean;
	readonly estimatedCeiling: number | null;
	readonly derivationSummary: string;
	readonly keyAssumptions: string[];
	/** Fraction of derived ceiling at which to trigger a Researcher Checkpoint (default 0.92). */
	readonly stoppingFraction: number;
	readonly confidence: number;
}

export type CheckpointPolicy = "coalesce" | "interactive";

export interface ResearcherCheckpointReport {
	readonly generation: number;
	readonly trigger: "approaching_bound" | "diminishing_returns" | "decision_model_stop";
	readonly bestScore: number;
	readonly bound?: TheoreticalBound;
	readonly distinctBasins: number;
	readonly summary: string;
}

export type HumanCheckpointDecision =
	| { readonly action: "coalesce" }
	| { readonly action: "continue"; readonly steeringNote?: string; readonly updatedCeiling?: number };

export type HumanCheckpointHandler = (
	report: ResearcherCheckpointReport,
) => HumanCheckpointDecision | Promise<HumanCheckpointDecision>;

export interface CheckpointOutcome {
	readonly shouldStop: boolean;
	readonly trigger?: ResearcherCheckpointReport["trigger"];
	readonly reason: string;
	readonly steeringNote?: string;
}

const BOUND_SCHEMA: JsonSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		metric_name: { type: "string" },
		higher_is_better: { type: "boolean" },
		estimated_ceiling: { type: ["number", "null"] },
		derivation_summary: { type: "string" },
		key_assumptions: { type: "array", items: { type: "string" } },
		stopping_fraction: { type: "number" },
		confidence: { type: "number" },
	},
	required: [
		"metric_name",
		"higher_is_better",
		"estimated_ceiling",
		"derivation_summary",
		"key_assumptions",
		"stopping_fraction",
		"confidence",
	],
};

function parseBoundJson(raw: string): TheoreticalBound | undefined {
	const tryParse = (text: string): TheoreticalBound | undefined => {
		try {
			const obj = JSON.parse(text) as Record<string, unknown>;
			if (typeof obj.metric_name !== "string" || typeof obj.derivation_summary !== "string") return undefined;
			const ceiling = typeof obj.estimated_ceiling === "number" && Number.isFinite(obj.estimated_ceiling)
				? obj.estimated_ceiling
				: null;
			const rawFrac = typeof obj.stopping_fraction === "number" && Number.isFinite(obj.stopping_fraction)
				? obj.stopping_fraction
				: 0.92;
			const stoppingFraction = Math.max(0.5, Math.min(0.995, rawFrac));
			const rawConf = typeof obj.confidence === "number" && Number.isFinite(obj.confidence) ? obj.confidence : 0.6;
			const assumptions = Array.isArray(obj.key_assumptions)
				? obj.key_assumptions.filter((a): a is string => typeof a === "string" && a.trim().length > 0).slice(0, 8)
				: [];
			return {
				metricName: obj.metric_name.trim() || "score",
				higherIsBetter: obj.higher_is_better !== false,
				estimatedCeiling: ceiling,
				derivationSummary: obj.derivation_summary.trim().slice(0, 800),
				keyAssumptions: assumptions,
				stoppingFraction,
				confidence: Math.max(0, Math.min(1, rawConf)),
			};
		} catch {
			return undefined;
		}
	};

	const trimmed = raw.trim();
	const direct = tryParse(trimmed);
	if (direct) return direct;
	for (const m of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
		const parsed = tryParse(m[1]!.trim());
		if (parsed) return parsed;
	}
	const braceMatch = /\{[\s\S]*\}/.exec(trimmed);
	if (braceMatch) return tryParse(braceMatch[0]);
	return undefined;
}

/**
 * Task-agnostic Phase-0 First-Principles Bound Analyst:
 * Inspects the problem statement & workspace (zero hardcoded domain equations) and derives
 * a falsifiable theoretical ceiling + explicit assumptions, publishing it to Board v2.
 */
export async function estimateFirstPrinciplesBound(
	os: SwarmOsApi,
	opts: { goal: string; rubric?: string; signal: AbortSignal; timeoutMs?: number },
): Promise<TheoreticalBound | undefined> {
	if (opts.signal.aborted || os.isInCloseoutReserve()) return undefined;

	const analyst = await os.spawnWorker({
		role: "planner",
		handle: "bound-analyst",
		workspace: os.worktrees.trunkPath,
		readOnly: true,
		canSpawn: false,
		requireOutputSchema: true,
		maxTurns: 2,
		cacheKeyPrefix: `${os.runId}:bound-analyst`,
		toolScope: {
			board: "read",
			artifacts: true,
			findings: false,
			tasks: false,
			nominate: false,
			scheduler: "never",
			skills: false,
			sidekick: false,
		},
		systemPrompt: [
			"You are a first-principles research scientist estimating theoretical upper/lower bounds before an open-ended search.",
			"Reason strictly from the problem specification, codebase, and physical/mathematical/algorithmic laws (for example: compute vs bandwidth limits, algorithmic complexity bounds, or exact spec pass bars).",
			"Return ONLY strict JSON matching the schema. Set `estimated_ceiling` to null if no meaningful numeric bound exists.",
		].join("\n"),
	});

	try {
		const res = await analyst.runTurn(
			[
				`Goal: ${opts.goal}`,
				opts.rubric ? `Rubric: ${opts.rubric}` : "",
				"Inspect the workspace briefly if needed, then derive the theoretical ceiling/bound, explicit assumptions that could be challenged, and a stopping_fraction (e.g. 0.92).",
			].filter(Boolean).join("\n\n"),
			{
				signal: opts.signal,
				outputSchema: BOUND_SCHEMA,
				timeoutMs: opts.timeoutMs ?? 45_000,
			},
		);
		const bound = parseBoundJson(res.finalText);
		if (!bound) return undefined;

		os.bus.emit(os.runId, "bound.estimated", {
			metricName: bound.metricName,
			estimatedCeiling: bound.estimatedCeiling,
			stoppingFraction: bound.stoppingFraction,
			confidence: bound.confidence,
			assumptions: bound.keyAssumptions,
		});

		os.board.publish({
			runId: os.runId,
			authorAgentId: analyst.agent.id,
			authorHandle: "bound-analyst",
			topic: "first-principles-bound",
			kind: "bound_estimate",
			visibility: "global",
			summary: `Derived bound for ${bound.metricName}: ceiling=${bound.estimatedCeiling ?? "qualitative"} (stop@${Math.round(bound.stoppingFraction * 100)}%, conf=${bound.confidence.toFixed(2)})`,
			body: [
				`Derivation: ${bound.derivationSummary}`,
				bound.keyAssumptions.length ? `Key Assumptions:\n${bound.keyAssumptions.map((a) => `- ${a}`).join("\n")}` : "",
			].filter(Boolean).join("\n\n"),
			isOsActor: true,
		});

		return bound;
	} catch {
		return undefined;
	} finally {
		await analyst.close().catch(() => {});
	}
}

/**
 * Evaluate whether an open-ended search has approached its derived theoretical bound or hit
 * genuine diminishing returns, then apply `checkpointPolicy` (default "coalesce"; opt-in "interactive").
 */
export async function evaluateResearcherCheckpoint(
	os: SwarmOsApi,
	opts: {
		goal: string;
		generation: number;
		bestScore: number;
		bound?: TheoreticalBound;
		scoreHistory: readonly number[];
		distinctBasins: number;
		checkpointPolicy?: CheckpointPolicy;
		onHumanCheckpoint?: HumanCheckpointHandler;
		signal?: AbortSignal;
	},
): Promise<CheckpointOutcome> {
	const policy: CheckpointPolicy = opts.checkpointPolicy ?? "coalesce";
	if (!Number.isFinite(opts.bestScore)) {
		return { shouldStop: false, reason: "No verified score yet" };
	}

	let trigger: ResearcherCheckpointReport["trigger"] | undefined;
	let reason = "";

	// 1. Objective gap-to-bound check against derived first-principles ceiling.
	const bound = opts.bound;
	if (bound && bound.estimatedCeiling !== null && bound.estimatedCeiling > 0) {
		const ratio = bound.higherIsBetter
			? opts.bestScore / bound.estimatedCeiling
			: bound.estimatedCeiling / Math.max(1e-9, opts.bestScore);
		if (ratio >= bound.stoppingFraction) {
			trigger = "approaching_bound";
			reason = `Reached ${(ratio * 100).toFixed(1)}% of derived first-principles ceiling (${opts.bestScore.toFixed(4)} vs ${bound.estimatedCeiling.toFixed(4)} ${bound.metricName})`;
		}
	}

	// 2. Calibrated System-1 Decision Model check (when configured and objective bound hasn't already fired).
	if (!trigger && os.decisionClient && opts.scoreHistory.length >= 2) {
		try {
			const state = [
				`Goal: ${opts.goal}`,
				`Generation: ${opts.generation}, Distinct Basins: ${opts.distinctBasins}`,
				`Best Score Trajectory: [${opts.scoreHistory.map((s) => s.toFixed(4)).join(" -> ")}]`,
				bound
					? `Derived Bound: ${bound.metricName} ceiling=${bound.estimatedCeiling ?? "none"} (${bound.derivationSummary})`
					: "Derived Bound: none",
			].join("\n");

			const dec = await os.decisionClient.decide({
				state,
				questions: {
					approaching_bound: {
						type: "noul",
						instructions: "Has the search effectively reached or closely approached its theoretical ceiling?",
					},
					diminishing_returns: {
						type: "noul",
						instructions: "Are recent generations showing severe diminishing returns such that further autonomous iterations are unlikely to yield meaningful gains?",
					},
				},
				signal: opts.signal,
			});

			os.bus.emit(os.runId, "decision.evaluated", {
				purpose: "researcher_checkpoint",
				provider: dec.provider,
				model: dec.model,
				questionCount: 2,
				inputTokens: dec.inputTokens,
				latencyMs: dec.latencyMs,
			});

			const boundAns = getNoulAnswer(dec.answers, "approaching_bound");
			const dimAns = getNoulAnswer(dec.answers, "diminishing_returns");
			if (boundAns && boundAns.p >= 0.80 && boundAns.confidence >= 0.60) {
				trigger = "approaching_bound";
				reason = `Decision model judged search near theoretical ceiling (P=${boundAns.p.toFixed(2)}, conf=${boundAns.confidence.toFixed(2)})`;
			} else if (dimAns && dimAns.p >= 0.82 && dimAns.confidence >= 0.60) {
				trigger = "diminishing_returns";
				reason = `Decision model detected strong diminishing returns (P=${dimAns.p.toFixed(2)}, conf=${dimAns.confidence.toFixed(2)})`;
			}
		} catch {
			// Non-fatal: continue search on decision client error.
		}
	}

	if (!trigger) {
		return { shouldStop: false, reason: "Continuing search" };
	}

	const report: ResearcherCheckpointReport = {
		generation: opts.generation,
		trigger,
		bestScore: opts.bestScore,
		bound,
		distinctBasins: opts.distinctBasins,
		summary: reason,
	};

	if (policy === "interactive" && opts.onHumanCheckpoint) {
		const decision = await opts.onHumanCheckpoint(report);
		os.bus.emit(os.runId, "researcher.checkpoint", {
			policy,
			trigger,
			bestScore: opts.bestScore,
			estimatedCeiling: bound?.estimatedCeiling ?? null,
			action: decision.action,
		});
		if (decision.action === "continue") {
			return {
				shouldStop: false,
				trigger,
				reason: `Human chose to continue${decision.steeringNote ? `: ${decision.steeringNote}` : ""}`,
				steeringNote: decision.steeringNote,
			};
		}
		return { shouldStop: true, trigger, reason: `Human chose to coalesce (${reason})` };
	}

	os.bus.emit(os.runId, "researcher.checkpoint", {
		policy,
		trigger,
		bestScore: opts.bestScore,
		estimatedCeiling: bound?.estimatedCeiling ?? null,
		action: "coalesce",
	});
	return { shouldStop: true, trigger, reason };
}
