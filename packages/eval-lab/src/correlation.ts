import type { Scorecard } from "./contracts.ts";

export interface CorrelationStats {
	n: number;
	pearsonR: number;
	spearmanRho: number;
	kendallTauB: number;
	/** Two-sided permutation p-value on Spearman's rho. */
	permutationPValue: number;
	direction: "positive" | "negative" | "neutral" | "insufficient";
}

export interface ProxyTargetPairCorrelation {
	proxyTaskId: string;
	targetTaskId: string;
	sharedArms: string[];
	scoreCorrelation: CorrelationStats;
	passRateCorrelation: CorrelationStats;
	efficiencyCorrelation: CorrelationStats;
}

export interface DiagnosticTransferEntry {
	metric: string;
	targetTaskId: string;
	correlation: CorrelationStats;
}

export interface ProxyToTargetReport {
	armKeys: string[];
	proxyTaskIds: string[];
	targetTaskIds: string[];
	/** Number of faulted runs excluded before computing correlations. */
	excludedFaultedRuns: number;
	/** Warnings emitted when an arm pools multiple git SHAs or has partial task coverage. */
	integrityWarnings: string[];
	/** Tasks with zero variance across arms (saturated proxies/targets). */
	saturatedTaskIds: string[];
	/** Per-arm aggregated scores on each task. */
	armTaskTable: Record<
		string,
		Record<
			string,
			{
				runs: number;
				meanScore: number;
				passRate: number;
				meanTokens: number;
				efficiency: number;
				meanNominationLoss: number;
				meanCoordShare: number;
				meanToolErrorRate: number;
				gitShas: string[];
			}
		>
	>;
	/** Pairwise proxy -> target rank correlations across all shared arms. */
	pairwise: ProxyTargetPairCorrelation[];
	/** Composite normalized proxy rank vs composite normalized long-horizon rank (non-saturated tasks). */
	composite: {
		sharedArms: string[];
		perArmComposite: Array<{
			arm: string;
			proxyComposite: number;
			targetComposite: number;
			proxyEfficiency: number;
			targetEfficiency: number;
			proxyTasksCovered: number;
			targetTasksCovered: number;
		}>;
		scoreCorrelation: CorrelationStats;
		passRateCorrelation: CorrelationStats;
		efficiencyCorrelation: CorrelationStats;
	};
	/** Strictly balanced composite restricted to tasks covered by ALL participating arms (eliminates Simpson's paradox). */
	balancedComposite: {
		sharedArms: string[];
		proxyTaskIds: string[];
		targetTaskIds: string[];
		perArmComposite: Array<{ arm: string; proxyComposite: number; targetComposite: number }>;
		scoreCorrelation: CorrelationStats;
	};
	/** Diagnostic proxy metrics (e.g. coordination share, nomination loss) vs target delivered score. */
	diagnosticTransfers: DiagnosticTransferEntry[];
}

export interface DeltaTransferArmRow {
	arm: string;
	baselineProxy: number;
	candidateProxy: number;
	deltaProxy: number;
	baselineTarget: number;
	candidateTarget: number;
	deltaTarget: number;
}

export interface DeltaTransferReport {
	proxyTaskId: string;
	targetTaskId: string;
	arms: DeltaTransferArmRow[];
	deltaCorrelation: CorrelationStats;
	pooledCorrelation: CorrelationStats;
}

function round6(x: number): number {
	return Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : 0;
}

/** Assign average mid-ranks (1-based) with exact tie handling. */
export function averageRanks(values: readonly number[]): number[] {
	const n = values.length;
	const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
	const ranks = new Array<number>(n);
	let i = 0;
	while (i < n) {
		let j = i;
		while (j + 1 < n && Math.abs(indexed[j + 1]!.v - indexed[i]!.v) <= 1e-12) {
			j++;
		}
		const avgRank = (i + j) / 2 + 1;
		for (let k = i; k <= j; k++) {
			ranks[indexed[k]!.i] = avgRank;
		}
		i = j + 1;
	}
	return ranks;
}

