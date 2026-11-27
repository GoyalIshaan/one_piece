import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	type AgentRecord,
	assertNever,
	type BoardService,
	type BudgetVector,
	type DecisionModelClient,
	type DriverTier,
	EventBus,
	FileArtifactStore,
	type FindingVerifier,
	GitWorktreeManager,
	type Goal,
	type JsonSchema,
	newId,
	type QuotaPoolRouter,
	Redactor,
	type ReviewLens,
	type Role,
	type Run,
	shortHandle,
	type SpawnWorkerRequest,
	type Store,
	type SwarmOsApi,
	type TaskRecord,
	type TerminalAgentStatus,
	type ToolDefinition,
	type ToolScope,
	type TopologyOutcome,
	type TopologyPlugin,
	transitionAgentRecord,
	transitionRun,
	type UsageRecord,
	type WorkerActivityEvent,
	type WorkerHandle,
	type WorkerSession,
	type WorkerTurnResult,
} from "@one-piece/core";
import { synthesizeHandoffFile } from "@one-piece/drivers";
import { createFrozenDispatcherTool, materializeToolSchemas, McpBusServer } from "@one-piece/mcp-bus";
import { boardTools, SwarmBoardService } from "@one-piece/module-board";
import { LocalSecretBroker, type SecretSpec } from "@one-piece/module-secrets";
import { spillLargeOutput, workspaceTools } from "@one-piece/module-workspace";
import { type PoolConfig, Scheduler, schedulerTools } from "@one-piece/scheduler";
import { CloseoutController } from "./closeout.ts";
import { createCodeModeTool } from "./codemode.ts";
import {
	buildDeterministicFieldGuide,
	DEFAULT_FIELD_GUIDE_MAX_LINES,
	enforceLineBudget,
	mirrorFieldGuideToWorktree,
	probeWorkspaceEnvironment,
	writeFieldGuideFile,
} from "./field-guide.ts";
import { IntegrationPipeline } from "./integration.ts";
import { FileSkillRegistry, loadSkillTool } from "./skills.ts";
import { BoardTriageService } from "./triage.ts";
import { TriggerEngine } from "./triggers.ts";
import { TrustLayer } from "./trust.ts";

export interface SwarmOsConfig {
	runId?: string;
	runDir: string;
	workspace: string;
	topology: string;
	goal: Goal;
	budget?: BudgetVector;
	reservePct?: number;
	wallSeconds?: number;
	/** Non-preemptible closeout grace window in ms after wallSeconds expires (default 30_000). */
	closeoutGraceMs?: number;
	/** Run-level paths kernel-blocked from reading for every worker and scheduled job. */
	deniedReadPaths?: readonly string[];
	pools?: PoolConfig[];
	secrets?: SecretSpec[];
	verifier?: FindingVerifier;
	enableBlindReview?: boolean;
	/** Composable decorrelated review lenses (e.g. ["blind-diff", "transcript-audit"]). */
	reviewLenses?: ReviewLens[];
	maxRepeatedTurns?: number;
	networkOffWorkers?: boolean;
	/** Allow workers to reach the local Docker daemon socket (for offline benchmark containers via `./.eval-exec`). */
	allowDockerSocket?: boolean;
	/** Additional directories to scan for curated SKILL.md folders. */
	skillsDirs?: string[];
	/** Automatically roll over bloated in-process sessions via .swarm/HANDOFF.md after 2 compactions (default true). */
	autoHandoffOnSecondCompaction?: boolean;
	/** Seed & inject KV-cache-safe wave-boundary Field Guide snapshots (default true). */
	enableFieldGuide?: boolean;
	/** Hard line ceiling for `.swarm/field-guide/index.md` (default 80). */
	fieldGuideMaxLines?: number;
	/** Optional System-1 calibrated Decision Model client (e.g., TypeSafe Jev). */
	decisionClient?: DecisionModelClient;
	rawConfig?: Record<string, unknown>;
	store: Store;
	router: QuotaPoolRouter;
}

const DEFAULT_LEASE_MS = 180_000;
const TIER_ORDER: readonly DriverTier[] = ["sidekick", "standard", "frontier"];

function nextHigherTier(tier: DriverTier): DriverTier | undefined {
	const idx = TIER_ORDER.indexOf(tier);
	return idx >= 0 && idx + 1 < TIER_ORDER.length ? TIER_ORDER[idx + 1] : undefined;
}

function isOpenAiEditModel(model?: string): boolean {
	return Boolean(model && /(?:^|[/_-])(gpt|codex|o[134])(?:[^a-z]|$)/i.test(model));
}

export type SpawnedChildOutcome = {
	readonly agentId: string;
	readonly handle: string;
	readonly role: Role;
	readonly branch?: string;
	readonly summary: string;
} & (
	| { readonly status: "completed" | "yielded" | "interrupted"; readonly commitSha?: string; readonly score?: number }
	| { readonly status: "rate_limited" | "failed"; readonly commitSha?: never; readonly score?: never }
);

/**
 * Layer B — Thin Shared Swarm OS.
 * Owns event logging, reactive triggers, worktrees, content-addressed artifacts,
 * resource scheduler, trust/verification, local MCP bus, and multi-CLI quota failover.
 * Topology plugins sit cleanly on top and never touch Pi or CLI-specific internals.
 */
export class SwarmOS implements SwarmOsApi {
	readonly runId: string;
	readonly runDir: string;
	readonly bus: EventBus;
	readonly store: Store;
	readonly worktrees: GitWorktreeManager;
	readonly artifacts: FileArtifactStore;
	readonly board: BoardService;
	readonly scheduler: Scheduler;
	readonly secrets: LocalSecretBroker;
	readonly trust: TrustLayer;
	readonly router: QuotaPoolRouter;
	readonly mcp: McpBusServer;
	readonly skills: FileSkillRegistry;
	readonly integration: IntegrationPipeline;
	readonly decisionClient?: DecisionModelClient;
	readonly triage: BoardTriageService;
	readonly fieldGuidePath: string;

	private currentRun: Run;
	private readonly reservePct: number;
	private readonly wallSeconds?: number;
	private readonly closeoutGraceMs: number;
	private readonly runDeniedReadPaths: readonly string[];
	private readonly startedAt: number;
	private readonly networkOffWorkers: boolean;
	private readonly allowDockerSocket: boolean;
	private readonly autoHandoffOnSecondCompaction: boolean;
	private readonly fieldGuideMaxLines: number;
	private fieldGuideState:
		| { readonly status: "disabled"; readonly cachedProbe?: string; readonly wave: number }
		| { readonly status: "enabled"; readonly baseEnvProbe: string; readonly wave: number; readonly snapshot: string };
	private readonly triggers: TriggerEngine;
	private readonly closeout: CloseoutController;
	private readonly spawnedChildren = new Map<
		string,
		{
			agentId: string;
			parentAgentId: string;
			role: Role;
			handle: string;
			subtreeId: string;
			promise: Promise<SpawnedChildOutcome>;
			cancel: () => void;
			steer: (msg: string) => Promise<void>;
		}
	>();
	private readonly activeHandles = new Map<
		string,
		{
			handle: WorkerHandle;
			abort: AbortController;
			workspace: string;
			deniedReadPaths: readonly string[];
			armEscalation: (reason: string) => boolean;
		}
	>();
	private readonly workAbort = new AbortController();
	private readonly closeoutAbort = new AbortController();
	private wallBudgetState:
		| { readonly phase: "unbounded" }
		| {
			readonly phase: "active";
			readonly reserveTimer: ReturnType<typeof setTimeout>;
			readonly hardTimer: ReturnType<typeof setTimeout>;
		}
		| { readonly phase: "closeout_grace"; readonly graceTimer: ReturnType<typeof setTimeout> }
		| { readonly phase: "expired" }
		| { readonly phase: "disposed" } = { phase: "unbounded" };
	private lifecycle:
		| { readonly kind: "ready" }
		| { readonly kind: "executing"; readonly topology: string }
		| { readonly kind: "disposed" } = { kind: "ready" };

