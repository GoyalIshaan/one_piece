import type { Scorecard } from "./contracts.ts";
import { analyzeProxyToTargetCorrelation, type ProxyToTargetReport } from "./correlation.ts";
import { buildBehavioralDiagnosticsSummary, type BehavioralDiagnosticsSummary } from "./diagnose.ts";
import type { EvalLedger, GenerationRecord, LedgerRunRecord } from "./ledger.ts";
import {
	benjaminiHochberg,
	bootstrapCI,
	computeRouterRegret,
	computeScalingLaws,
	mcnemarExact,
	type BootstrapInterval,
	type RouterRegretReport,
	type ScalingPoint,
} from "./stats.ts";
import { ALL_EVAL_TASKS } from "./tasks/registry.ts";

export interface ParetoArmPoint {
	readonly armKey: string;
	readonly topology: string;
	readonly runs: number;
	readonly meanNormalizedScore: number;
	readonly passRate: number;
	readonly meanTokens: number;
	readonly meanWallMs: number;
	readonly meanAulcTokens: number;
	readonly isParetoTokens: boolean;
	readonly isParetoWall: boolean;
}

export interface GenerationSummary {
	readonly genId: string;
	readonly label: string;
	readonly gitSha: string;
	readonly createdAt: string;
	readonly totalRuns: number;
	readonly validRuns: number;
	readonly faultCount: number;
	readonly faultRate: number;
	readonly tasksCovered: readonly string[];
	readonly armsCovered: readonly string[];
	readonly passRate: number;
	readonly normalizedScore: BootstrapInterval;
	readonly meanAulcTokens: number;
	readonly meanEfficiency: number;
	readonly meanTokens: number;
	readonly meanWallMs: number;
	readonly meanNominationLoss: number;
	readonly meanDiscoveryLoss: number;
	readonly meanFalseCertRate: number;
	readonly meanStoppingWasteShare: number;
	readonly meanCoordShare: number;
	readonly meanKvCacheHitRate: number;
	/** 2D Pareto hypervolume in normalized (1 - tokens/refTokens, score) space, [0, 1]. Higher = better frontier. */
	readonly paretoHypervolumeTokens: number;
	/** 2D Pareto hypervolume in normalized (1 - wallMs/refWallMs, score) space, [0, 1]. */
	readonly paretoHypervolumeWall: number;
	readonly paretoPoints: readonly ParetoArmPoint[];
	readonly v3Mechanisms?: {
		readonly citationYield?: number;
		readonly semanticRepairRate?: number;
		readonly basinDiversityRatio?: number;
		readonly boundCalibrationError?: number;
		readonly providerDiversityEntropy?: number;
		readonly stragglerSkewRatio?: number;
	};
}

interface GenerationTransitionBase {
	readonly fromGenId: string;
	readonly fromLabel: string;
	readonly toGenId: string;
	readonly toLabel: string;
	readonly passRateGain: number;
	readonly scoreGain: BootstrapInterval;
	readonly aulcGain: BootstrapInterval;
	readonly tokenDeltaMean: number;
	readonly hypervolumeDelta: number;
	readonly mcnemarPValue: number;
	readonly fdrQValue: number;
}

/**
 * Exhaustive generation transition outcome:
 * - `"unpaired"` transitions ALWAYS have `pairs: 0` and `verdict: "UNDERPOWERED"`.
 * - Paired transitions (`"exact_arm" | "best_arm_by_task"`) carry full statistical verdicts.
 */
export type GenerationTransition = GenerationTransitionBase & (
	| { readonly pairingMode: "unpaired"; readonly pairs: 0; readonly verdict: "UNDERPOWERED" }
	| {
		readonly pairingMode: "exact_arm" | "best_arm_by_task";
		readonly pairs: number;
		readonly verdict: "IMPROVED" | "REGRESSED" | "NEUTRAL" | "UNDERPOWERED";
	}
);

export interface CusumAlert {
	readonly metric: "meanTokens" | "faultRate" | "meanNominationLoss" | "normalizedScore";
	readonly direction: "upward_degradation" | "downward_degradation";
	readonly triggeredAtGenId: string;
	readonly triggeredAtLabel: string;
	readonly cusumValue: number;
	readonly threshold: number;
	readonly message: string;
}

export interface LossWaterfallRow {
	readonly genId: string;
	readonly label: string;
	readonly deliveredNormalized: number;
	readonly faultLoss: number;
	readonly nominationLoss: number;
	readonly falseCertLoss: number;
	readonly discoveryLoss: number;
	readonly stoppingWasteShare: number;
}

export interface BottleneckDiagnosis {
	readonly rank: number;
	readonly name: string;
	readonly impactScore: number;
	readonly metricValue: string;
	readonly diagnosis: string;
	readonly recommendedAction: string;
}

export interface TaskSaturationEntry {
	readonly taskId: string;
	readonly tier: string;
	readonly family: string;
	readonly runs: number;
	readonly armCount: number;
	readonly nonSoloMeanNormalized: number;
	readonly nonSoloStdDev: number;
	readonly soloMeanNormalized?: number;
	readonly silentBonMeanNormalized?: number;
	readonly bestSwarmMeanNormalized?: number;
	readonly communicationLift?: number;
	readonly status: "HEALTHY" | "SATURATED" | "LOW_COVERAGE";
}

export interface HeatmapCell {
	readonly taskId: string;
	readonly armKey: string;
	readonly runs: number;
	readonly passRate: number;
	readonly meanScore: number;
	readonly meanNormalizedScore: number;
	readonly meanTokens: number;
	readonly meanAulcTokens: number;
}

