import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AnytimePoint, Scorecard } from "./contracts.ts";
import { sha256Text } from "./sandbox.ts";
import type { HarnessHealthCertificate } from "./verify.ts";

export interface GenerationRecord {
	readonly genId: string;
	readonly label: string;
	readonly parentGenId: string | null;
	readonly gitSha: string;
	readonly dirtyDiffSha: string;
	readonly createdAt: string;
	readonly configFingerprint: string;
	readonly healthCert?: HarnessHealthCertificate;
	readonly notes?: string;
}

export interface LedgerRunRecord {
	readonly runKey: string;
	readonly genId: string;
	readonly campaignDir: string;
	readonly runId: string;
	readonly taskId: string;
	readonly family: string;
	readonly armKey: string;
	readonly topology: string;
	readonly controlRung: string;
	readonly swarmSize: number;
	readonly seed: number;
	readonly deliveredPass: boolean;
	readonly deliveredScore: number;
	readonly bestOfflineScore: number;
	readonly aulcTokens: number;
	readonly tokensTotal: number;
	readonly wallMs: number;
	readonly hasFault: boolean;
	readonly scorecard: Scorecard;
	readonly ingestedAt: string;
}

export interface IngestCampaignResult {
	readonly genId: string;
	readonly label: string;
	readonly campaignDir: string;
	readonly runsIngested: number;
}

export interface BackfillResult {
	readonly campaignsScanned: number;
	readonly generationsCount: number;
	readonly totalRunsIngested: number;
	readonly campaigns: readonly IngestCampaignResult[];
}

export type TraceScoreLocality = "single_turn" | "nearby_window" | "run_summary" | "escalated_span";
export type TraceScoreSource = "deterministic" | "system1_jev" | "escalated_judge";
export type TraceScoreLabel = "flagged" | "clean" | "uncertain";

/**
 * Exhaustive behavioral trace-score record (Table 3: `trace_scores`):
 * - `source: "system1_jev"` enforces 0-output-token scoring (`rationale?: never`).
 * - `source: "deterministic" | "escalated_judge"` requires a non-empty diagnostic `rationale`.
 */
export type TraceScoreRecord = {
	readonly scoreId: string;
	readonly runKey: string;
	readonly traceDbPath: string;
	readonly agentId: string | null;
	readonly seqStart: number;
	readonly seqEnd: number;
	readonly locality: TraceScoreLocality;
	readonly judgeName: string;
	readonly judgeVersion: string;
	readonly model: string;
	readonly prob: number;
	readonly confidence: number;
	readonly label: TraceScoreLabel;
	readonly evidenceSeqs: readonly number[];
	readonly indexedAt: string;
} & (
	| { readonly source: "system1_jev"; readonly rationale?: never }
	| { readonly source: "deterministic" | "escalated_judge"; readonly rationale: string }
);

export interface TraceAuditRecord {
	readonly auditId: string;
	readonly scoreId: string;
	readonly auditor: string;
	readonly groundTruth: "flagged" | "clean";
	readonly notes?: string;
	readonly auditedAt: string;
}

export interface TraceScoreFilter {
	readonly runKey?: string;
	readonly genId?: string;
	readonly taskId?: string;
	readonly judgeName?: string;
	readonly judgeVersion?: string;
	readonly label?: TraceScoreLabel;
	readonly source?: TraceScoreSource;
	readonly minProb?: number;
}

