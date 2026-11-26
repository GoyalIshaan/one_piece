import type { DriverPoolSelection, McpConnectionInfo, QuotaPoolRouter, WorkerSession, WorkerTurnResult } from "./driver.ts";
import type { EventBus } from "./events.ts";
import type { FindingVerifier, ResourceScheduler, SecretBroker } from "./services.ts";
import type { Store } from "./store.ts";
import type {
	AgentRecord,
	ArtifactRecord,
	BoardPost,
	EvidenceLevel,
	Finding,
	JsonSchema,
	Role,
	Run,
	TaskRecord,
	ToolDefinition,
} from "./types.ts";

export interface WorktreeHandle {
	path: string;
	branch: string;
	baseSha: string;
}

export interface WorktreeManager {
	readonly repoRoot: string;
	readonly baseSha: string;
	readonly trunkPath: string;
	create(agentId: string, baseRef?: string): WorktreeHandle;
	commitWip(worktreePath: string, message: string): string | undefined;
	diffStat(worktreePath: string, baseRef?: string): string;
	diffSha(worktreePath: string): string;
	writeGitExclude(worktreePath: string, patterns: readonly string[]): void;
	mergeIntoTrunk(branch: string, opts?: { message?: string }): { ok: boolean; commitSha?: string; error?: string };
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

export interface BoardService {
	publish(input: {
		runId: string;
		authorAgentId: string;
		topic: string;
		summary: string;
		body?: string;
		board?: string;
		references?: Array<{ postId: string; reason: string }>;
		artifactIds?: string[];
		parentPostId?: string;
	}): BoardPost;
	search(runId: string, query: string, opts?: { k?: number; board?: string }): Array<{ post: BoardPost; score: number; citations: number }>;
	visit(postId: string): { post: BoardPost; citedBy: BoardPost[] } | undefined;
	recent(runId: string, limit?: number): BoardPost[];
}

export interface SpawnWorkerRequest {
	role: Role;
	taskId?: string;
	parentAgentId?: string;
	preferredDriverId?: string;
	avoidDrivers?: readonly string[];
	/** Reuse an existing workspace path instead of creating a new git worktree. */
	workspace?: string;
	/** Base git ref to branch the new worktree from (defaults to trunk baseSha). */
	baseRef?: string;
	readOnly?: boolean;
	systemPrompt?: string;
	model?: string;
	maxTurns?: number;
	/** Explicit tool menu exposed to this worker via MCP / in-process bridge. */
	tools?: ToolDefinition[];
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

export interface TopologyOutcome {
	status: "done" | "stopped" | "failed";
	summary: string;
	nominatedFindingId?: string;
	nominatedRevision?: number;
}

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
	createTask(input: { title: string; description: string; role?: Role; dependsOn?: string[]; priority?: number; createdBy: string }): TaskRecord;
	/** Return open tasks whose dependencies are all `done`. */
	readyTasks(): TaskRecord[];
	/** Default role-scoped OS tools (board, artifacts, tasks, findings, jobs, optional spawn). */
	defaultToolsFor(role: Role, opts?: { canSpawn?: boolean; readOnly?: boolean }): ToolDefinition[];
	/** Spawn a bounded worker on the best healthy driver for its role. */
	spawnWorker(req: SpawnWorkerRequest): Promise<WorkerHandle>;
	/** Record an explicit nomination for final run delivery. */
	nominate(findingId: string, revision?: number, auto?: boolean): void;
}

export interface TopologyPlugin {
	readonly name: string;
	readonly description: string;
	run(os: SwarmOsApi, input: { goal: string; rubric?: string; signal: AbortSignal }): Promise<TopologyOutcome>;
}
