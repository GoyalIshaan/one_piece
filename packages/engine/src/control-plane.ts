import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type BoundOverride,
	type EventBus,
	type ExecutionControlMode,
	newId,
	type RunControlCommandRecord,
	type RunControlPayload,
	type RunControlState,
	type RunControlStatus,
	type Store,
	transitionRunControl,
} from "@one-piece/core";

export interface BestSoFarPointer {
	readonly runId: string;
	readonly findingId: string;
	readonly revision: number;
	readonly score?: number;
	readonly accepted: boolean;
	readonly artifactSha256?: string;
	readonly snapshotDir?: string;
	readonly claim: string;
	readonly updatedAt: number;
}

export interface RunControlPollSnapshot {
	readonly state: RunControlStatus;
	readonly newSteeringNotes: readonly string[];
	readonly boundOverride?: BoundOverride;
}

export interface RunControlControllerOptions {
	readonly runId: string;
	readonly runDir: string;
	readonly mode: ExecutionControlMode;
	readonly store: Store;
	readonly bus: EventBus;
	readonly onPause?: (reason: string) => void;
	readonly onResume?: (pausedMs: number, steeringNote?: string) => void;
	readonly onLiveSteer?: (message: string, targetAgentId?: string) => void;
	readonly onCoalesce?: (reason: string) => void;
}

/**
 * External Research / Eval Control Plane Controller.
 * Polls SQLite WAL `control_commands` (cross-process safe for CLI & Dashboard),
 * enforces `transitionRunControl` (absorbing `coalescing`, unpausable `"eval"` mode),
 * drives `waitIfPaused`, and atomically maintains `<runDir>/best-so-far.json`.
 */
export class RunControlController {
	private readonly opts: RunControlControllerOptions;
	private state: RunControlState = { status: "running", totalPausedMs: 0 };
	private readonly steeringNotes: string[] = [];
	private pendingSteeringIndex = 0;
	private pendingBoundOverride?: BoundOverride;
	private readonly wakeups = new Set<() => void>();
	private bestPointerScore = Number.NEGATIVE_INFINITY;
	private bestPointerAccepted = false;

	constructor(opts: RunControlControllerOptions) {
		this.opts = opts;
	}

	get mode(): ExecutionControlMode {
		return this.opts.mode;
	}

	get status(): RunControlStatus {
		return this.state.status;
	}

	get totalPausedMs(): number {
		if (this.state.status === "paused") {
			return this.state.totalPausedMs + Math.max(0, Date.now() - this.state.pausedAt);
		}
		return this.state.totalPausedMs;
	}

	activeSteeringNotes(): readonly string[] {
		return [...this.steeringNotes];
	}

	private notifyWakeups(): void {
		for (const fn of [...this.wakeups]) {
			fn();
		}
	}

	/** Enqueue an in-process control command (e.g., from a Researcher Checkpoint `"pause"` or `requestCoalesce`). */
	enqueueLocal(payload: RunControlPayload, issuedBy: RunControlCommandRecord["issuedBy"] = "os"): RunControlCommandRecord {
		const record: RunControlCommandRecord = {
			id: newId("ctl"),
			runId: this.opts.runId,
			issuedBy,
			createdAt: Date.now(),
			payload,
		};
		this.opts.store.put("control_commands", record);
		this.ingestCommands();
		return record;
	}

