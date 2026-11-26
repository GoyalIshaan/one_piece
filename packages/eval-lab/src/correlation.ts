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
			}
		>
	>;
	/** Pairwise proxy -> target rank correlations across all shared arms. */
	pairwise: ProxyTargetPairCorrelation[];
	/** Composite normalized proxy rank vs composite normalized long-horizon rank. */
	composite: {
		sharedArms: string[];
		perArmComposite: Array<{ arm: string; proxyComposite: number; targetComposite: number }>;
		scoreCorrelation: CorrelationStats;
		passRateCorrelation: CorrelationStats;
	};
	/** Diagnostic proxy metrics (e.g. coordination share, nomination loss) vs target delivered score. */
	diagnosticTransfers: DiagnosticTransferEntry[];
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
	},
): ProxyToTargetReport {
	const armKeyFn = options.armKeyFn ?? defaultArmKey;
	const proxySet = new Set(options.proxyTaskIds);
	const targetSet = new Set(options.targetTaskIds);

	const grouped = new Map<string, Map<string, Scorecard[]>>();
	for (const card of scorecards) {
		const arm = armKeyFn(card);
		if (!grouped.has(arm)) grouped.set(arm, new Map());
		const byTask = grouped.get(arm)!;
		if (!byTask.has(card.taskId)) byTask.set(card.taskId, []);
		byTask.get(card.taskId)!.push(card);
	}

	const armKeys = [...grouped.keys()].sort();
	const armTaskTable: ProxyToTargetReport["armTaskTable"] = {};

	for (const arm of armKeys) {
		armTaskTable[arm] = {};
		for (const [taskId, rows] of grouped.get(arm)!.entries()) {
			const avg = (fn: (s: Scorecard) => number) => rows.reduce((acc, r) => acc + fn(r), 0) / rows.length;
			const meanScore = avg((r) => r.deliveredScore);
			const passRate = rows.filter((r) => r.deliveredPass).length / rows.length;
			const meanTokens = avg((r) => r.tokens.total);
			const efficiency = meanScore / Math.max(0.1, meanTokens / 100_000);
			armTaskTable[arm]![taskId] = {
				runs: rows.length,
				meanScore: round6(meanScore),
				passRate: round6(passRate),
				meanTokens: Math.round(meanTokens),
				efficiency: round6(efficiency),
				meanNominationLoss: round6(avg((r) => r.losses.nominationLoss)),
				meanCoordShare: round6(avg((r) => r.tokens.coordinationTokenShare)),
				meanToolErrorRate: round6(avg((r) => r.dynamics.toolErrorRate)),
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
	for (const taskId of [...proxySet, ...targetSet]) {
		const vals = armKeys
			.map((a) => armTaskTable[a]?.[taskId]?.meanScore)
			.filter((v): v is number => typeof v === "number");
		if (vals.length) {
			taskRange.set(taskId, { min: Math.min(...vals), max: Math.max(...vals) });
		}
	}
	const normTaskScore = (taskId: string, val: number): number => {
		const r = taskRange.get(taskId);
		if (!r || Math.abs(r.max - r.min) <= 1e-12) return 0.5;
		return (val - r.min) / (r.max - r.min);
	};

	const compositeArms = armKeys.filter(
		(a) =>
			options.proxyTaskIds.some((t) => Boolean(armTaskTable[a]?.[t])) &&
			options.targetTaskIds.some((t) => Boolean(armTaskTable[a]?.[t])),
	);
	const perArmComposite = compositeArms.map((arm) => {
		const pTasks = options.proxyTaskIds.filter((t) => Boolean(armTaskTable[arm]?.[t]));
		const tTasks = options.targetTaskIds.filter((t) => Boolean(armTaskTable[arm]?.[t]));
		const proxyComposite =
			pTasks.reduce((s, t) => s + normTaskScore(t, armTaskTable[arm]![t]!.meanScore), 0) / pTasks.length;
		const targetComposite =
			tTasks.reduce((s, t) => s + normTaskScore(t, armTaskTable[arm]![t]!.meanScore), 0) / tTasks.length;
		return {
			arm,
			proxyComposite: round6(proxyComposite),
			targetComposite: round6(targetComposite),
		};
	});
	const compPxPass = compositeArms.map((arm) => {
		const pTasks = options.proxyTaskIds.filter((t) => Boolean(armTaskTable[arm]?.[t]));
		return pTasks.reduce((s, t) => s + armTaskTable[arm]![t]!.passRate, 0) / pTasks.length;
	});
	const compTgPass = compositeArms.map((arm) => {
		const tTasks = options.targetTaskIds.filter((t) => Boolean(armTaskTable[arm]?.[t]));
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
		},
		diagnosticTransfers,
	};
}

export function renderCorrelationReport(report: ProxyToTargetReport): string {
	const lines: string[] = [
		"# Proxy-to-Long-Horizon Benchmark Correlation Report",
		"",
		`- **Harness Arms (${report.armKeys.length}):** ${report.armKeys.map((a) => `\`${a}\``).join(", ") || "(none)"}`,
		`- **Proxy Benchmarks:** ${report.proxyTaskIds.map((t) => `\`${t}\``).join(", ")}`,
		`- **Long-Horizon Target Benchmarks:** ${report.targetTaskIds.map((t) => `\`${t}\``).join(", ")}`,
		"",
		"## Composite Proxy vs Long-Horizon Transfer",
		"",
		`- **Score Rank Correlation:** Spearman $\\rho = ${report.composite.scoreCorrelation.spearmanRho.toFixed(3)}$, Kendall $\\tau_b = ${report.composite.scoreCorrelation.kendallTauB.toFixed(3)}$, Pearson $r = ${report.composite.scoreCorrelation.pearsonR.toFixed(3)}$ ($n=${report.composite.scoreCorrelation.n}$, permutation $p=${report.composite.scoreCorrelation.permutationPValue.toFixed(4)}$, direction=\`${report.composite.scoreCorrelation.direction}\`)`,
		`- **Pass-Rate Rank Correlation:** Spearman $\\rho = ${report.composite.passRateCorrelation.spearmanRho.toFixed(3)}$, Kendall $\\tau_b = ${report.composite.passRateCorrelation.kendallTauB.toFixed(3)}$ ($p=${report.composite.passRateCorrelation.permutationPValue.toFixed(4)}$)`,
		"",
		"| Arm | Normalized Proxy Composite | Normalized Long-Horizon Composite |",
		"| --- | ---: | ---: |",
		...report.composite.perArmComposite.map(
			(row) => `| \`${row.arm}\` | ${row.proxyComposite.toFixed(3)} | ${row.targetComposite.toFixed(3)} |`,
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
