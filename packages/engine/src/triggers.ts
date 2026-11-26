import type { EventBus, HarnessEvent } from "@one-piece/core";

export interface TriggerOptions {
	runId: string;
	bus: EventBus;
	/** Number of consecutive identical (toolSig + diffSha) turns before marking an agent stalled. */
	maxRepeatedTurns?: number;
	isInCloseoutReserve: () => boolean;
	onStall?: (agentId: string, reason: string) => void;
	onReserveEntered?: (reason: string) => void;
}

type TriggerLifecycle =
	| { readonly status: "stopped" }
	| {
		readonly status: "active";
		readonly unsubscribe: () => void;
		reserve: { readonly fired: false } | { readonly fired: true; readonly reason: string; readonly at: number };
	};

type StallEntry =
	| { readonly state: "tracking"; readonly sig: string; readonly count: number }
	| { readonly state: "stalled"; readonly sig: string; readonly count: number };

/**
 * Pure event-driven reactive rules (zero 1 Hz polling).
 * 1. Dependency unblocking: task.status(done) -> emits task.ready for unblocked dependents
 * 2. Mechanical loop/stall detector: catches MAST FM-1.3 step repetition automatically
 * 3. Reserve closeout trigger: halts exploration at reservePct so winning code is always nominated
 */
export class TriggerEngine {
	private readonly runId: string;
	private readonly bus: EventBus;
	private readonly maxRepeats: number;
	private readonly isInReserve: () => boolean;
	private readonly onStall?: (agentId: string, reason: string) => void;
	private readonly onReserveEntered?: (reason: string) => void;
	private readonly stallTrackers = new Map<string, StallEntry>();
	private readonly readyNotified = new Set<string>();
	private lifecycle: TriggerLifecycle = { status: "stopped" };

	constructor(opts: TriggerOptions) {
		this.runId = opts.runId;
		this.bus = opts.bus;
		this.maxRepeats = opts.maxRepeatedTurns ?? 3;
		this.isInReserve = opts.isInCloseoutReserve;
		this.onStall = opts.onStall;
		this.onReserveEntered = opts.onReserveEntered;
	}

	start(): void {
		if (this.lifecycle.status === "active") return;
		const unsubscribe = this.bus.on((event) => this.handle(event));
		this.lifecycle = { status: "active", unsubscribe, reserve: { fired: false } };
	}

	stop(): void {
		if (this.lifecycle.status === "stopped") return;
		this.lifecycle.unsubscribe();
		this.lifecycle = { status: "stopped" };
	}

	private handle(event: HarnessEvent): void {
		if (this.lifecycle.status !== "active" || event.runId !== this.runId) return;

		if (event.type === "task.status" && event.data.status === "done") {
			this.checkUnblockedTasks();
		} else if (event.type === "agent.turn" && event.nodeId) {
			this.checkStall(event.nodeId, event.data);
		} else if (event.type === "budget.charged") {
			this.checkReserve();
		}
	}

	private checkUnblockedTasks(): void {
		const tasks = this.bus.store.list("tasks", { runId: this.runId });
		const doneIds = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
		for (const task of tasks) {
			if (task.status !== "open" || this.readyNotified.has(task.id)) continue;
			if (task.dependsOn.every((dep) => doneIds.has(dep))) {
				this.readyNotified.add(task.id);
				this.bus.emit(this.runId, "task.ready", { taskId: task.id, title: task.title });
			}
		}
	}

	private checkStall(agentId: string, data: Record<string, unknown>): void {
		const toolSig = typeof data.toolSig === "string" ? data.toolSig : "";
		const diffSha = typeof data.diffSha === "string" ? data.diffSha : "";
		if (!toolSig && !diffSha) return;
		const sig = `${toolSig}::${diffSha}`;
		const prev = this.stallTrackers.get(agentId);
		if (prev && prev.state === "tracking" && prev.sig === sig) {
			const nextCount = prev.count + 1;
			if (nextCount >= this.maxRepeats) {
				const reason = `Repeated identical no-progress state (${sig}) ${nextCount} times`;
				this.stallTrackers.set(agentId, { state: "stalled", sig, count: nextCount });
				this.bus.emit(this.runId, "agent.stalled", { agentId, reason, repeatCount: nextCount }, agentId);
				this.onStall?.(agentId, reason);
			} else {
				this.stallTrackers.set(agentId, { state: "tracking", sig, count: nextCount });
			}
		} else {
			this.stallTrackers.set(agentId, { state: "tracking", sig, count: 1 });
		}
	}

	private checkReserve(): void {
		if (this.lifecycle.status !== "active" || this.lifecycle.reserve.fired) return;
		if (this.isInReserve()) {
			const reason = "Run entered closeout reserve; halting new exploration to verify and nominate best artifact.";
			this.lifecycle.reserve = { fired: true, reason, at: Date.now() };
			this.bus.emit(this.runId, "run.closing", { reason });
			this.onReserveEntered?.(reason);
		}
	}
}
