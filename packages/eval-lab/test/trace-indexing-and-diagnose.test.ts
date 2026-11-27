import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	DecisionModelClient,
	DecisionRequest,
	DecisionResponse,
	DriverCapabilities,
	DriverHealth,
	WorkerDriver,
	WorkerSession,
	WorkerSpawnSpec,
	WorkerTurnResult,
} from "@one-piece/core";
import { DriverQuotaRouter } from "@one-piece/drivers";
import {
	analyzeFailureBuckets,
	analyzeTrajectory,
	classifyProb,
	compareBucketsAcrossGenerations,
	computeJudgeCalibration,
	createOfflineTraceNavTools,
	escalateUnexplainedFailures,
	EvalLedger,
	extractTraceWindows,
	generateObservatory,
	indexLedgerTraces,
	loadOfflineTraceSnapshot,
	openEvalTraceDb,
	renderFailureBucketsMarkdown,
	sampleAuditQueue,
	SYSTEM1_PROBE_CATALOG,
	type EscalatedJudgeFinding,
	type ExtractedTraceWindow,
	type JudgeCalibrationSummary,
	type Scorecard,
	type TraceScoreRecord,
} from "../src/index.ts";

function makeCard(opts: {
	runId: string;
	taskId: string;
	genSha: string;
	seed: number;
	passed: boolean;
	score: number;
	bestOfflineScore?: number;
	swarmSize?: number;
	stoppingWasteShare?: number;
	conflictsDetected?: number;
	conflictsResolved?: number;
	stragglerSkewRatio?: number;
	kvCacheBustCount?: number;
}): Scorecard {
	const bestOffline = opts.bestOfflineScore ?? opts.score;
	const n = opts.swarmSize ?? 4;
	return {
		schemaVersion: 2,
		runId: opts.runId,
		taskId: opts.taskId,
		family: "coupled-swe",
		status: "done",
		deliveredPass: opts.passed,
		deliveredScore: opts.score,
		bestOfflinePass: bestOffline >= 0.99,
		bestOfflineScore: bestOffline,
		autoNominated: true,
		hasHarnessFault: false,
		harnessFaults: [],
		losses: {
			discoveryLoss: Math.max(0, 1 - bestOffline),
			nominationLoss: Math.max(0, bestOffline - opts.score),
			falseCertificationRate: 0,
			postOptimumTokens: Math.round(100_000 * (opts.stoppingWasteShare ?? 0.05)),
			stoppingWasteShare: opts.stoppingWasteShare ?? 0.05,
		},
		tokens: {
			total: 100_000,
			input: 80_000,
			output: 20_000,
			cacheRead: 40_000,
			cacheWrite: 0,
			cacheHitRate: 0.5,
			reasoning: 0,
			peakInputPerCall: 30_000,
			estimatedUsd: 0.3,
			byRole: { worker: 100_000, coordinator: 0, reviewer: 0, refinery: 0 },
			byCategory: { work: 90_000, coordination: 10_000, verification: 0, other: 0 },
			coordinationTokenShare: 0.1,
		},
		time: {
			wallClockMs: 60_000,
			llmWaitMs: 50_000,
			quotaWaitMs: 0,
			toolExecMs: 10_000,
			graderComputeMs: 0,
			cpuSeconds: 0,
			gpuSeconds: 0,
			timeToFirstValidMs: opts.passed ? 25_000 : null,
			timeToNominationMs: 60_000,
		},
		dynamics: {
			swarmSize: n,
			agentCount: n,
			avgParallelism: n,
			peakParallelism: n,
			modelCalls: 8,
			modelErrors: 0,
			toolCalls: 20,
			toolErrors: 1,
			toolErrorRate: 0.05,
			toolCallsByName: {},
			messageCount: 4,
			messageBytes: 800,
			compactions: 0,
			artifactReads: 0,
			stallDetections: 0,
			failoverCount: 0,
		},
		anytimeFrontier: [
			{
				atTokens: 50_000,
				atWallMs: 30_000,
				bestOfflineScore: bestOffline,
				nominatedScore: opts.score,
				bestOfflinePassed: bestOffline >= 0.99,
				nominatedPassed: opts.passed,
			},
		],
		anytime: {
			aulcTokens: opts.score * 0.6,
			aulcBestOfflineTokens: bestOffline * 0.6,
			anytimeNominationLag: Math.max(0, (bestOffline - opts.score) * 0.6),
			aulcWall: opts.score * 0.6,
			scorePer100kTokens: opts.score,
		},
		mechanisms: {
			board: {
				postsTotal: 4,
				postsGlobal: 2,
				postsSubtree: 2,
				promotedCount: 1,
				promotionRate: 0.33,
				citationCount: 2,
				crossSubtreeCitations: 1,
				citationYield: 1,
				supersededCount: 0,
			},
			forest: {
				maxDepth: 1,
				plannerCount: 1,
				workerCount: n,
				plannerTokenShare: 0.1,
				spawnBatchCalls: 1,
				awaitCalls: 1,
				steerOrCancelCalls: 0,
				stragglerSkewRatio: opts.stragglerSkewRatio ?? 1.2,
				kvCacheBustCount: opts.kvCacheBustCount ?? 0,
			},
			governor: {
				scaleEvents: 0,
				scaleUps: 0,
				scaleDowns: 0,
				quotaRetries: 0,
				quotaCooldowns: 0,
				quotaDrainedCount: 0,
				providerDiversityEntropy: 0,
				activeComputeFraction: 1,
			},
			integration: {
				conflictsDetected: opts.conflictsDetected ?? 0,
				conflictsResolved: opts.conflictsResolved ?? 0,
				conflictResolutionRate: 1,
				semanticRegressionsDetected: 0,
				semanticRepairsSucceeded: 0,
				semanticRepairRate: 1,
				monotonicRollbacks: 0,
			},
			search: {
				totalCandidates: 2,
				uniqueDiffShas: 2,
				basinDiversityRatio: 1,
				duplicateWorkWaste: 0,
				escalations: 0,
				handoffs: 0,
			},
			meta: {
				decisionCalls: 2,
				decisionQuestions: 4,
				decisionInputTokens: 1000,
				meanDecisionLatencyMs: 80,
				adaptiveMorphs: 0,
				phaseChanges: 0,
				initialTopology: "adaptive",
				finalTopology: "adaptive",
				boundEstimates: 0,
				estimatedCeiling: null,
				checkpointsTriggered: 0,
				earlyStopDecisions: 0,
				fieldGuideUpdates: 1,
				fieldGuideMaxBytes: 512,
			},
		},
		reproducibility: {
			harnessAdapter: "v2",
			topology: "adaptive",
			controlRung: n === 1 ? "solo" : "swarm",
			budgetMode: "tokens",
			budget: { tokens: 200_000, wallClockMs: 240_000 },
			seed: opts.seed,
			armOrderIndex: 0,
			fixtureSha256: "fix",
			graderSha256: "grd",
			harnessGitSha: opts.genSha,
			dirtyDiffSha: "clean",
			driverIds: ["codex"],
			modelIds: ["gpt"],
		},
		customMetrics: {},
		gradeDetails: opts.passed ? "passed" : "failed hidden tests",
	};
}

