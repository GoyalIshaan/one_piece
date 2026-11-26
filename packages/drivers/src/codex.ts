import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

function tomlString(value: string): string {
	return JSON.stringify(value);
}

function mcpConfigArgs(spec: WorkerSpawnSpec): string[] {
	if (!spec.mcp) return [];
	const name = spec.mcp.serverName;
	const args = [
		"-c", `mcp_servers.${name}.url=${tomlString(spec.mcp.url)}`,
		"-c", `mcp_servers.${name}.http_headers.Authorization=${tomlString(`Bearer ${spec.mcp.token}`)}`,
	];
	// Auto-approve trusted local swarm MCP tools in Codex 0.150+ so approval policy never blocks swarm coordination.
	for (const toolName of spec.mcp.toolNames ?? []) {
		args.push("-c", `mcp_servers.${name}.tools.${toolName}.approval_mode="approve"`);
	}
	return args;
}

async function probeCodexHealth(driverId: string, kind: "codex-app-server" | "codex-exec", config: DriverConfig): Promise<DriverHealth> {
	const binary = config.binary ?? "codex";
	const base = await probeCliBinary(driverId, kind, binary);
	if (!base.ok) return base;
	if (config.subscriptionMode === false && process.env.OPENAI_API_KEY) {
		return { ...base, detail: "auth: OPENAI_API_KEY" };
	}
	try {
		const { stdout, stderr } = await execFileAsync(binary, ["login", "status"], { timeout: 4_000 });
		const info = (stdout || stderr).trim();
		const loggedIn = /logged in/i.test(info);
		return { ...base, ok: loggedIn, detail: info || (loggedIn ? "logged in" : "Run 'codex login' to sign in") };
	} catch (error) {
		return { ...base, ok: false, detail: `Not logged in — run 'codex login' (${error instanceof Error ? error.message : String(error)})` };
	}
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
 * Persistent JSON-RPC 2.0 driver over `codex app-server --stdio`.
 * Supports multi-turn threads, mid-turn `turn/steer`, `turn/interrupt`, and ChatGPT subscription auth.
 */
export class CodexAppServerDriver implements WorkerDriver {
	readonly id: string;
	readonly kind = "codex-app-server" as const;
	readonly capabilities: DriverCapabilities = {
		supportsSteer: true,
		supportsResume: true,
		supportsOutputSchema: true,
		supportsMcpHttp: true,
	};
	private readonly config: DriverConfig;

	constructor(config: DriverConfig) {
		this.id = config.id;
		this.config = config;
	}

	healthCheck(): Promise<DriverHealth> {
		return probeCodexHealth(this.id, this.kind, this.config);
	}

	async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
		const binary = this.config.binary ?? "codex";
		const env = this.config.subscriptionMode === false
			? buildCliEnv([])
			: buildCliEnv(["OPENAI_API_KEY"]);
		const args = [
			"app-server",
			"--stdio",
			...mcpConfigArgs(spec),
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
		let stderrBuf = "";
		let threadId: string | undefined = spec.resumeSessionId;
		let resolvedModel: string | undefined = spec.model ?? this.config.model;
		let threadTokenTotals = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
		let activeTurn: {
			turnId?: string;
			chunks: string[];
			startTotals: { input: number; cached: number; cacheWrite: number; output: number; reasoning: number; total: number };
			usage?: WorkerTurnResult["usage"];
			resolve: (res: WorkerTurnResult) => void;
			startedAt: number;
		} | undefined;

		const sendRpc = (method: string, params: Record<string, unknown>): Promise<any> => {
			return new Promise((resolve, reject) => {
				if (!child.stdin || child.killed) {
					reject(new Error("codex app-server stdin closed"));
					return;
				}
				const id = nextId++;
				pending.set(id, { resolve, reject });
				child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			});
		};

		const sendResponse = (id: string | number, result: unknown): void => {
			if (child.stdin && !child.killed) {
				child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
			}
		};

		const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
		rl.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let msg: any;
			try {
				msg = JSON.parse(trimmed);
			} catch {
				stderrBuf += `${trimmed}\n`;
				return;
			}

			// Response to our RPC request
			if (msg.id !== undefined && msg.method === undefined) {
				const waiter = pending.get(Number(msg.id));
				if (waiter) {
					pending.delete(Number(msg.id));
					if (msg.error) waiter.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
					else waiter.resolve(msg.result);
				}
				return;
			}

			// Server -> Client approval callback (handles command, fileChange, and MCP tool approvals)
			if (msg.id !== undefined && typeof msg.method === "string") {
				if (msg.method.includes("requestApproval") || msg.method.includes("Approval")) {
					const decline = spec.readOnly && msg.method.includes("fileChange");
					sendResponse(msg.id, { decision: decline ? "decline" : "accept" });
				} else {
					sendResponse(msg.id, {});
				}
				return;
			}

			// Streaming notification
			const method = String(msg.method ?? "");
			const params = (msg.params ?? {}) as Record<string, any>;

			if (method === "turn/started" && activeTurn) {
				activeTurn.turnId = String(params.turn?.id ?? params.turnId ?? "");
			} else if ((method === "item/agentMessage/delta" || method === "item/delta") && activeTurn) {
				const delta = String(params.delta ?? params.text ?? "");
				if (delta) {
					activeTurn.chunks.push(delta);
					spec.onActivity?.({ type: "text", delta });
				}
			} else if (method === "item/completed") {
				const item = params.item ?? params;
				if (item?.type === "agentMessage" && typeof item.text === "string" && activeTurn) {
					if (!activeTurn.chunks.length) activeTurn.chunks.push(item.text);
				} else if (item?.type === "commandExecution" || item?.type === "mcpToolCall") {
					const isMcp = item.type === "mcpToolCall";
					const toolName = String(item.tool ?? (item.type === "commandExecution" ? "bash" : item.type));
					const argsRaw = item.command ?? item.arguments ?? item.input;
					const argsPreview = argsRaw !== undefined
						? (typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw)).slice(0, 240)
						: undefined;
					spec.onActivity?.({ type: "tool_call", name: toolName, argsPreview, isMcp });
					const outputRaw = item.aggregatedOutput ?? item.output ?? item.result ?? item.error;
					const isError = Boolean(
						item.error ||
						item.status === "failed" ||
						(typeof item.exitCode === "number" && item.exitCode !== 0),
					);
					const outputPreview = outputRaw !== undefined
						? (typeof outputRaw === "string" ? outputRaw : JSON.stringify(outputRaw)).slice(0, 500)
						: undefined;
					spec.onActivity?.({ type: "tool_result", name: toolName, isError, outputPreview, isMcp });
				}
			} else if (method === "thread/tokenUsage/updated") {
				const tot = params.tokenUsage?.total;
				if (tot && typeof tot === "object") {
					const next = {
						input: Number(tot.inputTokens ?? tot.input_tokens ?? 0) || 0,
						cached: Number(tot.cachedInputTokens ?? tot.cached_input_tokens ?? 0) || 0,
						cacheWrite: Number(tot.cacheWriteInputTokens ?? tot.cache_write_input_tokens ?? 0) || 0,
						output: Number(tot.outputTokens ?? tot.output_tokens ?? 0) || 0,
						reasoning: Number(tot.reasoningOutputTokens ?? tot.reasoning_output_tokens ?? 0) || 0,
						total: Number(tot.totalTokens ?? tot.total_tokens ?? 0) || 0,
					};
					threadTokenTotals = next;
					if (activeTurn) {
						const base = activeTurn.startTotals;
						const dIn = Math.max(0, next.input - base.input);
						const dCached = Math.max(0, next.cached - base.cached);
						const dCacheWrite = Math.max(0, next.cacheWrite - base.cacheWrite);
						const dOut = Math.max(0, next.output - base.output);
						const dReason = Math.max(0, next.reasoning - base.reasoning);
						const dTotal = Math.max(0, next.total - base.total);
						activeTurn.usage = {
							inputTokens: dIn || undefined,
							cachedTokens: dCached || undefined,
							cacheWriteTokens: dCacheWrite || undefined,
							outputTokens: dOut || undefined,
							reasoningTokens: dReason || undefined,
							totalTokens: dTotal || (dIn + dOut) || undefined,
							durationMs: Date.now() - activeTurn.startedAt,
						};
					}
				}
			} else if ((method === "turn/completed" || method === "turn/failed" || method === "error") && activeTurn) {
				const turn = activeTurn;
				activeTurn = undefined;
				const durationMs = Date.now() - turn.startedAt;
				const errText = String(params.error?.message ?? params.turn?.error?.message ?? params.message ?? stderrBuf).trim();
				const quota = method !== "turn/completed" || params.turn?.status === "failed"
					? classifyQuotaError(errText)
					: undefined;
				const usageObj = params.usage ?? params.turn?.usage;
				const turnModel = typeof params.model === "string"
					? params.model
					: typeof params.turn?.model === "string"
						? params.turn.model
						: resolvedModel;
				if (turnModel) resolvedModel = turnModel;
				const usage = usageObj
					? {
						inputTokens: Number(usageObj.input_tokens ?? usageObj.inputTokens ?? 0) || undefined,
						cachedTokens: Number(usageObj.cached_input_tokens ?? usageObj.cachedTokens ?? 0) || undefined,
						cacheWriteTokens: Number(usageObj.cache_write_input_tokens ?? usageObj.cacheWriteInputTokens ?? 0) || undefined,
						outputTokens: Number(usageObj.output_tokens ?? usageObj.outputTokens ?? 0) || undefined,
						reasoningTokens: Number(usageObj.reasoning_output_tokens ?? usageObj.reasoningTokens ?? 0) || undefined,
						totalTokens: Number(usageObj.total_tokens ?? usageObj.totalTokens ?? 0) || undefined,
						durationMs,
					}
					: turn.usage
						? { ...turn.usage, durationMs }
						: { durationMs };

				if (quota) {
					turn.resolve({ status: "rate_limited", finalText: turn.chunks.join(""), sessionId: threadId, model: resolvedModel, usage, quotaError: quota, error: errText });
				} else if (method === "turn/failed" || method === "error" || params.turn?.status === "failed") {
					turn.resolve({ status: "failed", finalText: turn.chunks.join(""), sessionId: threadId, model: resolvedModel, usage, error: errText || "codex turn failed" });
				} else if (params.turn?.status === "interrupted") {
					turn.resolve({ status: "interrupted", finalText: turn.chunks.join(""), sessionId: threadId, model: resolvedModel, usage });
				} else {
					turn.resolve({ status: "completed", finalText: turn.chunks.join(""), sessionId: threadId, model: resolvedModel, usage });
				}
			}
		});

		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderrBuf += chunk;
		});

		child.on("close", (code) => {
			const errMsg = stderrBuf.trim() || `codex app-server exited with code ${code ?? "null"}`;
			for (const waiter of pending.values()) waiter.reject(new Error(errMsg));
			pending.clear();
			if (activeTurn) {
				const turn = activeTurn;
				activeTurn = undefined;
				const quota = classifyQuotaError(errMsg);
				turn.resolve({
					status: quota ? "rate_limited" : "failed",
					finalText: turn.chunks.join(""),
					sessionId: threadId,
					usage: { durationMs: Date.now() - turn.startedAt },
					quotaError: quota,
					error: errMsg,
				});
			}
		});

		// Initialize JSON-RPC handshake + thread
		await sendRpc("initialize", {
			clientInfo: { name: "one-piece", version: "0.2.0" },
		});
		const model = spec.model ?? this.config.model;
		const threadParams: Record<string, unknown> = {
			cwd: spec.workspace,
			sandbox: spec.readOnly ? "read-only" : "workspace-write",
			approvalPolicy: "on-request",
			...(model ? { model } : {}),
			...(spec.systemPrompt ? { baseInstructions: spec.systemPrompt } : {}),
		};
		const threadResult = threadId
			? await sendRpc("thread/resume", { threadId, ...threadParams })
			: await sendRpc("thread/start", threadParams);
		threadId = String(threadResult?.thread?.id ?? threadResult?.threadId ?? threadId ?? "");
		const startedModel = typeof threadResult?.thread?.model === "string"
			? threadResult.thread.model
			: typeof threadResult?.model === "string"
				? threadResult.model
				: resolvedModel;
		if (startedModel) resolvedModel = startedModel;
		if (threadId) spec.onActivity?.({ type: "session", sessionId: threadId, model: resolvedModel });

		const driverId = this.id;
		return {
			driverId,
			get sessionId() {
				return threadId;
			},
			async runTurn(prompt: string, opts = {}): Promise<WorkerTurnResult> {
				if (!threadId) throw new Error("codex app-server thread not initialized");
				const startedAt = Date.now();
				return new Promise<WorkerTurnResult>((resolve, reject) => {
					let timer: ReturnType<typeof setTimeout> | undefined;
					const cleanup = () => {
						if (timer) clearTimeout(timer);
						opts.signal?.removeEventListener("abort", onAbort);
					};
					const finish = (res: WorkerTurnResult) => {
						cleanup();
						resolve(res);
					};
					const onAbort = () => {
						if (activeTurn?.turnId && threadId) {
							void sendRpc("turn/interrupt", { threadId, turnId: activeTurn.turnId }).catch(() => {});
						}
						if (activeTurn) {
							const turn = activeTurn;
							activeTurn = undefined;
							finish({ status: "interrupted", finalText: turn.chunks.join(""), sessionId: threadId, usage: { durationMs: Date.now() - startedAt } });
						}
					};
					if (opts.signal?.aborted) {
						resolve({ status: "interrupted", finalText: "", sessionId: threadId, usage: { durationMs: 0 } });
						return;
					}
					opts.signal?.addEventListener("abort", onAbort, { once: true });
					if (opts.timeoutMs) {
						timer = setTimeout(onAbort, opts.timeoutMs);
					}
					activeTurn = { chunks: [], startTotals: { ...threadTokenTotals }, resolve: finish, startedAt };
					const turnParams: Record<string, unknown> = {
						threadId,
						input: [{ type: "text", text: prompt }],
						...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
					};
					void sendRpc("turn/start", turnParams).catch((error) => {
						if (activeTurn) {
							activeTurn = undefined;
							const raw = error instanceof Error ? error.message : String(error);
							const quota = classifyQuotaError(raw);
							finish({
								status: quota ? "rate_limited" : "failed",
								finalText: "",
								sessionId: threadId,
								usage: { durationMs: Date.now() - startedAt },
								quotaError: quota,
								error: raw,
							});
						} else {
							cleanup();
							reject(error);
						}
					});
				});
			},
			async steer(message: string): Promise<void> {
				if (!threadId || !activeTurn?.turnId) return;
				await sendRpc("turn/steer", {
					threadId,
					turnId: activeTurn.turnId,
					input: [{ type: "text", text: message }],
				});
			},
			async interrupt(): Promise<void> {
				if (!threadId || !activeTurn?.turnId) return;
				await sendRpc("turn/interrupt", { threadId, turnId: activeTurn.turnId });
			},
			async close(): Promise<void> {
				rl.close();
				killTree(child);
			},
		};
	}
}