	private constructor(
		cfg: SwarmOsConfig,
		runId: string,
		bus: EventBus,
		mcp: McpBusServer,
	) {
		this.runId = runId;
		this.runDir = resolve(cfg.runDir);
		mkdirSync(this.runDir, { recursive: true });
		this.store = cfg.store;
		this.bus = bus;
		this.mcp = mcp;
		this.router = cfg.router;
		this.router.attachBus?.(this.bus, this.runId);
		this.reservePct = cfg.reservePct ?? 0.12;
		this.wallSeconds = cfg.wallSeconds;
		this.closeoutGraceMs = cfg.closeoutGraceMs ?? 30_000;
		this.runDeniedReadPaths = cfg.deniedReadPaths ? [...cfg.deniedReadPaths] : [];
		this.startedAt = Date.now();
		this.networkOffWorkers = cfg.networkOffWorkers ?? false;
		this.allowDockerSocket = cfg.allowDockerSocket ?? false;
		this.autoHandoffOnSecondCompaction = cfg.autoHandoffOnSecondCompaction ?? true;
		this.fieldGuideMaxLines = cfg.fieldGuideMaxLines ?? DEFAULT_FIELD_GUIDE_MAX_LINES;
		this.fieldGuidePath = join(this.runDir, "field-guide", "index.md");

		this.worktrees = new GitWorktreeManager(cfg.workspace, this.runDir, this.runId);
		if (cfg.enableFieldGuide ?? true) {
			const baseEnvProbe = probeWorkspaceEnvironment(cfg.workspace, this.worktrees.baseSha);
			const snapshot = enforceLineBudget(baseEnvProbe, this.fieldGuideMaxLines);
			writeFieldGuideFile(this.fieldGuidePath, snapshot);
			this.fieldGuideState = { status: "enabled", baseEnvProbe, wave: 0, snapshot };
		} else {
			this.fieldGuideState = { status: "disabled", wave: 0 };
		}
		this.artifacts = new FileArtifactStore(this.runId, this.runDir, this.bus);
		this.board = new SwarmBoardService(this.bus);
		this.decisionClient = cfg.decisionClient;
		this.triage = new BoardTriageService({
			runId: this.runId,
			board: this.board,
			bus: this.bus,
			decisionClient: this.decisionClient,
		});
		this.secrets = new LocalSecretBroker(this.runId, this.bus, { secrets: cfg.secrets ?? [] });
		this.skills = new FileSkillRegistry({ projectDir: cfg.workspace, extraDirs: cfg.skillsDirs });

		const now = Date.now();
		this.currentRun = {
			id: this.runId,
			topology: cfg.topology,
			goal: cfg.goal,
			budget: { ...(cfg.budget ?? { tokens: 2_000_000, usd: 5 }) },
			spent: {},
			workspace: resolve(cfg.workspace),
			baseCommitSha: this.worktrees.baseSha,
			status: "running",
			config: cfg.rawConfig ?? {},
			createdAt: now,
			updatedAt: now,
		};
		this.bus.save("runs", this.currentRun);

		this.scheduler = new Scheduler(
			{
				runId: this.runId,
				bus: this.bus,
				store: this.store,
				secrets: this.secrets,
				isRunActive: () => this.currentRun.status === "running",
				workspaceOf: (agentId) => this.activeHandles.get(agentId)?.workspace ?? this.store.get("agents", agentId)?.workspace,
				taskIdOf: (agentId) => this.store.get("agents", agentId)?.taskId,
				signalOf: (agentId) => this.activeHandles.get(agentId)?.abort.signal ?? this.workAbort.signal,
				deniedReadPathsOf: (agentId) => this.activeHandles.get(agentId)?.deniedReadPaths ?? this.runDeniedReadPaths,
				availableBudget: (unit) => {
					const cap = this.currentRun.budget[unit];
					return cap === undefined ? Infinity : cap - (this.currentRun.spent[unit] ?? 0);
				},
				chargeUnits: (agentId, units) => this.chargeBudget(agentId, undefined, undefined, undefined, units),
			},
			cfg.pools ?? [{ name: "cpu", unit: "cpu_seconds", capacity: 2, kind: "local", description: "local sandboxed CPU, network off" }],
		);

		this.trust = new TrustLayer({
			runId: this.runId,
			runDir: this.runDir,
			bus: this.bus,
			artifacts: this.artifacts,
			verifier: cfg.verifier,
			enableBlindReview: cfg.enableBlindReview ?? false,
			reviewLenses: cfg.reviewLenses,
			spawnReviewer: (req) => this.spawnWorker(req),
		});

		this.closeout = new CloseoutController(this.runId, this.runDir, this.bus, this.trust);
		this.integration = new IntegrationPipeline(this);

		this.triggers = new TriggerEngine({
			runId: this.runId,
			bus: this.bus,
			maxRepeatedTurns: cfg.maxRepeatedTurns ?? 3,
			isInCloseoutReserve: () => this.isInCloseoutReserve(),
			onStall: (agentId, reason) => {
				const active = this.activeHandles.get(agentId);
				if (active) {
					if (active.armEscalation(reason)) {
						void active.handle.interrupt?.().catch(() => {});
						return;
					}
					this.updateAgentStatus(agentId, "stalled", reason);
					active.abort.abort(new Error(reason));
					void active.handle.interrupt?.().catch(() => {});
				}
			},
			onReserveEntered: (reason) => {
				const { next, changed } = transitionRun(this.currentRun, { type: "enter_closing", reason, now: Date.now() });
				if (changed) {
					this.currentRun = next;
					this.bus.save("runs", this.currentRun);
				}
			},
		});
		this.triggers.start();
		if (this.wallSeconds && this.wallSeconds > 0) {
			const reserveMs = Math.max(1_000, Math.floor(this.wallSeconds * (1 - this.reservePct) * 1000));
			const reserveTimer = setTimeout(() => {
				if (this.wallBudgetState.phase !== "active") return;
				const { next, changed } = transitionRun(this.currentRun, { type: "enter_closing", reason: "Wall-clock reserve reached", now: Date.now() });
				if (changed) {
					this.currentRun = next;
					this.bus.save("runs", this.currentRun);
					this.bus.emit(this.runId, "run.closing", { reason: "Wall-clock reserve reached", reservePct: this.reservePct });
				}
			}, reserveMs);
			reserveTimer.unref?.();

			// Hard wall-clock cutoff: abort active LLM turns via workAbort, while keeping closeoutAbort
			// alive for a bounded non-preemptible grace window so mechanical assembly & verification succeed.
			const hardMs = Math.max(reserveMs + 1_000, Math.ceil(this.wallSeconds * 1000));
			const hardTimer = setTimeout(() => {
				if (this.wallBudgetState.phase !== "active") return;
				clearTimeout(this.wallBudgetState.reserveTimer);
				if (!this.workAbort.signal.aborted) {
					this.workAbort.abort(new Error(`Wall-clock limit (${this.wallSeconds}s) exceeded`));
				}
				if (!this.closeoutAbort.signal.aborted) {
					const graceTimer = setTimeout(() => {
						if (this.wallBudgetState.phase !== "closeout_grace") return;
						this.wallBudgetState = { phase: "expired" };
						if (!this.closeoutAbort.signal.aborted) {
							this.closeoutAbort.abort(new Error(`Closeout grace (${this.closeoutGraceMs}ms) exceeded`));
						}
					}, Math.max(1_000, this.closeoutGraceMs));
					graceTimer.unref?.();
					this.wallBudgetState = { phase: "closeout_grace", graceTimer };
				} else {
					this.wallBudgetState = { phase: "expired" };
				}
			}, hardMs);
			hardTimer.unref?.();
			this.wallBudgetState = { phase: "active", reserveTimer, hardTimer };
		}
	}

	get closeoutSignal(): AbortSignal {
		return this.closeoutAbort.signal;
	}

	static async create(cfg: SwarmOsConfig): Promise<SwarmOS> {
		const runId = cfg.runId ?? newId("run");
		const redactor = new Redactor();
		const bus = new EventBus(cfg.store, redactor);
		const mcp = await McpBusServer.start(bus);
		return new SwarmOS(cfg, runId, bus, mcp);
	}

	run(): Run {
		return structuredClone(this.currentRun);
	}

	isInCloseoutReserve(): boolean {
		if (this.currentRun.status === "closing") return true;
		const { budget, spent } = this.currentRun;
		if (budget.tokens && budget.tokens > 0) {
			const remaining = 1 - (spent.tokens ?? 0) / budget.tokens;
			if (remaining <= this.reservePct) return true;
		}
		if (budget.usd && budget.usd > 0) {
			const remaining = 1 - (spent.usd ?? 0) / budget.usd;
			if (remaining <= this.reservePct) return true;
		}
		if (this.wallSeconds && this.wallSeconds > 0) {
			const elapsedSec = (Date.now() - this.startedAt) / 1000;
			const remaining = 1 - elapsedSec / this.wallSeconds;
			if (remaining <= this.reservePct) return true;
		}
		return false;
	}

	remainingWallMs(): number | undefined {
		if (!this.wallSeconds || this.wallSeconds <= 0) return undefined;
		return Math.max(0, Math.floor(this.wallSeconds * 1000 - (Date.now() - this.startedAt)));
	}

	createTask(input: {
		title: string;
		description: string;
		role?: Role;
		dependsOn?: string[];
		ownedPaths?: string[];
		acceptanceCriteria?: string[];
		priority?: number;
		createdBy: string;
	}): TaskRecord {
		const now = Date.now();
		const task: TaskRecord = {
			id: newId("tsk"),
			runId: this.runId,
			title: input.title,
			description: input.description,
			role: input.role ?? "worker",
			status: "open",
			dependsOn: input.dependsOn ?? [],
			fencingToken: 0,
			ownedPaths: input.ownedPaths?.length ? input.ownedPaths : undefined,
			acceptanceCriteria: input.acceptanceCriteria?.length ? input.acceptanceCriteria : undefined,
			priority: input.priority ?? 0,
			createdBy: input.createdBy,
			createdAt: now,
			updatedAt: now,
		};
		this.bus.save("tasks", task, input.createdBy);
		this.bus.emit(this.runId, "task.created", { taskId: task.id, title: task.title, dependsOn: task.dependsOn }, input.createdBy);
		if (!task.dependsOn.length) {
			this.bus.emit(this.runId, "task.ready", { taskId: task.id, title: task.title }, input.createdBy);
		}
		return task;
	}