function buildSynthetic120EventTrace(dbPath: string, runId: string): void {
	mkdirSync(join(dbPath, ".."), { recursive: true });
	const db = openEvalTraceDb(dbPath);
	try {
		const insEv = db.prepare(
			"INSERT INTO events (ts, run_id, type, node_id, causal_parents, idempotency_key, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		const insDoc = db.prepare(
			"INSERT INTO docs (collection, id, run_id, data, updated_at) VALUES (?, ?, ?, ?, ?)",
		);
		const t0 = 1_700_000_000_000;
		insDoc.run("runs", runId, runId, JSON.stringify({ id: runId, goal: { title: "Synthetic Swarm", text: "Fix MVCC deadlock without bypassing tests" } }), t0);
		insDoc.run("agents", "agt-p1", runId, JSON.stringify({ id: "agt-p1", role: "worker", driverId: "codex", spent: { tokens: 50_000 } }), t0);
		insDoc.run("agents", "agt-p2", runId, JSON.stringify({ id: "agt-p2", role: "worker", driverId: "codex", spent: { tokens: 50_000 } }), t0);
		insDoc.run(
			"posts",
			"post-15",
			runId,
			JSON.stringify({ id: "post-15", authorAgentId: "agt-p1", visibility: "global", title: "Critical Invariant", body: "Never mutate tx_id in wal.py; lock ordering must be A->B" }),
			t0 + 1500,
		);
		insDoc.run(
			"findings",
			"fnd-1",
			runId,
			JSON.stringify({
				id: "fnd-1",
				authorAgentId: "agt-p2",
				status: "accepted",
				claim: "All 40 tests pass cleanly",
				summary: "Updated wal.py",
				evidence: ["pytest passed"],
				score: 0.4,
				submissions: [{ revision: 1, checks: [{ checker: "public-check", status: "failed", message: "3 tests failed in test_wal.py" }] }],
			}),
			t0 + 118_000,
		);

		for (let seq = 1; seq <= 120; seq++) {
			const ts = t0 + seq * 1000;
			if (seq === 15) {
				insEv.run(ts, runId, "board.promoted", "agt-p1", null, null, JSON.stringify({ postId: "post-15", summary: "Critical invariant: lock ordering A->B" }));
			} else if (seq >= 40 && seq <= 46) {
				insEv.run(
					ts,
					runId,
					"driver.tool_result",
					"agt-p1",
					null,
					null,
					JSON.stringify({ tool: "bash", isError: true, outputPreview: `Repeat failing edit #${seq - 39}: AssertionError in mvcc.py` }),
				);
			} else if (seq === 85) {
				insEv.run(
					ts,
					runId,
					"driver.tool_call",
					"agt-p2",
					null,
					null,
					JSON.stringify({ tool: "edit_file", argsPreview: "wal.py (ignoring board invariant A->B)" }),
				);
			} else if (seq === 118) {
				insEv.run(
					ts,
					runId,
					"finding.reported",
					"agt-p2",
					null,
					null,
					JSON.stringify({ findingId: "fnd-1", claim: "All 40 tests pass cleanly" }),
				);
			} else if (seq === 119) {
				insEv.run(
					ts,
					runId,
					"finding.verification",
					"verifier",
					null,
					null,
					JSON.stringify({ findingId: "fnd-1", status: "failed", message: "3 tests failed in test_wal.py" }),
				);
			} else {
				const agent = seq % 2 === 0 ? "agt-p1" : "agt-p2";
				insEv.run(ts, runId, "driver.tool_call", agent, null, null, JSON.stringify({ tool: "read_file", argsPreview: `src/mod_${seq % 7}.py` }));
			}
		}
	} finally {
		db.close();
	}
}