/** Sample Pearson correlation coefficient r in [-1, 1]. Returns 0 on constant series. */
export function pearsonCorrelation(xs: readonly number[], ys: readonly number[]): number {
	const n = Math.min(xs.length, ys.length);
	if (n < 2) return 0;
	let mx = 0;
	let my = 0;
	for (let i = 0; i < n; i++) {
		mx += xs[i]!;
		my += ys[i]!;
	}
	mx /= n;
	my /= n;
	let num = 0;
	let dx2 = 0;
	let dy2 = 0;
	for (let i = 0; i < n; i++) {
		const dx = xs[i]! - mx;
		const dy = ys[i]! - my;
		num += dx * dy;
		dx2 += dx * dx;
		dy2 += dy * dy;
	}
	const denom = Math.sqrt(dx2 * dy2);
	if (denom <= 1e-15) return 0;
	return round6(Math.max(-1, Math.min(1, num / denom)));
}

/** Spearman's rank correlation rho (Pearson on average mid-ranks). */
export function spearmanRankCorrelation(xs: readonly number[], ys: readonly number[]): number {
	const n = Math.min(xs.length, ys.length);
	if (n < 2) return 0;
	const rx = averageRanks(xs.slice(0, n));
	const ry = averageRanks(ys.slice(0, n));
	return pearsonCorrelation(rx, ry);
}

/** Tie-adjusted Kendall's tau-b in [-1, 1]. */
export function kendallTauB(xs: readonly number[], ys: readonly number[]): number {
	const n = Math.min(xs.length, ys.length);
	if (n < 2) return 0;
	let concordant = 0;
	let discordant = 0;
	let tiesX = 0;
	let tiesY = 0;
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const dx = xs[i]! - xs[j]!;
			const dy = ys[i]! - ys[j]!;
			const tx = Math.abs(dx) <= 1e-12;
			const ty = Math.abs(dy) <= 1e-12;
			if (tx && ty) continue;
			if (tx) tiesX++;
			else if (ty) tiesY++;
			else if (dx * dy > 0) concordant++;
			else discordant++;
		}
	}
	const denom = Math.sqrt((concordant + discordant + tiesX) * (concordant + discordant + tiesY));
	if (denom <= 1e-15) return 0;
	return round6((concordant - discordant) / denom);
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

function spearmanPermutationPValue(xs: readonly number[], ys: readonly number[], seed = 42): number {
	const n = Math.min(xs.length, ys.length);
	if (n < 3) return 1;
	const rx = averageRanks(xs.slice(0, n));
	const ry = averageRanks(ys.slice(0, n));
	const obs = Math.abs(pearsonCorrelation(rx, ry));
	if (obs <= 1e-12) return 1;

	// Exact enumeration for n <= 7 (<= 5,040 permutations); deterministic Monte-Carlo for n >= 8.
	if (n <= 7) {
		const perm = [...ry];
		let total = 0;
		let extreme = 0;
		const swap = (a: number, b: number) => {
			const tmp = perm[a]!;
			perm[a] = perm[b]!;
			perm[b] = tmp;
		};
		const heap = (k: number) => {
			if (k === 1) {
				total++;
				if (Math.abs(pearsonCorrelation(rx, perm)) >= obs - 1e-12) extreme++;
				return;
			}
			heap(k - 1);
			for (let i = 0; i < k - 1; i++) {
				swap(k % 2 === 0 ? i : 0, k - 1);
				heap(k - 1);
			}
		};
		heap(n);
		return round6(extreme / Math.max(1, total));
	}

	const rand = mulberry32(seed);
	const perm = [...ry];
	const resamples = 10_000;
	let extreme = 0;
	for (let r = 0; r < resamples; r++) {
		for (let i = n - 1; i > 0; i--) {
			const j = Math.floor(rand() * (i + 1));
			const tmp = perm[i]!;
			perm[i] = perm[j]!;
			perm[j] = tmp;
		}
		if (Math.abs(pearsonCorrelation(rx, perm)) >= obs - 1e-12) extreme++;
	}
	return round6((extreme + 1) / (resamples + 1));
}