export interface TrajectoryReport {
	readonly generatedAt: string;
	readonly totalGenerations: number;
	readonly totalRuns: number;
	readonly validRuns: number;
	readonly faultedRuns: number;
	readonly overallVerdict: "ON_TRACK" | "PLATEAUING" | "REGRESSING" | "INSUFFICIENT_DATA";
	readonly executiveSummary: string;
	readonly generations: readonly GenerationSummary[];
	readonly transitions: readonly GenerationTransition[];
	readonly anchorToLatest?: GenerationTransition;
	readonly cusumAlerts: readonly CusumAlert[];
	readonly lossWaterfall: readonly LossWaterfallRow[];
	readonly bottlenecks: readonly BottleneckDiagnosis[];
	readonly taskHealth: readonly TaskSaturationEntry[];
	readonly heatmap: readonly HeatmapCell[];
	readonly routerRegret: RouterRegretReport;
	readonly scalingLaws: readonly ScalingPoint[];
	readonly correlation?: ProxyToTargetReport;
	readonly behavioralDiagnostics?: BehavioralDiagnosticsSummary;
	readonly latestAnytimeCurves: ReadonlyArray<{
		readonly armKey: string;
		readonly taskId: string;
		readonly points: readonly { pctBudget: number; bestOffline: number; nominated: number }[];
	}>;
}

function round4(x: number): number {
	return Number.isFinite(x) ? Math.round(x * 10_000) / 10_000 : 0;
}

