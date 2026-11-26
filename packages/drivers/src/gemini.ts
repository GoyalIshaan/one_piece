import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
	type DriverCapabilities,
	type DriverConfig,
	type DriverHealth,
	seatbeltReadDenyCommand,
	type WorkerDriver,
	type WorkerSession,
	type WorkerSpawnSpec,
	type WorkerTurnResult,
} from "@one-piece/core";
import { buildCliEnv, classifyQuotaError, probeCliBinary } from "./classify.ts";
import { bindTurnCancellation, killProcessTreeNow } from "./supervisor.ts";

function writeGeminiMcpConfig(spec: WorkerSpawnSpec): void {
	if (!spec.mcp) return;
	const dir = join(spec.workspace, ".gemini");
	mkdirSync(dir, { recursive: true });
	const settings = {
		mcpServers: {
			[spec.mcp.serverName]: {
				httpUrl: spec.mcp.url,
				headers: {
					Authorization: `Bearer ${spec.mcp.token}`,
				},
			},
		},
	};
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
}

/**
 * Google Gemini CLI driver (`gemini 0.70.0+`).
 * Supports both:
 * - `kind: "gemini-cli"` (headless `-p ... -o stream-json --resume <session_id>`)
 * - `kind: "gemini-acp"` (persistent native ACP JSON-RPC 2.0 over `gemini --acp`)
 */
export class GeminiCliDriver implements WorkerDriver {
	readonly id: string;
	readonly kind: "gemini-cli" | "gemini-acp";
	readonly capabilities: DriverCapabilities = {
		supportsSteer: false,
		supportsResume: true,
		supportsOutputSchema: false,
		supportsMcpHttp: true,
	};
	private readonly config: DriverConfig;

	constructor(config: DriverConfig) {
		this.id = config.id;
		this.kind = config.kind === "gemini-acp" ? "gemini-acp" : "gemini-cli";
		this.config = config;
	}

	async healthCheck(): Promise<DriverHealth> {
		const base = await probeCliBinary(this.id, this.kind, this.config.binary ?? "gemini");
		if (!base.ok) return base;
		const gemDir = join(homedir(), ".gemini");
		const hasSettings = existsSync(join(gemDir, "settings.json")) || existsSync(join(gemDir, "oauth_creds.json"));
		const hasEnvAuth = Boolean(
			process.env.GOOGLE_GENAI_USE_GCA ||
			process.env.GOOGLE_GENAI_USE_VERTEXAI ||
			(this.config.subscriptionMode === false && (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)),
		);
		if (!hasSettings && !hasEnvAuth) {
			return { ...base, ok: false, detail: "Not authenticated — run 'gemini' once to sign in with Google OAuth" };
		}
		return { ...base, detail: hasSettings ? "auth: ~/.gemini" : "auth: env" };
	}

