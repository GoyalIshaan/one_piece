import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	type BudgetVector,
	type CallRecord,
	EventBus,
	type Goal,
	type HarnessApi,
	type HarnessModule,
	type HarnessProfile,
	type ModelRouter,
	moduleState,
	newId,
	type NodeContext,
	Redactor,
	type Run,
	ServiceRegistry,
	type Store,
	SwarmTree,
	type SwarmNode,
	TERMINAL_STATUSES,
	TREE_ROLES,
} from "@one-piece/core";
import { briefFor, systemPrompt } from "./prompts.ts";
import { Semaphore } from "./semaphore.ts";

export interface HarnessConfig {
	/** Folder for this run's workspaces, report and logs. */
	runDir: string;
	/** Optional seed folder copied into each leaf's workspace. */
	seedWorkspace?: string;
	maxConcurrentAgents: number;
	/** Budget fractions at which a node gets a hidden review. */
	reviewFractions: number[];
	claimsMaxRounds: number;
	questionDeadlineMs: number;
	/** Run-budget fractions at which the root reviewer considers a new epoch (trigger C). */
	epochCheckpoints: number[];
	/** Hidden reviews in a row without a newly accepted finding before trigger A fires. */
	saturationWindow: number;
	/** Agent turns without a new checkpoint before a stall review. */
	stallTurns: number;
	/** "Continue" nudges given to an agent that stops without calling finish. */
	maxNudges: number;
	/** Fraction of the run budget kept back so the root can always write its report. */
	reportReserve: number;
	/** Retries (with exponential backoff) after temporary provider errors such as overload or rate limits. */
	maxRetries: number;
	retryBaseMs: number;
	/** Agent turns between two hidden reviews of the same node. */
	reviewCooldownTurns: number;
	profile: HarnessProfile;
	caps: { maxChildren: number; maxDepth: number };
}

export const DEFAULT_CONFIG: Omit<HarnessConfig, "runDir"> = {
	maxConcurrentAgents: 6,
	reviewFractions: [0.25, 0.5, 0.75],
	claimsMaxRounds: 3,
	questionDeadlineMs: 15 * 60_000,
	epochCheckpoints: [0.25, 0.5, 0.75],
	saturationWindow: 6,
	stallTurns: 8,
	maxNudges: 3,
	reportReserve: 0.05,
	maxRetries: 4,
	retryBaseMs: 5_000,
	reviewCooldownTurns: 4,
	profile: {},
	caps: { maxChildren: 8, maxDepth: 6 },
};

interface Live {
	agent?: Agent;
	inbox: string[];
	inboxWaiters: Array<() => void>;
	turnWaiters: Array<() => void>;
	settled: Promise<void>;
	resolveSettled: () => void;
	holdsSlot: boolean;
	parked: number;
	abort: AbortController;
	nudges: number;
	retries: number;
	lastReviewTurn: number;
	lastCheckpointTurn: number;
	reviewedFractions: Set<number>;
	reviewing: boolean;
	spawnCalls: number;
}

export type ToolFactory = (harness: Harness, node: SwarmNode) => AgentTool<any>[];

/**
 * The swarm engine. Owns the run, the tree, the agent slots and every node's lifecycle.
 * Role-specific behaviour (tree tools, trust layer, reviewers, epochs) is attached through
 * tool factories and the hooks below, so each piece stays in its own file.
 */
export class Harness implements HarnessApi {
	readonly bus: EventBus;
	readonly tree: SwarmTree;
	readonly store: Store;
	readonly services = new ServiceRegistry();
	readonly config: HarnessConfig;
	readonly modules: HarnessModule[];
	readonly router: ModelRouter;
	private readonly slots: Semaphore;
	private readonly live = new Map<string, Live>();
	private readonly roleTools: ToolFactory[] = [];
	private readonly callHooks: Array<(node: SwarmNode, record: CallRecord) => void> = [];
	private readonly turnHooks: Array<(node: SwarmNode) => void> = [];
	private currentRun?: Run;
	private resolveDone?: () => void;
	readonly done: Promise<void>;

	constructor(options: { store: Store; router: ModelRouter; modules?: HarnessModule[]; config: Partial<HarnessConfig> & { runDir: string }; redactor?: Redactor }) {
		this.store = options.store;
		this.router = options.router;
		this.modules = options.modules ?? [];
		this.config = { ...DEFAULT_CONFIG, ...options.config };
		this.bus = new EventBus(this.store, options.redactor ?? new Redactor());
		this.tree = new SwarmTree(this.bus);
		this.slots = new Semaphore(this.config.maxConcurrentAgents);
		this.services.register("router", this.router);
		this.done = new Promise((resolve) => {
			this.resolveDone = resolve;
		});
	}

