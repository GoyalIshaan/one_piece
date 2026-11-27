import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type QuotaPoolRouter } from "@one-piece/core";
import { formatCompactTraceEvent, SwarmOS } from "@one-piece/engine";
import type { EvalLedger, LedgerRunRecord, TraceAuditRecord, TraceScoreRecord } from "./ledger.ts";
import { sha256Text } from "./sandbox.ts";
import { createOfflineTraceNavTools, loadOfflineTraceSnapshot } from "./trace-navigator.ts";

export interface EvidencePointer {
	readonly runKey: string;
	readonly runId: string;
	readonly taskId: string;
	readonly genId: string;
	readonly agentId: string | null;
	readonly seqStart: number;
	readonly seqEnd: number;
	readonly prob: number;
	readonly traceDbPath: string;
	readonly rationale?: string;
}

export interface FailureBucketRow {
	readonly judgeName: string;
	readonly judgeVersion: string;
	readonly source: TraceScoreRecord["source"];
	readonly flaggedFailedRuns: number;
	readonly flaggedPassedRuns: number;
	readonly totalFlaggedRuns: number;
	/** Fraction of failed/sub-optimal runs carrying this tag [0..1]. */
	readonly failureShare: number;
	/** Relative risk P(fail | flagged) / P(fail). >1.5x indicates strong causal failure association; ~1.0x is harmless background noise. */
	readonly failureLift: number;
	/** Sum of (1 - normalizedScore) across failed runs carrying this tag. */
	readonly estimatedLostScore: number;
	readonly evidencePointers: readonly EvidencePointer[];
}

export interface UnclassifiedFailureRef {
	readonly runKey: string;
	readonly runId: string;
	readonly taskId: string;
	readonly genId: string;
	readonly deliveredScore: number;
	readonly uncertainCount: number;
	readonly traceDbPath?: string;
}

export interface FailureBucketReport {
	readonly totalRuns: number;
	readonly indexedRuns: number;
	readonly totalFailedRuns: number;
	readonly totalPassedRuns: number;
	readonly baseFailureRate: number;
	readonly buckets: readonly FailureBucketRow[];
	readonly unclassifiedFailures: readonly UnclassifiedFailureRef[];
}

export interface GenerationBucketDelta {
	readonly judgeName: string;
	readonly fromGenId: string;
	readonly toGenId: string;
	readonly fromRate: number;
	readonly toRate: number;
	readonly deltaPp: number;
}

export type EscalatedJudgeFinding = {
	readonly runKey: string;
	readonly runId: string;
	readonly rootCauseTag: string;
	readonly seqStart: number;
	readonly seqEnd: number;
	readonly agentId: string | null;
	readonly rationale: string;
	readonly scoreRecord: TraceScoreRecord;
} & (
	| { readonly isNovelPattern: false; readonly suggestedAtomicProbe?: never }
	| { readonly isNovelPattern: true; readonly suggestedAtomicProbe?: string }
);

export interface AuditSampleItem {
	readonly score: TraceScoreRecord;
	readonly run: LedgerRunRecord;
	readonly stratum: "clean_on_fail" | "flagged" | "uncertain";
	readonly rawExcerpt: string;
}

export type JudgeCalibrationSummary = {
	readonly judgeName: string;
	readonly judgeVersion: string;
	readonly auditedCount: number;
	readonly tp: number;
	readonly fp: number;
	readonly tn: number;
	readonly fn: number;
	readonly precision: number;
	readonly recall: number;
	readonly f1: number;
	readonly falseNegativeRate: number;
} & (
	| { readonly status: "ok"; readonly warning?: never }
	| { readonly status: "warning"; readonly warning: string }
);

export interface BehavioralDiagnosticsSummary {
	readonly indexedRuns: number;
	readonly totalRuns: number;
	readonly totalFailedRuns: number;
	readonly unclassifiedFailedRuns: number;
	readonly buckets: readonly FailureBucketRow[];
	readonly byGeneration: ReadonlyArray<{
		readonly genId: string;
		readonly label: string;
		readonly totalRuns: number;
		readonly indexedRuns: number;
		readonly tagRates: Readonly<Record<string, number>>;
	}>;
	readonly judgeCalibration: readonly JudgeCalibrationSummary[];
}

function round4(x: number): number {
	return Number.isFinite(x) ? Math.round(x * 10_000) / 10_000 : 0;
}

