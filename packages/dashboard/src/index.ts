import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { Store } from "@one-piece/core";

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

export interface DashboardHandle {
	url: string;
	port: number;
	close(): Promise<void>;
}

/**
 * Lightweight local-only (127.0.0.1) v2 telemetry dashboard.
 * Reads normalized SQLite WAL collections directly with zero dual tree/peer branching.
 */
export async function startDashboard(store: Store, opts: { port?: number } = {}): Promise<DashboardHandle> {
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");

		if (url.pathname === "/" || url.pathname === "/index.html") {
			const html = readFileSync(HTML_PATH, "utf8");
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			res.end(html);
			return;
		}

		if (url.pathname === "/api/runs") {
			const runs = store.list("runs").sort((a, b) => b.createdAt - a.createdAt);
			sendJson(res, 200, { runs });
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
			sendJson(res, 200, {
				run,
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
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const actualPort = (server.address() as AddressInfo).port;
	return {
		port: actualPort,
		url: `http://127.0.0.1:${actualPort}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
