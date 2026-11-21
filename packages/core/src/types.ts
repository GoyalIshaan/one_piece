// Shared vocabulary of the harness. Every module depends on these types and on nothing else in
// another module, which is what keeps the packages swappable.

export type Role = "root" | "internal" | "leaf" | "claims_reviewer" | "hidden_reviewer" | "root_reviewer";

/** Agents that belong to the search tree. Reviewers are attached to it but are not part of it. */
export const TREE_ROLES: readonly Role[] = ["root", "internal", "leaf"];

export type NodeStatus =
	| "pending"
	| "running"
	| "parked"
	| "done"
	| "cut"
	| "merged"
	| "archived"
	| "failed";

export const TERMINAL_STATUSES: readonly NodeStatus[] = ["done", "cut", "merged", "archived", "failed"];

/**
 * A budget has one amount per resource: `tokens`, `usd`, `cpu_seconds`, `gpu_usd`, `tokens:openai`...
 * A missing key means "no limit on this resource for this node".
 */
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

/** What a parent hands a child: the goal it is graded against, plus a rubric that steers it. */
export interface Goal {
	title: string;
	text: string;
	/** Guidance on what good looks like and which trade-offs matter. Steers; not a checklist. */
	rubric?: string;
	/** Concrete, measurable targets where they exist ("1.2x faster on benchmark B"). */
	targets?: string[];
	/** What to hand back: files, format, the finding to report. */
	deliverable?: string;
	/** What not to do or touch (what siblings own), so siblings do not duplicate work. */
	boundaries?: string;
}

/** The child's own plan, written for its own thinking and for reviewers to read. */
export interface Contract {
	success: string[];
	kill: string[];
	firstCheck: string;
	evidenceLevel: EvidenceLevel;
	version: number;
}

export interface ModelRef {
	provider: string;
	id: string;
}

export type ModuleState = "off" | "deferred" | "active";

export interface SwarmNode {
	id: string;
	runId: string;
	epoch: number;
	parentId?: string;
	role: Role;
	depth: number;
	goal: Goal;
	contract?: Contract;
	status: NodeStatus;
	statusReason?: string;
	/** Budget this node was given (includes what it later hands to children). */
	budget: BudgetVector;
	/** What this node's own agent spent: its own model calls and jobs, nothing else. */
	spent: BudgetVector;
	/**
	 * What background reviewers (claims and hidden reviews) spent overseeing this node. Kept apart
	 * from `spent` so an agent's own number is honest, but it counts against the node's budget.
	 */
	oversight: BudgetVector;
	/** Sum of the budgets handed to its children. */
	allocatedToChildren: BudgetVector;
	/** Leftover budgets returned by finished children. */
	refunded: BudgetVector;
	modules: Record<string, ModuleState>;
	model?: ModelRef;
	children: string[];
	/** Latest reviewer grade, 0..1. */
	grade?: number;
	/** Reviewed promise, 0..1. Drives scheduling priority. */
	promise: number;
	/** Soft caps; a reviewer may recommend raising them for this node. */
	caps: { maxChildren: number; maxDepth: number };
	/** For merged nodes: the successor that absorbed them. */
	mergedInto?: string;
	/** For reviewers: the node or finding under review. */
	targetNodeId?: string;
	targetFindingId?: string;
	/** Set when the agent called finish. */
	finishedSummary?: string;
	turns: number;
	/** Latest checkpoint the agent wrote (compact, replaced, never appended). */
	checkpoint?: string;
	/** Latest one-line description of what the agent is doing right now. */
	activity?: string;
	createdAt: number;
	updatedAt: number;
}

export type FindingStatus = "pending_review" | "accepted" | "rejected" | "needs_work";

export interface ReviewRound {
	round: number;
	reviewerNodeId: string;
	reviewerModel?: ModelRef;
	verdict: "accepted" | "rejected" | "needs_work";
	message: string;
	confidence?: number;
	checksRun: string[];
	at: number;
}