function clamp01(x: number): number {
	return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

function normalizedLossForRun(run: LedgerRunRecord): number {
	if (run.deliveredPass && run.deliveredScore >= 0.999) return 0;
	if (run.family === "scalar-optimization") {
		const ceil = Math.max(run.bestOfflineScore, run.deliveredScore, 20);
		return clamp01(1 - run.deliveredScore / Math.max(1e-6, ceil));
	}
	return clamp01(1 - run.deliveredScore);
}

/**
 * Filter a score list so each `judgeName` uses either an explicitly requested `judgeVersion`
 * or the latest `judgeVersion` (by most recent `indexedAt`) present in the table.
 */
function selectActiveScores(
	scores: readonly TraceScoreRecord[],
	explicitVersion?: string,
): TraceScoreRecord[] {
	if (explicitVersion) {
		return scores.filter((s) => s.judgeVersion === explicitVersion);
	}
	const latestByJudge = new Map<string, { version: string; indexedAt: string }>();
	for (const s of scores) {
		const cur = latestByJudge.get(s.judgeName);
		if (!cur || s.indexedAt > cur.indexedAt) {
			latestByJudge.set(s.judgeName, { version: s.judgeVersion, indexedAt: s.indexedAt });
		}
	}
	return scores.filter((s) => latestByJudge.get(s.judgeName)?.version === s.judgeVersion);
}

/**
 * Read-time SQL analytics: Join `runs` and `trace_scores` to rank behavioral & fault failure buckets
 * by Failure Share, Failure Lift (`P(fail | flagged) / P(fail)`), and Estimated Lost Score Impact,
 * while explicitly surfacing `unclassifiedFailures` for Tier-2 escalation.
 */
export function analyzeFailureBuckets(
	ledger: EvalLedger,
	opts: {
		genId?: string;
		taskId?: string;
		judgeName?: string;
		judgeVersion?: string;
		minProb?: number;
		repoRoot?: string;
	} = {},
): FailureBucketReport {
	const runs = ledger.listRuns({ genId: opts.genId, taskId: opts.taskId });
	const runByKey = new Map(runs.map((r) => [r.runKey, r]));
	const rawScores = ledger.listTraceScores({
		genId: opts.genId,
		taskId: opts.taskId,
		judgeName: opts.judgeName,
		judgeVersion: opts.judgeVersion,
	});
	const activeScores = selectActiveScores(rawScores, opts.judgeVersion);

	const indexedRunKeys = new Set<string>();
	for (const s of activeScores) {
		if (runByKey.has(s.runKey)) indexedRunKeys.add(s.runKey);
	}

	const failedRuns = runs.filter((r) => !r.deliveredPass);
	const passedRuns = runs.filter((r) => r.deliveredPass);
	const totalFailedRuns = failedRuns.length;
	const totalPassedRuns = passedRuns.length;
	const baseFailureRate = runs.length > 0 ? totalFailedRuns / runs.length : 0;
	const minProb = opts.minProb ?? 0;

	// Group flagged scores per (judgeName -> runKey -> strongest TraceScoreRecord)
	const judgeMeta = new Map<string, { judgeVersion: string; source: TraceScoreRecord["source"] }>();
	const flaggedByJudgeRun = new Map<string, Map<string, TraceScoreRecord>>();
	const flaggedRunKeys = new Set<string>();
	const uncertainCountByRun = new Map<string, number>();

	for (const s of activeScores) {
		const run = runByKey.get(s.runKey);
		if (!run) continue;
		if (s.label === "uncertain") {
			uncertainCountByRun.set(s.runKey, (uncertainCountByRun.get(s.runKey) ?? 0) + 1);
		}
		if (s.label !== "flagged" || s.prob < minProb) continue;

		flaggedRunKeys.add(s.runKey);
		judgeMeta.set(s.judgeName, { judgeVersion: s.judgeVersion, source: s.source });
		let byRun = flaggedByJudgeRun.get(s.judgeName);
		if (!byRun) {
			byRun = new Map<string, TraceScoreRecord>();
			flaggedByJudgeRun.set(s.judgeName, byRun);
		}
		const prev = byRun.get(s.runKey);
		if (!prev || s.prob > prev.prob) {
			byRun.set(s.runKey, s);
		}
	}

	const buckets: FailureBucketRow[] = [];
	for (const [judgeName, byRun] of flaggedByJudgeRun.entries()) {
		const meta = judgeMeta.get(judgeName)!;
		let flaggedFailedRuns = 0;
		let flaggedPassedRuns = 0;
		let estimatedLostScore = 0;
		const evidence: EvidencePointer[] = [];

		for (const [runKey, sc] of byRun.entries()) {
			const run = runByKey.get(runKey)!;
			if (!run.deliveredPass) {
				flaggedFailedRuns += 1;
				estimatedLostScore += normalizedLossForRun(run);
				evidence.push({
					runKey,
					runId: run.runId,
					taskId: run.taskId,
					genId: run.genId,
					agentId: sc.agentId,
					seqStart: sc.seqStart,
					seqEnd: sc.seqEnd,
					prob: sc.prob,
					traceDbPath: sc.traceDbPath,
					...(sc.source !== "system1_jev" ? { rationale: sc.rationale } : {}),
				});
			} else {
				flaggedPassedRuns += 1;
			}
		}

		const totalFlaggedRuns = flaggedFailedRuns + flaggedPassedRuns;
		const failureShare = totalFailedRuns > 0 ? round4(flaggedFailedRuns / totalFailedRuns) : 0;
		const pFailGivenFlag = totalFlaggedRuns > 0 ? flaggedFailedRuns / totalFlaggedRuns : 0;
		const failureLift = baseFailureRate > 0 ? round4(pFailGivenFlag / baseFailureRate) : 0;

		evidence.sort((a, b) => b.prob - a.prob || a.runId.localeCompare(b.runId));
		buckets.push({
			judgeName,
			judgeVersion: meta.judgeVersion,
			source: meta.source,
			flaggedFailedRuns,
			flaggedPassedRuns,
			totalFlaggedRuns,
			failureShare,
			failureLift,
			estimatedLostScore: round4(estimatedLostScore),
			evidencePointers: evidence.slice(0, 5),
		});
	}

	// Rank by estimated lost score * failureLift weight (surfacing high-impact, high-lift root causes first)
	buckets.sort(
		(a, b) =>
			b.estimatedLostScore - a.estimatedLostScore ||
			b.failureLift - a.failureLift ||
			b.flaggedFailedRuns - a.flaggedFailedRuns ||
			a.judgeName.localeCompare(b.judgeName),
	);

	const unclassifiedFailures: UnclassifiedFailureRef[] = failedRuns
		.filter((r) => !flaggedRunKeys.has(r.runKey))
		.map((r) => ({
			runKey: r.runKey,
			runId: r.runId,
			taskId: r.taskId,
			genId: r.genId,
			deliveredScore: r.deliveredScore,
			uncertainCount: uncertainCountByRun.get(r.runKey) ?? 0,
			traceDbPath: ledger.resolveTraceDbPath(r, opts.repoRoot),
		}));

	return {
		totalRuns: runs.length,
		indexedRuns: indexedRunKeys.size,
		totalFailedRuns,
		totalPassedRuns,
		baseFailureRate: round4(baseFailureRate),
		buckets,
		unclassifiedFailures,
	};
}

/**
 * Compare behavioral tag flag rates across two generations (`fromGenId` -> `toGenId`).
 */
export function compareBucketsAcrossGenerations(
	ledger: EvalLedger,
	fromGenId: string,
	toGenId: string,
	opts: { taskId?: string; minProb?: number } = {},
): GenerationBucketDelta[] {
	const fromRep = analyzeFailureBuckets(ledger, { genId: fromGenId, taskId: opts.taskId, minProb: opts.minProb });
	const toRep = analyzeFailureBuckets(ledger, { genId: toGenId, taskId: opts.taskId, minProb: opts.minProb });
	const allTags = new Set<string>([
		...fromRep.buckets.map((b) => b.judgeName),
		...toRep.buckets.map((b) => b.judgeName),
	]);
	const fromMap = new Map(fromRep.buckets.map((b) => [b.judgeName, b]));
	const toMap = new Map(toRep.buckets.map((b) => [b.judgeName, b]));

	const out: GenerationBucketDelta[] = [];
	for (const judgeName of allTags) {
		const fromB = fromMap.get(judgeName);
		const toB = toMap.get(judgeName);
		const fromRate = fromRep.totalRuns > 0 ? round4((fromB?.totalFlaggedRuns ?? 0) / fromRep.totalRuns) : 0;
		const toRate = toRep.totalRuns > 0 ? round4((toB?.totalFlaggedRuns ?? 0) / toRep.totalRuns) : 0;
		out.push({
			judgeName,
			fromGenId,
			toGenId,
			fromRate,
			toRate,
			deltaPp: Math.round((toRate - fromRate) * 1000) / 10,
		});
	}
	return out.sort((a, b) => Math.abs(b.deltaPp) - Math.abs(a.deltaPp) || a.judgeName.localeCompare(b.judgeName));
}

type ParsedEscalatedResult = {
	readonly rootCauseTag: string;
	readonly seqStart: number;
	readonly seqEnd: number;
	readonly agentId: string | null;
	readonly rationale: string;
} & (
	| { readonly isNovelPattern: false; readonly suggestedAtomicProbe?: never }
	| { readonly isNovelPattern: true; readonly suggestedAtomicProbe?: string }
);

function parseEscalatedJson(text: string): ParsedEscalatedResult {
	const match = /\{[\s\S]*\}/.exec(text);
	if (match) {
		try {
			const obj = JSON.parse(match[0]) as Record<string, unknown>;
			const rawTag = typeof obj.rootCauseTag === "string" ? obj.rootCauseTag.trim() : "unknown_failure";
			const rootCauseTag = rawTag.toLowerCase().replace(/[^a-z0-9_:-]+/g, "_") || "unknown_failure";
			const seqStart = Math.max(0, Math.floor(Number(obj.seqStart ?? 0)));
			const seqEnd = Math.max(seqStart, Math.floor(Number(obj.seqEnd ?? seqStart)));
			const agentId = typeof obj.agentId === "string" && obj.agentId.trim() ? obj.agentId.trim() : null;
			const rationale = typeof obj.rationale === "string" && obj.rationale.trim()
				? obj.rationale.trim().slice(0, 600)
				: "Escalated trace judge identified failure root cause.";
			const suggestedAtomicProbe = typeof obj.suggestedAtomicProbe === "string" && obj.suggestedAtomicProbe.trim()
				? obj.suggestedAtomicProbe.trim().slice(0, 300)
				: undefined;
			if (Boolean(obj.isNovelPattern)) {
				return {
					rootCauseTag,
					isNovelPattern: true,
					seqStart,
					seqEnd,
					agentId,
					rationale,
					...(suggestedAtomicProbe ? { suggestedAtomicProbe } : {}),
				};
			}
			return {
				rootCauseTag,
				isNovelPattern: false,
				seqStart,
				seqEnd,
				agentId,
				rationale,
			};
		} catch {
			// Fall through to safe fallback
		}
	}
	return {
		rootCauseTag: "unparsed_escalated_failure",
		isNovelPattern: false,
		seqStart: 0,
		seqEnd: 0,
		agentId: null,
		rationale: text.trim().slice(0, 400) || "Escalated judge returned unparseable response.",
	};
}

/**
 * Layer 3 (Tier-2 Escalation): Run a read-only tool-using Agent-as-Judge equipped with
 * `trace_list_anchors`, `trace_expand_window`, `trace_search_events`, `trace_get_peer_context`,
 * and `trace_read_evidence` over failed runs that had zero Layer 1/2 flags (`unclassifiedFailures`).
 */
export async function escalateUnexplainedFailures(opts: {
	readonly ledger: EvalLedger;
	readonly router: QuotaPoolRouter;
	readonly genId?: string;
	readonly taskId?: string;
	readonly maxEscalate?: number;
	readonly repoRoot?: string;
	readonly log?: (line: string) => void;
}): Promise<EscalatedJudgeFinding[]> {
	const log = opts.log ?? (() => {});
	const maxEscalate = Math.max(1, opts.maxEscalate ?? 5);
	const report = analyzeFailureBuckets(opts.ledger, {
		genId: opts.genId,
		taskId: opts.taskId,
		repoRoot: opts.repoRoot,
	});
	const targets = report.unclassifiedFailures.filter((u) => Boolean(u.traceDbPath)).slice(0, maxEscalate);
	if (!targets.length) return [];

	const runsByKey = new Map(opts.ledger.listRuns({ genId: opts.genId, taskId: opts.taskId }).map((r) => [r.runKey, r]));
	const findings: EscalatedJudgeFinding[] = [];

	for (const target of targets) {
		const run = runsByKey.get(target.runKey);
		const traceDbPath = target.traceDbPath;
		if (!run || !traceDbPath) continue;

		const existingHints = opts.ledger.listTraceScores({ runKey: run.runKey });
		const navTools = createOfflineTraceNavTools({
			traceDbPath,
			runId: run.runId,
			scoreHints: existingHints,
		});
		const snap = loadOfflineTraceSnapshot(traceDbPath, run.runId);
		const tailLines = snap.events.slice(-15).map((e) => formatCompactTraceEvent(e, 200)).join("\n");

		const tmpRoot = mkdtempSync(join(tmpdir(), "eval-escalate-"));
		const judgeWorkspace = join(tmpRoot, "workspace");
		mkdirSync(judgeWorkspace, { recursive: true });
		const store = new MemoryStore();
		let os: SwarmOS | undefined;
		try {
			os = await SwarmOS.create({
				runId: `escalate-${sha256Text(run.runKey).slice(0, 10)}`,
				runDir: join(tmpRoot, "run"),
				workspace: judgeWorkspace,
				topology: "single",
				goal: {
					title: `Escalate trace diagnosis for ${run.runId}`,
					text: `Diagnose unexplained failure in ${run.taskId} (${run.armKey}, seed=${run.seed}).`,
				},
				enableFieldGuide: false,
				store,
				router: opts.router,
			});

			const judge = await os.spawnWorker({
				role: "reviewer",
				readOnly: true,
				workspace: judgeWorkspace,
				tools: navTools,
				systemPrompt: [
					"You are a Tier-2 Trace-Navigating Forensic Judge diagnosing an unexplained benchmark failure.",
					"You have 5 read-only trace navigation tools: `trace_list_anchors`, `trace_expand_window`, `trace_search_events`, `trace_get_peer_context`, and `trace_read_evidence`.",
					"Start by inspecting the final events below. Whenever the local window does not clearly explain the root cause, ALWAYS call `trace_list_anchors`, `trace_search_events`, `trace_expand_window`, or `trace_get_peer_context` to hunt earlier turns and sibling peers!",
					'Respond strictly with JSON: {"rootCauseTag":"snake_case_tag","isNovelPattern":true|false,"seqStart":1,"seqEnd":10,"agentId":"agt-id-or-null","rationale":"concise root cause citing exact seq numbers","suggestedAtomicProbe":"optional single yes/no noul question if isNovelPattern is true"}',
				].join("\n"),
			});

			try {
				const prompt = [
					`Unexplained failed run: ${run.runId} (task=${run.taskId}, arm=${run.armKey}, seed=${run.seed})`,
					`Delivered pass=${run.deliveredPass}, score=${run.deliveredScore.toFixed(3)}, bestOffline=${run.bestOfflineScore.toFixed(3)}`,
					`Grade details: ${run.scorecard.gradeDetails}`,
					`Total trace events: ${snap.events.length} (seq ${snap.events[0]?.seq ?? 0}..${snap.events.at(-1)?.seq ?? 0})`,
					"",
					"Final 15 events (use your trace_* tools to search/expand earlier history!):",
					tailLines || "(empty trace)",
				].join("\n");

				const res = await judge.runTurn(prompt);
				const parsed = parseEscalatedJson(res.finalText);
				const modelStr = `${judge.agent.driverId}/${res.model ?? judge.agent.model ?? "unknown"}`;
				const nowIso = new Date().toISOString();
				const judgeVersion = "escalated-v1";
				const scoreRecord: TraceScoreRecord = {
					scoreId: `ts_${sha256Text(`${run.runKey}|${parsed.rootCauseTag}|${judgeVersion}|${parsed.agentId ?? ""}|${parsed.seqStart}|${parsed.seqEnd}`).slice(0, 20)}`,
					runKey: run.runKey,
					traceDbPath,
					agentId: parsed.agentId,
					seqStart: parsed.seqStart,
					seqEnd: parsed.seqEnd,
					locality: "escalated_span",
					source: "escalated_judge",
					judgeName: parsed.rootCauseTag,
					judgeVersion,
					model: modelStr,
					prob: 0.95,
					confidence: 0.9,
					label: "flagged",
					evidenceSeqs: parsed.seqStart > 0 ? [parsed.seqStart, ...(parsed.seqEnd !== parsed.seqStart ? [parsed.seqEnd] : [])] : [],
					rationale: parsed.rationale,
					indexedAt: nowIso,
				};
				opts.ledger.upsertTraceScores([scoreRecord]);
				findings.push({
					runKey: run.runKey,
					runId: run.runId,
					...parsed,
					scoreRecord,
				});
				log(`  [escalated] ${run.runId} -> ${parsed.rootCauseTag} (seq ${parsed.seqStart}..${parsed.seqEnd}, novel=${parsed.isNovelPattern})`);
			} finally {
				await judge.close();
			}
		} finally {
			if (os) await os.dispose();
			store.close();
			rmSync(tmpRoot, { recursive: true, force: true });
		}
	}

	return findings;
}

/**
 * Deterministic PRNG for stratified audit sampling (reproducible given `seed`).
 */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
	const arr = [...items];
	let s = (seed >>> 0) || 1;
	const next = () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		const tmp = arr[i]!;
		arr[i] = arr[j]!;
		arr[j] = tmp;
	}
	return arr;
}