export function computeCorrelationStats(xs: readonly number[], ys: readonly number[]): CorrelationStats {
	const n = Math.min(xs.length, ys.length);
	if (n < 3) {
		return {
			n,
			pearsonR: n === 2 ? pearsonCorrelation(xs, ys) : 0,
			spearmanRho: n === 2 ? spearmanRankCorrelation(xs, ys) : 0,
			kendallTauB: n === 2 ? kendallTauB(xs, ys) : 0,
			permutationPValue: 1,
			direction: "insufficient",
		};
	}
	const pearsonR = pearsonCorrelation(xs, ys);
	const spearmanRho = spearmanRankCorrelation(xs, ys);
	const tau = kendallTauB(xs, ys);
	const permutationPValue = spearmanPermutationPValue(xs, ys);
	const direction: CorrelationStats["direction"] =
		spearmanRho >= 0.25 ? "positive" : spearmanRho <= -0.25 ? "negative" : "neutral";
	return { n, pearsonR, spearmanRho, kendallTauB: tau, permutationPValue, direction };
}

/** Derive a stable arm key identifying a harness/topology configuration across tasks. */
export function defaultArmKey(card: Scorecard): string {
	return `${card.reproducibility.controlRung}:${card.reproducibility.topology}:n${card.dynamics.swarmSize}`;
}

/**
 * Analyze whether progress across harness configurations on fast/proxy benchmarks
 * correlates positively with progress on harder longer-horizon benchmarks.
 */
