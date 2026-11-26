import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type BoardPost,
	type Collection,
	type Documents,
	type EventQuery,
	type HarnessEvent,
	type LeaseClaimResult,
	type Store,
	type TaskStatus,
	transitionClaimTask,
	transitionReleaseTask,
	transitionRenewTask,
} from "@one-piece/core";

const DEFAULT_BOARD = "swarm";

/**
 * Normalized v2 SQLite WAL store using Node's built-in `node:sqlite`.
 * Holds the append-only event log (with idempotency keys and causal parents)
 * plus normalized document projections and atomic lease transactions.
 */
export class SqliteStore implements Store {
	private readonly db: DatabaseSync;
	private readonly insertEvent;
	private readonly selectEventByIdempotency;
	private readonly upsertDoc;
	private readonly selectDoc;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS events (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				run_id TEXT NOT NULL,
				type TEXT NOT NULL,
				node_id TEXT,
				causal_parents TEXT,
				idempotency_key TEXT,
				data TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS events_run ON events (run_id, seq);
			CREATE UNIQUE INDEX IF NOT EXISTS events_idempotency
				ON events (run_id, idempotency_key)
				WHERE idempotency_key IS NOT NULL;

			CREATE TABLE IF NOT EXISTS docs (
				collection TEXT NOT NULL,
				id TEXT NOT NULL,
				run_id TEXT,
				data TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (collection, id)
			);
			CREATE INDEX IF NOT EXISTS docs_run ON docs (collection, run_id);
			CREATE INDEX IF NOT EXISTS docs_posts_board
				ON docs (run_id, coalesce(json_extract(data, '$.board'), '${DEFAULT_BOARD}'))
				WHERE collection = 'posts';
		`);
		this.insertEvent = this.db.prepare(
			"INSERT INTO events (ts, run_id, type, node_id, causal_parents, idempotency_key, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		this.selectEventByIdempotency = this.db.prepare(
			"SELECT seq FROM events WHERE run_id = ? AND idempotency_key = ?",
		);
		this.upsertDoc = this.db.prepare(
			"INSERT INTO docs (collection, id, run_id, data, updated_at) VALUES (?, ?, ?, ?, ?) " +
				"ON CONFLICT (collection, id) DO UPDATE SET run_id = excluded.run_id, data = excluded.data, updated_at = excluded.updated_at",
		);
		this.selectDoc = this.db.prepare("SELECT data FROM docs WHERE collection = ? AND id = ?");
	}

	appendEvent(event: Omit<HarnessEvent, "seq">): number {
		if (event.idempotencyKey) {
			const existing = this.selectEventByIdempotency.get(event.runId, event.idempotencyKey) as { seq: number } | undefined;
			if (existing) return Number(existing.seq);
		}
		const result = this.insertEvent.run(
			event.ts,
			event.runId,
			event.type,
			event.nodeId ?? null,
			event.causalParents?.length ? JSON.stringify(event.causalParents) : null,
			event.idempotencyKey ?? null,
			JSON.stringify(event.data),
		);
		return Number(result.lastInsertRowid);
	}

	events(runId: string, query: EventQuery = {}): HarnessEvent[] {
		const where = ["run_id = ?", "seq > ?"];
		const params: Array<string | number> = [runId, query.afterSeq ?? 0];
		if (query.nodeId) {
			where.push("node_id = ?");
			params.push(query.nodeId);
		}
		if (query.types?.length) {
			where.push(`type IN (${query.types.map(() => "?").join(",")})`);
			params.push(...query.types);
		}
		const limit = query.limit ? ` LIMIT ${Math.floor(query.limit)}` : "";
		const rows = this.db.prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq${limit}`).all(...params) as Array<Record<string, unknown>>;
		return rows.map((r) => ({
			seq: Number(r.seq),
			ts: Number(r.ts),
			runId: String(r.run_id),
			type: String(r.type),
			nodeId: typeof r.node_id === "string" ? r.node_id : undefined,
			causalParents: typeof r.causal_parents === "string" ? (JSON.parse(r.causal_parents) as string[]) : undefined,
			idempotencyKey: typeof r.idempotency_key === "string" ? r.idempotency_key : undefined,
			data: JSON.parse(String(r.data)) as Record<string, unknown>,
		}));
	}

	put<K extends Collection>(collection: K, doc: Documents[NoInfer<K>]): void {
		const runId = "runId" in doc && typeof doc.runId === "string" ? doc.runId : null;
		this.upsertDoc.run(collection, doc.id, runId, JSON.stringify(doc), Date.now());
	}

	get<K extends Collection>(collection: K, id: string): Documents[K] | undefined {
		const row = this.selectDoc.get(collection, id) as { data: string } | undefined;
		return row ? (JSON.parse(row.data) as Documents[K]) : undefined;
	}

	list<K extends Collection>(collection: K, filter: { runId?: string } = {}): Documents[K][] {
		const rows = filter.runId
			? this.db.prepare("SELECT data FROM docs WHERE collection = ? AND run_id = ? ORDER BY updated_at").all(collection, filter.runId)
			: this.db.prepare("SELECT data FROM docs WHERE collection = ? ORDER BY updated_at").all(collection);
		return (rows as Array<{ data: string }>).map((r) => JSON.parse(r.data) as Documents[K]);
	}

	listBoardPosts(runId: string, board?: string, cites?: string): BoardPost[] {
		const where = ["collection = 'posts'", "run_id = ?"];
		const params: string[] = [runId];
		if (board) {
			where.push(`coalesce(json_extract(data, '$.board'), '${DEFAULT_BOARD}') = ?`);
			params.push(board);
		}
		if (cites !== undefined) {
			where.push("EXISTS (SELECT 1 FROM json_each(docs.data, '$.references') AS ref WHERE json_extract(ref.value, '$.postId') = ?)");
			params.push(cites);
		}
		const rows = this.db.prepare(`SELECT data FROM docs WHERE ${where.join(" AND ")} ORDER BY updated_at`).all(...params) as Array<{ data: string }>;
		return rows.map((r) => JSON.parse(r.data) as BoardPost);
	}

	private withWriteTransaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// Ignore rollback error if transaction already closed.
			}
			throw error;
		}
	}

	claimTaskLease(runId: string, taskId: string, agentId: string, ttlMs: number, now = Date.now()): LeaseClaimResult {
		return this.withWriteTransaction(() => {
			const outcome = transitionClaimTask(this.get("tasks", taskId), runId, taskId, agentId, ttlMs, now);
			if (outcome.claimed) this.put("tasks", outcome.task);
			return outcome;
		});
	}

	renewTaskLease(taskId: string, agentId: string, fencingToken: number, ttlMs: number, now = Date.now()): boolean {
		return this.withWriteTransaction(() => {
			const next = transitionRenewTask(this.get("tasks", taskId), agentId, fencingToken, ttlMs, now);
			if (!next) return false;
			this.put("tasks", next);
			return true;
		});
	}

	releaseTaskLease(
		taskId: string,
		agentId: string,
		fencingToken: number,
		nextStatus: Exclude<TaskStatus, "claimed">,
		update: { result?: string; artifactIds?: string[]; findingId?: string } = {},
		now = Date.now(),
	): boolean {
		return this.withWriteTransaction(() => {
			const next = transitionReleaseTask(this.get("tasks", taskId), agentId, fencingToken, nextStatus, update, now);
			if (!next) return false;
			this.put("tasks", next);
			return true;
		});
	}

	lastSeq(runId: string): number {
		const row = this.db.prepare("SELECT MAX(seq) AS seq FROM events WHERE run_id = ?").get(runId) as { seq: number | null };
		return Number(row.seq ?? 0);
	}

	close(): void {
		this.db.close();
	}
}