function extractRawExcerpt(traceDbPath: string, runId: string, seqStart: number, seqEnd: number, agentId: string | null): string {
	if (!traceDbPath) return "(trace.db unavailable)";
	const snap = loadOfflineTraceSnapshot(traceDbPath, runId);
	const slice = snap.events.filter((e) => {
		if (e.seq < seqStart || e.seq > seqEnd) return false;
		if (agentId && e.agentId && e.agentId !== agentId) return false;
		return true;
	});
	return slice.slice(0, 40).map((e) => formatCompactTraceEvent(e, 240)).join("\n") || "(no events in span)";
}

/**
 * Stratified Calibration Audit Sampler:
 * Oversamples **50% `clean` on failed runs** (actively hunting silent false negatives!),
 * **30% `flagged`**, and **20% `uncertain`**, skipping already-audited `score_id`s.
 */
export function sampleAuditQueue(
	ledger: EvalLedger,
	opts: { sampleSize?: number; judgeName?: string; judgeVersion?: string; seed?: number } = {},
): AuditSampleItem[] {
	const sampleSize = Math.max(1, opts.sampleSize ?? 20);
	const seed = opts.seed ?? 42;
	const runsByKey = new Map(ledger.listRuns().map((r) => [r.runKey, r]));
	const auditedIds = new Set(ledger.listTraceAudits({ judgeName: opts.judgeName, judgeVersion: opts.judgeVersion }).map((a) => a.scoreId));

	const scores = selectActiveScores(
		ledger.listTraceScores({ judgeName: opts.judgeName, judgeVersion: opts.judgeVersion, source: "system1_jev" }),
		opts.judgeVersion,
	).filter((s) => !auditedIds.has(s.scoreId) && runsByKey.has(s.runKey));

	const cleanOnFail: TraceScoreRecord[] = [];
	const flagged: TraceScoreRecord[] = [];
	const uncertain: TraceScoreRecord[] = [];
	const otherClean: TraceScoreRecord[] = [];

	for (const s of scores) {
		const run = runsByKey.get(s.runKey)!;
		if (s.label === "clean" && !run.deliveredPass) cleanOnFail.push(s);
		else if (s.label === "flagged") flagged.push(s);
		else if (s.label === "uncertain") uncertain.push(s);
		else otherClean.push(s);
	}

	const qCleanFail = Math.round(sampleSize * 0.5);
	const qFlagged = Math.round(sampleSize * 0.3);
	const qUncertain = Math.max(0, sampleSize - qCleanFail - qFlagged);

	const picked: Array<{ score: TraceScoreRecord; stratum: AuditSampleItem["stratum"] }> = [];
	const used = new Set<string>();
	const take = (pool: TraceScoreRecord[], count: number, stratum: AuditSampleItem["stratum"]) => {
		for (const sc of seededShuffle(pool, seed + picked.length)) {
			if (picked.length >= sampleSize || count <= 0) break;
			if (used.has(sc.scoreId)) continue;
			used.add(sc.scoreId);
			picked.push({ score: sc, stratum });
			count -= 1;
		}
	};

	take(cleanOnFail, qCleanFail, "clean_on_fail");
	take(flagged, qFlagged, "flagged");
	take(uncertain, qUncertain, "uncertain");
	// Backfill any shortfall if a stratum had fewer items than quota
	if (picked.length < sampleSize) {
		take(cleanOnFail, sampleSize - picked.length, "clean_on_fail");
		take(flagged, sampleSize - picked.length, "flagged");
		take(uncertain, sampleSize - picked.length, "uncertain");
		take(otherClean, sampleSize - picked.length, "clean_on_fail");
	}

	return picked.map(({ score, stratum }) => {
		const run = runsByKey.get(score.runKey)!;
		return {
			score,
			run,
			stratum,
			rawExcerpt: extractRawExcerpt(score.traceDbPath, run.runId, score.seqStart, score.seqEnd, score.agentId),
		};
	});
}

