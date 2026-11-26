// Canonical contracts for Layer E (`@one-piece/eval-lab`).
// Zero Pi imports, zero external npm dependencies, and zero coupling to v1 or v2 engine internals.

export type TaskFamily = "coupled-swe" | "info-routing" | "scalar-optimization" | "mixed-phase";

export type ControlRung = "solo" | "silent_bon" | "scripted_dag" | "swarm";

export type BudgetMode = "tokens" | "wall_clock";

export type EvalSandboxProfile = "eval-offline" | "eval-isolated-shards";

export type HarnessFaultCode =
	| "TOKEN_LEDGER_MISMATCH"
	| "SILENT_PATCH_NOOP"
	| "SANDBOX_BREACH"
	| "STALE_VERDICT_APPLIED"
	| "ORPHAN_ACTIVE_AGENT"
	| "MISSING_TERMINAL_EVENT"
	| "DUPLICATE_JOB_CHARGE"
	| "PROVIDER_AUTH_FAILURE"
	| "RUNNER_CRASH";

export interface HarnessFault {
	code: HarnessFaultCode;
	message: string;
	seq?: number;
}

export interface RunBudget {
	tokens?: number;
	usd?: number;
	wallClockMs?: number;
	cpuSeconds?: number;
}

export interface PreparedTask {
	taskId: string;
	seed: number;
	n: number;
	options: Record<string, string>;
	workspaceDir: string;
	hiddenDir: string;
	/** Per-seat private shard directories for asymmetric-information tasks. */
	privateShards?: readonly string[];
	goal: string;
	rubric?: string;
	fixtureSha256: string;
	graderSha256: string;
	incumbentScore?: number;
	sandboxProfile: EvalSandboxProfile;
}

export interface GradeReport {
	passed: boolean;
	/** Normalized [0, 1] when bounded, or continuous objective for optimization tasks. */
	score: number;
	customMetrics: Record<string, number | string | boolean>;
	details: string;
}

export interface PublicCheckResult {
	passed: boolean;
	score: number;
	details: string;
}

export interface EvalTask {
	readonly id: string;
	readonly title: string;
	readonly family: TaskFamily;
	readonly supportedN: readonly number[];
	readonly defaultOptions?: Record<string, string>;
	readonly higherIsBetter?: boolean;

	prepare(ctx: {
		seed: number;
		n: number;
		options: Record<string, string>;
		workDir: string;
		hiddenDir: string;
	}): Promise<PreparedTask>;

	/**
	 * Public-only check available to online verifiers and `silent_bon` selection.
	 * MUST NEVER read `hiddenDir` or hidden ground-truth answer keys.
	 */
	publicCheck?(ctx: {
		artifactDir: string;
		seed: number;
		n: number;
		options: Record<string, string>;
	}): Promise<PublicCheckResult>;

	grade(ctx: {
		artifactDir: string;
		hiddenDir: string;
		seed: number;
		n: number;
		options: Record<string, string>;
	}): Promise<GradeReport>;

	/**
	 * Produce a known-good reference artifact in `outDir` using `hiddenDir`.
	 * Used exclusively by the zero-cost calibration gate (never exposed to agents).
	 */
	buildReferenceArtifact?(ctx: {
		prepared: PreparedTask;
		outDir: string;
	}): Promise<void>;

	/**
	 * Produce a deliberately broken/naive-merge artifact in `outDir` for calibration.
	 * Returns `false` if semantic interference is disabled for the current options (e.g. `coupling=low`).
	 */
	buildSemanticInterferenceArtifact?(ctx: {
		prepared: PreparedTask;
		outDir: string;
	}): Promise<boolean | void>;
}

export type AgentRoleCategory = "worker" | "coordinator" | "reviewer" | "refinery";

export interface CanonicalEvent {
	seq: number;
	ts: number;
	runId: string;
	type: string;
	agentId?: string;
	role?: AgentRoleCategory;
	causalParents?: readonly string[];
	idempotencyKey?: string;
	data: Record<string, unknown>;
}

export interface CandidateSnapshot {
	id: string;
	agentId: string;
	dir: string;
	sha256: string;
	atTokens: number;
	atWallMs: number;
	acceptedByVerifier: boolean;
	revision?: number;
	findingId?: string;
}

export interface HarnessRunSpec {
	runId: string;
	runDir: string;
	dbPath: string;
	taskId: string;
	seed: number;
	goal: string;
	rubric?: string;
	workspaceDir: string;
	privateShards?: readonly string[];
	/** Assigned seat index (0-based) for single-seat runs on sharded tasks. */
	seatIndex?: number;
	/** Total seat count of the prepared task instance (may exceed swarmSize for solo arms). */
	totalSeats?: number;
	hiddenDenyPaths: readonly string[];
	controlRung: ControlRung;
	topology?: string;
	swarmSize: number;
	budget: RunBudget;
	budgetMode: BudgetMode;
	autoNominate: boolean;
	sandboxProfile: EvalSandboxProfile;
	taskOptions?: Record<string, string>;
	/** Optional counterfactual injection applied at start or fork point. */
	injectedPrompt?: string;
}