	// ---- extension points ---------------------------------------------------------------------

	addTools(factory: ToolFactory): void {
		this.roleTools.push(factory);
	}

	onCall(hook: (node: SwarmNode, record: CallRecord) => void): void {
		this.callHooks.push(hook);
	}

	onTurn(hook: (node: SwarmNode) => void): void {
		this.turnHooks.push(hook);
	}

	// ---- HarnessApi -------------------------------------------------------------------------

	run(): Run {
		if (!this.currentRun) throw new Error("No run started");
		return this.currentRun;
	}

	saveRun(patch: Partial<Run>): void {
		const run = this.run();
		Object.assign(run, patch, { updatedAt: Date.now() });
		this.bus.save("runs", run);
	}

	workspaceOf(nodeId: string): string | undefined {
		const node = this.tree.get(nodeId);
		if (!node) return undefined;
		const owner = node.role === "claims_reviewer" || node.role === "hidden_reviewer" ? node.targetNodeId : node.id;
		return owner ? join(this.config.runDir, "workspaces", owner) : undefined;
	}

	deliver(nodeId: string, text: string): void {
		const live = this.live.get(nodeId);
		const node = this.tree.get(nodeId);
		if (!live || !node || TERMINAL_STATUSES.includes(node.status)) return;
		this.bus.emit(node.runId, "node.delivered", { text: text.slice(0, 2000) }, nodeId);
		if (live.agent?.state.isStreaming && live.parked === 0) {
			live.agent.steer({ role: "user", content: text, timestamp: Date.now() });
			return;
		}
		live.inbox.push(text);
		for (const wake of live.inboxWaiters.splice(0)) wake();
	}

	whenSettled(nodeId: string): Promise<void> {
		return this.liveOf(nodeId).settled;
	}

	nextTurn(nodeId: string): Promise<void> {
		const live = this.liveOf(nodeId);
		return new Promise((resolve) => live.turnWaiters.push(resolve));
	}

	async park<T>(nodeId: string, waitFor: Promise<T>): Promise<T> {
		const live = this.liveOf(nodeId);
		live.parked += 1;
		if (live.parked === 1 && live.holdsSlot) {
			live.holdsSlot = false;
			this.slots.release();
			this.tree.setStatus(nodeId, "parked");
		}
		try {
			return await raceAbort(waitFor, live.abort.signal);
		} finally {
			live.parked -= 1;
			if (live.parked === 0 && !this.tree.isTerminal(nodeId)) {
				await this.slots.acquire();
				live.holdsSlot = true;
				if (!this.tree.isTerminal(nodeId)) this.tree.setStatus(nodeId, "running");
			}
		}
	}

	// ---- inbox ------------------------------------------------------------------------------

	drainInbox(nodeId: string): string[] {
		return this.liveOf(nodeId).inbox.splice(0);
	}

	inboxSignal(nodeId: string): Promise<void> {
		const live = this.liveOf(nodeId);
		if (live.inbox.length) return Promise.resolve();
		return new Promise((resolve) => live.inboxWaiters.push(resolve));
	}

	signalOf(nodeId: string): AbortSignal {
		return this.liveOf(nodeId).abort.signal;
	}

	liveState(nodeId: string): Live {
		return this.liveOf(nodeId);
	}

	private liveOf(nodeId: string): Live {
		let live = this.live.get(nodeId);
		if (!live) {
			let resolveSettled!: () => void;
			const settled = new Promise<void>((resolve) => {
				resolveSettled = resolve;
			});
			live = {
				inbox: [],
				inboxWaiters: [],
				turnWaiters: [],
				settled,
				resolveSettled,
				holdsSlot: false,
				parked: 0,
				abort: new AbortController(),
				nudges: 0,
				retries: 0,
				lastReviewTurn: Number.NEGATIVE_INFINITY,
				lastCheckpointTurn: 0,
				reviewedFractions: new Set(),
				reviewing: false,
				spawnCalls: 0,
			};
			this.live.set(nodeId, live);
		}
		return live;
	}

	// ---- runs -------------------------------------------------------------------------------

	async start(goal: Goal, budget: BudgetVector, options: { workspace?: string; config?: Record<string, unknown> } = {}): Promise<Run> {
		const now = Date.now();
		const runId = newId("run");
		mkdirSync(this.config.runDir, { recursive: true });
		this.currentRun = {
			id: runId,
			goal,
			status: "running",
			budget,
			epoch: 1,
			rootNodeId: "",
			workspace: options.workspace ?? this.config.seedWorkspace,
			config: options.config ?? {},
			createdAt: now,
			updatedAt: now,
		};
		this.bus.save("runs", this.currentRun);
		this.bus.emit(runId, "run.started", { goal, budget, providers: this.router.providers() });
		for (const module of this.modules) await module.setup?.(this);
		const root = this.tree.create({ runId, epoch: 1, role: "root", goal, budget, modules: this.config.profile, caps: this.config.caps });
		this.saveRun({ rootNodeId: root.id });
		this.bus.save("epochs", { id: newId("epoch"), runId, number: 1, rootNodeId: root.id, carried: [], startedAt: now });
		this.launch(root, briefFor(root));
		return this.currentRun;
	}

