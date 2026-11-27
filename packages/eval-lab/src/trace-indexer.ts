import type { DecisionModelClient, DecisionQuestion } from "@one-piece/core";
import { formatCompactTraceEvent, isAnchorTraceEvent, type TraceNavEvent } from "@one-piece/engine";
import type { EvalLedger, LedgerRunRecord, TraceScoreLabel, TraceScoreLocality, TraceScoreRecord } from "./ledger.ts";
import { sha256Text } from "./sandbox.ts";
import { loadOfflineTraceSnapshot, type OfflineTraceSnapshot } from "./trace-navigator.ts";

export type ProbeWindowScope = "nearby_window" | "cross_peer_digest" | "claim_evidence_digest";

export interface System1ProbeDefinition {
	readonly judgeName: string;
	readonly scope: ProbeWindowScope;
	readonly baseVersion: string;
	readonly instructions: string;
	/** Auto-computed immutable version tag: `<baseVersion>@<sha256(instructions).slice(0,8)>`. */
	readonly judgeVersion: string;
}

function defineProbe(spec: {
	readonly judgeName: string;
	readonly scope: ProbeWindowScope;
	readonly baseVersion: string;
	readonly instructions: string;
}): System1ProbeDefinition {
	const hash = sha256Text(spec.instructions).slice(0, 8);
	return {
		...spec,
		judgeVersion: `${spec.baseVersion}@${hash}`,
	};
}

/**
 * Versioned catalog of strictly atomic, orthogonal single-question `noul` System-1 probes.
 * Editing any probe's `instructions` automatically rotates its `judgeVersion` hash so
 * `indexLedgerTraces()` cleanly re-indexes only the modified probe across existing runs.
 */
export const SYSTEM1_PROBE_CATALOG: readonly System1ProbeDefinition[] = [
	defineProbe({
		judgeName: "thrashing_loop",
		scope: "nearby_window",
		baseVersion: "v1",
		instructions:
			"Did this agent repeat materially identical failing edits or commands 3 or more times without changing strategy?",
	}),
	defineProbe({
		judgeName: "failed_error_recovery",
		scope: "nearby_window",
		baseVersion: "v1",
		instructions:
			"After encountering a tool, build, or test error in this window, did the agent fail to diagnose the root cause before moving on?",
	}),
	defineProbe({
		judgeName: "scope_drift",
		scope: "nearby_window",
		baseVersion: "v1",
		instructions:
			"Did this agent modify unrelated files or weaken/bypass existing tests instead of addressing the root cause of the task?",
	}),
	defineProbe({
		judgeName: "duplicated_peer_work",
		scope: "cross_peer_digest",
		baseVersion: "v1",
		instructions:
			"Did two or more workers independently make overlapping or duplicate edits for the same sub-problem?",
	}),
	defineProbe({
		judgeName: "ignored_board_signal",
		scope: "cross_peer_digest",
		baseVersion: "v1",
		instructions:
			"Did a worker ignore a directly relevant discovery, error, or invariant that was already posted on the shared board?",
	}),
	defineProbe({
		judgeName: "coordination_chatter_waste",
		scope: "cross_peer_digest",
		baseVersion: "v1",
		instructions:
			"Did agents spend excessive turns messaging or polling the board without making concrete workspace progress?",
	}),
	defineProbe({
		judgeName: "unverified_success_claim",
		scope: "claim_evidence_digest",
		baseVersion: "v1",
		instructions:
			"Did the agent claim tests, builds, or requirements passed when the recorded tool or verification outputs do not confirm it?",
	}),
	defineProbe({
		judgeName: "premature_stop",
		scope: "claim_evidence_digest",
		baseVersion: "v1",
		instructions:
			"Did the run yield or submit its deliverable while known failing checks or clear unresolved gaps remained?",
	}),
];

export const DETERMINISTIC_JUDGE_VERSION = "det-v1";