function clamp01(x: number): number {
	return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

const KNOWN_OPT_BOUNDS: Record<string, { floor: number; ceiling: number }> = {
	"vliw-kernel-opt": { floor: 1.0, ceiling: 20.0 },
	"mini-opt-pack": { floor: 2.621899, ceiling: 2.636 },
};

function buildTaskNormalizers(runs: readonly LedgerRunRecord[]): Map<string, (score: number) => number> {
	const maxByTask = new Map<string, number>();
	for (const r of runs) {
		const prev = maxByTask.get(r.taskId) ?? Number.NEGATIVE_INFINITY;
		const hi = Math.max(r.deliveredScore, r.bestOfflineScore);
		if (hi > prev) maxByTask.set(r.taskId, hi);
	}
	const out = new Map<string, (score: number) => number>();
	for (const [taskId, maxObs] of maxByTask.entries()) {
		const known = KNOWN_OPT_BOUNDS[taskId];
		if (known) {
			const ceil = Math.max(known.ceiling, maxObs);
			const span = Math.max(1e-6, ceil - known.floor);
			out.set(taskId, (s) => clamp01((s - known.floor) / span));
		} else if (maxObs > 1.05) {
			const span = Math.max(1e-6, maxObs);
			out.set(taskId, (s) => clamp01(s / span));
		} else {
			out.set(taskId, (s) => clamp01(s));
		}
	}
	return out;
}

function computeParetoAndHypervolume(
	points: readonly Omit<ParetoArmPoint, "isParetoTokens" | "isParetoWall">[],
	refTokens: number,
	refWallMs: number,
): {
	annotated: ParetoArmPoint[];
	hvTokens: number;
	hvWall: number;
} {
	const isUndominated = (
		idx: number,
		costFn: (p: Omit<ParetoArmPoint, "isParetoTokens" | "isParetoWall">) => number,
	): boolean => {
		const cur = points[idx]!;
		const curCost = costFn(cur);
		for (let j = 0; j < points.length; j++) {
			if (j === idx) continue;
			const other = points[j]!;
			const otherCost = costFn(other);
			const betterOrEqScore = other.meanNormalizedScore >= cur.meanNormalizedScore - 1e-9;
			const betterOrEqCost = otherCost <= curCost + 1e-9;
			const strictlyBetter = other.meanNormalizedScore > cur.meanNormalizedScore + 1e-9 || otherCost < curCost - 1e-9;
			if (betterOrEqScore && betterOrEqCost && strictlyBetter) return false;
		}
		return true;
	};

	const annotated: ParetoArmPoint[] = points.map((p, idx) => ({
		...p,
		isParetoTokens: isUndominated(idx, (x) => x.meanTokens),
		isParetoWall: isUndominated(idx, (x) => x.meanWallMs),
	}));

	const hypervolume = (
		frontier: readonly ParetoArmPoint[],
		costFn: (p: ParetoArmPoint) => number,
		refCost: number,
	): number => {
		if (!frontier.length || refCost <= 0) return 0;
		// Normalize cost x in [0, 1] where lower cost = larger (1 - x) saving; sort ascending by x
		const sorted = frontier
			.map((p) => ({ x: clamp01(costFn(p) / refCost), y: clamp01(p.meanNormalizedScore) }))
			.sort((a, b) => a.x - b.x || b.y - a.y);
		// Exact 2D dominated area relative to worst corner (x=1, y=0)
		let area = 0;
		let maxYSoFar = 0;
		for (let i = 0; i < sorted.length; i++) {
			const pt = sorted[i]!;
			if (pt.y > maxYSoFar) {
				const width = Math.max(0, 1 - pt.x);
				area += width * (pt.y - maxYSoFar);
				maxYSoFar = pt.y;
			}
		}
		return round4(clamp01(area));
	};

	return {
		annotated,
		hvTokens: hypervolume(annotated.filter((p) => p.isParetoTokens), (p) => p.meanTokens, refTokens),
		hvWall: hypervolume(annotated.filter((p) => p.isParetoWall), (p) => p.meanWallMs, refWallMs),
	};
}

type RawGenerationTransition = Omit<GenerationTransitionBase, "fdrQValue"> & (
	| { readonly pairingMode: "unpaired"; readonly pairs: 0; readonly verdict: "UNDERPOWERED" }
	| {
		readonly pairingMode: "exact_arm" | "best_arm_by_task";
		readonly pairs: number;
		readonly verdict: "IMPROVED" | "REGRESSED" | "NEUTRAL" | "UNDERPOWERED";
	}
);

function compareGenerationPair(
	fromGen: GenerationSummary,
	toGen: GenerationSummary,
	fromRuns: readonly LedgerRunRecord[],
	toRuns: readonly LedgerRunRecord[],
	normalizers: Map<string, (s: number) => number>,
): RawGenerationTransition {
	const norm = (r: LedgerRunRecord) => (normalizers.get(r.taskId) ?? clamp01)(r.deliveredScore);

	// 1. Try exact (taskId, armKey, seed) pairing
	const fromByExact = new Map<string, LedgerRunRecord>();
	for (const r of fromRuns) {
		if (!r.hasFault) fromByExact.set(`${r.taskId}::${r.armKey}::${r.seed}`, r);
	}
	const exactPairs: Array<{ a: LedgerRunRecord; b: LedgerRunRecord }> = [];
	for (const r of toRuns) {
		if (r.hasFault) continue;
		const prev = fromByExact.get(`${r.taskId}::${r.armKey}::${r.seed}`);
		if (prev) exactPairs.push({ a: prev, b: r });
	}

	let pairs = exactPairs;
	let pairedMode: "exact_arm" | "best_arm_by_task" = "exact_arm";

	// 2. Fallback: best non-faulted arm per (taskId, seed) when topologies changed between generations
	if (pairs.length === 0) {
		const bestByTaskSeed = (rows: readonly LedgerRunRecord[]) => {
			const map = new Map<string, LedgerRunRecord>();
			for (const r of rows) {
				if (r.hasFault) continue;
				const k = `${r.taskId}::${r.seed}`;
				const cur = map.get(k);
				if (!cur || norm(r) > norm(cur)) map.set(k, r);
			}
			return map;
		};
		const fromBest = bestByTaskSeed(fromRuns);
		const toBest = bestByTaskSeed(toRuns);
		const bestPairs: Array<{ a: LedgerRunRecord; b: LedgerRunRecord }> = [];
		for (const [k, b] of toBest.entries()) {
			const a = fromBest.get(k);
			if (a) bestPairs.push({ a, b });
		}
		if (bestPairs.length > 0) {
			pairs = bestPairs;
			pairedMode = "best_arm_by_task";
		}
	}

	const hvDelta = round4(toGen.paretoHypervolumeTokens - fromGen.paretoHypervolumeTokens);
	if (!pairs.length) {
		const rawDelta = round4(toGen.normalizedScore.mean - fromGen.normalizedScore.mean);
		return {
			fromGenId: fromGen.genId,
			fromLabel: fromGen.label,
			toGenId: toGen.genId,
			toLabel: toGen.label,
			pairingMode: "unpaired",
			pairs: 0,
			passRateGain: round4(toGen.passRate - fromGen.passRate),
			scoreGain: { mean: rawDelta, ciLow: rawDelta, ciHigh: rawDelta, n: 0 },
			aulcGain: { mean: round4(toGen.meanAulcTokens - fromGen.meanAulcTokens), ciLow: 0, ciHigh: 0, n: 0 },
			tokenDeltaMean: Math.round(toGen.meanTokens - fromGen.meanTokens),
			hypervolumeDelta: hvDelta,
			mcnemarPValue: 1,
			verdict: "UNDERPOWERED",
		};
	}

	let winsOnlyTo = 0;
	let winsOnlyFrom = 0;
	let fromPass = 0;
	let toPass = 0;
	const scoreDiffs: number[] = [];
	const aulcDiffs: number[] = [];
	const tokenDiffs: number[] = [];

	for (const { a, b } of pairs) {
		if (a.deliveredPass) fromPass++;
		if (b.deliveredPass) toPass++;
		if (!a.deliveredPass && b.deliveredPass) winsOnlyTo++;
		else if (a.deliveredPass && !b.deliveredPass) winsOnlyFrom++;
		scoreDiffs.push(norm(b) - norm(a));
		aulcDiffs.push(b.aulcTokens - a.aulcTokens);
		tokenDiffs.push(b.tokensTotal - a.tokensTotal);
	}

	const scoreGain = bootstrapCI(scoreDiffs);
	const aulcGain = bootstrapCI(aulcDiffs);
	const passRateGain = round4((toPass - fromPass) / pairs.length);
	const pVal = mcnemarExact(winsOnlyTo, winsOnlyFrom);
	const tokenDeltaMean = Math.round(tokenDiffs.reduce((s, x) => s + x, 0) / pairs.length);

	let verdict: GenerationTransition["verdict"] = "NEUTRAL";
	if (pairs.length < 2) {
		verdict = "UNDERPOWERED";
	} else if (scoreGain.ciLow > 0 || (scoreGain.mean >= 0.05 && passRateGain >= 0)) {
		verdict = "IMPROVED";
	} else if (scoreGain.ciHigh < 0 || scoreGain.mean <= -0.05 || passRateGain <= -0.1) {
		verdict = "REGRESSED";
	}

	return {
		fromGenId: fromGen.genId,
		fromLabel: fromGen.label,
		toGenId: toGen.genId,
		toLabel: toGen.label,
		pairingMode: pairedMode,
		pairs: pairs.length,
		passRateGain,
		scoreGain,
		aulcGain,
		tokenDeltaMean,
		hypervolumeDelta: hvDelta,
		mcnemarPValue: pVal,
		verdict,
	};
}

function detectCusumAlerts(gens: readonly GenerationSummary[]): CusumAlert[] {
	if (gens.length < 4) return [];
	const alerts: CusumAlert[] = [];

	const runOne = (
		metric: CusumAlert["metric"],
		direction: CusumAlert["direction"],
		extractor: (g: GenerationSummary) => number,
		unitDesc: string,
	) => {
		const values = gens.map(extractor);
		// Baseline mean/std from first half of history (at least 2 points)
		const baseLen = Math.max(2, Math.floor(values.length / 2));
		const base = values.slice(0, baseLen);
		const mean = base.reduce((s, x) => s + x, 0) / base.length;
		const variance = base.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, base.length - 1);
		const std = Math.max(Math.sqrt(variance), Math.abs(mean) * 0.08, 1e-4);
		const k = 0.5 * std;
		const h = 2.5 * std;

		let sPos = 0;
		let sNeg = 0;
		for (let i = baseLen; i < values.length; i++) {
			const x = values[i]!;
			sPos = Math.max(0, sPos + (x - mean - k));
			sNeg = Math.max(0, sNeg + (mean - x - k));
			if (direction === "upward_degradation" && sPos > h) {
				alerts.push({
					metric,
					direction,
					triggeredAtGenId: gens[i]!.genId,
					triggeredAtLabel: gens[i]!.label,
					cusumValue: round4(sPos),
					threshold: round4(h),
					message: `Sustained upward drift in ${metric} (${unitDesc}): baseline=${round4(mean)}, latest=${round4(x)} (CUSUM ${round4(sPos)} > ${round4(h)}).`,
				});
				break;
			}
			if (direction === "downward_degradation" && sNeg > h) {
				alerts.push({
					metric,
					direction,
					triggeredAtGenId: gens[i]!.genId,
					triggeredAtLabel: gens[i]!.label,
					cusumValue: round4(sNeg),
					threshold: round4(h),
					message: `Sustained downward drift in ${metric} (${unitDesc}): baseline=${round4(mean)}, latest=${round4(x)} (CUSUM ${round4(sNeg)} > ${round4(h)}).`,
				});
				break;
			}
		}
	};

	runOne("meanTokens", "upward_degradation", (g) => g.meanTokens, "tokens/run");
	runOne("faultRate", "upward_degradation", (g) => g.faultRate, "fault fraction");
	runOne("meanNominationLoss", "upward_degradation", (g) => g.meanNominationLoss, "lost score");
	runOne("normalizedScore", "downward_degradation", (g) => g.normalizedScore.mean, "normalized score");
	return alerts;
}

