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
