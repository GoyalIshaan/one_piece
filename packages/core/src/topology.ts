import type { DriverPoolSelection, DriverTier, McpConnectionInfo, QuotaPoolRouter, WorkerSession, WorkerTurnResult } from "./driver.ts";
import type { EventBus } from "./events.ts";
import type { FindingVerifier, ResourceScheduler, SecretBroker } from "./services.ts";
import type { BoardPostLabelResult, Store } from "./store.ts";
import type {
	AgentRecord,
	ArtifactRecord,
	BoardPost,
	EvidenceLevel,
	Exclusive,
	Finding,
	JsonSchema,
	Role,
	Run,
	RunNomination,
	TaskRecord,
	ToolDefinition,
} from "./types.ts";

export interface WorktreeHandle {
	path: string;
	branch: string;
	baseSha: string;
}

export type MergeTrunkResult =
	| { readonly ok: true; readonly commitSha: string; readonly conflictFiles?: never; readonly error?: never }
	| { readonly ok: false; readonly conflictFiles: string[]; readonly error: string; readonly commitSha?: never };

export interface WorktreeManager {
	readonly repoRoot: string;
	readonly baseSha: string;
	readonly trunkPath: string;
	create(agentId: string, baseRef?: string): WorktreeHandle;
	commitWip(worktreePath: string, message: string): string | undefined;
	headSha(worktreePath: string): string | undefined;
	diffStat(worktreePath: string, baseRef?: string): string;
	diffSha(worktreePath: string): string;
	writeGitExclude(worktreePath: string, patterns: readonly string[]): void;
	mergeIntoTrunk(branch: string, opts?: { message?: string }): MergeTrunkResult;
	mergePreviewDiff(branch: string): { baseSha: string; trunkDiff: string; branchDiff: string };
	resetTrunk?(ref: string): boolean;
	remove(worktreePath: string): void;
}

export interface ArtifactReadPage {
	artifactId: string;
	sha256: string;
	offset: number;
	nextOffset: number;
	totalBytes: number;
	eof: boolean;
	content: string;
}

export interface ArtifactStore {
	put(label: string, content: string | Buffer, opts?: { mimeType?: string; createdBy?: string }): ArtifactRecord;
	preview(record: ArtifactRecord, maxBytes?: number): string;
	read(idOrSha: string, offset?: number, limitBytes?: number): ArtifactReadPage;
	get(idOrSha: string): ArtifactRecord | undefined;
}

export interface McpWorkerRegistration {
	token: string;
	connection: McpConnectionInfo;
	unregister: () => void;
}

export interface McpToolRegistry {
	readonly url: string;
	registerWorker(spec: {
		runId: string;
		agentId: string;
		role: Role;
		workspace?: string;
		tools: ToolDefinition[];
	}): McpWorkerRegistration;
	toolsFor(agentId: string): ToolDefinition[];
	close(): Promise<void>;
}

export interface SubmitFindingInput {
	agentId: string;
	driverId?: string;
	taskId?: string;
	workspace: string;
	findingId?: string;
	claim: string;
	summary: string;
	evidence?: string[];
	level: EvidenceLevel;
	scope?: string;
	score?: number;
	buildsOn?: string[];
}

export interface TrustService {
	readonly verifier?: FindingVerifier;
	submitFinding(input: SubmitFindingInput, signal?: AbortSignal): Promise<Finding>;
	challengeFinding(findingId: string, challengeJson: string, actorId: string, signal?: AbortSignal): Promise<Finding>;
	verifyAndReview(findingId: string, opts?: { runBlindReviewer?: boolean; signal?: AbortSignal }): Promise<Finding>;
	bestVerifiedFinding(runId: string): { finding: Finding; revision: number } | undefined;
	drainPending(): Promise<void>;
}

export interface BoardPublishInput {
	runId: string;
	authorAgentId: string;
	authorHandle?: string;
	topic: string;
	summary: string;
	body?: string;
	board?: string;
	references?: Array<{ postId: string; reason: string }>;
	artifactIds?: string[];
	parentPostId?: string;
	threadId?: string;
	labels?: Record<string, string>;
	supersedes?: string;
	ifLatestId?: string;
	idempotencyKey?: string;
	/** Only OS subsystems (TrustLayer, Refinery, SwarmOS) may set reserved `os:*` / `verified` labels. */
	isOsActor?: boolean;
}