export type ExtractedTraceWindow = {
	readonly windowId: string;
	readonly seqStart: number;
	readonly seqEnd: number;
	readonly anchorSeqs: readonly number[];
	readonly text: string;
} & (
	| { readonly scope: "nearby_window"; readonly locality: "nearby_window"; readonly agentId: string | null }
	| { readonly scope: "cross_peer_digest" | "claim_evidence_digest"; readonly locality: "run_summary"; readonly agentId: null }
);

export interface ProbClassificationOptions {
	readonly flagThreshold?: number;
	readonly cleanThreshold?: number;
	readonly minConfidence?: number;
}

/**
 * Pure threshold bucketing for System-1 `noul` probabilities:
 * - `prob >= 0.75 && confidence >= 0.55` -> `"flagged"`
 * - `prob <= 0.25 && confidence >= 0.55` -> `"clean"`
 * - otherwise -> `"uncertain"`
 */
export function classifyProb(
	prob: number,
	confidence: number,
	opts: ProbClassificationOptions = {},
): TraceScoreLabel {
	const flagThreshold = opts.flagThreshold ?? 0.75;
	const cleanThreshold = opts.cleanThreshold ?? 0.25;
	const minConfidence = opts.minConfidence ?? 0.55;
	if (!Number.isFinite(prob) || !Number.isFinite(confidence)) return "uncertain";
	if (confidence < minConfidence) return "uncertain";
	if (prob >= flagThreshold) return "flagged";
	if (prob <= cleanThreshold) return "clean";
	return "uncertain";
}

function makeScoreId(
	runKey: string,
	judgeName: string,
	judgeVersion: string,
	agentId: string | null,
	seqStart: number,
	seqEnd: number,
): string {
	return `ts_${sha256Text(`${runKey}|${judgeName}|${judgeVersion}|${agentId ?? ""}|${seqStart}|${seqEnd}`).slice(0, 20)}`;
}

/**
 * Layer 1 (Free Deterministic): Compute objective behavioral + hard-fault tags directly from
 * `LedgerRunRecord` (`Scorecard v2`) + optional `trace.db` events with ZERO LLM calls.
 */