	/** Start a node's agent loop in the background. */
	launch(node: SwarmNode, firstMessage: string): void {
		void this.runNode(node, firstMessage);
	}

	/** Run a node to completion and resolve when it settles. */
	async runNode(node: SwarmNode, firstMessage: string): Promise<void> {
		const live = this.liveOf(node.id);
		try {
			await this.slots.acquire();
			live.holdsSlot = true;
			if (this.tree.isTerminal(node.id)) return;
			this.tree.setStatus(node.id, "running");
			const agent = this.buildAgent(node);
			live.agent = agent;
			let message = firstMessage;
			for (;;) {
				await agent.prompt(message);
				if (node.finishedSummary !== undefined || this.tree.isTerminal(node.id)) break;
				const exhausted = TREE_ROLES.includes(node.role) ? this.tree.exhausted(node.id) : undefined;
				if (exhausted) {
					node.finishedSummary = `Stopped: ${exhausted} budget exhausted.`;
					break;
				}
				const inbox = this.drainInbox(node.id);
				if (inbox.length) {
					message = inbox.join("\n\n");
					continue;
				}
				const error = agent.state.errorMessage;
				if (error) {
					this.bus.emit(node.runId, "agent.error", { error }, node.id);
					if (TRANSIENT.test(error) && live.retries < this.config.maxRetries) {
						const delay = this.config.retryBaseMs * 3 ** live.retries;
						live.retries += 1;
						this.bus.emit(node.runId, "agent.retry", { attempt: live.retries, delayMs: delay }, node.id);
						await this.park(node.id, new Promise((resolve) => setTimeout(resolve, delay)));
						message = "The previous model call failed with a temporary provider error. Continue where you left off.";
						continue;
					}
				}
				if (live.nudges >= this.config.maxNudges) {
					node.finishedSummary = "Stopped: the agent ended its turn repeatedly without calling finish.";
					break;
				}
				live.nudges += 1;
				message = "Continue working on your goal. When you are done, call finish (and report_finding first if you have a result).";
			}
			if (!this.tree.isTerminal(node.id)) {
				this.tree.update(node.id, { finishedSummary: node.finishedSummary });
				this.tree.setStatus(node.id, "done", node.finishedSummary);
			}
		} catch (error) {
			if (!this.tree.isTerminal(node.id)) this.tree.setStatus(node.id, "failed", String(error));
			this.bus.emit(node.runId, "agent.error", { error: String(error) }, node.id);
		} finally {
			if (live.holdsSlot) {
				live.holdsSlot = false;
				this.slots.release();
			}
			for (const wake of live.turnWaiters.splice(0)) wake();
			live.resolveSettled();
		}
	}

	/** Stop a node's subtree. Nothing is deleted: nodes are marked and their work archived. */
	stopSubtree(nodeId: string, status: "cut" | "merged" | "archived" | "done", reason: string): void {
		for (const member of this.tree.subtree(nodeId).reverse()) {
			if (this.tree.isTerminal(member.id)) continue;
			this.services.get("scheduler")?.cancelSubtree(member.id);
			const live = this.live.get(member.id);
			live?.abort.abort(reason);
			live?.agent?.abort();
			this.tree.setStatus(member.id, status, reason);
			live?.resolveSettled();
		}
	}

	finishRun(status: Run["status"], reason: string): void {
		const run = this.run();
		if (run.status !== "running") return;
		for (const node of this.tree.all()) {
			if (!this.tree.isTerminal(node.id) && node.role !== "root") this.stopSubtree(node.id, "done", reason);
		}
		this.saveRun({ status });
		this.bus.emit(run.id, "run.finished", { status, reason });
		this.resolveDone?.();
	}

	writeReportFile(name: string, markdown: string): string {
		const path = join(this.config.runDir, name);
		writeFileSync(path, markdown);
		return path;
	}

	// ---- agents -----------------------------------------------------------------------------

	buildTools(node: SwarmNode): AgentTool<any>[] {
		const ctx: NodeContext = { node, harness: this };
		const tools: AgentTool<any>[] = [];
		for (const factory of this.roleTools) tools.push(...factory(this, node));
		for (const module of this.modules) {
			if (moduleState(node, module.manifest.name) !== "active") continue;
			if (!module.manifest.roles.includes(node.role)) continue;
			tools.push(...(module.tools?.(ctx) ?? []));
		}
		const seen = new Set<string>();
		return tools.filter((tool) => (seen.has(tool.name) ? false : (seen.add(tool.name), true)));
	}