export interface BoardQueryOptions {
	query?: string;
	k?: number;
	offset?: number;
	board?: string;
	topic?: string;
	threadId?: string;
	labels?: readonly string[];
	afterSeq?: number;
	includeSuperseded?: boolean;
}

export interface BoardTopicSummary {
	topic: string;
	count: number;
	latestSeq: number;
}

export interface BoardSearchHit {
	post: BoardPost;
	score: number;
	citations: number;
}

export interface BoardQueryResult {
	hits: BoardSearchHit[];
	totalMatches: number;
	cursor: number;
	topics: BoardTopicSummary[];
}

export interface BoardThreadView {
	root: BoardPost;
	replies: BoardPost[];
	earlierReplies: number;
	newestId: string;
	cursor: number;
}

export interface BoardLabelInput {
	set?: Record<string, string>;
	unset?: readonly string[];
	ifMatch?: Record<string, string | null>;
	actorId: string;
	isOsActor?: boolean;
}

export interface BoardWaitOptions {
	afterSeq?: number;
	board?: string;
	topic?: string;
	threadId?: string;
	labels?: readonly string[];
	minPosts?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export type BoardWaitResult = Exclusive<
	| {
		readonly status: "matched";
		readonly timedOut: false;
		readonly posts: [BoardPost, ...BoardPost[]];
		readonly cursor: number;
		readonly topics: BoardTopicSummary[];
	}
	| {
		readonly status: "timed_out" | "aborted";
		readonly timedOut: true;
		readonly posts: BoardPost[];
		readonly cursor: number;
		readonly topics: BoardTopicSummary[];
	}
>;

export interface BoardService {
	publish(input: BoardPublishInput): BoardPost;
	search(runId: string, query: string, opts?: { k?: number; board?: string }): BoardSearchHit[];
	query(runId: string, opts?: BoardQueryOptions): BoardQueryResult;
	topics(runId: string, board?: string): BoardTopicSummary[];
	visit(postId: string): { post: BoardPost; citedBy: BoardPost[]; replies?: BoardPost[]; newestId?: string; cursor?: number } | undefined;
	thread(postId: string, opts?: { latest?: number }): BoardThreadView | undefined;
	label(postId: string, input: BoardLabelInput): BoardPostLabelResult;
	digest(runId: string, board?: string): string;
	wait(runId: string, opts?: BoardWaitOptions): Promise<BoardWaitResult>;
	recent(runId: string, limit?: number): BoardPost[];
}

export interface ToolScope {
	/** Shared ScaleMAS board tool exposure (default "read-write"). */
	board?: "none" | "read" | "read-write";
	/** Expose `read_artifact` (default true). */
	artifacts?: boolean;
	/** Expose `report_finding` for write workers (default !readOnly). */
	findings?: boolean;
	/** Expose `nominate` for write workers (default !readOnly when no scope specified). */
	nominate?: boolean;
	/** Expose `claim_task` / `complete_task` (default !readOnly when no scope specified). */
	tasks?: boolean;
	/** Resource-pool scheduler tools: "auto" exposes only when non-default compute pools exist. */
	scheduler?: "auto" | "always" | "never";
	/** Explicitly opt into async recursive spawning (`spawn_task`). */
	canSpawn?: boolean;
	/** Read-only worker flag. */
	readOnly?: boolean;
	/** Expose `load_skill` when on-demand skills exist (default true). */
	skills?: boolean;
	/** Skill names already pre-bound into the static prompt (excluded from on-demand catalog). */
	excludeSkills?: readonly string[];
	/** Expose sandboxed coordinator Code Mode (`run_swarm_script`, default false). */
	codeMode?: boolean;
	/** Expose disposable read-only `delegate_explore` sidekick tool (default true for planner/integrator/root). */
	sidekick?: boolean;
	/** Optional extended/overflow tools exposed via `.swarm/tools/` + frozen `call_tool` dispatcher. */
	extendedTools?: ToolDefinition[];
	/** Include local workspace tools (automatically true for `pi-in-process`). */
	includeWorkspaceTools?: boolean;
}

export interface SpawnWorkerRequest {
	role: Role;
	/** Optional OS-assigned readable handle (e.g. "peer-1", "integrator") shown on board posts. */
	handle?: string;
	taskId?: string;
	parentAgentId?: string;
	preferredDriverId?: string;
	avoidDrivers?: readonly string[];
	/** Minimum capability tier for driver selection (e.g. "frontier"). */
	minTier?: DriverTier;
	/** Maximum capability tier for driver selection (e.g. "sidekick"). */
	maxTier?: DriverTier;
	/** Reuse an existing workspace path instead of creating a new git worktree. */
	workspace?: string;
	/** Base git ref to branch the new worktree from (defaults to trunk baseSha). */
	baseRef?: string;
	/** Paths this worker process must be kernel-blocked from reading (Seatbelt). */
	deniedReadPaths?: readonly string[];
	readOnly?: boolean;
	systemPrompt?: string;
	model?: string;
	maxTurns?: number;
	/** Explicit tool menu exposed to this worker via MCP / in-process bridge. */
	tools?: ToolDefinition[];
	/** Declarative topology/role tool scoping (preferred over full 12-tool default menu). */
	toolScope?: ToolScope;
	/** Explicit curated skill names to pre-bind into this worker's static prompt. */
	skills?: string[];
	/** Stable KV prompt cache key shared across sibling workers of the same role. */
	cacheKeyPrefix?: string;
	/** Explicitly opt into async recursive spawning (default false to prevent Double-Harness Collision). */
	canSpawn?: boolean;
}

export interface WorkerHandle {
	readonly agent: AgentRecord;
	readonly workspace: string;
	readonly branch?: string;
	readonly session: WorkerSession;
	readonly selection: DriverPoolSelection;
	/** Execute a turn with automatic Class-1 backoff and Class-2 cross-provider worktree failover! */
	runTurn(prompt: string, opts?: { signal?: AbortSignal; outputSchema?: JsonSchema; timeoutMs?: number }): Promise<WorkerTurnResult>;
	steer?(message: string): Promise<void>;
	interrupt?(): Promise<void>;
	close(): Promise<void>;
}

export type TopologyOutcome = {
	readonly status: "done" | "stopped" | "failed";
	readonly summary: string;
} & RunNomination;

export interface SwarmOsApi {
	readonly runId: string;
	readonly runDir: string;
	readonly bus: EventBus;
	readonly store: Store;
	readonly worktrees: WorktreeManager;
	readonly artifacts: ArtifactStore;
	readonly board: BoardService;
	readonly scheduler: ResourceScheduler;
	readonly secrets: SecretBroker;
	readonly trust: TrustService;
	readonly router: QuotaPoolRouter;
	readonly mcp: McpToolRegistry;
	run(): Run;
	/** Check remaining wall-clock/token/USD fraction (0..1); returns true once reserve threshold is reached. */
	isInCloseoutReserve(): boolean;
	/** Create a new task on the shared task table. */
	createTask(input: {
		title: string;
		description: string;
		role?: Role;
		dependsOn?: string[];
		ownedPaths?: string[];
		acceptanceCriteria?: string[];
		priority?: number;
		createdBy: string;
	}): TaskRecord;
	/** Return open tasks whose dependencies are all `done`. */
	readyTasks(): TaskRecord[];
	/** Default role-scoped OS tools (board, artifacts, tasks, findings, jobs, optional spawn/skills/codeMode). */
	defaultToolsFor(role: Role, opts?: ToolScope): ToolDefinition[];
	/** Spawn a bounded worker on the best healthy driver for its role. */
	spawnWorker(req: SpawnWorkerRequest): Promise<WorkerHandle>;
	/** Record an explicit nomination for final run delivery. */
	nominate(findingId: string, revision?: number, auto?: boolean): void;
	/** Path to the run's line-budgeted stigmergic field guide (`.swarm/field-guide/index.md` source). */
	readonly fieldGuidePath?: string;
	/** Current immutable KV-cache-safe wave snapshot of the field guide. */
	fieldGuideSnapshot?(): string;
	/** Wave-boundary dreaming: consolidate board posts, verifier receipts, and handoffs into <= 80 lines. */
	consolidateFieldGuide?(opts?: { mode?: "deterministic" | "llm" }): Promise<{ lines: number; bytes: number; path: string }>;
}

export interface TopologyPlugin {
	readonly name: string;
	readonly description: string;
	run(os: SwarmOsApi, input: { goal: string; rubric?: string; signal: AbortSignal }): Promise<TopologyOutcome>;
}