	readyTasks(): TaskRecord[] {
		const tasks = this.store.list("tasks", { runId: this.runId });
		const doneIds = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
		const now = Date.now();
		return tasks
			.filter((t) => {
				const openOrExpired = t.status === "open" || (t.status === "claimed" && t.leaseExpiresAt <= now);
				return openOrExpired && t.dependsOn.every((dep) => doneIds.has(dep));
			})
			.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt - b.createdAt);
	}

	nominate(findingId: string, revision?: number, auto = false): void {
		const finding = this.store.get("findings", findingId);
		if (!finding || finding.runId !== this.runId) throw new Error(`Finding ${findingId} not found in run ${this.runId}`);
		const rev = revision ?? finding.submissions.at(-1)?.revision ?? 1;
		const sub = finding.submissions.find((s) => s.revision === rev);
		const { next } = transitionRun(this.currentRun, { type: "nominate", findingId, revision: rev, now: Date.now() });
		this.currentRun = next;
		this.bus.save("runs", this.currentRun);
		this.bus.emit(this.runId, "run.nominated", {
			findingId,
			revision: rev,
			auto,
			artifactSha256: sub?.artifactSha256,
		});
	}

	fieldGuideSnapshot(): string {
		return this.fieldGuideState.status === "enabled" ? this.fieldGuideState.snapshot : "";
	}

	setFieldGuideEnabled(enabled: boolean): void {
		if (!enabled) {
			if (this.fieldGuideState.status === "enabled") {
				this.fieldGuideState = {
					status: "disabled",
					cachedProbe: this.fieldGuideState.baseEnvProbe,
					wave: this.fieldGuideState.wave,
				};
			}
			return;
		}
		if (this.fieldGuideState.status === "disabled") {
			const baseEnvProbe =
				this.fieldGuideState.cachedProbe ??
				probeWorkspaceEnvironment(this.worktrees.repoRoot, this.worktrees.baseSha);
			const snapshot = enforceLineBudget(baseEnvProbe, this.fieldGuideMaxLines);
			writeFieldGuideFile(this.fieldGuidePath, snapshot);
			this.fieldGuideState = {
				status: "enabled",
				baseEnvProbe,
				wave: this.fieldGuideState.wave,
				snapshot,
			};
		}
	}

	async consolidateFieldGuide(opts: { mode?: "deterministic" | "llm" } = {}): Promise<{ lines: number; bytes: number; path: string }> {
		if (this.fieldGuideState.status === "disabled") {
			return { lines: 0, bytes: 0, path: this.fieldGuidePath };
		}
		const baseEnvProbe = this.fieldGuideState.baseEnvProbe;
		const nextWave = this.fieldGuideState.wave + 1;
		this.fieldGuideState = { ...this.fieldGuideState, wave: nextWave };
		const mode = opts.mode ?? "deterministic";
		let markdown = buildDeterministicFieldGuide({
			runId: this.runId,
			runDir: this.runDir,
			baseProbe: baseEnvProbe,
			store: this.store,
			wave: nextWave,
			maxLines: this.fieldGuideMaxLines,
		});

		if (mode === "llm" && !this.workAbort.signal.aborted && !this.isInCloseoutReserve()) {
			try {
				const consolidator = await this.spawnWorker({
					role: "explorer",
					handle: "dreamer",
					workspace: this.worktrees.trunkPath,
					readOnly: true,
					canSpawn: false,
					maxTier: "sidekick",
					maxTurns: 1,
					toolScope: {
						board: "none",
						artifacts: false,
						findings: false,
						tasks: false,
						nominate: false,
						scheduler: "never",
						skills: false,
						sidekick: false,
						codeMode: false,
						includeWorkspaceTools: false,
					},
					systemPrompt: [
						`You are a wave-boundary Field Guide consolidator. Rewrite the draft Field Guide into <= ${this.fieldGuideMaxLines} crisp markdown lines.`,
						"Keep build/test commands, verified wins, non-obvious invariants, and failed approaches to avoid. Drop stale or redundant lines. Output ONLY markdown.",
					].join("\n"),
				});
				try {
					const res = await consolidator.runTurn(`Draft Field Guide (Wave ${nextWave}):\n\n${markdown}`, {
						signal: this.workAbort.signal,
					});
					if (res.status === "completed" && res.finalText.trim().length > 20) {
						markdown = enforceLineBudget(res.finalText, this.fieldGuideMaxLines);
					}
				} finally {
					await consolidator.close();
				}
			} catch {
				// Fall back gracefully to deterministic consolidation.
			}
		}

		if (this.fieldGuideState.status === "enabled") {
			this.fieldGuideState = {
				status: "enabled",
				baseEnvProbe,
				wave: nextWave,
				snapshot: markdown,
			};
		}
		const { lines, bytes } = writeFieldGuideFile(this.fieldGuidePath, markdown);
		// Mirror to active worktrees on disk (without mutating live workers' KV system prompts).
		for (const active of this.activeHandles.values()) {
			mirrorFieldGuideToWorktree(active.workspace, markdown);
		}
		this.bus.emit(this.runId, "field_guide.updated", {
			lines,
			bytes,
			mode,
			path: this.fieldGuidePath,
			wave: nextWave,
		});
		return { lines, bytes, path: this.fieldGuidePath };
	}

	private hasNonDefaultComputePools(): boolean {
		const pools = this.scheduler.pools();
		return pools.length > 1 || pools.some((p) => p.name !== "cpu" || p.unit !== "cpu_seconds");
	}

	defaultToolsFor(role: Role, opts: ToolScope = {}): ToolDefinition[] {
		const tools: ToolDefinition[] = [];
		const boardMode = opts.board ?? "read-write";
		const boardToolOpts = {
			resolveHandle: (id: string) => this.store.get("agents", id)?.handle,
			resolveSubtree: (id: string) => opts.subtreeId ?? this.store.get("agents", id)?.subtreeId,
			defaultVisibility: opts.defaultPostVisibility ?? (role === "worker" ? ("subtree" as const) : ("global" as const)),
		};
		if (boardMode === "read-write") {
			tools.push(...boardTools(this.board, boardToolOpts));
		} else if (boardMode === "read") {
			tools.push(...boardTools(this.board, boardToolOpts).filter((t) => t.name === "board_search" || t.name === "board_visit"));
		}

		if (opts.artifacts !== false) {
			tools.push({
				name: "read_artifact",
				description: "Read a byte range from a stored artifact by ID or SHA-256.",
				inputSchema: {
					type: "object",
					properties: {
						artifact_id: { type: "string" },
						offset: { type: "number" },
						limit: { type: "number" },
					},
					required: ["artifact_id"],
				},
				execute: (args) => {
					const page = this.artifacts.read(
						String(args.artifact_id ?? ""),
						typeof args.offset === "number" ? args.offset : 0,
						typeof args.limit === "number" ? args.limit : 4096,
					);
					return {
						text: `[${page.artifactId} bytes ${page.offset}-${page.nextOffset}/${page.totalBytes}${page.eof ? " EOF" : ""}]\n${page.content}`,
					};
				},
			});
		}

		const schedulerMode = opts.scheduler ?? "auto";
		if (schedulerMode === "always" || (schedulerMode === "auto" && this.hasNonDefaultComputePools())) {
			tools.push(...schedulerTools(this.scheduler, { artifacts: this.artifacts }));
		}

		if (!opts.readOnly) {
			if (opts.tasks !== false) {
				tools.push(
					{
						name: "claim_task",
						description: "Atomically lease the next ready task from the shared task queue.",
						inputSchema: {
							type: "object",
							properties: { task_id: { type: "string", description: "Optional specific task ID" } },
						},
						execute: (args, ctx) => {
							const ready = this.readyTasks();
							const target = typeof args.task_id === "string"
								? ready.find((t) => t.id === args.task_id)
								: ready[0];
							if (!target) return { text: "(no ready tasks available)" };
							const claim = this.store.claimTaskLease(this.runId, target.id, ctx.agentId, DEFAULT_LEASE_MS);
							if (!claim.claimed) return { text: claim.reason, isError: true };
							this.bus.emit(
								this.runId,
								"task.claimed",
								{ taskId: claim.task.id, agentId: ctx.agentId, fencingToken: claim.task.fencingToken, leaseExpiresAt: claim.task.leaseExpiresAt },
								ctx.agentId,
							);
							return {
								text: `Claimed ${claim.task.id} (token=${claim.task.fencingToken}): ${claim.task.title}\n${claim.task.description}`,
								data: { taskId: claim.task.id, fencingToken: claim.task.fencingToken },
							};
						},
					},
					{
						name: "complete_task",
						description: "Release a leased task as done or blocked with a concise summary.",
						inputSchema: {
							type: "object",
							properties: {
								task_id: { type: "string" },
								fencing_token: { type: "number" },
								status: { type: "string", enum: ["done", "blocked"] },
								result: { type: "string" },
								finding_id: { type: "string" },
							},
							required: ["task_id", "fencing_token", "status", "result"],
						},
						execute: (args, ctx) => {
							const taskId = String(args.task_id ?? "");
							const token = Number(args.fencing_token);
							const status = args.status === "blocked" ? "blocked" : "done";
							const result = String(args.result ?? "");
							const ok = this.store.releaseTaskLease(taskId, ctx.agentId, token, status, {
								result,
								findingId: typeof args.finding_id === "string" ? args.finding_id : undefined,
							});
							if (!ok) return { text: `Stale or invalid lease for task ${taskId} (token=${token})`, isError: true };
							this.bus.emit(this.runId, "task.status", { taskId, status, result }, ctx.agentId);
							return { text: `Marked ${taskId} ${status}.` };
						},
					},
				);
			}

			if (opts.findings !== false) {
				tools.push({
					name: "report_finding",
					description: "Freeze a SHA-256 snapshot of your workspace and submit a verified finding.",
					inputSchema: {
						type: "object",
						properties: {
							finding_id: { type: "string", description: "Existing finding ID to revise" },
							claim: { type: "string" },
							summary: { type: "string" },
							evidence: { type: "array", items: { type: "string" } },
							level: { type: "string", enum: ["formal_proof", "exact_check", "empirical", "conditional", "hypothesis", "external_acceptance"] },
							scope: { type: "string" },
							score: { type: "number" },
							board_post_id: { type: "string", description: "Optional board post ID to stamp with OS verification badge when accepted" },
						},
						required: ["claim", "summary"],
					},
					execute: async (args, ctx) => {
						if (!ctx.workspace) return { text: "No workspace to snapshot", isError: true };
						const agent = this.store.get("agents", ctx.agentId);
						const finding = await this.trust.submitFinding(
							{
								agentId: ctx.agentId,
								driverId: agent?.driverId,
								taskId: agent?.taskId,
								workspace: ctx.workspace,
								findingId: typeof args.finding_id === "string" ? args.finding_id : undefined,
								claim: String(args.claim ?? ""),
								summary: String(args.summary ?? ""),
								evidence: Array.isArray(args.evidence) ? args.evidence.filter((e): e is string => typeof e === "string") : [],
								level: (typeof args.level === "string" ? args.level : "empirical") as any,
								scope: typeof args.scope === "string" ? args.scope : undefined,
								score: typeof args.score === "number" ? args.score : undefined,
							},
							ctx.signal,
						);
						if (finding.status === "accepted" && typeof args.board_post_id === "string" && args.board_post_id.trim()) {
							try {
								this.board.label(args.board_post_id.trim(), {
									set: {
										"os:verified": "true",
										"os:finding": finding.id,
										...(finding.score !== undefined ? { "os:score": String(finding.score) } : {}),
									},
									actorId: "trust-layer",
									isOsActor: true,
								});
							} catch {
								// Non-fatal: finding verification succeeded even if optional post ID was invalid.
							}
						}
						const lastRound = finding.rounds.at(-1);
						const sub = finding.submissions.at(-1);
						return {
							text: `Finding ${finding.id} rev ${sub?.revision ?? 1}: status=${finding.status} (sha=${sub?.artifactSha256?.slice(0, 12) ?? "none"})\n${lastRound?.message ?? ""}`,
							isError: finding.status === "rejected" || finding.status === "needs_work",
							data: { findingId: finding.id, status: finding.status, revision: sub?.revision },
						};
					},
				});
			}

			if (opts.nominate !== false) {
				tools.push({
					name: "nominate",
					description: "Nominate an accepted finding ID as the final run deliverable.",
					inputSchema: {
						type: "object",
						properties: {
							finding_id: { type: "string" },
							revision: { type: "number" },
						},
						required: ["finding_id"],
					},
					execute: (args) => {
						this.nominate(String(args.finding_id ?? ""), typeof args.revision === "number" ? args.revision : undefined, false);
						return { text: `Nominated ${String(args.finding_id)} as final deliverable.` };
					},
				});
			}
		}

		// Strict 2-role recursive spawning invariant: ONLY non-worker roles (Planners/Root) may spawn agents.
		const allowRecursiveSpawn = role !== "worker" && Boolean(opts.spawnAgents);
		if (opts.canSpawn && role !== "worker") {
			tools.push({
				name: "spawn_task",
				description: "Queue an asynchronous sub-task for a leaf worker (returns task ID immediately).",
				inputSchema: {
					type: "object",
					properties: {
						title: { type: "string" },
						description: { type: "string" },
						depends_on: { type: "array", items: { type: "string" } },
					},
					required: ["title", "description"],
				},
				execute: (args, ctx) => {
					const task = this.createTask({
						title: String(args.title ?? "subtask"),
						description: String(args.description ?? ""),
						dependsOn: Array.isArray(args.depends_on) ? args.depends_on.filter((d): d is string => typeof d === "string") : [],
						createdBy: ctx.agentId,
					});
					return { text: `Queued task ${task.id}: ${task.title}`, data: { taskId: task.id } };
				},
			});
		}

		if (allowRecursiveSpawn) {
			tools.push(
				{
					name: "spawn_agents",
					description:
						"Spawn one or more child Planners (recursive search-tree managers with Board write + spawn access) and/or leaf Workers (non-spawning executors in isolated git worktrees) in parallel. Returns agent IDs immediately so you can launch waves concurrently or back-to-back.",
					inputSchema: {
						type: "object",
						properties: {
							agents: {
								type: "array",
								items: {
									type: "object",
									properties: {
										role: { type: "string", enum: ["planner", "worker"] },
										handle: { type: "string", description: "Optional readable handle (e.g. 'planner-perf', 'worker-wal')" },
										prompt: { type: "string", description: "Concrete assignment or search-space subtree prompt" },
										base_ref: { type: "string", description: "Optional git branch/SHA to branch this child's worktree from" },
										owned_paths: { type: "array", items: { type: "string" }, description: "Optional owned path hints" },
									},
									required: ["role", "prompt"],
								},
							},
						},
						required: ["agents"],
					},
					execute: async (args, ctx) => {
						if (this.workAbort.signal.aborted || this.isInCloseoutReserve()) {
							return { text: "Cannot spawn new agents during closeout reserve or after abort.", isError: true };
						}
						const rawSpecs = Array.isArray(args.agents) ? args.agents : [];
						if (!rawSpecs.length) {
							return { text: "agents array must contain at least one agent spec.", isError: true };
						}
						const parentRecord = this.store.get("agents", ctx.agentId);
						const parentDepth = parentRecord?.depth ?? 0;
						const parentSubtree = parentRecord?.subtreeId ?? parentRecord?.id ?? ctx.agentId;
						const spawnedMeta: Array<{ agentId: string; role: string; handle: string; subtreeId: string }> = [];

						for (let i = 0; i < rawSpecs.length; i++) {
							const item = rawSpecs[i] as Record<string, unknown>;
							const childRole: Role = item.role === "planner" ? "planner" : "worker";
							const childPrompt = String(item.prompt ?? "").trim();
							if (!childPrompt) continue;
							const childHandle = typeof item.handle === "string" && item.handle.trim()
								? item.handle.trim()
								: `${childRole}-d${parentDepth + 1}-${i + 1}`;
							const baseRef = typeof item.base_ref === "string" && item.base_ref.trim() ? item.base_ref.trim() : undefined;
							const ownedPaths = Array.isArray(item.owned_paths)
								? item.owned_paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
								: [];
							const childSubtree = childRole === "planner" ? `${parentSubtree}/${childHandle}` : parentSubtree;

							const childAbort = new AbortController();
							type SpawnedChildPhase =
								| { readonly status: "spawning"; readonly cancelRequested: boolean; readonly pendingSteers: string[] }
								| { readonly status: "running"; readonly handle: WorkerHandle }
								| { readonly status: "settled" };
							let childPhase: SpawnedChildPhase = { status: "spawning", cancelRequested: false, pendingSteers: [] };
							const childIdPlaceholder = newId("agt");
							let resolvedAgentId = childIdPlaceholder;

							const childPromise = (async (): Promise<SpawnedChildOutcome> => {
								const sharedChildReq = {
									handle: childHandle,
									parentAgentId: ctx.agentId,
									subtreeId: childSubtree,
									depth: parentDepth + 1,
									baseRef,
									passiveSnapshotOnExit: true,
									cacheKeyPrefix: `${this.runId}:recursive-${childRole}`,
								};
								const sharedChildScope = {
									board: "read-write" as const,
									artifacts: true,
									findings: true,
									tasks: false,
									nominate: false,
									scheduler: "auto" as const,
									passiveSnapshotOnExit: true,
									subtreeId: childSubtree,
								};
								const child = childRole === "planner"
									? await this.spawnWorker({
										...sharedChildReq,
										role: "planner",
										canSpawn: true,
										toolScope: {
											...sharedChildScope,
											canSpawn: true,
											spawnAgents: true,
											defaultPostVisibility: "global",
										},
										systemPrompt: [
											"You are a recursive Planner managing a search subtree in an isolated git worktree.",
											"You may solve directly, spawn parallel or sequential child Planners/Workers via `spawn_agents` + `await_agents`, and publish discoveries/hypotheses/dead-ends to Board v2 (`board_publish`) so sibling Planners learn from your branch.",
										].join("\n"),
									})
									: await this.spawnWorker({
										...sharedChildReq,
										role: "worker",
										canSpawn: false,
										toolScope: {
											...sharedChildScope,
											canSpawn: false,
											spawnAgents: false,
											defaultPostVisibility: "subtree",
										},
										systemPrompt: [
											"You are a focused leaf Worker in an isolated git worktree (cannot spawn sub-agents).",
											"Implement and verify your assigned task cleanly, and publish key discoveries, counterexamples, or dead-ends via `board_publish(kind=...)`.",
										].join("\n"),
									});
								resolvedAgentId = child.agent.id;
								const entry = this.spawnedChildren.get(childIdPlaceholder);
								if (entry && resolvedAgentId !== childIdPlaceholder) {
									entry.agentId = resolvedAgentId;
									this.spawnedChildren.set(resolvedAgentId, entry);
									this.spawnedChildren.delete(childIdPlaceholder);
								}
								try {
									if ((childPhase.status === "spawning" && childPhase.cancelRequested) || childAbort.signal.aborted) {
										return {
											agentId: child.agent.id,
											handle: child.agent.handle,
											role: childRole,
											status: "interrupted",
											branch: child.branch,
											summary: `Child ${child.agent.handle} cancelled before first turn.`,
										};
									}
									const queuedSteers = childPhase.status === "spawning" ? childPhase.pendingSteers : [];
									childPhase = { status: "running", handle: child };
									const pulse = this.board.digest(this.runId, { subtreeId: childSubtree });
									const pathHint = ownedPaths.length ? `\nOwned paths: ${ownedPaths.join(", ")}` : "";
									const steerHint = queuedSteers.length
										? `\n\nParent steering updates received before start:\n${queuedSteers.map((s) => `- ${s}`).join("\n")}`
										: "";
									const fullPrompt = `${pulse}\n\n${childPrompt}${pathHint}${steerHint}`;
									const combined = AbortSignal.any([this.workAbort.signal, childAbort.signal]);
									const turnRes = await child.runTurn(fullPrompt, { signal: combined });
									const wipSha = turnRes.workspaceSnapshot?.wipSha ?? this.worktrees.commitWip(child.workspace, `${child.agent.handle}: child work`);
									const headSha = turnRes.workspaceSnapshot?.headSha ?? this.worktrees.headSha(child.workspace);
									const bestChildFinding = this.store
										.list("findings", { runId: this.runId })
										.filter((f) => f.authorAgentId === child.agent.id)
										.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))[0];
									const summary = turnRes.finalText.slice(0, 800) || `Child ${child.agent.handle} finished (${turnRes.status}).`;
									if (turnRes.status === "failed" || turnRes.status === "rate_limited") {
										return {
											agentId: child.agent.id,
											handle: child.agent.handle,
											role: childRole,
											status: turnRes.status,
											branch: child.branch,
											summary,
										};
									}
									return {
										agentId: child.agent.id,
										handle: child.agent.handle,
										role: childRole,
										status: turnRes.status,
										branch: child.branch,
										commitSha: wipSha ?? headSha,
										score: bestChildFinding?.score,
										summary,
									};
								} catch (err) {
									return {
										agentId: resolvedAgentId,
										handle: childHandle,
										role: childRole,
										status: "failed",
										branch: child.branch,
										summary: err instanceof Error ? err.message : String(err),
									};
								} finally {
									childPhase = { status: "settled" };
									await child.close().catch(() => {});
								}
							})();

							this.spawnedChildren.set(childIdPlaceholder, {
								agentId: childIdPlaceholder,
								parentAgentId: ctx.agentId,
								role: childRole,
								handle: childHandle,
								subtreeId: childSubtree,
								promise: childPromise,
								cancel: () => {
									switch (childPhase.status) {
										case "spawning":
											childPhase = { status: "spawning", cancelRequested: true, pendingSteers: [] };
											childAbort.abort(new Error(`Cancelled by parent ${ctx.agentId}`));
											break;
										case "running":
											childAbort.abort(new Error(`Cancelled by parent ${ctx.agentId}`));
											void childPhase.handle.interrupt?.().catch(() => {});
											break;
										case "settled":
											break;
										default:
											assertNever(childPhase, "Unhandled SpawnedChildPhase");
									}
								},
								steer: async (msg: string) => {
									switch (childPhase.status) {
										case "spawning":
											if (!childPhase.cancelRequested) childPhase.pendingSteers.push(msg);
											break;
										case "running":
											await childPhase.handle.steer?.(msg);
											break;
										case "settled":
											break;
										default:
											assertNever(childPhase, "Unhandled SpawnedChildPhase");
									}
								},
							});
							spawnedMeta.push({ agentId: childIdPlaceholder, role: childRole, handle: childHandle, subtreeId: childSubtree });
						}

						return {
							text: `Spawned ${spawnedMeta.length} child agent(s): ${spawnedMeta.map((m) => `${m.handle}[${m.role}]=${m.agentId}`).join(", ")}. Call await_agents to collect results.`,
							data: { spawned: spawnedMeta },
						};
					},
				},
				{
					name: "await_agents",
					description: "Wait for spawned child Planners/Workers to finish (mode='all' or 'any') and run Board triage so high-signal child discoveries are promoted.",
					inputSchema: {
						type: "object",
						properties: {
							agent_ids: { type: "array", items: { type: "string" }, description: "Specific child IDs to await (omit to await all your children)" },
							mode: { type: "string", enum: ["all", "any"], description: "Wait for all or first completed (default 'all')" },
							timeout_seconds: { type: "number", minimum: 1, maximum: 600 },
						},
					},
					execute: async (args, ctx) => {
						const requestedIds = Array.isArray(args.agent_ids)
							? args.agent_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
							: [];
						const targets = requestedIds.length
							? requestedIds
								.map((id) => this.spawnedChildren.get(id) ?? [...this.spawnedChildren.values()].find((c) => c.agentId === id))
								.filter((c): c is NonNullable<typeof c> => Boolean(c))
							: [...this.spawnedChildren.values()].filter((c) => c.parentAgentId === ctx.agentId);

						if (!targets.length) {
							return { text: "No active spawned children found to await." };
						}
						const mode = args.mode === "any" ? "any" : "all";
						const timeoutMs = typeof args.timeout_seconds === "number" && Number.isFinite(args.timeout_seconds)
							? Math.max(1_000, Math.floor(args.timeout_seconds * 1_000))
							: undefined;

						const raceWithTimeout = async <T>(p: Promise<T>): Promise<T | "TIMED_OUT"> => {
							if (!timeoutMs) return p;
							return Promise.race([
								p,
								new Promise<"TIMED_OUT">((r) => {
									const t = setTimeout(() => r("TIMED_OUT"), timeoutMs);
									t.unref?.();
								}),
							]);
						};

						// Temporarily park parent Planner's concurrency permit while awaiting children so
						// nested recursive Planners can NEVER deadlock even on a 1-slot driver pool!
						const parentActive = this.activeHandles.get(ctx.agentId);
						parentActive?.handle.selection.park?.();
						let settled: SpawnedChildOutcome[] | "TIMED_OUT";
						try {
							settled = mode === "any"
								? await raceWithTimeout(Promise.race(targets.map((t) => t.promise)).then((r) => [r]))
								: await raceWithTimeout(Promise.all(targets.map((t) => t.promise)));
						} finally {
							parentActive?.handle.selection.unpark?.();
						}

						if (settled === "TIMED_OUT") {
							return { text: `await_agents timed out after ${args.timeout_seconds}s while ${targets.length} child(ren) remain running.` };
						}

						// Run Decision-Model Board triage on newly produced subtree claims before returning to parent Planner.
						await this.triage.triagePosts({
							goal: this.currentRun.goal.text,
							signal: this.closeoutAbort.signal,
						}).catch(() => {});

						const lines = settled.map(
							(r) =>
								`- ${r.handle} (${r.role}, id=${r.agentId}, status=${r.status}${r.branch ? `, branch=${r.branch}` : ""}${r.score !== undefined ? `, score=${r.score.toFixed(4)}` : ""}): ${r.summary.slice(0, 320)}`,
						);
						return {
							text: `Collected ${settled.length} child result(s):\n${lines.join("\n")}`,
							data: { results: settled },
						};
					},
				},
				{
					name: "steer_or_cancel_agent",
					description: "Redirect (steer) or cancel a live spawned child agent when a sibling discovers a better direction or dead-end.",
					inputSchema: {
						type: "object",
						properties: {
							agent_id: { type: "string" },
							action: { type: "string", enum: ["steer", "cancel"] },
							message: { type: "string", description: "Steering guidance when action='steer'" },
						},
						required: ["agent_id", "action"],
					},
					execute: async (args) => {
						const id = String(args.agent_id ?? "").trim();
						const target = this.spawnedChildren.get(id) ?? [...this.spawnedChildren.values()].find((c) => c.agentId === id);
						if (!target) return { text: `Spawned child not found: ${id}`, isError: true };
						if (args.action === "cancel") {
							target.cancel();
							return { text: `Cancelled child ${target.handle} (${target.agentId}).` };
						}
						const msg = String(args.message ?? "").trim();
						if (!msg) return { text: "message is required for action='steer'", isError: true };
						await target.steer(msg);
						return { text: `Steered child ${target.handle} (${target.agentId}).` };
					},
				},
			);
		}

		if (opts.skills !== false && this.skills.renderOnDemandCatalog(role, opts.excludeSkills).length > 0) {
			tools.push(loadSkillTool(this.skills, this.bus));
		}

		if (opts.codeMode) {
			tools.push(
				createCodeModeTool({
					runId: this.runId,
					runDir: this.runDir,
					bus: this.bus,
					store: this.store,
					artifacts: this.artifacts,
					worktrees: this.worktrees,
				}),
			);
		}

		const enableSidekick = opts.sidekick ?? (role === "planner" || role === "integrator" || role === "root");
		if (enableSidekick) {
			tools.push({
				name: "delegate_explore",
				description: "Offload a noisy read-only codebase search or targeted inspection to a disposable sidekick worker and receive only the concise answer.",
				inputSchema: {
					type: "object",
					properties: {
						query: { type: "string", description: "Concrete read-only question or lookup to answer from the workspace" },
						paths: { type: "array", items: { type: "string" }, description: "Optional file/directory hints to inspect first" },
						max_turns: { type: "number", minimum: 1, maximum: 6 },
					},
					required: ["query"],
				},
				execute: async (args, ctx) => {
					const query = String(args.query ?? "").trim();
					if (!query) return { text: "query is required", isError: true };
					const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string") : [];
					const maxTurns = Math.min(6, Math.max(1, typeof args.max_turns === "number" ? Math.floor(args.max_turns) : 4));
					const explorer = await this.spawnWorker({
						role: "explorer",
						parentAgentId: ctx.agentId,
						workspace: ctx.workspace ?? this.worktrees.trunkPath,
						readOnly: true,
						canSpawn: false,
						maxTier: "sidekick",
						maxTurns,
						toolScope: {
							board: "read",
							artifacts: true,
							findings: false,
							tasks: false,
							nominate: false,
							scheduler: "never",
							skills: false,
							sidekick: false,
							codeMode: false,
						},
						systemPrompt: "You are a disposable read-only codebase explorer. Answer the query concisely with exact file:line references. Never modify files.",
					});
					try {
						const prompt = [
							`Query: ${query}`,
							...(paths.length ? [`Focus paths: ${paths.join(", ")}`] : []),
							`Return a concise, factual answer with exact file:line citations.`,
						].join("\n");
						const res = await explorer.runTurn(prompt, { signal: ctx.signal });
						const raw = res.finalText || (res.status === "failed" || res.status === "rate_limited" ? res.error : "(no findings)");
						const spilled = spillLargeOutput("delegate_explore", raw, {
							artifacts: this.artifacts,
							createdBy: ctx.agentId,
						});
						return {
							text: spilled.text,
							isError: res.status === "failed" || res.status === "rate_limited",
							data: { explorerAgentId: explorer.agent.id, driverId: explorer.agent.driverId, artifactId: spilled.artifactId },
						};
					} finally {
						await explorer.close();
					}
				},
			});
		}

		if (opts.extendedTools?.length) {
			tools.push(createFrozenDispatcherTool(opts.extendedTools));
		}

		if (opts.includeWorkspaceTools) {
			tools.push(
				...workspaceTools({
					bus: this.bus,
					secrets: this.secrets,
					artifacts: this.artifacts,
					readOnly: opts.readOnly,
					networkOff: this.networkOffWorkers,
					allowDockerSocket: this.allowDockerSocket,
					deniedReadPaths: opts.deniedReadPaths ?? this.runDeniedReadPaths,
					editFormat: opts.editFormat,
				}),
			);
		}

		return tools.sort((a, b) => a.name.localeCompare(b.name));
	}

	async spawnWorker(req: SpawnWorkerRequest): Promise<WorkerHandle> {
		if (this.lifecycle.kind === "disposed") {
			throw new Error(`Cannot spawn worker (${req.role}) after SwarmOS has been disposed`);
		}
		const agentId = newId("agt");
		const effectiveDeniedReadPaths = [...new Set([...this.runDeniedReadPaths, ...(req.deniedReadPaths ?? [])])];
		let selection = await this.router.acquireForRole(req.role, {
			preferredDriverId: req.preferredDriverId,
			avoidDrivers: req.avoidDrivers,
			minTier: req.minTier,
			maxTier: req.maxTier,
			requireOutputSchema: req.requireOutputSchema,
			strictCapabilities: req.strictCapabilities,
			preferInProcess: req.preferInProcess ?? (req.role === "planner" || req.role === "reviewer"),
			signal: this.workAbort.signal,
		});

		const worktreeHandle = req.workspace
			? undefined
			: this.worktrees.create(agentId, req.baseRef);
		const workspace = req.workspace ?? worktreeHandle!.path;
		const branch = worktreeHandle?.branch;
		const initialBaseHeadSha = this.worktrees.headSha(workspace) ?? req.baseRef ?? this.worktrees.baseSha;

		const assignedTask = req.taskId ? this.store.get("tasks", req.taskId) : undefined;
		const pinnedChecklist = [
			...(this.currentRun.goal.deliverable ? [`Deliverable: ${this.currentRun.goal.deliverable}`] : []),
			...(this.currentRun.goal.rubric ? [`Rubric: ${this.currentRun.goal.rubric}`] : []),
			...(assignedTask?.acceptanceCriteria ?? []),
			...(assignedTask?.ownedPaths?.length ? [`Stay within owned paths: ${assignedTask.ownedPaths.join(", ")}`] : []),
		];

		const effectiveSubtreeId = req.subtreeId ?? req.toolScope?.subtreeId ?? (req.parentAgentId ? this.store.get("agents", req.parentAgentId)?.subtreeId : undefined) ?? agentId;
		const effectiveDepth = req.depth ?? (req.parentAgentId ? (this.store.get("agents", req.parentAgentId)?.depth ?? 0) + 1 : 0);
		const passiveSnapshotOnExit = req.passiveSnapshotOnExit ?? req.toolScope?.passiveSnapshotOnExit ?? false;
		const buildTools = (driverKind: string, driverId: string) => {
			const modelHint = req.model ?? this.router.getDriverConfig?.(driverId)?.model;
			// Enforce strict 2-role invariant: leaf workers NEVER gain spawn permissions.
			const canSpawnEffective = req.role === "worker" ? false : (req.canSpawn ?? req.toolScope?.canSpawn ?? false);
			const spawnAgentsEffective = req.role === "worker" ? false : (req.toolScope?.spawnAgents ?? false);
			return req.tools ??
				this.defaultToolsFor(req.role, {
					...(req.toolScope ?? {}),
					canSpawn: canSpawnEffective,
					spawnAgents: spawnAgentsEffective,
					subtreeId: effectiveSubtreeId,
					readOnly: req.readOnly ?? req.toolScope?.readOnly ?? false,
					excludeSkills: req.skills,
					deniedReadPaths: effectiveDeniedReadPaths,
					includeWorkspaceTools: req.toolScope?.includeWorkspaceTools ?? driverKind === "pi-in-process",
					...(driverKind === "pi-in-process" && isOpenAiEditModel(modelHint) ? { editFormat: "apply_patch" as const } : {}),
				});
		};

		if (req.toolScope?.extendedTools?.length) {
			materializeToolSchemas(workspace, req.toolScope.extendedTools);
		}
		if (this.fieldGuideState.status === "enabled" && this.fieldGuideState.snapshot && !req.readOnly && req.role !== "reviewer") {
			mirrorFieldGuideToWorktree(workspace, this.fieldGuideState.snapshot);
		}

		const staticSkills = this.skills.staticPromptFor(req.role, req.skills);
		const onDemandCatalog = req.toolScope?.skills !== false
			? this.skills.renderOnDemandCatalog(req.role, req.skills)
			: "";
		const extendedToolsHint = req.toolScope?.extendedTools?.length
			? "Extended tools are cataloged in `.swarm/tools/INDEX.md`; read `.swarm/tools/<name>.json` and invoke via `call_tool(name, arguments)`."
			: "";
		// Inject immutable KV-cache-safe wave Field Guide snapshot for non-reviewer roles (never leaks generator state to blind reviewers).
		const fieldGuideBlock =
			this.fieldGuideState.status === "enabled" && this.fieldGuideState.snapshot && req.role !== "reviewer" && req.handle !== "dreamer"
				? this.fieldGuideState.snapshot.trim()
				: "";
		const composedSystemPrompt = [req.systemPrompt, fieldGuideBlock, staticSkills, onDemandCatalog, extendedToolsHint]
			.filter((s): s is string => Boolean(s && s.trim()))
			.join("\n\n") || undefined;

		const cacheKeyPrefix = req.cacheKeyPrefix ?? `${this.runId}:${req.role}`;
		const compactionPolicy = {
			watermarkFraction: 0.70,
			keepRecentTurns: 6,
			minPruneBytes: 1024,
			maxCompactionsBeforeHandoff: 2,
			pinnedChecklist: pinnedChecklist.length ? pinnedChecklist : undefined,
			spillArtifact: (label: string, content: string) => {
				const rec = this.artifacts.put(label, content, { mimeType: "text/plain", createdBy: agentId });
				return { id: rec.id, sha256: rec.sha256 };
			},
			onCompacted: (ev: { strategy: "micro" | "anchor"; beforeTokens: number; afterTokens: number; prunedCount: number; compactionCount: number }) => {
				this.bus.emit(this.runId, "agent.compacted", { agentId, ...ev }, agentId);
			},
		};

		let tools = buildTools(selection.driver.kind, selection.driver.id);
		let mcpReg = this.mcp.registerWorker({
			runId: this.runId,
			agentId,
			role: req.role,
			workspace,
			tools,
		});

		const now = Date.now();
		let agent: AgentRecord = {
			id: agentId,
			runId: this.runId,
			handle: req.handle?.trim() || shortHandle(agentId),
			role: req.role,
			driverId: selection.driver.id,
			model: req.model,
			parentAgentId: req.parentAgentId,
			subtreeId: effectiveSubtreeId,
			depth: effectiveDepth,
			taskId: req.taskId,
			workspace,
			branch,
			status: "running",
			turns: 0,
			spent: {},
			createdAt: now,
			updatedAt: now,
		};
		this.bus.save("agents", agent, agentId);
		this.bus.emit(
			this.runId,
			"agent.spawned",
			{
				agentId,
				role: req.role,
				driverId: selection.driver.id,
				model: req.model,
				taskId: req.taskId,
				workspace,
				waitedMs: selection.waitedMs || undefined,
			},
			agentId,
		);
		this.bus.emit(this.runId, "agent.status", { status: "running" }, agentId);

		const transcriptDir = join(this.runDir, "transcripts");
		mkdirSync(transcriptDir, { recursive: true });
		const transcriptRel = `transcripts/${agentId}.jsonl`;
		const transcriptAbs = join(this.runDir, transcriptRel);

		let lastToolSig = "";
		let turnToolLog: Array<{
			ts: number;
			kind: "call" | "result" | "error";
			tool?: string;
			isMcp?: boolean;
			isError?: boolean;
			argsPreview?: string;
			outputPreview?: string;
			durationMs?: number;
			message?: string;
		}> = [];

		const handleActivity = (ev: WorkerActivityEvent): void => {
			if (ev.type === "session") {
				const latest = this.store.get("agents", agentId) ?? agent;
				agent = {
					...latest,
					sessionId: ev.sessionId,
					model: ev.model ?? latest.model,
					updatedAt: Date.now(),
				};
				this.bus.save("agents", agent, agentId);
			} else if (ev.type === "tool_call") {
				const cleanArgs = ev.argsPreview ? this.bus.redactor.redactText(ev.argsPreview).slice(0, 240) : undefined;
				lastToolSig = `${ev.name}:${cleanArgs ?? ""}`.slice(0, 120);
				turnToolLog.push({ ts: Date.now(), kind: "call", tool: ev.name, isMcp: ev.isMcp, argsPreview: cleanArgs });
				this.bus.emit(
					this.runId,
					"driver.tool_call",
					{ tool: ev.name, argsPreview: cleanArgs, isMcp: Boolean(ev.isMcp), driverId: selection.driver.id },
					agentId,
				);
			} else if (ev.type === "tool_result") {
				const cleanOut = ev.outputPreview ? this.bus.redactor.redactText(ev.outputPreview).slice(0, 500) : undefined;
				turnToolLog.push({
					ts: Date.now(),
					kind: "result",
					tool: ev.name,
					isMcp: ev.isMcp,
					isError: Boolean(ev.isError),
					outputPreview: cleanOut,
					durationMs: ev.durationMs,
				});
				this.bus.emit(
					this.runId,
					"driver.tool_result",
					{
						tool: ev.name,
						isError: Boolean(ev.isError),
						outputPreview: cleanOut,
						durationMs: ev.durationMs,
						isMcp: Boolean(ev.isMcp),
						driverId: selection.driver.id,
					},
					agentId,
				);
			} else if (ev.type === "error") {
				const cleanErr = this.bus.redactor.redactText(ev.message).slice(0, 500);
				turnToolLog.push({ ts: Date.now(), kind: "error", message: cleanErr });
				this.bus.emit(this.runId, "driver.error", { message: cleanErr, driverId: selection.driver.id }, agentId);
			}
		};

		let session: WorkerSession;
		try {
			session = await selection.driver.spawn({
				runId: this.runId,
				agentId,
				role: req.role,
				workspace,
				systemPrompt: composedSystemPrompt,
				model: req.model,
				maxTurns: req.maxTurns,
				readOnly: req.readOnly,
				deniedReadPaths: effectiveDeniedReadPaths,
				cacheKeyPrefix,
				compaction: compactionPolicy,
				mcp: mcpReg.connection,
				tools,
				onActivity: handleActivity,
			});
		} catch (error) {
			mcpReg.unregister();
			selection.release();
			this.updateAgentStatus(agentId, "failed", error instanceof Error ? error.message : String(error));
			throw error;
		}

		const abort = new AbortController();
		type LastTurnOutcome = { readonly status: WorkerTurnResult["status"]; readonly error?: string };
		type PendingRollover = { readonly reason: string; readonly failedApproaches?: string[] };
		type EscalationState =
			| { readonly status: "ready"; readonly used: number }
			| { readonly status: "armed"; readonly used: number; readonly reason: string; readonly targetMinTier: DriverTier }
			| { readonly status: "exhausted"; readonly used: number };
		type WorkerHandleState =
			| {
				readonly kind: "idle";
				readonly lastOutcome?: LastTurnOutcome;
				readonly pendingRollover?: PendingRollover;
			}
			| {
				readonly kind: "running_turn";
				readonly lastOutcome?: LastTurnOutcome;
			}
			| {
				readonly kind: "broken";
				readonly error: string;
			}
			| {
				readonly kind: "closed";
				readonly finalStatus: TerminalAgentStatus;
				readonly reason?: string;
			};
		let handleState: WorkerHandleState = { kind: "idle" };
		let escalationState: EscalationState = { status: "ready", used: 0 };
		const transitionToIdle = (lastOutcome: LastTurnOutcome, pendingRollover?: PendingRollover): void => {
			if (handleState.kind !== "closed" && handleState.kind !== "broken") {
				handleState = { kind: "idle", lastOutcome, pendingRollover };
			}
		};
		const attemptedDrivers = new Set<string>([selection.driver.id]);
		let pendingPermitWaitMs = selection.waitedMs ?? 0;

		const findHigherHealthyTier = (): DriverTier | undefined => {
			if (!this.router.getDriverTier) return undefined;
			const currentTier = this.router.getDriverTier(selection.driver.id);
			const target = nextHigherTier(currentTier);
			if (!target) return undefined;
			const targetRank = TIER_ORDER.indexOf(target);
			const hasHigher = this.router.status().some(
				(s) =>
					s.state === "healthy" &&
					s.driverId !== selection.driver.id &&
					!attemptedDrivers.has(s.driverId) &&
					TIER_ORDER.indexOf(this.router.getDriverTier!(s.driverId)) >= targetRank,
			);
			return hasHigher ? target : undefined;
		};

		const armEscalation = (reason: string): boolean => {
			if (handleState.kind === "closed" || handleState.kind === "broken") return false;
			if (escalationState.status !== "ready") return false;
			const target = findHigherHealthyTier();
			if (!target) return false;
			escalationState = { status: "armed", used: escalationState.used, reason, targetMinTier: target };
			return true;
		};

		const consumeEscalation = (): { reason: string; targetMinTier: DriverTier } | undefined => {
			if (escalationState.status !== "armed") return undefined;
			const armed = escalationState;
			escalationState = armed.used >= 2 ? { status: "exhausted", used: armed.used } : { status: "ready", used: armed.used };
			return { reason: armed.reason, targetMinTier: armed.targetMinTier };
		};

		const recordEscalationUsed = (): void => {
			const nextUsed = escalationState.used + 1;
			escalationState = nextUsed >= 2 ? { status: "exhausted", used: nextUsed } : { status: "ready", used: nextUsed };
		};

		const switchSessionWithHandoff = async (params: {
			reason: string;
			reasonKind: "compaction_limit" | "stall_escalation";
			originalPrompt: string;
			failedApproaches?: string[];
			escalateToTier?: DriverTier;
			signal: AbortSignal;
		}): Promise<{ prompt: string; escalated: boolean }> => {
			const fromDriver = selection.driver.id;
			const fromTier: DriverTier = this.router.getDriverTier?.(fromDriver) ?? "standard";
			const handoff = synthesizeHandoffFile({
				runId: this.runId,
				agentId,
				fromDriver,
				reason: params.reason,
				reasonKind: params.reasonKind,
				originalPrompt: params.originalPrompt,
				workspace,
				worktrees: this.worktrees,
				store: this.store,
				failedApproaches: params.failedApproaches,
				acceptanceCriteria: assignedTask?.acceptanceCriteria,
				ownedPaths: assignedTask?.ownedPaths,
			});

			let nextSelection = selection;
			let switchedDriver = false;
			if (params.escalateToTier) {
				try {
					const candidate = await this.router.acquireForRole(req.role, {
						minTier: params.escalateToTier,
						avoidDrivers: [...attemptedDrivers, ...(req.avoidDrivers ?? [])],
						signal: params.signal,
					});
					const candidateTier = this.router.getDriverTier?.(candidate.driver.id) ?? "standard";
					if (candidate.driver.id !== fromDriver && TIER_ORDER.indexOf(candidateTier) > TIER_ORDER.indexOf(fromTier)) {
						nextSelection = candidate;
						switchedDriver = true;
					} else {
						candidate.release();
					}
				} catch {
					// Fall back to same-driver clean-slate respawn.
				}
			}

			await session.close().catch(() => {});
			if (switchedDriver) {
				selection.release();
				mcpReg.unregister();
				selection = nextSelection;
				pendingPermitWaitMs += nextSelection.waitedMs ?? 0;
				attemptedDrivers.add(selection.driver.id);
				recordEscalationUsed();
				tools = buildTools(selection.driver.kind, selection.driver.id);
				mcpReg = this.mcp.registerWorker({ runId: this.runId, agentId, role: req.role, workspace, tools });
				const latestEsc = this.store.get("agents", agentId) ?? agent;
				agent = { ...latestEsc, driverId: selection.driver.id, sessionId: undefined, model: undefined, updatedAt: Date.now() };
				this.bus.save("agents", agent, agentId);
				const toTier: DriverTier = this.router.getDriverTier?.(selection.driver.id) ?? "standard";
				this.bus.emit(
					this.runId,
					"agent.escalated",
					{ agentId, fromDriver, toDriver: selection.driver.id, fromTier, toTier, reason: params.reason },
					agentId,
				);
			}

			this.bus.emit(
				this.runId,
				"agent.handoff",
				{
					agentId,
					fromDriver,
					toDriver: selection.driver.id,
					workspace,
					handoffPath: handoff.handoffPath,
					reasonKind: params.reasonKind,
					waitedMs: switchedDriver ? nextSelection.waitedMs || undefined : undefined,
				},
				agentId,
			);

			try {
				session = await selection.driver.spawn({
					runId: this.runId,
					agentId,
					role: req.role,
					workspace,
					systemPrompt: composedSystemPrompt,
					model: switchedDriver ? undefined : req.model,
					maxTurns: req.maxTurns,
					readOnly: req.readOnly,
					deniedReadPaths: effectiveDeniedReadPaths,
					cacheKeyPrefix,
					compaction: compactionPolicy,
					mcp: mcpReg.connection,
					tools,
					onActivity: handleActivity,
				});
			} catch (error) {
				handleState = { kind: "broken", error: error instanceof Error ? error.message : String(error) };
				throw error;
			}
			return { prompt: handoff.prompt, escalated: switchedDriver };
		};

		const store = this.store;
		const handle: WorkerHandle = {
			get agent() {
				return store.get("agents", agentId) ?? agent;
			},
			workspace,
			branch,
			get session() {
				return session;
			},
			get selection() {
				return selection;
			},
			runTurn: async (prompt: string, opts: { signal?: AbortSignal; outputSchema?: JsonSchema; timeoutMs?: number } = {}): Promise<WorkerTurnResult> => {
				if (handleState.kind === "closed") {
					throw new Error(`Worker ${agentId} is already closed (${handleState.finalStatus})`);
				}
				if (handleState.kind === "broken") {
					throw new Error(`Worker ${agentId} session is broken after respawn failure (${handleState.error})`);
				}
				if (handleState.kind === "running_turn") {
					throw new Error(`Worker ${agentId} already has an active turn in flight`);
				}
				const rollover = handleState.pendingRollover;
				const prevOutcome = handleState.lastOutcome;
				handleState = { kind: "running_turn", lastOutcome: prevOutcome };
				let currentPrompt = prompt;
				let rpmRetries = 0;

				try {
					// Tier 2 Clean-Slate Handoff rollover before starting a new turn on a heavily compacted session.
					// Because this boundary already resets the KV cache, opportunistically escalate to a higher tier if available.
					if (rollover && this.autoHandoffOnSecondCompaction) {
						const rolloverSignal = opts.signal
							? AbortSignal.any([this.workAbort.signal, abort.signal, opts.signal])
							: AbortSignal.any([this.workAbort.signal, abort.signal]);
						const targetTier = escalationState.status === "ready" ? findHigherHealthyTier() : undefined;
						const switched = await switchSessionWithHandoff({
							reason: rollover.reason,
							reasonKind: "compaction_limit",
							originalPrompt: prompt,
							failedApproaches: rollover.failedApproaches,
							escalateToTier: targetTier,
							signal: rolloverSignal,
						});
						currentPrompt = `${switched.prompt}\n\nNext instruction:\n${prompt}`;
					}

					for (;;) {
						const combinedSignal = opts.signal
							? AbortSignal.any([this.workAbort.signal, abort.signal, opts.signal])
							: AbortSignal.any([this.workAbort.signal, abort.signal]);

						lastToolSig = "";
						turnToolLog = [];
						const turnWaitedMs = pendingPermitWaitMs;
						pendingPermitWaitMs = 0;

						const rawRes = await session.runTurn(currentPrompt, { ...opts, signal: combinedSignal });
						// Automatically capture WIP + content-addressed tree snapshot on every write-worker turn exit/interrupt.
						let workspaceSnapshot = rawRes.workspaceSnapshot;
						if (!req.readOnly && branch) {
							const wipSha = this.worktrees.commitWip(workspace, `one-piece(${agent.handle}): turn ${agent.turns + 1}`);
							const headSha = this.worktrees.headSha(workspace);
							const treeSha = this.worktrees.treeSha?.(workspace);
							const hasEdits = Boolean(wipSha) || (Boolean(headSha) && headSha !== initialBaseHeadSha);
							workspaceSnapshot = { headSha, treeSha, wipSha, hasEdits };
						}
						const res: WorkerTurnResult = workspaceSnapshot ? { ...rawRes, workspaceSnapshot } : rawRes;
						const latest = this.store.get("agents", agentId) ?? agent;
						agent = {
							...latest,
							turns: latest.turns + 1,
							sessionId: res.sessionId ?? latest.sessionId,
							model: res.model ?? latest.model,
							updatedAt: Date.now(),
						};
						this.bus.save("agents", agent, agentId);

						let turnTokens: number | undefined;
						if (res.usage) {
							const computed = res.usage.totalTokens ?? ((res.usage.inputTokens ?? 0) + (res.usage.outputTokens ?? 0));
							turnTokens = computed || undefined;
							this.chargeBudget(agentId, selection.driver.id, turnTokens, res.usage.usd, undefined, res.usage, agent.model);
						}
						const diffSha = this.worktrees.diffSha(workspace);
						const cleanError = res.status === "failed" || res.status === "rate_limited"
							? this.bus.redactor.redactText(res.error)
							: undefined;
						const transcriptEntry = {
							ts: Date.now(),
							turn: agent.turns,
							driverId: selection.driver.id,
							model: agent.model,
							sessionId: agent.sessionId,
							status: res.status,
							durationMs: res.usage?.durationMs,
							waitedMs: turnWaitedMs || undefined,
							diffSha,
							usage: res.usage,
							prompt: this.bus.redactor.redactText(currentPrompt),
							finalText: this.bus.redactor.redactText(res.finalText ?? ""),
							error: cleanError,
							quotaError: res.status === "rate_limited"
								? { ...res.quotaError, raw: this.bus.redactor.redactText(res.quotaError.raw) }
								: undefined,
							tools: turnToolLog,
						};
						try {
							appendFileSync(transcriptAbs, `${JSON.stringify(transcriptEntry)}\n`, "utf8");
						} catch {
							// Best-effort durable transcript write; never crash worker turn.
						}

						const cachedTok = res.usage?.cachedTokens;
						const inputTok = res.usage?.inputTokens ?? 0;
						const cacheWriteTok = res.usage?.cacheWriteTokens ?? 0;
						// pi-ai splits inputTokens (uncached) from cachedTokens; CLI drivers (Codex/Grok/Agy) report inputTokens inclusive of cachedTokens.
						const totalPromptIn = selection.driver.kind === "pi-in-process"
							? inputTok + (cachedTok ?? 0) + cacheWriteTok
							: Math.max(inputTok, cachedTok ?? 0);
						const cacheHitRate = cachedTok !== undefined && totalPromptIn > 0
							? Math.min(1, Math.round((cachedTok / totalPromptIn) * 10_000) / 10_000)
							: undefined;

						this.bus.emit(
							this.runId,
							"agent.turn",
							{
								turn: agent.turns,
								driverId: selection.driver.id,
								model: agent.model,
								status: res.status,
								toolSig: lastToolSig || undefined,
								diffSha,
								durationMs: res.usage?.durationMs,
								waitedMs: turnWaitedMs || undefined,
								inputTokens: res.usage?.inputTokens,
								outputTokens: res.usage?.outputTokens,
								cachedTokens: res.usage?.cachedTokens,
								cacheWriteTokens: res.usage?.cacheWriteTokens,
								cacheHitRate,
								reasoningTokens: res.usage?.reasoningTokens,
								totalTokens: turnTokens,
								usd: res.usage?.usd,
								error: cleanError?.slice(0, 600),
								quotaErrorKind: res.status === "rate_limited" ? res.quotaError.kind : undefined,
								promptBytes: Buffer.byteLength(currentPrompt),
								finalTextBytes: Buffer.byteLength(res.finalText ?? ""),
								transcriptFile: transcriptRel,
							},
							agentId,
						);

						// If TriggerEngine armed a stall escalation during this turn, immediately escalate cleanly at this cold boundary.
						const pendingEsc = consumeEscalation();
						if (pendingEsc && !combinedSignal.aborted) {
							const escalated = await switchSessionWithHandoff({
								reason: pendingEsc.reason,
								reasonKind: "stall_escalation",
								originalPrompt: prompt,
								failedApproaches: res.failedApproaches,
								escalateToTier: pendingEsc.targetMinTier,
								signal: combinedSignal,
							});
							if (escalated.escalated) {
								currentPrompt = escalated.prompt;
								rpmRetries = 0;
								continue;
							}
						}

						switch (res.status) {
							case "completed":
							case "yielded":
							case "interrupted": {
								if (res.status === "completed") this.router.reportSuccess(selection.driver.id);
								transitionToIdle(
									{ status: res.status },
									res.needsHandoff && this.autoHandoffOnSecondCompaction
										? { reason: "Session hit compaction rollover threshold", failedApproaches: res.failedApproaches }
										: undefined,
								);
								return res;
							}

							case "failed": {
								transitionToIdle(
									{ status: "failed", error: res.error },
									res.needsHandoff && this.autoHandoffOnSecondCompaction
										? { reason: "Session hit compaction rollover threshold", failedApproaches: res.failedApproaches }
										: undefined,
								);
								return res;
							}

							case "rate_limited": {
								// Class 1: Transient RPM / 429 / 529 -> jittered backoff on same worker
								if (res.quotaError.kind === "transient_rpm" && rpmRetries < 3) {
									rpmRetries += 1;
									const waitMs = res.quotaError.retryAfterMs ?? Math.min(30_000, 1_500 * 2 ** (rpmRetries - 1) + Math.floor(Math.random() * 500));
									this.bus.emit(
										this.runId,
										"quota.retry",
										{
											driverId: selection.driver.id,
											attempt: rpmRetries,
											waitMs,
											reason: this.bus.redactor.redactText(res.error || res.quotaError.raw).slice(0, 240),
										},
										agentId,
									);
									await delay(waitMs, undefined, { signal: combinedSignal });
									continue;
								}

								// Class 2 (window exhausted) or Class 3 (hard auth/weekly cap): mark driver + failover worktree!
								const failedDriver = selection.driver.id;
								this.router.reportQuotaError(failedDriver, res.quotaError);

								let nextSelection;
								try {
									nextSelection = await this.router.acquireForRole(req.role, {
										avoidDrivers: [...attemptedDrivers, ...(req.avoidDrivers ?? [])],
										signal: combinedSignal,
									});
								} catch {
									transitionToIdle({ status: "rate_limited", error: res.error });
									return res;
								}

								if (attemptedDrivers.has(nextSelection.driver.id)) {
									nextSelection.release();
									transitionToIdle({ status: "rate_limited", error: res.error });
									return res;
								}

								const handoff = synthesizeHandoffFile({
									runId: this.runId,
									agentId,
									fromDriver: failedDriver,
									reason: res.error || res.quotaError.raw,
									reasonKind: "quota_failover",
									originalPrompt: prompt,
									workspace,
									worktrees: this.worktrees,
									store: this.store,
									failedApproaches: res.failedApproaches,
									acceptanceCriteria: assignedTask?.acceptanceCriteria,
									ownedPaths: assignedTask?.ownedPaths,
								});

								await session.close().catch(() => {});
								selection.release();
								mcpReg.unregister();

								selection = nextSelection;
								pendingPermitWaitMs += nextSelection.waitedMs ?? 0;
								attemptedDrivers.add(selection.driver.id);
								tools = buildTools(selection.driver.kind, selection.driver.id);
								mcpReg = this.mcp.registerWorker({ runId: this.runId, agentId, role: req.role, workspace, tools });

								const latestHandoff = this.store.get("agents", agentId) ?? agent;
								agent = { ...latestHandoff, driverId: selection.driver.id, sessionId: undefined, model: undefined, updatedAt: Date.now() };
								this.bus.save("agents", agent, agentId);
								this.bus.emit(
									this.runId,
									"agent.handoff",
									{
										agentId,
										fromDriver: failedDriver,
										toDriver: selection.driver.id,
										workspace,
										handoffPath: handoff.handoffPath,
										reasonKind: "quota_failover",
										waitedMs: nextSelection.waitedMs || undefined,
									},
									agentId,
								);

								try {
									session = await selection.driver.spawn({
										runId: this.runId,
										agentId,
										role: req.role,
										workspace,
										systemPrompt: composedSystemPrompt,
										maxTurns: req.maxTurns,
										readOnly: req.readOnly,
										deniedReadPaths: effectiveDeniedReadPaths,
										cacheKeyPrefix,
										compaction: compactionPolicy,
										mcp: mcpReg.connection,
										tools,
										onActivity: handleActivity,
									});
								} catch (error) {
									handleState = { kind: "broken", error: error instanceof Error ? error.message : String(error) };
									throw error;
								}
								currentPrompt = handoff.prompt;
								rpmRetries = 0;
								break;
							}

							default:
								return assertNever(res, "Unhandled WorkerTurnResult status");
						}
					}
				} catch (error) {
					transitionToIdle({
						status: "failed",
						error: error instanceof Error ? error.message : String(error),
					});
					throw error;
				}
			},
			steer: (msg) => (handleState.kind === "closed" || handleState.kind === "broken" ? Promise.resolve() : (session.steer?.(msg) ?? Promise.resolve())),
			interrupt: () => (handleState.kind === "closed" || handleState.kind === "broken" ? Promise.resolve() : (session.interrupt?.() ?? Promise.resolve())),
			close: async () => {
				if (handleState.kind === "closed") return;
				// Passive deliverable capture: automatically snapshot & verify committed worker edits
				// even when the worker never called `report_finding` manually.
				if (passiveSnapshotOnExit && !req.readOnly && !this.closeoutAbort.signal.aborted) {
					try {
						const wipSha = this.worktrees.commitWip(workspace, `${agent.handle}: passive snapshot`);
						const headAfter = this.worktrees.headSha(workspace);
						const hasEdits = Boolean(wipSha) || Boolean(headAfter && initialBaseHeadSha && headAfter !== initialBaseHeadSha);
						if (hasEdits) {
							const treeSha = this.worktrees.treeSha?.(workspace) ?? this.worktrees.diffSha(workspace);
							const alreadySubmitted = this.store
								.list("findings", { runId: this.runId })
								.some((f) => f.authorAgentId === agentId && f.submissions.some((s) => s.treeSha === treeSha));
							if (!alreadySubmitted) {
								const diff = this.worktrees.diffStat(workspace, initialBaseHeadSha);
								await this.trust.submitFinding(
									{
										agentId,
										driverId: selection.driver.id,
										taskId: req.taskId,
										workspace,
										claim: `${agent.handle} passive workspace deliverable`,
										summary: `Auto-captured worktree changes on exit.\nDiff:\n${diff.slice(0, 1200)}`,
										level: "empirical",
									},
									this.closeoutAbort.signal,
								);
							}
						}
					} catch {
						// Best-effort passive capture; never block worker teardown.
					}
				}
				const finalStatus: TerminalAgentStatus =
					handleState.kind === "broken"
						? "failed"
						: handleState.lastOutcome?.status === "failed" || handleState.lastOutcome?.status === "rate_limited"
							? "failed"
							: handleState.lastOutcome?.status === "interrupted"
								? "stopped"
								: "done";
				const finalReason = handleState.kind === "broken" ? handleState.error : handleState.lastOutcome?.error;
				handleState = { kind: "closed", finalStatus, reason: finalReason };
				this.activeHandles.delete(agentId);
				const latestClose = this.store.get("agents", agentId) ?? agent;
				if (latestClose.status === "running") {
					this.updateAgentStatus(agentId, finalStatus, finalReason);
				}
				await session.close().catch(() => {});
				mcpReg.unregister();
				selection.release();
			},
		};

		this.activeHandles.set(agentId, { handle, abort, workspace, deniedReadPaths: effectiveDeniedReadPaths, armEscalation });
		return handle;
	}

	async execute(plugin: TopologyPlugin, signal?: AbortSignal): Promise<TopologyOutcome & { reportPath: string }> {
		if (this.lifecycle.kind !== "ready") {
			throw new Error(`SwarmOS.execute() called in invalid lifecycle state "${this.lifecycle.kind}"`);
		}
		this.lifecycle = { kind: "executing", topology: plugin.name };
		const onExternalAbort = () => this.workAbort.abort(signal?.reason);
		signal?.addEventListener("abort", onExternalAbort, { once: true });
		this.bus.emit(this.runId, "run.started", { topology: plugin.name, goal: this.currentRun.goal.title });

		let outcome: TopologyOutcome;
		try {
			outcome = await plugin.run(this, {
				goal: this.currentRun.goal.text,
				rubric: this.currentRun.goal.rubric,
				signal: this.workAbort.signal,
				closeoutSignal: this.closeoutAbort.signal,
			});
		} catch (error) {
			outcome = {
				status: this.workAbort.signal.aborted ? "stopped" : "failed",
				summary: error instanceof Error ? error.message : String(error),
			};
		} finally {
			signal?.removeEventListener("abort", onExternalAbort);
		}

		// Close any lingering workers cleanly before final verification & closeout.
		await Promise.allSettled([...this.activeHandles.values()].map(({ handle }) => handle.close()));

		this.currentRun = transitionRun(this.currentRun, {
			type: "finish",
			status: outcome.status,
			reason: outcome.summary,
			now: Date.now(),
		}).next;
		const closedOut = await this.closeout.finalize(this.currentRun, outcome.summary);
		if (closedOut.nominatedFindingId !== undefined) {
			this.currentRun = transitionRun(this.currentRun, {
				type: "nominate",
				findingId: closedOut.nominatedFindingId,
				revision: closedOut.nominatedRevision,
				now: Date.now(),
			}).next;
		}
		this.bus.save("runs", this.currentRun);
		this.bus.emit(this.runId, "run.finished", { status: outcome.status, reason: outcome.summary });

		const nomination = closedOut.nominatedFindingId !== undefined
			? { nominatedFindingId: closedOut.nominatedFindingId, nominatedRevision: closedOut.nominatedRevision }
			: {};
		return {
			status: outcome.status,
			summary: outcome.summary,
			...nomination,
			reportPath: closedOut.reportPath,
		};
	}

	private clearWallBudgetTimers(): void {
		switch (this.wallBudgetState.phase) {
			case "active":
				clearTimeout(this.wallBudgetState.reserveTimer);
				clearTimeout(this.wallBudgetState.hardTimer);
				break;
			case "closeout_grace":
				clearTimeout(this.wallBudgetState.graceTimer);
				break;
			case "unbounded":
			case "expired":
			case "disposed":
				break;
			default:
				assertNever(this.wallBudgetState, "Unhandled wallBudgetState");
		}
		this.wallBudgetState = { phase: "disposed" };
	}

	async dispose(): Promise<void> {
		if (this.lifecycle.kind === "disposed") return;
		this.lifecycle = { kind: "disposed" };
		this.clearWallBudgetTimers();
		this.triggers.stop();
		this.workAbort.abort();
		this.closeoutAbort.abort();
		await Promise.allSettled([...this.activeHandles.values()].map(({ handle }) => handle.close()));
		await this.scheduler.dispose();
		await this.mcp.close();
	}

	private updateAgentStatus(agentId: string, status: AgentRecord["status"], reason?: string): void {
		const existing = this.store.get("agents", agentId);
		if (!existing) return;
		const { next, changed } = transitionAgentRecord(existing, {
			type: "set_status",
			status,
			reason,
			now: Date.now(),
		});
		if (!changed) return;
		this.bus.save("agents", next, agentId);
		this.bus.emit(this.runId, "agent.status", { status: next.status, reason: next.statusReason }, agentId);
	}

	private chargeBudget(
		agentId: string | undefined,
		driverId: string | undefined,
		tokens?: number,
		usd?: number,
		units?: Record<string, number>,
		usage?: UsageRecord,
		model?: string,
	): void {
		const spent = { ...this.currentRun.spent };
		if (tokens) spent.tokens = (spent.tokens ?? 0) + tokens;
		if (usd) spent.usd = (spent.usd ?? 0) + usd;
		if (units) {
			for (const [k, v] of Object.entries(units)) spent[k] = (spent[k] ?? 0) + v;
		}
		this.currentRun = { ...this.currentRun, spent, updatedAt: Date.now() };
		this.bus.save("runs", this.currentRun);
		if (agentId) {
			const ag = this.store.get("agents", agentId);
			if (ag) {
				const aSpent = { ...ag.spent };
				if (tokens) aSpent.tokens = (aSpent.tokens ?? 0) + tokens;
				if (usd) aSpent.usd = (aSpent.usd ?? 0) + usd;
				this.store.put("agents", { ...ag, spent: aSpent, updatedAt: Date.now() });
			}
		}
		this.bus.emit(
			this.runId,
			"budget.charged",
			{
				agentId,
				driverId,
				model,
				tokens,
				inputTokens: usage?.inputTokens,
				outputTokens: usage?.outputTokens,
				cachedTokens: usage?.cachedTokens,
				cacheWriteTokens: usage?.cacheWriteTokens,
				reasoningTokens: usage?.reasoningTokens,
				cacheReadReported: usage?.cacheReadReported,
				cacheWriteReported: usage?.cacheWriteReported,
				reasoningReported: usage?.reasoningReported,
				usd,
				units,
			},
			agentId,
		);
	}
}
