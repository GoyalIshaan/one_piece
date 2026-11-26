// Shared v2 vocabulary for one_piece. Zero LLM-SDK or Pi imports live in core.

export type UnionKeys<U> = U extends unknown ? keyof U : never;
export type Exclusive<U, Keys extends PropertyKey = UnionKeys<U>> =
	U extends unknown ? U & { readonly [K in Exclude<Keys, keyof U>]?: never } : never;

/** Exhaustiveness helper: fails at compile time if any discriminated union branch is unhandled. */
export function assertNever(value: never, context = "Unexpected variant"): never {
	throw new Error(`${context}: ${JSON.stringify(value)}`);
}

export type Role = "planner" | "worker" | "explorer" | "integrator" | "reviewer" | "leaf" | "root";

export type TerminalAgentStatus = "done" | "stalled" | "failed" | "stopped";
export type AgentStatus = "pending" | "running" | "parked" | TerminalAgentStatus;

export const TERMINAL_AGENT_STATUSES: readonly TerminalAgentStatus[] = ["done", "stalled", "failed", "stopped"];

export type BudgetVector = Record<string, number>;

export type EvidenceLevel =
	| "formal_proof"
	| "exact_check"
	| "empirical"
	| "conditional"
	| "hypothesis"
	| "external_acceptance";

export const EVIDENCE_LEVELS: readonly EvidenceLevel[] = [
	"formal_proof",
	"exact_check",
	"empirical",
	"conditional",
	"hypothesis",
	"external_acceptance",
];

export interface Goal {
	title: string;
	text: string;
	rubric?: string;
	targets?: string[];
	deliverable?: string;
	boundaries?: string;
}

export interface UsageRecord {
	inputTokens?: number;
	cachedTokens?: number;
	cacheWriteTokens?: number;
	outputTokens?: number;
	reasoningTokens?: number;
	totalTokens?: number;
	usd?: number;
	durationMs?: number;
	/** Explicit tri-state indicators distinguishing "provider reported 0" from "omitted". */
	cacheReadReported?: boolean;
	cacheWriteReported?: boolean;
	reasoningReported?: boolean;
}

interface RunFields {
	id: string;
	topology: string;
	goal: Goal;
	budget: BudgetVector;
	spent: BudgetVector;
	workspace?: string;
	baseCommitSha?: string;
	config: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}

export type RunPhase = Exclusive<
	| { readonly status: "running" }
	| { readonly status: "closing"; readonly statusReason?: string }
	| { readonly status: "done" | "stopped" | "failed"; readonly statusReason: string }
>;

export type RunNomination =
	| { readonly nominatedFindingId: string; readonly nominatedRevision: number }
	| { readonly nominatedFindingId?: never; readonly nominatedRevision?: never };

export type Run = RunFields & RunPhase & RunNomination;

interface AgentFields {
	id: string;
	runId: string;
	handle: string;
	role: Role;
	driverId: string;
	model?: string;
	sessionId?: string;
	parentAgentId?: string;
	/** Subtree root identifier used to scope Board v2 epistemic digests cleanly at high parallelism. */
	subtreeId?: string;
	/** Recursive depth in the Planner/Worker search forest (0 = root). */
	depth?: number;
	taskId?: string;
	workspace?: string;
	branch?: string;
	turns: number;
	spent: BudgetVector;
	summary?: string;
	createdAt: number;
	updatedAt: number;
}

export type AgentPhase = Exclusive<
	| { readonly status: "pending" | "running" }
	| { readonly status: "parked" | "done" | "stopped"; readonly statusReason?: string }
	| { readonly status: "stalled" | "failed"; readonly statusReason: string }
>;

export type AgentRecord = AgentFields & AgentPhase;

export type TaskStatus = "open" | "claimed" | "done" | "blocked" | "failed" | "cancelled";

interface TaskFields {
	id: string;
	runId: string;
	title: string;
	description: string;
	role?: Role;
	dependsOn: string[];
	/** Monotonic fencing token (incremented on every lease acquisition; prevents split-brain merges). */
	fencingToken: number;
	/** Disjoint workspace file/directory prefixes owned by this ticket (prevents split-brain edits). */
	ownedPaths?: string[];
	/** Concrete acceptance criteria pinned across compaction & handoffs. */
	acceptanceCriteria?: string[];
	result?: string;
	artifactIds?: string[];
	findingId?: string;
	priority?: number;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
}

