import { existsSync } from "node:fs";
import {
	toScorecardFaultState,
	type AgentRoleCategory,
	type AnytimeMetrics,
	type AnytimePoint,
	type CanonicalEvent,
	type EvalTask,
	type GradeReport,
	type HarnessRunReceipt,
	type HarnessRunSpec,
	type LossDecomposition,
	type MechanismTelemetry,
	type PreparedTask,
	type Scorecard,
	type SwarmDynamics,
	type TimeComputeBreakdown,
	type TokenBreakdown,
} from "./contracts.ts";
import { readRunEvents, type AgentDocSummary, type PostDocSummary } from "./event-reader.ts";
import { detectHarnessFaults, gitReproducibility } from "./sandbox.ts";

const COORDINATION_TOOLS = new Set([
	"ask_peer",
	"message_peer",
	"read_environment",
	"share_context",
	"swarm_task",
	"post_board",
	"read_board",
	"read_board_post",
	"board_search",
	"board_publish",
	"board_visit",
	"board_wait",
	"spawn_children",
	"spawn_agent",
	"spawn_task",
	"wait_for_children",
	"yield_until",
	"list_children",
	"steer_child",
	"cut_child",
	"reallocate_budget",
	"ask",
	"respond_to_question",
	"search_board",
	"claim_task",
	"complete_task",
	"release_task",
	"run_swarm_script",
]);

const VERIFICATION_TOOLS = new Set([
	"report_finding",
	"nominate",
	"inspect_finding",
	"submit_verdict",
	"challenge_finding",
	"run_check",
	"verify_candidate",
	"recommend",
	"decide_epoch",
	"request_epoch_review",
]);

const WORK_TOOLS = new Set([
	"bash",
	"terminal",
	"read_file",
	"write_file",
	"edit_file",
	"grep_files",
	"load_skill",
	"call_tool",
	"apply_workspace_change",
	"list_files",
	"submit_job",
	"wait_job",
	"job_status",
	"read_artifact",
	"write_checkpoint",
	"finish",
	"code_read",
	"code_edit",
	"code_publish",
	"code_sign",
	"kernel_try",
	"kernel_read",
	"kernel_finish",
]);

function computeParallelism(events: readonly CanonicalEvent[], endTs: number): { avg: number; peak: number } {
	const changes = events.filter(
		(e) =>
			(e.type === "node.status" ||
				e.type === "agent.status" ||
				e.type === "node.spawned" ||
				e.type === "agent.spawned") &&
			e.agentId,
	);
	if (!changes.length) return { avg: 0, peak: 0 };
	const running = new Set<string>();
	let lastTs = changes[0]!.ts;
	let area = 0;
	let peak = 0;
	for (const e of changes) {
		area += running.size * Math.max(0, e.ts - lastTs);
		lastTs = e.ts;
		if (e.type === "node.spawned" || e.type === "agent.spawned" || e.data.status === "running") {
			running.add(e.agentId!);
		} else {
			running.delete(e.agentId!);
		}
		if (running.size > peak) peak = running.size;
	}
	const finalTs = Math.max(lastTs, Math.min(endTs, events.at(-1)?.ts ?? endTs));
	area += running.size * Math.max(0, finalTs - lastTs);
	const span = Math.max(1, finalTs - changes[0]!.ts);
	return { avg: Math.round((area / span) * 100) / 100, peak };
}

function classifyCallCategory(
	role: AgentRoleCategory,
	nextTools: readonly string[],
): "work" | "coordination" | "verification" | "other" {
	if (role === "reviewer") return "verification";
	if (role === "coordinator") return "coordination";
	if (!nextTools.length) return role === "refinery" ? "work" : "other";
	let coord = 0;
	let verif = 0;
	let work = 0;
	for (const name of nextTools) {
		if (VERIFICATION_TOOLS.has(name)) verif++;
		else if (COORDINATION_TOOLS.has(name)) coord++;
		else if (WORK_TOOLS.has(name)) work++;
	}
	if (verif > 0 && verif >= coord && verif >= work) return "verification";
	if (coord > 0 && coord >= work) return "coordination";
	if (work > 0) return "work";
	return "other";
}

function betterScore(a: number, b: number, higherIsBetter: boolean): boolean {
	return higherIsBetter ? a > b : a < b;
}

function round4(x: number): number {
	return Number.isFinite(x) ? Math.round(x * 10_000) / 10_000 : 0;
}

function clamp01(x: number): number {
	if (!Number.isFinite(x)) return 0;
	return Math.max(0, Math.min(1, x));
}

function computeStepAulc(
	points: readonly { x: number; y: number }[],
	horizon: number,
): number {
	if (!points.length || horizon <= 0) return 0;
	const sorted = [...points].sort((a, b) => a.x - b.x);
	let area = 0;
	let prevX = 0;
	let prevY = 0;
	for (const pt of sorted) {
		const cx = Math.max(prevX, Math.min(horizon, pt.x));
		area += (cx - prevX) * prevY;
		prevX = cx;
		prevY = Math.max(prevY, clamp01(pt.y));
	}
	if (prevX < horizon) {
		area += (horizon - prevX) * prevY;
	}
	return round4(clamp01(area / horizon));
}