function clamp01(x: number): number {
	return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

/**
 * Reconstruct step-function AULC for historical v1 scorecards that pre-dated `Scorecard v2`
 * using their saved `anytimeFrontier` and budget envelope.
 */
function reconstructAulcTokens(card: Scorecard): number {
	if (card.anytime && Number.isFinite(card.anytime.aulcTokens)) {
		return card.anytime.aulcTokens;
	}
	const frontier: readonly AnytimePoint[] = card.anytimeFrontier ?? [];
	const horizon = Math.max(card.reproducibility.budget?.tokens ?? 0, card.tokens.total, 1);
	const isOptimization = card.family === "scalar-optimization";
	const floor = isOptimization ? 1 : 0;
	const ceiling = isOptimization
		? Math.max(floor + 1e-6, card.bestOfflineScore, card.deliveredScore, 20)
		: 1;
	const span = Math.max(1e-6, ceiling - floor);
	const norm = (s: number) => clamp01((s - floor) / span);

	if (!frontier.length) {
		// Fall back to step at final token count if nominated passed/scored
		const t = Math.min(horizon, card.tokens.total);
		const y = norm(card.deliveredScore);
		return Math.round(((horizon - t) * y / horizon) * 10_000) / 10_000;
	}

	const sorted = [...frontier].sort((a, b) => a.atTokens - b.atTokens);
	let area = 0;
	let prevX = 0;
	let prevY = 0;
	for (const pt of sorted) {
		const cx = Math.max(prevX, Math.min(horizon, pt.atTokens));
		area += (cx - prevX) * prevY;
		prevX = cx;
		prevY = Math.max(prevY, norm(pt.nominatedScore));
	}
	if (prevX < horizon) {
		area += (horizon - prevX) * prevY;
	}
	return Math.round(clamp01(area / horizon) * 10_000) / 10_000;
}

export function deriveArmKey(card: Scorecard): string {
	const topo = card.reproducibility.topology || card.reproducibility.controlRung;
	const n = Math.max(1, card.dynamics.swarmSize);
	if (card.reproducibility.controlRung === "solo") return "solo-n1";
	if (card.reproducibility.controlRung === "silent_bon") return `silent_bon-n${n}`;
	return `${topo}-n${n}`;
}

function inferGenerationLabel(gitSha: string, campaignNames: readonly string[], repoRoot?: string): string {
	const shortSha = gitSha.slice(0, 7);
	// Prefer explicit RSI-X or v3/v2 tag from git commit subject when available
	if (repoRoot && gitSha && gitSha !== "unknown") {
		const gitLog = spawnSync("git", ["show", "-s", "--format=%s", gitSha], {
			cwd: repoRoot,
			encoding: "utf8",
			timeout: 1500,
		});
		if (gitLog.status === 0) {
			const subject = gitLog.stdout.trim();
			const rsiMatch = /\b(RSI-\d+[a-z]?)\b/i.exec(subject);
			if (rsiMatch) return `${rsiMatch[1]!.toUpperCase()} (${shortSha})`;
			const vMatch = /\b(Harness v\d+(?:\.\d+)?)\b/i.exec(subject);
			if (vMatch) return `${vMatch[1]} (${shortSha})`;
			if (subject) return `${subject.slice(0, 28)} (${shortSha})`;
		}
	}
	// Fallback to campaign directory prefix (e.g. rsi11b-*, rsi7-*, live-v2-*)
	for (const name of campaignNames) {
		const m = /^(rsi\d+[a-z]?|v\d+(?:\.\d+)?|r\d+)/i.exec(name);
		if (m) return `${m[1]!.toUpperCase()} (${shortSha})`;
	}
	return `gen-${shortSha}`;
}

function loadScorecardsFromDir(campaignDir: string): Scorecard[] {
	const out: Scorecard[] = [];
	const jsonl = join(campaignDir, "results.jsonl");
	if (existsSync(jsonl)) {
		for (const line of readFileSync(jsonl, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line) as Scorecard);
			} catch {
				// Ignore partial trailing line from an interrupted run.
			}
		}
		return out;
	}
	const scDir = join(campaignDir, "scorecards");
	if (existsSync(scDir)) {
		for (const file of readdirSync(scDir).sort()) {
			if (!file.endsWith(".json")) continue;
			try {
				out.push(JSON.parse(readFileSync(join(scDir, file), "utf8")) as Scorecard);
			} catch {
				// Ignore malformed file.
			}
		}
	}
	return out;
}

function discoverCampaignDirs(rootDir: string): string[] {
	const found: string[] = [];
	if (!existsSync(rootDir)) return found;
	const visit = (dir: string) => {
		if (existsSync(join(dir, "results.jsonl")) || existsSync(join(dir, "scorecards"))) {
			found.push(dir);
			return;
		}
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			visit(join(dir, entry.name));
		}
	};
	visit(rootDir);
	return found;
}

/**
 * Immutable SQLite Generation Ledger (`eval-lab/ledger.sqlite`).
 * Indexes every harness generation (`gitSha`, `label`, `parentGenId`, `healthCert`)
 * and every run `Scorecard` across campaigns so longitudinal trajectory, regression,
 * Pareto frontier, and saturation analyses run instantaneously over the full history.
 */