export function extractDeterministicRunTags(
	run: LedgerRunRecord,
	opts: { traceDbPath?: string; snapshot?: OfflineTraceSnapshot; indexedAt?: string } = {},
): TraceScoreRecord[] {
	const indexedAt = opts.indexedAt ?? new Date().toISOString();
	const traceDbPath = opts.traceDbPath ?? opts.snapshot?.traceDbPath ?? "";
	const events = opts.snapshot?.events ?? [];
	const minSeq = events[0]?.seq ?? 0;
	const maxSeq = events.at(-1)?.seq ?? 0;
	const card = run.scorecard;
	const out: TraceScoreRecord[] = [];

	const pushDet = (spec: {
		judgeName: string;
		label: TraceScoreLabel;
		prob: number;
		agentId?: string | null;
		seqStart?: number;
		seqEnd?: number;
		evidenceSeqs?: readonly number[];
		rationale: string;
	}) => {
		const seqStart = spec.seqStart ?? minSeq;
		const seqEnd = spec.seqEnd ?? maxSeq;
		const agentId = spec.agentId ?? null;
		out.push({
			scoreId: makeScoreId(run.runKey, spec.judgeName, DETERMINISTIC_JUDGE_VERSION, agentId, seqStart, seqEnd),
			runKey: run.runKey,
			traceDbPath,
			agentId,
			seqStart,
			seqEnd,
			locality: "run_summary",
			source: "deterministic",
			judgeName: spec.judgeName,
			judgeVersion: DETERMINISTIC_JUDGE_VERSION,
			model: "deterministic",
			prob: spec.prob,
			confidence: 1.0,
			label: spec.label,
			evidenceSeqs: spec.evidenceSeqs ?? (seqStart > 0 ? [seqStart] : []),
			rationale: spec.rationale,
			indexedAt,
		});
	};

	// 1. Mirror hard harness faults into trace_scores so hard & behavioral faults share one index
	for (const fault of card.harnessFaults) {
		const seq = fault.seq ?? maxSeq;
		pushDet({
			judgeName: `fault:${fault.code}`,
			label: "flagged",
			prob: 1.0,
			seqStart: seq,
			seqEnd: seq,
			evidenceSeqs: seq > 0 ? [seq] : [],
			rationale: fault.message.slice(0, 260),
		});
	}

	// 2. nomination_loss: bestOfflineScore - deliveredScore > 0.1
	const nomGap = Math.max(0, run.bestOfflineScore - run.deliveredScore);
	const findingSeqs = events.filter((e) => e.type === "finding.reported" || e.type === "run.nominated").map((e) => e.seq);
	if (nomGap > 0.1) {
		pushDet({
			judgeName: "nomination_loss",
			label: "flagged",
			prob: 1.0,
			seqStart: findingSeqs[0] ?? minSeq,
			seqEnd: findingSeqs.at(-1) ?? maxSeq,
			evidenceSeqs: findingSeqs.slice(-5),
			rationale: `Best offline score (${run.bestOfflineScore.toFixed(3)}) exceeded delivered score (${run.deliveredScore.toFixed(3)}) by ${nomGap.toFixed(3)}.`,
		});
	}

	// 3. zero_edits: failed run with no edits / missing nomination / empty patch
	const missingNom = Boolean(card.customMetrics.missingNomination) || Boolean(card.customMetrics.emptyPatch);
	const noFindings = events.length > 0 && !events.some((e) => e.type === "finding.reported");
	if (!run.deliveredPass && (missingNom || (run.deliveredScore <= 0 && noFindings))) {
		pushDet({
			judgeName: "zero_edits",
			label: "flagged",
			prob: 1.0,
			evidenceSeqs: maxSeq > 0 ? [maxSeq] : [],
			rationale: missingNom
				? "Run failed with missing nomination or empty diff."
				: "Run failed with score 0 and zero reported findings.",
		});
	}

	// 4. unresolved_conflict: mechanisms.integration.conflictsDetected > conflictsResolved
	const integ = card.mechanisms?.integration;
	if (integ && integ.conflictsDetected > integ.conflictsResolved) {
		const conflictSeqs = events
			.filter((e) => e.type === "peer.conflict_detected" || e.type === "refinery.semantic_regression")
			.map((e) => e.seq);
		pushDet({
			judgeName: "unresolved_conflict",
			label: "flagged",
			prob: 1.0,
			seqStart: conflictSeqs[0] ?? minSeq,
			seqEnd: conflictSeqs.at(-1) ?? maxSeq,
			evidenceSeqs: conflictSeqs.slice(0, 6),
			rationale: `${integ.conflictsDetected - integ.conflictsResolved} of ${integ.conflictsDetected} merge conflict(s) remained unresolved.`,
		});
	}

	// 5. straggler_skew: mechanisms.forest.stragglerSkewRatio > 2.5
	const forest = card.mechanisms?.forest;
	if (forest && forest.stragglerSkewRatio > 2.5) {
		// Find slowest agent from agent.turn durations
		const durByAgent = new Map<string, { total: number; seqs: number[] }>();
		for (const ev of events) {
			if (ev.type === "agent.turn" && ev.agentId) {
				const dur = Number(ev.data.durationMs ?? 0);
				if (dur > 0) {
					const cur = durByAgent.get(ev.agentId) ?? { total: 0, seqs: [] };
					cur.total += dur;
					cur.seqs.push(ev.seq);
					durByAgent.set(ev.agentId, cur);
				}
			}
		}
		let slowestId: string | null = null;
		let slowestSeqs: number[] = [];
		let maxDur = 0;
		for (const [id, st] of durByAgent.entries()) {
			if (st.total > maxDur) {
				maxDur = st.total;
				slowestId = id;
				slowestSeqs = st.seqs;
			}
		}
		pushDet({
			judgeName: "straggler_skew",
			label: "flagged",
			prob: 1.0,
			agentId: slowestId,
			seqStart: slowestSeqs[0] ?? minSeq,
			seqEnd: slowestSeqs.at(-1) ?? maxSeq,
			evidenceSeqs: slowestSeqs.slice(0, 6),
			rationale: `Straggler skew ratio ${forest.stragglerSkewRatio.toFixed(2)}x exceeded 2.5x threshold${slowestId ? ` (slowest agent: ${slowestId})` : ""}.`,
		});
	}

	// 6. kv_cache_thrash: mechanisms.forest.kvCacheBustCount >= 2
	if (forest && forest.kvCacheBustCount >= 2) {
		const bustSeqs: number[] = [];
		const prevHit = new Map<string, number>();
		for (const ev of events) {
			if (ev.type === "agent.turn" && ev.agentId && typeof ev.data.cacheHitRate === "number") {
				const prev = prevHit.get(ev.agentId);
				if (prev !== undefined && prev - ev.data.cacheHitRate > 0.35) bustSeqs.push(ev.seq);
				prevHit.set(ev.agentId, ev.data.cacheHitRate);
			}
		}
		pushDet({
			judgeName: "kv_cache_thrash",
			label: "flagged",
			prob: 1.0,
			seqStart: bustSeqs[0] ?? minSeq,
			seqEnd: bustSeqs.at(-1) ?? maxSeq,
			evidenceSeqs: bustSeqs.slice(0, 6),
			rationale: `Detected ${forest.kvCacheBustCount} sharp KV-cache hit-rate drops (>35pp) across turns.`,
		});
	}

	// 7. stopping_waste: losses.stoppingWasteShare > 0.45
	if (card.losses.stoppingWasteShare > 0.45) {
		pushDet({
			judgeName: "stopping_waste",
			label: "flagged",
			prob: 1.0,
			evidenceSeqs: findingSeqs.slice(-3),
			rationale: `Burned ${(card.losses.stoppingWasteShare * 100).toFixed(1)}% of total tokens after discovering the best offline candidate.`,
		});
	}

	return out;
}

