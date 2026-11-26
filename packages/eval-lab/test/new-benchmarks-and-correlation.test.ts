import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Scorecard } from "../src/contracts.ts";
import { runTaskCalibration } from "../src/calibration.ts";
import {
	analyzeProxyToTargetCorrelation,
	averageRanks,
	computeCorrelationStats,
	kendallTauB,
	pearsonCorrelation,
	renderCorrelationReport,
	spearmanRankCorrelation,
} from "../src/correlation.ts";
import { runFaultInjectionSuite } from "../src/faults.ts";
import { adversarialSpecForgeTask } from "../src/tasks/adversarial-spec-forge/index.ts";
import { causalIncidentMeshTask } from "../src/tasks/causal-incident-mesh/index.ts";
import { horizonRepoMigrationTask } from "../src/tasks/horizon-repo-migration/index.ts";
import { vliwKernelOptTask } from "../src/tasks/vliw-kernel-opt/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function makeSyntheticCard(params: {
	taskId: string;
	arm: string;
	topology: string;
	n: number;
	seed: number;
	score: number;
	passed: boolean;
	tokens: number;
	nomLoss?: number;
	coordShare?: number;
}): Scorecard {
	return {
		schemaVersion: 1,
		runId: `${params.taskId}-s${params.seed}-${params.arm}`,
		taskId: params.taskId,
		family: "coupled-swe",
		status: "done",
		deliveredPass: params.passed,
		deliveredScore: params.score,
		bestOfflinePass: params.passed,
		bestOfflineScore: params.score + (params.nomLoss ?? 0),
		autoNominated: true,
		harnessFaults: [],
		hasHarnessFault: false,
		losses: {
			discoveryLoss: Math.max(0, 1 - params.score),
			nominationLoss: params.nomLoss ?? 0,
			falseCertificationRate: 0,
			postOptimumTokens: 0,
			stoppingWasteShare: 0,
		},
		tokens: {
			total: params.tokens,
			input: Math.round(params.tokens * 0.8),
			output: Math.round(params.tokens * 0.2),
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
			peakInputPerCall: 1000,
			estimatedUsd: 0,
			byRole: { worker: params.tokens, coordinator: 0, reviewer: 0, refinery: 0 },
			byCategory: {
				work: Math.round(params.tokens * (1 - (params.coordShare ?? 0.1))),
				coordination: Math.round(params.tokens * (params.coordShare ?? 0.1)),
				verification: 0,
				other: 0,
			},
			coordinationTokenShare: params.coordShare ?? 0.1,
		},
		time: {
			wallClockMs: 1000,
			llmWaitMs: 800,
			quotaWaitMs: 0,
			toolExecMs: 200,
			graderComputeMs: 50,
			cpuSeconds: 0.1,
			gpuSeconds: 0,
			timeToFirstValidMs: params.passed ? 500 : null,
			timeToNominationMs: 900,
		},
		dynamics: {
			swarmSize: params.n,
			agentCount: params.n,
			avgParallelism: params.n,
			peakParallelism: params.n,
			modelCalls: 4,
			modelErrors: 0,
			toolCalls: 10,
			toolErrors: 0,
			toolErrorRate: 0,
			toolCallsByName: {},
			messageCount: 2,
			messageBytes: 100,
			compactions: 0,
			artifactReads: 0,
			stallDetections: 0,
			failoverCount: 0,
		},
		anytimeFrontier: [],
		reproducibility: {
			harnessAdapter: "test",
			topology: params.topology,
			controlRung: params.n === 1 ? "solo" : "swarm",
			budgetMode: "tokens",
			budget: { tokens: 100_000 },
			seed: params.seed,
			armOrderIndex: 0,
			fixtureSha256: "a",
			graderSha256: "b",
			harnessGitSha: "c",
			dirtyDiffSha: "d",
			driverIds: ["sim"],
			modelIds: ["sim"],
		},
		customMetrics: {},
		gradeDetails: "ok",
	};
}

