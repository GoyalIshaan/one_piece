import { existsSync } from "node:fs";
import type {
	AgentRoleCategory,
	AnytimePoint,
	CanonicalEvent,
	EvalTask,
	GradeReport,
	HarnessRunReceipt,
	HarnessRunSpec,
	LossDecomposition,
	PreparedTask,
	Scorecard,
	SwarmDynamics,
	TimeComputeBreakdown,
	TokenBreakdown,
} from "./contracts.ts";
import { readRunEvents } from "./event-reader.ts";
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
	const { events, recordedLedgerTokens, driverIds, modelIds } = readRunEvents(spec.dbPath, receipt.runId);
	const faults = detectHarnessFaults(events, receipt, recordedLedgerTokens);

	// 1. Grade the nominated artifact strictly offline (never fall back to un-nominated workspaces for deliveredScore).
	const missingGrade: GradeReport = {
		passed: false,
		score: prepared.incumbentScore ?? 0,
		customMetrics: { missingNomination: true },
		details: "No deliverable was nominated before cutoff.",
	};
	const deliveredGrade: GradeReport =
		receipt.nominatedArtifactDir && existsSync(receipt.nominatedArtifactDir)
			? await task.grade({
					artifactDir: receipt.nominatedArtifactDir,
					hiddenDir: prepared.hiddenDir,
					seed: prepared.seed,
					n: prepared.n,
					options: prepared.options,
				})
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
		const grade = await task.grade({
			artifactDir: snap.dir,
			hiddenDir: prepared.hiddenDir,
			seed: prepared.seed,
			n: prepared.n,
			options: prepared.options,
		});
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

	const git = gitReproducibility(repoRoot);
	return {
		schemaVersion: 1,
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
		harnessFaults: faults,
		hasHarnessFault: faults.length > 0,
		losses,
		tokens,
		time,
		dynamics,
		anytimeFrontier,
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
