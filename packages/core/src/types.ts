// Shared v2 vocabulary for one_piece. Zero LLM-SDK or Pi imports live in core.

export type Role = "planner" | "worker" | "explorer" | "integrator" | "reviewer" | "leaf" | "root" | (string & {});

export type AgentStatus = "pending" | "running" | "parked" | "done" | "stalled" | "failed" | "stopped";

export const TERMINAL_AGENT_STATUSES: readonly AgentStatus[] = ["done", "stalled", "failed", "stopped"];

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
}

export interface Run {
	id: string;
	topology: string;
	goal: Goal;
	budget: BudgetVector;
	spent: BudgetVector;
	workspace?: string;
	baseCommitSha?: string;
	status: "running" | "closing" | "done" | "stopped" | "failed";
	statusReason?: string;
	nominatedFindingId?: string;
	nominatedRevision?: number;
	config: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}

export interface AgentRecord {
	id: string;
	runId: string;
	handle: string;
	role: Role;
	driverId: string;
	model?: string;
	sessionId?: string;
	parentAgentId?: string;
	taskId?: string;
	workspace?: string;
	branch?: string;
	status: AgentStatus;
	statusReason?: string;
	turns: number;
	spent: BudgetVector;
	summary?: string;
	createdAt: number;
	updatedAt: number;
}

export type TaskStatus = "open" | "claimed" | "done" | "blocked" | "failed" | "cancelled";

export interface TaskRecord {
	id: string;
	runId: string;
	title: string;
	description: string;
	role?: Role;
	status: TaskStatus;
	dependsOn: string[];
	/** Atomic lease ownership with monotonic fencing token (prevents split-brain merges). */
	leaseOwner?: string;
	leaseExpiresAt?: number;
	fencingToken: number;
	result?: string;
	artifactIds?: string[];
	findingId?: string;
	priority?: number;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
}

export interface BoardReference {
	postId: string;
	reason: string;
}

export interface BoardPost {
	id: string;
	runId: string;
	board?: string;
	topic: string;
	authorAgentId: string;
	summary: string;
	body: string;
	references?: BoardReference[];
	artifactIds?: string[];
	parentPostId?: string;
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

export interface VerificationReceipt {
	checker: string;
	version: string;
	kind: "suite" | "counterexample";
	durationMs?: number;
	status: "passed" | "failed" | "error" | "invalid";
	message: string;
	counterexample?: string;
}

export interface FindingSubmission {
	revision: number;
	claim: string;
	summary: string;
	evidence: string[];
	level: EvidenceLevel;
	scope?: string;
	artifactSha256?: string;
	snapshotDir?: string;
	snapshotNote?: string;
	verifier?: { name: string; version: string };
	score?: number;
	checks: VerificationReceipt[];
	at: number;
}

export interface ReviewRound {
	round: number;
	revision: number;
	reviewerAgentId: string;
	reviewerDriverId?: string;
	verdict: "accepted" | "rejected" | "needs_work";
	message: string;
	confidence?: number;
	checksRun: string[];
	at: number;
}

export type FindingStatus = "pending_review" | "accepted" | "rejected" | "needs_work" | "unreviewed";

export interface Finding {
	id: string;
	runId: string;
	authorAgentId: string;
	authorDriverId?: string;
	taskId?: string;
	claim: string;
	summary: string;
	evidence: string[];
	level: EvidenceLevel;
	status: FindingStatus;
	confidence?: number;
	score?: number;
	submissions: FindingSubmission[];
	rounds: ReviewRound[];
	buildsOn: string[];
	reviewError?: string;
	retryAfter?: number;
	createdAt: number;
	updatedAt: number;
}

export interface Report {
	id: string;
	runId: string;
	kind: "final" | "interim" | "handoff";
	title: string;
	markdown: string;
	nominatedFindingId?: string;
	nominatedRevision?: number;
	createdAt: number;
}

export interface ProviderQuotaRecord {
	id: string;
	runId?: string;
	driverId: string;
	state: "healthy" | "cooldown" | "drained";
	cooldownUntil?: number;
	reason?: string;
	consecutiveErrors: number;
	updatedAt: number;
}

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

type UnionKeys<U> = U extends unknown ? keyof U : never;
type Exclusive<U, Keys extends PropertyKey = UnionKeys<U>> =
	U extends unknown ? U & { readonly [K in Exclude<Keys, keyof U>]?: never } : never;

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