export class EvalLedger {
	readonly dbPath: string;
	private readonly db: DatabaseSync;

	constructor(dbPath: string) {
		this.dbPath = resolve(dbPath);
		mkdirSync(dirname(this.dbPath), { recursive: true });
		this.db = new DatabaseSync(this.dbPath);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			CREATE TABLE IF NOT EXISTS generations (
				gen_id TEXT PRIMARY KEY,
				label TEXT NOT NULL,
				parent_gen_id TEXT,
				git_sha TEXT NOT NULL,
				dirty_diff_sha TEXT NOT NULL,
				created_at TEXT NOT NULL,
				config_fingerprint TEXT NOT NULL,
				health_cert_json TEXT,
				notes TEXT
			);
			CREATE INDEX IF NOT EXISTS generations_created ON generations (created_at);
			CREATE TABLE IF NOT EXISTS runs (
				run_key TEXT PRIMARY KEY,
				gen_id TEXT NOT NULL,
				campaign_dir TEXT NOT NULL,
				run_id TEXT NOT NULL,
				task_id TEXT NOT NULL,
				family TEXT NOT NULL,
				arm_key TEXT NOT NULL,
				topology TEXT NOT NULL,
				control_rung TEXT NOT NULL,
				swarm_size INTEGER NOT NULL,
				seed INTEGER NOT NULL,
				delivered_pass INTEGER NOT NULL,
				delivered_score REAL NOT NULL,
				best_offline_score REAL NOT NULL,
				aulc_tokens REAL NOT NULL,
				tokens_total INTEGER NOT NULL,
				wall_ms INTEGER NOT NULL,
				has_fault INTEGER NOT NULL,
				scorecard_json TEXT NOT NULL,
				ingested_at TEXT NOT NULL,
				FOREIGN KEY (gen_id) REFERENCES generations(gen_id)
			);
			CREATE INDEX IF NOT EXISTS runs_gen_task ON runs (gen_id, task_id, arm_key, seed);
			CREATE INDEX IF NOT EXISTS runs_task ON runs (task_id, arm_key);
			CREATE TABLE IF NOT EXISTS trace_scores (
				score_id       TEXT PRIMARY KEY,
				run_key        TEXT NOT NULL,
				trace_db_path  TEXT NOT NULL,
				agent_id       TEXT,
				seq_start      INTEGER NOT NULL,
				seq_end        INTEGER NOT NULL,
				locality       TEXT NOT NULL,
				source         TEXT NOT NULL,
				judge_name     TEXT NOT NULL,
				judge_version  TEXT NOT NULL,
				model          TEXT NOT NULL,
				prob           REAL NOT NULL,
				confidence     REAL NOT NULL,
				label          TEXT NOT NULL,
				evidence_seqs  TEXT NOT NULL,
				rationale      TEXT,
				indexed_at     TEXT NOT NULL,
				FOREIGN KEY (run_key) REFERENCES runs(run_key)
			);
			CREATE INDEX IF NOT EXISTS ts_lookup  ON trace_scores (judge_name, judge_version, label, prob);
			CREATE INDEX IF NOT EXISTS ts_run     ON trace_scores (run_key, judge_name, label);
			CREATE INDEX IF NOT EXISTS ts_version ON trace_scores (run_key, judge_version);
			CREATE TABLE IF NOT EXISTS trace_audits (
				audit_id       TEXT PRIMARY KEY,
				score_id       TEXT NOT NULL,
				auditor        TEXT NOT NULL,
				ground_truth   TEXT NOT NULL,
				notes          TEXT,
				audited_at     TEXT NOT NULL,
				FOREIGN KEY (score_id) REFERENCES trace_scores(score_id)
			);
			CREATE INDEX IF NOT EXISTS ta_score ON trace_audits (score_id);
		`);
	}

	close(): void {
		this.db.close();
	}

	registerGeneration(gen: GenerationRecord): void {
		const existing = this.db
			.prepare("SELECT gen_id, created_at, health_cert_json, notes FROM generations WHERE gen_id = ?")
			.get(gen.genId) as { gen_id: string; created_at: string; health_cert_json: string | null; notes: string | null } | undefined;

		// Preserve earliest createdAt so multi-campaign generations stay anchored chronologically
		const createdAt = existing && existing.created_at < gen.createdAt ? existing.created_at : gen.createdAt;
		const healthJson = gen.healthCert ? JSON.stringify(gen.healthCert) : (existing?.health_cert_json ?? null);
		const notes = gen.notes ?? existing?.notes ?? null;

		this.db
			.prepare(
				`INSERT INTO generations (gen_id, label, parent_gen_id, git_sha, dirty_diff_sha, created_at, config_fingerprint, health_cert_json, notes)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(gen_id) DO UPDATE SET
				   label = excluded.label,
				   parent_gen_id = COALESCE(excluded.parent_gen_id, generations.parent_gen_id),
				   created_at = excluded.created_at,
				   health_cert_json = COALESCE(excluded.health_cert_json, generations.health_cert_json),
				   notes = COALESCE(excluded.notes, generations.notes)`,
			)
			.run(
				gen.genId,
				gen.label,
				gen.parentGenId,
				gen.gitSha,
				gen.dirtyDiffSha,
				createdAt,
				gen.configFingerprint,
				healthJson,
				notes,
			);
	}

	ingestCampaignDir(
		campaignDir: string,
		opts: {
			genId?: string;
			label?: string;
			parentGenId?: string | null;
			repoRoot?: string;
			healthCert?: HarnessHealthCertificate;
			notes?: string;
		} = {},
	): IngestCampaignResult {
		const absDir = resolve(campaignDir);
		const cards = loadScorecardsFromDir(absDir);
		const protoPath = join(absDir, "protocol.json");
		const proto = existsSync(protoPath)
			? (JSON.parse(readFileSync(protoPath, "utf8")) as {
					createdAt?: string;
					git?: { harnessGitSha?: string; dirtyDiffSha?: string };
					budgetMode?: string;
					budget?: Record<string, unknown>;
					taskOptions?: Record<string, string>;
				})
			: {};

		const firstCard = cards[0];
		const gitSha = firstCard?.reproducibility.harnessGitSha ?? proto.git?.harnessGitSha ?? "unknown";
		const dirtyDiffSha = firstCard?.reproducibility.dirtyDiffSha ?? proto.git?.dirtyDiffSha ?? "unknown";
		const createdAt = proto.createdAt ?? new Date().toISOString();
		const shortSha = gitSha.slice(0, 7);
		const genId = opts.genId ?? `sha-${shortSha}`;
		const label = opts.label ?? inferGenerationLabel(gitSha, [basename(absDir)], opts.repoRoot);
		const relDir = opts.repoRoot ? relative(opts.repoRoot, absDir).replace(/\\/g, "/") : absDir;
		const configFingerprint = sha256Text(
			JSON.stringify({
				gitSha,
				budgetMode: proto.budgetMode ?? firstCard?.reproducibility.budgetMode ?? "unknown",
				taskOptions: proto.taskOptions ?? {},
			}),
		).slice(0, 16);

		this.registerGeneration({
			genId,
			label,
			parentGenId: opts.parentGenId ?? null,
			gitSha,
			dirtyDiffSha,
			createdAt,
			configFingerprint,
			healthCert: opts.healthCert,
			notes: opts.notes,
		});

		const insertRun = this.db.prepare(
			`INSERT OR REPLACE INTO runs (
				run_key, gen_id, campaign_dir, run_id, task_id, family, arm_key, topology,
				control_rung, swarm_size, seed, delivered_pass, delivered_score, best_offline_score,
				aulc_tokens, tokens_total, wall_ms, has_fault, scorecard_json, ingested_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const nowIso = new Date().toISOString();
		for (const card of cards) {
			const armKey = deriveArmKey(card);
			const aulcTokens = reconstructAulcTokens(card);
			const runKey = `${genId}::${relDir}::${card.runId}`;
			insertRun.run(
				runKey,
				genId,
				relDir,
				card.runId,
				card.taskId,
				card.family,
				armKey,
				card.reproducibility.topology || card.reproducibility.controlRung,
				card.reproducibility.controlRung,
				Math.max(1, card.dynamics.swarmSize),
				card.reproducibility.seed,
				card.deliveredPass ? 1 : 0,
				card.deliveredScore,
				card.bestOfflineScore,
				aulcTokens,
				card.tokens.total,
				card.time.wallClockMs,
				card.hasHarnessFault ? 1 : 0,
				JSON.stringify(card),
				nowIso,
			);
		}

		return {
			genId,
			label,
			campaignDir: relDir,
			runsIngested: cards.length,
		};
	}

	/**
	 * Recursively discover and chronologically backfill all saved eval-lab campaigns under `rootDir`.
	 * Automatically links `parentGenId` across generations in chronological order.
	 */
	backfillDirectory(rootDir: string, opts: { repoRoot?: string } = {}): BackfillResult {
		const dirs = discoverCampaignDirs(resolve(rootDir));
		const withMeta = dirs.map((dir) => {
			const protoPath = join(dir, "protocol.json");
			const proto = existsSync(protoPath)
				? (JSON.parse(readFileSync(protoPath, "utf8")) as { createdAt?: string })
				: {};
			const cards = loadScorecardsFromDir(dir);
			const gitSha = cards[0]?.reproducibility.harnessGitSha ?? "unknown";
			return {
				dir,
				createdAt: proto.createdAt ?? "9999-12-31T00:00:00.000Z",
				gitSha,
				count: cards.length,
			};
		});

		withMeta.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.dir.localeCompare(b.dir));

		// Group campaign names per gitSha so label inference sees all sibling campaigns for that generation
		const namesBySha = new Map<string, string[]>();
		for (const item of withMeta) {
			const arr = namesBySha.get(item.gitSha) ?? [];
			arr.push(basename(item.dir));
			namesBySha.set(item.gitSha, arr);
		}

		const campaigns: IngestCampaignResult[] = [];
		const seenGenOrder: string[] = [];
		let totalRunsIngested = 0;

		for (const item of withMeta) {
			if (item.count === 0) continue;
			const genId = `sha-${item.gitSha.slice(0, 7)}`;
			const prevGenId =
				seenGenOrder.includes(genId)
					? undefined
					: seenGenOrder.at(-1) ?? null;
			const label = inferGenerationLabel(item.gitSha, namesBySha.get(item.gitSha) ?? [], opts.repoRoot);
			const res = this.ingestCampaignDir(item.dir, {
				genId,
				label,
				parentGenId: prevGenId,
				repoRoot: opts.repoRoot,
			});
			if (!seenGenOrder.includes(genId)) seenGenOrder.push(genId);
			campaigns.push(res);
			totalRunsIngested += res.runsIngested;
		}

		return {
			campaignsScanned: dirs.length,
			generationsCount: this.listGenerations().length,
			totalRunsIngested,
			campaigns,
		};
	}

