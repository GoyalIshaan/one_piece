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

function readOptional(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function processIsAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function evalRounds(dataDir: string, store: SqliteStore) {
	const root = join(dataDir, "evals");
	if (!existsSync(root)) return [];
	const lockPid = Number(readOptional(join(dataDir, "eval.lock")));
	const activePid = processIsAlive(lockPid) ? lockPid : undefined;
	let runs: Run[] | undefined;
	return readdirSync(root)
		.filter((id) => existsSync(join(root, id, "round.json")) || existsSync(join(root, id, "results.json")))
		.sort().reverse().slice(0, 50)
		.map((id) => {
			const dir = join(root, id);
			const manifest = JSON.parse(readOptional(join(dir, "round.json")) ?? "null") as { pid: number; tasks: { id: string; title: string }[] } | null;
			const raw = JSON.parse(readOptional(join(dir, "results.json")) ?? "[]") as Array<Record<string, any>>;
			const results = raw.map((r) => ({
				task: { id: r.task.id, title: r.task.title, category: r.task.category, inspiredBy: r.task.inspiredBy },
				runId: r.runId,
				status: r.status,
				score: r.score,
				best: r.best ? { title: r.best.title, details: r.best.grade.details } : null,
				graded: r.graded.map((g: any) => ({ title: g.title, score: g.grade.score })),
				health: r.health,
				stats: r.stats,
			}));
			const tasks = manifest?.tasks ?? results.map((r) => r.task);
			const status = !manifest || existsSync(join(dir, "report.md")) ? "complete" : manifest.pid === activePid ? "running" : "interrupted";
			let current;
			if (status !== "complete" && results.length < tasks.length) {
				runs ??= store.list<Run>("runs");
				const run = runs.findLast((r) => r.config.evalRound === id && !results.some((result) => result.runId === r.id));
				if (run) {
					const latest = store.events(run.id, { afterSeq: store.lastSeq(run.id) - 1, limit: 1 })[0];
					current = { taskId: run.config.eval, runId: run.id, status: run.status, lastActivity: latest?.ts ?? run.createdAt };
				}
			}
			return { id, status, tasks, current, results };
		});
}

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
	const reviewerTokens: Array<[number, number]> = [];
	const accepted: Array<[number, number]> = [];
	const active: Array<[number, number]> = [];
	const running = new Set<string>();
	const activity: Record<string, number> = {};
	const stages: Array<{ t: number; label: string }> = [];
	const modelUsage = { input: 0, output: 0, other: 0 };
	let total = 0;
	let reviews = 0;
	let acc = 0;
	for (const e of events) {
		if (e.nodeId && !NOISE.has(e.type)) activity[e.nodeId] = e.ts;
		if (e.type === "model.call") {
			const spent = Number(e.data.totalTokens ?? 0);
			const input = Number(e.data.input ?? 0);
			const output = Number(e.data.output ?? 0);
			modelUsage.input += input;
			modelUsage.output += output;
			modelUsage.other += Math.max(0, spent - input - output);
			total += spent;
			if (String(e.data.role).endsWith("_reviewer")) reviews += spent;
			tokens.push([e.ts, total]);
			reviewerTokens.push([e.ts, reviews]);
		} else if (e.type === "finding.verdict" && e.data.verdict === "accepted") {
			acc += 1;
			accepted.push([e.ts, acc]);
		} else if (e.type === "node.status" && e.nodeId) {
			const before = running.size;
			if (e.data.status === "running") running.add(e.nodeId);
			else running.delete(e.nodeId);
			if (running.size !== before) active.push([e.ts, running.size]);
		} else if (e.type === "epoch.started") {
			stages.push({ t: e.ts, label: `Epoch ${String(e.data.number)}` });
		} else if (e.type === "budget.report_reserve") {
			stages.push({ t: e.ts, label: "Report reserve" });
		}
	}
	const thin = <T>(arr: T[], max: number) => (arr.length <= max ? arr : arr.filter((_, i) => i % Math.ceil(arr.length / max) === 0 || i === arr.length - 1));
	return { tokens: thin(tokens, 400), reviewerTokens: thin(reviewerTokens, 400), accepted, active: thin(active, 600), activity, stages, modelUsage, lastEventAt: events.at(-1)?.ts };
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
				return json(res, 200, evalRounds(dirname(options.dbPath), store));
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