export function analyzeProxyToTargetCorrelation(
	scorecards: readonly Scorecard[],
	options: {
		proxyTaskIds: readonly string[];
		targetTaskIds: readonly string[];
		armKeyFn?: (card: Scorecard) => string;
		/** Exclude runs with `hasHarnessFault === true` (default true). */
		excludeFaulted?: boolean;
		/** Throw an error if pooled runs mix distinct harnessGitSha or dirtyDiffSha manifests (default false). */
		strictManifest?: boolean;
	},
): ProxyToTargetReport {
	const armKeyFn = options.armKeyFn ?? defaultArmKey;
	const excludeFaulted = options.excludeFaulted ?? true;
	const strictManifest = options.strictManifest ?? false;
	const proxySet = new Set(options.proxyTaskIds);
	const targetSet = new Set(options.targetTaskIds);

	let excludedFaultedRuns = 0;
	const cleanCards: Scorecard[] = [];
	for (const card of scorecards) {
		if (excludeFaulted && card.hasHarnessFault) {
			excludedFaultedRuns += 1;
			continue;
		}
		cleanCards.push(card);
	}

	const grouped = new Map<string, Map<string, Scorecard[]>>();
	for (const card of cleanCards) {
		const arm = armKeyFn(card);
		if (!grouped.has(arm)) grouped.set(arm, new Map());
		const byTask = grouped.get(arm)!;
		if (!byTask.has(card.taskId)) byTask.set(card.taskId, []);
		byTask.get(card.taskId)!.push(card);
	}

	const armKeys = [...grouped.keys()].sort();
	const armTaskTable: ProxyToTargetReport["armTaskTable"] = {};
	const integrityWarnings: string[] = [];

	for (const arm of armKeys) {
		armTaskTable[arm] = {};
		for (const [taskId, rows] of grouped.get(arm)!.entries()) {
			const avg = (fn: (s: Scorecard) => number) => rows.reduce((acc, r) => acc + fn(r), 0) / rows.length;
			const meanScore = avg((r) => r.deliveredScore);
			const passRate = rows.filter((r) => r.deliveredPass).length / rows.length;
			const meanTokens = avg((r) => r.tokens.total);
			const efficiency = meanScore / Math.max(0.1, meanTokens / 100_000);
			const gitShas = [...new Set(rows.map((r) => r.reproducibility?.harnessGitSha).filter((s): s is string => Boolean(s)))].sort();
			const dirtyShas = [...new Set(rows.map((r) => r.reproducibility?.dirtyDiffSha).filter((s): s is string => Boolean(s)))].sort();
			if (gitShas.length > 1) {
				const msg = `Arm "${arm}" on "${taskId}" pools ${gitShas.length} distinct harness commits (${gitShas.map((s) => s.slice(0, 7)).join(", ")})`;
				integrityWarnings.push(msg);
				if (strictManifest) throw new Error(`Strict manifest violation: ${msg}`);
			}
			if (dirtyShas.length > 1) {
				const msg = `Arm "${arm}" on "${taskId}" pools ${dirtyShas.length} distinct dirty-tree digests`;
				integrityWarnings.push(msg);
				if (strictManifest) throw new Error(`Strict manifest violation: ${msg}`);
			}
			armTaskTable[arm]![taskId] = {
				runs: rows.length,
				meanScore: round6(meanScore),
				passRate: round6(passRate),
				meanTokens: Math.round(meanTokens),
				efficiency: round6(efficiency),
				meanNominationLoss: round6(avg((r) => r.losses.nominationLoss)),
				meanCoordShare: round6(avg((r) => r.tokens.coordinationTokenShare)),
				meanToolErrorRate: round6(avg((r) => r.dynamics.toolErrorRate)),
				gitShas,
			};
		}
	}

	// Pairwise proxy -> target correlations across all arms that ran both tasks
	const pairwise: ProxyTargetPairCorrelation[] = [];
	for (const proxyTaskId of options.proxyTaskIds) {
		for (const targetTaskId of options.targetTaskIds) {
			const sharedArms = armKeys.filter((a) => armTaskTable[a]?.[proxyTaskId] && armTaskTable[a]?.[targetTaskId]);
			const pxScore = sharedArms.map((a) => armTaskTable[a]![proxyTaskId]!.meanScore);
			const tgScore = sharedArms.map((a) => armTaskTable[a]![targetTaskId]!.meanScore);
			const pxPass = sharedArms.map((a) => armTaskTable[a]![proxyTaskId]!.passRate);
			const tgPass = sharedArms.map((a) => armTaskTable[a]![targetTaskId]!.passRate);
			const pxEff = sharedArms.map((a) => armTaskTable[a]![proxyTaskId]!.efficiency);
			const tgEff = sharedArms.map((a) => armTaskTable[a]![targetTaskId]!.efficiency);
			pairwise.push({
				proxyTaskId,
				targetTaskId,
				sharedArms,
				scoreCorrelation: computeCorrelationStats(pxScore, tgScore),
				passRateCorrelation: computeCorrelationStats(pxPass, tgPass),
				efficiencyCorrelation: computeCorrelationStats(pxEff, tgEff),
			});
		}
	}

	// Min-max normalize each task across arms so unbounded objectives (e.g. VLIW speedup, circle radius sum)
	// combine fairly with [0, 1] benchmarks in the composite rank.
	const taskRange = new Map<string, { min: number; max: number }>();
	const effRange = new Map<string, { min: number; max: number }>();
	const saturatedTaskIds: string[] = [];
	for (const taskId of [...proxySet, ...targetSet]) {
		const vals = armKeys
			.map((a) => armTaskTable[a]?.[taskId]?.meanScore)
			.filter((v): v is number => typeof v === "number");
		if (vals.length) {
			const min = Math.min(...vals);
			const max = Math.max(...vals);
			taskRange.set(taskId, { min, max });
			if (Math.abs(max - min) <= 1e-12) saturatedTaskIds.push(taskId);
		}
		const effs = armKeys
			.map((a) => armTaskTable[a]?.[taskId]?.efficiency)
			.filter((v): v is number => typeof v === "number");
		if (effs.length) {
			effRange.set(taskId, { min: Math.min(...effs), max: Math.max(...effs) });
		}
	}
	const saturatedSet = new Set(saturatedTaskIds);
	const normTaskScore = (taskId: string, val: number): number => {
		const r = taskRange.get(taskId);
		if (!r || Math.abs(r.max - r.min) <= 1e-12) return 0.5;
		return (val - r.min) / (r.max - r.min);
	};
	const normTaskEff = (taskId: string, val: number): number => {
		const r = effRange.get(taskId);
		if (!r || Math.abs(r.max - r.min) <= 1e-12) return 0.5;
		return (val - r.min) / (r.max - r.min);
	};

	const activeProxyTasks = options.proxyTaskIds.filter((t) => !saturatedSet.has(t));
	const effectiveProxyTasks = activeProxyTasks.length ? activeProxyTasks : [...options.proxyTaskIds];
	const activeTargetTasks = options.targetTaskIds.filter((t) => !saturatedSet.has(t));
	const effectiveTargetTasks = activeTargetTasks.length ? activeTargetTasks : [...options.targetTaskIds];

	const compositeArms = armKeys.filter(
		(a) =>
			effectiveProxyTasks.some((t) => Boolean(armTaskTable[a]?.[t])) &&
			effectiveTargetTasks.some((t) => Boolean(armTaskTable[a]?.[t])),
	);
	const perArmComposite = compositeArms.map((arm) => {
		const pTasks = effectiveProxyTasks.filter((t) => Boolean(armTaskTable[arm]?.[t]));
		const tTasks = effectiveTargetTasks.filter((t) => Boolean(armTaskTable[arm]?.[t]));
		const proxyComposite =
			pTasks.reduce((s, t) => s + normTaskScore(t, armTaskTable[arm]![t]!.meanScore), 0) / pTasks.length;
		const targetComposite =
			tTasks.reduce((s, t) => s + normTaskScore(t, armTaskTable[arm]![t]!.meanScore), 0) / tTasks.length;
		const allPTasks = options.proxyTaskIds.filter((t) => Boolean(armTaskTable[arm]?.[t]));
		const allTTasks = options.targetTaskIds.filter((t) => Boolean(armTaskTable[arm]?.[t]));
		const proxyEfficiency =
			allPTasks.reduce((s, t) => s + normTaskEff(t, armTaskTable[arm]![t]!.efficiency), 0) / Math.max(1, allPTasks.length);
		const targetEfficiency =
			allTTasks.reduce((s, t) => s + normTaskEff(t, armTaskTable[arm]![t]!.efficiency), 0) / Math.max(1, allTTasks.length);
		return {
			arm,
			proxyComposite: round6(proxyComposite),
			targetComposite: round6(targetComposite),
			proxyEfficiency: round6(proxyEfficiency),
			targetEfficiency: round6(targetEfficiency),
			proxyTasksCovered: pTasks.length,
			targetTasksCovered: tTasks.length,
		};
	});

	const unbalancedArms = perArmComposite.filter(
		(row) => row.proxyTasksCovered < effectiveProxyTasks.length || row.targetTasksCovered < effectiveTargetTasks.length,
	);
	if (unbalancedArms.length > 0) {
		integrityWarnings.push(
			`Unbalanced composite coverage: ${unbalancedArms.map((r) => `${r.arm} (${r.proxyTasksCovered}/${effectiveProxyTasks.length} proxy, ${r.targetTasksCovered}/${effectiveTargetTasks.length} target)`).join("; ")} — consult balancedComposite for apples-to-apples comparison.`,
		);
	}

	// Strictly balanced composite: choose the largest subset of non-saturated tasks covered by ALL arms
	// (or, if none cover all arms, restrict to arms covering the most common proxy+target task pair).
	const commonProxyTasks = effectiveProxyTasks.filter((t) => compositeArms.every((a) => Boolean(armTaskTable[a]?.[t])));
	const commonTargetTasks = effectiveTargetTasks.filter((t) => compositeArms.every((a) => Boolean(armTaskTable[a]?.[t])));
	let balArms = compositeArms;
	let balProxyTasks = commonProxyTasks;
	let balTargetTasks = commonTargetTasks;
	if (!balProxyTasks.length || !balTargetTasks.length) {
		// Fall back to arms that cover ALL effective proxy & target tasks
		const fullArms = compositeArms.filter(
			(a) =>
				effectiveProxyTasks.every((t) => Boolean(armTaskTable[a]?.[t])) &&
				effectiveTargetTasks.every((t) => Boolean(armTaskTable[a]?.[t])),
		);
		if (fullArms.length >= 3) {
			balArms = fullArms;
			balProxyTasks = effectiveProxyTasks;
			balTargetTasks = effectiveTargetTasks;
		} else {
			// Pick the non-saturated proxy & target tasks with maximum arm coverage
			const bestP = [...effectiveProxyTasks].sort(
				(a, b) => compositeArms.filter((x) => armTaskTable[x]?.[b]).length - compositeArms.filter((x) => armTaskTable[x]?.[a]).length,
			)[0];
			const bestT = [...effectiveTargetTasks].sort(
				(a, b) => compositeArms.filter((x) => armTaskTable[x]?.[b]).length - compositeArms.filter((x) => armTaskTable[x]?.[a]).length,
			)[0];
			balProxyTasks = bestP ? [bestP] : [];
			balTargetTasks = bestT ? [bestT] : [];
			balArms = compositeArms.filter(
				(a) =>
					balProxyTasks.every((t) => Boolean(armTaskTable[a]?.[t])) &&
					balTargetTasks.every((t) => Boolean(armTaskTable[a]?.[t])),
			);
		}
	}
	const balPerArm = balArms.map((arm) => ({
		arm,
		proxyComposite: round6(
			balProxyTasks.reduce((s, t) => s + normTaskScore(t, armTaskTable[arm]![t]!.meanScore), 0) / Math.max(1, balProxyTasks.length),
		),
		targetComposite: round6(
			balTargetTasks.reduce((s, t) => s + normTaskScore(t, armTaskTable[arm]![t]!.meanScore), 0) / Math.max(1, balTargetTasks.length),
		),
	}));

	const compPxPass = compositeArms.map((arm) => {
		const pTasks = effectiveProxyTasks.filter((t) => Boolean(armTaskTable[arm]?.[t]));
		return pTasks.reduce((s, t) => s + armTaskTable[arm]![t]!.passRate, 0) / pTasks.length;
	});
	const compTgPass = compositeArms.map((arm) => {
		const tTasks = effectiveTargetTasks.filter((t) => Boolean(armTaskTable[arm]?.[t]));
		return tTasks.reduce((s, t) => s + armTaskTable[arm]![t]!.passRate, 0) / tTasks.length;
	});

	// Diagnostic proxy metrics vs target scores
	const diagnosticTransfers: DiagnosticTransferEntry[] = [];
	const diagnosticMetrics: Array<{ name: string; extract: (m: ProxyToTargetReport["armTaskTable"][string][string]) => number }> = [
		{ name: "proxy.nominationLoss", extract: (m) => m.meanNominationLoss },
		{ name: "proxy.coordinationTokenShare", extract: (m) => m.meanCoordShare },
		{ name: "proxy.toolErrorRate", extract: (m) => m.meanToolErrorRate },
	];
	for (const targetTaskId of options.targetTaskIds) {
		const armsForTarget = compositeArms.filter((a) => Boolean(armTaskTable[a]?.[targetTaskId]));
		const ys = armsForTarget.map((a) => armTaskTable[a]![targetTaskId]!.meanScore);
		for (const dm of diagnosticMetrics) {
			const xs = armsForTarget.map((arm) => {
				const pTasks = options.proxyTaskIds.filter((t) => Boolean(armTaskTable[arm]?.[t]));
				return pTasks.reduce((s, t) => s + dm.extract(armTaskTable[arm]![t]!), 0) / Math.max(1, pTasks.length);
			});
			diagnosticTransfers.push({
				metric: dm.name,
				targetTaskId,
				correlation: computeCorrelationStats(xs, ys),
			});
		}
	}

	return {
		armKeys,
		proxyTaskIds: [...options.proxyTaskIds],
		targetTaskIds: [...options.targetTaskIds],
		excludedFaultedRuns,
		integrityWarnings,
		saturatedTaskIds,
		armTaskTable,
		pairwise,
		composite: {
			sharedArms: compositeArms,
			perArmComposite,
			scoreCorrelation: computeCorrelationStats(
				perArmComposite.map((p) => p.proxyComposite),
				perArmComposite.map((p) => p.targetComposite),
			),
			passRateCorrelation: computeCorrelationStats(compPxPass, compTgPass),
			efficiencyCorrelation: computeCorrelationStats(
				perArmComposite.map((p) => p.proxyEfficiency),
				perArmComposite.map((p) => p.targetEfficiency),
			),
		},
		balancedComposite: {
			sharedArms: balArms,
			proxyTaskIds: balProxyTasks,
			targetTaskIds: balTargetTasks,
			perArmComposite: balPerArm,
			scoreCorrelation: computeCorrelationStats(
				balPerArm.map((p) => p.proxyComposite),
				balPerArm.map((p) => p.targetComposite),
			),
		},
		diagnosticTransfers,
	};
}