/**
 * Analyze the full longitudinal history stored in `EvalLedger` and produce a complete
 * statistical trajectory, regression, Pareto hypervolume, CUSUM, saturation, and bottleneck report.
 */
export function analyzeTrajectory(ledger: EvalLedger): TrajectoryReport {
	const rawGens: GenerationRecord[] = ledger.listGenerations();
	const allRuns: LedgerRunRecord[] = ledger.listRuns();
	const normalizers = buildTaskNormalizers(allRuns);
	const normOf = (r: LedgerRunRecord) => (normalizers.get(r.taskId) ?? clamp01)(r.deliveredScore);
	const normBestOf = (r: LedgerRunRecord) => (normalizers.get(r.taskId) ?? clamp01)(r.bestOfflineScore);

	// Global reference bounds for cross-generation comparable Pareto Hypervolume
	const validAll = allRuns.filter((r) => !r.hasFault);
	const refTokens = Math.max(100_000, ...validAll.map((r) => r.tokensTotal)) * 1.1;
	const refWallMs = Math.max(60_000, ...validAll.map((r) => r.wallMs)) * 1.1;

	const runsByGen = new Map<string, LedgerRunRecord[]>();
	for (const r of allRuns) {
		const arr = runsByGen.get(r.genId) ?? [];
		arr.push(r);
		runsByGen.set(r.genId, arr);
	}

	const generations: GenerationSummary[] = [];
	const lossWaterfall: LossWaterfallRow[] = [];

	for (const g of rawGens) {
		const gRuns = runsByGen.get(g.genId) ?? [];
		if (!gRuns.length) continue;
		const valid = gRuns.filter((r) => !r.hasFault);
		const faultCount = gRuns.length - valid.length;
		const faultRate = round4(faultCount / gRuns.length);

		const normScores = valid.map(normOf);
		const avg = (rows: readonly LedgerRunRecord[], fn: (r: LedgerRunRecord) => number) =>
			rows.length ? rows.reduce((s, r) => s + fn(r), 0) / rows.length : 0;

		// Aggregate per-arm points for Pareto frontier
		const byArm = new Map<string, LedgerRunRecord[]>();
		for (const r of valid) {
			const arr = byArm.get(r.armKey) ?? [];
			arr.push(r);
			byArm.set(r.armKey, arr);
		}
		const armPoints = [...byArm.entries()].map(([armKey, rows]) => ({
			armKey,
			topology: rows[0]!.topology,
			runs: rows.length,
			meanNormalizedScore: round4(avg(rows, normOf)),
			passRate: round4(rows.filter((r) => r.deliveredPass).length / rows.length),
			meanTokens: Math.round(avg(rows, (r) => r.tokensTotal)),
			meanWallMs: Math.round(avg(rows, (r) => r.wallMs)),
			meanAulcTokens: round4(avg(rows, (r) => r.aulcTokens)),
		}));
		const pareto = computeParetoAndHypervolume(armPoints, refTokens, refWallMs);

		const meanNom = round4(avg(valid, (r) => Math.max(0, normBestOf(r) - normOf(r))));
		const meanDisc = round4(avg(valid, (r) => Math.max(0, 1 - normBestOf(r))));
		const meanFalseCert = round4(avg(valid, (r) => r.scorecard.losses.falseCertificationRate));
		const meanStopWaste = round4(avg(valid, (r) => r.scorecard.losses.stoppingWasteShare));

		// Optional v3 mechanism aggregates
		const v2Cards = valid.map((r) => r.scorecard).filter((c) => Boolean(c.mechanisms));
		const meanOpt = (vals: readonly (number | undefined)[]) => {
			const clean = vals.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
			return clean.length ? round4(clean.reduce((s, x) => s + x, 0) / clean.length) : undefined;
		};
		const v3Mechanisms = v2Cards.length
			? {
					citationYield: meanOpt(v2Cards.map((c) => c.mechanisms?.board.citationYield)),
					semanticRepairRate: meanOpt(v2Cards.map((c) => c.mechanisms?.integration.semanticRepairRate)),
					basinDiversityRatio: meanOpt(v2Cards.map((c) => c.mechanisms?.search.basinDiversityRatio)),
					boundCalibrationError: meanOpt(v2Cards.map((c) => c.mechanisms?.meta.boundCalibrationError)),
					providerDiversityEntropy: meanOpt(v2Cards.map((c) => c.mechanisms?.governor.providerDiversityEntropy)),
					stragglerSkewRatio: meanOpt(v2Cards.map((c) => c.mechanisms?.forest.stragglerSkewRatio)),
				}
			: undefined;

		const summary: GenerationSummary = {
			genId: g.genId,
			label: g.label,
			gitSha: g.gitSha,
			createdAt: g.createdAt,
			totalRuns: gRuns.length,
			validRuns: valid.length,
			faultCount,
			faultRate,
			tasksCovered: [...new Set(gRuns.map((r) => r.taskId))].sort(),
			armsCovered: [...new Set(gRuns.map((r) => r.armKey))].sort(),
			passRate: round4(valid.length ? valid.filter((r) => r.deliveredPass).length / valid.length : 0),
			normalizedScore: bootstrapCI(normScores),
			meanAulcTokens: round4(avg(valid, (r) => r.aulcTokens)),
			meanEfficiency: round4(avg(valid, (r) => normOf(r) / Math.max(0.1, r.tokensTotal / 100_000))),
			meanTokens: Math.round(avg(valid, (r) => r.tokensTotal)),
			meanWallMs: Math.round(avg(valid, (r) => r.wallMs)),
			meanNominationLoss: meanNom,
			meanDiscoveryLoss: meanDisc,
			meanFalseCertRate: meanFalseCert,
			meanStoppingWasteShare: meanStopWaste,
			meanCoordShare: round4(avg(valid, (r) => r.scorecard.tokens.coordinationTokenShare)),
			meanKvCacheHitRate: round4(avg(valid, (r) => r.scorecard.tokens.cacheHitRate ?? 0)),
			paretoHypervolumeTokens: pareto.hvTokens,
			paretoHypervolumeWall: pareto.hvWall,
			paretoPoints: pareto.annotated,
			...(v3Mechanisms ? { v3Mechanisms } : {}),
		};
		generations.push(summary);

		const deliveredAll = round4(
			gRuns.length ? gRuns.reduce((s, r) => s + (r.hasFault ? 0 : normOf(r)), 0) / gRuns.length : 0,
		);
		const faultLoss = round4(faultRate);
		const rem = Math.max(0, 1 - deliveredAll - faultLoss);
		const nomPart = round4(Math.min(rem, meanNom * (1 - faultRate)));
		const fcPart = round4(Math.min(Math.max(0, rem - nomPart), meanFalseCert * 0.25 * (1 - faultRate)));
		const discPart = round4(Math.max(0, rem - nomPart - fcPart));
		lossWaterfall.push({
			genId: g.genId,
			label: g.label,
			deliveredNormalized: deliveredAll,
			faultLoss,
			nominationLoss: nomPart,
			falseCertLoss: fcPart,
			discoveryLoss: discPart,
			stoppingWasteShare: meanStopWaste,
		});
	}

	// Adjacent generation-over-generation transitions with Benjamini-Hochberg FDR
	const rawTransitions: RawGenerationTransition[] = [];
	for (let i = 1; i < generations.length; i++) {
		const prev = generations[i - 1]!;
		const cur = generations[i]!;
		rawTransitions.push(
			compareGenerationPair(prev, cur, runsByGen.get(prev.genId) ?? [], runsByGen.get(cur.genId) ?? [], normalizers),
		);
	}
	const fdrQ = benjaminiHochberg(rawTransitions.map((t) => t.mcnemarPValue));
	const transitions: GenerationTransition[] = rawTransitions.map((t, i): GenerationTransition => ({
		...t,
		fdrQValue: fdrQ[i] ?? 1,
	}));

	const anchorToLatest: GenerationTransition | undefined =
		generations.length >= 2
			? {
					...compareGenerationPair(
						generations[0]!,
						generations.at(-1)!,
						runsByGen.get(generations[0]!.genId) ?? [],
						runsByGen.get(generations.at(-1)!.genId) ?? [],
						normalizers,
					),
					fdrQValue: 1,
				}
			: undefined;

	// CUSUM drift alerts
	const cusumAlerts = detectCusumAlerts(generations);

	// Task Saturation & Communication Lift Watchdog + Heatmap
	const byTask = new Map<string, LedgerRunRecord[]>();
	const byTaskArm = new Map<string, LedgerRunRecord[]>();
	for (const r of validAll) {
		const tArr = byTask.get(r.taskId) ?? [];
		tArr.push(r);
		byTask.set(r.taskId, tArr);

		const taKey = `${r.taskId}::${r.armKey}`;
		const taArr = byTaskArm.get(taKey) ?? [];
		taArr.push(r);
		byTaskArm.set(taKey, taArr);
	}

	const heatmap: HeatmapCell[] = [...byTaskArm.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([, rows]) => {
			const first = rows[0]!;
			const mean = (fn: (r: LedgerRunRecord) => number) => rows.reduce((s, r) => s + fn(r), 0) / rows.length;
			return {
				taskId: first.taskId,
				armKey: first.armKey,
				runs: rows.length,
				passRate: round4(rows.filter((r) => r.deliveredPass).length / rows.length),
				meanScore: round4(mean((r) => r.deliveredScore)),
				meanNormalizedScore: round4(mean(normOf)),
				meanTokens: Math.round(mean((r) => r.tokensTotal)),
				meanAulcTokens: round4(mean((r) => r.aulcTokens)),
			};
		});

	const taskHealth: TaskSaturationEntry[] = [...byTask.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([taskId, rows]) => {
			const meta = ALL_EVAL_TASKS.find((t) => t.id === taskId);
			const armMeans = new Map<string, { rung: string; mean: number }>();
			const grouped = new Map<string, LedgerRunRecord[]>();
			for (const r of rows) {
				const arr = grouped.get(r.armKey) ?? [];
				arr.push(r);
				grouped.set(r.armKey, arr);
			}
			for (const [arm, aRows] of grouped.entries()) {
				armMeans.set(arm, {
					rung: aRows[0]!.controlRung,
					mean: aRows.reduce((s, r) => s + normOf(r), 0) / aRows.length,
				});
			}
			const nonSoloVals = [...armMeans.values()].filter((v) => v.rung !== "solo").map((v) => v.mean);
			const nonSoloMean = nonSoloVals.length ? nonSoloVals.reduce((s, x) => s + x, 0) / nonSoloVals.length : 0;
			const nonSoloVar = nonSoloVals.length > 1
				? nonSoloVals.reduce((s, x) => s + (x - nonSoloMean) ** 2, 0) / nonSoloVals.length
				: 0;
			const nonSoloStd = Math.sqrt(nonSoloVar);

			const soloEntry = [...armMeans.values()].find((v) => v.rung === "solo");
			const silentEntry = [...armMeans.values()].find((v) => v.rung === "silent_bon");
			const swarmVals = [...armMeans.values()].filter((v) => v.rung === "swarm").map((v) => v.mean);
			const bestSwarm = swarmVals.length ? Math.max(...swarmVals) : undefined;
			const communicationLift =
				bestSwarm !== undefined && silentEntry !== undefined ? round4(bestSwarm - silentEntry.mean) : undefined;

			let status: TaskSaturationEntry["status"] = "HEALTHY";
			if (armMeans.size < 2) status = "LOW_COVERAGE";
			else if (nonSoloVals.length >= 2 && nonSoloMean >= 0.95 && nonSoloStd < 0.045) status = "SATURATED";

			return {
				taskId,
				tier: meta?.tier ?? "proxy",
				family: rows[0]!.family,
				runs: rows.length,
				armCount: armMeans.size,
				nonSoloMeanNormalized: round4(nonSoloMean),
				nonSoloStdDev: round4(nonSoloStd),
				...(soloEntry ? { soloMeanNormalized: round4(soloEntry.mean) } : {}),
				...(silentEntry ? { silentBonMeanNormalized: round4(silentEntry.mean) } : {}),
				...(bestSwarm !== undefined ? { bestSwarmMeanNormalized: round4(bestSwarm) } : {}),
				...(communicationLift !== undefined ? { communicationLift } : {}),
				status,
			};
		});

	// Cross-benchmark correlation, Router Regret, Scaling Laws
	const allCards: Scorecard[] = allRuns.map((r) => r.scorecard);
	const seenTasks = [...new Set(allCards.map((c) => c.taskId))];
	const proxyTaskIds = seenTasks.filter((id) => (ALL_EVAL_TASKS.find((t) => t.id === id)?.tier ?? "proxy") === "proxy");
	const targetTaskIds = seenTasks.filter((id) => ALL_EVAL_TASKS.find((t) => t.id === id)?.tier === "long-horizon");
	const correlation =
		proxyTaskIds.length && targetTaskIds.length
			? analyzeProxyToTargetCorrelation(allCards, { proxyTaskIds, targetTaskIds, excludeFaulted: true })
			: undefined;
	const routerRegret = computeRouterRegret(allCards, "adaptive");
	const scalingLaws = computeScalingLaws(allCards);

	// Bottleneck Attribution Ranker (focus on the latest 2 generations so advice targets CURRENT bottlenecks)
	const recentGenIds = new Set(generations.slice(-2).map((g) => g.genId));
	const recentRuns = allRuns.filter((r) => recentGenIds.has(r.genId));
	const recentValid = recentRuns.filter((r) => !r.hasFault);
	const rAvg = (fn: (r: LedgerRunRecord) => number) =>
		recentValid.length ? recentValid.reduce((s, r) => s + fn(r), 0) / recentValid.length : 0;

	const rawBottlenecks: Array<Omit<BottleneckDiagnosis, "rank">> = [];
	const recentDiscLoss = rAvg((r) => Math.max(0, 1 - normBestOf(r)));
	if (recentDiscLoss > 0.02) {
		rawBottlenecks.push({
			name: "Discovery Shortfall",
			impactScore: round4(recentDiscLoss),
			metricValue: `${(recentDiscLoss * 100).toFixed(1)}% avg gap to ceiling`,
			diagnosis: "Best candidate produced anywhere in the swarm still falls short of full task ceiling on hard long-horizon tasks.",
			recommendedAction: "Increase search diversity (evolution crossover, recursive Planner decomposition, or longer-horizon verification feedback).",
		});
	}
	const recentNomLoss = rAvg((r) => Math.max(0, normBestOf(r) - normOf(r)));
	if (recentNomLoss > 0.005) {
		rawBottlenecks.push({
			name: "Nomination / Closeout Loss",
			impactScore: round4(recentNomLoss * 1.5),
			metricValue: `${(recentNomLoss * 100).toFixed(1)}% score left on the table`,
			diagnosis: "Agents discovered stronger solutions than the final nominated trunk artifact.",
			recommendedAction: "Audit closeout verification and IntegrationPipeline rollback/auto-nomination selection.",
		});
	}
	const recentFaultRate = recentRuns.length ? (recentRuns.length - recentValid.length) / recentRuns.length : 0;
	if (recentFaultRate > 0) {
		rawBottlenecks.push({
			name: "Harness / Infrastructure Faults",
			impactScore: round4(recentFaultRate * 2.0),
			metricValue: `${(recentFaultRate * 100).toFixed(1)}% faulted runs`,
			diagnosis: "Infrastructure, quota drain, or runner crash faults corrupted benchmark runs.",
			recommendedAction: "Inspect fault codes via `eval-lab verify` and harden failover / sandbox paths.",
		});
	}
	const recentStopWaste = rAvg((r) => r.scorecard.losses.stoppingWasteShare);
	if (recentStopWaste > 0.1) {
		rawBottlenecks.push({
			name: "Post-Optimum Stopping Waste",
			impactScore: round4(recentStopWaste * 0.5),
			metricValue: `${(recentStopWaste * 100).toFixed(1)}% tokens spent after optimum`,
			diagnosis: "Swarm continues burning tokens after best verified candidate has already been achieved.",
			recommendedAction: "Tighten First-Principles Bound Analyst `stoppingFraction` and early coalesce checkpoints.",
		});
	}
	if (routerRegret.tasksEvaluated > 0 && routerRegret.meanNormalizedRegret > 0.02) {
		rawBottlenecks.push({
			name: "Adaptive Meta-Router Oracle Regret",
			impactScore: round4(routerRegret.meanNormalizedRegret * 1.2),
			metricValue: `mean normalized regret ${(routerRegret.meanNormalizedRegret * 100).toFixed(1)}% (raw max ${routerRegret.maxRegret.toFixed(3)})`,
			diagnosis: `Adaptive router underperformed the per-task oracle topology on ${routerRegret.perTask.filter((t) => t.normalizedRegret > 0.01).map((t) => `${t.taskId} (${(t.normalizedRegret * 100).toFixed(1)}%, oracle=${t.oracleTopology})`).join(", ")}.`,
			recommendedAction: "Calibrate structural pre-flight classifier / Jev mid-run morph triggers on those regimes.",
		});
	}
	const saturatedProxies = taskHealth.filter((t) => t.status === "SATURATED");
	if (saturatedProxies.length > 0) {
		rawBottlenecks.push({
			name: "Proxy Benchmark Saturation",
			impactScore: round4(0.15 * saturatedProxies.length),
			metricValue: `${saturatedProxies.length} saturated proxy task(s): ${saturatedProxies.map((t) => t.taskId).join(", ")}`,
			diagnosis: "Raw score variance collapsed across swarm arms on these proxies, reducing RSI gradient signal.",
			recommendedAction: "Switch ranking to AULC / efficiency (`score / 100k tok`) or graduate to harder tasks (`triage-needle-mesh`, SWE-bench, MLE-bench).",
		});
	}
	rawBottlenecks.sort((a, b) => b.impactScore - a.impactScore);
	const bottlenecks: BottleneckDiagnosis[] = rawBottlenecks.slice(0, 6).map((b, idx) => ({ rank: idx + 1, ...b }));

	// Latest generation anytime curves (for plotting)
	const latestGen = generations.at(-1);
	const latestAnytimeCurves: Array<{
		readonly armKey: string;
		readonly taskId: string;
		readonly points: readonly { pctBudget: number; bestOffline: number; nominated: number }[];
	}> = [];
	if (latestGen) {
		const latestValid = (runsByGen.get(latestGen.genId) ?? []).filter((r) => !r.hasFault);
		const seenCurves = new Set<string>();
		for (const r of latestValid) {
			const key = `${r.taskId}::${r.armKey}`;
			if (seenCurves.has(key)) continue;
			seenCurves.add(key);
			const norm = normalizers.get(r.taskId) ?? clamp01;
			const horizon = Math.max(r.scorecard.reproducibility.budget?.tokens ?? 0, r.tokensTotal, 1);
			const pts = (r.scorecard.anytimeFrontier ?? []).map((p) => ({
				pctBudget: round4(clamp01(p.atTokens / horizon)),
				bestOffline: round4(norm(p.bestOfflineScore)),
				nominated: round4(norm(p.nominatedScore)),
			}));
			if (!pts.length) {
				pts.push({
					pctBudget: round4(clamp01(r.tokensTotal / horizon)),
					bestOffline: round4(norm(r.bestOfflineScore)),
					nominated: round4(norm(r.deliveredScore)),
				});
			}
			latestAnytimeCurves.push({ armKey: r.armKey, taskId: r.taskId, points: pts });
		}
	}

	// Executive Trajectory Verdict
	let overallVerdict: TrajectoryReport["overallVerdict"] = "INSUFFICIENT_DATA";
	let executiveSummary = "Need at least 2 recorded generations to assess trajectory.";
	if (generations.length >= 2) {
		const first = generations[0]!;
		const last = generations.at(-1)!;
		const scoreShift = round4(last.normalizedScore.mean - first.normalizedScore.mean);
		const hvShift = round4(last.paretoHypervolumeTokens - first.paretoHypervolumeTokens);
		const recentRegressions = transitions.slice(-2).filter((t) => t.verdict === "REGRESSED").length;
		const criticalAlerts = cusumAlerts.filter((a) => a.metric === "normalizedScore" || a.metric === "faultRate").length;

		if (recentRegressions > 0 || criticalAlerts > 0 || (scoreShift < -0.05 && hvShift < -0.03)) {
			overallVerdict = "REGRESSING";
			executiveSummary = `Trajectory shows regression risk (${recentRegressions} recent regressed transitions, ${cusumAlerts.length} CUSUM alerts; anchor→latest score ${scoreShift >= 0 ? "+" : ""}${(scoreShift * 100).toFixed(1)}pp, Pareto HV ${hvShift >= 0 ? "+" : ""}${hvShift.toFixed(3)}).`;
		} else if (scoreShift >= 0.05 || hvShift >= 0.03 || last.passRate > first.passRate + 0.08) {
			overallVerdict = "ON_TRACK";
			executiveSummary = `Positive generational trajectory across ${generations.length} generations (${allRuns.length} runs): normalized score ${first.normalizedScore.mean.toFixed(3)} → ${last.normalizedScore.mean.toFixed(3)} (${scoreShift >= 0 ? "+" : ""}${(scoreShift * 100).toFixed(1)}pp), Pareto HV ${first.paretoHypervolumeTokens.toFixed(3)} → ${last.paretoHypervolumeTokens.toFixed(3)} (${hvShift >= 0 ? "+" : ""}${hvShift.toFixed(3)}), latest fault rate ${(last.faultRate * 100).toFixed(1)}%.`;
		} else {
			overallVerdict = "PLATEAUING";
			executiveSummary = `Performance is currently plateauing across ${generations.length} generations (score delta ${scoreShift >= 0 ? "+" : ""}${(scoreShift * 100).toFixed(1)}pp, Pareto HV delta ${hvShift >= 0 ? "+" : ""}${hvShift.toFixed(3)}). Focus next cycle on #1 bottleneck: ${bottlenecks[0]?.name ?? "harder benchmarks"}.`;
		}
	}

	const behavioralDiagnostics = buildBehavioralDiagnosticsSummary(ledger);

	return {
		generatedAt: new Date().toISOString(),
		totalGenerations: generations.length,
		totalRuns: allRuns.length,
		validRuns: validAll.length,
		faultedRuns: allRuns.length - validAll.length,
		overallVerdict,
		executiveSummary,
		generations,
		transitions,
		...(anchorToLatest ? { anchorToLatest } : {}),
		cusumAlerts,
		lossWaterfall,
		bottlenecks,
		taskHealth,
		heatmap,
		routerRegret,
		scalingLaws,
		...(correlation ? { correlation } : {}),
		...(behavioralDiagnostics ? { behavioralDiagnostics } : {}),
		latestAnytimeCurves,
	};
}

