import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type BoundOverride,
	type BreakableAssumption,
	clampRooflineBoundEmpirically,
	type Exclusive,
	type ExecutionControlMode,
	getNoulAnswer,
	type JsonSchema,
	type RooflineBoundSnapshot,
	type SwarmOsApi,
} from "@one-piece/core";

export type RooflineBound = RooflineBoundSnapshot;
/** Backward-compatible alias for legacy callers/tests. */
export type TheoreticalBound = RooflineBound;

export type CheckpointPolicy = "coalesce" | "interactive" | "pause" | "notify";

export interface ResearcherCheckpointReport {
	readonly generation: number;
	readonly trigger: "approaching_bound" | "diminishing_returns" | "decision_model_stop" | "paradigm_exhausted";
	readonly bestScore: number;
	readonly bound?: RooflineBound;
	readonly distinctBasins: number;
	readonly summary: string;
	readonly runId?: string;
	readonly bestArtifactPath?: string;
	readonly spentTokens?: number;
	readonly negativeMemory?: readonly string[];
}

export type HumanCheckpointDecision =
	| { readonly action: "coalesce" }
	| { readonly action: "continue"; readonly steeringNote?: string; readonly updatedCeiling?: number; readonly updatedBound?: BoundOverride };

export type HumanCheckpointHandler = (
	report: ResearcherCheckpointReport,
) => HumanCheckpointDecision | Promise<HumanCheckpointDecision>;

export type CheckpointOutcome = Exclusive<
	| {
		readonly action: "continue";
		readonly shouldStop: false;
		readonly reason: string;
		readonly trigger?: ResearcherCheckpointReport["trigger"];
		readonly steeringNote?: string;
		readonly updatedBound?: BoundOverride;
		readonly advisoryBriefPath?: string;
	}
	| {
		readonly action: "paradigm_shift";
		readonly shouldStop: false;
		readonly reason: string;
		readonly targetAssumption: BreakableAssumption;
		readonly directive: string;
		readonly remainingGapToHard: number | null;
	}
	| {
		readonly action: "interrupt_researcher";
		readonly shouldStop: false;
		readonly trigger: ResearcherCheckpointReport["trigger"];
		readonly reason: string;
		readonly briefPath: string;
		readonly pauseRun: boolean;
		readonly steeringNote?: string;
	}
	| {
		readonly action: "coalesce";
		readonly shouldStop: true;
		readonly trigger: ResearcherCheckpointReport["trigger"];
		readonly reason: string;
		readonly briefPath?: string;
	}
>;

const BOUND_SCHEMA: JsonSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		metric_name: { type: "string" },
		higher_is_better: { type: "boolean" },
		hard_ceiling: { type: ["number", "null"] },
		is_proven_hard: { type: "boolean" },
		paradigm_ceiling: { type: ["number", "null"] },
		active_bottleneck: { type: "string" },
		derivation_summary: { type: "string" },
		key_assumptions: { type: "array", items: { type: "string" } },
		breakable_assumptions: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string" },
					assumption: { type: "string" },
					unlock_hint: { type: "string" },
					tier: { type: "string", enum: ["paradigm", "hard"] },
				},
				required: ["id", "assumption", "unlock_hint", "tier"],
			},
		},
		paradigm_shift_fraction: { type: "number" },
		stopping_fraction: { type: "number" },
		confidence: { type: "number" },
	},
	required: [
		"metric_name",
		"higher_is_better",
		"hard_ceiling",
		"is_proven_hard",
		"paradigm_ceiling",
		"active_bottleneck",
		"derivation_summary",
		"key_assumptions",
		"breakable_assumptions",
		"paradigm_shift_fraction",
		"stopping_fraction",
		"confidence",
	],
};

