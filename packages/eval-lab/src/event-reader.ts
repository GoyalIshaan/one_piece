import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { AgentRoleCategory, CanonicalEvent } from "./contracts.ts";

export interface ReadRunEventsResult {
	events: CanonicalEvent[];
	recordedLedgerTokens?: number;
	driverIds: string[];
	modelIds: string[];
}

function classifyRole(rawRole: unknown): AgentRoleCategory {
	const value = String(rawRole ?? "").toLowerCase();
	if (value.includes("review") || value.includes("eval") || value.includes("verifier")) return "reviewer";
	if (value.includes("refinery") || value.includes("merge") || value.includes("integrat")) return "refinery";
	if (value === "root" || value === "internal" || value.includes("coord") || value.includes("manager") || value.includes("plan")) {
		return "coordinator";
	}
	return "worker";
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return rows.some((row) => row.name === column);
}

function tableExists(db: DatabaseSync, table: string): boolean {
	const row = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(table) as { name?: string } | undefined;
	return Boolean(row?.name);
}

/**
 * Engine-agnostic reader for v1 and v2 `one_piece` SQLite WAL stores.
 * Normalizes event schemas into `CanonicalEvent[]` and computes agent-role mappings
 * plus optional ledger-recorded spend for conservation checks.
 */
export function readRunEvents(dbPath: string, runId: string, maxSeq?: number): ReadRunEventsResult {
	if (!existsSync(dbPath)) {
		return { events: [], driverIds: [], modelIds: [] };
	}
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		if (!tableExists(db, "events")) {
			return { events: [], driverIds: [], modelIds: [] };
		}
		const hasCausal = hasColumn(db, "events", "causal_parents");
		const hasIdem = hasColumn(db, "events", "idempotency_key");
		const selectCols = [
			"seq",
			"ts",
			"run_id",
			"type",
			"node_id",
			hasCausal ? "causal_parents" : "NULL AS causal_parents",
			hasIdem ? "idempotency_key" : "NULL AS idempotency_key",
			"data",
		].join(", ");

		const sql =
			maxSeq !== undefined
				? `SELECT ${selectCols} FROM events WHERE run_id = ? AND seq <= ? ORDER BY seq`
				: `SELECT ${selectCols} FROM events WHERE run_id = ? ORDER BY seq`;
		const rawRows = (
			maxSeq !== undefined ? db.prepare(sql).all(runId, maxSeq) : db.prepare(sql).all(runId)
		) as Array<Record<string, unknown>>;

		const roleByAgent = new Map<string, AgentRoleCategory>();
		const driverSet = new Set<string>();
		const modelSet = new Set<string>();
		let recordedLedgerTokens: number | undefined;

		if (tableExists(db, "docs")) {
			for (const collection of ["nodes", "agents"]) {
				const docRows = db
					.prepare("SELECT data FROM docs WHERE collection = ? AND run_id = ?")
					.all(collection, runId) as Array<{ data: string }>;
				if (!docRows.length) continue;
				let ledgerSum = 0;
				let sawSpend = false;
				for (const row of docRows) {
					const doc = JSON.parse(row.data) as Record<string, unknown>;
					const id = typeof doc.id === "string" ? doc.id : undefined;
					if (id) roleByAgent.set(id, classifyRole(doc.role));
					if (typeof doc.driver === "string" && doc.driver) driverSet.add(doc.driver);
					if (typeof doc.driverId === "string" && doc.driverId) driverSet.add(doc.driverId);
					if (typeof doc.model === "string" && doc.model) {
						modelSet.add(doc.model);
					} else {
						const model = doc.model as { provider?: string; id?: string } | undefined;
						if (model?.provider && model?.id) modelSet.add(`${model.provider}/${model.id}`);
					}
					const spent = doc.spent as { tokens?: number } | undefined;
					if (spent && typeof spent.tokens === "number") {
						ledgerSum += spent.tokens;
						sawSpend = true;
					}
				}
				if (sawSpend) recordedLedgerTokens = (recordedLedgerTokens ?? 0) + ledgerSum;
			}
		}

		const events: CanonicalEvent[] = rawRows.map((r) => {
			const data = JSON.parse(String(r.data ?? "{}")) as Record<string, unknown>;
			const agentId = typeof r.node_id === "string" ? r.node_id : undefined;
			const type = String(r.type);
			if ((type === "node.spawned" || type === "agent.spawned") && agentId) {
				roleByAgent.set(agentId, classifyRole(data.role));
			}
			if (type === "model.call") {
				const provider = typeof data.provider === "string" ? data.provider : undefined;
				const model = typeof data.model === "string" ? data.model : undefined;
				if (provider && model) modelSet.add(`${provider}/${model}`);
				if (typeof data.driver === "string" && data.driver) driverSet.add(data.driver);
			} else if (type === "agent.turn" || type === "budget.charged" || type === "agent.spawned") {
				if (typeof data.driverId === "string" && data.driverId) driverSet.add(data.driverId);
				if (typeof data.model === "string" && data.model) modelSet.add(data.model);
			}
			const role =
				data.role !== undefined
					? classifyRole(data.role)
					: agentId
						? roleByAgent.get(agentId)
						: undefined;
			return {
				seq: Number(r.seq),
				ts: Number(r.ts),
				runId: String(r.run_id),
				type,
				agentId,
				role,
				causalParents:
					typeof r.causal_parents === "string"
						? (JSON.parse(r.causal_parents) as string[])
						: undefined,
				idempotencyKey: typeof r.idempotency_key === "string" ? r.idempotency_key : undefined,
				data,
			};
		});

		return {
			events,
			recordedLedgerTokens,
			driverIds: [...driverSet].sort(),
			modelIds: [...modelSet].sort(),
		};
	} finally {
		db.close();
	}
}

/**
 * Create a lightweight SQLite WAL store conforming to v2's `events` + `docs` schema.
 * Used by `MockHarnessAdapter` and `forkTrace` without importing `@one-piece/store`.
 */
export function openEvalTraceDb(dbPath: string): DatabaseSync {
	const db = new DatabaseSync(dbPath);
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
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
	return db;
}
