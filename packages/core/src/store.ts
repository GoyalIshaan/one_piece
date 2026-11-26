import {
	type TaskLeaseClaimOutcome,
	transitionClaimTask,
	transitionReleaseTask,
	transitionRenewTask,
} from "./state-machines.ts";
import type {
	AgentRecord,
	ArtifactRecord,
	BoardPost,
	Finding,
	Job,
	ProviderQuotaRecord,
	Report,
	Run,
	TaskRecord,
	TaskStatus,
} from "./types.ts";

/** Canonical append-only event record. Every state transition is persisted before dispatch. */
export interface HarnessEvent {
	seq: number;
	ts: number;
	runId: string;
	type: string;
	nodeId?: string;
	causalParents?: string[];
	idempotencyKey?: string;
	data: Record<string, unknown>;
}

export interface Documents {
	runs: Run;
	agents: AgentRecord;
	tasks: TaskRecord;
	posts: BoardPost;
	artifacts: ArtifactRecord;
	findings: Finding;
	jobs: Job;
	quotas: ProviderQuotaRecord;
	reports: Report;
	job_cache: { id: string; runId: string; jobId: string };
}

export type Collection = keyof Documents;

export interface EventQuery {
	afterSeq?: number;
	limit?: number;
	types?: string[];
	nodeId?: string;
}

export type LeaseClaimResult = TaskLeaseClaimOutcome;

export interface Store {
	appendEvent(event: Omit<HarnessEvent, "seq">): number;
	events(runId: string, query?: EventQuery): HarnessEvent[];
	put<K extends Collection>(collection: K, doc: Documents[NoInfer<K>]): void;
	get<K extends Collection>(collection: K, id: string): Documents[K] | undefined;
	list<K extends Collection>(collection: K, filter?: { runId?: string }): Documents[K][];
	listBoardPosts?(runId: string, board?: string, cites?: string): BoardPost[];
	/** Atomically acquire or reclaim an expired lease on a task, bumping its fencingToken. */
	claimTaskLease(runId: string, taskId: string, agentId: string, ttlMs: number, now?: number): LeaseClaimResult;
	renewTaskLease(taskId: string, agentId: string, fencingToken: number, ttlMs: number, now?: number): boolean;
	releaseTaskLease(
		taskId: string,
		agentId: string,
		fencingToken: number,
		nextStatus: Exclude<TaskStatus, "claimed">,
		update?: { result?: string; artifactIds?: string[]; findingId?: string },
		now?: number,
	): boolean;
	lastSeq?(runId: string): number;
	close(): void;
}

/** In-memory store for deterministic tests and dry runs. */
export class MemoryStore implements Store {
	private seq = 0;
	private readonly log: HarnessEvent[] = [];
	private readonly idempotencyKeys = new Map<string, number>();
	private readonly docs = new Map<Collection, Map<string, unknown>>();

	appendEvent(event: Omit<HarnessEvent, "seq">): number {
		if (event.idempotencyKey) {
			const key = `${event.runId}:${event.idempotencyKey}`;
			const existing = this.idempotencyKeys.get(key);
			if (existing !== undefined) return existing;
			this.seq += 1;
			this.idempotencyKeys.set(key, this.seq);
			this.log.push({ ...structuredClone(event), seq: this.seq });
			return this.seq;
		}
		this.seq += 1;
		this.log.push({ ...structuredClone(event), seq: this.seq });
		return this.seq;
	}

	events(runId: string, query: EventQuery = {}): HarnessEvent[] {
		let out = this.log.filter((e) => e.runId === runId && e.seq > (query.afterSeq ?? 0));
		if (query.types?.length) out = out.filter((e) => query.types!.includes(e.type));
		if (query.nodeId) out = out.filter((e) => e.nodeId === query.nodeId);
		return structuredClone(query.limit ? out.slice(0, query.limit) : out);
	}

	put<K extends Collection>(collection: K, doc: Documents[NoInfer<K>]): void {
		let map = this.docs.get(collection);
		if (!map) {
			map = new Map();
			this.docs.set(collection, map);
		}
		map.set(doc.id, structuredClone(doc));
	}

	get<K extends Collection>(collection: K, id: string): Documents[K] | undefined {
		const value = this.docs.get(collection)?.get(id);
		return value === undefined ? undefined : (structuredClone(value) as Documents[K]);
	}

	list<K extends Collection>(collection: K, filter: { runId?: string } = {}): Documents[K][] {
		const values = [...(this.docs.get(collection)?.values() ?? [])] as Array<Documents[K] & { runId?: string }>;
		const filtered = filter.runId ? values.filter((v) => v.runId === filter.runId) : values;
		return filtered.map((v) => structuredClone(v) as Documents[K]);
	}

	listBoardPosts(runId: string, board?: string, cites?: string): BoardPost[] {
		return this.list("posts", { runId }).filter((post) => {
			if (board && (post.board ?? "swarm") !== board) return false;
			if (cites && !post.references?.some((ref) => ref.postId === cites)) return false;
			return true;
		});
	}

	claimTaskLease(runId: string, taskId: string, agentId: string, ttlMs: number, now = Date.now()): LeaseClaimResult {
		const outcome = transitionClaimTask(this.get("tasks", taskId), runId, taskId, agentId, ttlMs, now);
		if (outcome.claimed) this.put("tasks", outcome.task);
		return outcome;
	}

	renewTaskLease(taskId: string, agentId: string, fencingToken: number, ttlMs: number, now = Date.now()): boolean {
		const next = transitionRenewTask(this.get("tasks", taskId), agentId, fencingToken, ttlMs, now);
		if (!next) return false;
		this.put("tasks", next);
		return true;
	}

	releaseTaskLease(
		taskId: string,
		agentId: string,
		fencingToken: number,
		nextStatus: Exclude<TaskStatus, "claimed">,
		update: { result?: string; artifactIds?: string[]; findingId?: string } = {},
		now = Date.now(),
	): boolean {
		const next = transitionReleaseTask(this.get("tasks", taskId), agentId, fencingToken, nextStatus, update, now);
		if (!next) return false;
		this.put("tasks", next);
		return true;
	}

	lastSeq(runId: string): number {
		let max = 0;
		for (const event of this.log) if (event.runId === runId && event.seq > max) max = event.seq;
		return max;
	}

	close(): void {}
}