export function renderTrajectoryMarkdown(report: TrajectoryReport): string {
	const lines: string[] = [
		`# Longitudinal Harness Trajectory Report — Verdict: **${report.overallVerdict}**`,
		"",
		`> ${report.executiveSummary}`,
		"",
		`- **Generations Tracked:** ${report.totalGenerations} · **Total Runs:** ${report.totalRuns} (${report.validRuns} valid, ${report.faultedRuns} faulted)`,
		`- **Adaptive Router Oracle Regret:** mean normalized \`${(report.routerRegret.meanNormalizedRegret * 100).toFixed(1)}%\` across ${report.routerRegret.tasksEvaluated} task(s)`,
		`- **CUSUM Drift Alerts:** ${report.cusumAlerts.length}`,
		"",
		"## 1. Generation-by-Generation Progression",
		"",
		"| Generation | Git SHA | Runs | Pass Rate | Norm Score (95% CI) | AULC | Pareto HV | Mean Tokens | NomLoss | Faults |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	for (const g of report.generations) {
		lines.push(
			`| ${g.label} | \`${g.gitSha.slice(0, 7)}\` | ${g.validRuns}/${g.totalRuns} | ${(g.passRate * 100).toFixed(1)}% | ${g.normalizedScore.mean.toFixed(3)} [${g.normalizedScore.ciLow.toFixed(2)}, ${g.normalizedScore.ciHigh.toFixed(2)}] | ${g.meanAulcTokens.toFixed(3)} | ${g.paretoHypervolumeTokens.toFixed(3)} | ${g.meanTokens.toLocaleString()} | ${g.meanNominationLoss.toFixed(3)} | ${g.faultCount} |`,
		);
	}

	if (report.bottlenecks.length) {
		lines.push("", "## 2. Ranked Next-Cycle Bottlenecks", "", "| Rank | Bottleneck | Impact | Observed | Recommended Action |", "| ---: | --- | ---: | --- | --- |");
		for (const b of report.bottlenecks) {
			lines.push(`| #${b.rank} | **${b.name}** | ${b.impactScore.toFixed(3)} | ${b.metricValue} | ${b.recommendedAction} |`);
		}
	}

	if (report.taskHealth.length) {
		lines.push("", "## 3. Benchmark Health & Saturation Watchdog", "", "| Task | Tier | Family | Runs | Non-Solo Mean ± SD | Comm Lift | Status |", "| --- | --- | --- | ---: | ---: | ---: | :---: |");
		for (const t of report.taskHealth) {
			const liftStr = t.communicationLift !== undefined ? `${t.communicationLift >= 0 ? "+" : ""}${t.communicationLift.toFixed(3)}` : "—";
			lines.push(
				`| \`${t.taskId}\` | ${t.tier} | ${t.family} | ${t.runs} | ${t.nonSoloMeanNormalized.toFixed(3)} ± ${t.nonSoloStdDev.toFixed(3)} | ${liftStr} | **${t.status}** |`,
			);
		}
	}

	if (report.cusumAlerts.length) {
		lines.push("", "## 4. CUSUM Drift Alerts", "");
		for (const a of report.cusumAlerts) {
			lines.push(`- **${a.metric}** @ \`${a.triggeredAtLabel}\`: ${a.message}`);
		}
	}

	if (report.behavioralDiagnostics) {
		const bd = report.behavioralDiagnostics;
		lines.push(
			"",
			"## 5. Behavioral Failure Modes & Judge Calibration",
			"",
			`- **Indexed Runs:** ${bd.indexedRuns}/${bd.totalRuns} · **Unclassified Failed Runs:** ${bd.unclassifiedFailedRuns}/${bd.totalFailedRuns}`,
		);
		if (bd.buckets.length) {
			lines.push(
				"",
				"| Tag | Source | Failed Flagged | Failure Share | Failure Lift | Est. Lost Score |",
				"| --- | --- | ---: | ---: | ---: | ---: |",
			);
			for (const b of bd.buckets.slice(0, 10)) {
				lines.push(
					`| \`${b.judgeName}\` | ${b.source} | ${b.flaggedFailedRuns}/${bd.totalFailedRuns} | ${(b.failureShare * 100).toFixed(1)}% | **${b.failureLift.toFixed(2)}x** | ${b.estimatedLostScore.toFixed(2)} |`,
				);
			}
		}
		if (bd.judgeCalibration.length) {
			lines.push(
				"",
				"| Judge | Version | Audited | Precision | Recall | F1 | FNR | Status |",
				"| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
			);
			for (const c of bd.judgeCalibration) {
				lines.push(
					`| \`${c.judgeName}\` | \`${c.judgeVersion}\` | ${c.auditedCount} | ${(c.precision * 100).toFixed(1)}% | ${(c.recall * 100).toFixed(1)}% | ${(c.f1 * 100).toFixed(1)}% | ${(c.falseNegativeRate * 100).toFixed(1)}% | ${c.warning ? "WARNING" : "OK"} |`,
				);
			}
		}
	}

	return lines.join("\n") + "\n";
}