function isNearbyAnchor(ev: TraceNavEvent): boolean {
	if (isAnchorTraceEvent(ev)) return true;
	return false;
}

function formatWindowText(header: string, lines: readonly string[], maxChars: number): string {
	const out = [header];
	let len = header.length + 1;
	for (const line of lines) {
		if (len + line.length + 1 > maxChars && out.length > 1) {
			out.push(`... [window capped at ${maxChars} chars]`);
			break;
		}
		out.push(line);
		len += line.length + 1;
	}
	return out.join("\n");
}

/**
 * Locality-Aware Compact Window Extractor:
 * Extracts bounded views from a run's `trace.db` tailored to each atomic probe family:
 * 1. `nearby_window`: per-agent error/conflict/promotion-anchored windows `[anchorIdx - 3 .. anchorIdx + 8]`,
 *    merged when overlapping, capped at 4 windows per agent (~16k chars / ~4k tokens max each).
 * 2. `cross_peer_digest`: shared board posts + promotions + per-agent edits/merge outcomes (multi-agent runs only).
 * 3. `claim_evidence_digest`: findings/claims vs recorded verification/test/command outputs.
 */
export function extractTraceWindows(
	snapshot: OfflineTraceSnapshot,
	opts: {
		swarmSize?: number;
		goalSummary?: string;
		maxWindowsPerAgent?: number;
		maxNearbyWindowsPerRun?: number;
		maxNearbyChars?: number;
		maxDigestChars?: number;
	} = {},
): ExtractedTraceWindow[] {
	const events = snapshot.events;
	if (!events.length) return [];

	const maxPerAgent = opts.maxWindowsPerAgent ?? 2;
	const maxNearbyTotal = opts.maxNearbyWindowsPerRun ?? 6;
	const maxNearbyChars = opts.maxNearbyChars ?? 16_000;
	const maxDigestChars = opts.maxDigestChars ?? 14_000;
	const goalLine = opts.goalSummary ?? snapshot.goalText ?? snapshot.goalTitle ?? snapshot.runId;
	const windows: ExtractedTraceWindow[] = [];

	// Group events by agentId for per-agent nearby_window extraction
	const eventsByAgent = new Map<string, TraceNavEvent[]>();
	for (const ev of events) {
		if (!ev.agentId) continue;
		if (ev.agentId === "verifier" || ev.agentId === "harness") continue;
		const arr = eventsByAgent.get(ev.agentId) ?? [];
		arr.push(ev);
		eventsByAgent.set(ev.agentId, arr);
	}
	if (eventsByAgent.size === 0) {
		eventsByAgent.set("run", [...events]);
	}

	// 1. Per-agent nearby_window slices (skip tiny <4-event wrappers, rank highest-signal windows across run)
	const candidateNearby: Array<{ win: ExtractedTraceWindow; anchorCount: number }> = [];
	for (const [agentId, agentEvents] of eventsByAgent.entries()) {
		if (eventsByAgent.size > 1 && agentEvents.length < 4) continue;
		const anchorIndices: number[] = [];
		for (let i = 0; i < agentEvents.length; i++) {
			if (isNearbyAnchor(agentEvents[i]!)) anchorIndices.push(i);
		}

		const rawRanges: Array<{ lo: number; hi: number; anchors: number[] }> = [];
		if (anchorIndices.length > 0) {
			for (const idx of anchorIndices) {
				const lo = Math.max(0, idx - 3);
				const hi = Math.min(agentEvents.length - 1, idx + 8);
				const prev = rawRanges.at(-1);
				if (prev && lo <= prev.hi + 1) {
					prev.hi = Math.max(prev.hi, hi);
					prev.anchors.push(agentEvents[idx]!.seq);
				} else {
					rawRanges.push({ lo, hi, anchors: [agentEvents[idx]!.seq] });
				}
			}
		} else {
			// Fallback for long error-free traces: evenly spaced windows capped at maxPerAgent
			const chunkCount = Math.min(maxPerAgent, Math.max(1, Math.ceil(agentEvents.length / 20)));
			const step = Math.max(1, Math.floor(agentEvents.length / chunkCount));
			for (let w = 0; w < chunkCount; w++) {
				const lo = w * step;
				const hi = Math.min(agentEvents.length - 1, lo + 14);
				rawRanges.push({ lo, hi, anchors: [agentEvents[lo]!.seq] });
			}
		}

		// Keep up to `maxPerAgent` highest-signal ranges per agent
		const picked =
			rawRanges.length <= maxPerAgent
				? rawRanges
				: [...rawRanges]
						.sort((a, b) => b.anchors.length - a.anchors.length || a.lo - b.lo)
						.slice(0, maxPerAgent)
						.sort((a, b) => a.lo - b.lo);

		for (let wi = 0; wi < picked.length; wi++) {
			const r = picked[wi]!;
			const slice = agentEvents.slice(r.lo, r.hi + 1);
			const seqStart = slice[0]!.seq;
			const seqEnd = slice.at(-1)!.seq;
			const header = `RUN=${snapshot.runId} AGENT=${agentId} WINDOW=nearby(${seqStart}..${seqEnd})\nGOAL: ${goalLine.slice(0, 320)}`;
			const lines = slice.map((e) => formatCompactTraceEvent(e, 240));
			candidateNearby.push({
				anchorCount: anchorIndices.length > 0 ? r.anchors.length : 0,
				win: {
					windowId: `nearby:${agentId}:${wi}:${seqStart}-${seqEnd}`,
					scope: "nearby_window",
					locality: "nearby_window",
					agentId: agentId === "run" ? null : agentId,
					seqStart,
					seqEnd,
					anchorSeqs: r.anchors,
					text: formatWindowText(header, lines, maxNearbyChars),
				},
			});
		}
	}

	const selectedNearby =
		candidateNearby.length <= maxNearbyTotal
			? candidateNearby.map((c) => c.win)
			: [...candidateNearby]
					.sort((a, b) => b.anchorCount - a.anchorCount || a.win.seqStart - b.win.seqStart)
					.slice(0, maxNearbyTotal)
					.sort((a, b) => a.win.seqStart - b.win.seqStart)
					.map((c) => c.win);
	windows.push(...selectedNearby);

	const minSeq = events[0]!.seq;
	const maxSeq = events.at(-1)!.seq;

	// 2. cross_peer_digest (multi-agent runs only)
	const distinctAgents = Math.max(opts.swarmSize ?? 1, snapshot.agents.length, eventsByAgent.size);
	if (distinctAgents >= 2) {
		const digestLines: string[] = [];
		const anchorSeqs: number[] = [];

		if (snapshot.agents.length) {
			digestLines.push(
				`AGENTS: ${snapshot.agents.map((a) => `${a.id}(${a.role}${a.driverId ? `/${a.driverId}` : ""})`).join(", ")}`,
			);
		}
		if (snapshot.posts.length) {
			digestLines.push("--- SHARED BOARD POSTS ---");
			for (const p of snapshot.posts.slice(0, 30)) {
				digestLines.push(
					`[post ${p.id}] author=${p.authorAgentId} vis=${p.visibility ?? "global"} cites=${(p.parentIds ?? []).join(",") || "none"}: ${(p.title ? `${p.title} — ` : "") + p.body.slice(0, 220)}`,
				);
			}
		}
		const peerEvents = events.filter(
			(e) =>
				e.type === "board.posted" ||
				e.type === "board.promoted" ||
				e.type === "peer.conflict_detected" ||
				e.type === "peer.conflict_resolved" ||
				e.type === "refinery.conflict_resolved" ||
				e.type === "refinery.semantic_regression" ||
				e.type === "peer.trunk_repaired" ||
				e.type === "finding.reported" ||
				e.type === "driver.tool_call" ||
				e.type === "mcp.tool_call" ||
				e.type === "tool.call",
		);
		digestLines.push("--- CROSS-PEER TIMELINE ---");
		for (const ev of peerEvents.slice(0, 90)) {
			if (ev.type.startsWith("board.") || ev.type.includes("conflict") || ev.type === "finding.reported") {
				anchorSeqs.push(ev.seq);
			}
			digestLines.push(formatCompactTraceEvent(ev, 200));
		}
		const header = `RUN=${snapshot.runId} SCOPE=cross_peer_digest (agents=${distinctAgents}, seq ${minSeq}..${maxSeq})\nGOAL: ${goalLine.slice(0, 320)}`;
		windows.push({
			windowId: `cross_peer:${minSeq}-${maxSeq}`,
			scope: "cross_peer_digest",
			locality: "run_summary",
			agentId: null,
			seqStart: minSeq,
			seqEnd: maxSeq,
			anchorSeqs: anchorSeqs.slice(0, 12),
			text: formatWindowText(header, digestLines, maxDigestChars),
		});
	}

	// 3. claim_evidence_digest (final claims vs actual verification/test/command evidence)
	const claimLines: string[] = [];
	const claimAnchors: number[] = [];
	if (snapshot.findings.length) {
		claimLines.push("--- REPORTED FINDINGS & CLAIMS ---");
		for (const f of snapshot.findings) {
			claimLines.push(
				`[finding ${f.id}] author=${f.authorAgentId} status=${f.status} score=${f.score ?? "n/a"} claim="${f.claim.slice(0, 200)}" summary="${f.summary.slice(0, 200)}"`,
			);
			for (const chk of f.checks ?? []) {
				claimLines.push(`  check(${chk.checker}): ${chk.status} score=${chk.score ?? "n/a"} msg="${chk.message.slice(0, 200)}"`);
			}
		}
	}
	const evidenceEvents = events.filter(
		(e) =>
			e.type === "finding.reported" ||
			e.type === "finding.verification" ||
			e.type === "finding.verdict" ||
			e.type === "run.nominated" ||
			e.type === "workspace.command" ||
			e.type === "driver.tool_result" ||
			e.type === "mcp.tool_result" ||
			e.type === "tool.result" ||
			e.type === "agent.turn",
	);
	claimLines.push("--- RECORDED VERIFICATION & EXECUTION EVIDENCE ---");
	for (const ev of evidenceEvents.slice(-50)) {
		if (ev.type.startsWith("finding.") || ev.type === "run.nominated" || ev.data.isError === true) {
			claimAnchors.push(ev.seq);
		}
		claimLines.push(formatCompactTraceEvent(ev, 220));
	}
	const claimHeader = `RUN=${snapshot.runId} SCOPE=claim_evidence_digest (seq ${minSeq}..${maxSeq})\nGOAL: ${goalLine.slice(0, 320)}`;
	windows.push({
		windowId: `claim_evidence:${minSeq}-${maxSeq}`,
		scope: "claim_evidence_digest",
		locality: "run_summary",
		agentId: null,
		seqStart: minSeq,
		seqEnd: maxSeq,
		anchorSeqs: claimAnchors.slice(-12),
		text: formatWindowText(claimHeader, claimLines, Math.min(maxDigestChars, 12_000)),
	});

	return windows;
}

