import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventBus, McpToolRegistry, McpWorkerRegistration, Role, ToolDefinition } from "@one-piece/core";
import { canonicalizeSchema } from "./progressive.ts";

const PROTOCOL_VERSION = "2025-03-26";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const STDIO_BRIDGE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "mcp-stdio-bridge.mjs");

interface RegisteredWorker {
	runId: string;
	agentId: string;
	role: Role;
	workspace?: string;
	tools: Map<string, ToolDefinition>;
	abort: AbortController;
}

interface JsonRpcRequest {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

function readJsonBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		req.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (total > MAX_BODY_BYTES) {
				reject(new Error("Request body exceeds 2 MiB limit"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

const READ_ONLY_TOOLS = new Set([
	"board_search",
	"board_visit",
	"read_artifact",
	"list_pools",
	"job_status",
	"read_file",
	"list_files",
	"grep_files",
	"load_skill",
]);

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": String(Buffer.byteLength(payload)),
		"Cache-Control": "no-store",
		...extraHeaders,
	});
	res.end(payload);
}

function rpcResult(id: string | number | null, result: unknown) {
	return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Embedded zero-dependency local Streamable HTTP MCP server (`127.0.0.1:0`).
 * Every CLI worker (Codex, Grok, Gemini) connects here with a per-worker bearer token
 * so the Swarm OS mechanically enforces role-filtered tool menus and authenticates actor IDs.
 */
export class McpBusServer implements McpToolRegistry {
	private readonly server: Server;
	private readonly bus: EventBus;
	private readonly workersByToken = new Map<string, RegisteredWorker>();
	private readonly tokenByAgent = new Map<string, string>();
	private _url = "";

	private constructor(bus: EventBus) {
		this.bus = bus;
		this.server = createServer((req, res) => {
			void this.handleHttp(req, res);
		});
	}

	static async start(bus: EventBus, port = 0): Promise<McpBusServer> {
		const instance = new McpBusServer(bus);
		await new Promise<void>((resolve, reject) => {
			instance.server.once("error", reject);
			instance.server.listen(port, "127.0.0.1", () => {
				instance.server.off("error", reject);
				const addr = instance.server.address() as AddressInfo;
				instance._url = `http://127.0.0.1:${addr.port}/mcp`;
				resolve();
			});
		});
		return instance;
	}

	get url(): string {
		return this._url;
	}

	registerWorker(spec: {
		runId: string;
		agentId: string;
		role: Role;
		workspace?: string;
		tools: ToolDefinition[];
	}): McpWorkerRegistration {
		const existingToken = this.tokenByAgent.get(spec.agentId);
		if (existingToken) {
			this.workersByToken.get(existingToken)?.abort.abort();
			this.workersByToken.delete(existingToken);
		}
		const token = randomBytes(24).toString("hex");
		this.bus.redactor.addSecret(token);

		const toolMap = new Map<string, ToolDefinition>();
		for (const tool of spec.tools) toolMap.set(tool.name, tool);

		const entry: RegisteredWorker = {
			runId: spec.runId,
			agentId: spec.agentId,
			role: spec.role,
			workspace: spec.workspace,
			tools: toolMap,
			abort: new AbortController(),
		};
		this.workersByToken.set(token, entry);
		this.tokenByAgent.set(spec.agentId, token);

		return {
			token,
			connection: {
				url: this._url,
				token,
				serverName: "swarm",
				toolNames: [...toolMap.keys()],
				stdioBridgePath: STDIO_BRIDGE_PATH,
			},
			unregister: () => {
				entry.abort.abort();
				this.workersByToken.delete(token);
				if (this.tokenByAgent.get(spec.agentId) === token) {
					this.tokenByAgent.delete(spec.agentId);
				}
			},
		};
	}

	toolsFor(agentId: string): ToolDefinition[] {
		const token = this.tokenByAgent.get(agentId);
		if (!token) return [];
		const worker = this.workersByToken.get(token);
		return worker ? [...worker.tools.values()] : [];
	}

	async close(): Promise<void> {
		for (const worker of this.workersByToken.values()) worker.abort.abort();
		this.workersByToken.clear();
		this.tokenByAgent.clear();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private extractToken(req: IncomingMessage): string | undefined {
		const auth = req.headers.authorization;
		if (typeof auth === "string" && auth.startsWith("Bearer ")) {
			return auth.slice("Bearer ".length).trim();
		}
		const headerToken = req.headers["x-one-piece-token"];
		if (typeof headerToken === "string" && headerToken.trim()) return headerToken.trim();
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const queryToken = url.searchParams.get("token");
		return queryToken?.trim() || undefined;
	}

	private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");

		if (req.method === "GET" && url.pathname === "/health") {
			sendJson(res, 200, { ok: true, server: "one-piece-swarm", protocolVersion: PROTOCOL_VERSION });
			return;
		}

		if (url.pathname !== "/mcp") {
			sendJson(res, 404, { error: "Not found" });
			return;
		}

		const token = this.extractToken(req);
		const worker = token ? this.workersByToken.get(token) : undefined;
		if (!worker) {
			sendJson(res, 401, rpcError(null, -32001, "Unauthorized worker token"));
			return;
		}

		if (req.method === "DELETE") {
			res.writeHead(204);
			res.end();
			return;
		}

		if (req.method === "GET") {
			// Streamable HTTP allows GET SSE probe; return 405 cleanly when server push SSE isn't needed.
			res.writeHead(405, { Allow: "POST, DELETE" });
			res.end();
			return;
		}

		if (req.method !== "POST") {
			res.writeHead(405, { Allow: "POST, DELETE" });
			res.end();
			return;
		}

		let raw: string;
		try {
			raw = await readJsonBody(req);
		} catch (error) {
			sendJson(res, 400, rpcError(null, -32700, error instanceof Error ? error.message : String(error)));
			return;
		}

		let parsed: JsonRpcRequest | JsonRpcRequest[];
		try {
			parsed = JSON.parse(raw) as JsonRpcRequest | JsonRpcRequest[];
		} catch {
			sendJson(res, 400, rpcError(null, -32700, "Invalid JSON"));
			return;
		}

		if (Array.isArray(parsed)) {
			const responses = (await Promise.all(parsed.map((item) => this.handleRpc(worker, item)))).filter((r) => r !== undefined);
			if (!responses.length) {
				res.writeHead(202);
				res.end();
				return;
			}
			sendJson(res, 200, responses);
			return;
		}

		const response = await this.handleRpc(worker, parsed);
		if (response === undefined) {
			res.writeHead(202, { "Mcp-Session-Id": worker.agentId });
			res.end();
			return;
		}
		sendJson(res, 200, response, { "Mcp-Session-Id": worker.agentId });
	}

	private async handleRpc(worker: RegisteredWorker, req: JsonRpcRequest): Promise<unknown | undefined> {
		const id = req.id ?? null;
		const isNotification = req.id === undefined;

		switch (req.method) {
			case "initialize": {
				const requestedVersion = typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : PROTOCOL_VERSION;
				return rpcResult(id, {
					protocolVersion: requestedVersion,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "one-piece-swarm", version: "0.2.0" },
				});
			}

			case "notifications/initialized":
			case "notifications/cancelled":
				return isNotification ? undefined : rpcResult(id, {});

			case "ping":
				return rpcResult(id, {});

			case "tools/list": {
				const tools = [...worker.tools.values()]
					.sort((a, b) => a.name.localeCompare(b.name))
					.map((t) => ({
						name: t.name,
						description: t.description,
						inputSchema: canonicalizeSchema(t.inputSchema),
						annotations: {
							readOnlyHint: READ_ONLY_TOOLS.has(t.name),
							destructiveHint: false,
							openWorldHint: false,
						},
					}));
				return rpcResult(id, { tools });
			}

			case "tools/call": {
				const params = req.params ?? {};
				const name = typeof params.name === "string" ? params.name : "";
				const args = params.arguments && typeof params.arguments === "object"
					? (params.arguments as Record<string, unknown>)
					: {};
				const tool = worker.tools.get(name);
				if (!tool) {
					return rpcResult(id, {
						content: [{ type: "text", text: `Tool "${name}" is not allowed for role "${worker.role}"` }],
						isError: true,
					});
				}
				this.bus.emit(worker.runId, "mcp.tool_call", { tool: name, role: worker.role, args }, worker.agentId);
				const startedAt = Date.now();
				try {
					const out = await tool.execute(args, {
						runId: worker.runId,
						agentId: worker.agentId,
						role: worker.role,
						workspace: worker.workspace,
						signal: worker.abort.signal,
					});
					const cleanText = this.bus.redactor.redactText(out.text);
					const durationMs = Date.now() - startedAt;
					this.bus.emit(
						worker.runId,
						"mcp.tool_result",
						{
							tool: name,
							isError: Boolean(out.isError),
							bytes: Buffer.byteLength(cleanText),
							durationMs,
							outputPreview: cleanText.slice(0, 500),
						},
						worker.agentId,
					);
					return rpcResult(id, {
						content: [{ type: "text", text: cleanText }],
						isError: Boolean(out.isError),
					});
				} catch (error) {
					const message = this.bus.redactor.redactText(error instanceof Error ? error.message : String(error));
					const durationMs = Date.now() - startedAt;
					this.bus.emit(
						worker.runId,
						"mcp.tool_result",
						{ tool: name, isError: true, durationMs, error: message, outputPreview: message.slice(0, 500) },
						worker.agentId,
					);
					return rpcResult(id, {
						content: [{ type: "text", text: `Error executing ${name}: ${message}` }],
						isError: true,
					});
				}
			}

			default:
				if (isNotification) return undefined;
				return rpcError(id, -32601, `Method not found: ${String(req.method)}`);
		}
	}
}
