import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import { prepareCleanGrokHome } from "./cli-home.ts";

function writeGrokMcpConfig(spec: WorkerSpawnSpec): void {
	if (!spec.mcp) return;
	const dir = join(spec.workspace, ".grok");
	mkdirSync(dir, { recursive: true });
	const toml = [
		`[mcp_servers.${spec.mcp.serverName}]`,
		`url = ${JSON.stringify(spec.mcp.url)}`,
		`enabled = true`,
		``,
		`[mcp_servers.${spec.mcp.serverName}.headers]`,
		`Authorization = ${JSON.stringify(`Bearer ${spec.mcp.token}`)}`,
		``,
	].join("\n");
	writeFileSync(join(dir, "config.toml"), toml, "utf8");
}

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
 * Official xAI Grok Build CLI driver (`grok 0.2.87+`).
 * Disables competing built-in machinery (`--no-subagents --no-plan --no-memory`)
 * so Grok operates as a crisp, bounded leaf worker wired to one_piece's MCP bus.
 */
export class GrokCliDriver implements WorkerDriver {
	readonly id: string;
	readonly kind = "grok-cli" as const;
	readonly capabilities: DriverCapabilities = {
		supportsSteer: false,
		supportsResume: true,
		supportsOutputSchema: true,
		supportsMcpHttp: true,
	};
	private readonly config: DriverConfig;

	constructor(config: DriverConfig) {
		this.id = config.id;
		this.config = config;
	}

	async healthCheck(): Promise<DriverHealth> {
		const base = await probeCliBinary(this.id, this.kind, this.config.binary ?? "grok");
		if (!base.ok) return base;
		const hasAuth = existsSync(join(homedir(), ".grok", "auth.json")) ||
			(this.config.subscriptionMode === false && Boolean(process.env.XAI_API_KEY || process.env.GROK_CODE_XAI_API_KEY));
		if (!hasAuth) {
			return { ...base, ok: false, detail: "Not logged in — run 'grok login'" };
		}
		const verMatch = /(\d+)\.(\d+)\.(\d+)/.exec(base.version ?? "");
		if (verMatch && Number(verMatch[1]) === 0) {
			return { ...base, ok: false, detail: `Outdated Grok CLI (${verMatch[0]} < 1.0.13) — run 'grok update'` };
		}
		return { ...base, detail: "auth: ~/.grok/auth.json" };
	}

	async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
		writeGrokMcpConfig(spec);
		const binary = this.config.binary ?? "grok";
		const extraEnv: Record<string, string> = {};
		if (this.config.cleanWorkerEnv !== false && !process.env.GROK_HOME) {
			extraEnv.GROK_HOME = prepareCleanGrokHome();
		}
		const env = this.config.subscriptionMode === false
			? buildCliEnv([], extraEnv)
			: buildCliEnv(["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"], extraEnv);
		let currentSessionId = spec.resumeSessionId;
		let activeChild: ChildProcess | undefined;
		const driverId = this.id;
		const config = this.config;

