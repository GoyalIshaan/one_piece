import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	newId,
	type RunControlCommandRecord,
	type RunControlPayload,
	type Store,
} from "@one-piece/core";

const HTML_PATH = fileURLToPath(new URL("../web/index.html", import.meta.url));

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-store",
	});
	res.end(payload);
}

function readJsonBody(req: IncomingMessage, maxBytes = 65_536): Promise<unknown> {
	return new Promise((resolveBody, rejectBody) => {
		const chunks: Buffer[] = [];
		let total = 0;
		req.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (total > maxBytes) {
				rejectBody(new Error("Request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				const raw = Buffer.concat(chunks).toString("utf8").trim();
				resolveBody(raw ? JSON.parse(raw) : {});
			} catch (err) {
				rejectBody(err);
			}
		});
		req.on("error", rejectBody);
	});
}

function validateControlPayload(raw: unknown): RunControlPayload | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	switch (obj.type) {
		case "pause":
			return { type: "pause", ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}) };
		case "resume":
			return { type: "resume", ...(typeof obj.steeringNote === "string" ? { steeringNote: obj.steeringNote } : {}) };
		case "steer": {
			if (typeof obj.message !== "string" || !obj.message.trim()) return undefined;
			const scope = obj.scope === "next_wave" || obj.scope === "live_workers" || obj.scope === "both" ? obj.scope : undefined;
			return {
				type: "steer",
				message: obj.message.trim(),
				...(typeof obj.targetAgentId === "string" ? { targetAgentId: obj.targetAgentId } : {}),
				...(scope ? { scope } : {}),
			};
		}
		case "update_bound": {
			if (!obj.override || typeof obj.override !== "object" || Array.isArray(obj.override)) return undefined;
			const ov = obj.override as Record<string, unknown>;
			return {
				type: "update_bound",
				override: {
					...(ov.hardCeiling === null || (typeof ov.hardCeiling === "number" && Number.isFinite(ov.hardCeiling))
						? { hardCeiling: ov.hardCeiling as number | null }
						: {}),
					...(ov.paradigmCeiling === null || (typeof ov.paradigmCeiling === "number" && Number.isFinite(ov.paradigmCeiling))
						? { paradigmCeiling: ov.paradigmCeiling as number | null }
						: {}),
					...(typeof ov.activeBottleneck === "string" ? { activeBottleneck: ov.activeBottleneck } : {}),
					...(typeof ov.markAssumptionBroken === "string" ? { markAssumptionBroken: ov.markAssumptionBroken } : {}),
				},
				...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
			};
		}
		case "coalesce":
			return { type: "coalesce", ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}) };
		default:
			return undefined;
	}
}

export interface DashboardHandle {
	url: string;
	port: number;
	close(): Promise<void>;
}

/**
 * Lightweight local-only (127.0.0.1) v4 telemetry & control-plane dashboard.
 * Reads normalized SQLite WAL collections directly and accepts external control commands.
 */