	listGenerations(): GenerationRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM generations ORDER BY created_at ASC, gen_id ASC")
			.all() as Array<Record<string, unknown>>;
		return rows.map((r) => ({
			genId: String(r.gen_id),
			label: String(r.label),
			parentGenId: r.parent_gen_id ? String(r.parent_gen_id) : null,
			gitSha: String(r.git_sha),
			dirtyDiffSha: String(r.dirty_diff_sha),
			createdAt: String(r.created_at),
			configFingerprint: String(r.config_fingerprint),
			healthCert: r.health_cert_json ? (JSON.parse(String(r.health_cert_json)) as HarnessHealthCertificate) : undefined,
			notes: r.notes ? String(r.notes) : undefined,
		}));
	}

	listRuns(filter: { genId?: string; taskId?: string; excludeFaulted?: boolean } = {}): LedgerRunRecord[] {
		const clauses: string[] = [];
		const params: Array<string | number> = [];
		if (filter.genId) {
			clauses.push("gen_id = ?");
			params.push(filter.genId);
		}
		if (filter.taskId) {
			clauses.push("task_id = ?");
			params.push(filter.taskId);
		}
		if (filter.excludeFaulted) {
			clauses.push("has_fault = 0");
		}
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.db
			.prepare(`SELECT * FROM runs ${where} ORDER BY gen_id ASC, task_id ASC, seed ASC, arm_key ASC`)
			.all(...params) as Array<Record<string, unknown>>;
		return rows.map((r) => this.mapRunRow(r));
	}

	private mapRunRow(r: Record<string, unknown>): LedgerRunRecord {
		return {
			runKey: String(r.run_key),
			genId: String(r.gen_id),
			campaignDir: String(r.campaign_dir),
			runId: String(r.run_id),
			taskId: String(r.task_id),
			family: String(r.family),
			armKey: String(r.arm_key),
			topology: String(r.topology),
			controlRung: String(r.control_rung),
			swarmSize: Number(r.swarm_size),
			seed: Number(r.seed),
			deliveredPass: Number(r.delivered_pass) === 1,
			deliveredScore: Number(r.delivered_score),
			bestOfflineScore: Number(r.best_offline_score),
			aulcTokens: Number(r.aulc_tokens),
			tokensTotal: Number(r.tokens_total),
			wallMs: Number(r.wall_ms),
			hasFault: Number(r.has_fault) === 1,
			scorecard: JSON.parse(String(r.scorecard_json)) as Scorecard,
			ingestedAt: String(r.ingested_at),
		};
	}

	private mapTraceScoreRow(r: Record<string, unknown>): TraceScoreRecord {
		const source = String(r.source) as TraceScoreSource;
		const base = {
			scoreId: String(r.score_id),
			runKey: String(r.run_key),
			traceDbPath: String(r.trace_db_path),
			agentId: r.agent_id !== null && r.agent_id !== undefined ? String(r.agent_id) : null,
			seqStart: Number(r.seq_start),
			seqEnd: Number(r.seq_end),
			locality: String(r.locality) as TraceScoreLocality,
			judgeName: String(r.judge_name),
			judgeVersion: String(r.judge_version),
			model: String(r.model),
			prob: Number(r.prob),
			confidence: Number(r.confidence),
			label: String(r.label) as TraceScoreLabel,
			evidenceSeqs: JSON.parse(String(r.evidence_seqs ?? "[]")) as number[],
			indexedAt: String(r.indexed_at),
		};
		if (source === "system1_jev") {
			return { ...base, source: "system1_jev" };
		}
		return {
			...base,
			source,
			rationale: r.rationale !== null && r.rationale !== undefined ? String(r.rationale) : "",
		};
	}

	/**
	 * Batch-insert or update behavioral trace scores inside a single atomic SQLite transaction.
	 */
	upsertTraceScores(scores: readonly TraceScoreRecord[]): number {
		if (!scores.length) return 0;
		const stmt = this.db.prepare(
			`INSERT OR REPLACE INTO trace_scores (
				score_id, run_key, trace_db_path, agent_id, seq_start, seq_end, locality,
				source, judge_name, judge_version, model, prob, confidence, label,
				evidence_seqs, rationale, indexed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.db.exec("BEGIN");
		try {
			for (const s of scores) {
				stmt.run(
					s.scoreId,
					s.runKey,
					s.traceDbPath,
					s.agentId,
					s.seqStart,
					s.seqEnd,
					s.locality,
					s.source,
					s.judgeName,
					s.judgeVersion,
					s.model,
					s.prob,
					s.confidence,
					s.label,
					JSON.stringify(s.evidenceSeqs),
					s.source === "system1_jev" ? null : s.rationale,
					s.indexedAt,
				);
			}
			this.db.exec("COMMIT");
			return scores.length;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	listTraceScores(filter: TraceScoreFilter = {}): TraceScoreRecord[] {
		const clauses: string[] = [];
		const params: Array<string | number> = [];
		const needsRunsJoin = Boolean(filter.genId || filter.taskId);
		if (filter.runKey) {
			clauses.push("ts.run_key = ?");
			params.push(filter.runKey);
		}
		if (filter.genId) {
			clauses.push("r.gen_id = ?");
			params.push(filter.genId);
		}
		if (filter.taskId) {
			clauses.push("r.task_id = ?");
			params.push(filter.taskId);
		}
		if (filter.judgeName) {
			clauses.push("ts.judge_name = ?");
			params.push(filter.judgeName);
		}
		if (filter.judgeVersion) {
			clauses.push("ts.judge_version = ?");
			params.push(filter.judgeVersion);
		}
		if (filter.label) {
			clauses.push("ts.label = ?");
			params.push(filter.label);
		}
		if (filter.source) {
			clauses.push("ts.source = ?");
			params.push(filter.source);
		}
		if (filter.minProb !== undefined) {
			clauses.push("ts.prob >= ?");
			params.push(filter.minProb);
		}
		const joinSql = needsRunsJoin ? "JOIN runs r ON r.run_key = ts.run_key" : "";
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.db
			.prepare(`SELECT ts.* FROM trace_scores ts ${joinSql} ${where} ORDER BY ts.run_key ASC, ts.seq_start ASC, ts.judge_name ASC`)
			.all(...params) as Array<Record<string, unknown>>;
		return rows.map((r) => this.mapTraceScoreRow(r));
	}

	/**
	 * Return runs missing one or more required `(judgeName -> judgeVersion)` pairs in `trace_scores`.
	 * Automatically picks up runs whose probe wording changed (bumping `judgeVersion`).
	 */
	listUnindexedRuns(
		requiredJudgeVersions: ReadonlyMap<string, string>,
		filter: { genId?: string; taskId?: string; onlySuboptimal?: boolean; limit?: number } = {},
	): LedgerRunRecord[] {
		const candidates = this.listRuns({ genId: filter.genId, taskId: filter.taskId }).filter((r) =>
			filter.onlySuboptimal ? !r.deliveredPass || r.deliveredScore < 0.999 : true,
		);
		if (requiredJudgeVersions.size === 0) {
			return filter.limit !== undefined ? candidates.slice(0, filter.limit) : candidates;
		}
		const existingRows = this.db
			.prepare("SELECT DISTINCT run_key, judge_name, judge_version FROM trace_scores")
			.all() as Array<{ run_key: string; judge_name: string; judge_version: string }>;
		const presentByRun = new Map<string, Set<string>>();
		for (const row of existingRows) {
			let set = presentByRun.get(row.run_key);
			if (!set) {
				set = new Set<string>();
				presentByRun.set(row.run_key, set);
			}
			set.add(`${row.judge_name}::${row.judge_version}`);
		}
		const out: LedgerRunRecord[] = [];
		for (const run of candidates) {
			const present = presentByRun.get(run.runKey);
			let missing = false;
			for (const [judgeName, judgeVersion] of requiredJudgeVersions.entries()) {
				if (!present?.has(`${judgeName}::${judgeVersion}`)) {
					missing = true;
					break;
				}
			}
			if (missing) {
				out.push(run);
				if (filter.limit !== undefined && out.length >= filter.limit) break;
			}
		}
		return out;
	}

	recordTraceAudit(audit: TraceAuditRecord): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO trace_audits (audit_id, score_id, auditor, ground_truth, notes, audited_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				audit.auditId,
				audit.scoreId,
				audit.auditor,
				audit.groundTruth,
				audit.notes ?? null,
				audit.auditedAt,
			);
	}

	listTraceAudits(filter: { judgeName?: string; judgeVersion?: string } = {}): Array<TraceAuditRecord & { score: TraceScoreRecord }> {
		const clauses: string[] = [];
		const params: Array<string> = [];
		if (filter.judgeName) {
			clauses.push("ts.judge_name = ?");
			params.push(filter.judgeName);
		}
		if (filter.judgeVersion) {
			clauses.push("ts.judge_version = ?");
			params.push(filter.judgeVersion);
		}
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.db
			.prepare(
				`SELECT ta.audit_id, ta.score_id AS audit_score_id, ta.auditor, ta.ground_truth, ta.notes, ta.audited_at,
				        ts.*
				 FROM trace_audits ta
				 JOIN trace_scores ts ON ts.score_id = ta.score_id
				 ${where}
				 ORDER BY ta.audited_at DESC, ta.audit_id ASC`,
			)
			.all(...params) as Array<Record<string, unknown>>;
		return rows.map((r) => ({
			auditId: String(r.audit_id),
			scoreId: String(r.audit_score_id),
			auditor: String(r.auditor),
			groundTruth: String(r.ground_truth) as "flagged" | "clean",
			notes: r.notes !== null && r.notes !== undefined ? String(r.notes) : undefined,
			auditedAt: String(r.audited_at),
			score: this.mapTraceScoreRow(r),
		}));
	}

	/**
	 * Resolve a run's on-disk `trace.db` path cleanly for both relative and absolute `campaignDir`s.
	 */
	resolveTraceDbPath(run: LedgerRunRecord, repoRoot?: string): string | undefined {
		const baseDir = repoRoot && !run.campaignDir.startsWith("/")
			? resolve(repoRoot, run.campaignDir)
			: resolve(run.campaignDir);
		const candidates = [
			join(baseDir, "runs", run.runId, "run", "trace.db"),
			join(baseDir, "runs", run.runId, "trace.db"),
			join(baseDir, run.runId, "run", "trace.db"),
			join(baseDir, run.runId, "trace.db"),
		];
		return candidates.find((p) => existsSync(p));
	}
}