	async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
		writeGeminiMcpConfig(spec);
		if (this.kind === "gemini-acp") return this.spawnAcp(spec);
		return this.spawnHeadless(spec);
	}

	private async spawnHeadless(spec: WorkerSpawnSpec): Promise<WorkerSession> {
		const binary = this.config.binary ?? "gemini";
		const env = this.config.subscriptionMode === false
			? buildCliEnv([])
			: buildCliEnv(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
		let currentSessionId = spec.resumeSessionId;
		type HeadlessState =
			| { readonly kind: "idle" }
			| { readonly kind: "running"; readonly child: ChildProcess }
			| { readonly kind: "closed" };
		let sessionState: HeadlessState = { kind: "idle" };
		const resetToIdle = (): void => {
			if (sessionState.kind !== "closed") sessionState = { kind: "idle" };
		};
		const driverId = this.id;
		const config = this.config;

		return {
			driverId,
			get sessionId() {
				return currentSessionId;
			},
			async runTurn(prompt: string, opts = {}): Promise<WorkerTurnResult> {
				if (sessionState.kind === "closed") {
					throw new Error("GeminiCliDriver session is closed");
				}
				if (sessionState.kind === "running") {
					throw new Error("GeminiCliDriver session already has an active turn in flight");
				}
				const startedAt = Date.now();
				const fullPrompt = spec.systemPrompt && !currentSessionId
					? `${spec.systemPrompt}\n\n${prompt}`
					: prompt;
				const model = spec.model ?? config.model;
				const args = [
					"-p", fullPrompt,
					"-o", "stream-json",
					"--skip-trust",
					"--approval-mode", spec.readOnly ? "plan" : "yolo",
					...(spec.mcp ? ["--allowed-mcp-server-names", spec.mcp.serverName] : []),
					...(model ? ["-m", model] : []),
					...(currentSessionId ? ["-r", currentSessionId] : []),
					...(config.extraArgs ?? []),
				];

				return new Promise<WorkerTurnResult>((resolve) => {
					const [spawnBin, ...spawnArgs] = seatbeltReadDenyCommand([binary, ...args], spec.deniedReadPaths ?? []);
					const child = spawn(spawnBin!, spawnArgs, {
						cwd: spec.workspace,
						env,
						stdio: ["ignore", "pipe", "pipe"],
						detached: true,
					});
					sessionState = { kind: "running", child };

					const textChunks: string[] = [];
					let stderr = "";
					let rawNonJson = "";
					let streamError = "";
					let resolvedModel: string | undefined = model;
					let usage: WorkerTurnResult["usage"] = { durationMs: 0 };
					const cancel = bindTurnCancellation(child, { signal: opts.signal, timeoutMs: opts.timeoutMs });

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
						if (ev.type === "init" && typeof ev.session_id === "string") {
							currentSessionId = ev.session_id;
							spec.onActivity?.({ type: "session", sessionId: ev.session_id, model: resolvedModel });
						} else if (ev.type === "message" && ev.role === "assistant" && typeof ev.content === "string") {
							textChunks.push(ev.content);
							spec.onActivity?.({ type: "text", delta: ev.content });
						} else if (ev.type === "tool_use") {
							const toolName = String(ev.tool_name ?? ev.name ?? "tool");
							const isMcp = Boolean(spec.mcp?.toolNames?.includes(toolName)) || toolName.startsWith(`${spec.mcp?.serverName ?? "swarm"}__`);
							const argsRaw = ev.parameters ?? ev.args ?? ev.input;
							const argsPreview = argsRaw !== undefined
								? (typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw)).slice(0, 240)
								: undefined;
							spec.onActivity?.({ type: "tool_call", name: toolName, argsPreview, isMcp });
						} else if (ev.type === "tool_result") {
							const toolName = String(ev.tool_name ?? ev.name ?? "tool");
							const isMcp = Boolean(spec.mcp?.toolNames?.includes(toolName)) || toolName.startsWith(`${spec.mcp?.serverName ?? "swarm"}__`);
							const outRaw = ev.output ?? ev.result ?? ev.error;
							const outputPreview = outRaw !== undefined
								? (typeof outRaw === "string" ? outRaw : JSON.stringify(outRaw)).slice(0, 500)
								: undefined;
							spec.onActivity?.({ type: "tool_result", name: toolName, isError: ev.status === "error", outputPreview, isMcp });
						} else if (ev.type === "error") {
							streamError += `${String(ev.message ?? ev.error ?? JSON.stringify(ev))}\n`;
						} else if (ev.type === "result") {
							if (ev.status && ev.status !== "success") {
								streamError += `${String(ev.error?.message ?? ev.message ?? ev.status)}\n`;
							}
							const stats = ev.stats;
							if (stats) {
								if (typeof stats.model === "string" && stats.model) resolvedModel = stats.model;
								usage = {
									inputTokens: Number(stats.input_tokens ?? stats.input ?? 0) || undefined,
									cachedTokens: Number(stats.cached ?? stats.cached_tokens ?? 0) || undefined,
									outputTokens: Number(stats.output_tokens ?? stats.output ?? 0) || undefined,
									reasoningTokens: Number(stats.thought_tokens ?? stats.reasoning_tokens ?? 0) || undefined,
									totalTokens: Number(stats.total_tokens ?? 0) || undefined,
									durationMs: Date.now() - startedAt,
								};
							}
						}
					});

					child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
						stderr += chunk;
					});

					child.on("close", (code) => {
						resetToIdle();
						rl.close();
						cancel.dispose();

						const durationMs = Date.now() - startedAt;
						usage = { ...usage, durationMs };
						const combinedErr = [streamError, stderr, rawNonJson].filter(Boolean).join("\n").trim();
						const finalText = textChunks.join("").trim();

						if (opts.signal?.aborted || cancel.wasCancelled()) {
							resolve({ status: "interrupted", finalText, sessionId: currentSessionId, model: resolvedModel, usage });
							return;
						}
						const quota = code !== 0 || streamError ? classifyQuotaError(combinedErr) : undefined;
						if (quota) {
							resolve({ status: "rate_limited", finalText, sessionId: currentSessionId, model: resolvedModel, usage, quotaError: quota, error: combinedErr });
							return;
						}
						if (code !== 0 || streamError) {
							resolve({ status: "failed", finalText, sessionId: currentSessionId, model: resolvedModel, usage, error: combinedErr || `gemini exited ${code}` });
							return;
						}
						resolve({ status: "completed", finalText, sessionId: currentSessionId, model: resolvedModel, usage });
					});
				});
			},
			async interrupt(): Promise<void> {
				if (sessionState.kind === "running") killProcessTreeNow(sessionState.child);
			},
			async close(): Promise<void> {
				const prev = sessionState;
				sessionState = { kind: "closed" };
				if (prev.kind === "running") killProcessTreeNow(prev.child);
			},
		};
	}

	private async spawnAcp(spec: WorkerSpawnSpec): Promise<WorkerSession> {
		const binary = this.config.binary ?? "gemini";
		const env = this.config.subscriptionMode === false
			? buildCliEnv([])
			: buildCliEnv(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
		const model = spec.model ?? this.config.model;
		const args = [
			"--acp",
			"--skip-trust",
			"--approval-mode", spec.readOnly ? "plan" : "yolo",
			...(spec.mcp ? ["--allowed-mcp-server-names", spec.mcp.serverName] : []),
			...(model ? ["-m", model] : []),
			...(this.config.extraArgs ?? []),
		];

		const [spawnBin, ...spawnArgs] = seatbeltReadDenyCommand([binary, ...args], spec.deniedReadPaths ?? []);
		const child = spawn(spawnBin!, spawnArgs, {
			cwd: spec.workspace,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});

		let nextId = 1;
		const pending = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
		let stderr = "";
		let acpSessionId: string | undefined = spec.resumeSessionId;
		type GeminiAcpState =
			| { readonly kind: "idle" }
			| { readonly kind: "running"; readonly chunks: string[] }
			| { readonly kind: "closed" };
		let sessionState: GeminiAcpState = { kind: "idle" };
		const resetToIdle = (): void => {
			if (sessionState.kind !== "closed") sessionState = { kind: "idle" };
		};

		const sendRpc = (method: string, params: Record<string, unknown>): Promise<any> =>
			new Promise((resolve, reject) => {
				if (!child.stdin || child.killed) {
					reject(new Error("gemini --acp stdin closed"));
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
					if (sessionState.kind === "running") sessionState.chunks.push(update.content.text);
					spec.onActivity?.({ type: "text", delta: update.content.text });
				} else if (update?.sessionUpdate === "tool_call") {
					spec.onActivity?.({ type: "tool_call", name: String(update.title ?? update.toolCallId ?? "tool") });
				}
			}
		});
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("close", (code) => {
			const err = new Error(stderr.trim() || `gemini --acp exited ${code ?? "null"}`);
			for (const waiter of pending.values()) waiter.reject(err);
			pending.clear();
		});

		let resolvedModel: string | undefined = model;
		try {
			await sendRpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
			const mcpServers = spec.mcp
				? [{ name: spec.mcp.serverName, type: "http", url: spec.mcp.url, headers: [{ name: "Authorization", value: `Bearer ${spec.mcp.token}` }] }]
				: [];
			const created = await sendRpc("session/new", { cwd: spec.workspace, mcpServers });
			acpSessionId = String(created?.sessionId ?? acpSessionId ?? "");
			if (typeof created?.model === "string") resolvedModel = created.model;
			if (acpSessionId) spec.onActivity?.({ type: "session", sessionId: acpSessionId, model: resolvedModel });
		} catch (error) {
			rl.close();
			killProcessTreeNow(child);
			throw error;
		}

		const driverId = this.id;
		let sentSystem = false;
		return {
			driverId,
			get sessionId() {
				return acpSessionId;
			},
			async runTurn(prompt: string, opts = {}): Promise<WorkerTurnResult> {
				if (sessionState.kind === "closed") {
					throw new Error("GeminiAcp session is closed");
				}
				if (sessionState.kind === "running") {
					throw new Error("GeminiAcp session already has an active turn in flight");
				}
				const startedAt = Date.now();
				const chunks: string[] = [];
				sessionState = { kind: "running", chunks };
				const text = spec.systemPrompt && !sentSystem ? `${spec.systemPrompt}\n\n${prompt}` : prompt;
				sentSystem = true;
				if (opts.signal?.aborted) {
					resetToIdle();
					return { status: "interrupted", finalText: "", sessionId: acpSessionId, model: resolvedModel, usage: { durationMs: 0 } };
				}
				const cancel = bindTurnCancellation(child, {
					signal: opts.signal,
					timeoutMs: opts.timeoutMs,
					graceMs: 3_000,
					onCancel: () => {
						if (acpSessionId) void sendRpc("session/cancel", { sessionId: acpSessionId }).catch(() => {});
					},
				});
				try {
					await sendRpc("session/prompt", { sessionId: acpSessionId, prompt: [{ type: "text", text }] });
					return {
						status: opts.signal?.aborted || cancel.wasCancelled() ? "interrupted" : "completed",
						finalText: chunks.join("").trim(),
						sessionId: acpSessionId,
						model: resolvedModel,
						usage: { durationMs: Date.now() - startedAt },
					};
				} catch (error) {
					const raw = `${error instanceof Error ? error.message : String(error)}\n${stderr}`.trim();
					const quota = classifyQuotaError(raw);
					const usage = { durationMs: Date.now() - startedAt };
					if (opts.signal?.aborted || cancel.wasCancelled()) {
						return { status: "interrupted", finalText: chunks.join("").trim(), sessionId: acpSessionId, model: resolvedModel, usage };
					}
					if (quota) {
						return { status: "rate_limited", finalText: chunks.join("").trim(), sessionId: acpSessionId, model: resolvedModel, usage, quotaError: quota, error: raw };
					}
					return { status: "failed", finalText: chunks.join("").trim(), sessionId: acpSessionId, model: resolvedModel, usage, error: raw };
				} finally {
					cancel.dispose();
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
				killProcessTreeNow(child);
			},
		};
	}
}