		return {
			driverId,
			get sessionId() {
				return currentSessionId;
			},
			async runTurn(prompt: string, opts = {}): Promise<WorkerTurnResult> {
				const startedAt = Date.now();
				const model = spec.model ?? config.model;
				const args = [
					"-p", prompt,
					"--cwd", spec.workspace,
					"--no-subagents",
					"--no-plan",
					"--no-memory",
					...(spec.readOnly ? ["--permission-mode", "plan"] : ["--always-approve"]),
					...(opts.outputSchema
						? ["--json-schema", JSON.stringify(opts.outputSchema)]
						: ["--output-format", "streaming-json"]),
					...(model ? ["-m", model] : []),
					...(spec.maxTurns ? ["--max-turns", String(spec.maxTurns)] : []),
					...(spec.systemPrompt ? ["--rules", spec.systemPrompt] : []),
					...(currentSessionId ? ["-r", currentSessionId] : []),
					...(config.extraArgs ?? []),
				];

				return new Promise<WorkerTurnResult>((resolve) => {
					const child = spawn(binary, args, {
						cwd: spec.workspace,
						env,
						stdio: ["ignore", "pipe", "pipe"],
						detached: true,
					});
					activeChild = child;

					const textChunks: string[] = [];
					let stderr = "";
					let rawNonJson = "";
					let streamError = "";
					let resolvedModel: string | undefined = model;
					let usage: WorkerTurnResult["usage"] = { durationMs: 0 };
					let timer: ReturnType<typeof setTimeout> | undefined;

					const onAbort = () => killTree(child);
					opts.signal?.addEventListener("abort", onAbort, { once: true });
					if (opts.timeoutMs) timer = setTimeout(onAbort, opts.timeoutMs);

					const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
					rl.on("line", (line) => {
						const trimmed = line.trim();
						if (!trimmed) return;
						let ev: any;
						try {
							ev = JSON.parse(trimmed);
						} catch {
							rawNonJson += `${trimmed}\n`;
							return;
						}
						if (typeof ev.model === "string" && ev.model) resolvedModel = ev.model;
						if (!resolvedModel && ev.modelUsage && typeof ev.modelUsage === "object") {
							const firstModel = Object.keys(ev.modelUsage as Record<string, unknown>)[0];
							if (firstModel) resolvedModel = firstModel;
						}
						const sid = typeof ev.sessionId === "string" ? ev.sessionId : typeof ev.session_id === "string" ? ev.session_id : undefined;
						if (sid) {
							currentSessionId = sid;
							spec.onActivity?.({ type: "session", sessionId: sid, model: resolvedModel });
						}
						if (ev.type === "assistant" || ev.type === "message" || ev.type === "text") {
							const text = extractText(ev);
							if (text) {
								textChunks.push(text);
								spec.onActivity?.({ type: "text", delta: text });
							}
						} else if (ev.type === "tool_use" || ev.type === "tool_call") {
							const toolName = String(ev.name ?? ev.tool ?? ev.toolName ?? "tool");
							const isMcp = Boolean(spec.mcp?.toolNames?.includes(toolName)) || toolName.startsWith(`${spec.mcp?.serverName ?? "swarm"}__`);
							const argsRaw = ev.input ?? ev.arguments ?? ev.args;
							const argsPreview = argsRaw !== undefined
								? (typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw)).slice(0, 240)
								: undefined;
							spec.onActivity?.({ type: "tool_call", name: toolName, argsPreview, isMcp });
						} else if (ev.type === "tool_result") {
							const toolName = String(ev.name ?? ev.tool ?? ev.toolName ?? "tool");
							const isMcp = Boolean(spec.mcp?.toolNames?.includes(toolName)) || toolName.startsWith(`${spec.mcp?.serverName ?? "swarm"}__`);
							const outRaw = ev.content ?? ev.output ?? ev.result ?? ev.error;
							const outputPreview = outRaw !== undefined
								? (typeof outRaw === "string" ? outRaw : JSON.stringify(outRaw)).slice(0, 500)
								: undefined;
							spec.onActivity?.({ type: "tool_result", name: toolName, isError: Boolean(ev.is_error ?? ev.isError), outputPreview, isMcp });
						} else if (ev.type === "result" || ev.type === "end" || ev.type === "usage") {
							const resText = extractText(ev);
							if (resText && !textChunks.length) textChunks.push(resText);
							if (ev.is_error || ev.error) streamError += `${String(ev.error ?? resText)}\n`;
							if (ev.usage) {
								usage = {
									inputTokens: Number(ev.usage.input_tokens ?? ev.usage.prompt_tokens ?? 0) || undefined,
									cachedTokens: Number(ev.usage.cached_tokens ?? ev.usage.cache_read_input_tokens ?? 0) || undefined,
									cacheWriteTokens: Number(ev.usage.cache_creation_input_tokens ?? 0) || undefined,
									outputTokens: Number(ev.usage.output_tokens ?? ev.usage.completion_tokens ?? 0) || undefined,
									reasoningTokens: Number(ev.usage.reasoning_tokens ?? 0) || undefined,
									totalTokens: Number(ev.usage.total_tokens ?? 0) || undefined,
									usd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined,
									durationMs: Date.now() - startedAt,
								};
							}
						} else if (ev.type === "error") {
							streamError += `${String(ev.error?.message ?? ev.message ?? ev.data ?? JSON.stringify(ev))}\n`;
						} else if (opts.outputSchema && ev && typeof ev === "object" && !ev.type) {
							// `--json-schema` emits raw JSON object in `--output-format json` mode.
							textChunks.push(trimmed);
						}
					});

					child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
						stderr += chunk;
					});

					child.on("close", (code) => {
						activeChild = undefined;
						rl.close();
						if (timer) clearTimeout(timer);
						opts.signal?.removeEventListener("abort", onAbort);

						const durationMs = Date.now() - startedAt;
						usage = { ...usage, durationMs };
						const combinedErr = [streamError, stderr, rawNonJson].filter(Boolean).join("\n").trim();
						const finalText = textChunks.join("").trim() || (code === 0 ? rawNonJson.trim() : "");

						if (opts.signal?.aborted) {
							resolve({ status: "interrupted", finalText, sessionId: currentSessionId, model: resolvedModel, usage });
							return;
						}
						const quota = code !== 0 || streamError ? classifyQuotaError(combinedErr) : undefined;
						if (quota) {
							resolve({ status: "rate_limited", finalText, sessionId: currentSessionId, model: resolvedModel, usage, quotaError: quota, error: combinedErr });
							return;
						}
						if (code !== 0 || streamError) {
							resolve({ status: "failed", finalText, sessionId: currentSessionId, model: resolvedModel, usage, error: combinedErr || `grok exited ${code}` });
							return;
						}
						resolve({ status: "completed", finalText, sessionId: currentSessionId, model: resolvedModel, usage });
					});
				});
			},
			async interrupt(): Promise<void> {
				if (activeChild) killTree(activeChild);
			},
			async close(): Promise<void> {
				if (activeChild) killTree(activeChild);
			},
		};
	}
}