	/** Ingest unacknowledged SQLite WAL control commands without draining pending steering/bound outputs. */
	private ingestCommands(): void {
		const commands = this.opts.store
			.list("control_commands", { runId: this.opts.runId })
			.filter((c) => c.acknowledgedAt === undefined)
			.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

		for (const cmd of commands) {
			const now = Date.now();
			const res = transitionRunControl(this.state, cmd.payload, { mode: this.opts.mode, now });
			this.state = res.next;

			const acked: RunControlCommandRecord = {
				...cmd,
				acknowledgedAt: now,
				...(!res.accepted ? { rejectedReason: res.rejectedReason } : {}),
			};
			this.opts.store.put("control_commands", acked);

			if (!res.accepted) {
				this.opts.bus.emit(this.opts.runId, "run.control_applied", {
					commandId: cmd.id,
					type: cmd.payload.type,
					issuedBy: cmd.issuedBy,
					nextState: this.state.status,
					detail: `rejected: ${res.rejectedReason}`,
				});
				continue;
			}

			this.opts.bus.emit(this.opts.runId, "run.control_applied", {
				commandId: cmd.id,
				type: cmd.payload.type,
				issuedBy: cmd.issuedBy,
				nextState: this.state.status,
				detail:
					cmd.payload.type === "steer"
						? cmd.payload.message.slice(0, 200)
						: cmd.payload.type === "pause" || cmd.payload.type === "coalesce"
							? cmd.payload.reason
							: cmd.payload.type === "resume"
								? cmd.payload.steeringNote
								: cmd.payload.reason,
			});

			if (cmd.payload.type === "pause" && res.transitioned) {
				const reason = this.state.status === "paused" ? this.state.reason : "Paused";
				this.opts.bus.emit(this.opts.runId, "run.paused", { reason });
				this.opts.onPause?.(reason);
			} else if (cmd.payload.type === "resume" && res.transitioned) {
				const pausedMs = res.pausedDeltaMs ?? 0;
				this.opts.bus.emit(this.opts.runId, "run.resumed", {
					pausedMs,
					...(res.steeringNote ? { steeringNote: res.steeringNote } : {}),
				});
				this.opts.onResume?.(pausedMs, res.steeringNote);
			} else if (cmd.payload.type === "coalesce" && res.transitioned) {
				const reason = this.state.status === "coalescing" ? this.state.reason : "Coalesce requested";
				this.opts.onCoalesce?.(reason);
			}

			if (res.steeringNote) {
				const scope = cmd.payload.type === "steer" ? (cmd.payload.scope ?? "both") : "next_wave";
				if (scope === "next_wave" || scope === "both") {
					this.steeringNotes.push(res.steeringNote);
				}
				if (cmd.payload.type === "steer" && (scope === "live_workers" || scope === "both")) {
					this.opts.onLiveSteer?.(res.steeringNote, cmd.payload.targetAgentId);
				}
			}

			if (res.boundOverride) {
				this.pendingBoundOverride = {
					...(this.pendingBoundOverride ?? {}),
					...res.boundOverride,
				};
			}

			this.notifyWakeups();
		}
	}

	/** Poll SQLite WAL for unacknowledged control commands and drain new steering notes & bound overrides. */
	poll(): RunControlPollSnapshot {
		this.ingestCommands();

		const newSteeringNotes = this.steeringNotes.slice(this.pendingSteeringIndex);
		this.pendingSteeringIndex = this.steeringNotes.length;
		const boundOverride = this.pendingBoundOverride;
		this.pendingBoundOverride = undefined;

		return {
			state: this.state.status,
			newSteeringNotes,
			...(boundOverride ? { boundOverride } : {}),
		};
	}

	/**
	 * Pause-gate awaited at wave, phase, and spawn boundaries.
	 * In `"eval"` mode this returns immediately after polling.
	 * In `"research"` mode, if paused, sleeps cleanly in 500ms WAL poll ticks until resumed, coalesced, or aborted.
	 */
	async waitIfPaused(signal?: AbortSignal): Promise<"running" | "coalescing" | "aborted"> {
		this.ingestCommands();
		if (this.state.status === "coalescing") return "coalescing";
		if (signal?.aborted) return "aborted";
		if (this.state.status === "running") return "running";

		while (this.state.status === "paused") {
			if (signal?.aborted) return "aborted";
			await new Promise<void>((resolve) => {
				let done = false;
				const finish = () => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					this.wakeups.delete(finish);
					signal?.removeEventListener("abort", finish);
					resolve();
				};
				const timer = setTimeout(finish, 500);
				timer.unref?.();
				this.wakeups.add(finish);
				signal?.addEventListener("abort", finish, { once: true });
			});
			this.ingestCommands();
		}

		const finalStatus: RunControlStatus = this.status;
		if (finalStatus === "coalescing") return "coalescing";
		if (signal?.aborted) return "aborted";
		return "running";
	}

	/** Atomically update `<runDir>/best-so-far.json` whenever a better verified finding lands. */
	updateBestSoFar(candidate: BestSoFarPointer): boolean {
		const candScore = candidate.score ?? Number.NEGATIVE_INFINITY;
		const strictlyBetter =
			(candidate.accepted && !this.bestPointerAccepted) ||
			(candidate.accepted === this.bestPointerAccepted && candScore > this.bestPointerScore + 1e-9) ||
			(!Number.isFinite(this.bestPointerScore) && candidate.accepted);
		if (!strictlyBetter) return false;
		this.bestPointerAccepted = candidate.accepted;
		if (Number.isFinite(candScore)) this.bestPointerScore = candScore;

		try {
			const finalPath = join(this.opts.runDir, "best-so-far.json");
			const tmpPath = join(this.opts.runDir, `.best-so-far.${process.pid}.${Date.now()}.tmp`);
			writeFileSync(tmpPath, JSON.stringify(candidate, null, 2) + "\n", "utf8");
			renameSync(tmpPath, finalPath);
			return true;
		} catch {
			return false;
		}
	}
}
