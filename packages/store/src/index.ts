import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Collection, EventQuery, HarnessEvent, Store } from "@one-piece/core";

/**
 * SQLite store (Node's built-in driver). One append-only event log plus one table of current
 * documents. WAL mode lets the dashboard read while the harness writes.
 */
export class SqliteStore implements Store {
	private readonly db: DatabaseSync;
	private readonly insertEvent;
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
				data TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS events_run ON events (run_id, seq);
			CREATE TABLE IF NOT EXISTS docs (
				collection TEXT NOT NULL,
				id TEXT NOT NULL,
				run_id TEXT,
				data TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (collection, id)
			);
			CREATE INDEX IF NOT EXISTS docs_run ON docs (collection, run_id);
		`);
		this.insertEvent = this.db.prepare("INSERT INTO events (ts, run_id, type, node_id, data) VALUES (?, ?, ?, ?, ?)");
		this.upsertDoc = this.db.prepare(
			"INSERT INTO docs (collection, id, run_id, data, updated_at) VALUES (?, ?, ?, ?, ?) " +
				"ON CONFLICT (collection, id) DO UPDATE SET run_id = excluded.run_id, data = excluded.data, updated_at = excluded.updated_at",
		);
		this.selectDoc = this.db.prepare("SELECT data FROM docs WHERE collection = ? AND id = ?");
	}

	appendEvent(event: Omit<HarnessEvent, "seq">): number {
		const result = this.insertEvent.run(event.ts, event.runId, event.type, event.nodeId ?? null, JSON.stringify(event.data));
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
		const rows = this.db.prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq${limit}`).all(...params) as any[];
		return rows.map((r) => ({
			seq: Number(r.seq),
			ts: Number(r.ts),
			runId: r.run_id,
			type: r.type,
			nodeId: r.node_id ?? undefined,
			data: JSON.parse(r.data),
		}));
	}

	put<T extends { id: string }>(collection: Collection, doc: T): void {
		const runId = (doc as { runId?: string }).runId ?? null;
		this.upsertDoc.run(collection, doc.id, runId, JSON.stringify(doc), Date.now());
	}

	get<T>(collection: Collection, id: string): T | undefined {
		const row = this.selectDoc.get(collection, id) as { data: string } | undefined;
		return row ? (JSON.parse(row.data) as T) : undefined;
	}

	list<T>(collection: Collection, filter: { runId?: string } = {}): T[] {
		const rows = filter.runId
			? this.db.prepare("SELECT data FROM docs WHERE collection = ? AND run_id = ? ORDER BY updated_at").all(collection, filter.runId)
			: this.db.prepare("SELECT data FROM docs WHERE collection = ? ORDER BY updated_at").all(collection);
		return (rows as Array<{ data: string }>).map((r) => JSON.parse(r.data) as T);
	}

	/** Highest event sequence number for a run (for live tails). */
	lastSeq(runId: string): number {
		const row = this.db.prepare("SELECT MAX(seq) AS seq FROM events WHERE run_id = ?").get(runId) as { seq: number | null };
		return Number(row.seq ?? 0);
	}

	close(): void {
		this.db.close();
	}
}
