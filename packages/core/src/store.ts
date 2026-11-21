// Storage interface. Everything the harness does is an event, and the current state of each
// object (node, finding, question, job...) is a document. Nothing is ever deleted.

export interface HarnessEvent {
	seq: number;
	ts: number;
	runId: string;
	type: string;
	nodeId?: string;
	data: Record<string, unknown>;
}

export type Collection =
	| "runs"
	| "nodes"
	| "findings"
	| "questions"
	| "recommendations"
	| "posts"
	| "assumptions"
	| "jobs"
	| "epochs"
	| "reports"
	| "user_answers"
	| "job_cache";

export interface EventQuery {
	afterSeq?: number;
	limit?: number;
	types?: string[];
	nodeId?: string;
}

export interface Store {
	appendEvent(event: Omit<HarnessEvent, "seq">): number;
	events(runId: string, query?: EventQuery): HarnessEvent[];
	put<T extends { id: string }>(collection: Collection, doc: T): void;
	get<T>(collection: Collection, id: string): T | undefined;
	list<T>(collection: Collection, filter?: { runId?: string }): T[];
	close(): void;
}

/** In-memory store for tests and dry runs. */
export class MemoryStore implements Store {
	private seq = 0;
	private readonly log: HarnessEvent[] = [];
	private readonly docs = new Map<Collection, Map<string, unknown>>();

	appendEvent(event: Omit<HarnessEvent, "seq">): number {
		this.seq += 1;
		this.log.push({ ...event, seq: this.seq });
		return this.seq;
	}

	events(runId: string, query: EventQuery = {}): HarnessEvent[] {
		let out = this.log.filter((e) => e.runId === runId && e.seq > (query.afterSeq ?? 0));
		if (query.types) out = out.filter((e) => query.types!.includes(e.type));
		if (query.nodeId) out = out.filter((e) => e.nodeId === query.nodeId);
		return query.limit ? out.slice(0, query.limit) : out;
	}

	put<T extends { id: string }>(collection: Collection, doc: T): void {
		let map = this.docs.get(collection);
		if (!map) {
			map = new Map();
			this.docs.set(collection, map);
		}
		map.set(doc.id, structuredClone(doc));
	}

	get<T>(collection: Collection, id: string): T | undefined {
		const value = this.docs.get(collection)?.get(id);
		return value === undefined ? undefined : (structuredClone(value) as T);
	}

	list<T>(collection: Collection, filter: { runId?: string } = {}): T[] {
		const values = [...(this.docs.get(collection)?.values() ?? [])] as Array<T & { runId?: string }>;
		const filtered = filter.runId ? values.filter((v) => v.runId === filter.runId) : values;
		return filtered.map((v) => structuredClone(v) as T);
	}

	close(): void {}
}