function asFiniteNumberOrNull(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseBoundJson(raw: string, revision = 1): RooflineBound | undefined {
	const tryParse = (text: string): RooflineBound | undefined => {
		try {
			const obj = JSON.parse(text) as Record<string, unknown>;
			if (typeof obj.metric_name !== "string" || typeof obj.derivation_summary !== "string") return undefined;

			// Support both new 2-tier Roofline JSON and legacy single-scalar `estimated_ceiling` JSON.
			const legacyCeiling = asFiniteNumberOrNull(obj.estimated_ceiling);
			const hardCeiling = obj.hard_ceiling !== undefined ? asFiniteNumberOrNull(obj.hard_ceiling) : legacyCeiling;
			const paradigmCeiling = obj.paradigm_ceiling !== undefined ? asFiniteNumberOrNull(obj.paradigm_ceiling) : legacyCeiling;
			const estimatedCeiling = paradigmCeiling ?? hardCeiling;
			const higherIsBetter = obj.higher_is_better !== false;
			const isProvenHard = obj.is_proven_hard === true;

			const rawShift = typeof obj.paradigm_shift_fraction === "number" && Number.isFinite(obj.paradigm_shift_fraction)
				? obj.paradigm_shift_fraction
				: 0.90;
			const paradigmShiftFraction = Math.max(0.5, Math.min(0.99, rawShift));

			const rawStop = typeof obj.stopping_fraction === "number" && Number.isFinite(obj.stopping_fraction)
				? obj.stopping_fraction
				: 0.96;
			const stoppingFraction = Math.max(0.5, Math.min(0.995, rawStop));

			const rawConf = typeof obj.confidence === "number" && Number.isFinite(obj.confidence) ? obj.confidence : 0.65;
			const keyAssumptions = Array.isArray(obj.key_assumptions)
				? obj.key_assumptions.filter((a): a is string => typeof a === "string" && a.trim().length > 0).slice(0, 8)
				: [];

			const breakableAssumptions: BreakableAssumption[] = Array.isArray(obj.breakable_assumptions)
				? obj.breakable_assumptions
					.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"))
					.filter((x) => typeof x.assumption === "string" && x.assumption.trim().length > 0)
					.slice(0, 8)
					.map((x, idx) => ({
						id: typeof x.id === "string" && x.id.trim() ? x.id.trim() : `A${idx + 1}`,
						assumption: String(x.assumption).trim().slice(0, 260),
						unlockHint: typeof x.unlock_hint === "string" && x.unlock_hint.trim()
							? x.unlock_hint.trim().slice(0, 260)
							: "Explore an orthogonal algorithmic structure that bypasses this bottleneck.",
						tier: x.tier === "hard" ? "hard" : "paradigm",
						status: "active",
					}))
				: keyAssumptions.slice(0, 4).map((a, idx) => ({
					id: `A${idx + 1}`,
					assumption: a,
					unlockHint: "Challenge this assumption structurally rather than micro-tuning.",
					tier: "paradigm",
					status: "active",
				}));

			const activeBottleneck = typeof obj.active_bottleneck === "string" && obj.active_bottleneck.trim()
				? obj.active_bottleneck.trim().slice(0, 220)
				: "primary structural bottleneck";

			return {
				metricName: obj.metric_name.trim() || "score",
				higherIsBetter,
				hardCeiling,
				isProvenHard,
				paradigmCeiling,
				estimatedCeiling,
				activeBottleneck,
				derivationSummary: obj.derivation_summary.trim().slice(0, 900),
				keyAssumptions,
				breakableAssumptions,
				paradigmShiftFraction,
				stoppingFraction,
				confidence: Math.max(0, Math.min(1, rawConf)),
				revision,
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

function publishRooflineToBoard(
	os: SwarmOsApi,
	bound: RooflineBound,
	authorAgentId: string,
	prevPostId?: string,
	isRefinement = false,
): string | undefined {
	if (prevPostId && os.board.edit) {
		try {
			os.board.edit({
				postId: prevPostId,
				authorAgentId,
				isPlannerOrOs: true,
				outdated: true,
				outdatedReason: `Superseded by refined Roofline bound rev ${bound.revision}`,
			});
		} catch {
			// Best-effort outdated marking if previous post was already marked outdated.
		}
	}
	try {
		const post = os.board.publish({
			runId: os.runId,
			authorAgentId,
			authorHandle: "bound-analyst",
			channel: "swarm",
			topic: "roofline-bound",
			kind: "bound_estimate",
			visibility: "global",
			references: isRefinement && prevPostId ? [{ postId: prevPostId, reason: "supersedes" }] : undefined,
			summary: `${isRefinement ? "Refined " : ""}Roofline rev ${bound.revision} (${bound.metricName}): Tier-2 Paradigm=${bound.paradigmCeiling ?? "open"}, Tier-1 Hard=${bound.hardCeiling ?? "unbounded"} (${bound.activeBottleneck})`,
			body: [
				`Tier-1 Hard Ceiling (speed-of-light): ${bound.hardCeiling ?? "unbounded"}${bound.isProvenHard ? " [PROVEN]" : ""}`,
				`Tier-2 Paradigm Ceiling (current approach): ${bound.paradigmCeiling ?? "open"}`,
				`Active Bottleneck: ${bound.activeBottleneck}`,
				`Derivation: ${bound.derivationSummary}`,
				bound.breakableAssumptions.length
					? `Breakable Assumptions:\n${bound.breakableAssumptions.map((a) => `- [${a.id} · ${a.tier} · ${a.status}] ${a.assumption} -> Unlock: ${a.unlockHint}`).join("\n")}`
					: "",
			].filter(Boolean).join("\n\n"),
			isOsActor: true,
		});
		return post.id;
	} catch {
		return undefined;
	}
}

/**
 * Task-agnostic Phase-0 First-Principles 2-Tier Roofline Bound Analyst.
 * Runs SERIALLY before initial family seeding so its physical & bottleneck ceilings
 * guide the entire swarm's opening strategy responsibly rather than blind guessing.
 */
export async function estimateFirstPrinciplesBound(
	os: SwarmOsApi,
	opts: { goal: string; rubric?: string; signal: AbortSignal; timeoutMs?: number },
): Promise<RooflineBound | undefined> {
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
			"You are a first-principles research scientist deriving a 2-tier Roofline Limit Ladder BEFORE search begins.",
			"Explicitly separate:",
			"1. `hard_ceiling` (Tier 1): absolute physical, mathematical, or spec speed-of-light roof (set `is_proven_hard: true` ONLY for exact mathematical/spec pass bars like score=1.0 or an exact proven floor).",
			"2. `paradigm_ceiling` (Tier 2): tightest realistic bottleneck-constrained roof under the baseline/current algorithmic paradigm accounting for real constraints (memory gathers/bandwidth, dependency chains, register/slot pressure, I/O, synchronization).",
			"3. `active_bottleneck`: the concrete bottleneck capping Tier 2.",
			"4. `breakable_assumptions`: concrete structural assumptions separating Tier 2 from Tier 1, each with an `unlock_hint` explaining what paradigm shift breaks it.",
			"Return ONLY strict JSON matching the schema. Use null if no meaningful numeric bound exists.",
		].join("\n"),
	});

	try {
		const res = await analyst.runTurn(
			[
				`Goal: ${opts.goal}`,
				opts.rubric ? `Rubric: ${opts.rubric}` : "",
				"Inspect the workspace briefly if needed, then derive the 2-tier Roofline Limit Ladder (`hard_ceiling`, `paradigm_ceiling`, `active_bottleneck`, `breakable_assumptions`, `paradigm_shift_fraction` ~0.90, `stopping_fraction` ~0.96).",
			].filter(Boolean).join("\n\n"),
			{
				signal: opts.signal,
				outputSchema: BOUND_SCHEMA,
				timeoutMs: opts.timeoutMs ?? 45_000,
			},
		);
		const parsed = parseBoundJson(res.finalText, 1);
		if (!parsed) return undefined;

		const boardPostId = publishRooflineToBoard(os, parsed, analyst.agent.id, undefined, false);
		const bound: RooflineBound = { ...parsed, ...(boardPostId ? { boardPostId } : {}) };

		os.bus.emit(os.runId, "bound.estimated", {
			metricName: bound.metricName,
			estimatedCeiling: bound.estimatedCeiling,
			hardCeiling: bound.hardCeiling,
			paradigmCeiling: bound.paradigmCeiling,
			isProvenHard: bound.isProvenHard,
			activeBottleneck: bound.activeBottleneck,
			isRefinement: false,
			stoppingFraction: bound.stoppingFraction,
			confidence: bound.confidence,
			assumptions: bound.keyAssumptions,
		});

		return bound;
	} catch {
		return undefined;
	} finally {
		await analyst.close().catch(() => {});
	}
}

/**
 * Mid-run Roofline refinement:
 * 1. Deterministic zero-token empirical clamping (`clampRooflineBoundEmpirically`).
 * 2. Optional 1-turn read-only `bound-analyst` profiling re-derivation ONLY when Tier 2 was empirically broken
 *    and `allowLlmRefinement` is enabled, marking the older `#swarm` bound post outdated via Board v3.
 */
export async function refineRooflineBound(
	os: SwarmOsApi,
	opts: {
		bound: RooflineBound;
		bestScore: number;
		goal: string;
		recentEvidence?: string;
		allowLlmRefinement?: boolean;
		signal: AbortSignal;
	},
): Promise<{ readonly bound: RooflineBound; readonly refined: boolean; readonly paradigmBroken: boolean }> {
	const clamped = clampRooflineBoundEmpirically(opts.bound, opts.bestScore);
	let current = clamped.next;

	if (!clamped.paradigmBroken && !clamped.hardBroken) {
		return { bound: current, refined: false, paradigmBroken: false };
	}

	// Deterministic empirical clamp happened; optionally ask analyst to tighten new Tier-2 paradigm roof
	if (opts.allowLlmRefinement && !opts.signal.aborted && !os.isInCloseoutReserve()) {
		const analyst = await os.spawnWorker({
			role: "planner",
			handle: "bound-analyst-refine",
			workspace: os.worktrees.trunkPath,
			readOnly: true,
			canSpawn: false,
			requireOutputSchema: true,
			maxTurns: 1,
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
			systemPrompt:
				"You are refining an empirical 2-tier Roofline Limit Ladder after the swarm broke the prior Tier-2 paradigm ceiling. Return ONLY strict JSON matching the schema.",
		});
		try {
			const res = await analyst.runTurn(
				[
					`Goal: ${opts.goal}`,
					`Prior Roofline rev ${opts.bound.revision}: Hard=${opts.bound.hardCeiling ?? "unbounded"}, Paradigm=${opts.bound.paradigmCeiling ?? "open"}, Bottleneck=${opts.bound.activeBottleneck}`,
					`New Verified Best Score: ${opts.bestScore.toFixed(4)} (${opts.bound.metricName}) — broke prior ceiling!`,
					opts.recentEvidence ? `Recent empirical evidence:\n${opts.recentEvidence.slice(0, 1500)}` : "",
					"Derive the updated Tier-2 `paradigm_ceiling`, new `active_bottleneck`, and remaining `breakable_assumptions`.",
				].filter(Boolean).join("\n\n"),
				{ signal: opts.signal, outputSchema: BOUND_SCHEMA, timeoutMs: 30_000 },
			);
			const reparsed = parseBoundJson(res.finalText, current.revision + 1);
			if (reparsed) {
				const clampedAgain = clampRooflineBoundEmpirically(reparsed, opts.bestScore);
				current = clampedAgain.next;
			}
		} catch {
			// Keep deterministic clamp on transient analyst failure.
		} finally {
			await analyst.close().catch(() => {});
		}
	}

	const boardPostId = publishRooflineToBoard(os, current, "bound-analyst", opts.bound.boardPostId, true);
	const finalized: RooflineBound = { ...current, ...(boardPostId ? { boardPostId } : {}) };

	os.bus.emit(os.runId, "bound.estimated", {
		metricName: finalized.metricName,
		estimatedCeiling: finalized.estimatedCeiling,
		hardCeiling: finalized.hardCeiling,
		paradigmCeiling: finalized.paradigmCeiling,
		isProvenHard: finalized.isProvenHard,
		activeBottleneck: finalized.activeBottleneck,
		isRefinement: true,
		stoppingFraction: finalized.stoppingFraction,
		confidence: finalized.confidence,
		assumptions: finalized.keyAssumptions,
	});

	return { bound: finalized, refined: true, paradigmBroken: clamped.paradigmBroken };
}

/** Write a structured 1-page Researcher Checkpoint Lab Brief to `<runDir>/checkpoints/brief-rev-<k>.md`. */
export function writeResearcherBrief(runDir: string, report: ResearcherCheckpointReport): string {
	const dir = join(runDir, "checkpoints");
	mkdirSync(dir, { recursive: true });
	const briefPath = join(dir, `brief-rev-${report.generation}.md`);
	const b = report.bound;
	const runIdArg = report.runId ?? "<runId>";
	const lines = [
		`# Researcher Checkpoint Lab Brief — Rev ${report.generation}`,
		"",
		`- **Trigger:** \`${report.trigger}\``,
		`- **Best Verified Score:** \`${report.bestScore.toFixed(4)}\`${b ? ` (${b.metricName})` : ""}`,
		`- **Distinct Basins Explored:** ${report.distinctBasins}`,
		...(report.spentTokens !== undefined ? [`- **Tokens Spent:** ${report.spentTokens.toLocaleString()}`] : []),
		...(report.bestArtifactPath ? [`- **Best Verified Snapshot:** \`${report.bestArtifactPath}\``] : []),
		"",
		"## Summary",
		report.summary,
		"",
		...(b
			? [
				"## 2-Tier Roofline Limit Ladder",
				`| Tier | Ceiling | Status / Bottleneck |`,
				`| --- | ---: | --- |`,
				`| Tier 1 — Hard Speed-of-Light | \`${b.hardCeiling ?? "unbounded"}\` | ${b.isProvenHard ? "Proven exact limit" : "Physical/mathematical bound"} |`,
				`| Tier 2 — Current Paradigm | \`${b.paradigmCeiling ?? "open"}\` | Bottleneck: ${b.activeBottleneck} |`,
				"",
				"### Breakable Assumptions",
				...(b.breakableAssumptions.length
					? b.breakableAssumptions.map((a) => `- **${a.id}** [${a.tier} · \`${a.status}\`]: ${a.assumption} — *Unlock:* ${a.unlockHint}`)
					: ["- (none listed)"]),
				"",
			]
			: []),
		...(report.negativeMemory?.length
			? ["## Recent Dead-Ends / Negative Memory", ...report.negativeMemory.slice(-6).map((n) => `- ${n}`), ""]
			: []),
		"## Control Commands",
		"```bash",
		`one-piece status ${runIdArg}`,
		`one-piece steer ${runIdArg} "Try breaking assumption A1 by ..." --live`,
		`one-piece bound ${runIdArg} --paradigm 22.0 --bottleneck "..."`,
		`one-piece resume ${runIdArg}`,
		`one-piece coalesce ${runIdArg} --reason "Ship current best"`,
		"```",
		"",
	];
	writeFileSync(briefPath, lines.join("\n"), "utf8");
	return briefPath;
}

function progressRatio(score: number, ceiling: number, higherIsBetter: boolean): number {
	return higherIsBetter ? score / Math.max(1e-9, ceiling) : ceiling / Math.max(1e-9, score);
}

/**
 * Evaluate the 4-way Researcher Checkpoint & Paradigm-Shift Gate:
 * 1. Exact / `isProvenHard` hard ceiling reached -> `"coalesce"` in BOTH modes.
 * 2. Tier-2 `paradigmCeiling` reached with Tier-1 headroom + active `BreakableAssumption` -> `"paradigm_shift"`.
 * 3. Exhausted / stalled / decision-model stop:
 *    - `"eval"` mode -> writes brief, emits non-blocking `advisory_interrupt`, returns `"continue"` (zero LLM auto-stop variance).
 *    - `"research"` mode -> writes brief and honors `policy` (`pause` | `notify` | `interactive` | `coalesce`).
 */
export async function evaluateResearcherCheckpoint(
	os: SwarmOsApi,
	opts: {
		goal: string;
		generation: number;
		bestScore: number;
		bound?: RooflineBound;
		scoreHistory: readonly number[];
		distinctBasins: number;
		controlMode?: ExecutionControlMode;
		checkpointPolicy?: CheckpointPolicy;
		onHumanCheckpoint?: HumanCheckpointHandler;
		negativeMemory?: readonly string[];
		signal?: AbortSignal;
	},
): Promise<CheckpointOutcome> {
	const controlMode: ExecutionControlMode = opts.controlMode ?? os.controlMode ?? "research";
	const policy: CheckpointPolicy = opts.checkpointPolicy ?? (controlMode === "eval" ? "notify" : "pause");
	if (!Number.isFinite(opts.bestScore)) {
		return { action: "continue", shouldStop: false, reason: "No verified score yet" };
	}

	const bound = opts.bound;

	// 1. Proven-Hard Tier-1 Exact Completion -> safe to coalesce in BOTH eval & research modes!
	if (bound && bound.isProvenHard && bound.hardCeiling !== null && bound.hardCeiling > 0) {
		const ratioHard = progressRatio(opts.bestScore, bound.hardCeiling, bound.higherIsBetter);
		if (ratioHard >= bound.stoppingFraction) {
			const reason = `Reached ${(ratioHard * 100).toFixed(1)}% of proven hard ceiling (${opts.bestScore.toFixed(4)} vs ${bound.hardCeiling.toFixed(4)} ${bound.metricName})`;
			os.bus.emit(os.runId, "researcher.checkpoint", {
				policy,
				trigger: "approaching_bound",
				bestScore: opts.bestScore,
				estimatedCeiling: bound.estimatedCeiling,
				hardCeiling: bound.hardCeiling,
				paradigmCeiling: bound.paradigmCeiling,
				controlMode,
				action: "coalesce",
			});
			return { action: "coalesce", shouldStop: true, trigger: "approaching_bound", reason };
		}
	}

	// 2. Tier-2 Paradigm Ceiling saturation with Tier-1 headroom -> Paradigm-Shift Steering!
	if (bound && bound.paradigmCeiling !== null && bound.paradigmCeiling > 0) {
		const ratioTier2 = progressRatio(opts.bestScore, bound.paradigmCeiling, bound.higherIsBetter);
		const hasTier1Headroom =
			bound.hardCeiling === null ||
			(bound.higherIsBetter
				? bound.hardCeiling > bound.paradigmCeiling * 1.04
				: bound.hardCeiling < bound.paradigmCeiling * 0.96);
		const nextAssumption = bound.breakableAssumptions.find((a) => a.tier === "paradigm" && a.status === "active");

		if (ratioTier2 >= bound.paradigmShiftFraction && hasTier1Headroom && nextAssumption) {
			const remainingGapToHard =
				bound.hardCeiling !== null ? Math.abs(bound.hardCeiling - opts.bestScore) : null;
			const directive = [
				`Current best (${opts.bestScore.toFixed(4)} ${bound.metricName}) is at ${(ratioTier2 * 100).toFixed(1)}% of Tier-2 paradigm ceiling (${bound.paradigmCeiling.toFixed(4)}, capped by: ${bound.activeBottleneck}).`,
				`STOP micro-tuning the existing paradigm. Break assumption [${nextAssumption.id}]: ${nextAssumption.assumption}.`,
				`Unlock direction: ${nextAssumption.unlockHint}`,
			].join(" ");
			os.bus.emit(os.runId, "bound.paradigm_shift", {
				generation: opts.generation,
				bestScore: opts.bestScore,
				paradigmCeiling: bound.paradigmCeiling,
				hardCeiling: bound.hardCeiling,
				targetAssumption: nextAssumption.assumption,
				unlockHint: nextAssumption.unlockHint,
			});
			os.bus.emit(os.runId, "researcher.checkpoint", {
				policy,
				trigger: "approaching_bound",
				bestScore: opts.bestScore,
				estimatedCeiling: bound.estimatedCeiling,
				hardCeiling: bound.hardCeiling,
				paradigmCeiling: bound.paradigmCeiling,
				controlMode,
				action: "paradigm_shift",
			});
			return {
				action: "paradigm_shift",
				shouldStop: false,
				reason: `Triggered paradigm shift on assumption ${nextAssumption.id} (${(ratioTier2 * 100).toFixed(1)}% of Tier-2 ceiling)`,
				targetAssumption: nextAssumption,
				directive,
				remainingGapToHard,
			};
		}
	}

	// 3. Evaluate whether a Researcher Checkpoint interrupt / advisory is warranted
	let trigger: ResearcherCheckpointReport["trigger"] | undefined;
	let reason = "";

	if (bound && bound.hardCeiling !== null && bound.hardCeiling > 0) {
		const ratioHard = progressRatio(opts.bestScore, bound.hardCeiling, bound.higherIsBetter);
		if (ratioHard >= bound.stoppingFraction) {
			trigger = "approaching_bound";
			reason = `Reached ${(ratioHard * 100).toFixed(1)}% of Tier-1 hard ceiling (${opts.bestScore.toFixed(4)} vs ${bound.hardCeiling.toFixed(4)} ${bound.metricName})`;
		}
	}

	if (!trigger && bound && bound.paradigmCeiling !== null && bound.paradigmCeiling > 0) {
		const ratioTier2 = progressRatio(opts.bestScore, bound.paradigmCeiling, bound.higherIsBetter);
		const unattempted = bound.breakableAssumptions.some((a) => a.tier === "paradigm" && a.status === "active");
		if (ratioTier2 >= bound.paradigmShiftFraction && !unattempted) {
			trigger = "paradigm_exhausted";
			reason = `At ${(ratioTier2 * 100).toFixed(1)}% of Tier-2 ceiling (${bound.paradigmCeiling.toFixed(4)}) with all paradigm assumptions attempted`;
		}
	}

	if (!trigger && os.decisionClient && opts.scoreHistory.length >= 2) {
		try {
			const state = [
				`Goal: ${opts.goal}`,
				`Evaluation Round: ${opts.generation}, Distinct Basins: ${opts.distinctBasins}`,
				`Best Score Trajectory: [${opts.scoreHistory.map((s) => s.toFixed(4)).join(" -> ")}]`,
				bound
					? `Roofline: ${bound.metricName} Tier-1=${bound.hardCeiling ?? "unbounded"}, Tier-2=${bound.paradigmCeiling ?? "open"}, Bottleneck=${bound.activeBottleneck}`
					: "Roofline: none",
			].join("\n");

			const dec = await os.decisionClient.decide({
				state,
				questions: {
					approaching_bound: {
						type: "noul",
						instructions: "Has the search effectively reached or closely approached its physical/mathematical hard ceiling?",
					},
					diminishing_returns: {
						type: "noul",
						instructions: "Are recent evaluations showing severe diminishing returns across distinct basins such that a human researcher checkpoint is warranted?",
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
				reason = `Decision model judged search near hard ceiling (P=${boundAns.p.toFixed(2)}, conf=${boundAns.confidence.toFixed(2)})`;
			} else if (dimAns && dimAns.p >= 0.82 && dimAns.confidence >= 0.60) {
				trigger = "diminishing_returns";
				reason = `Decision model detected strong diminishing returns (P=${dimAns.p.toFixed(2)}, conf=${dimAns.confidence.toFixed(2)})`;
			}
		} catch {
			// Non-fatal: continue search on decision client error.
		}
	}

	if (!trigger) {
		return { action: "continue", shouldStop: false, reason: "Continuing search" };
	}

	const runSnap = os.run();
	const report: ResearcherCheckpointReport = {
		generation: opts.generation,
		trigger,
		bestScore: opts.bestScore,
		bound,
		distinctBasins: opts.distinctBasins,
		summary: reason,
		runId: os.runId,
		spentTokens: runSnap.spent.tokens,
		negativeMemory: opts.negativeMemory,
	};
	const briefPath = writeResearcherBrief(os.runDir, report);

	// In `"eval"` mode, never auto-kill an open-ended benchmark on an LLM ceiling/stall guess (unless explicit policy="coalesce" override was requested for a stopping test).
	if (controlMode === "eval" && opts.checkpointPolicy !== "coalesce") {
		os.bus.emit(os.runId, "researcher.checkpoint", {
			policy,
			trigger,
			bestScore: opts.bestScore,
			estimatedCeiling: bound?.estimatedCeiling ?? null,
			hardCeiling: bound?.hardCeiling ?? null,
			paradigmCeiling: bound?.paradigmCeiling ?? null,
			briefPath,
			controlMode,
			action: "advisory_interrupt",
		});
		return {
			action: "continue",
			shouldStop: false,
			trigger,
			reason: `Eval-mode advisory checkpoint logged (${reason})`,
			advisoryBriefPath: briefPath,
		};
	}

	if (policy === "interactive" && opts.onHumanCheckpoint) {
		const decision = await opts.onHumanCheckpoint(report);
		os.bus.emit(os.runId, "researcher.checkpoint", {
			policy,
			trigger,
			bestScore: opts.bestScore,
			estimatedCeiling: bound?.estimatedCeiling ?? null,
			hardCeiling: bound?.hardCeiling ?? null,
			paradigmCeiling: bound?.paradigmCeiling ?? null,
			briefPath,
			controlMode,
			action: decision.action,
		});
		if (decision.action === "continue") {
			const updatedBound: BoundOverride | undefined =
				decision.updatedBound ??
				(decision.updatedCeiling !== undefined ? { paradigmCeiling: decision.updatedCeiling } : undefined);
			return {
				action: "continue",
				shouldStop: false,
				trigger,
				reason: `Human chose to continue${decision.steeringNote ? `: ${decision.steeringNote}` : ""}`,
				steeringNote: decision.steeringNote,
				updatedBound,
				advisoryBriefPath: briefPath,
			};
		}
		return { action: "coalesce", shouldStop: true, trigger, reason: `Human chose to coalesce (${reason})`, briefPath };
	}

	if (policy === "pause" || policy === "notify") {
		const pauseRun = policy === "pause";
		os.bus.emit(os.runId, "researcher.checkpoint", {
			policy,
			trigger,
			bestScore: opts.bestScore,
			estimatedCeiling: bound?.estimatedCeiling ?? null,
			hardCeiling: bound?.hardCeiling ?? null,
			paradigmCeiling: bound?.paradigmCeiling ?? null,
			briefPath,
			controlMode,
			action: pauseRun ? "pause" : "notify",
		});
		return {
			action: "interrupt_researcher",
			shouldStop: false,
			trigger,
			reason,
			briefPath,
			pauseRun,
		};
	}

	os.bus.emit(os.runId, "researcher.checkpoint", {
		policy,
		trigger,
		bestScore: opts.bestScore,
		estimatedCeiling: bound?.estimatedCeiling ?? null,
		hardCeiling: bound?.hardCeiling ?? null,
		paradigmCeiling: bound?.paradigmCeiling ?? null,
		briefPath,
		controlMode,
		action: "coalesce",
	});
	return { action: "coalesce", shouldStop: true, trigger, reason, briefPath };
}