function computeAnytimeMetrics(params: {
	frontier: readonly AnytimePoint[];
	spec: HarnessRunSpec;
	prepared: PreparedTask;
	higherIsBetter: boolean;
	deliveredScore: number;
	bestOfflineScore: number;
	totalTokens: number;
	wallClockMs: number;
	estimatedUsd: number;
}): AnytimeMetrics {
	const { frontier, spec, prepared, higherIsBetter, deliveredScore, bestOfflineScore, totalTokens, wallClockMs, estimatedUsd } = params;
	const floor = prepared.incumbentScore ?? 0;
	const ceiling =
		prepared.theoreticalCeiling ??
		(prepared.incumbentScore !== undefined
			? Math.max(floor + 1e-6, bestOfflineScore, deliveredScore)
			: 1);
	const span = Math.max(1e-6, Math.abs(ceiling - floor));
	const norm = (score: number): number => {
		if (!Number.isFinite(score)) return 0;
		return higherIsBetter ? clamp01((score - floor) / span) : clamp01((floor - score) / span);
	};

	const tokenHorizon = Math.max(spec.budget.tokens ?? 0, totalTokens, 1);
	const wallHorizon = Math.max(spec.budget.wallClockMs ?? 0, wallClockMs, 1);

	const aulcTokens = computeStepAulc(
		frontier.map((p) => ({ x: p.atTokens, y: norm(p.nominatedScore) })),
		tokenHorizon,
	);
	const aulcBestOfflineTokens = computeStepAulc(
		frontier.map((p) => ({ x: p.atTokens, y: norm(p.bestOfflineScore) })),
		tokenHorizon,
	);
	const aulcWall = computeStepAulc(
		frontier.map((p) => ({ x: p.atWallMs, y: norm(p.nominatedScore) })),
		wallHorizon,
	);
	const scorePer100kTokens = round4(deliveredScore / Math.max(0.1, totalTokens / 100_000));
	return {
		aulcTokens,
		aulcBestOfflineTokens,
		anytimeNominationLag: round4(Math.max(0, aulcBestOfflineTokens - aulcTokens)),
		aulcWall,
		scorePer100kTokens,
		...(estimatedUsd > 0 ? { scorePerUsd: round4(deliveredScore / estimatedUsd) } : {}),
	};
}

function shannonEntropyBits(counts: Iterable<number>): number {
	const vals = [...counts].filter((c) => c > 0);
	const total = vals.reduce((s, c) => s + c, 0);
	if (total <= 0 || vals.length <= 1) return 0;
	let h = 0;
	for (const c of vals) {
		const p = c / total;
		h -= p * Math.log2(p);
	}
	return round4(h);
}

