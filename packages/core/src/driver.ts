import type { EventBus } from "./events.ts";
import type { JsonSchema, Role, ToolDefinition, UsageRecord } from "./types.ts";

export type DriverKind =
	| "codex-app-server"
	| "codex-exec"
	| "grok-acp"
	| "grok-cli"
	| "agy-acp"
	| "gemini-acp"
	| "gemini-cli"
	| "pi-in-process";

export type QuotaErrorClass =
	| { kind: "transient_rpm"; retryAfterMs?: number; raw: string }
	| { kind: "window_exhausted"; resetAtMs?: number; raw: string }
	| { kind: "hard_auth_or_cap"; reason: string; raw: string };

export interface McpConnectionInfo {
	url: string;
	token: string;
	serverName: string;
	toolNames?: string[];
	stdioBridgePath?: string;
}

export interface DriverCapabilities {
	supportsSteer: boolean;
	supportsResume: boolean;
	supportsOutputSchema: boolean;
	supportsMcpHttp: boolean;
}

export interface WorkerSpawnSpec {
	runId: string;
	agentId: string;
	role: Role;
	workspace: string;
	systemPrompt?: string;
	model?: string;
	maxTurns?: number;
	readOnly?: boolean;
	/** Local MCP bus coordinates for external CLI workers. */
	mcp?: McpConnectionInfo;
	/** Direct tool definitions for in-process drivers (PiInProcessDriver). */
	tools?: ToolDefinition[];
	/** Resume an existing vendor CLI session id if supported. */
	resumeSessionId?: string;
	/** Optional event hook for streaming tool/text activity into TriggerEngine. */
	onActivity?: (event: WorkerActivityEvent) => void;
}

export type WorkerActivityEvent =
	| { type: "session"; sessionId: string; model?: string }
	| { type: "text"; delta: string }
	| { type: "tool_call"; name: string; argsPreview?: string; isMcp?: boolean }
	| { type: "tool_result"; name: string; isError?: boolean; outputPreview?: string; durationMs?: number; isMcp?: boolean }
	| { type: "error"; message: string };

export interface WorkerTurnResult {
	status: "completed" | "yielded" | "interrupted" | "rate_limited" | "failed";
	finalText: string;
	sessionId?: string;
	model?: string;
	usage?: UsageRecord;
	quotaError?: QuotaErrorClass;
	error?: string;
}

export interface WorkerSession {
	readonly driverId: string;
	readonly sessionId?: string;
	runTurn(
		prompt: string,
		opts?: { signal?: AbortSignal; outputSchema?: JsonSchema; timeoutMs?: number },
	): Promise<WorkerTurnResult>;
	steer?(message: string): Promise<void>;
	interrupt?(): Promise<void>;
	close(): Promise<void>;
}

export interface DriverHealth {
	ok: boolean;
	driverId: string;
	kind: DriverKind;
	version?: string;
	binaryPath?: string;
	detail?: string;
}

export interface WorkerDriver {
	readonly id: string;
	readonly kind: DriverKind;
	readonly capabilities: DriverCapabilities;
	healthCheck(): Promise<DriverHealth>;
	spawn(spec: WorkerSpawnSpec): Promise<WorkerSession>;
}

export interface DriverConfig {
	id: string;
	kind: DriverKind;
	/** Executable override (defaults to `codex`, `grok`, `gemini`). */
	binary?: string;
	/** Default model ID for this driver (optional; uses CLI default if omitted). */
	model?: string;
	/** Max concurrent workers allowed on this subscription/provider (default 2 for subs). */
	maxConcurrent?: number;
	/** Keep consumer subscription billing by unsetting API key env vars (default true for CLIs). */
	subscriptionMode?: boolean;
	/** For `pi-in-process`: underlying pi-ai provider id (e.g. `openrouter`, `openai`, `sim`). */
	provider?: string;
	/** Relative preference weight when routing within a role pool. */
	weight?: number;
	/** Extra CLI flags appended if needed. */
	extraArgs?: string[];
}

export interface DriverPoolSelection {
	driver: WorkerDriver;
	release: () => void;
	/** Milliseconds spent waiting for a concurrency permit. */
	waitedMs?: number;
}

export interface QuotaPoolRouter {
	attachBus?(bus: EventBus, runId: string): void;
	drivers(): WorkerDriver[];
	getDriver(id: string): WorkerDriver | undefined;
	healthCheckAll(): Promise<DriverHealth[]>;
	/** Acquire a healthy driver for a role, respecting concurrency permits, cooldowns, and cross-provider avoidance. */
	acquireForRole(
		role: Role,
		opts?: { preferredDriverId?: string; avoidDrivers?: readonly string[]; signal?: AbortSignal },
	): Promise<DriverPoolSelection>;
	/** Record a classified rate-limit or auth error against a driver. */
	reportQuotaError(driverId: string, error: QuotaErrorClass): void;
	/** Clear cooldown state after a successful turn. */
	reportSuccess(driverId: string): void;
	/** Current quota/cooldown status snapshot for all registered drivers. */
	status(): Array<{ driverId: string; kind: DriverKind; state: "healthy" | "cooldown" | "drained"; cooldownUntil?: number; running: number; waiting: number }>;
}
