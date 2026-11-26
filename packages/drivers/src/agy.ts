import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
	DriverCapabilities,
	DriverConfig,
	DriverHealth,
	WorkerDriver,
	WorkerSession,
	WorkerSpawnSpec,
	WorkerTurnResult,
} from "@one-piece/core";
import { buildCliEnv, classifyQuotaError, probeCliBinary } from "./classify.ts";

function killTree(child: ChildProcess): void {
	try {
		if (child.pid) process.kill(-child.pid, "SIGKILL");
		else child.kill("SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already exited.
		}
	}
}

/**
 * Antigravity CLI (`agy`) native ACP JSON-RPC 2.0 driver.
 * Drives Gemini 4 Neon/Carbon/Argon/Hydrogen, Gemini 3.8 Flash, Claude 5.5, and GPT-OSS
 * over `agy acp --stdio` with zero workspace config files (MCP servers injected via `session/new`).
 */
export class AgyAcpDriver implements WorkerDriver {
	readonly id: string;
	readonly kind = "agy-acp" as const;
	readonly capabilities: DriverCapabilities = {
		supportsSteer: false,
		supportsResume: true,
		supportsOutputSchema: false,
		supportsMcpHttp: true,
	};
	private readonly config: DriverConfig;

	constructor(config: DriverConfig) {
		this.id = config.id;
		this.config = config;
	}

	async healthCheck(): Promise<DriverHealth> {
		const base = await probeCliBinary(this.id, this.kind, this.config.binary ?? "agy");
		if (!base.ok) return base;
		const agyDir = join(homedir(), ".gemini", "antigravity-cli");
		const hasState = existsSync(join(agyDir, "jetski_state.pbtxt")) || existsSync(join(homedir(), ".gemini", "antigravity"));
		if (!hasState) {
			return { ...base, ok: false, detail: "Not signed in — run 'agy acp --login' or 'agy'" };
		}
		return { ...base, detail: "auth: ~/.gemini/antigravity-cli" };
	}

	async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
		const binary = this.config.binary ?? "agy";
		const env = buildCliEnv([]);
		const args = [
			"acp",
			"--stdio",
			...(spec.readOnly ? [] : ["--dangerously-skip-permissions"]),
			...(this.config.extraArgs ?? []),
		];

		const child = spawn(binary, args, {
			cwd: spec.workspace,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});

		let nextId = 1;
		const pending = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
		let stderr = "";
		let acpSessionId: string | undefined = spec.resumeSessionId;
		let resolvedModel: string | undefined = spec.model ?? this.config.model;
		let turnChunks: string[] = [];
		const mcpPrefix = `${spec.mcp?.serverName ?? "swarm"}__`;
		const isMcpToolName = (name: string) =>
			Boolean(spec.mcp?.toolNames?.includes(name)) ||
			name.startsWith(mcpPrefix) ||
			(name.includes("__") && Boolean(spec.mcp?.toolNames?.includes(name.slice(name.indexOf("__") + 2))));

		const sendRpc = (method: string, params: Record<string, unknown>): Promise<any> =>
			new Promise((resolve, reject) => {
				if (!child.stdin || child.killed) {
					reject(new Error("agy acp stdin closed"));
					return;
				}
				const id = nextId++;
				pending.set(id, { resolve, reject });
				child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			});