export interface IndexLedgerOptions {
	readonly ledger: EvalLedger;
	readonly decisionClient?: DecisionModelClient;
	readonly repoRoot?: string;
	readonly genId?: string;
	readonly taskId?: string;
	readonly onlySuboptimal?: boolean;
	readonly limit?: number;
	readonly probes?: readonly System1ProbeDefinition[];
	readonly concurrency?: number;
	readonly skipJev?: boolean;
	readonly classification?: ProbClassificationOptions;
	readonly log?: (line: string) => void;
}

export interface IndexLedgerResult {
	readonly runsScanned: number;
	readonly runsIndexed: number;
	readonly skippedMissingTrace: number;
	readonly deterministicRowsWritten: number;
	readonly system1RowsWritten: number;
	readonly jevRequestsSent: number;
	readonly jevInputTokens: number;
	readonly errors: readonly string[];
}

/**
 * Write-time Behavioral Trace Indexer:
 * - Always writes Layer 1 deterministic behavioral + fault tags (0 LLM calls).
 * - When `decisionClient` is provided and `!skipJev`, evaluates all applicable versioned
 *   atomic System-1 `noul` probes per compact window in batched 0-output-token passes.
 * - 100% idempotent per `(runKey, judgeName, judgeVersion)`: re-running skips already-indexed
 *   probes with 0 Jev calls; editing any probe's rubric automatically rotates `judgeVersion`.
 */