/**
 * Headless one-shot / resumable `codex exec --json` driver.
 * Ideal for stateless fresh-shot structured JSON planning (`--output-schema`) and clean fallback.
 */
export class CodexExecDriver implements WorkerDriver {
	readonly id: string;
	readonly kind = "codex-exec" as const;
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

	healthCheck(): Promise<DriverHealth> {
		return probeCodexHealth(this.id, this.kind, this.config);
	}

	async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
		const binary = this.config.binary ?? "codex";
		const env = this.config.subscriptionMode === false
			? buildCliEnv([])
			: buildCliEnv(["OPENAI_API_KEY"]);
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
				const fullPrompt = spec.systemPrompt && !currentSessionId
					? `${spec.systemPrompt}\n\n${prompt}`
					: prompt;
				let schemaDir: string | undefined;
				let schemaPath: string | undefined;
				if (opts.outputSchema) {
					schemaDir = mkdtempSync(join(tmpdir(), "op-codex-schema-"));
					schemaPath = join(schemaDir, "schema.json");
					writeFileSync(schemaPath, JSON.stringify(opts.outputSchema, null, 2), "utf8");
				}
				const model = spec.model ?? config.model;
				const args = currentSessionId
					? [
						"exec", "resume", currentSessionId,
						"--json",
						...mcpConfigArgs(spec),
						...(model ? ["-m", model] : []),
						...(config.extraArgs ?? []),
						fullPrompt,
					]
					: [
						"exec",
						"-C", spec.workspace,
						"-s", spec.readOnly ? "read-only" : "workspace-write",
						"--json",
						...mcpConfigArgs(spec),
						...(model ? ["-m", model] : []),
						...(schemaPath ? ["--output-schema", schemaPath] : []),
						...(config.extraArgs ?? []),
						fullPrompt,
					];