function medianNumber(values: readonly number[]): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function extractMechanismTelemetry(params: {
	events: readonly CanonicalEvent[];
	agentDocs: readonly AgentDocSummary[];
	postDocs: readonly PostDocSummary[];
	receipt: HarnessRunReceipt;
	spec: HarnessRunSpec;
	prepared: PreparedTask;
	tokens: TokenBreakdown;
	time: TimeComputeBreakdown;
	dynamics: SwarmDynamics;
}): MechanismTelemetry {
	const { events, agentDocs, postDocs, receipt, spec, prepared, tokens, time, dynamics } = params;

	// 1. Board v2 Epistemic Telemetry
	const postEvents = events.filter((e) => e.type === "board.posted");
	const promotedEvents = events.filter((e) => e.type === "board.promoted");
	const postById = new Map<string, PostDocSummary>();
	for (const p of postDocs) postById.set(p.id, p);

	const postsTotal = Math.max(postDocs.length, postEvents.length);
	let postsGlobal = 0;
	let postsSubtree = 0;
	let citationCount = 0;
	let crossSubtreeCitations = 0;
	let supersededCount = 0;

	if (postDocs.length > 0) {
		for (const p of postDocs) {
			if (p.visibility === "subtree") postsSubtree++;
			else postsGlobal++;
			if (p.supersededBy) supersededCount++;
			if (p.parentIds?.length) {
				citationCount += p.parentIds.length;
				for (const pid of p.parentIds) {
					const parent = postById.get(pid);
					if (
						parent &&
						((p.subtreeId && parent.subtreeId && p.subtreeId !== parent.subtreeId) ||
							(p.authorAgentId && parent.authorAgentId && p.authorAgentId !== parent.authorAgentId))
					) {
						crossSubtreeCitations++;
					}
				}
			}
		}
	} else {
		postsGlobal = postEvents.length;
		for (const e of postEvents) {
			if (typeof e.data.supersedes === "string" && e.data.supersedes) supersededCount++;
		}
	}

	const promotedCount = promotedEvents.length;
	const novelties = promotedEvents.map((e) => Number(e.data.novelty)).filter(Number.isFinite);
	const broadcastProbs = promotedEvents.map((e) => Number(e.data.broadcastProb)).filter(Number.isFinite);
	const crossoverProbs = promotedEvents.map((e) => Number(e.data.crossoverProb)).filter(Number.isFinite);
	const meanOf = (arr: readonly number[]) => (arr.length ? round4(arr.reduce((s, x) => s + x, 0) / arr.length) : undefined);

	// 2. Recursive Forest & Straggler / KV Cache Geometry
	let maxDepth = 0;
	let plannerCount = 0;
	let workerCount = 0;
	let plannerTokens = 0;
	if (agentDocs.length > 0) {
		for (const ag of agentDocs) {
			if (typeof ag.depth === "number" && ag.depth > maxDepth) maxDepth = ag.depth;
			if (ag.role.toLowerCase().includes("plan") || ag.role === "coordinator") {
				plannerCount++;
				plannerTokens += ag.spentTokens;
			} else if (ag.role === "worker") {
				workerCount++;
			}
		}
	} else {
		for (const e of events) {
			if (e.type === "agent.spawned") {
				const r = String(e.data.role ?? "worker").toLowerCase();
				if (r.includes("plan") || r === "coordinator") plannerCount++;
				else if (r === "worker") workerCount++;
			}
		}
		plannerTokens = tokens.byRole.coordinator;
	}

	// Straggler skew ratio across agents with recorded turn durations
	const wallByAgent = new Map<string, number>();
	const lastCacheHitByAgent = new Map<string, number>();
	let kvCacheBustCount = 0;
	const driverTurnCounts = new Map<string, number>();
	for (const e of events) {
		if (e.type === "agent.turn") {
			if (e.agentId) {
				const dur = Number(e.data.durationMs ?? 0);
				if (dur > 0) wallByAgent.set(e.agentId, (wallByAgent.get(e.agentId) ?? 0) + dur);
				if (typeof e.data.cacheHitRate === "number" && Number.isFinite(e.data.cacheHitRate)) {
					const prev = lastCacheHitByAgent.get(e.agentId);
					if (prev !== undefined && prev - e.data.cacheHitRate > 0.35) {
						kvCacheBustCount++;
					}
					lastCacheHitByAgent.set(e.agentId, e.data.cacheHitRate);
				}
			}
			const drv = typeof e.data.driverId === "string" ? e.data.driverId : undefined;
			if (drv) driverTurnCounts.set(drv, (driverTurnCounts.get(drv) ?? 0) + 1);
		} else if (e.type === "model.call") {
			const drv = typeof e.data.driver === "string" ? e.data.driver : typeof e.data.provider === "string" ? e.data.provider : undefined;
			if (drv) driverTurnCounts.set(drv, (driverTurnCounts.get(drv) ?? 0) + 1);
		}
	}
	const agentWalls = [...wallByAgent.values()].filter((w) => w > 0);
	const medWall = medianNumber(agentWalls);
	const stragglerSkewRatio = agentWalls.length >= 2 && medWall > 0 ? round4(Math.max(...agentWalls) / medWall) : 1;

	// 3. AIMD Physics Governor & Quota Dynamics
	const scaleEvents = events.filter((e) => e.type === "governor.scaled");
	let scaleUps = 0;
	let scaleDowns = 0;
	const windows: number[] = [];
	const freeMems: number[] = [];
	const cpuLoads: number[] = [];
	for (const e of scaleEvents) {
		const prevW = Number(e.data.prevWindow ?? 0);
		const nextW = Number(e.data.nextWindow ?? 0);
		if (nextW > prevW) scaleUps++;
		else if (nextW < prevW) scaleDowns++;
		if (nextW > 0) windows.push(nextW);
		if (typeof e.data.freeMemMb === "number" && Number.isFinite(e.data.freeMemMb)) freeMems.push(e.data.freeMemMb);
		if (typeof e.data.cpuLoadRatio === "number" && Number.isFinite(e.data.cpuLoadRatio)) cpuLoads.push(e.data.cpuLoadRatio);
	}
	const quotaRetries = events.filter((e) => e.type === "quota.retry").length;
	const quotaCooldowns = events.filter((e) => e.type === "quota.cooldown").length;
	const quotaDrainedCount = events.filter((e) => e.type === "quota.drained").length;

	// 4. Integration & Semantic Repair Forensics
	const peerConflictsDetected = events.filter((e) => e.type === "peer.conflict_detected").length;
	const peerConflictsResolved = events.filter((e) => e.type === "peer.conflict_resolved").length;
	const refineryConflictsResolved = events.filter((e) => e.type === "refinery.conflict_resolved").length;
	const conflictsResolved = peerConflictsResolved + refineryConflictsResolved;
	const conflictsDetected = Math.max(peerConflictsDetected + refineryConflictsResolved, conflictsResolved);

	const semRegEvents = events.filter((e) => e.type === "refinery.semantic_regression");
	const peerRepairEvents = events.filter((e) => e.type === "peer.trunk_repaired");
	const semanticRegressionsDetected = semRegEvents.length + peerRepairEvents.length;
	const semanticRepairsSucceeded =
		semRegEvents.filter((e) => e.data.repaired === true).length +
		peerRepairEvents.filter((e) => e.data.repaired === true).length;
	const monotonicRollbacks = semRegEvents.filter((e) => e.data.rolledBack === true).length;

	// 5. Search Diversity & Evolution
	const totalCandidates = receipt.candidateSnapshots.length;
	const uniqueDiffShas = new Set(receipt.candidateSnapshots.map((s) => s.sha256)).size;
	const basinDiversityRatio = totalCandidates > 0 ? round4(uniqueDiffShas / totalCandidates) : 1;
	const escalations = events.filter((e) => e.type === "agent.escalated").length;
	const handoffs = events.filter((e) => e.type === "agent.handoff").length;

	// 6. Meta-Control, Jev Decision Client & Bound Analyst Calibration
	const decisionEvents = events.filter((e) => e.type === "decision.evaluated");
	const decisionQuestions = decisionEvents.reduce((s, e) => s + Number(e.data.questionCount ?? 0), 0);
	const decisionInputTokens = decisionEvents.reduce((s, e) => s + Number(e.data.inputTokens ?? 0), 0);
	const meanDecisionLatencyMs = decisionEvents.length
		? round4(decisionEvents.reduce((s, e) => s + Number(e.data.latencyMs ?? 0), 0) / decisionEvents.length)
		: 0;

	const morphEvents = events.filter((e) => e.type === "adaptive.morphed");
	const phaseChanges = events.filter((e) => e.type === "phase.changed").length;
	const initialTopology = spec.topology ?? spec.controlRung;
	const finalTopology = morphEvents.length ? String(morphEvents.at(-1)!.data.to ?? initialTopology) : initialTopology;

	const boundEvents = events.filter((e) => e.type === "bound.estimated");
	let estimatedCeiling: number | null = null;
	for (let i = boundEvents.length - 1; i >= 0; i--) {
		const raw = boundEvents[i]!.data.estimatedCeiling;
		if (typeof raw === "number" && Number.isFinite(raw)) {
			estimatedCeiling = raw;
			break;
		}
	}
	const groundTruthCeiling = prepared.theoreticalCeiling;
	const boundCalibrationError =
		estimatedCeiling !== null && groundTruthCeiling !== undefined && groundTruthCeiling !== 0
			? round4(Math.abs(estimatedCeiling - groundTruthCeiling) / Math.abs(groundTruthCeiling))
			: undefined;

	const checkpointEvents = events.filter((e) => e.type === "researcher.checkpoint");
	const earlyStopDecisions = checkpointEvents.filter((e) => String(e.data.action ?? "") === "coalesce").length;

	const fgEvents = events.filter((e) => e.type === "field_guide.updated");
	const fieldGuideMaxBytes = fgEvents.reduce((m, e) => Math.max(m, Number(e.data.bytes ?? 0)), 0);

	return {
		board: {
			postsTotal,
			postsGlobal,
			postsSubtree,
			promotedCount,
			promotionRate: postsSubtree + promotedCount > 0 ? round4(promotedCount / Math.max(1, postsSubtree + promotedCount)) : 0,
			...(novelties.length ? { avgPromotedNovelty: meanOf(novelties) } : {}),
			...(broadcastProbs.length ? { avgPromotedBroadcastProb: meanOf(broadcastProbs) } : {}),
			...(crossoverProbs.length ? { avgPromotedCrossoverProb: meanOf(crossoverProbs) } : {}),
			citationCount,
			crossSubtreeCitations,
			citationYield: promotedCount + postsGlobal > 0 ? round4(crossSubtreeCitations / Math.max(1, promotedCount || postsGlobal)) : 0,
			supersededCount,
		},
		forest: {
			maxDepth,
			plannerCount,
			workerCount,
			plannerTokenShare: tokens.total > 0 ? round4(plannerTokens / tokens.total) : 0,
			spawnBatchCalls: dynamics.toolCallsByName.spawn_agents ?? 0,
			awaitCalls: dynamics.toolCallsByName.await_agents ?? 0,
			steerOrCancelCalls: dynamics.toolCallsByName.steer_or_cancel_agent ?? 0,
			stragglerSkewRatio,
			kvCacheBustCount,
		},
		governor: {
			scaleEvents: scaleEvents.length,
			scaleUps,
			scaleDowns,
			...(windows.length
				? {
						minWindow: Math.min(...windows),
						maxWindow: Math.max(...windows),
						meanWindow: round4(windows.reduce((s, w) => s + w, 0) / windows.length),
					}
				: {}),
			...(freeMems.length ? { minFreeMemMb: Math.min(...freeMems) } : {}),
			...(cpuLoads.length ? { maxCpuLoadRatio: round4(Math.max(...cpuLoads)) } : {}),
			quotaRetries,
			quotaCooldowns,
			quotaDrainedCount,
			providerDiversityEntropy: shannonEntropyBits(driverTurnCounts.values()),
			activeComputeFraction: time.llmWaitMs + time.quotaWaitMs > 0 ? round4(time.llmWaitMs / (time.llmWaitMs + time.quotaWaitMs)) : 1,
		},
		integration: {
			conflictsDetected,
			conflictsResolved,
			conflictResolutionRate: conflictsDetected > 0 ? round4(conflictsResolved / conflictsDetected) : 1,
			semanticRegressionsDetected,
			semanticRepairsSucceeded,
			semanticRepairRate: semanticRegressionsDetected > 0 ? round4(semanticRepairsSucceeded / semanticRegressionsDetected) : 1,
			monotonicRollbacks,
		},
		search: {
			totalCandidates,
			uniqueDiffShas,
			basinDiversityRatio,
			duplicateWorkWaste: round4(Math.max(0, 1 - basinDiversityRatio)),
			escalations,
			handoffs,
		},
		meta: {
			decisionCalls: decisionEvents.length,
			decisionQuestions,
			decisionInputTokens,
			meanDecisionLatencyMs,
			adaptiveMorphs: morphEvents.length,
			phaseChanges,
			initialTopology,
			finalTopology,
			boundEstimates: boundEvents.length,
			estimatedCeiling,
			...(groundTruthCeiling !== undefined ? { groundTruthCeiling } : {}),
			...(boundCalibrationError !== undefined ? { boundCalibrationError } : {}),
			checkpointsTriggered: checkpointEvents.length,
			earlyStopDecisions,
			fieldGuideUpdates: fgEvents.length,
			fieldGuideMaxBytes,
		},
	};
}