/**
 * Paired RSI version delta-transfer analysis: tests whether harness-version improvements
 * (deltaProxy = candidate - baseline) correlate positively with long-horizon gains (deltaTarget).
 */
export function analyzeDeltaTransferCorrelation(
	baselineCards: readonly Scorecard[],
	candidateCards: readonly Scorecard[],
	options: {
		proxyTaskId: string;
		targetTaskId: string;
		armKeyFn?: (card: Scorecard) => string;
		excludeFaulted?: boolean;
	},
): DeltaTransferReport {
	const armKeyFn = options.armKeyFn ?? defaultArmKey;
	const excludeFaulted = options.excludeFaulted ?? true;
	const aggregate = (cards: readonly Scorecard[], taskId: string): Map<string, number> => {
		const buckets = new Map<string, number[]>();
		for (const c of cards) {
			if (excludeFaulted && c.hasHarnessFault) continue;
			if (c.taskId !== taskId) continue;
			const arm = armKeyFn(c);
			if (!buckets.has(arm)) buckets.set(arm, []);
			buckets.get(arm)!.push(c.deliveredScore);
		}
		const out = new Map<string, number>();
		for (const [arm, vals] of buckets.entries()) {
			out.set(arm, vals.reduce((a, b) => a + b, 0) / vals.length);
		}
		return out;
	};

	const baseP = aggregate(baselineCards, options.proxyTaskId);
	const candP = aggregate(candidateCards, options.proxyTaskId);
	const baseT = aggregate(baselineCards, options.targetTaskId);
	const candT = aggregate(candidateCards, options.targetTaskId);

	const sharedArms = [...baseP.keys()]
		.filter((a) => candP.has(a) && baseT.has(a) && candT.has(a))
		.sort();

	const arms: DeltaTransferArmRow[] = sharedArms.map((arm) => {
		const bp = baseP.get(arm)!;
		const cp = candP.get(arm)!;
		const bt = baseT.get(arm)!;
		const ct = candT.get(arm)!;
		return {
			arm,
			baselineProxy: round6(bp),
			candidateProxy: round6(cp),
			deltaProxy: round6(cp - bp),
			baselineTarget: round6(bt),
			candidateTarget: round6(ct),
			deltaTarget: round6(ct - bt),
		};
	});

	const pooledX = arms.flatMap((r) => [r.baselineProxy, r.candidateProxy]);
	const pooledY = arms.flatMap((r) => [r.baselineTarget, r.candidateTarget]);

	return {
		proxyTaskId: options.proxyTaskId,
		targetTaskId: options.targetTaskId,
		arms,
		deltaCorrelation: computeCorrelationStats(
			arms.map((r) => r.deltaProxy),
			arms.map((r) => r.deltaTarget),
		),
		pooledCorrelation: computeCorrelationStats(pooledX, pooledY),
	};
}

