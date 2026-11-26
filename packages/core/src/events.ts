import { Mailbox } from "./mailbox.ts";
import type { Redactor } from "./redact.ts";
import type { Collection, Documents, HarnessEvent, Store } from "./store.ts";
import type { AgentStatus, EvidenceLevel, FinishedJob, Job, ReviewRound, Run, TaskStatus } from "./types.ts";

type RunEnded = { status: Exclude<Run["status"], "running">; reason: string };

export interface LifecycleEvents {
	"run.started": { topology: string; goal: string };
	"run.closing": { reason: string; reservePct?: number };
	"run.finishing": RunEnded;
	"run.finished": RunEnded;
	"run.nominated": { findingId: string; revision: number; auto: boolean; artifactSha256?: string };
	"agent.spawned": { agentId: string; role: string; driverId: string; model?: string; taskId?: string; workspace?: string; waitedMs?: number };
	"agent.status": { status: AgentStatus; reason?: string };
	"agent.turn": {
		turn: number;
		driverId: string;
		model?: string;
		status?: string;
		toolSig?: string;
		diffSha?: string;
		durationMs?: number;
		waitedMs?: number;
		inputTokens?: number;
		outputTokens?: number;
		cachedTokens?: number;
		cacheWriteTokens?: number;
		cacheHitRate?: number;
		reasoningTokens?: number;
		totalTokens?: number;
		usd?: number;
		error?: string;
		quotaErrorKind?: string;
		promptBytes?: number;
		finalTextBytes?: number;
		transcriptFile?: string;
	};
	"agent.stalled": { agentId: string; reason: string; repeatCount?: number };
	"agent.escalated": { agentId: string; fromDriver: string; toDriver: string; fromTier: string; toTier: string; reason: string };
	"agent.compacted": { agentId: string; strategy: "micro" | "anchor"; beforeTokens: number; afterTokens: number; prunedCount: number; compactionCount: number };
	"agent.handoff": { agentId: string; fromDriver: string; toDriver: string; workspace: string; handoffPath: string; reasonKind?: string; waitedMs?: number };
	"refinery.conflict_resolved": { taskId: string; branch: string; conflictFiles: string[]; commitSha: string };
	"peer.conflict_detected": { peerHandle: string; branch: string; conflictFiles: string[] };
	"peer.conflict_resolved": { peerHandle: string; branch: string; conflictFiles: string[]; commitSha: string };
	"skill.loaded": { skill: string; source: string; bytes: number };
	"codemode.executed": { exitCode: number; durationMs: number; outputBytes: number; artifactId?: string };
	"driver.tool_call": { tool: string; argsPreview?: string; isMcp?: boolean; driverId?: string };
	"driver.tool_result": { tool: string; isError: boolean; outputPreview?: string; durationMs?: number; isMcp?: boolean; driverId?: string };
	"driver.error": { message: string; driverId?: string };
	"task.created": { taskId: string; title: string; dependsOn: string[] };
	"task.ready": { taskId: string; title: string };
	"task.claimed": { taskId: string; agentId: string; fencingToken: number; leaseExpiresAt: number };
	"task.status": { taskId: string; status: TaskStatus; result?: string };
	"board.posted": {
		postId: string;
		topic: string;
		authorAgentId: string;
		authorHandle?: string;
		threadId?: string;
		supersedes?: string;
		labels?: Record<string, string>;
	};
	"board.labeled": { postId: string; set?: Record<string, string>; unset?: string[]; actorId: string };
	"artifact.stored": { artifactId: string; sha256: string; bytes: number; label: string };
	"job.started": { jobId: string; pool: string; exclusive: boolean };
	"job.leasing": { jobId: string; pool: string };
	"job.rejected": { operation: "submit_job" | "resume_job"; pool?: string; label?: string; taskId?: string; reason: string };
	"job.finished": { jobId: string; status: FinishedJob["status"]; exitCode?: number; units?: number };
	"job.interrupted": { jobId: string; previousStatus: Exclude<Job, FinishedJob>["status"] };
	"finding.reported": { findingId: string; revision: number; claim: string; level: EvidenceLevel; artifactSha256?: string };
	"finding.verification": { findingId: string; revision: number; scope: string; status: string; message: string; score?: number };
	"finding.verdict": { findingId: string; revision: number; verdict: ReviewRound["verdict"]; confidence?: number };
	"quota.retry": { driverId: string; attempt: number; waitMs: number; reason: string };
	"quota.cooldown": { driverId: string; until: number; reason: string };
	"quota.drained": { driverId: string; reason: string };
	"phase.changed": { from?: string; to: string; reason: string };
	"budget.charged": {
		agentId?: string;
		driverId?: string;
		model?: string;
		tokens?: number;
		inputTokens?: number;
		outputTokens?: number;
		cachedTokens?: number;
		cacheWriteTokens?: number;
		reasoningTokens?: number;
		usd?: number;
		units?: Record<string, number>;
	};
}

type EmitArgs<K extends string> = K extends keyof LifecycleEvents
	? [data: LifecycleEvents[K], nodeId?: string, meta?: EmitMeta]
	: [data?: Record<string, unknown>, nodeId?: string, meta?: EmitMeta];

export interface EmitMeta {
	causalParents?: string[];
	idempotencyKey?: string;
}

export type EventListener = (event: HarnessEvent) => void;

/**
 * The append-only event spine. Every state change is redacted, persisted to the store,
 * and delivered in FIFO sequence to reactive triggers, topology plugins, and telemetry.
 */
export class EventBus {
	private readonly listeners = new Set<EventListener>();
	private readonly delivery: Mailbox<HarnessEvent>;

	readonly store: Store;
	readonly redactor: Redactor;

	constructor(store: Store, redactor: Redactor) {
		this.store = store;
		this.redactor = redactor;
		this.delivery = new Mailbox<HarnessEvent>((event) => {
			for (const listener of [...this.listeners]) {
				try {
					listener(structuredClone(event));
				} catch {
					// A broken listener never breaks the swarm OS.
				}
			}
		});
	}

	emit<K extends string>(runId: string, type: K, ...args: EmitArgs<NoInfer<K>>): HarnessEvent;
	emit(runId: string, type: string, data: Record<string, unknown> = {}, nodeId?: string, meta?: EmitMeta): HarnessEvent {
		const clean = this.redactor.redact(data);
		const event: Omit<HarnessEvent, "seq"> = {
			ts: Date.now(),
			runId,
			type,
			nodeId,
			causalParents: meta?.causalParents,
			idempotencyKey: meta?.idempotencyKey,
			data: clean,
		};
		const seq = this.store.appendEvent(event);
		const full: HarnessEvent = { ...event, seq };
		this.delivery.send(structuredClone(full));
		return full;
	}

	/** Persist a document and announce the change. */
	save<K extends Collection>(collection: K, doc: Documents[NoInfer<K>], nodeId?: string): void {
		const clean = this.redactor.redact(doc);
		this.store.put(collection, clean);
		const runId = "runId" in doc && typeof doc.runId === "string" ? doc.runId : doc.id;
		this.emit<`${Collection}.updated`>(runId, `${collection}.updated`, { id: doc.id }, nodeId);
	}

	/** Persist a document explicitly scoped to a runId and emit its update event. */
	saveForRun<K extends Collection>(runId: string, collection: K, doc: Documents[NoInfer<K>], nodeId?: string): void {
		const clean = this.redactor.redact(doc);
		this.store.put(collection, clean);
		this.emit<`${Collection}.updated`>(runId, `${collection}.updated`, { id: doc.id }, nodeId);
	}

	on(listener: EventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