export type TaskPhase = Exclusive<
	| { readonly status: "open" }
	| { readonly status: "claimed"; readonly leaseOwner: string; readonly leaseExpiresAt: number }
	| { readonly status: "done" | "blocked" | "failed" | "cancelled"; readonly completedBy?: string }
>;

export type TaskRecord = TaskFields & TaskPhase;
export type ClaimedTaskRecord = Extract<TaskRecord, { status: "claimed" }>;

export type BoardPostKind = "discovery" | "hypothesis" | "counterexample" | "dead_end" | "bound_estimate" | "update";
export type BoardVisibility = "subtree" | "global";

export interface BoardReference {
	postId: string;
	reason: string;
}

export interface BoardPost {
	id: string;
	runId: string;
	board?: string;
	topic: string;
	/** Typed epistemic claim classification on the shared knowledge DAG. */
	kind?: BoardPostKind;
	/** Subtree root identifier of the author (enables low-noise local digests). */
	subtreeId?: string;
	/** Two-tier visibility: subtree-local by default for workers, promoted to global by Decision Model triage. */
	visibility?: BoardVisibility;
	authorAgentId: string;
	authorHandle?: string;
	summary: string;
	body: string;
	references?: BoardReference[];
	artifactIds?: string[];
	parentPostId?: string;
	threadId?: string;
	labels?: Record<string, string>;
	supersedes?: string;
	supersededBy?: string;
	seq?: number;
	idempotencyKey?: string;
	createdAt: number;
}

export interface ArtifactRecord {
	id: string;
	runId: string;
	sha256: string;
	label: string;
	mimeType: string;
	bytes: number;
	path: string;
	createdBy?: string;
	createdAt: number;
}

export type VerificationReceipt = {
	checker: string;
	version: string;
	kind: "suite" | "counterexample";
	durationMs?: number;
	message: string;
	score?: number;
} & Exclusive<
	| { readonly status: "passed" }
	| { readonly status: "failed"; readonly counterexample?: string }
	| { readonly status: "error" | "invalid" }
>;

export type SnapshotState =
	| { readonly artifactSha256: string; readonly snapshotDir: string; readonly snapshotNote?: never }
	| { readonly artifactSha256?: never; readonly snapshotDir?: never; readonly snapshotNote: string };

export type FindingSubmission = {
	revision: number;
	claim: string;
	summary: string;
	evidence: string[];
	level: EvidenceLevel;
	scope?: string;
	verifier?: { name: string; version: string };
	/** Content-addressed git tree hash (`HEAD^{tree}`) for basin deduplication. */
	treeSha?: string;
	score?: number;
	checks: VerificationReceipt[];
	at: number;
} & SnapshotState;

export type ReviewLens = "executable" | "blind-diff" | "transcript-audit";

export interface ReviewRound {
	round: number;
	revision: number;
	reviewerAgentId: string;
	reviewerDriverId?: string;
	lens?: ReviewLens;
	verdict: "accepted" | "rejected" | "needs_work";
	message: string;
	confidence?: number;
	/** Distinguishes clean structured JSON verdicts from fail-closed heuristic fallbacks. */
	parseStatus?: "parsed" | "fallback_failed_closed";
	checksRun: string[];
	at: number;
}

export type FindingStatus = "pending_review" | "accepted" | "rejected" | "needs_work" | "unreviewed";

interface FindingFields {
	id: string;
	runId: string;
	authorAgentId: string;
	authorDriverId?: string;
	taskId?: string;
	claim: string;
	summary: string;
	evidence: string[];
	level: EvidenceLevel;
	score?: number;
	submissions: FindingSubmission[];
	rounds: ReviewRound[];
	buildsOn: string[];
	createdAt: number;
	updatedAt: number;
}

export type FindingPhase = Exclusive<
	| { readonly status: "pending_review" }
	| { readonly status: "accepted" | "rejected" | "needs_work"; readonly confidence?: number }
	| { readonly status: "unreviewed"; readonly reviewError: string; readonly retryAfter?: number }
>;

export type Finding = FindingFields & FindingPhase;

export type Report = {
	id: string;
	runId: string;
	kind: "final" | "interim" | "handoff";
	title: string;
	markdown: string;
	createdAt: number;
} & RunNomination;

interface ProviderQuotaFields {
	id: string;
	runId?: string;
	driverId: string;
	consecutiveErrors: number;
	updatedAt: number;
}