/**
 * Automated Frontier Auditor for `eval-lab audit-judges --auditor frontier`:
 * Uses the configured `QuotaPoolRouter` (CLI Codex/Gemini/etc.) to independently label sampled
 * trace windows as `"flagged" | "clean"` and persist verdicts to `trace_audits`.
 */
export async function runFrontierAudit(opts: {
	readonly ledger: EvalLedger;
	readonly router: QuotaPoolRouter;
	readonly items: readonly AuditSampleItem[];
	readonly log?: (line: string) => void;
}): Promise<TraceAuditRecord[]> {
	const log = opts.log ?? (() => {});
	if (!opts.items.length) return [];

	const tmpRoot = mkdtempSync(join(tmpdir(), "eval-audit-"));
	const auditWorkspace = join(tmpRoot, "workspace");
	mkdirSync(auditWorkspace, { recursive: true });
	const store = new MemoryStore();
	const recorded: TraceAuditRecord[] = [];
	let os: SwarmOS | undefined;
	try {
		os = await SwarmOS.create({
			runId: `audit-${Date.now()}`,
			runDir: join(tmpRoot, "run"),
			workspace: auditWorkspace,
			topology: "single",
			goal: { title: "Judge calibration audit", text: "Audit System-1 behavioral labels against raw trace excerpts." },
			enableFieldGuide: false,
			store,
			router: opts.router,
		});

		const auditor = await os.spawnWorker({
			role: "reviewer",
			readOnly: true,
			workspace: auditWorkspace,
			systemPrompt: [
				"You are a strict Frontier Calibration Auditor verifying whether a behavioral failure tag truly occurred in the provided trace excerpt.",
				"Judge strictly on the raw trace evidence (ignore any prior label).",
				'Respond strictly with JSON: {"groundTruth":"flagged"|"clean","notes":"concise 1-sentence justification"}',
			].join("\n"),
		});
		try {
			for (const item of opts.items) {
				const prompt = [
					`Tag under audit: ${item.score.judgeName} (${item.score.judgeVersion})`,
					`Run: ${item.run.runId} (task=${item.run.taskId}, deliveredPass=${item.run.deliveredPass}, score=${item.run.deliveredScore.toFixed(3)})`,
					`Span: agent=${item.score.agentId ?? "all"}, seq ${item.score.seqStart}..${item.score.seqEnd}`,
					"",
					"Raw trace excerpt:",
					item.rawExcerpt,
				].join("\n");
				const res = await auditor.runTurn(prompt);
				const match = /\{[\s\S]*\}/.exec(res.finalText);
				let groundTruth: "flagged" | "clean" = "clean";
				let notes = res.finalText.trim().slice(0, 240);
				if (match) {
					try {
						const parsed = JSON.parse(match[0]) as { groundTruth?: unknown; notes?: unknown };
						if (parsed.groundTruth === "flagged" || parsed.groundTruth === "clean") {
							groundTruth = parsed.groundTruth;
						}
						if (typeof parsed.notes === "string") notes = parsed.notes.slice(0, 300);
					} catch {
						// Keep default
					}
				}
				const audit: TraceAuditRecord = {
					auditId: `aud_${sha256Text(`${item.score.scoreId}|${auditor.agent.driverId}|${Date.now()}`).slice(0, 16)}`,
					scoreId: item.score.scoreId,
					auditor: `frontier:${auditor.agent.driverId}/${res.model ?? auditor.agent.model ?? "unknown"}`,
					groundTruth,
					notes,
					auditedAt: new Date().toISOString(),
				};
				opts.ledger.recordTraceAudit(audit);
				recorded.push(audit);
				log(`  [audit] ${item.score.judgeName} (${item.stratum}, sys1=${item.score.label}) -> truth=${groundTruth}`);
			}
		} finally {
			await auditor.close();
		}
	} finally {
		if (os) await os.dispose();
		store.close();
		rmSync(tmpRoot, { recursive: true, force: true });
	}
	return recorded;
}

