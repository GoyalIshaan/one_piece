import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BoardPost, Epoch, Finding, HarnessEvent, Job, Question, Recommendation, Report, Run, SwarmNode } from "@one-piece/core";
import { SqliteStore } from "@one-piece/store";

// The telemetry dashboard: everything the swarm does, read straight from the run's SQLite
// store. It runs in its own process (or beside the harness) and only ever writes one thing:
// the user's answers to escalated questions.

export interface DashboardOptions {
	dbPath: string;
	port?: number;
	/** Defaults to 127.0.0.1: telemetry contains everything, so it is not exposed by default. */
	host?: string;
}

const NOISE = new Set(["nodes.updated", "budget.charged"]);

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of req) {
		body += chunk;
		if (body.length > 100_000) throw new Error("body too large");
	}
	return body;
}

function series(events: HarnessEvent[]) {
	const tokens: Array<[number, number]> = [];
	const accepted: Array<[number, number]> = [];
	let total = 0;
	let acc = 0;
	for (const e of events) {
		if (e.type === "model.call") {
			total += Number(e.data.totalTokens ?? 0);
			tokens.push([e.ts, total]);
		} else if (e.type === "finding.verdict" && e.data.verdict === "accepted") {
			acc += 1;
			accepted.push([e.ts, acc]);
		}
	}
	const thin = <T>(arr: T[], max: number) => (arr.length <= max ? arr : arr.filter((_, i) => i % Math.ceil(arr.length / max) === 0 || i === arr.length - 1));
	return { tokens: thin(tokens, 400), accepted };
}

function roleStats(events: HarnessEvent[]) {
	const out: Record<string, { calls: number; tokens: number; usd: number }> = {};
	for (const e of events) {
		if (e.type !== "model.call") continue;
		const s = (out[String(e.data.role)] ??= { calls: 0, tokens: 0, usd: 0 });
		s.calls += 1;
		s.tokens += Number(e.data.totalTokens ?? 0);
		s.usd += Number(e.data.usd ?? 0);
	}
	return out;
}

function providerStats(events: HarnessEvent[]) {
	const out: Record<string, { calls: number; tokens: number; usd: number; waitedMs: number; errors: number; models: Record<string, number> }> = {};
	for (const e of events) {
		if (e.type !== "model.call") continue;
		const p = String(e.data.provider);
		const s = (out[p] ??= { calls: 0, tokens: 0, usd: 0, waitedMs: 0, errors: 0, models: {} });
		s.calls += 1;
		s.tokens += Number(e.data.totalTokens ?? 0);
		s.usd += Number(e.data.usd ?? 0);
		s.waitedMs += Number(e.data.waitedMs ?? 0);
		if (e.data.error) s.errors += 1;
		const model = String(e.data.model);
		s.models[model] = (s.models[model] ?? 0) + 1;
	}
	return out;
}

export function startDashboard(options: DashboardOptions): { server: Server; url: string; close(): void } {
	const store = new SqliteStore(options.dbPath);
	const pagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "index.html");
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 4747;

	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", `http://${host}`);
			const parts = url.pathname.split("/").filter(Boolean);
			if (req.method === "GET" && url.pathname === "/") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(readFileSync(pagePath, "utf8"));
				return;
			}
			if (parts[0] !== "api") return json(res, 404, { error: "not found" });
			if (req.method === "GET" && parts[1] === "evals") {
				// Eval rounds live next to the store: <dataDir>/evals/<stamp>/results.json
				const root = join(dirname(options.dbPath), "evals");
				const rounds = existsSync(root)
					? readdirSync(root)
							.filter((d) => existsSync(join(root, d, "results.json")))
							.sort()
							.reverse()
							.slice(0, 50)
							.map((d) => {
								const results = JSON.parse(readFileSync(join(root, d, "results.json"), "utf8")) as Array<Record<string, any>>;
								return {
									id: d,
									results: results.map((r) => ({
										task: { id: r.task.id, title: r.task.title, category: r.task.category, inspiredBy: r.task.inspiredBy },
										runId: r.runId,
										status: r.status,
										score: r.score,
										best: r.best ? { title: r.best.title, details: r.best.grade.details } : null,
										graded: r.graded.map((g: any) => ({ title: g.title, score: g.grade.score })),
										health: r.health,
										stats: r.stats,
									})),
								};
							})
					: [];
				return json(res, 200, rounds);
			}
			if (req.method === "GET" && parts[1] === "runs" && parts.length === 2) {
				return json(res, 200, store.list<Run>("runs").sort((a, b) => b.createdAt - a.createdAt));
			}
			if (req.method === "POST" && parts[1] === "questions" && parts[3] === "answer") {
				const q = store.get<Question>("questions", parts[2]);
				if (!q || q.holder !== "user") return json(res, 404, { error: "no such question waiting for you" });
				const { answer } = JSON.parse(await readBody(req)) as { answer?: string };
				if (!answer?.trim()) return json(res, 400, { error: "empty answer" });
				store.put("user_answers", { id: q.id, runId: q.runId, answer: answer.trim(), at: Date.now() });
				return json(res, 200, { ok: true });
			}
			const runId = parts[2];
			if (parts[1] !== "runs" || !runId) return json(res, 404, { error: "not found" });
			if (parts[3] === "state") {
				const all = store.events(runId);
				return json(res, 200, {
					run: store.get<Run>("runs", runId),
					nodes: store.list<SwarmNode>("nodes", { runId }),
					findings: store.list<Finding>("findings", { runId }),
					questions: store.list<Question>("questions", { runId }),
					recommendations: store.list<Recommendation>("recommendations", { runId }),
					posts: store.list<BoardPost>("posts", { runId }),
					assumptions: store.list("assumptions", { runId }),
					jobs: store.list<Job>("jobs", { runId }),
					epochs: store.list<Epoch>("epochs", { runId }),
					reports: store.list<Report>("reports", { runId }).map((r) => ({ ...r, markdown: undefined, size: r.markdown.length })),
					providers: providerStats(all),
					roles: roleStats(all),
					series: series(all),
					lastSeq: store.lastSeq(runId),
				});
			}
			if (parts[3] === "reports" && parts[4]) {
				const report = store.get<Report>("reports", parts[4]);
				return report && report.runId === runId ? json(res, 200, report) : json(res, 404, { error: "no report" });
			}
			if (parts[3] === "events") {
				const events = store
					.events(runId, {
						afterSeq: Number(url.searchParams.get("after") ?? 0),
						nodeId: url.searchParams.get("node") ?? undefined,
						types: url.searchParams.get("types")?.split(",") ?? undefined,
					})
					.filter((e) => !NOISE.has(e.type));
				const limit = Number(url.searchParams.get("limit") ?? 500);
				return json(res, 200, events.slice(-limit));
			}
			if (parts[3] === "stream") {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
				let after = Number(url.searchParams.get("after") ?? store.lastSeq(runId));
				const tick = setInterval(() => {
					const fresh = store.events(runId, { afterSeq: after, limit: 500 });
					if (!fresh.length) {
						res.write(": ping\n\n");
						return;
					}
					after = fresh.at(-1)!.seq;
					const visible = fresh.filter((e) => !NOISE.has(e.type));
					res.write(`data: ${JSON.stringify({ lastSeq: after, events: visible })}\n\n`);
				}, 1000);
				req.on("close", () => clearInterval(tick));
				return;
			}
			return json(res, 404, { error: "not found" });
		} catch (error) {
			json(res, 500, { error: String(error) });
		}
	});
	server.listen(port, host);
	return {
		server,
		url: `http://${host}:${port}`,
		close: () => {
			server.close();
			store.close();
		},
	};
}