export interface Finding {
	id: string;
	runId: string;
	nodeId: string;
	epoch: number;
	claim: string;
	reasoning: string;
	evidence: string[];
	level: EvidenceLevel;
	assumptions: string[];
	status: FindingStatus;
	confidence?: number;
	rounds: ReviewRound[];
	/** Accepted child findings this one builds on. */
	buildsOn: string[];
	createdAt: number;
	updatedAt: number;
}

export type QuestionKind = "clarification" | "decision" | "resource" | "blocker";
export type QuestionStatus = "open" | "answered" | "defaulted" | "escalated";

export interface Question {
	id: string;
	runId: string;
	fromNode: string;
	to: "parent" | "family_board";
	kind: QuestionKind;
	question: string;
	context: string;
	options: string[];
	default: string;
	blocking: boolean;
	status: QuestionStatus;
	/** Node currently responsible for answering, or "user" once escalated past the root. */
	holder: string;
	answer?: string;
	answeredBy?: string;
	createdAt: number;
	updatedAt: number;
}

export type ReviewerAction = "continue" | "redirect" | "reallocate" | "cut" | "merge" | "promote" | "revamp" | "raise_caps";

export interface Recommendation {
	id: string;
	runId: string;
	reviewerNodeId: string;
	targetNodeId: string;
	/** The node that decides: always the target's parent. */
	deciderNodeId: string;
	action: ReviewerAction;
	reason: string;
	grade: number;
	promise: number;
	details?: string;
	status: "open" | "applied" | "dismissed";
	createdAt: number;
}

export type BoardPostKind = "checkpoint" | "note" | "question" | "answer" | "peer_review";

export interface BoardPost {
	id: string;
	runId: string;
	/** The family is identified by the parent node id; siblings share it. */
	familyId: string;
	authorNode: string;
	kind: BoardPostKind;
	title: string;
	body: string;
	createdAt: number;
}

export interface Assumption {
	id: string;
	runId: string;
	nodeId: string;
	questionId: string;
	assumption: string;
	createdAt: number;
}

export type JobStatus = "queued" | "gated" | "running" | "succeeded" | "failed" | "cancelled" | "cached";

export interface JobSpec {
	pool: string;
	command: string;
	/** Working directory, relative to the requesting node's workspace. */
	cwd?: string;
	/** Files whose content identifies the job for caching. */
	inputs?: string[];
	/** Units of the pool's resource requested, e.g. GPU-minutes or CPU-seconds. */
	units?: number;
	exclusive?: boolean;
	timeoutSeconds?: number;
	/** Named secret capabilities to inject into the job's environment. */
	capabilities?: string[];
	/** Optional cheap local check that must pass before the job may enter its pool. */
	gate?: string;
	idempotencyKey?: string;
}

export interface Job {
	id: string;
	runId: string;
	nodeId: string;
	spec: JobSpec;
	status: JobStatus;
	cacheKey: string;
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	unitsUsed?: number;
	queuedAt: number;
	startedAt?: number;
	finishedAt?: number;
	receipt?: { inputHashes: Record<string, string>; host: string; durationMs: number };
}

export type EpochTrigger = "A_saturation" | "B_reframe" | "C_checkpoint" | "E_context";
export type EpochMode = "fresh" | "carry" | "mix";

export interface Epoch {
	id: string;
	runId: string;
	number: number;
	rootNodeId: string;
	trigger?: EpochTrigger;
	mode?: EpochMode;
	handoff?: string;
	carried: string[];
	startedAt: number;
	endedAt?: number;
}

export interface Report {
	id: string;
	runId: string;
	epoch: number;
	kind: "final" | "interim" | "handoff";
	title: string;
	markdown: string;
	createdAt: number;
}

export interface Run {
	id: string;
	goal: Goal;
	status: "running" | "done" | "stopped" | "failed";
	budget: BudgetVector;
	epoch: number;
	rootNodeId: string;
	workspace?: string;
	config: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}