		const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
		rl.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let msg: any;
			try {
				msg = JSON.parse(trimmed);
			} catch {
				stderr += `${trimmed}\n`;
				return;
			}
			if (msg.id !== undefined && msg.method === undefined) {
				const waiter = pending.get(Number(msg.id));
				if (waiter) {
					pending.delete(Number(msg.id));
					if (msg.error) waiter.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
					else waiter.resolve(msg.result);
				}
				return;
			}
			if (msg.id !== undefined && msg.method === "session/request_permission") {
				const allowOpt = (msg.params?.options ?? []).find((o: any) => o.kind === "allow_once" || o.kind === "allow_always");
				const outcome = spec.readOnly ? { outcome: "cancelled" } : { outcome: "selected", optionId: allowOpt?.optionId ?? "allow" };
				child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome } })}\n`);
				return;
			}
			if (msg.method === "session/update") {
				const update = msg.params?.update ?? msg.params;
				if (update?.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string") {
					turnChunks.push(update.content.text);
					spec.onActivity?.({ type: "text", delta: update.content.text });
				} else if (update?.sessionUpdate === "tool_call") {
					const toolName = String(update.title ?? update.toolCallId ?? "tool");
					const argsRaw = update.rawInput ?? update.arguments ?? update.input;
					const argsPreview = argsRaw !== undefined
						? (typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw)).slice(0, 240)
						: undefined;
					spec.onActivity?.({ type: "tool_call", name: toolName, argsPreview, isMcp: isMcpToolName(toolName) });
				} else if (update?.sessionUpdate === "tool_call_update" && (update.status === "completed" || update.status === "failed")) {
					const toolName = String(update.title ?? update.toolCallId ?? "tool");
					const outRaw = update.rawOutput ?? update.content;
					const outputPreview = outRaw !== undefined
						? (typeof outRaw === "string" ? outRaw : JSON.stringify(outRaw)).slice(0, 500)
						: undefined;
					spec.onActivity?.({
						type: "tool_result",
						name: toolName,
						isError: update.status === "failed",
						outputPreview,
						isMcp: isMcpToolName(toolName),
					});
				}
			}
		});

		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});

		child.on("close", (code) => {
			const err = new Error(stderr.trim() || `agy acp exited ${code ?? "null"}`);
			for (const waiter of pending.values()) waiter.reject(err);
			pending.clear();
		});

		try {
			await sendRpc("initialize", { protocolVersion: 1, clientCapabilities: {} });

			const mcpServers = spec.mcp
				? [{ name: spec.mcp.serverName, type: "http", url: spec.mcp.url, headers: [{ name: "Authorization", value: `Bearer ${spec.mcp.token}` }] }]
				: [];
			const sessionMeta = spec.systemPrompt ? { _meta: { antigravity: { systemPrompt: { append: spec.systemPrompt } } } } : {};
			let created: any;
			if (spec.resumeSessionId) {
				try {
					created = await sendRpc("session/load", { sessionId: spec.resumeSessionId, cwd: spec.workspace, mcpServers });
				} catch {
					created = await sendRpc("session/new", { cwd: spec.workspace, mcpServers, ...sessionMeta });
				}
			} else {
				created = await sendRpc("session/new", { cwd: spec.workspace, mcpServers, ...sessionMeta });
			}
			acpSessionId = String(created?.sessionId ?? acpSessionId ?? "");
			const defaultModel = created?.models?.currentModelId ?? created?.models?.availableModels?.[0]?.modelId;
			if (!resolvedModel && typeof defaultModel === "string" && defaultModel) {
				resolvedModel = defaultModel;
			}
			if (acpSessionId) spec.onActivity?.({ type: "session", sessionId: acpSessionId, model: resolvedModel });

			const model = spec.model ?? this.config.model;
			if (model && acpSessionId) {
				await sendRpc("session/set_model", { sessionId: acpSessionId, modelId: model }).catch(() => {});
				resolvedModel = model;
			}
		} catch (error) {
			rl.close();
			killTree(child);
			throw error;
		}

		const driverId = this.id;
		let sentSystemFallback = Boolean(spec.systemPrompt);
		return {
			driverId,
			get sessionId() {
				return acpSessionId;
			},
			async runTurn(prompt: string, opts = {}): Promise<WorkerTurnResult> {
				const startedAt = Date.now();
				turnChunks = [];
				const text = spec.systemPrompt && !sentSystemFallback ? `${spec.systemPrompt}\n\n${prompt}` : prompt;
				sentSystemFallback = true;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const onAbort = () => {
					if (acpSessionId) void sendRpc("session/cancel", { sessionId: acpSessionId }).catch(() => {});
				};
				opts.signal?.addEventListener("abort", onAbort, { once: true });
				if (opts.timeoutMs) timer = setTimeout(onAbort, opts.timeoutMs);
				try {
					const res = await sendRpc("session/prompt", { sessionId: acpSessionId, prompt: [{ type: "text", text }] });
					const rawUsage = res?.usage;
					const durationMs = Date.now() - startedAt;
					const usage: WorkerTurnResult["usage"] = rawUsage
						? {
							inputTokens: Number(rawUsage.inputTokens ?? rawUsage.input_tokens ?? 0) || undefined,
							cachedTokens: Number(rawUsage.cachedReadTokens ?? rawUsage.cache_read_input_tokens ?? 0) || undefined,
							cacheWriteTokens: Number(rawUsage.cachedWriteTokens ?? rawUsage.cache_creation_input_tokens ?? 0) || undefined,
							outputTokens: Number(rawUsage.outputTokens ?? rawUsage.output_tokens ?? 0) || undefined,
							reasoningTokens: Number(rawUsage.thoughtTokens ?? rawUsage.reasoningTokens ?? 0) || undefined,
							totalTokens: Number(rawUsage.totalTokens ?? rawUsage.total_tokens ?? 0) || undefined,
							durationMs,
						}
						: { durationMs };
					return {
						status: opts.signal?.aborted ? "interrupted" : "completed",
						finalText: turnChunks.join("").trim(),
						sessionId: acpSessionId,
						model: resolvedModel,
						usage,
					};
				} catch (error) {
					const raw = `${error instanceof Error ? error.message : String(error)}\n${stderr}`.trim();
					const quota = classifyQuotaError(raw);
					return {
						status: quota ? "rate_limited" : opts.signal?.aborted ? "interrupted" : "failed",
						finalText: turnChunks.join("").trim(),
						sessionId: acpSessionId,
						model: resolvedModel,
						usage: { durationMs: Date.now() - startedAt },
						quotaError: quota,
						error: raw,
					};
				} finally {
					if (timer) clearTimeout(timer);
					opts.signal?.removeEventListener("abort", onAbort);
				}
			},
			async interrupt(): Promise<void> {
				if (acpSessionId) await sendRpc("session/cancel", { sessionId: acpSessionId }).catch(() => {});
			},
			async close(): Promise<void> {
				rl.close();
				killTree(child);
			},
		};
	}
}