export function renderCorrelationReport(report: ProxyToTargetReport): string {
	const lines: string[] = [
		"# Proxy-to-Long-Horizon Benchmark Correlation Report",
		"",
		`- **Harness Arms (${report.armKeys.length}):** ${report.armKeys.map((a) => `\`${a}\``).join(", ") || "(none)"}`,
		`- **Proxy Benchmarks:** ${report.proxyTaskIds.map((t) => `\`${t}\``).join(", ")}`,
		`- **Long-Horizon Target Benchmarks:** ${report.targetTaskIds.map((t) => `\`${t}\``).join(", ")}`,
		`- **Excluded Faulted Runs:** ${report.excludedFaultedRuns}`,
		...(report.saturatedTaskIds.length
			? [`- **Saturated (Zero-Variance) Tasks Excluded from Score Composite:** ${report.saturatedTaskIds.map((t) => `\`${t}\``).join(", ")}`]
			: []),
		...(report.integrityWarnings.length
			? ["", "> [!WARNING] **Correlation Integrity Checks**", ...report.integrityWarnings.map((w) => `> - ${w}`)]
			: []),
		"",
		"## Composite Proxy vs Long-Horizon Transfer",
		"",
		`- **Score Rank Correlation (non-saturated):** Spearman $\\rho = ${report.composite.scoreCorrelation.spearmanRho.toFixed(3)}$, Kendall $\\tau_b = ${report.composite.scoreCorrelation.kendallTauB.toFixed(3)}$, Pearson $r = ${report.composite.scoreCorrelation.pearsonR.toFixed(3)}$ ($n=${report.composite.scoreCorrelation.n}$, permutation $p=${report.composite.scoreCorrelation.permutationPValue.toFixed(4)}$, direction=\`${report.composite.scoreCorrelation.direction}\`)`,
		`- **Balanced Common-Task Composite (${report.balancedComposite.proxyTaskIds.join("+") || "none"} -> ${report.balancedComposite.targetTaskIds.join("+") || "none"}):** Spearman $\\rho = ${report.balancedComposite.scoreCorrelation.spearmanRho.toFixed(3)}$, Kendall $\\tau_b = ${report.balancedComposite.scoreCorrelation.kendallTauB.toFixed(3)}$, Pearson $r = ${report.balancedComposite.scoreCorrelation.pearsonR.toFixed(3)}$ ($n=${report.balancedComposite.scoreCorrelation.n}$, $p=${report.balancedComposite.scoreCorrelation.permutationPValue.toFixed(4)}$)`,
		`- **Pass-Rate Rank Correlation:** Spearman $\\rho = ${report.composite.passRateCorrelation.spearmanRho.toFixed(3)}$, Kendall $\\tau_b = ${report.composite.passRateCorrelation.kendallTauB.toFixed(3)}$ ($p=${report.composite.passRateCorrelation.permutationPValue.toFixed(4)}$)`,
		`- **Cost-Adjusted Efficiency Correlation:** Spearman $\\rho = ${report.composite.efficiencyCorrelation.spearmanRho.toFixed(3)}$, Kendall $\\tau_b = ${report.composite.efficiencyCorrelation.kendallTauB.toFixed(3)}$, Pearson $r = ${report.composite.efficiencyCorrelation.pearsonR.toFixed(3)}$ ($p=${report.composite.efficiencyCorrelation.permutationPValue.toFixed(4)}$)`,
		"",
		"| Arm | Normalized Proxy Composite | Proxy Coverage | Normalized Long-Horizon Composite | Target Coverage |",
		"| --- | ---: | ---: | ---: | ---: |",
		...report.composite.perArmComposite.map(
			(row) =>
				`| \`${row.arm}\` | ${row.proxyComposite.toFixed(3)} | ${row.proxyTasksCovered} | ${row.targetComposite.toFixed(3)} | ${row.targetTasksCovered} |`,
		),
		"",
		"## Pairwise Proxy -> Long-Horizon Matrix",
		"",
		"| Proxy Task | Target Task | Shared Arms | Spearman rho | Kendall tau-b | Pearson r | Perm p-value | Direction |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
		...report.pairwise.map(
			(p) =>
				`| \`${p.proxyTaskId}\` | \`${p.targetTaskId}\` | ${p.sharedArms.length} | ${p.scoreCorrelation.spearmanRho.toFixed(3)} | ${p.scoreCorrelation.kendallTauB.toFixed(3)} | ${p.scoreCorrelation.pearsonR.toFixed(3)} | ${p.scoreCorrelation.permutationPValue.toFixed(4)} | ${p.scoreCorrelation.direction} |`,
		),
		"",
		"## Per-Arm Task Scores",
		"",
	];

	const allTasks = [...report.proxyTaskIds, ...report.targetTaskIds];
	lines.push(`| Arm | ${allTasks.map((t) => `\`${t}\``).join(" | ")} |`);
	lines.push(`| --- | ${allTasks.map(() => "---:").join(" | ")} |`);
	for (const arm of report.armKeys) {
		const cells = allTasks.map((t) => {
			const cell = report.armTaskTable[arm]?.[t];
			return cell ? `${cell.meanScore.toFixed(3)} (${Math.round(cell.passRate * 100)}%)` : "—";
		});
		lines.push(`| \`${arm}\` | ${cells.join(" | ")} |`);
	}
	lines.push("");
	return lines.join("\n");
}
