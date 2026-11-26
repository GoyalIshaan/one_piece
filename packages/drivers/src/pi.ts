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

function toPiTools(defs: readonly ToolDefinition[], spec: WorkerSpawnSpec): AgentTool<any>[] {
	return defs.map((def) => ({
		name: def.name,
		label: def.name,
		description: def.description,
		parameters: def.inputSchema as any,
		async execute(_toolCallId, params, signal) {
			spec.onActivity?.({ type: "tool_call", name: def.name });
			const out = await def.execute((params ?? {}) as Record<string, unknown>, {
				runId: spec.runId,
				agentId: spec.agentId,
				role: spec.role,
				workspace: spec.workspace,
				signal: signal ?? new AbortController().signal,
			});
			spec.onActivity?.({ type: "tool_result", name: def.name, isError: out.isError });
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
		const picked = this.config.model && this.config.provider
			? { provider: this.config.provider, id: this.config.model }
			: this.router.pick(spec.role);
		const model = this.router.resolve(picked);
		let turnUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, usd: 0 };

		const streamFn = this.router.streamFn((record) => {
			turnUsage.inputTokens += record.input;
			turnUsage.cachedTokens += record.cacheReadTokens ?? 0;
			turnUsage.outputTokens += record.output;
			turnUsage.totalTokens += record.totalTokens;
			turnUsage.usd += record.usd;
			this.onCall?.(spec.agentId, record);
		});

		const agent = new Agent({
			initialState: {
				systemPrompt: spec.systemPrompt ?? `You are a ${spec.role} agent in one_piece.`,
				model,
				tools: toPiTools(spec.tools ?? [], spec),
				messages: [],
			},
			streamFn,
			sessionId: spec.agentId,
		});

		const driverId = this.id;
		return {
			driverId,
			sessionId: spec.agentId,
			async runTurn(prompt: string, opts = {}): Promise<WorkerTurnResult> {
				const startedAt = Date.now();
				turnUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, usd: 0 };
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
					if (opts.signal?.aborted) {
						return { status: "interrupted", finalText: text, sessionId: spec.agentId, usage };
					}
					if (errMsg) {
						const quota = classifyQuotaError(String(errMsg));
						return {
							status: quota ? "rate_limited" : "failed",
							finalText: text,
							sessionId: spec.agentId,
							usage,
							quotaError: quota,
							error: String(errMsg),
						};
					}
					return { status: "completed", finalText: text, sessionId: spec.agentId, usage };
				} catch (error) {
					const raw = error instanceof Error ? error.message : String(error);
					const quota = classifyQuotaError(raw);
					return {
						status: quota ? "rate_limited" : opts.signal?.aborted ? "interrupted" : "failed",
						finalText: "",
						sessionId: spec.agentId,
						usage: { ...turnUsage, durationMs: Date.now() - startedAt },
						quotaError: quota,
						error: raw,
					};
				} finally {
					if (timer) clearTimeout(timer);
					opts.signal?.removeEventListener("abort", onAbort);
				}
			},
			async steer(message: string): Promise<void> {
				agent.steer({ role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() } as any);
			},
			async interrupt(): Promise<void> {
				agent.abort();
			},
			async close(): Promise<void> {
				agent.abort();
			},
		};
	}
}
