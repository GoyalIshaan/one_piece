import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	benjaminiHochberg,
	computeRouterRegret,
	computeScalingLaws,
	extractScorecard,
	miniCoopInterpTask,
	openEvalTraceDb,
	runRealOsChaosSuite,
	runTaskCalibration,
	sha256Dir,
	triageNeedleMeshTask,
	type HarnessRunReceipt,
	type HarnessRunSpec,
	type Scorecard,
} from "../src/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("Pillar 1 & 2: Real-OS Chaos Suite, Scorecard v2 Telemetry, Scaling/Regret Stats & triage-needle-mesh", () => {
	it("passes all 6 Real-OS chaos, concurrency, token conservation, security red-team & KV stability scenarios", async () => {
		const report = await runRealOsChaosSuite();
		for (const sc of report.scenarios) {
			expect(sc.passed, `${sc.scenario}: ${sc.details}`).toBe(true);
		}
		expect(report.allPassed).toBe(true);
		expect(report.totalCount).toBe(6);
	}, 30_000);

	it("extracts full Scorecard v2 AULC and all 6 Harness v3 mechanism telemetry dimensions", async () => {
		const root = mkdtempSync(join(tmpdir(), "eval-sc2-"));
		try {
			const workDir = join(root, "work");
			const hiddenDir = join(root, "hidden");
			const refDir = join(root, "ref");
			const runDir = join(root, "run");
			mkdirSync(runDir, { recursive: true });

			const prepared = await miniCoopInterpTask.prepare({
				seed: 5,
				n: 2,
				options: {},
				workDir,
				hiddenDir,
			});
			const preparedWithCeiling = { ...prepared, theoreticalCeiling: 1.0 };
			cpSync(prepared.workspaceDir, refDir, { recursive: true });
			await miniCoopInterpTask.buildReferenceArtifact!({ prepared, outDir: refDir });

			const dbPath = join(runDir, "trace.db");
			const db = openEvalTraceDb(dbPath);
			const runId = "sc2-v3-rich";
			const t0 = 1_730_000_000_000;
			const insertEvent = db.prepare(
				"INSERT INTO events (ts, run_id, type, node_id, causal_parents, idempotency_key, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
			);
			const insertDoc = db.prepare(
				"INSERT INTO docs (collection, id, run_id, data, updated_at) VALUES (?, ?, ?, ?, ?)",
			);

			// Seed rich docs for agents (depth=2 recursive forest) & Board v2 cross-subtree citations
			insertDoc.run("agents", "ag-root", runId, JSON.stringify({ id: "ag-root", role: "planner", depth: 0, subtreeId: "root", driverId: "codex", spent: { tokens: 4_000 } }), t0);
			insertDoc.run("agents", "ag-w1", runId, JSON.stringify({ id: "ag-w1", role: "worker", depth: 2, subtreeId: "sub-a", driverId: "codex", spent: { tokens: 10_000 } }), t0);
			insertDoc.run("agents", "ag-w2", runId, JSON.stringify({ id: "ag-w2", role: "worker", depth: 2, subtreeId: "sub-b", driverId: "gemini", spent: { tokens: 6_000 } }), t0);

			insertDoc.run("posts", "p1", runId, JSON.stringify({ id: "p1", authorAgentId: "ag-w1", subtreeId: "sub-a", visibility: "global", labels: { "os:promoted": "true" } }), t0 + 100);
			insertDoc.run("posts", "p2", runId, JSON.stringify({ id: "p2", authorAgentId: "ag-w1", subtreeId: "sub-a", visibility: "subtree" }), t0 + 200);
			insertDoc.run("posts", "p3", runId, JSON.stringify({ id: "p3", authorAgentId: "ag-w2", subtreeId: "sub-b", visibility: "global", parentIds: ["p1"] }), t0 + 300);

			// Seed rich v3 lifecycle events
			insertEvent.run(t0, runId, "run.started", null, null, null, JSON.stringify({ topology: "adaptive", goal: "test" }));
			insertEvent.run(t0 + 50, runId, "phase.changed", null, null, null, JSON.stringify({ to: "explore", reason: "init" }));
			insertEvent.run(t0 + 80, runId, "adaptive.morphed", null, null, null, JSON.stringify({ from: "adaptive", to: "recursive-planners", reason: "multi-module" }));
			insertEvent.run(t0 + 100, runId, "bound.estimated", null, null, null, JSON.stringify({ metricName: "score", estimatedCeiling: 0.9, stoppingFraction: 0.92, confidence: 0.85, assumptions: ["a1"] }));
			insertEvent.run(t0 + 120, runId, "decision.evaluated", null, null, null, JSON.stringify({ purpose: "triage", provider: "jev", model: "jev-v1", questionCount: 4, inputTokens: 800, latencyMs: 180 }));
			insertEvent.run(t0 + 140, runId, "board.promoted", "ag-w1", null, null, JSON.stringify({ postId: "p1", novelty: 0.91, broadcastProb: 0.86, crossoverProb: 0.72, reason: "novel" }));
			insertEvent.run(t0 + 160, runId, "governor.scaled", null, null, null, JSON.stringify({ driverId: "codex", prevWindow: 2, nextWindow: 3, reason: "aimd_up", freeMemMb: 8192, cpuLoadRatio: 0.4 }));
			insertEvent.run(t0 + 200, runId, "governor.scaled", null, null, null, JSON.stringify({ driverId: "codex", prevWindow: 3, nextWindow: 1, reason: "429", freeMemMb: 7900, cpuLoadRatio: 0.6 }));
			insertEvent.run(t0 + 250, runId, "agent.turn", "ag-w1", null, null, JSON.stringify({ turn: 1, driverId: "codex", durationMs: 4000, cacheHitRate: 0.85 }));
			insertEvent.run(t0 + 300, runId, "agent.turn", "ag-w1", null, null, JSON.stringify({ turn: 2, driverId: "codex", durationMs: 2000, cacheHitRate: 0.25 })); // KV bust (0.85 -> 0.25)
			insertEvent.run(t0 + 320, runId, "agent.turn", "ag-w2", null, null, JSON.stringify({ turn: 1, driverId: "gemini", durationMs: 2000, cacheHitRate: 0.7 }));
			insertEvent.run(t0 + 350, runId, "budget.charged", "ag-root", null, null, JSON.stringify({ tokens: 4_000, inputTokens: 3_000, outputTokens: 1_000, usd: 0.04 }));
			insertEvent.run(t0 + 360, runId, "budget.charged", "ag-w1", null, null, JSON.stringify({ tokens: 10_000, inputTokens: 8_000, outputTokens: 2_000, usd: 0.10 }));
			insertEvent.run(t0 + 370, runId, "budget.charged", "ag-w2", null, null, JSON.stringify({ tokens: 6_000, inputTokens: 5_000, outputTokens: 1_000, usd: 0.06 }));
			insertEvent.run(t0 + 400, runId, "peer.conflict_detected", null, null, null, JSON.stringify({ peerHandle: "w2", branch: "b2", conflictFiles: ["a.py"] }));
			insertEvent.run(t0 + 410, runId, "peer.conflict_resolved", null, null, null, JSON.stringify({ peerHandle: "w2", branch: "b2", conflictFiles: ["a.py"], commitSha: "abc" }));
			insertEvent.run(t0 + 420, runId, "refinery.semantic_regression", null, null, null, JSON.stringify({ taskId: "t1", branch: "b2", reason: "mismatch", repaired: true, rolledBack: false }));
			insertEvent.run(t0 + 440, runId, "researcher.checkpoint", null, null, null, JSON.stringify({ policy: "coalesce", trigger: "approaching_bound", bestScore: 1.0, estimatedCeiling: 0.9, action: "coalesce" }));
			insertEvent.run(t0 + 450, runId, "field_guide.updated", null, null, null, JSON.stringify({ lines: 42, bytes: 1850, mode: "deterministic", path: "fg.md", wave: 1 }));
			insertEvent.run(t0 + 500, runId, "agent.status", "ag-root", null, null, JSON.stringify({ status: "done" }));
			insertEvent.run(t0 + 500, runId, "agent.status", "ag-w1", null, null, JSON.stringify({ status: "done" }));
			insertEvent.run(t0 + 500, runId, "agent.status", "ag-w2", null, null, JSON.stringify({ status: "done" }));
			insertEvent.run(t0 + 5000, runId, "run.finished", null, null, null, JSON.stringify({ status: "done", reason: "ok" }));
			db.close();

			const refSha = sha256Dir(refDir);
			const spec: HarnessRunSpec = {
				runId,
				runDir,
				dbPath,
				taskId: miniCoopInterpTask.id,
				seed: 5,
				goal: prepared.goal,
				workspaceDir: prepared.workspaceDir,
				hiddenDenyPaths: [hiddenDir],
				controlRung: "swarm",
				topology: "adaptive",
				swarmSize: 2,
				budget: { tokens: 100_000, wallClockMs: 10_000 },
				budgetMode: "tokens",
				autoNominate: true,
				sandboxProfile: "eval-offline",
			};
			const receipt: HarnessRunReceipt = {
				runId,
				status: "done",
				nominatedArtifactDir: refDir,
				nominatedSha256: refSha,
				nominatedAtTokens: 20_000,
				nominatedAtWallMs: 2_000,
				autoNominated: true,
				candidateSnapshots: [
					// Early win at 20% token budget + duplicate snapshot to test basin diversity
					{ id: "c1", agentId: "ag-w1", dir: refDir, sha256: refSha, atTokens: 20_000, atWallMs: 2_000, acceptedByVerifier: true },
					{ id: "c2", agentId: "ag-w2", dir: refDir, sha256: refSha, atTokens: 20_000, atWallMs: 2_500, acceptedByVerifier: true },
				],
				harnessFaults: [],
			};

			const card = await extractScorecard({
				task: miniCoopInterpTask,
				prepared: preparedWithCeiling,
				spec,
				receipt,
				adapterName: "test-v3",
				armOrderIndex: 0,
				repoRoot: REPO_ROOT,
			});

			expect(card.schemaVersion).toBe(2);
			expect(card.hasHarnessFault).toBe(false);
			expect(card.deliveredPass).toBe(true);

			// Anytime AULC: reached 1.0 at 20,000 / 100,000 tokens -> AULC should be ~0.80!
			expect(card.anytime?.aulcTokens).toBeCloseTo(0.8, 2);
			expect(card.anytime?.aulcWall).toBeCloseTo(0.8, 2);
			expect(card.anytime?.anytimeNominationLag).toBe(0);
			expect(card.anytime?.scorePerUsd).toBeCloseTo(5.0, 2);

			// Board v2 telemetry
			expect(card.mechanisms?.board.promotedCount).toBe(1);
			expect(card.mechanisms?.board.crossSubtreeCitations).toBe(1);
			expect(card.mechanisms?.board.citationYield).toBe(1);
			expect(card.mechanisms?.board.avgPromotedNovelty).toBeCloseTo(0.91, 2);

			// Forest & KV cache telemetry
			expect(card.mechanisms?.forest.maxDepth).toBe(2);
			expect(card.mechanisms?.forest.plannerCount).toBe(1);
			expect(card.mechanisms?.forest.workerCount).toBe(2);
			expect(card.mechanisms?.forest.plannerTokenShare).toBeCloseTo(0.2, 2);
			expect(card.mechanisms?.forest.stragglerSkewRatio).toBeCloseTo(1.5, 2); // max=6000, median=(6000+2000)/2=4000 -> 1.5
			expect(card.mechanisms?.forest.kvCacheBustCount).toBe(1);

			// AIMD Governor & Provider Entropy
			expect(card.mechanisms?.governor.scaleUps).toBe(1);
			expect(card.mechanisms?.governor.scaleDowns).toBe(1);
			expect(card.mechanisms?.governor.minWindow).toBe(1);
			expect(card.mechanisms?.governor.maxWindow).toBe(3);
			expect(card.mechanisms?.governor.providerDiversityEntropy).toBeGreaterThan(0.9); // 2 codex + 1 gemini -> ~0.918 bits

			// Integration & Semantic Repair
			expect(card.mechanisms?.integration.conflictsDetected).toBe(1);
			expect(card.mechanisms?.integration.conflictResolutionRate).toBe(1);
			expect(card.mechanisms?.integration.semanticRegressionsDetected).toBe(1);
			expect(card.mechanisms?.integration.semanticRepairRate).toBe(1);
			expect(card.mechanisms?.integration.monotonicRollbacks).toBe(0);

			// Search Basin Diversity (2 identical snapshots -> 0.5 diversity, 0.5 duplicate waste)
			expect(card.mechanisms?.search.uniqueDiffShas).toBe(1);
			expect(card.mechanisms?.search.basinDiversityRatio).toBe(0.5);
			expect(card.mechanisms?.search.duplicateWorkWaste).toBe(0.5);

			// Meta-Control & Bound Calibration Error (|0.9 - 1.0| / 1.0 = 0.1)
			expect(card.mechanisms?.meta.decisionCalls).toBe(1);
			expect(card.mechanisms?.meta.decisionQuestions).toBe(4);
			expect(card.mechanisms?.meta.adaptiveMorphs).toBe(1);
			expect(card.mechanisms?.meta.finalTopology).toBe("recursive-planners");
			expect(card.mechanisms?.meta.estimatedCeiling).toBe(0.9);
			expect(card.mechanisms?.meta.boundCalibrationError).toBeCloseTo(0.1, 3);
			expect(card.mechanisms?.meta.earlyStopDecisions).toBe(1);
			expect(card.mechanisms?.meta.fieldGuideMaxBytes).toBe(1850);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("computes Scaling Laws, Router Oracle Regret, and Benjamini-Hochberg FDR accurately", () => {
		const mkCard = (opts: { taskId: string; topology: string; n: number; score: number; wallMs: number; aulc: number }): Scorecard =>
			({
				schemaVersion: 1,
				runId: `${opts.taskId}-${opts.topology}-n${opts.n}`,
				taskId: opts.taskId,
				family: "coupled-swe",
				status: "done",
				deliveredPass: opts.score >= 0.9,
				deliveredScore: opts.score,
				bestOfflinePass: opts.score >= 0.9,
				bestOfflineScore: opts.score,
				autoNominated: true,
				harnessFaults: [],
				hasHarnessFault: false,
				losses: { discoveryLoss: 0, nominationLoss: 0, falseCertificationRate: 0, postOptimumTokens: 0, stoppingWasteShare: 0 },
				tokens: {
					total: 10_000 * opts.n,
					input: 8_000 * opts.n,
					output: 2_000 * opts.n,
					cacheRead: 0,
					cacheWrite: 0,
					reasoning: 0,
					peakInputPerCall: 8_000,
					estimatedUsd: 0.1,
					byRole: { worker: 10_000 * opts.n, coordinator: 0, reviewer: 0, refinery: 0 },
					byCategory: { work: 10_000 * opts.n, coordination: 0, verification: 0, other: 0 },
					coordinationTokenShare: 0,
				},
				time: {
					wallClockMs: opts.wallMs,
					llmWaitMs: opts.wallMs,
					quotaWaitMs: 0,
					toolExecMs: 0,
					graderComputeMs: 0,
					cpuSeconds: 0,
					gpuSeconds: 0,
					timeToFirstValidMs: opts.wallMs,
					timeToNominationMs: opts.wallMs,
				},
				dynamics: {
					swarmSize: opts.n,
					agentCount: opts.n,
					avgParallelism: opts.n,
					peakParallelism: opts.n,
					modelCalls: opts.n,
					modelErrors: 0,
					toolCalls: 0,
					toolErrors: 0,
					toolErrorRate: 0,
					toolCallsByName: {},
					messageCount: 0,
					messageBytes: 0,
					compactions: 0,
					artifactReads: 0,
					stallDetections: 0,
					failoverCount: 0,
				},
				anytimeFrontier: [],
				anytime: {
					aulcTokens: opts.aulc,
					aulcBestOfflineTokens: opts.aulc,
					anytimeNominationLag: 0,
					aulcWall: opts.aulc,
					scorePer100kTokens: opts.score,
				},
				reproducibility: {
					harnessAdapter: "v2",
					topology: opts.topology,
					controlRung: opts.n === 1 ? "solo" : "swarm",
					budgetMode: "wall_clock",
					budget: {},
					seed: 1,
					armOrderIndex: 0,
					fixtureSha256: "f",
					graderSha256: "g",
					harnessGitSha: "abc",
					dirtyDiffSha: "def",
					driverIds: ["codex"],
					modelIds: ["gpt"],
				},
				customMetrics: {},
				gradeDetails: "ok",
			});

		// 1. Scaling laws: N=1 (1000ms), N=2 (600ms -> S=1.667), N=4 (400ms -> S=2.5)
		const scaling = computeScalingLaws([
			mkCard({ taskId: "t1", topology: "elastic-phase", n: 1, score: 0.5, wallMs: 1000, aulc: 0.3 }),
			mkCard({ taskId: "t1", topology: "elastic-phase", n: 2, score: 0.8, wallMs: 600, aulc: 0.6 }),
			mkCard({ taskId: "t1", topology: "elastic-phase", n: 4, score: 1.0, wallMs: 400, aulc: 0.85 }),
		]);
		expect(scaling.length).toBe(3);
		expect(scaling[0]!.speedupS).toBe(1);
		expect(scaling[2]!.speedupS).toBeCloseTo(2.5, 2);
		expect(scaling[2]!.parallelEfficiencyE).toBeCloseTo(0.625, 3);
		expect(scaling[2]!.karpFlattSerialFraction).toBeCloseTo(0.2, 2);

		// 2. Router Oracle Regret: task A adaptive=1.0 vs oracle=1.0 (regret 0); task B adaptive=0.8 vs evolution=1.0 (regret 0.2)
		const regret = computeRouterRegret([
			mkCard({ taskId: "tA", topology: "adaptive", n: 4, score: 1.0, wallMs: 400, aulc: 0.8 }),
			mkCard({ taskId: "tA", topology: "pull-refinery", n: 4, score: 0.5, wallMs: 400, aulc: 0.4 }),
			mkCard({ taskId: "tB", topology: "adaptive", n: 4, score: 0.8, wallMs: 400, aulc: 0.7 }),
			mkCard({ taskId: "tB", topology: "evolution", n: 4, score: 1.0, wallMs: 400, aulc: 0.9 }),
		]);
		expect(regret.tasksEvaluated).toBe(2);
		expect(regret.meanRegret).toBeCloseTo(0.1, 4);
		expect(regret.maxRegret).toBeCloseTo(0.2, 4);
		expect(regret.perTask.find((r) => r.taskId === "tB")?.oracleTopology).toBe("evolution");

		// 3. Benjamini-Hochberg FDR exact check: [0.005, 0.04, 0.02, 0.50] -> sorted [0.005*4/1=0.02, 0.02*4/2=0.04, 0.04*4/3=0.053333, 0.5*4/4=0.5]
		const q = benjaminiHochberg([0.005, 0.04, 0.02, 0.5]);
		expect(q[0]).toBeCloseTo(0.02, 4);
		expect(q[1]).toBeCloseTo(0.053333, 4);
		expect(q[2]).toBeCloseTo(0.04, 4);
		expect(q[3]).toBeCloseTo(0.5, 4);
	});

	it("calibrates triage-needle-mesh cleanly and penalizes distractor leaks", async () => {
		const cal = await runTaskCalibration(triageNeedleMeshTask, { repoRoot: REPO_ROOT, n: 4 });
		for (const c of cal.checks) {
			expect(c.passed, `${c.name}: ${c.details}`).toBe(true);
		}
		expect(cal.passed).toBe(true);

		// Also verify distractor leak penalty explicitly
		const root = mkdtempSync(join(tmpdir(), "eval-triage-leak-"));
		try {
			const prepared = await triageNeedleMeshTask.prepare({
				seed: 19,
				n: 4,
				options: {},
				workDir: join(root, "work"),
				hiddenDir: join(root, "hidden"),
			});
			const refDir = join(root, "ref");
			cpSync(prepared.workspaceDir, refDir, { recursive: true });
			await triageNeedleMeshTask.buildReferenceArtifact!({ prepared, outDir: refDir });

			// Inject a fake distractor edge into seat_0's submission -> must fail and count leak!
			const s0Path = join(refDir, "submissions", "seat_0.json");
			const s0 = JSON.parse(readFileSync(s0Path, "utf8")) as { verified_ring_edges: unknown[] };
			s0.verified_ring_edges.push({ edge_id: "edge-fake-0-0-dead", from_seat: 0, to_seat: 1, link_token: "00000000", combined_weight: 99 });
			writeFileSync(s0Path, JSON.stringify(s0, null, 2));

			const grade = await triageNeedleMeshTask.grade({
				artifactDir: refDir,
				hiddenDir: prepared.hiddenDir,
				seed: 19,
				n: 4,
				options: {},
			});
			expect(grade.passed).toBe(false);
			expect(Number(grade.customMetrics.distractorLeakCount)).toBeGreaterThan(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