function build150EventScatteredTrace(dbPath: string, runId: string): void {
	mkdirSync(join(dbPath, ".."), { recursive: true });
	const db = openEvalTraceDb(dbPath);
	try {
		const insEv = db.prepare(
			"INSERT INTO events (ts, run_id, type, node_id, causal_parents, idempotency_key, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		const insDoc = db.prepare(
			"INSERT INTO docs (collection, id, run_id, data, updated_at) VALUES (?, ?, ?, ?, ?)",
		);
		const t0 = 1_700_000_000_000;
		insDoc.run("runs", runId, runId, JSON.stringify({ id: runId, goal: { title: "Scattered Bug", text: "Preserve exact schema version" } }), t0);
		insDoc.run("agents", "agt-1", runId, JSON.stringify({ id: "agt-1", role: "worker", driverId: "codex", spent: { tokens: 80_000 } }), t0);
		insDoc.run("agents", "agt-2", runId, JSON.stringify({ id: "agt-2", role: "worker", driverId: "codex", spent: { tokens: 20_000 } }), t0);
		insDoc.run(
			"posts",
			"post-early",
			runId,
			JSON.stringify({ id: "post-early", authorAgentId: "agt-2", visibility: "global", title: "Schema Lock", body: "SCHEMA_LOCK_V2 must not be downgraded" }),
			t0 + 11_000,
		);

		for (let seq = 1; seq <= 150; seq++) {
			const ts = t0 + seq * 1000;
			if (seq === 12) {
				insEv.run(
					ts,
					runId,
					"driver.tool_call",
					"agt-1",
					null,
					null,
					JSON.stringify({ tool: "edit_file", argsPreview: "config.py: EARLY_CONSTRAINT_VIOLATION downgraded SCHEMA_LOCK_V2 -> V1" }),
				);
			} else if (seq === 13) {
				insEv.run(ts, runId, "board.posted", "agt-2", null, null, JSON.stringify({ postId: "post-early", body: "SCHEMA_LOCK_V2 required" }));
			} else {
				insEv.run(ts, runId, "driver.tool_call", "agt-1", null, null, JSON.stringify({ tool: "read_file", argsPreview: `work_${seq}.py` }));
			}
		}
	} finally {
		db.close();
	}
}

class MockJudgeDriver implements WorkerDriver {
	readonly id = "mock-judge";
	readonly kind = "codex-exec" as const;
	readonly capabilities: DriverCapabilities = {
		supportsSteer: false,
		supportsResume: false,
		supportsOutputSchema: false,
		supportsMcpHttp: true,
	};
	readonly handler: (spec: WorkerSpawnSpec, prompt: string) => Promise<WorkerTurnResult>;

	constructor(handler: (spec: WorkerSpawnSpec, prompt: string) => Promise<WorkerTurnResult>) {
		this.handler = handler;
	}

	async healthCheck(): Promise<DriverHealth> {
		return { ok: true, driverId: this.id, kind: this.kind };
	}

	async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
		const driverId = this.id;
		const handler = this.handler;
		return {
			driverId,
			async runTurn(prompt: string): Promise<WorkerTurnResult> {
				return handler(spec, prompt);
			},
			async close(): Promise<void> {},
		};
	}
}