export async function indexLedgerTraces(opts: IndexLedgerOptions): Promise<IndexLedgerResult> {
	const log = opts.log ?? (() => {});
	const activeProbes = opts.probes ?? SYSTEM1_PROBE_CATALOG;
	const useJev = Boolean(opts.decisionClient) && !opts.skipJev;
	const concurrency = Math.max(1, Math.min(16, opts.concurrency ?? 4));

	const allRuns = opts.ledger.listRuns({ genId: opts.genId, taskId: opts.taskId }).filter((r) =>
		opts.onlySuboptimal ? !r.deliveredPass || r.deliveredScore < 0.999 : true,
	);
	const targetRuns = opts.limit !== undefined ? allRuns.slice(0, opts.limit) : allRuns;

	// Preload existing (runKey -> Set<judgeName::judgeVersion>) for O(1) idempotency checks
	const existingByRun = new Map<string, Set<string>>();
	for (const s of opts.ledger.listTraceScores({ genId: opts.genId, taskId: opts.taskId })) {
		let set = existingByRun.get(s.runKey);
		if (!set) {
			set = new Set<string>();
			existingByRun.set(s.runKey, set);
		}
		set.add(`${s.judgeName}::${s.judgeVersion}`);
	}

	let runsIndexed = 0;
	let skippedMissingTrace = 0;
	let deterministicRowsWritten = 0;
	let system1RowsWritten = 0;
	let jevRequestsSent = 0;
	let jevInputTokens = 0;
	const errors: string[] = [];

	const processRun = async (run: LedgerRunRecord): Promise<void> => {
		const traceDbPath = opts.ledger.resolveTraceDbPath(run, opts.repoRoot);
		const snapshot = traceDbPath ? loadOfflineTraceSnapshot(traceDbPath, run.runId) : undefined;
		const existing = existingByRun.get(run.runKey) ?? new Set<string>();
		const toWrite: TraceScoreRecord[] = [];
		const nowIso = new Date().toISOString();

		// Layer 1: Deterministic tags (0 LLM calls, always idempotent)
		const detTags = extractDeterministicRunTags(run, { traceDbPath, snapshot, indexedAt: nowIso });
		for (const tag of detTags) {
			if (!existing.has(`${tag.judgeName}::${tag.judgeVersion}`)) {
				toWrite.push(tag);
				existing.add(`${tag.judgeName}::${tag.judgeVersion}`);
				deterministicRowsWritten += 1;
			}
		}

		// Layer 2: Batched Atomic System-1 Jev probes
		if (useJev && opts.decisionClient) {
			if (!snapshot || snapshot.events.length === 0) {
				skippedMissingTrace += 1;
			} else {
				const windows = extractTraceWindows(snapshot, {
					swarmSize: run.swarmSize,
					goalSummary: `${run.taskId} (${run.armKey}, seed=${run.seed}, deliveredPass=${run.deliveredPass}, score=${run.deliveredScore.toFixed(3)})`,
				});
				for (const win of windows) {
					const matchingProbes = activeProbes.filter(
						(p) => p.scope === win.scope && !existing.has(`${p.judgeName}::${p.judgeVersion}`),
					);
					if (!matchingProbes.length) continue;

					const questions: Record<string, DecisionQuestion> = {};
					for (const p of matchingProbes) {
						questions[p.judgeName] = { type: "noul", instructions: p.instructions };
					}
					try {
						const resp = await opts.decisionClient.decide({
							state: win.text,
							questions,
						});
						jevRequestsSent += 1;
						jevInputTokens += resp.inputTokens;
						for (const p of matchingProbes) {
							const ans = resp.answers[p.judgeName];
							if (!ans || ans.type !== "noul") continue;
							const prob = Math.round(ans.noul * 10_000) / 10_000;
							const confidence = Math.round(ans.confidence * 10_000) / 10_000;
							const label = classifyProb(prob, confidence, opts.classification);
							toWrite.push({
								scoreId: makeScoreId(run.runKey, p.judgeName, p.judgeVersion, win.agentId, win.seqStart, win.seqEnd),
								runKey: run.runKey,
								traceDbPath: traceDbPath ?? "",
								agentId: win.agentId,
								seqStart: win.seqStart,
								seqEnd: win.seqEnd,
								locality: win.locality,
								source: "system1_jev",
								judgeName: p.judgeName,
								judgeVersion: p.judgeVersion,
								model: resp.model,
								prob,
								confidence,
								label,
								evidenceSeqs: win.anchorSeqs.length ? win.anchorSeqs : [win.seqStart],
								indexedAt: nowIso,
							});
							system1RowsWritten += 1;
						}
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						errors.push(`${run.runId}/${win.windowId}: ${msg.slice(0, 200)}`);
					}
				}
				// Mark probes written for this run (avoid duplicate calls across multiple windows of same run only if already covered;
				// note: per-window scoring evaluates all windows of an unindexed run, then subsequent runs skip it completely!)
				for (const row of toWrite) {
					existing.add(`${row.judgeName}::${row.judgeVersion}`);
				}
			}
		}

		if (toWrite.length > 0) {
			opts.ledger.upsertTraceScores(toWrite);
			runsIndexed += 1;
			log(`  [indexed] ${run.runId} (+${toWrite.length} trace_scores)`);
		}
	};

	// Bounded concurrency pool
	let cursor = 0;
	const workers = Array.from({ length: Math.min(concurrency, Math.max(1, targetRuns.length)) }, async () => {
		while (cursor < targetRuns.length) {
			const idx = cursor++;
			await processRun(targetRuns[idx]!);
		}
	});
	await Promise.all(workers);

	return {
		runsScanned: targetRuns.length,
		runsIndexed,
		skippedMissingTrace,
		deterministicRowsWritten,
		system1RowsWritten,
		jevRequestsSent,
		jevInputTokens,
		errors,
	};
}