export type ReceiptNomination =
	| {
		readonly nominatedArtifactDir: string;
		readonly nominatedSha256: string;
		readonly nominatedAtTokens?: number;
		readonly nominatedAtWallMs?: number;
		readonly autoNominated: boolean;
	}
	| {
		readonly nominatedArtifactDir?: never;
		readonly nominatedSha256?: never;
		readonly nominatedAtTokens?: never;
		readonly nominatedAtWallMs?: never;
		readonly autoNominated: false;
	};

export type HarnessRunReceipt = {
	readonly runId: string;
	readonly status: "done" | "stopped" | "failed" | "timeout";
	readonly candidateSnapshots: readonly CandidateSnapshot[];
	readonly harnessFaults: readonly HarnessFault[];
	readonly driverIds?: readonly string[];
	readonly modelIds?: readonly string[];
} & ReceiptNomination;

export interface HarnessAdapter {
	readonly name: string;
	run(spec: HarnessRunSpec, signal?: AbortSignal): Promise<HarnessRunReceipt>;
}

export interface AnytimePoint {
	atTokens: number;
	atWallMs: number;
	bestOfflineScore: number;
	nominatedScore: number;
	bestOfflinePassed: boolean;
	nominatedPassed: boolean;
}

export interface LossDecomposition {
	/** Gap between oracle/target ceiling and best candidate ever produced by any agent. */
	discoveryLoss: number;
	/** Gap between best candidate produced anywhere and the actually nominated artifact. */
	nominationLoss: number;
	/** Fraction of verifier-accepted submissions that failed the held-out grader. */
	falseCertificationRate: number;
	/** Tokens burned after the highest verified candidate was already achieved. */
	postOptimumTokens: number;
	/** Share of total tokens burned after the highest verified candidate. */
	stoppingWasteShare: number;
}

export interface TokenBreakdown {
	total: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheHitRate?: number;
	reasoning: number;
	peakInputPerCall: number;
	estimatedUsd: number;
	byRole: Record<AgentRoleCategory, number>;
	byCategory: {
		work: number;
		coordination: number;
		verification: number;
		other: number;
	};
	coordinationTokenShare: number;
}

export interface TimeComputeBreakdown {
	wallClockMs: number;
	llmWaitMs: number;
	quotaWaitMs: number;
	toolExecMs: number;
	graderComputeMs: number;
	cpuSeconds: number;
	gpuSeconds: number;
	timeToFirstValidMs: number | null;
	timeToNominationMs: number | null;
}

export interface SwarmDynamics {
	swarmSize: number;
	agentCount: number;
	avgParallelism: number;
	peakParallelism: number;
	modelCalls: number;
	modelErrors: number;
	toolCalls: number;
	toolErrors: number;
	toolErrorRate: number;
	toolCallsByName: Record<string, number>;
	messageCount: number;
	messageBytes: number;
	compactions: number;
	artifactReads: number;
	stallDetections: number;
	failoverCount: number;
	skillsLoaded?: number;
	codemodeExecutions?: number;
}

export interface ReproducibilityEnvelope {
	harnessAdapter: string;
	topology: string;
	controlRung: ControlRung;
	budgetMode: BudgetMode;
	budget: RunBudget;
	seed: number;
	armOrderIndex: number;
	fixtureSha256: string;
	graderSha256: string;
	harnessGitSha: string;
	dirtyDiffSha: string;
	driverIds: readonly string[];
	modelIds: readonly string[];
}

export interface Scorecard {
	schemaVersion: 1;
	runId: string;
	taskId: string;
	family: TaskFamily;
	status: HarnessRunReceipt["status"];
	deliveredPass: boolean;
	deliveredScore: number;
	bestOfflinePass: boolean;
	bestOfflineScore: number;
	autoNominated: boolean;
	nominatedSha256?: string;
	harnessFaults: readonly HarnessFault[];
	hasHarnessFault: boolean;
	losses: LossDecomposition;
	tokens: TokenBreakdown;
	time: TimeComputeBreakdown;
	dynamics: SwarmDynamics;
	anytimeFrontier: readonly AnytimePoint[];
	reproducibility: ReproducibilityEnvelope;
	customMetrics: Record<string, number | string | boolean>;
	gradeDetails: string;
}

export interface PromotionBar {
	minSeeds: number;
	minPassRateGain?: number;
	minScoreGain?: number;
	maxIntegrityFaults: number;
	requireCiAboveZero?: boolean;
}

export type PromotionDecision = {
	verdict: "PROMOTE" | "REJECT" | "NO_DECISION";
	reason: string;
};
