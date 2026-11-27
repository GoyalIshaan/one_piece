import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ToolDefinition } from "@one-piece/core";
import {
	createTraceNavTools,
	type TraceNavAgent,
	type TraceNavBackend,
	type TraceNavEvent,
	type TraceNavFinding,
	type TraceNavPost,
	type TraceNavScoreHint,
} from "@one-piece/engine";
import { readRunEvents } from "./event-reader.ts";
import type { TraceScoreRecord } from "./ledger.ts";

export interface OfflineTraceSnapshot {
	readonly runId: string;
	readonly traceDbPath: string;
	readonly goalTitle?: string;
	readonly goalText?: string;
	readonly events: readonly TraceNavEvent[];
	readonly agents: readonly TraceNavAgent[];
	readonly posts: readonly TraceNavPost[];
	readonly findings: readonly TraceNavFinding[];
}

function tableExists(db: DatabaseSync, table: string): boolean {
	const row = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(table) as { name?: string } | undefined;
	return Boolean(row?.name);
}

/**
 * Load a complete read-only snapshot of an offline `trace.db` (events + agents + posts + findings + run goal)
 * for trace navigation, Tier-2 escalation, and calibration audit excerpt extraction.
 */
export function loadOfflineTraceSnapshot(traceDbPath: string, runId: string): OfflineTraceSnapshot {
	const read = readRunEvents(traceDbPath, runId);
	const events: TraceNavEvent[] = read.events.map((e) => ({
		seq: e.seq,
		ts: e.ts,
		type: e.type,
		agentId: e.agentId,
		data: e.data,
	}));
	const agents: TraceNavAgent[] = read.agentDocs.map((a) => ({
		id: a.id,
		role: a.role,
		driverId: a.driverId,
	}));
	const posts: TraceNavPost[] = [];
	const findings: TraceNavFinding[] = [];
	let goalTitle: string | undefined;
	let goalText: string | undefined;

	if (existsSync(traceDbPath)) {
		const db = new DatabaseSync(traceDbPath, { readOnly: true });
		try {
			if (tableExists(db, "docs")) {
				const runRow = db
					.prepare("SELECT data FROM docs WHERE collection = 'runs' AND id = ?")
					.get(runId) as { data?: string } | undefined;
				if (runRow?.data) {
					const runDoc = JSON.parse(runRow.data) as { goal?: { title?: string; text?: string } };
					goalTitle = runDoc.goal?.title;
					goalText = runDoc.goal?.text;
				}

				const postRows = db
					.prepare("SELECT data FROM docs WHERE collection = 'posts' AND run_id = ?")
					.all(runId) as Array<{ data: string }>;
				for (const row of postRows) {
					const doc = JSON.parse(row.data) as Record<string, unknown>;
					if (typeof doc.id !== "string") continue;
					const cited = new Set<string>();
					if (Array.isArray(doc.parentIds)) {
						for (const x of doc.parentIds) if (typeof x === "string") cited.add(x);
					}
					if (typeof doc.parentPostId === "string" && doc.parentPostId) cited.add(doc.parentPostId);
					if (Array.isArray(doc.references)) {
						for (const ref of doc.references) {
							if (ref && typeof ref === "object" && typeof (ref as { postId?: unknown }).postId === "string") {
								cited.add((ref as { postId: string }).postId);
							}
						}
					}
					posts.push({
						id: doc.id,
						authorAgentId: String(doc.authorAgentId ?? ""),
						title:
							typeof doc.title === "string"
								? doc.title
								: typeof doc.topic === "string"
									? doc.topic
									: typeof doc.summary === "string"
										? doc.summary
										: undefined,
						body: String(doc.body ?? doc.summary ?? doc.content ?? ""),
						visibility: typeof doc.visibility === "string" ? doc.visibility : undefined,
						parentIds: cited.size ? [...cited] : undefined,
						createdAt: typeof doc.createdAt === "number" ? doc.createdAt : undefined,
					});
				}

				const findingRows = db
					.prepare("SELECT data FROM docs WHERE collection = 'findings' AND run_id = ?")
					.all(runId) as Array<{ data: string }>;
				for (const row of findingRows) {
					const doc = JSON.parse(row.data) as Record<string, unknown>;
					if (typeof doc.id !== "string") continue;
					const subs = Array.isArray(doc.submissions) ? (doc.submissions as Array<Record<string, unknown>>) : [];
					const latest = subs.at(-1);
					const rawChecks = Array.isArray(latest?.checks) ? (latest.checks as Array<Record<string, unknown>>) : [];
					findings.push({
						id: doc.id,
						authorAgentId: String(doc.authorAgentId ?? ""),
						status: String(doc.status ?? "unknown"),
						claim: String(doc.claim ?? ""),
						summary: String(doc.summary ?? ""),
						evidence: Array.isArray(doc.evidence)
							? doc.evidence.filter((x): x is string => typeof x === "string")
							: [],
						score: typeof doc.score === "number" ? doc.score : undefined,
						checks: rawChecks.map((c) => ({
							checker: String(c.checker ?? "verifier"),
							status: String(c.status ?? "unknown"),
							message: String(c.message ?? ""),
							score: typeof c.score === "number" ? c.score : undefined,
						})),
					});
				}
			}
		} finally {
			db.close();
		}
	}

	return { runId, traceDbPath, goalTitle, goalText, events, agents, posts, findings };
}

/**
 * Create a read-only `TraceNavBackend` over an offline campaign `trace.db` file
 * (plus optional existing `trace_scores` hints and spilled artifacts under `<runDir>/artifacts/`).
 */
export function createOfflineTraceNavBackend(opts: {
	traceDbPath: string;
	runId: string;
	scoreHints?: readonly TraceScoreRecord[];
}): TraceNavBackend {
	const snap = loadOfflineTraceSnapshot(opts.traceDbPath, opts.runId);
	const artifactsDir = join(dirname(opts.traceDbPath), "artifacts");
	const hints: TraceNavScoreHint[] = (opts.scoreHints ?? []).map((s) => ({
		judgeName: s.judgeName,
		label: s.label,
		prob: s.prob,
		agentId: s.agentId,
		seqStart: s.seqStart,
		seqEnd: s.seqEnd,
	}));

	return {
		runId: snap.runId,
		goalTitle: snap.goalTitle,
		goalText: snap.goalText,
		listEvents: () => snap.events,
		listAgents: () => snap.agents,
		listPosts: () => snap.posts,
		listFindings: () => snap.findings,
		listScoreHints: () => hints,
		readArtifact(idOrSha: string, offset = 0, limitBytes = 4096): string | undefined {
			const clean = idOrSha.replace(/[^a-zA-Z0-9._-]/g, "");
			if (!clean) return undefined;
			for (const candidate of [join(artifactsDir, clean), join(artifactsDir, `${clean}.txt`), join(artifactsDir, `${clean}.log`)]) {
				if (existsSync(candidate)) {
					return readFileSync(candidate, "utf8").slice(offset, offset + Math.min(limitBytes, 8192));
				}
			}
			return undefined;
		},
	};
}

/**
 * Create the 5 read-only trace-navigation tools bound to an offline `trace.db` for Tier-2 escalation.
 */
export function createOfflineTraceNavTools(opts: {
	traceDbPath: string;
	runId: string;
	scoreHints?: readonly TraceScoreRecord[];
}): ToolDefinition[] {
	return createTraceNavTools(createOfflineTraceNavBackend(opts));
}
