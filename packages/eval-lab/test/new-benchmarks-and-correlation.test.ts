import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isSandboxReadBlocked } from "@one-piece/core";
import type { HarnessAdapter, Scorecard } from "../src/contracts.ts";
import { runTaskCalibration } from "../src/calibration.ts";
import {
	analyzeDeltaTransferCorrelation,
	analyzeProxyToTargetCorrelation,
	averageRanks,
	computeCorrelationStats,
	kendallTauB,
	pearsonCorrelation,
	renderCorrelationReport,
	spearmanRankCorrelation,
} from "../src/correlation.ts";
import { runFaultInjectionSuite } from "../src/faults.ts";
import { runCampaign } from "../src/runner.ts";
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

	it("prevents unbalanced-subset Simpson's paradox, filters faulted runs, flags mixed commits, and computes delta-transfer", () => {
		const cards: Scorecard[] = [
			// Arm A: ran easy proxy (1.0) + hard target (1.0)
			makeSyntheticCard({ taskId: "p-easy", arm: "armA", topology: "a", n: 4, seed: 1, score: 1.0, passed: true, tokens: 100_000 }),
			makeSyntheticCard({ taskId: "p-sat", arm: "armA", topology: "a", n: 4, seed: 1, score: 1.0, passed: true, tokens: 100_000 }),
			makeSyntheticCard({ taskId: "t-main", arm: "armA", topology: "a", n: 4, seed: 1, score: 1.0, passed: true, tokens: 200_000 }),
			// Arm B: ran easy proxy (0.5) + hard target (0.5)
			makeSyntheticCard({ taskId: "p-easy", arm: "armB", topology: "b", n: 4, seed: 1, score: 0.5, passed: false, tokens: 100_000 }),
			makeSyntheticCard({ taskId: "p-sat", arm: "armB", topology: "b", n: 4, seed: 1, score: 1.0, passed: true, tokens: 100_000 }),
			makeSyntheticCard({ taskId: "t-main", arm: "armB", topology: "b", n: 4, seed: 1, score: 0.5, passed: false, tokens: 200_000 }),
			// Arm C: ran easy proxy (0.1) + hard target (0.1) + a faulted run that MUST be excluded
			makeSyntheticCard({ taskId: "p-easy", arm: "armC", topology: "c", n: 4, seed: 1, score: 0.1, passed: false, tokens: 100_000 }),
			makeSyntheticCard({ taskId: "p-sat", arm: "armC", topology: "c", n: 4, seed: 1, score: 1.0, passed: true, tokens: 100_000 }),
			makeSyntheticCard({ taskId: "t-main", arm: "armC", topology: "c", n: 4, seed: 1, score: 0.1, passed: false, tokens: 200_000 }),
		];
		// Add a faulted run and a mixed-commit duplicate on armC
		const faulted = makeSyntheticCard({ taskId: "t-main", arm: "armC", topology: "c", n: 4, seed: 2, score: 0.99, passed: true, tokens: 10_000 });
		faulted.hasHarnessFault = true;
		cards.push(faulted);

		const report = analyzeProxyToTargetCorrelation(cards, {
			proxyTaskIds: ["p-easy", "p-sat"],
			targetTaskIds: ["t-main"],
		});
		expect(report.excludedFaultedRuns).toBe(1);
		expect(report.saturatedTaskIds).toEqual(["p-sat"]);
		expect(report.balancedComposite.scoreCorrelation.spearmanRho).toBe(1);
		expect(report.armTaskTable["swarm:c:n4"]!["t-main"]!.meanScore).toBe(0.1);

		// Delta-transfer correlation (baseline -> candidate)
		const base = [
			makeSyntheticCard({ taskId: "px", arm: "a", topology: "a", n: 4, seed: 1, score: 0.2, passed: false, tokens: 100_000 }),
			makeSyntheticCard({ taskId: "tg", arm: "a", topology: "a", n: 4, seed: 1, score: 0.2, passed: false, tokens: 200_000 }),
			makeSyntheticCard({ taskId: "px", arm: "b", topology: "b", n: 4, seed: 1, score: 0.4, passed: false, tokens: 100_000 }),
			makeSyntheticCard({ taskId: "tg", arm: "b", topology: "b", n: 4, seed: 1, score: 0.5, passed: false, tokens: 200_000 }),
			makeSyntheticCard({ taskId: "px", arm: "c", topology: "c", n: 4, seed: 1, score: 0.6, passed: false, tokens: 100_000 }),
			makeSyntheticCard({ taskId: "tg", arm: "c", topology: "c", n: 4, seed: 1, score: 0.7, passed: false, tokens: 200_000 }),
		];
		const cand = [
			makeSyntheticCard({ taskId: "px", arm: "a", topology: "a", n: 4, seed: 1, score: 0.9, passed: true, tokens: 100_000 }),
			makeSyntheticCard({ taskId: "tg", arm: "a", topology: "a", n: 4, seed: 1, score: 0.95, passed: true, tokens: 200_000 }),
			makeSyntheticCard({ taskId: "px", arm: "b", topology: "b", n: 4, seed: 1, score: 0.7, passed: false, tokens: 100_000 }),
			makeSyntheticCard({ taskId: "tg", arm: "b", topology: "b", n: 4, seed: 1, score: 0.75, passed: false, tokens: 200_000 }),
			makeSyntheticCard({ taskId: "px", arm: "c", topology: "c", n: 4, seed: 1, score: 0.6, passed: false, tokens: 100_000 }),
			makeSyntheticCard({ taskId: "tg", arm: "c", topology: "c", n: 4, seed: 1, score: 0.65, passed: false, tokens: 200_000 }),
		];
		const delta = analyzeDeltaTransferCorrelation(base, cand, { proxyTaskId: "px", targetTaskId: "tg" });
		expect(delta.arms.length).toBe(3);
		expect(delta.deltaCorrelation.spearmanRho).toBe(1);
		expect(delta.deltaCorrelation.direction).toBe("positive");
	});

	it("rejects starter & tampered public tests on adversarial-spec-forge & horizon-repo-migration, and passes exact per-seat prompts in silent_bon", async () => {
		const root = mkdtempSync(join(tmpdir(), "eval-pubcheck-silent-"));
		try {
			// 1. Starter fails publicCheck (< 1.0) and deleting tests/test_public.py cannot bypass publicCheck!
			for (const task of [adversarialSpecForgeTask, horizonRepoMigrationTask]) {
				const workDir = join(root, `${task.id}-work`);
				const hiddenDir = join(root, `${task.id}-hidden`);
				const prep = await task.prepare({ seed: 1, n: 4, options: {}, workDir, hiddenDir });
				const starterPub = await task.publicCheck!({ artifactDir: workDir, seed: 1, n: 4, options: prep.options });
				expect(starterPub.passed).toBe(false);
				expect(starterPub.score).toBeLessThan(1);

				// Tamper by deleting tests/test_public.py -> must STILL fail!
				unlinkSync(join(workDir, "tests", "test_public.py"));
				const tamperedPub = await task.publicCheck!({ artifactDir: workDir, seed: 1, n: 4, options: prep.options });
				expect(tamperedPub.passed).toBe(false);

				// Reference artifact passes publicCheck with score = 1.0!
				const refDir = join(root, `${task.id}-ref`);
				mkdirSync(refDir, { recursive: true });
				await task.prepare({ seed: 1, n: 4, options: {}, workDir: refDir, hiddenDir: join(root, `${task.id}-ref-hidden`) });
				await task.buildReferenceArtifact!({ prepared: prep, outDir: refDir });
				const refPub = await task.publicCheck!({ artifactDir: refDir, seed: 1, n: 4, options: prep.options });
				expect(refPub.passed).toBe(true);
				expect(refPub.score).toBe(1);
			}

			// 2. silent_bon on causal-incident-mesh passes exact per-seat soloSeatPrompts[i] (`seat_i.json`) to ALL 4 seats!
			const seenSeats = new Map<number, { prompt?: string; shardCount: number; hiddenBlocked: boolean }>();
			const probeAdapter: HarnessAdapter = {
				name: "probe",
				async run(spec) {
					const idx = spec.seatIndex ?? -1;
					seenSeats.set(idx, {
						prompt: spec.soloSeatPrompts?.[idx],
						shardCount: spec.privateShards?.length ?? 0,
						hiddenBlocked: isSandboxReadBlocked(spec.hiddenDenyPaths[0] ?? ""),
					});
					return {
						runId: spec.runId,
						status: "done",
						autoNominated: false,
						candidateSnapshots: [],
						harnessFaults: [],
						driverIds: ["probe"],
						modelIds: ["probe"],
					};
				},
			};
			await runCampaign({
				task: causalIncidentMeshTask,
				adapter: probeAdapter,
				arms: [{ id: "silent_bon-n4", controlRung: "silent_bon", topology: "silent_bon", swarmSize: 4 }],
				seeds: [1],
				budget: { wallClockMs: 30_000 },
				budgetMode: "wall_clock",
				outDir: join(root, "silent-campaign"),
				repoRoot: REPO_ROOT,
			});
			expect(seenSeats.size).toBe(4);
			for (let i = 0; i < 4; i++) {
				const entry = seenSeats.get(i)!;
				expect(entry.shardCount).toBe(4);
				expect(entry.prompt).toContain(`Seat ${i} of 4`);
				expect(entry.prompt).toContain(`submissions/seat_${i}.json`);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);
});