function extractText(ev: any): string {
	if (typeof ev.data === "string") return ev.data;
	if (typeof ev.text === "string") return ev.text;
	if (typeof ev.content === "string") return ev.content;
	if (typeof ev.result === "string") return ev.result;
	if (typeof ev.delta === "string") return ev.delta;
	if (Array.isArray(ev.message?.content)) {
		return ev.message.content
			.filter((b: any) => b?.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text)
			.join("");
	}
	return "";
}

/**
 * Official xAI Grok Build ACP JSON-RPC 2.0 driver (`grok agent stdio`, Grok 1.0+).
 * Injects one_piece's local HTTP MCP bus directly in `session/new` (avoiding folder-trust
 * blocks on fresh git worktrees) and disables competing subagent/memory machinery via
 * `GROK_SUBAGENTS=0` / `GROK_MEMORY=0`.
 */
export class GrokAcpDriver implements WorkerDriver {
	readonly id: string;
	readonly kind = "grok-acp" as const;
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
		const base = await probeCliBinary(this.id, this.kind, this.config.binary ?? "grok");
		if (!base.ok) return base;
		const hasAuth = existsSync(join(homedir(), ".grok", "auth.json")) ||
			(this.config.subscriptionMode === false && Boolean(process.env.XAI_API_KEY || process.env.GROK_CODE_XAI_API_KEY));
		if (!hasAuth) {
			return { ...base, ok: false, detail: "Not logged in — run 'grok login'" };
		}
		const verMatch = /(\d+)\.(\d+)\.(\d+)/.exec(base.version ?? "");
		if (verMatch && Number(verMatch[1]) === 0) {
			return { ...base, ok: false, detail: `Outdated Grok CLI (${verMatch[0]} < 1.0.13) — run 'grok update'` };
		}
		return { ...base, detail: "auth: ~/.grok/auth.json (ACP)" };
	}

	async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
		const binary = this.config.binary ?? "grok";
		const extraEnv: Record<string, string> = { GROK_SUBAGENTS: "0", GROK_MEMORY: "0" };
		if (this.config.cleanWorkerEnv !== false && !process.env.GROK_HOME) {
			extraEnv.GROK_HOME = prepareCleanGrokHome();
		}
		const env = this.config.subscriptionMode === false
			? buildCliEnv([], extraEnv)
			: buildCliEnv(["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"], extraEnv);
		const model = spec.model ?? this.config.model;
		const args = [
			"agent",
			"--no-leader",
			...(spec.readOnly ? [] : ["--always-approve"]),
			...(model ? ["-m", model] : []),
			...(this.config.extraArgs ?? []),
			"stdio",
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
		let resolvedModel: string | undefined = model;
		type GrokAcpSessionState =
			| { readonly kind: "idle" }
			| { readonly kind: "running"; readonly chunks: string[]; usage?: WorkerTurnResult["usage"] }
			| { readonly kind: "closed" };
		let sessionState: GrokAcpSessionState = { kind: "idle" };
		const resetToIdle = (): void => {
			if (sessionState.kind !== "closed") sessionState = { kind: "idle" };
		};
		const mcpPrefix = `${spec.mcp?.serverName ?? "swarm"}__`;
		const isMcpToolName = (name: string) =>
			Boolean(spec.mcp?.toolNames?.includes(name)) ||
			name.startsWith(mcpPrefix) ||
			(name.includes("__") && Boolean(spec.mcp?.toolNames?.includes(name.slice(name.indexOf("__") + 2))));

		const sendRpc = (method: string, params: Record<string, unknown>): Promise<any> =>
			new Promise((resolve, reject) => {
				if (!child.stdin || child.killed) {
					reject(new Error("grok agent stdio stdin closed"));
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
			if (msg.method === "_x.ai/session_notification") {
				const u = msg.params?.update;
				if (u?.sessionUpdate === "model_changed" && typeof u.model_id === "string") {
					resolvedModel = u.model_id;
				} else if (u?.sessionUpdate === "turn_completed" && u.usage) {
					const raw = u.usage;
					if (sessionState.kind === "running") {
						sessionState.usage = {
							inputTokens: Number(raw.inputTokens ?? raw.input_tokens ?? 0) || undefined,
							cachedTokens: Number(raw.cachedReadTokens ?? raw.cache_read_input_tokens ?? 0) || undefined,
							cacheWriteTokens: Number(raw.cacheCreationTokens ?? raw.cache_creation_input_tokens ?? 0) || undefined,
							outputTokens: Number(raw.outputTokens ?? raw.output_tokens ?? 0) || undefined,
							reasoningTokens: Number(raw.reasoningTokens ?? raw.reasoning_tokens ?? 0) || undefined,
							totalTokens: Number(raw.totalTokens ?? raw.total_tokens ?? 0) || undefined,
							durationMs: 0,
						};
					}
				}
				return;
			}
			if (msg.method === "session/update") {
				const update = msg.params?.update ?? msg.params;
				if (update?.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string") {
					if (sessionState.kind === "running") sessionState.chunks.push(update.content.text);
					spec.onActivity?.({ type: "text", delta: update.content.text });
				} else if (update?.sessionUpdate === "tool_call") {
					const rawName = update.rawInput?.tool_name ?? update.title ?? update.toolCallId ?? "tool";
					const toolName = String(rawName);
					const rawArgs = update.rawInput?.tool_input ?? update.rawInput;
					const argsPreview = rawArgs !== undefined
						? (typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs)).slice(0, 240)
						: undefined;
					spec.onActivity?.({ type: "tool_call", name: toolName, argsPreview, isMcp: isMcpToolName(toolName) });
				} else if (update?.sessionUpdate === "tool_call_update" && (update.status === "completed" || update.status === "failed")) {
					const toolName = String(update.rawOutput?.tool_name ?? update.title ?? update.toolCallId ?? "tool");
					const outRaw = update.rawOutput?.output?.OkayOutput ?? update.rawOutput ?? update.content;
					const outputPreview = outRaw !== undefined
						? (typeof outRaw === "string" ? outRaw : JSON.stringify(outRaw)).slice(0, 500)
						: undefined;
					spec.onActivity?.({
						type: "tool_result",
						name: toolName,
						isError: update.status === "failed",
						outputPreview,
						isMcp: update.rawOutput?.type === "MCP" || isMcpToolName(toolName),
					});
				}
			}
		});

		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});

		child.on("close", (code) => {
			const err = new Error(stderr.trim() || `grok agent stdio exited ${code ?? "null"}`);
			for (const waiter of pending.values()) waiter.reject(err);
			pending.clear();
		});

		try {
			await sendRpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
			const mcpServers = spec.mcp
				? [{ name: spec.mcp.serverName, type: "http", url: spec.mcp.url, headers: [{ name: "Authorization", value: `Bearer ${spec.mcp.token}` }] }]
				: [];

			let created: any;
			if (spec.resumeSessionId) {
				try {
					created = await sendRpc("session/load", { sessionId: spec.resumeSessionId, cwd: spec.workspace, mcpServers });
				} catch {
					created = await sendRpc("session/new", { cwd: spec.workspace, mcpServers });
				}
			} else {
				created = await sendRpc("session/new", { cwd: spec.workspace, mcpServers });
			}
			acpSessionId = String(created?.sessionId ?? acpSessionId ?? "");
			if (typeof created?.models?.currentModelId === "string" && created.models.currentModelId) {
				resolvedModel = created.models.currentModelId;
			}
			if (acpSessionId) spec.onActivity?.({ type: "session", sessionId: acpSessionId, model: resolvedModel });
			if (model && acpSessionId && model !== resolvedModel) {
				await sendRpc("session/set_model", { sessionId: acpSessionId, modelId: model }).catch(() => {});
			}
		} catch (error) {
			rl.close();
			killTree(child);
			throw error;
		}

		const driverId = this.id;
		let sentSystemPrompt = false;
		return {
			driverId,
			get sessionId() {
				return acpSessionId;
			},
			async runTurn(prompt: string, opts = {}): Promise<WorkerTurnResult> {
				if (sessionState.kind === "closed") {
					throw new Error("GrokAcpDriver session is closed");
				}
				if (sessionState.kind === "running") {
					throw new Error("GrokAcpDriver session already has an active turn in flight");
				}
				const startedAt = Date.now();
				const turn: Extract<GrokAcpSessionState, { kind: "running" }> = { kind: "running", chunks: [] };
				sessionState = turn;
				const text = spec.systemPrompt && !sentSystemPrompt ? `${spec.systemPrompt}\n\n${prompt}` : prompt;
				sentSystemPrompt = true;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const onAbort = () => {
					if (acpSessionId) void sendRpc("session/cancel", { sessionId: acpSessionId }).catch(() => {});
				};
				opts.signal?.addEventListener("abort", onAbort, { once: true });
				if (opts.timeoutMs) timer = setTimeout(onAbort, opts.timeoutMs);
				try {
					const res = await sendRpc("session/prompt", { sessionId: acpSessionId, prompt: [{ type: "text", text }] });
					const meta = res?._meta;
					if (typeof meta?.modelId === "string" && meta.modelId) resolvedModel = meta.modelId;
					const durationMs = Date.now() - startedAt;
					const usage: WorkerTurnResult["usage"] = turn.usage
						? { ...turn.usage, durationMs }
						: {
							inputTokens: Number(meta?.inputTokens ?? 0) || undefined,
							cachedTokens: Number(meta?.cachedReadTokens ?? 0) || undefined,
							outputTokens: Number(meta?.outputTokens ?? 0) || undefined,
							reasoningTokens: Number(meta?.reasoningTokens ?? 0) || undefined,
							totalTokens: Number(meta?.totalTokens ?? 0) || undefined,
							durationMs,
						};
					return {
						status: opts.signal?.aborted ? "interrupted" : "completed",
						finalText: turn.chunks.join("").trim(),
						sessionId: acpSessionId,
						model: resolvedModel,
						usage,
					};
				} catch (error) {
					const raw = `${error instanceof Error ? error.message : String(error)}\n${stderr}`.trim();
					const quota = classifyQuotaError(raw);
					const usage = { ...(turn.usage ?? {}), durationMs: Date.now() - startedAt };
					if (quota) {
						return { status: "rate_limited", finalText: turn.chunks.join("").trim(), sessionId: acpSessionId, model: resolvedModel, usage, quotaError: quota, error: raw };
					}
					if (opts.signal?.aborted) {
						return { status: "interrupted", finalText: turn.chunks.join("").trim(), sessionId: acpSessionId, model: resolvedModel, usage };
					}
					return { status: "failed", finalText: turn.chunks.join("").trim(), sessionId: acpSessionId, model: resolvedModel, usage, error: raw };
				} finally {
					if (timer) clearTimeout(timer);
					opts.signal?.removeEventListener("abort", onAbort);
					resetToIdle();
				}
			},
			async interrupt(): Promise<void> {
				if (sessionState.kind === "running" && acpSessionId) {
					await sendRpc("session/cancel", { sessionId: acpSessionId }).catch(() => {});
				}
			},
			async close(): Promise<void> {
				sessionState = { kind: "closed" };
				rl.close();
				killTree(child);
			},
		};
	}
}