describe("Behavioral Evals-as-Indexes & Escalated Trace Auditing", () => {
	it("enforces TraceScoreRecord schema, atomic batch upserts, and version-aware idempotency in EvalLedger", () => {
		const root = mkdtempSync(join(tmpdir(), "eval-trace-idx-schema-"));
		try {
			const campDir = join(root, "camp-1");
			mkdirSync(campDir, { recursive: true });
			writeFileSync(join(campDir, "protocol.json"), JSON.stringify({ createdAt: "2026-11-26T00:00:00Z", git: { harnessGitSha: "aaaa111" } }));
			writeFileSync(
				join(campDir, "results.jsonl"),
				JSON.stringify(makeCard({ runId: "r1", taskId: "adversarial-spec-forge", genSha: "aaaa111", seed: 1, passed: false, score: 0.4 })) + "\n",
			);

			const ledger = new EvalLedger(join(root, "ledger.sqlite"));
			try {
				ledger.ingestCampaignDir(campDir);
				const runs = ledger.listRuns();
				expect(runs.length).toBe(1);
				const run = runs[0]!;

				const sys1: TraceScoreRecord = {
					scoreId: "ts_sys1_1",
					runKey: run.runKey,
					traceDbPath: "/tmp/trace.db",
					agentId: "agt-1",
					seqStart: 10,
					seqEnd: 20,
					locality: "nearby_window",
					source: "system1_jev",
					judgeName: "thrashing_loop",
					judgeVersion: "v1@11111111",
					model: "jev-latest",
					prob: 0.91,
					confidence: 0.85,
					label: "flagged",
					evidenceSeqs: [14, 15],
					indexedAt: "2026-11-26T01:00:00Z",
				};
				const det: TraceScoreRecord = {
					scoreId: "ts_det_1",
					runKey: run.runKey,
					traceDbPath: "/tmp/trace.db",
					agentId: null,
					seqStart: 1,
					seqEnd: 50,
					locality: "run_summary",
					source: "deterministic",
					judgeName: "stopping_waste",
					judgeVersion: "det-v1",
					model: "deterministic",
					prob: 1.0,
					confidence: 1.0,
					label: "flagged",
					evidenceSeqs: [40],
					rationale: "Burned 60% of tokens post-optimum",
					indexedAt: "2026-11-26T01:00:00Z",
				};

				// Compile-time invariants:
				// @ts-expect-error system1_jev MUST forbid rationale (0 output tokens)
				const _badSys1: TraceScoreRecord = { ...sys1, rationale: "forbidden" };
				void _badSys1;
				// @ts-expect-error deterministic MUST require rationale
				const _badDet: TraceScoreRecord = { ...det, rationale: undefined };
				void _badDet;
				// @ts-expect-error cross_peer_digest MUST have locality='run_summary' and agentId=null
				const _badWin: ExtractedTraceWindow = { windowId: "w", scope: "cross_peer_digest", locality: "nearby_window", agentId: "agt-1", seqStart: 1, seqEnd: 2, anchorSeqs: [], text: "" };
				void _badWin;
				// @ts-expect-error non-novel escalated finding MUST NOT carry suggestedAtomicProbe
				const _badEsc: EscalatedJudgeFinding = { runKey: "k", runId: "r", rootCauseTag: "t", isNovelPattern: false, suggestedAtomicProbe: "dup?", seqStart: 1, seqEnd: 2, agentId: null, rationale: "x", scoreRecord: det };
				void _badEsc;
				// @ts-expect-error status='ok' calibration MUST NOT carry a warning string
				const _badCal: JudgeCalibrationSummary = { judgeName: "j", judgeVersion: "v1", auditedCount: 10, tp: 5, fp: 0, tn: 5, fn: 0, precision: 1, recall: 1, f1: 1, falseNegativeRate: 0, status: "ok", warning: "impossible" };
				void _badCal;

				expect(ledger.upsertTraceScores([sys1, det])).toBe(2);
				const loaded = ledger.listTraceScores({ runKey: run.runKey });
				expect(loaded.length).toBe(2);
				expect(loaded.find((s) => s.scoreId === "ts_sys1_1")?.source).toBe("system1_jev");
				expect(loaded.find((s) => s.scoreId === "ts_det_1")?.rationale).toContain("60%");

				// Same judgeVersion -> already indexed (0 runs queued)
				expect(ledger.listUnindexedRuns(new Map([["thrashing_loop", "v1@11111111"]])).length).toBe(0);
				// Bumped judgeVersion (prompt wording changed) -> automatically re-queued!
				expect(ledger.listUnindexedRuns(new Map([["thrashing_loop", "v1@22222222"]])).length).toBe(1);
			} finally {
				ledger.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("extracts bounded anchored windows, runs Layer 1 + batched System-1 Jev indexing, and skips duplicates on re-run", async () => {
		const root = mkdtempSync(join(tmpdir(), "eval-trace-idx-run-"));
		try {
			const campDir = join(root, "camp-120");
			mkdirSync(campDir, { recursive: true });
			const runId = "spec-forge-s1-adaptive";
			const traceDbPath = join(campDir, "runs", runId, "run", "trace.db");
			buildSynthetic120EventTrace(traceDbPath, runId);

			writeFileSync(join(campDir, "protocol.json"), JSON.stringify({ createdAt: "2026-11-26T00:00:00Z", git: { harnessGitSha: "bbbb222" } }));
			writeFileSync(
				join(campDir, "results.jsonl"),
				JSON.stringify(
					makeCard({
						runId,
						taskId: "adversarial-spec-forge",
						genSha: "bbbb222",
						seed: 1,
						passed: false,
						score: 0.4,
						bestOfflineScore: 0.85,
						stoppingWasteShare: 0.55,
						kvCacheBustCount: 3,
					}),
				) + "\n",
			);

			// Verify window extraction bounds & anchors
			const snap = loadOfflineTraceSnapshot(traceDbPath, runId);
			const windows = extractTraceWindows(snap, { swarmSize: 4 });
			const nearby = windows.filter((w) => w.scope === "nearby_window");
			const crossPeer = windows.filter((w) => w.scope === "cross_peer_digest");
			const claimEv = windows.filter((w) => w.scope === "claim_evidence_digest");
			expect(nearby.length).toBeGreaterThanOrEqual(1);
			expect(nearby.some((w) => w.anchorSeqs.includes(40))).toBe(true);
			expect(crossPeer.length).toBe(1);
			expect(crossPeer[0]!.text).toContain("post-15");
			expect(claimEv.length).toBe(1);
			expect(claimEv[0]!.text).toContain("All 40 tests pass cleanly");

			// Verify classifyProb boundaries
			expect(classifyProb(0.85, 0.7)).toBe("flagged");
			expect(classifyProb(0.15, 0.7)).toBe("clean");
			expect(classifyProb(0.5, 0.9)).toBe("uncertain");
			expect(classifyProb(0.9, 0.3)).toBe("uncertain");

			// Mock Jev DecisionModelClient returning calibrated noul answers in a single batch per window
			const requests: DecisionRequest[] = [];
			const mockJev: DecisionModelClient = {
				provider: "typesafe-jev",
				model: "jev-mock",
				async decide(req: DecisionRequest): Promise<DecisionResponse> {
					requests.push(req);
					const answers: DecisionResponse["answers"] = {};
					for (const qKey of Object.keys(req.questions)) {
						const stateStr = typeof req.state === "string" ? req.state : JSON.stringify(req.state);
						if (qKey === "thrashing_loop" && stateStr.includes("Repeat failing edit")) {
							answers[qKey] = { type: "noul", noul: 0.92, confidence: 0.88 };
						} else if (qKey === "ignored_board_signal" && stateStr.includes("post-15")) {
							answers[qKey] = { type: "noul", noul: 0.89, confidence: 0.84 };
						} else if (qKey === "unverified_success_claim" && stateStr.includes("3 tests failed")) {
							answers[qKey] = { type: "noul", noul: 0.95, confidence: 0.9 };
						} else {
							answers[qKey] = { type: "noul", noul: 0.08, confidence: 0.86 };
						}
					}
					return { answers, inputTokens: 1200, outputTokens: 0, latencyMs: 12, provider: "typesafe-jev", model: "jev-mock" };
				},
			};

			const ledger = new EvalLedger(join(root, "ledger.sqlite"));
			try {
				ledger.ingestCampaignDir(campDir);
				const res1 = await indexLedgerTraces({ ledger, decisionClient: mockJev });
				expect(res1.runsIndexed).toBe(1);
				expect(res1.deterministicRowsWritten).toBeGreaterThanOrEqual(3); // nomination_loss, stopping_waste, kv_cache_thrash
				expect(res1.system1RowsWritten).toBeGreaterThanOrEqual(8);
				expect(res1.jevRequestsSent).toBe(windows.length);
				// Every batched request asked multiple atomic noul questions in a single pass
				expect(requests.some((r) => Object.keys(r.questions).length === 3)).toBe(true);

				const flaggedNames = new Set(ledger.listTraceScores({ label: "flagged" }).map((s) => s.judgeName));
				expect(flaggedNames.has("nomination_loss")).toBe(true);
				expect(flaggedNames.has("stopping_waste")).toBe(true);
				expect(flaggedNames.has("kv_cache_thrash")).toBe(true);
				expect(flaggedNames.has("thrashing_loop")).toBe(true);
				expect(flaggedNames.has("ignored_board_signal")).toBe(true);
				expect(flaggedNames.has("unverified_success_claim")).toBe(true);

				// Idempotency: re-running with the same probe catalog MUST send 0 Jev calls and write 0 rows!
				const res2 = await indexLedgerTraces({ ledger, decisionClient: mockJev });
				expect(res2.jevRequestsSent).toBe(0);
				expect(res2.system1RowsWritten).toBe(0);
				expect(res2.deterministicRowsWritten).toBe(0);
			} finally {
				ledger.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("computes failure buckets, failure lift, gen-over-gen deltas, unclassified failures, and Observatory Chart 7", () => {
		const root = mkdtempSync(join(tmpdir(), "eval-trace-diagnose-"));
		try {
			const g1Dir = join(root, "g1");
			const g2Dir = join(root, "g2");
			mkdirSync(g1Dir, { recursive: true });
			mkdirSync(g2Dir, { recursive: true });
			writeFileSync(join(g1Dir, "protocol.json"), JSON.stringify({ createdAt: "2026-11-24T00:00:00Z", git: { harnessGitSha: "1111aaa" } }));
			writeFileSync(join(g2Dir, "protocol.json"), JSON.stringify({ createdAt: "2026-11-25T00:00:00Z", git: { harnessGitSha: "2222bbb" } }));

			const g1Cards = [
				makeCard({ runId: "g1-f1", taskId: "t1", genSha: "1111aaa", seed: 1, passed: false, score: 0.2 }),
				makeCard({ runId: "g1-f2", taskId: "t1", genSha: "1111aaa", seed: 2, passed: false, score: 0.3 }),
				makeCard({ runId: "g1-f3-unclass", taskId: "t1", genSha: "1111aaa", seed: 3, passed: false, score: 0.1 }),
				makeCard({ runId: "g1-p1", taskId: "t1", genSha: "1111aaa", seed: 4, passed: true, score: 1.0 }),
				makeCard({ runId: "g1-p2", taskId: "t1", genSha: "1111aaa", seed: 5, passed: true, score: 1.0 }),
				makeCard({ runId: "g1-p3", taskId: "t1", genSha: "1111aaa", seed: 6, passed: true, score: 1.0 }),
			];
			const g2Cards = [
				makeCard({ runId: "g2-p1", taskId: "t1", genSha: "2222bbb", seed: 1, passed: true, score: 1.0 }),
				makeCard({ runId: "g2-p2", taskId: "t1", genSha: "2222bbb", seed: 2, passed: true, score: 1.0 }),
				makeCard({ runId: "g2-p3", taskId: "t1", genSha: "2222bbb", seed: 3, passed: true, score: 1.0 }),
				makeCard({ runId: "g2-p4", taskId: "t1", genSha: "2222bbb", seed: 4, passed: true, score: 1.0 }),
			];
			writeFileSync(join(g1Dir, "results.jsonl"), g1Cards.map((c) => JSON.stringify(c)).join("\n") + "\n");
			writeFileSync(join(g2Dir, "results.jsonl"), g2Cards.map((c) => JSON.stringify(c)).join("\n") + "\n");

			const ledger = new EvalLedger(join(root, "ledger.sqlite"));
			try {
				ledger.ingestCampaignDir(g1Dir);
				ledger.ingestCampaignDir(g2Dir);
				const runs = ledger.listRuns();
				const byId = new Map(runs.map((r) => [r.runId, r]));

				const mkScore = (id: string, runId: string, judgeName: string, label: "flagged" | "clean", prob: number): TraceScoreRecord => ({
					scoreId: id,
					runKey: byId.get(runId)!.runKey,
					traceDbPath: "/tmp/t.db",
					agentId: "agt-1",
					seqStart: 10,
					seqEnd: 20,
					locality: "run_summary",
					source: "system1_jev",
					judgeName,
					judgeVersion: "v1@abcd1234",
					model: "jev-latest",
					prob,
					confidence: 0.9,
					label,
					evidenceSeqs: [12],
					indexedAt: "2026-11-26T00:00:00Z",
				});

				// High-lift root cause: `ignored_board_signal` appears ONLY on failed runs (g1-f1, g1-f2)
				// Low-lift background noise: `verbose_thinking` appears equally on failed (g1-f1) and passing (g1-p1, g1-p2, g1-p3, g2-p1) runs
				// Unclassified failure: `g1-f3-unclass` has ONLY clean labels
				ledger.upsertTraceScores([
					mkScore("s1", "g1-f1", "ignored_board_signal", "flagged", 0.92),
					mkScore("s2", "g1-f2", "ignored_board_signal", "flagged", 0.88),
					mkScore("s3", "g1-f1", "verbose_thinking", "flagged", 0.85),
					mkScore("s4", "g1-p1", "verbose_thinking", "flagged", 0.85),
					mkScore("s5", "g1-p2", "verbose_thinking", "flagged", 0.85),
					mkScore("s6", "g1-p3", "verbose_thinking", "flagged", 0.85),
					mkScore("s7", "g2-p1", "verbose_thinking", "flagged", 0.85),
					mkScore("s8", "g1-f3-unclass", "ignored_board_signal", "clean", 0.08),
				]);

				const diag = analyzeFailureBuckets(ledger);
				expect(diag.totalFailedRuns).toBe(3);
				expect(diag.unclassifiedFailures.map((u) => u.runId)).toEqual(["g1-f3-unclass"]);

				const boardBucket = diag.buckets.find((b) => b.judgeName === "ignored_board_signal")!;
				const noiseBucket = diag.buckets.find((b) => b.judgeName === "verbose_thinking")!;
				// Base failure rate = 3/10 = 0.30. P(fail | ignored_board_signal) = 2/2 = 1.0 -> lift = 3.33x!
				expect(boardBucket.failureLift).toBeGreaterThan(3.0);
				// P(fail | verbose_thinking) = 1/5 = 0.20 -> lift = 0.67x (harmless habit, not root cause!)
				expect(noiseBucket.failureLift).toBeLessThan(1.0);
				expect(diag.buckets[0]!.judgeName).toBe("ignored_board_signal");

				const md = renderFailureBucketsMarkdown(diag, { showEvidence: true });
				expect(md).toContain("ignored_board_signal");
				expect(md).toContain("g1-f3-unclass");

				// Gen-over-gen behavioral delta: ignored_board_signal drops from 33.3% (2/6) -> 0% (0/4)
				const deltas = compareBucketsAcrossGenerations(ledger, "sha-1111aaa", "sha-2222bbb");
				const boardDelta = deltas.find((d) => d.judgeName === "ignored_board_signal")!;
				expect(boardDelta.deltaPp).toBeLessThan(-30);

				// Observatory Chart 7 renders when trace_scores exist!
				const traj = analyzeTrajectory(ledger);
				expect(traj.behavioralDiagnostics?.indexedRuns).toBeGreaterThan(0);
				const obsDir = join(root, "obs");
				const artifacts = generateObservatory(traj, obsDir);
				expect(Object.keys(artifacts.chartPaths).length).toBe(7);
				expect(existsSync(artifacts.chartPaths["07-behavioral-failure-modes"]!)).toBe(true);
				const svg7 = readFileSync(artifacts.chartPaths["07-behavioral-failure-modes"]!, "utf8");
				expect(svg7).toContain("ignored_board_signal");
				const html = readFileSync(artifacts.htmlPath, "utf8");
				expect(html).toContain("Behavioral Failure Buckets");
			} finally {
				ledger.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("locates scattered seq 12 root causes via trace_nav tools and records escalated_judge findings with suggestedAtomicProbe", async () => {
		const root = mkdtempSync(join(tmpdir(), "eval-trace-escalate-"));
		try {
			const campDir = join(root, "camp-esc");
			mkdirSync(campDir, { recursive: true });
			const runId = "scattered-s1-adaptive";
			const traceDbPath = join(campDir, "runs", runId, "run", "trace.db");
			build150EventScatteredTrace(traceDbPath, runId);

			writeFileSync(join(campDir, "protocol.json"), JSON.stringify({ createdAt: "2026-11-26T00:00:00Z", git: { harnessGitSha: "3333ccc" } }));
			writeFileSync(
				join(campDir, "results.jsonl"),
				JSON.stringify(makeCard({ runId, taskId: "horizon-repo-migration", genSha: "3333ccc", seed: 1, passed: false, score: 0.25 })) + "\n",
			);

			// 1. Directly exercise the 5 offline trace navigation tools on the 150-event trace
			const tools = createOfflineTraceNavTools({ traceDbPath, runId });
			const toolByName = new Map(tools.map((t) => [t.name, t]));
			const dummyCtx = { runId, agentId: "judge", role: "reviewer" as const, signal: new AbortController().signal };

			const searchRes = await toolByName.get("trace_search_events")!.execute({ query: "EARLY_CONSTRAINT_VIOLATION" }, dummyCtx);
			expect(searchRes.text).toContain("[seq 12]");
			expect(searchRes.text).toContain("SCHEMA_LOCK_V2");

			const expandRes = await toolByName.get("trace_expand_window")!.execute({ seq_start: 12, seq_end: 12, radius: 2 }, dummyCtx);
			expect(expandRes.text).toContain("[seq 10]");
			expect(expandRes.text).toContain("[seq 14]");

			const peerRes = await toolByName.get("trace_get_peer_context")!.execute({ around_seq: 12, radius: 3, exclude_agent_id: "agt-1" }, dummyCtx);
			expect(peerRes.text).toContain("post-early");

			const postRes = await toolByName.get("trace_read_evidence")!.execute({ kind: "post", id: "post-early" }, dummyCtx);
			expect(postRes.text).toContain("SCHEMA_LOCK_V2 must not be downgraded");

			// 2. Run Tier-2 escalation via SwarmOS + MockJudgeDriver and verify DB persistence
			const ledger = new EvalLedger(join(root, "ledger.sqlite"));
			try {
				ledger.ingestCampaignDir(campDir);
				let judgeSawNavTools: string[] = [];
				const mockDriver = new MockJudgeDriver(async (spec) => {
					judgeSawNavTools = [...(spec.mcp?.toolNames ?? [])];
					return {
						status: "completed",
						model: "mock-frontier-1",
						finalText: JSON.stringify({
							rootCauseTag: "silent_schema_downgrade",
							isNovelPattern: true,
							seqStart: 12,
							seqEnd: 13,
							agentId: "agt-1",
							rationale: "At seq 12 agt-1 downgraded SCHEMA_LOCK_V2 despite peer post at seq 13.",
							suggestedAtomicProbe: "Did an agent downgrade a schema version constant contrary to constraints?",
						}),
					};
				});
				const router = new DriverQuotaRouter({
					drivers: [{ driver: mockDriver, config: { id: "mock-judge", kind: "codex-exec" } }],
					roles: { default: ["mock-judge"], reviewer: ["mock-judge"] },
				});

				const escalated = await escalateUnexplainedFailures({ ledger, router, maxEscalate: 3 });
				expect(escalated.length).toBe(1);
				expect(escalated[0]!.rootCauseTag).toBe("silent_schema_downgrade");
				expect(escalated[0]!.isNovelPattern).toBe(true);
				expect(escalated[0]!.suggestedAtomicProbe).toContain("schema version");
				expect(judgeSawNavTools).toContain("trace_search_events");
				expect(judgeSawNavTools).toContain("trace_expand_window");

				// Persisted in trace_scores with source='escalated_judge', removing run from unclassifiedFailures!
				const stored = ledger.listTraceScores({ source: "escalated_judge" });
				expect(stored.length).toBe(1);
				expect(stored[0]!.locality).toBe("escalated_span");
				expect(stored[0]!.seqStart).toBe(12);
				expect(analyzeFailureBuckets(ledger).unclassifiedFailures.length).toBe(0);
			} finally {
				ledger.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("oversamples clean-on-fail runs in sampleAuditQueue and triggers CALIBRATION_WARNING when FNR > 15%", () => {
		const root = mkdtempSync(join(tmpdir(), "eval-trace-audit-"));
		try {
			const campDir = join(root, "camp-aud");
			mkdirSync(campDir, { recursive: true });
			writeFileSync(join(campDir, "protocol.json"), JSON.stringify({ createdAt: "2026-11-26T00:00:00Z", git: { harnessGitSha: "4444ddd" } }));
			const cards: Scorecard[] = [];
			for (let i = 1; i <= 14; i++) {
				cards.push(makeCard({ runId: `r-${i}`, taskId: "t1", genSha: "4444ddd", seed: i, passed: i > 10, score: i > 10 ? 1 : 0.2 }));
			}
			writeFileSync(join(campDir, "results.jsonl"), cards.map((c) => JSON.stringify(c)).join("\n") + "\n");

			const ledger = new EvalLedger(join(root, "ledger.sqlite"));
			try {
				ledger.ingestCampaignDir(campDir);
				const runs = ledger.listRuns();
				const scores: TraceScoreRecord[] = runs.map((r, i) => ({
					scoreId: `ts_aud_${i}`,
					runKey: r.runKey,
					traceDbPath: "",
					agentId: "agt-1",
					seqStart: 1,
					seqEnd: 10,
					locality: "nearby_window",
					source: "system1_jev",
					judgeName: "thrashing_loop",
					judgeVersion: SYSTEM1_PROBE_CATALOG[0]!.judgeVersion,
					model: "jev-latest",
					prob: i < 6 ? 0.1 : i < 10 ? 0.85 : 0.5,
					confidence: i < 10 ? 0.9 : 0.4,
					label: i < 6 ? "clean" : i < 10 ? "flagged" : "uncertain",
					evidenceSeqs: [5],
					indexedAt: "2026-11-26T00:00:00Z",
				}));
				ledger.upsertTraceScores(scores);

				// Sample 10: should oversample clean_on_fail (~50% = 5 items)
				const queue = sampleAuditQueue(ledger, { sampleSize: 10, seed: 7 });
				expect(queue.length).toBe(10);
				expect(queue.filter((q) => q.stratum === "clean_on_fail").length).toBe(5);
				expect(queue.filter((q) => q.stratum === "flagged").length).toBe(3);
				expect(queue.filter((q) => q.stratum === "uncertain").length).toBe(2);

				// Record 10 audits where 3 of the "clean" items were actually flagged (high FNR = 3 / (3 + 3) = 50% > 15%!)
				for (let i = 0; i < queue.length; i++) {
					const item = queue[i]!;
					const truth: "flagged" | "clean" =
						item.stratum === "flagged"
							? "flagged"
							: item.stratum === "clean_on_fail" && i < 3
								? "flagged"
								: "clean";
					ledger.recordTraceAudit({
						auditId: `aud_${i}`,
						scoreId: item.score.scoreId,
						auditor: "human",
						groundTruth: truth,
						auditedAt: "2026-11-26T01:00:00Z",
					});
				}

				const cal = computeJudgeCalibration(ledger);
				expect(cal.length).toBe(1);
				expect(cal[0]!.auditedCount).toBe(10);
				expect(cal[0]!.fn).toBe(3);
				expect(cal[0]!.tp).toBe(3);
				expect(cal[0]!.falseNegativeRate).toBeCloseTo(0.5, 4);
				expect(cal[0]!.warning).toContain("CALIBRATION_WARNING");
			} finally {
				ledger.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
