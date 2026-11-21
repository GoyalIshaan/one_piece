import type { Redactor } from "./redact.ts";
import type { Collection, HarnessEvent, Store } from "./store.ts";

export type EventListener = (event: HarnessEvent) => void;

/**
 * The telemetry spine. Every state change goes through here: it is scrubbed for secrets,
 * appended to the store, and handed to live listeners (dashboard, reviewers, scheduler).
 */
export class EventBus {
	private readonly listeners = new Set<EventListener>();

	readonly store: Store;
	readonly redactor: Redactor;

	constructor(store: Store, redactor: Redactor) {
		this.store = store;
		this.redactor = redactor;
	}

	emit(runId: string, type: string, data: Record<string, unknown> = {}, nodeId?: string): HarnessEvent {
		const clean = this.redactor.redact(data);
		const event = { ts: Date.now(), runId, type, nodeId, data: clean };
		const seq = this.store.appendEvent(event);
		const full: HarnessEvent = { ...event, seq };
		for (const listener of this.listeners) {
			try {
				listener(full);
			} catch {
				// A broken listener never breaks the harness.
			}
		}
		return full;
	}

	/** Persist a document and announce the change. */
	save<T extends { id: string; runId?: string }>(collection: Collection, doc: T, nodeId?: string): void {
		const clean = this.redactor.redact(doc);
		this.store.put(collection, clean);
		this.emit(doc.runId ?? doc.id, `${collection}.updated`, { id: doc.id }, nodeId);
	}

	on(listener: EventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