export async function startDashboard(
	store: Store,
	opts: { port?: number; evalObservatoryDir?: string } = {},
): Promise<DashboardHandle> {
	const obsDir = resolve(opts.evalObservatoryDir ?? join(process.cwd(), ".one_piece", "eval-lab", "observatory"));
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");

		if (url.pathname === "/" || url.pathname === "/index.html") {
			const html = readFileSync(HTML_PATH, "utf8");
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			res.end(html);
			return;
		}

		if (url.pathname === "/evals" || url.pathname === "/evals/") {
			const obsHtml = join(obsDir, "observatory.html");
			if (!existsSync(obsHtml)) {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(`<html><body style="background:#0b0e14;color:#e6edf3;font-family:sans-serif;padding:24px"><h2>Eval Observatory not generated yet</h2><p>Run <code>npm run eval:observatory</code> to backfill your ledger and build plots.</p></body></html>`);
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			res.end(readFileSync(obsHtml, "utf8"));
			return;
		}

		if (url.pathname === "/api/evals/trajectory") {
			const trajJson = join(obsDir, "trajectory.json");
			if (!existsSync(trajJson)) {
				sendJson(res, 404, { error: "Trajectory report not generated yet. Run `npm run eval:observatory`." });
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			res.end(readFileSync(trajJson, "utf8"));
			return;
		}

		if (url.pathname === "/api/runs") {
			const runs = store.list("runs").sort((a, b) => b.createdAt - a.createdAt);
			sendJson(res, 200, { runs });
			return;
		}

		const controlMatch = /^\/api\/runs\/([^/]+)\/control$/.exec(url.pathname);
		if (controlMatch && req.method === "POST") {
			const runId = decodeURIComponent(controlMatch[1]!);
			const run = store.get("runs", runId);
			if (!run) {
				sendJson(res, 404, { error: "Run not found" });
				return;
			}
			void readJsonBody(req)
				.then((raw) => {
					const payload = validateControlPayload(raw);
					if (!payload) {
						sendJson(res, 400, { error: "Invalid RunControlPayload" });
						return;
					}
					const record: RunControlCommandRecord = {
						id: newId("ctl"),
						runId,
						issuedBy: "dashboard",
						createdAt: Date.now(),
						payload,
					};
					store.put("control_commands", record);
					sendJson(res, 202, { commandId: record.id, runId, type: payload.type });
				})
				.catch((err) => {
					sendJson(res, 400, { error: err instanceof Error ? err.message : "Bad JSON body" });
				});
			return;
		}

		const briefsMatch = /^\/api\/runs\/([^/]+)\/briefs$/.exec(url.pathname);
		if (briefsMatch && req.method === "GET") {
			const runId = decodeURIComponent(briefsMatch[1]!);
			const run = store.get("runs", runId);
			if (!run) {
				sendJson(res, 404, { error: "Run not found" });
				return;
			}
			const runDir = typeof run.config.runDir === "string" ? run.config.runDir : undefined;
			const briefsDir = runDir ? join(runDir, "checkpoints") : undefined;
			if (!briefsDir || !existsSync(briefsDir)) {
				sendJson(res, 200, { runId, briefs: [] });
				return;
			}
			const files = readdirSync(briefsDir).filter((f) => f.endsWith(".md")).sort();
			const briefs = files.map((name) => ({
				name,
				path: join(briefsDir, name),
				markdown: readFileSync(join(briefsDir, name), "utf8"),
			}));
			sendJson(res, 200, { runId, briefs });
			return;
		}

		const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
		if (runMatch) {
			const runId = decodeURIComponent(runMatch[1]!);
			const run = store.get("runs", runId);
			if (!run) {
				sendJson(res, 404, { error: "Run not found" });
				return;
			}
			const controlCommands = store
				.list("control_commands", { runId })
				.sort((a, b) => b.createdAt - a.createdAt)
				.slice(0, 20);
			const boundEvents = store.events(runId, { types: ["bound.estimated"] });
			const latestBound = boundEvents.at(-1)?.data ?? null;
			const controlEvents = store.events(runId, { types: ["run.control_applied"] });
			const controlState = controlEvents.at(-1)?.data.nextState ?? "running";
			sendJson(res, 200, {
				run,
				controlState,
				controlCommands,
				latestBound,
				agents: store.list("agents", { runId }),
				tasks: store.list("tasks", { runId }),
				posts: store.list("posts", { runId }),
				findings: store.list("findings", { runId }),
				jobs: store.list("jobs", { runId }),
				quotas: store.list("quotas", { runId }),
				reports: store.list("reports", { runId }),
			});
			return;
		}

		const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
		if (eventsMatch) {
			const runId = decodeURIComponent(eventsMatch[1]!);
			const afterSeq = Number(url.searchParams.get("afterSeq") ?? 0) || 0;
			const limit = Number(url.searchParams.get("limit") ?? 200) || 200;
			const events = store.events(runId, { afterSeq, limit });
			sendJson(res, 200, { events });
			return;
		}

		const sseMatch = /^\/api\/runs\/([^/]+)\/stream$/.exec(url.pathname);
		if (sseMatch) {
			const runId = decodeURIComponent(sseMatch[1]!);
			let cursor = Number(url.searchParams.get("afterSeq") ?? 0) || 0;
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			const flush = () => {
				const batch = store.events(runId, { afterSeq: cursor, limit: 100 });
				for (const ev of batch) {
					cursor = ev.seq;
					res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
				}
			};
			flush();
			const timer = setInterval(flush, 500);
			req.on("close", () => clearInterval(timer));
			return;
		}

		sendJson(res, 404, { error: "Not found" });
	});

	const port = opts.port ?? 4747;
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
	const actualPort = (server.address() as AddressInfo).port;
	return {
		port: actualPort,
		url: `http://127.0.0.1:${actualPort}`,
		close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
	};
}