/**
 * Compute precision, recall, F1, and False Negative Rate per `(judgeName, judgeVersion)` from `trace_audits`.
 * Emits `CALIBRATION_WARNING` whenever `falseNegativeRate > 0.15` with `auditedCount >= 10`.
 */
export function computeJudgeCalibration(
	ledger: EvalLedger,
	opts: { judgeName?: string; judgeVersion?: string; fnrWarningThreshold?: number; minAuditsForWarning?: number } = {},
): JudgeCalibrationSummary[] {
	const fnrThresh = opts.fnrWarningThreshold ?? 0.15;
	const minAudits = opts.minAuditsForWarning ?? 10;
	const audits = ledger.listTraceAudits({ judgeName: opts.judgeName, judgeVersion: opts.judgeVersion });

	const grouped = new Map<string, { judgeName: string; judgeVersion: string; tp: number; fp: number; tn: number; fn: number }>();
	for (const a of audits) {
		const key = `${a.score.judgeName}::${a.score.judgeVersion}`;
		let cur = grouped.get(key);
		if (!cur) {
			cur = { judgeName: a.score.judgeName, judgeVersion: a.score.judgeVersion, tp: 0, fp: 0, tn: 0, fn: 0 };
			grouped.set(key, cur);
		}
		const predictedFlagged = a.score.label === "flagged";
		const actualFlagged = a.groundTruth === "flagged";
		if (predictedFlagged && actualFlagged) cur.tp += 1;
		else if (predictedFlagged && !actualFlagged) cur.fp += 1;
		else if (!predictedFlagged && actualFlagged) cur.fn += 1;
		else cur.tn += 1;
	}

	const out: JudgeCalibrationSummary[] = [];
	for (const g of grouped.values()) {
		const auditedCount = g.tp + g.fp + g.tn + g.fn;
		const precision = g.tp + g.fp > 0 ? round4(g.tp / (g.tp + g.fp)) : 1;
		const recall = g.tp + g.fn > 0 ? round4(g.tp / (g.tp + g.fn)) : 1;
		const f1 = precision + recall > 0 ? round4((2 * precision * recall) / (precision + recall)) : 0;
		const falseNegativeRate = g.tp + g.fn > 0 ? round4(g.fn / (g.tp + g.fn)) : 0;
		const base = {
			judgeName: g.judgeName,
			judgeVersion: g.judgeVersion,
			auditedCount,
			tp: g.tp,
			fp: g.fp,
			tn: g.tn,
			fn: g.fn,
			precision,
			recall,
			f1,
			falseNegativeRate,
		};
		if (auditedCount >= minAudits && falseNegativeRate > fnrThresh) {
			out.push({
				...base,
				status: "warning",
				warning: `CALIBRATION_WARNING: ${g.judgeName}@${g.judgeVersion} FNR=${(falseNegativeRate * 100).toFixed(1)}% > ${(fnrThresh * 100).toFixed(0)}% across ${auditedCount} audits — refine atomic rubric & bump judgeVersion.`,
			});
		} else {
			out.push({ ...base, status: "ok" });
		}
	}
	return out.sort((a, b) => b.falseNegativeRate - a.falseNegativeRate || a.judgeName.localeCompare(b.judgeName));
}