	deferredModules(node: SwarmNode): HarnessModule[] {
		return this.modules.filter((m) => moduleState(node, m.manifest.name) === "deferred" && m.manifest.roles.includes(node.role));
	}

	refreshTools(node: SwarmNode): void {
		const agent = this.live.get(node.id)?.agent;
		if (agent) agent.state.tools = this.buildTools(node);
	}

	private buildAgent(node: SwarmNode): Agent {
		const ctx: NodeContext = { node, harness: this };
		const sections: string[] = [];
		for (const module of this.modules) {
			if (moduleState(node, module.manifest.name) !== "active" || !module.manifest.roles.includes(node.role)) continue;
			const section = module.prompt?.(ctx);
			if (section) sections.push(section);
		}
		const deferred = this.deferredModules(node).map((m) => `${m.manifest.name}: ${m.manifest.summary}`);
		const target = node.targetNodeId ? this.tree.get(node.targetNodeId) : undefined;
		const avoid = target?.model ? [target.model.provider] : [];
		const picked = node.model ?? this.router.pick(node.role, { avoidProviders: avoid });
		this.tree.update(node.id, { model: picked });
		const agent = new Agent({
			initialState: { systemPrompt: systemPrompt(node, sections, deferred), model: this.router.resolve(picked), tools: this.buildTools(node) },
			streamFn: this.router.streamFn((record) => this.recordCall(node, record)),
			sessionId: node.id,
		});
		agent.finishTurn = async () => {
			node.turns += 1;
			this.tree.update(node.id, { turns: node.turns });
			const live = this.liveOf(node.id);
			for (const wake of live.turnWaiters.splice(0)) wake();
			for (const hook of this.turnHooks) hook(node);
			if (node.finishedSummary !== undefined || this.tree.isTerminal(node.id)) return { action: "end" };
			if (TREE_ROLES.includes(node.role) && this.tree.exhausted(node.id)) return { action: "end" };
			return undefined;
		};
		agent.subscribe((event) => this.onAgentEvent(node, event));
		return agent;
	}

	private recordCall(node: SwarmNode, record: CallRecord): void {
		const usage = { tokens: record.totalTokens, usd: record.usd, [`tokens:${record.provider}`]: record.totalTokens };
		// Every agent's own spend is its own, reviewers included. A reviewer's spend is also recorded
		// as oversight on the node it reviews, which counts against that node's budget.
		this.tree.charge(node.id, usage);
		const target = TREE_ROLES.includes(node.role) ? undefined : (node.targetNodeId ?? this.run().rootNodeId);
		if (target && this.tree.get(target)) this.tree.chargeOversight(target, usage);
		this.bus.emit(node.runId, "model.call", { ...record, role: node.role, target }, node.id);
		for (const hook of this.callHooks) hook(node, record);
	}

	private onAgentEvent(node: SwarmNode, event: AgentEvent): void {
		if (event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message;
			const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
			const thinking = message.content.flatMap((b) => (b.type === "thinking" ? [b.thinking] : [])).join("\n");
			const calls = message.content.flatMap((b) => (b.type === "toolCall" ? [b.name] : []));
			const activity = calls.length ? `calling ${calls.join(", ")}` : text.split("\n").find((l) => l.trim())?.slice(0, 160);
			if (activity) this.tree.update(node.id, { activity });
			this.bus.emit(
				node.runId,
				"agent.message",
				{ text: text.slice(0, 6000), thinking: thinking.slice(0, 6000), toolCalls: calls, stopReason: message.stopReason, error: message.errorMessage },
				node.id,
			);
		} else if (event.type === "tool_execution_start") {
			this.bus.emit(node.runId, "tool.call", { tool: event.toolName, args: truncateJson(event.args, 2000) }, node.id);
		} else if (event.type === "tool_execution_end") {
			const result = event.result as { content?: Array<{ type: string; text?: string }> } | undefined;
			const text = result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
			this.bus.emit(node.runId, "tool.result", { tool: event.toolName, isError: event.isError, text: text.slice(0, 2000) }, node.id);
		}
	}
}

/** Provider errors worth retrying: overload, rate limits, timeouts, 5xx, dropped connections. */
const TRANSIENT = /overloaded|rate.?limit|too many requests|\b429\b|\b5\d\d\b|timed? ?out|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|temporarily unavailable|try again/i;

function truncateJson(value: unknown, max: number): unknown {
	const text = JSON.stringify(value) ?? "";
	return text.length <= max ? value : `${text.slice(0, max)}...`;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("stopped"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("stopped"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