				return new Promise<WorkerTurnResult>((resolve) => {
					const child = spawn(binary, args, {
						cwd: spec.workspace,
						env,
						stdio: ["ignore", "pipe", "pipe"],
						detached: true,
					});
					activeChild = child;

					const messages: string[] = [];
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
						if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
							currentSessionId = ev.thread_id;
							spec.onActivity?.({ type: "session", sessionId: ev.thread_id, model: resolvedModel });
						} else if (ev.type === "item.completed" && ev.item) {
							if (ev.item.type === "agent_message" && typeof ev.item.text === "string") {
								messages.push(ev.item.text);
								spec.onActivity?.({ type: "text", delta: ev.item.text });
							} else if (ev.item.type === "command_execution" || ev.item.type === "mcp_tool_call") {
								const isMcp = ev.item.type === "mcp_tool_call";
								const toolName = String(ev.item.tool ?? (ev.item.type === "command_execution" ? "bash" : ev.item.type));
								const argsRaw = ev.item.command ?? ev.item.arguments ?? ev.item.input;
								const argsPreview = argsRaw !== undefined
									? (typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw)).slice(0, 240)
									: undefined;
								spec.onActivity?.({ type: "tool_call", name: toolName, argsPreview, isMcp });
								const outputRaw = ev.item.aggregated_output ?? ev.item.output ?? ev.item.result ?? ev.item.error;
								const isError = Boolean(
									ev.item.error ||
									ev.item.status === "failed" ||
									(typeof ev.item.exit_code === "number" && ev.item.exit_code !== 0),
								);
								const outputPreview = outputRaw !== undefined
									? (typeof outputRaw === "string" ? outputRaw : JSON.stringify(outputRaw)).slice(0, 500)
									: undefined;
								spec.onActivity?.({ type: "tool_result", name: toolName, isError, outputPreview, isMcp });
							}
						} else if (ev.type === "turn.completed" && ev.usage) {
							usage = {
								inputTokens: Number(ev.usage.input_tokens ?? 0) || undefined,
								cachedTokens: Number(ev.usage.cached_input_tokens ?? 0) || undefined,
								outputTokens: Number(ev.usage.output_tokens ?? 0) || undefined,
								reasoningTokens: Number(ev.usage.reasoning_output_tokens ?? 0) || undefined,
								durationMs: Date.now() - startedAt,
							};
						} else if (ev.type === "turn.failed" || ev.type === "error") {
							streamError += `${String(ev.error?.message ?? ev.message ?? JSON.stringify(ev))}\n`;
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
						if (schemaDir) rmSync(schemaDir, { recursive: true, force: true });

						const durationMs = Date.now() - startedAt;
						usage = { ...usage, durationMs };
						const combinedErr = [streamError, stderr, rawNonJson].filter(Boolean).join("\n").trim();
						const finalText = messages.join("\n").trim();

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
							resolve({ status: "failed", finalText, sessionId: currentSessionId, model: resolvedModel, usage, error: combinedErr || `codex exec exited ${code}` });
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