describe("4 New High-Signal Swarm Benchmarks: 6-Check Calibration Gate & Fault Injection", () => {
	it("passes all 6 calibration checks + fault suite on causal-incident-mesh (N=4)", async () => {
		const cal = await runTaskCalibration(causalIncidentMeshTask, { repoRoot: REPO_ROOT, seed: 11, n: 4 });
		expect(cal.checks.map((c) => `${c.name}:${c.passed}`)).toEqual(cal.checks.map((c) => `${c.name}:true`));
		expect(cal.passed).toBe(true);

		const faults = await runFaultInjectionSuite(causalIncidentMeshTask, { repoRoot: REPO_ROOT });
		expect(faults.allIntegrityChecksPassed).toBe(true);
	}, 20_000);

	it("passes all 7 calibration checks (including semantic interference detection!) on adversarial-spec-forge", async () => {
		const cal = await runTaskCalibration(adversarialSpecForgeTask, { repoRoot: REPO_ROOT, seed: 5, n: 4 });
		expect(cal.checks.map((c) => `${c.name}:${c.passed}`)).toEqual(cal.checks.map((c) => `${c.name}:true`));
		expect(cal.checks.some((c) => c.name === "semantic_interference_caught" && c.passed)).toBe(true);
		expect(cal.passed).toBe(true);
	}, 20_000);

	it("passes all 6 calibration checks on vliw-kernel-opt (vectorized reference generalizes to unseen transfer shapes)", async () => {
		const cal = await runTaskCalibration(vliwKernelOptTask, { repoRoot: REPO_ROOT, seed: 3, n: 4 });
		expect(cal.checks.map((c) => `${c.name}:${c.passed}`)).toEqual(cal.checks.map((c) => `${c.name}:true`));
		expect(cal.passed).toBe(true);
	}, 20_000);

	it("passes all 6 calibration checks (including O(N log N) throughput bar!) on horizon-repo-migration", async () => {
		const cal = await runTaskCalibration(horizonRepoMigrationTask, { repoRoot: REPO_ROOT, seed: 9, n: 4 });
		expect(cal.checks.map((c) => `${c.name}:${c.passed}`)).toEqual(cal.checks.map((c) => `${c.name}:true`));
		expect(cal.passed).toBe(true);
	}, 25_000);
});

describe("Cross-Benchmark Rank Correlation Engine (Proxy -> Long-Horizon Transfer)", () => {
	it("computes exact mid-ranks, Pearson r, Spearman rho, Kendall tau-b, and exact permutation p-values", () => {
		expect(averageRanks([10, 20, 20, 40])).toEqual([1, 2.5, 2.5, 4]);
		expect(pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBe(1);
		expect(spearmanRankCorrelation([1, 2, 3, 4, 5], [10, 20, 35, 90, 500])).toBe(1);
		expect(spearmanRankCorrelation([1, 2, 3, 4, 5], [500, 90, 35, 20, 10])).toBe(-1);
		expect(kendallTauB([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])).toBe(1);
		// Tie-adjusted Kendall tau-b
		expect(kendallTauB([1, 1, 2, 3], [1, 2, 3, 4])).toBeGreaterThan(0.8);

		const stats = computeCorrelationStats([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]);
		expect(stats.spearmanRho).toBe(1);
		expect(stats.direction).toBe("positive");
		// Exact two-sided permutation p-value for n=5 perfect monotonic rank is 2 / 5! = 2/120 = 0.016667
		expect(stats.permutationPValue).toBeCloseTo(2 / 120, 4);
	});

	it("distinguishes positive-transfer proxies from misleading negative-transfer proxies in a multi-arm report", () => {
		const topologies = [
			{ name: "single", n: 1, goodProxy: 0.2, badProxy: 0.9, target: 0.25 },
			{ name: "hierarchy", n: 4, goodProxy: 0.45, badProxy: 0.7, target: 0.5 },
			{ name: "pull-refinery", n: 4, goodProxy: 0.7, badProxy: 0.5, target: 0.72 },
			{ name: "substrate-peers", n: 4, goodProxy: 0.82, badProxy: 0.35, target: 0.85 },
			{ name: "elastic-phase", n: 4, goodProxy: 0.95, badProxy: 0.15, target: 0.96 },
		];
		const cards: Scorecard[] = [];
		for (const t of topologies) {
			cards.push(
				makeSyntheticCard({ taskId: "proxy-good", arm: t.name, topology: t.name, n: t.n, seed: 1, score: t.goodProxy, passed: t.goodProxy >= 0.8, tokens: 100_000 }),
				makeSyntheticCard({ taskId: "proxy-bad", arm: t.name, topology: t.name, n: t.n, seed: 1, score: t.badProxy, passed: t.badProxy >= 0.8, tokens: 100_000 }),
				makeSyntheticCard({ taskId: "target-long", arm: t.name, topology: t.name, n: t.n, seed: 1, score: t.target, passed: t.target >= 0.8, tokens: 300_000 }),
			);
		}
		const report = analyzeProxyToTargetCorrelation(cards, {
			proxyTaskIds: ["proxy-good", "proxy-bad"],
			targetTaskIds: ["target-long"],
		});
		const goodPair = report.pairwise.find((p) => p.proxyTaskId === "proxy-good")!;
		const badPair = report.pairwise.find((p) => p.proxyTaskId === "proxy-bad")!;
		expect(goodPair.scoreCorrelation.spearmanRho).toBe(1);
		expect(goodPair.scoreCorrelation.direction).toBe("positive");
		expect(badPair.scoreCorrelation.spearmanRho).toBe(-1);
		expect(badPair.scoreCorrelation.direction).toBe("negative");

		const md = renderCorrelationReport(report);
		expect(md).toContain("Proxy-to-Long-Horizon Benchmark Correlation Report");
		expect(md).toContain("proxy-good");
		expect(md).toContain("target-long");
	});
});