/**
 * Build the combined `BehavioralDiagnosticsSummary` embedded into `TrajectoryReport` and Chart 7
 * whenever `trace_scores` has indexed records.
 */
export function buildBehavioralDiagnosticsSummary(ledger: EvalLedger): BehavioralDiagnosticsSummary | undefined {
	const allScores = ledger.listTraceScores();
	if (!allScores.length) return undefined;

	const overall = analyzeFailureBuckets(ledger);
	const gens = ledger.listGenerations();
	const byGeneration = gens.map((g) => {
		const gRep = analyzeFailureBuckets(ledger, { genId: g.genId });
		const tagRates: Record<string, number> = {};
		for (const b of gRep.buckets) {
			tagRates[b.judgeName] = gRep.totalRuns > 0 ? round4(b.totalFlaggedRuns / gRep.totalRuns) : 0;
		}
		return {
			genId: g.genId,
			label: g.label,
			totalRuns: gRep.totalRuns,
			indexedRuns: gRep.indexedRuns,
			tagRates,
		};
	}).filter((g) => g.totalRuns > 0);

	return {
		indexedRuns: overall.indexedRuns,
		totalRuns: overall.totalRuns,
		totalFailedRuns: overall.totalFailedRuns,
		unclassifiedFailedRuns: overall.unclassifiedFailures.length,
		buckets: overall.buckets,
		byGeneration,
		judgeCalibration: computeJudgeCalibration(ledger),
	};
}

