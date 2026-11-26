import type { EventBus } from "./events.ts";
import type { Exclusive, JsonSchema, Role, ToolDefinition, UsageRecord } from "./types.ts";

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

export type DriverTier = "sidekick" | "standard" | "frontier";

export interface CompactionEvent {
	strategy: "micro" | "anchor";
	beforeTokens: number;
	afterTokens: number;
	prunedCount: number;
	compactionCount: number;
}

export interface WorkerCompactionPolicy {
	/** Context-window fraction at which Tier 1 compaction fires (default 0.70). */
	watermarkFraction?: number;
	/** Keep the most recent N turns verbatim during micro-compaction (default 6). */
	keepRecentTurns?: number;
	/** Minimum tool-result bytes eligible for micro-compaction spillover (default 1024). */
	minPruneBytes?: number;
	/** After this many compactions in one session, signal Tier 2 Clean-Slate Handoff (default 2). */
	maxCompactionsBeforeHandoff?: number;
	/** Acceptance criteria & owned paths pinned verbatim into structured compaction anchors. */
	pinnedChecklist?: string[];
	/** Artifact store hook used to spill pruned tool outputs losslessly. */
	spillArtifact?: (label: string, content: string) => { id: string; sha256: string };
	/** Callback invoked whenever Tier 1 compaction runs. */
	onCompacted?: (event: CompactionEvent) => void;
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
	/** Stable prefix key for KV prompt caching (defaults to role/agent key). */
	cacheKeyPrefix?: string;
	/** Optional Tier 1/2 context compaction policy (used by in-process drivers). */
	compaction?: WorkerCompactionPolicy;
	/** Local MCP bus coordinates for external CLI workers. */
	mcp?: McpConnectionInfo;
	/** Direct tool definitions for in-process drivers (PiInProcessDriver). */
	tools?: ToolDefinition[];
	/** Paths this worker process (and any child commands) must be kernel-blocked from reading (e.g. hidden grader / sibling private shards). */
	deniedReadPaths?: readonly string[];
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

interface WorkerTurnBase {
	finalText: string;
	sessionId?: string;
	model?: string;
	usage?: UsageRecord;
}

export type WorkerTurnResult = WorkerTurnBase & Exclusive<
	| {
		readonly status: "completed" | "yielded" | "interrupted";
		/** Set when Tier 1 compaction hit its rollover limit and Tier 2 Clean-Slate Handoff is advised. */
		readonly needsHandoff?: boolean;
		/** Structured negative results captured during the turn/compaction for clean-slate handoffs. */
		readonly failedApproaches?: string[];
	}
	| {
		readonly status: "rate_limited";
		readonly quotaError: QuotaErrorClass;
		readonly error: string;
		readonly failedApproaches?: string[];
	}
	| {
		readonly status: "failed";
		readonly error: string;
		readonly needsHandoff?: boolean;
		readonly failedApproaches?: string[];
	}
>;

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
	/** Capability/cost tier used for cache-free escalation & sidekick delegation (default "standard"). */
	tier?: DriverTier;
	/** Executable override (defaults to `codex`, `grok`, `gemini`). */
	binary?: string;
	/** Default model ID for this driver (optional; uses CLI default if omitted). */
	model?: string;
	/** Max concurrent workers allowed on this subscription/provider (default 2 for subs). */
	maxConcurrent?: number;
	/** Keep consumer subscription billing by unsetting API key env vars (default true for CLIs). */
	subscriptionMode?: boolean;
	/** Isolate CLI workers from personal MCPs, plugins, hooks, and ambient skills (default true for CLIs). */
	cleanWorkerEnv?: boolean;
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
	getDriverTier?(driverId: string): DriverTier;
	getDriverConfig?(driverId: string): DriverConfig | undefined;
	healthCheckAll(): Promise<DriverHealth[]>;
	/** Acquire a healthy driver for a role, respecting concurrency permits, tiers, cooldowns, and cross-provider avoidance. */
	acquireForRole(
		role: Role,
		opts?: {
			preferredDriverId?: string;
			avoidDrivers?: readonly string[];
			minTier?: DriverTier;
			maxTier?: DriverTier;
			/** Prefer drivers whose `capabilities.supportsOutputSchema` is true (graceful fallback if none). */
			requireOutputSchema?: boolean;
			signal?: AbortSignal;
		},
	): Promise<DriverPoolSelection>;
	/** Record a classified rate-limit or auth error against a driver. */
	reportQuotaError(driverId: string, error: QuotaErrorClass): void;
	/** Clear cooldown state after a successful turn. */
	reportSuccess(driverId: string): void;
	/** Current quota/cooldown status snapshot for all registered drivers. */
	status(): Array<{ driverId: string; kind: DriverKind; state: "healthy" | "cooldown" | "drained"; cooldownUntil?: number; running: number; waiting: number }>;
}