export interface ExtractScorecardOptions {
	task: EvalTask;
	prepared: PreparedTask;
	spec: HarnessRunSpec;
	receipt: HarnessRunReceipt;
	adapterName: string;
	armOrderIndex: number;
	repoRoot: string;
}

/**
 * Extract the universal cross-eval `Scorecard` from Layer B's SQLite WAL event log
 * and offline grading of the nominated artifact + every candidate snapshot.
 */
export async function extractScorecard(options: ExtractScorecardOptions): Promise<Scorecard> {
	const { task, prepared, spec, receipt, adapterName, armOrderIndex, repoRoot } = options;
	const higherIsBetter = task.higherIsBetter ?? true;
	const { events, recordedLedgerTokens, driverIds, modelIds, agentDocs, postDocs } = readRunEvents(spec.dbPath, receipt.runId);
	const faults = detectHarnessFaults(events, receipt, recordedLedgerTokens);

	// 1. Grade the nominated artifact strictly offline (never fall back to un-nominated workspaces for deliveredScore).
	// Memoize `task.grade()` by content `sha256` within this scorecard extraction so identical artifacts
	// (e.g. nominatedArtifactDir + matching candidateSnapshot, or duplicate snapshots) NEVER spin up
	// redundant Docker grading containers!
	const gradeCacheBySha = new Map<string, GradeReport>();
	const gradeArtifact = async (artifactDir: string, sha256?: string): Promise<GradeReport> => {
		if (sha256) {
			const cached = gradeCacheBySha.get(sha256);
			if (cached) return cached;
		}
		const report = await task.grade({
			artifactDir,
			hiddenDir: prepared.hiddenDir,
			seed: prepared.seed,
			n: prepared.n,
			options: prepared.options,
		});
		if (sha256) gradeCacheBySha.set(sha256, report);
		return report;
	};

	const missingGrade: GradeReport = {
		passed: false,
		score: prepared.incumbentScore ?? 0,
		customMetrics: { missingNomination: true },
		details: "No deliverable was nominated before cutoff.",
	};
	const deliveredGrade: GradeReport =
		receipt.nominatedArtifactDir && existsSync(receipt.nominatedArtifactDir)
			? await gradeArtifact(receipt.nominatedArtifactDir, receipt.nominatedSha256)
			: missingGrade;

	// 2. Grade every persisted candidate snapshot chronologically to reconstruct Anytime Frontier + bestOffline.
	const sortedCandidates = [...receipt.candidateSnapshots].sort(
		(a, b) => a.atTokens - b.atTokens || a.atWallMs - b.atWallMs,
	);
	const anytimeFrontier: AnytimePoint[] = [];
	let bestOfflineScore = deliveredGrade.score;
	let bestOfflinePass = deliveredGrade.passed;
	let bestAtTokens = receipt.nominatedAtTokens ?? 0;
	let timeToFirstValidMs: number | null = deliveredGrade.passed ? (receipt.nominatedAtWallMs ?? null) : null;
	let verifierAcceptedCount = 0;
	let verifierFalseAcceptCount = 0;

	let runningBestScore = prepared.incumbentScore ?? (higherIsBetter ? 0 : Number.POSITIVE_INFINITY);
	let runningBestPass = false;
	let runningNomScore = prepared.incumbentScore ?? (higherIsBetter ? 0 : Number.POSITIVE_INFINITY);
	let runningNomPass = false;

	for (const snap of sortedCandidates) {
		if (!existsSync(snap.dir)) continue;
		const grade = await gradeArtifact(snap.dir, snap.sha256);
		if (snap.acceptedByVerifier) {
			verifierAcceptedCount++;
			if (!grade.passed) verifierFalseAcceptCount++;
		}
		if (grade.passed && (timeToFirstValidMs === null || snap.atWallMs < timeToFirstValidMs)) {
			timeToFirstValidMs = snap.atWallMs;
		}
		const isBetter =
			(grade.passed && !runningBestPass) ||
			(grade.passed === runningBestPass && betterScore(grade.score, runningBestScore, higherIsBetter));
		if (isBetter) {
			runningBestScore = grade.score;
			runningBestPass = grade.passed;
			bestAtTokens = snap.atTokens;
		}
		if (
			(grade.passed && !bestOfflinePass) ||
			(grade.passed === bestOfflinePass && betterScore(grade.score, bestOfflineScore, higherIsBetter))
		) {
			bestOfflineScore = grade.score;
			bestOfflinePass = grade.passed;
		}
		if (receipt.nominatedSha256 && snap.sha256 === receipt.nominatedSha256) {
			runningNomScore = grade.score;
			runningNomPass = grade.passed;
		}
		anytimeFrontier.push({
			atTokens: snap.atTokens,
			atWallMs: snap.atWallMs,
			bestOfflineScore: Number.isFinite(runningBestScore) ? runningBestScore : 0,
			nominatedScore: Number.isFinite(runningNomScore) ? runningNomScore : 0,
			bestOfflinePassed: runningBestPass,
			nominatedPassed: runningNomPass,
		});
	}

	// Ensure final nominated state is reflected on the frontier tail.
	const modelCalls = events.filter((e) => e.type === "model.call");
	const budgetCharges = events.filter((e) => e.type === "budget.charged");
	const agentTurns = events.filter((e) => e.type === "agent.turn");
	const totalTokens = modelCalls.length
		? modelCalls.reduce((sum, e) => sum + Number(e.data.totalTokens ?? 0), 0)
		: budgetCharges.reduce((sum, e) => sum + Number(e.data.tokens ?? 0), 0);
	const startTs = events.find((e) => e.type === "run.started")?.ts ?? events[0]?.ts ?? Date.now();
	const endTs = events.findLast((e) => e.type === "run.finished")?.ts ?? events.at(-1)?.ts ?? startTs;
	const wallClockMs = Math.max(0, endTs - startTs);

	if (receipt.nominatedArtifactDir) {
		anytimeFrontier.push({
			atTokens: receipt.nominatedAtTokens ?? totalTokens,
			atWallMs: receipt.nominatedAtWallMs ?? wallClockMs,
			bestOfflineScore,
			nominatedScore: deliveredGrade.score,
			bestOfflinePassed: bestOfflinePass,
			nominatedPassed: deliveredGrade.passed,
		});
	}

	// 3. Token & Cost Breakdown (role + category)
	// Supports both v1 `model.call` events and v2 CLI-driver `budget.charged` + `agent.turn` events.
	const byRole: Record<AgentRoleCategory, number> = { worker: 0, coordinator: 0, reviewer: 0, refinery: 0 };
	const byCategory = { work: 0, coordination: 0, verification: 0, other: 0 };
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let reasoning = 0;
	let cacheReadReported = false;
	let cacheWriteReported = false;
	let reasoningReported = false;
	let peakInputPerCall = 0;
	let estimatedUsd = 0;
	let llmWaitMs = 0;
	let quotaWaitMs = 0;
	let modelErrors = 0;

	const isToolCallEvent = (e: CanonicalEvent) =>
		e.type === "tool.call" || e.type === "mcp.tool_call" || (e.type === "driver.tool_call" && e.data.isMcp !== true);
	const isToolResultEvent = (e: CanonicalEvent) =>
		e.type === "tool.result" || e.type === "mcp.tool_result" || (e.type === "driver.tool_result" && e.data.isMcp !== true);

	if (modelCalls.length > 0) {
		for (let i = 0; i < events.length; i++) {
			const e = events[i]!;
			if (e.type !== "model.call") continue;
			const role: AgentRoleCategory = e.role ?? "worker";
			const tokens = Number(e.data.totalTokens ?? 0);
			const inTok = Number(e.data.input ?? 0);
			const crTok = Number(e.data.cacheReadTokens ?? 0);
			const cwTok = Number(e.data.cacheWriteTokens ?? 0);
			if (e.data.cacheReadReported === true || e.data.cacheReadTokens !== undefined) cacheReadReported = true;
			if (e.data.cacheWriteReported === true || e.data.cacheWriteTokens !== undefined) cacheWriteReported = true;
			if (e.data.reasoningReported === true || e.data.reasoningTokens !== undefined) reasoningReported = true;
			input += inTok;
			output += Number(e.data.output ?? 0);
			cacheRead += crTok;
			cacheWrite += cwTok;
			reasoning += Number(e.data.reasoningTokens ?? 0);
			peakInputPerCall = Math.max(peakInputPerCall, inTok + crTok + cwTok);
			estimatedUsd += Number(e.data.usd ?? 0);
			llmWaitMs += Number(e.data.durationMs ?? 0);
			quotaWaitMs += Number(e.data.waitedMs ?? 0);
			if (e.data.error || e.data.stopReason === "error") modelErrors++;
			byRole[role] += tokens;

			const triggeredTools: string[] = [];
			for (let j = i + 1; j < events.length; j++) {
				const next = events[j]!;
				if (next.agentId !== e.agentId) continue;
				if (next.type === "model.call") break;
				if (isToolCallEvent(next) && typeof next.data.tool === "string") {
					triggeredTools.push(next.data.tool);
				}
			}
			const cat = classifyCallCategory(role, triggeredTools);
			byCategory[cat] += tokens;
		}
	} else {
		// v2 CLI drivers emit `budget.charged` + `agent.turn` + `quota.retry` per turn
		for (let i = 0; i < events.length; i++) {
			const e = events[i]!;
			if (e.type === "budget.charged") {
				const role: AgentRoleCategory = e.role ?? "worker";
				const tok = Number(e.data.tokens ?? 0);
				const inTok = Number(e.data.inputTokens ?? 0);
				const outTok = Number(e.data.outputTokens ?? 0);
				const crTok = Number(e.data.cachedTokens ?? 0);
				const cwTok = Number(e.data.cacheWriteTokens ?? 0);
				const rTok = Number(e.data.reasoningTokens ?? 0);
				if (e.data.cacheReadReported === true || e.data.cachedTokens !== undefined) cacheReadReported = true;
				if (e.data.cacheWriteReported === true || e.data.cacheWriteTokens !== undefined) cacheWriteReported = true;
				if (e.data.reasoningReported === true || e.data.reasoningTokens !== undefined) reasoningReported = true;
				input += inTok;
				output += outTok;
				cacheRead += crTok;
				cacheWrite += cwTok;
				reasoning += rTok;
				const effectiveInput = tok > 0 ? Math.max(inTok, tok - outTok) : Math.max(inTok, crTok + cwTok);
				peakInputPerCall = Math.max(peakInputPerCall, effectiveInput);
				estimatedUsd += Number(e.data.usd ?? 0);
				byRole[role] += tok;
				// Attribute to tools called by this agent right before this turn charge
				const recentTools: string[] = [];
				for (let j = i - 1; j >= 0; j--) {
					const prev = events[j]!;
					if (prev.agentId !== e.agentId) continue;
					if (prev.type === "budget.charged" || prev.type === "agent.turn") break;
					if (isToolCallEvent(prev) && typeof prev.data.tool === "string") recentTools.push(prev.data.tool);
				}
				const cat = classifyCallCategory(role, recentTools);
				byCategory[cat] += tok;
			} else if (e.type === "agent.turn") {
				llmWaitMs += Number(e.data.durationMs ?? 0);
				quotaWaitMs += Number(e.data.waitedMs ?? 0);
				if (e.data.status === "failed" || e.data.status === "rate_limited" || e.data.error) {
					modelErrors++;
				}
			} else if (e.type === "quota.retry") {
				quotaWaitMs += Number(e.data.waitMs ?? 0);
			}
		}
	}

	const turnCacheHitRates: number[] = [];
	for (const e of events) {
		if (e.type === "agent.turn" && typeof e.data.cacheHitRate === "number" && Number.isFinite(e.data.cacheHitRate)) {
			turnCacheHitRates.push(e.data.cacheHitRate);
		}
	}
	const cacheHitRate = turnCacheHitRates.length
		? Math.round((turnCacheHitRates.reduce((s, r) => s + r, 0) / turnCacheHitRates.length) * 10000) / 10000
		: input + cacheRead > 0 && cacheRead > 0
			? Math.round((Math.min(cacheRead, input || cacheRead) / Math.max(input, cacheRead)) * 10000) / 10000
			: 0;

	const tokens: TokenBreakdown = {
		total: totalTokens,
		input,
		output,
		cacheRead,
		cacheWrite,
		cacheHitRate,
		reasoning,
		cacheReadReported,
		cacheWriteReported,
		reasoningReported,
		peakInputPerCall,
		estimatedUsd: Math.round(estimatedUsd * 1e6) / 1e6,
		byRole,
		byCategory,
		coordinationTokenShare: totalTokens > 0 ? Math.round((byCategory.coordination / totalTokens) * 10000) / 10000 : 0,
	};

	// 4. Time & Compute Decomposition
	let toolExecMs = 0;
	let graderComputeMs = 0;
	let cpuSeconds = 0;
	let gpuSeconds = 0;

	const openToolStart = new Map<string, number>();
	for (const e of events) {
		if (isToolCallEvent(e)) {
			const key = `${e.agentId ?? ""}:${String(e.data.tool ?? "")}`;
			openToolStart.set(key, e.ts);
		} else if (isToolResultEvent(e)) {
			const key = `${e.agentId ?? ""}:${String(e.data.tool ?? "")}`;
			const dur =
				typeof e.data.durationMs === "number"
					? e.data.durationMs
					: openToolStart.has(key)
						? Math.max(0, e.ts - openToolStart.get(key)!)
						: 0;
			openToolStart.delete(key);
			const toolName = String(e.data.tool ?? "");
			if (VERIFICATION_TOOLS.has(toolName)) graderComputeMs += dur;
			else toolExecMs += dur;
			if (typeof e.data.cpuSeconds === "number") cpuSeconds += e.data.cpuSeconds;
			if (typeof e.data.gpuSeconds === "number") gpuSeconds += e.data.gpuSeconds;
		} else if (e.type === "job.finished") {
			const dur = Number(e.data.durationMs ?? 0);
			graderComputeMs += dur;
			if (typeof e.data.cpuSeconds === "number") cpuSeconds += e.data.cpuSeconds;
			else if (e.data.unit === "cpu_seconds") cpuSeconds += Number(e.data.units ?? 0);
			if (typeof e.data.gpuSeconds === "number") gpuSeconds += e.data.gpuSeconds;
			else if (e.data.unit === "gpu_minutes") gpuSeconds += Number(e.data.units ?? 0) * 60;
		}
	}

	const time: TimeComputeBreakdown = {
		wallClockMs,
		llmWaitMs,
		quotaWaitMs,
		toolExecMs,
		graderComputeMs,
		cpuSeconds: Math.round(cpuSeconds * 1000) / 1000,
		gpuSeconds: Math.round(gpuSeconds * 1000) / 1000,
		timeToFirstValidMs,
		timeToNominationMs: receipt.nominatedArtifactDir ? (receipt.nominatedAtWallMs ?? wallClockMs) : null,
	};

	// 5. Swarm Dynamics
	const agentIds = new Set<string>();
	const toolCallsByName: Record<string, number> = {};
	let toolCalls = 0;
	let toolErrors = 0;
	let messageCount = 0;
	let messageBytes = 0;
	let compactions = 0;
	let artifactReads = 0;
	let stallDetections = 0;
	let failoverCount = 0;
	let skillsLoaded = 0;
	let codemodeExecutions = 0;

	for (const e of events) {
		if (e.agentId) agentIds.add(e.agentId);
		if (isToolCallEvent(e)) {
			toolCalls++;
			const name = String(e.data.tool ?? "unknown");
			toolCallsByName[name] = (toolCallsByName[name] ?? 0) + 1;
			if (name === "post_board" || name === "board_publish" || name === "message_peer" || name === "share_context") {
				messageCount++;
				messageBytes += Buffer.byteLength(JSON.stringify(e.data.args ?? ""));
			}
		} else if (isToolResultEvent(e) && e.data.isError) {
			toolErrors++;
		} else if (e.type === "message.sent") {
			messageCount++;
			messageBytes += Buffer.byteLength(String(e.data.body ?? e.data.text ?? ""));
		} else if (e.type === "context.compacted" || e.type === "agent.compacted") {
			compactions++;
		} else if (e.type === "context.read" || e.type === "context.artifact_read") {
			artifactReads++;
		} else if (e.type === "stall.detected" || e.type === "agent.stalled" || e.type === "review.stall") {
			stallDetections++;
		} else if (e.type === "provider.failover" || e.type === "agent.handoff") {
			failoverCount++;
		} else if (e.type === "skill.loaded") {
			skillsLoaded++;
		} else if (e.type === "codemode.executed") {
			codemodeExecutions++;
		}
	}

	const { avg: avgParallelism, peak: peakParallelism } = computeParallelism(events, endTs);
	const dynamics: SwarmDynamics = {
		swarmSize: spec.swarmSize,
		agentCount: agentIds.size,
		avgParallelism,
		peakParallelism,
		modelCalls: modelCalls.length > 0 ? modelCalls.length : agentTurns.length,
		modelErrors,
		toolCalls,
		toolErrors,
		toolErrorRate: toolCalls > 0 ? Math.round((toolErrors / toolCalls) * 10000) / 10000 : 0,
		toolCallsByName,
		messageCount,
		messageBytes,
		compactions,
		artifactReads,
		stallDetections,
		failoverCount,
		skillsLoaded,
		codemodeExecutions,
	};

	// 6. Causal Loss Decomposition
	const rawNominationGap = higherIsBetter
		? bestOfflineScore - deliveredGrade.score
		: deliveredGrade.score - bestOfflineScore;
	const nominationLoss = Math.max(0, Math.round(rawNominationGap * 1e6) / 1e6);
	const discoveryLoss = higherIsBetter
		? Math.max(0, Math.round((1 - Math.min(1, bestOfflineScore)) * 1e6) / 1e6)
		: Math.max(0, bestOfflineScore);
	const postOptimumTokens =
		bestOfflinePass || (prepared.incumbentScore !== undefined && betterScore(bestOfflineScore, prepared.incumbentScore, higherIsBetter))
			? Math.max(0, totalTokens - bestAtTokens)
			: 0;
	const losses: LossDecomposition = {
		discoveryLoss,
		nominationLoss,
		falseCertificationRate:
			verifierAcceptedCount > 0 ? Math.round((verifierFalseAcceptCount / verifierAcceptedCount) * 10000) / 10000 : 0,
		postOptimumTokens,
		stoppingWasteShare: totalTokens > 0 ? Math.round((postOptimumTokens / totalTokens) * 10000) / 10000 : 0,
	};

	const anytime = computeAnytimeMetrics({
		frontier: anytimeFrontier,
		spec,
		prepared,
		higherIsBetter,
		deliveredScore: deliveredGrade.score,
		bestOfflineScore,
		totalTokens,
		wallClockMs,
		estimatedUsd: tokens.estimatedUsd,
	});
	const mechanisms = extractMechanismTelemetry({
		events,
		agentDocs,
		postDocs,
		receipt,
		spec,
		prepared,
		tokens,
		time,
		dynamics,
	});

	const git = gitReproducibility(repoRoot);
	return {
		schemaVersion: 2,
		runId: receipt.runId,
		taskId: task.id,
		family: task.family,
		status: receipt.status,
		deliveredPass: deliveredGrade.passed,
		deliveredScore: deliveredGrade.score,
		bestOfflinePass,
		bestOfflineScore,
		autoNominated: receipt.autoNominated,
		nominatedSha256: receipt.nominatedSha256,
		...toScorecardFaultState(faults),
		losses,
		tokens,
		time,
		dynamics,
		anytimeFrontier,
		anytime,
		mechanisms,
		reproducibility: {
			harnessAdapter: adapterName,
			topology: spec.topology ?? spec.controlRung,
			controlRung: spec.controlRung,
			budgetMode: spec.budgetMode,
			budget: spec.budget,
			seed: prepared.seed,
			armOrderIndex,
			fixtureSha256: prepared.fixtureSha256,
			graderSha256: prepared.graderSha256,
			harnessGitSha: git.harnessGitSha,
			dirtyDiffSha: git.dirtyDiffSha,
			driverIds: receipt.driverIds ? [...receipt.driverIds] : driverIds,
			modelIds: receipt.modelIds ? [...receipt.modelIds] : modelIds,
		},
		customMetrics: deliveredGrade.customMetrics,
		gradeDetails: deliveredGrade.details,
	};
}