export type ProviderQuotaPhase = Exclusive<
	| { readonly state: "healthy" }
	| { readonly state: "cooldown"; readonly cooldownUntil: number; readonly reason: string }
	| { readonly state: "drained"; readonly reason: string }
>;

export type ProviderQuotaRecord = ProviderQuotaFields & ProviderQuotaPhase;

// --- Scheduler Job Types (preserved for compatibility with packages/scheduler) ---

export type JobStatus = JobPhase["status"];

interface JobSpecFields {
	pool: string;
	command: string;
	label?: string;
	cwd?: string;
	inputs?: string[];
	units?: number;
	exclusive?: boolean;
	timeoutSeconds?: number;
	capabilities?: string[];
	gate?: string;
	compilerSmoke?: boolean;
	cache?: boolean;
	idempotencyKey?: string;
}

export type JobSpec = JobSpecFields & (
	| { readonly requireOutputs: true; readonly outputFiles: [string, ...string[]] }
	| { readonly requireOutputs?: false; readonly outputFiles?: string[] }
);

export interface HostProcessSnapshot {
	sampledAt: number;
	readable: boolean;
	processCount: number;
	executableNames: string[];
	matches: Array<{ pid: number; executable: string }>;
}

export type JobOutputFile = { path: string } & (
	| { readonly bytes: number; readonly sha256: string; readonly status?: never }
	| { readonly status: "missing" | "unavailable" | "too_large" | "changed" | "stale"; readonly bytes?: never; readonly sha256?: never }
);

interface JobFields {
	id: string;
	runId: string;
	nodeId: string;
	taskId?: string;
	resumesJobId?: string;
	workingDirectory?: string;
	spec: JobSpec;
	cacheKey: string;
	stdout?: string;
	stderr?: string;
	unitsUsed?: number;
	queuedAt: number;
	receipt?: {
		inputHashes: Record<string, string>;
		inputHashAlgorithm?: "sha256" | "sha256-base64";
		host: string;
		durationMs: number;
		toolchain?: Record<string, string>;
		hostProcessSnapshot?: HostProcessSnapshot;
		outputFiles?: JobOutputFile[];
	};
}

type FailureTiming =
	| { readonly failureStage: "admission" | "gate"; readonly startedAt?: never }
	| { readonly failureStage: "execution"; readonly startedAt: number }
	| { readonly failureStage?: "interrupted"; readonly startedAt?: number };

export type JobPhase = Exclusive<
	| { readonly status: "queued" }
	| { readonly status: "gated" }
	| { readonly status: "leasing" }
	| { readonly status: "running"; readonly startedAt: number }
	| { readonly status: "succeeded" | "cached"; readonly startedAt: number; readonly finishedAt: number; readonly exitCode: 0 }
	| ({ readonly status: "failed"; readonly finishedAt: number; readonly exitCode?: number; readonly failureDetail?: string } & FailureTiming)
	| ({ readonly status: "cancelled"; readonly finishedAt: number } & (
		| ({ readonly withdrawal?: never; readonly exitCode?: number; readonly failureDetail?: string } & FailureTiming)
		| { readonly withdrawal: { reason: string; reusedJobId?: string }; readonly startedAt?: never;
			readonly exitCode?: never; readonly failureStage?: never; readonly failureDetail?: never }
	))
>;

export type Job = JobFields & (
	| (Extract<JobPhase, { status: "gated" }> & { spec: JobSpec & ({ gate: string } | { compilerSmoke: true }) })
	| Exclude<JobPhase, { status: "gated" }>
);

export type FinishedJob = Extract<Job, { finishedAt: number }>;

export function isFinishedJob(job: Job): job is FinishedJob {
	return job.finishedAt !== undefined;
}

// --- Runtime-Agnostic Tool Definitions (JSON Schema, zero Pi coupling) ---

export interface JsonSchema {
	type?: string | string[];
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: unknown[];
	additionalProperties?: boolean | JsonSchema;
	default?: unknown;
	minimum?: number;
	maximum?: number;
	[key: string]: unknown;
}

export interface ToolContext {
	readonly runId: string;
	readonly agentId: string;
	readonly role: Role;
	readonly workspace?: string;
	readonly signal: AbortSignal;
}

export interface ToolResult {
	text: string;
	isError?: boolean;
	data?: Record<string, unknown>;
}

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: JsonSchema;
	execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}
