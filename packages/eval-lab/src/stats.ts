import type { PromotionBar, PromotionDecision, Scorecard } from "./contracts.ts";

export interface BootstrapInterval {
	mean: number;
	ciLow: number;
	ciHigh: number;
	n: number;
}

export interface PairedComparison {
	pairs: number;
	baselinePassRate: number;
	candidatePassRate: number;
	passRateGain: number;
	/** Candidate passed while baseline failed. */
	winsOnlyCandidate: number;
	/** Baseline passed while candidate failed. */
	winsOnlyBaseline: number;
	bothPassed: number;
	neitherPassed: number;
	mcnemarPValue: number;
	scoreGain: BootstrapInterval;
	tokenDeltaMean: number;
	wallClockRatio: number;
	baselineFaults: number;
	candidateFaults: number;
}

export interface CoordinationLiftReport {
	communicationLift?: PairedComparison;
	adaptationLift?: PairedComparison;
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function logFactorial(n: number): number {
	let sum = 0;
	for (let i = 2; i <= n; i++) sum += Math.log(i);
	return sum;
}

function binomPmf(k: number, n: number, p: number): number {
	if (k < 0 || k > n) return 0;
	const logCoeff = logFactorial(n) - logFactorial(k) - logFactorial(n - k);
	return Math.exp(logCoeff + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

/**
 * Exact two-sided McNemar test on discordant binary pairs (`b` = candidate-only wins,
 * `c` = baseline-only wins). Returns 1.0 when `b + c === 0`.
 */
export function mcnemarExact(winsOnlyCandidate: number, winsOnlyBaseline: number): number {
	const total = winsOnlyCandidate + winsOnlyBaseline;
	if (total === 0) return 1;
	const minTail = Math.min(winsOnlyCandidate, winsOnlyBaseline);
	let tailProb = 0;
	for (let k = 0; k <= minTail; k++) {
		tailProb += binomPmf(k, total, 0.5);
	}
	return Math.min(1, Math.round(2 * tailProb * 1e6) / 1e6);
}

/**
 * Deterministic paired percentile bootstrap confidence interval over seed-block differences.
 */
export function bootstrapCI(
	diffs: readonly number[],
	options: { resamples?: number; alpha?: number; seed?: number } = {},
): BootstrapInterval {
	const n = diffs.length;
	if (n === 0) return { mean: 0, ciLow: 0, ciHigh: 0, n: 0 };
	const mean = diffs.reduce((s, x) => s + x, 0) / n;
	if (n === 1) return { mean, ciLow: mean, ciHigh: mean, n: 1 };
	const resamples = options.resamples ?? 5000;
	const alpha = options.alpha ?? 0.05;
	const rand = mulberry32(options.seed ?? 42);
	const means = new Float64Array(resamples);
	for (let r = 0; r < resamples; r++) {
		let sum = 0;
		for (let i = 0; i < n; i++) {
			sum += diffs[Math.floor(rand() * n)]!;
		}
		means[r] = sum / n;
	}
	means.sort();
	const lowIdx = Math.max(0, Math.floor((alpha / 2) * resamples));
	const highIdx = Math.min(resamples - 1, Math.floor((1 - alpha / 2) * resamples));
	return {
		mean: Math.round(mean * 1e6) / 1e6,
		ciLow: Math.round(means[lowIdx]! * 1e6) / 1e6,
		ciHigh: Math.round(means[highIdx]! * 1e6) / 1e6,
		n,
	};
}

function pairKey(row: Scorecard): string {
	return `${row.taskId}::${row.reproducibility.seed}`;
}

/**
 * Strictly pair baseline and candidate scorecards by `(taskId, seed)`.
 * Unmatched seeds are ignored (and require at least 1 matched pair to compute deltas).
 */
export function pairedComparison(
	baselineRows: readonly Scorecard[],
	candidateRows: readonly Scorecard[],
	higherIsBetter = true,
): PairedComparison {
	const byKey = new Map<string, Scorecard>();
	for (const row of baselineRows) byKey.set(pairKey(row), row);

	const pairs: Array<{ base: Scorecard; cand: Scorecard }> = [];
	for (const cand of candidateRows) {
		const base = byKey.get(pairKey(cand));
		if (base) pairs.push({ base, cand });
	}
	if (!pairs.length) {
		return {
			pairs: 0,
			baselinePassRate: 0,
			candidatePassRate: 0,
			passRateGain: 0,
			winsOnlyCandidate: 0,
			winsOnlyBaseline: 0,
			bothPassed: 0,
			neitherPassed: 0,
			mcnemarPValue: 1,
			scoreGain: { mean: 0, ciLow: 0, ciHigh: 0, n: 0 },
			tokenDeltaMean: 0,
			wallClockRatio: 1,
			baselineFaults: 0,
			candidateFaults: 0,
		};
	}

	let winsOnlyCandidate = 0;
	let winsOnlyBaseline = 0;
	let bothPassed = 0;
	let neitherPassed = 0;
	let baselineFaults = 0;
	let candidateFaults = 0;
	let baseWallTotal = 0;
	let candWallTotal = 0;
	const scoreDiffs: number[] = [];
	const tokenDiffs: number[] = [];

	for (const { base, cand } of pairs) {
		if (base.deliveredPass && cand.deliveredPass) bothPassed++;
		else if (!base.deliveredPass && cand.deliveredPass) winsOnlyCandidate++;
		else if (base.deliveredPass && !cand.deliveredPass) winsOnlyBaseline++;
		else neitherPassed++;

		if (base.hasHarnessFault) baselineFaults++;
		if (cand.hasHarnessFault) candidateFaults++;
		baseWallTotal += base.time.wallClockMs;
		candWallTotal += cand.time.wallClockMs;

		const gain = higherIsBetter
			? cand.deliveredScore - base.deliveredScore
			: base.deliveredScore - cand.deliveredScore;
		scoreDiffs.push(gain);
		tokenDiffs.push(cand.tokens.total - base.tokens.total);
	}

	const n = pairs.length;
	const baselinePassRate = (bothPassed + winsOnlyBaseline) / n;
	const candidatePassRate = (bothPassed + winsOnlyCandidate) / n;
	return {
		pairs: n,
		baselinePassRate: Math.round(baselinePassRate * 1e4) / 1e4,
		candidatePassRate: Math.round(candidatePassRate * 1e4) / 1e4,
		passRateGain: Math.round((candidatePassRate - baselinePassRate) * 1e4) / 1e4,
		winsOnlyCandidate,
		winsOnlyBaseline,
		bothPassed,
		neitherPassed,
		mcnemarPValue: mcnemarExact(winsOnlyCandidate, winsOnlyBaseline),
		scoreGain: bootstrapCI(scoreDiffs),
		tokenDeltaMean: Math.round(tokenDiffs.reduce((s, x) => s + x, 0) / n),
		wallClockRatio: baseWallTotal > 0 ? Math.round((candWallTotal / baseWallTotal) * 1000) / 1000 : 1,
		baselineFaults,
		candidateFaults,
	};
}

/**
 * Compute true Coordination Lift:
 * - `communicationLift` = Adaptive Swarm − Silent Best-of-N (at matched total budget)
 * - `adaptationLift` = Adaptive Swarm − Static Scripted DAG (when scripted baseline exists)
 */
export function computeCoordinationLift(options: {
	swarmRows: readonly Scorecard[];
	silentBonRows?: readonly Scorecard[];
	scriptedDagRows?: readonly Scorecard[];
	higherIsBetter?: boolean;
}): CoordinationLiftReport {
	const higher = options.higherIsBetter ?? true;
	return {
		communicationLift: options.silentBonRows?.length
			? pairedComparison(options.silentBonRows, options.swarmRows, higher)
			: undefined,
		adaptationLift: options.scriptedDagRows?.length
			? pairedComparison(options.scriptedDagRows, options.swarmRows, higher)
			: undefined,
	};
}

/**
 * Evaluate a pre-registered promotion bar. Refuses to promote when seed count is below
 * `minSeeds`, any integrity/harness fault occurred above `maxIntegrityFaults`, or the
 * target gain / confidence bound is not met.
 */
export function evaluatePromotionBar(comparison: PairedComparison, bar: PromotionBar): PromotionDecision {
	if (comparison.candidateFaults > bar.maxIntegrityFaults) {
		return {
			verdict: "REJECT",
			reason: `Candidate had ${comparison.candidateFaults} harness/integrity fault(s) (max allowed: ${bar.maxIntegrityFaults}).`,
		};
	}
	if (comparison.pairs < bar.minSeeds) {
		return {
			verdict: "NO_DECISION",
			reason: `Only ${comparison.pairs} paired seeds completed (requires >= ${bar.minSeeds} before promotion).`,
		};
	}
	if (bar.minPassRateGain !== undefined && comparison.passRateGain < bar.minPassRateGain) {
		return {
			verdict: comparison.passRateGain < 0 ? "REJECT" : "NO_DECISION",
			reason: `Pass-rate gain ${(comparison.passRateGain * 100).toFixed(1)}pp is below pre-registered bar ${(bar.minPassRateGain * 100).toFixed(1)}pp.`,
		};
	}
	if (bar.minScoreGain !== undefined && comparison.scoreGain.mean < bar.minScoreGain) {
		return {
			verdict: comparison.scoreGain.mean < 0 ? "REJECT" : "NO_DECISION",
			reason: `Mean score gain ${comparison.scoreGain.mean.toFixed(4)} is below pre-registered bar ${bar.minScoreGain.toFixed(4)}.`,
		};
	}
	if (bar.requireCiAboveZero && comparison.scoreGain.ciLow <= 0) {
		return {
			verdict: "NO_DECISION",
			reason: `95% bootstrap CI [${comparison.scoreGain.ciLow.toFixed(4)}, ${comparison.scoreGain.ciHigh.toFixed(4)}] includes zero.`,
		};
	}
	return {
		verdict: "PROMOTE",
		reason: `Met promotion bar across ${comparison.pairs} paired seeds (pass gain ${(comparison.passRateGain * 100).toFixed(1)}pp, score gain ${comparison.scoreGain.mean.toFixed(4)}, 0 integrity faults).`,
	};
}

export interface ScalingPoint {
	readonly n: number;
	readonly runs: number;
	readonly passRate: number;
	readonly meanScore: number;
	readonly meanAulcTokens: number;
	readonly meanTokens: number;
	readonly meanWallClockMs: number;
	/** Speedup S(N) = T(1) / T(N) relative to smallest N baseline. */
	readonly speedupS: number;
	/** Parallel efficiency E(N) = S(N) / (N / N_base). */
	readonly parallelEfficiencyE: number;
	/** Karp-Flatt empirical serial fraction f = (1/S - 1/N) / (1 - 1/N) for N > 1. */
	readonly karpFlattSerialFraction?: number;
}

/**
 * Compute empirical parallel scaling curves across swarm sizes `N ∈ {1, 2, 4, 8, ...}`:
 * Speedup S(N), Parallel Efficiency E(N), and Karp-Flatt serial fraction f.
 */
export function computeScalingLaws(scorecards: readonly Scorecard[]): ScalingPoint[] {
	const byN = new Map<number, Scorecard[]>();
	for (const s of scorecards) {
		if (s.hasHarnessFault) continue;
		const n = Math.max(1, s.dynamics.swarmSize);
		const arr = byN.get(n) ?? [];
		arr.push(s);
		byN.set(n, arr);
	}
	const ns = [...byN.keys()].sort((a, b) => a - b);
	if (!ns.length) return [];
	const baseN = ns[0]!;
	const baseRows = byN.get(baseN)!;
	const baseWall = baseRows.reduce((acc, r) => acc + r.time.wallClockMs, 0) / baseRows.length;

	return ns.map((n) => {
		const rows = byN.get(n)!;
		const avg = (fn: (s: Scorecard) => number) => rows.reduce((acc, r) => acc + fn(r), 0) / rows.length;
		const meanWallClockMs = avg((r) => r.time.wallClockMs);
		const speedupS = meanWallClockMs > 0 && baseWall > 0 ? Math.round((baseWall / meanWallClockMs) * 1000) / 1000 : 1;
		const relN = n / baseN;
		const parallelEfficiencyE = relN > 0 ? Math.round((speedupS / relN) * 1000) / 1000 : 1;
		const karpFlattSerialFraction =
			relN > 1 && speedupS > 0
				? Math.round((((1 / speedupS) - (1 / relN)) / (1 - 1 / relN)) * 10000) / 10000
				: undefined;
		return {
			n,
			runs: rows.length,
			passRate: Math.round((rows.filter((r) => r.deliveredPass).length / rows.length) * 10000) / 10000,
			meanScore: Math.round(avg((r) => r.deliveredScore) * 10000) / 10000,
			meanAulcTokens: Math.round(avg((r) => r.anytime?.aulcTokens ?? 0) * 10000) / 10000,
			meanTokens: Math.round(avg((r) => r.tokens.total)),
			meanWallClockMs: Math.round(meanWallClockMs),
			speedupS,
			parallelEfficiencyE,
			...(karpFlattSerialFraction !== undefined ? { karpFlattSerialFraction } : {}),
		};
	});
}

export interface RouterRegretTaskRow {
	readonly taskId: string;
	readonly adaptiveScore: number;
	readonly oracleScore: number;
	readonly oracleTopology: string;
	readonly regret: number;
	readonly normalizedRegret: number;
}

export interface RouterRegretReport {
	readonly adaptiveTopology: string;
	readonly tasksEvaluated: number;
	readonly meanRegret: number;
	readonly meanNormalizedRegret: number;
	readonly maxRegret: number;
	readonly perTask: readonly RouterRegretTaskRow[];
}

/**
 * Compute Adaptive Meta-Router Oracle Regret across tasks:
 * `regret(task) = max_{t in staticTopologies} meanScore(t) - meanScore(adaptive)`.
 */
export function computeRouterRegret(
	scorecards: readonly Scorecard[],
	adaptiveTopology = "adaptive",
): RouterRegretReport {
	const byTask = new Map<string, Map<string, number[]>>();
	for (const s of scorecards) {
		if (s.hasHarnessFault) continue;
		const topo = s.reproducibility.topology;
		const taskMap = byTask.get(s.taskId) ?? new Map<string, number[]>();
		const list = taskMap.get(topo) ?? [];
		list.push(s.deliveredScore);
		taskMap.set(topo, list);
		byTask.set(s.taskId, taskMap);
	}

	const perTask: RouterRegretTaskRow[] = [];
	for (const [taskId, topoMap] of [...byTask.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		const adaptiveScores = topoMap.get(adaptiveTopology);
		if (!adaptiveScores?.length) continue;
		const adaptiveMean = adaptiveScores.reduce((s, x) => s + x, 0) / adaptiveScores.length;
		let oracleScore = adaptiveMean;
		let oracleTopology = adaptiveTopology;
		for (const [topo, vals] of topoMap.entries()) {
			if (!vals.length) continue;
			const m = vals.reduce((s, x) => s + x, 0) / vals.length;
			if (m > oracleScore) {
				oracleScore = m;
				oracleTopology = topo;
			}
		}
		const regret = Math.max(0, Math.round((oracleScore - adaptiveMean) * 1e6) / 1e6);
		const normalizedRegret = oracleScore > 0 ? Math.round((regret / oracleScore) * 1e4) / 1e4 : 0;
		perTask.push({
			taskId,
			adaptiveScore: Math.round(adaptiveMean * 1e4) / 1e4,
			oracleScore: Math.round(oracleScore * 1e4) / 1e4,
			oracleTopology,
			regret,
			normalizedRegret,
		});
	}

	const n = perTask.length;
	return {
		adaptiveTopology,
		tasksEvaluated: n,
		meanRegret: n ? Math.round((perTask.reduce((s, r) => s + r.regret, 0) / n) * 1e6) / 1e6 : 0,
		meanNormalizedRegret: n ? Math.round((perTask.reduce((s, r) => s + r.normalizedRegret, 0) / n) * 1e4) / 1e4 : 0,
		maxRegret: n ? Math.max(...perTask.map((r) => r.regret)) : 0,
		perTask,
	};
}

/**
 * Exact Benjamini-Hochberg False Discovery Rate (FDR) step-up p-value adjustment.
 * Preserves input ordering and clamps q-values to [0, 1].
 */
export function benjaminiHochberg(pValues: readonly number[]): number[] {
	const m = pValues.length;
	if (m === 0) return [];
	const indexed = pValues.map((p, i) => ({ i, p: Math.max(0, Math.min(1, Number.isFinite(p) ? p : 1)) }));
	indexed.sort((a, b) => a.p - b.p);
	const adjusted = new Array<number>(m);
	let runningMin = 1;
	for (let rank = m; rank >= 1; rank--) {
		const item = indexed[rank - 1]!;
		const q = Math.min(runningMin, (item.p * m) / rank);
		runningMin = q;
		adjusted[item.i] = Math.round(Math.min(1, q) * 1e6) / 1e6;
	}
	return adjusted;
}