export function renderFailureBucketsMarkdown(
	report: FailureBucketReport,
	opts: { showEvidence?: boolean; deltas?: readonly GenerationBucketDelta[] } = {},
): string {
	const lines: string[] = [
		"# Behavioral Failure-Mode Diagnostics",
		"",
		`- **Runs:** ${report.totalRuns} total (${report.indexedRuns} indexed, ${report.totalFailedRuns} failed, ${report.totalPassedRuns} passed; base failure rate ${(report.baseFailureRate * 100).toFixed(1)}%)`,
		`- **Unclassified Failures:** ${report.unclassifiedFailures.length} failed run(s) with zero flagged tags`,
		"",
	];

	if (report.buckets.length) {
		lines.push(
			"## Ranked Failure Buckets (by Estimated Lost Score & Failure Lift)",
			"",
			"| Tag | Source | Failed Flagged | Passed Flagged | Failure Share | Failure Lift | Est. Lost Score |",
			"| --- | --- | ---: | ---: | ---: | ---: | ---: |",
		);
		for (const b of report.buckets) {
			lines.push(
				`| \`${b.judgeName}\` | ${b.source} | ${b.flaggedFailedRuns}/${report.totalFailedRuns} | ${b.flaggedPassedRuns}/${report.totalPassedRuns} | ${(b.failureShare * 100).toFixed(1)}% | **${b.failureLift.toFixed(2)}x** | ${b.estimatedLostScore.toFixed(2)} |`,
			);
		}
		if (opts.showEvidence) {
			lines.push("", "## Top Evidence Pointers", "");
			for (const b of report.buckets.slice(0, 8)) {
				if (!b.evidencePointers.length) continue;
				lines.push(`### \`${b.judgeName}\` (${b.judgeVersion})`);
				for (const ev of b.evidencePointers) {
					lines.push(
						`- \`${ev.runId}\` (${ev.taskId}, ${ev.genId}) agent=\`${ev.agentId ?? "all"}\` seq \`${ev.seqStart}..${ev.seqEnd}\` p=${ev.prob.toFixed(2)}${ev.rationale ? ` — ${ev.rationale}` : ""}`,
					);
				}
			}
		}
	} else {
		lines.push("_No flagged behavioral buckets found yet. Run `eval-lab index` to populate `trace_scores`._");
	}

	if (opts.deltas?.length) {
		lines.push(
			"",
			`## Generation Behavioral Delta (${opts.deltas[0]!.fromGenId} → ${opts.deltas[0]!.toGenId})`,
			"",
			"| Tag | From Rate | To Rate | Delta |",
			"| --- | ---: | ---: | ---: |",
		);
		for (const d of opts.deltas) {
			lines.push(
				`| \`${d.judgeName}\` | ${(d.fromRate * 100).toFixed(1)}% | ${(d.toRate * 100).toFixed(1)}% | ${d.deltaPp >= 0 ? "+" : ""}${d.deltaPp.toFixed(1)}pp |`,
			);
		}
	}

	if (report.unclassifiedFailures.length) {
		lines.push("", "## Unclassified Failures (Candidates for `--escalate`)", "");
		for (const u of report.unclassifiedFailures.slice(0, 15)) {
			lines.push(
				`- \`${u.runId}\` (${u.taskId}, ${u.genId}) score=${u.deliveredScore.toFixed(3)} uncertainWindows=${u.uncertainCount}${u.traceDbPath ? "" : " [no trace.db]"}`,
			);
		}
	}

	return lines.join("\n") + "\n";
}
