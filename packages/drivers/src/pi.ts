import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type {
	DriverCapabilities,
	DriverConfig,
	DriverHealth,
	ToolDefinition,
	WorkerDriver,
	WorkerSession,
	WorkerSpawnSpec,
	WorkerTurnResult,
} from "@one-piece/core";
import type { CallRecord, ModelRouter } from "@one-piece/router";
import { classifyQuotaError } from "./classify.ts";
import { extractFailedApproaches, type GenericMessage, maybeCompactSession } from "./compaction.ts";

/** Recursively sort object keys so tool JSON schemas hash byte-identically for KV cache stability. */
export function canonicalizeValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalizeValue);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			out[key] = canonicalizeValue((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

function toPiTools(defs: readonly ToolDefinition[], spec: WorkerSpawnSpec): AgentTool<any>[] {
	const sorted = [...defs].sort((a, b) => a.name.localeCompare(b.name));
	return sorted.map((def) => ({
		name: def.name,
		label: def.name,
		description: def.description,
		parameters: canonicalizeValue(def.inputSchema) as any,
		async execute(_toolCallId, params, signal) {
			const argsPreview = params !== undefined ? JSON.stringify(params).slice(0, 240) : undefined;
			spec.onActivity?.({ type: "tool_call", name: def.name, argsPreview });
			const out = await def.execute((params ?? {}) as Record<string, unknown>, {
				runId: spec.runId,
				agentId: spec.agentId,
				role: spec.role,
				workspace: spec.workspace,
				signal: signal ?? new AbortController().signal,
			});
			spec.onActivity?.({ type: "tool_result", name: def.name, isError: out.isError, outputPreview: out.text.slice(0, 500) });
			if (out.isError) {
				throw new Error(out.text);
			}
			return {
				content: [{ type: "text" as const, text: out.text }],
				details: out.data ?? {},
			};
		},
	}));
}

/**
 * Thin in-process Pi driver (`pi-ai` + `pi-agent-core`).
 * This is the ONLY driver importing `@earendil-works/pi-agent-core`.
 * Ideal for lean ~600-token API/OpenRouter coordinators and deterministic `sim` (FauxProvider) testing.
 */
export class PiInProcessDriver implements WorkerDriver {
	readonly id: string;
	readonly kind = "pi-in-process" as const;
	readonly capabilities: DriverCapabilities = {
		supportsSteer: true,
		supportsResume: true,
		supportsOutputSchema: false,
		supportsMcpHttp: false,
	};
	private readonly config: DriverConfig;
	private readonly router: ModelRouter;
	private readonly onCall?: (agentId: string, record: CallRecord) => void;

	constructor(config: DriverConfig, router: ModelRouter, onCall?: (agentId: string, record: CallRecord) => void) {
		this.id = config.id;
		this.config = config;
		this.router = router;
		this.onCall = onCall;
	}

	async healthCheck(): Promise<DriverHealth> {
		try {
			await this.router.prepare?.();
			return {
				ok: true,
				driverId: this.id,
				kind: this.kind,
				version: "pi-1.6.0",
				detail: `providers: ${this.router.providers().join(", ")}`,
			};
		} catch (error) {
			return { ok: false, driverId: this.id, kind: this.kind, detail: error instanceof Error ? error.message : String(error) };
		}
	}

	async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
		const requestedModel = spec.model ?? this.config.model;
		const picked = requestedModel && this.config.provider
			? { provider: this.config.provider, id: requestedModel }
			: this.router.pick(spec.role);
		const model = this.router.resolve(picked);
		let turnUsage = {
			inputTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
			outputTokens: 0,
			reasoningTokens: 0,
			totalTokens: 0,
			usd: 0,
			cacheReadReported: false,
			cacheWriteReported: false,
			reasoningReported: false,
		};
		let lastInputTokens = 0;
		let compactionCount = 0;
		let needsHandoff = false;
		let capturedFailures: string[] = [];
		const systemPrompt = spec.systemPrompt ?? `You are a ${spec.role} agent in one_piece.`;
		const contextWindow = Math.max(8_192, Number((model as any)?.contextWindow ?? 128_000));

		const streamFn = this.router.streamFn((record) => {
			turnUsage.inputTokens += record.input;
			if (record.cacheReadTokens !== undefined) {
				turnUsage.cachedTokens += record.cacheReadTokens;
				turnUsage.cacheReadReported = true;
			}
			if (record.cacheWriteTokens !== undefined) {
				turnUsage.cacheWriteTokens += record.cacheWriteTokens;
				turnUsage.cacheWriteReported = true;
			}
			turnUsage.outputTokens += record.output;
			if (record.reasoningTokens !== undefined) {
				turnUsage.reasoningTokens += record.reasoningTokens;
				turnUsage.reasoningReported = true;
			}
			turnUsage.totalTokens += record.totalTokens;
			turnUsage.usd += record.usd;
			lastInputTokens = record.input + (record.cacheReadTokens ?? 0);
			this.onCall?.(spec.agentId, record);
		});

		const agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				tools: toPiTools(spec.tools ?? [], spec),
				messages: [],
			},
			transformContext: async (messages) => {
				const sysHead = messages[0]?.role === "system" ? [messages[0]] : [];
				const body = sysHead.length ? messages.slice(1) : messages;
				const res = maybeCompactSession({
					messages: body as unknown as GenericMessage[],
					systemPrompt,
					contextWindow,
					lastReportedInputTokens: lastInputTokens,
					compactionCount,
					policy: spec.compaction,
				});
				if (!res.compacted) return messages;
				compactionCount = res.compactionCount;
				if (res.needsHandoff) needsHandoff = true;
				if (res.failedApproaches.length) capturedFailures = res.failedApproaches;
				const next = [...sysHead, ...(res.messages as any[])];
				// Persist compacted messages back to agent state so subsequent turns keep the new prefix stably cached.
				agent.state.messages = next;
				lastInputTokens = res.compacted.afterTokens;
				return next;
			},
			streamFn,
			sessionId: spec.cacheKeyPrefix ?? spec.agentId,
		});

		const driverId = this.id;
		const resolvedModel = `${model.provider}/${model.id}`;
		type PiSessionState =
			| { readonly kind: "idle" }
			| { readonly kind: "running" }
			| { readonly kind: "closed" };
		let sessionState: PiSessionState = { kind: "idle" };
		const resetToIdle = (): void => {
			if (sessionState.kind !== "closed") sessionState = { kind: "idle" };
		};
		return {
			driverId,
			sessionId: spec.agentId,
			async runTurn(prompt: string, opts = {}): Promise<WorkerTurnResult> {
				if (sessionState.kind === "closed") {
					throw new Error("PiInProcessDriver session is closed");
				}
				if (sessionState.kind === "running") {
					throw new Error("PiInProcessDriver session already has an active turn in flight");
				}
				sessionState = { kind: "running" };
				const startedAt = Date.now();
				turnUsage = {
					inputTokens: 0,
					cachedTokens: 0,
					cacheWriteTokens: 0,
					outputTokens: 0,
					reasoningTokens: 0,
					totalTokens: 0,
					usd: 0,
					cacheReadReported: false,
					cacheWriteReported: false,
					reasoningReported: false,
				};
				needsHandoff = false;
				const onAbort = () => agent.abort();
				opts.signal?.addEventListener("abort", onAbort, { once: true });
				let timer: ReturnType<typeof setTimeout> | undefined;
				if (opts.timeoutMs) timer = setTimeout(onAbort, opts.timeoutMs);
				try {
					await agent.prompt(prompt);
					const last = [...agent.state.messages].reverse().find((m) => m.role === "assistant") as any;
					const text = Array.isArray(last?.content)
						? last.content.filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("")
						: "";
					const errMsg = agent.state.errorMessage ?? last?.errorMessage;
					const usage = { ...turnUsage, durationMs: Date.now() - startedAt };
					const failedApproaches = capturedFailures.length
						? capturedFailures
						: extractFailedApproaches(agent.state.messages as unknown as GenericMessage[]);
					if (opts.signal?.aborted) {
						return { status: "interrupted", finalText: text, sessionId: spec.agentId, model: resolvedModel, usage, needsHandoff, failedApproaches };
					}
					if (errMsg) {
						const quota = classifyQuotaError(String(errMsg));
						if (quota) {
							return {
								status: "rate_limited",
								finalText: text,
								sessionId: spec.agentId,
								model: resolvedModel,
								usage,
								quotaError: quota,
								error: String(errMsg),
								failedApproaches,
							};
						}
						return {
							status: "failed",
							finalText: text,
							sessionId: spec.agentId,
							model: resolvedModel,
							usage,
							error: String(errMsg),
							needsHandoff,
							failedApproaches,
						};
					}
					return { status: "completed", finalText: text, sessionId: spec.agentId, model: resolvedModel, usage, needsHandoff, failedApproaches };
				} catch (error) {
					const raw = error instanceof Error ? error.message : String(error);
					const quota = classifyQuotaError(raw);
					const usage = { ...turnUsage, durationMs: Date.now() - startedAt };
					if (quota) {
						return { status: "rate_limited", finalText: "", sessionId: spec.agentId, model: resolvedModel, usage, quotaError: quota, error: raw };
					}
					if (opts.signal?.aborted) {
						return { status: "interrupted", finalText: "", sessionId: spec.agentId, model: resolvedModel, usage, needsHandoff };
					}
					return { status: "failed", finalText: "", sessionId: spec.agentId, model: resolvedModel, usage, error: raw, needsHandoff };
				} finally {
					if (timer) clearTimeout(timer);
					opts.signal?.removeEventListener("abort", onAbort);
					resetToIdle();
				}
			},
			async steer(message: string): Promise<void> {
				if (sessionState.kind === "closed") return;
				agent.steer({ role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() } as any);
			},
			async interrupt(): Promise<void> {
				if (sessionState.kind === "running") agent.abort();
			},
			async close(): Promise<void> {
				sessionState = { kind: "closed" };
				agent.abort();
			},
		};
	}
}
