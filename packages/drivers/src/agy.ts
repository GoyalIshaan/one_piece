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
			...(this.config.cleanWorkerEnv !== false ? ["--include-default-customizations=false", "--disable-telemetry"] : []),
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
		type AgySessionState =
			| { readonly kind: "idle" }
			| { readonly kind: "running"; readonly chunks: string[] }
			| { readonly kind: "closed" };
		let sessionState: AgySessionState = { kind: "idle" };
		const resetToIdle = (): void => {
			if (sessionState.kind !== "closed") sessionState = { kind: "idle" };
		};
		const mcpServer = (spec.mcp?.serverName ?? "swarm").toLowerCase();
		const mcpPrefix = `${mcpServer}__`;
		const isMcpToolName = (name: string) => {
			const lower = name.toLowerCase();
			if (lower.includes(`mcp_${mcpServer}_`) || lower.includes(mcpPrefix)) return true;
			if (spec.mcp?.toolNames?.some((t) => name === t || name.endsWith(`_${t}`) || name.endsWith(`__${t}`))) return true;
			return false;
		};

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

		const normalizeTool = (update: any): { name: string; isMcp: boolean; fallbackArgs?: string } => {
			const rawTitle = String(update?.title ?? update?.toolCallId ?? "tool").trim();
			const isMcp = isMcpToolName(rawTitle);
			if (isMcp) return { name: rawTitle, isMcp: true };
			const kind = String(update?.kind ?? "").toLowerCase();
			if (
				kind === "execute" ||
				rawTitle.includes("\n") ||
				rawTitle.includes("&&") ||
				rawTitle.includes("|") ||
				/^(python3?|bash|sh|zsh|git|ls|find|mkdir|rm|cp|mv|cat|pwd|which|sysctl|clang\+\+|gcc|g\+\+|rustc|cargo|node|npm|npx|pytest|[A-Z_]+=)\b/.test(rawTitle)
			) {
				return { name: "bash", isMcp: false, fallbackArgs: rawTitle.slice(0, 240) };
			}
			if (rawTitle.startsWith("File ")) {
				return { name: kind === "edit" ? "edit_file" : "read_file", isMcp: false, fallbackArgs: rawTitle.slice(0, 240) };
			}
			return { name: rawTitle.slice(0, 64), isMcp: false };
		};

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
					if (sessionState.kind === "running") sessionState.chunks.push(update.content.text);
					spec.onActivity?.({ type: "text", delta: update.content.text });
				} else if (update?.sessionUpdate === "tool_call") {
					const norm = normalizeTool(update);
					const argsRaw = update.rawInput ?? update.arguments ?? update.input;
					const argsPreview = argsRaw !== undefined
						? (typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw)).slice(0, 240)
						: norm.fallbackArgs;
					spec.onActivity?.({ type: "tool_call", name: norm.name, argsPreview, isMcp: norm.isMcp });
				} else if (update?.sessionUpdate === "tool_call_update" && (update.status === "completed" || update.status === "failed")) {
					const norm = normalizeTool(update);
					const outRaw = update.rawOutput ?? update.content;
					const outputPreview = outRaw !== undefined
						? (typeof outRaw === "string" ? outRaw : JSON.stringify(outRaw)).slice(0, 500)
						: undefined;
					spec.onActivity?.({
						type: "tool_result",
						name: norm.name,
						isError: update.status === "failed",
						outputPreview,
						isMcp: norm.isMcp,
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
				if (sessionState.kind === "closed") {
					throw new Error("AgyAcpDriver session is closed");
				}
				if (sessionState.kind === "running") {
					throw new Error("AgyAcpDriver session already has an active turn in flight");
				}
				const startedAt = Date.now();
				const chunks: string[] = [];
				sessionState = { kind: "running", chunks };
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
						finalText: chunks.join("").trim(),
						sessionId: acpSessionId,
						model: resolvedModel,
						usage,
					};
				} catch (error) {
					const raw = `${error instanceof Error ? error.message : String(error)}\n${stderr}`.trim();
					const quota = classifyQuotaError(raw);
					const usage = { durationMs: Date.now() - startedAt };
					if (quota) {
						return { status: "rate_limited", finalText: chunks.join("").trim(), sessionId: acpSessionId, model: resolvedModel, usage, quotaError: quota, error: raw };
					}
					if (opts.signal?.aborted) {
						return { status: "interrupted", finalText: chunks.join("").trim(), sessionId: acpSessionId, model: resolvedModel, usage };
					}
					return { status: "failed", finalText: chunks.join("").trim(), sessionId: acpSessionId, model: resolvedModel, usage, error: raw };
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
