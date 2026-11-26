import { Mailbox } from "./mailbox.ts";

type Release = () => void;
type Request = {
	id: symbol;
	signal?: AbortSignal;
	abort: () => void;
	grant: (release: Release) => void;
	reject: (error: unknown) => void;
};
type Command =
	| { type: "acquire"; request: Request }
	| { type: "ready" | "release"; id: symbol }
	| { type: "reject"; id: symbol; reason: unknown };
type Permit =
	| { phase: "queued"; request: Request }
	| { phase: "preparing"; request: Request }
	| { phase: "held" };

/** Owns FIFO reservations. Callers receive a one-shot reply and can release only their own permit. */
export class PermitActor {
	private readonly capacity: number;
	private readonly beforeGrant?: (signal?: AbortSignal) => Promise<void>;
	private readonly permits = new Map<symbol, Permit>();
	/** FIFO index. Only the permit record can authorize a grant or release. */
	private readonly queue = new Set<symbol>();
	private granted = 0;
	private readonly mailbox = new Mailbox<Command>(command => this.receive(command));

	constructor(capacity: number, beforeGrant?: (signal?: AbortSignal) => Promise<void>) {
		if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Capacity must be a positive integer");
		this.capacity = capacity;
		this.beforeGrant = beforeGrant;
	}

	get free(): number { return this.capacity - (this.permits.size - this.queue.size); }
	get waiting(): number { return this.permits.size - this.running; }
	get running(): number {
		let held = 0;
		for (const permit of this.permits.values()) if (permit.phase === "held") held++;
		return held;
	}
	get calls(): number { return this.granted; }

	acquire(signal?: AbortSignal): Promise<Release> {
		const id = Symbol();
		return new Promise((grant, reject) => {
			const abort = () => this.mailbox.send({ type: "reject", id, reason: signal?.reason });
			this.mailbox.send({ type: "acquire", request: { id, signal, abort, grant, reject } });
		});
	}

	private receive(command: Command): undefined {
		switch (command.type) {
			case "acquire": {
				const request = command.request;
				if (request.signal?.aborted) {
					request.reject(request.signal.reason);
					return;
				}
				request.signal?.addEventListener("abort", request.abort, { once: true });
				this.permits.set(request.id, { phase: "queued", request });
				this.queue.add(request.id);
				break;
			}
			case "ready": {
				const permit = this.permits.get(command.id);
				if (permit?.phase !== "preparing") return;
				const { request } = permit;
				request.signal?.removeEventListener("abort", request.abort);
				this.permits.set(request.id, { phase: "held" });
				this.granted++;
				request.grant(() => this.mailbox.send({ type: "release", id: command.id }));
				break;
			}
			case "reject": {
				const permit = this.permits.get(command.id);
				if (!permit || permit.phase === "held") return;
				const { request } = permit;
				if (permit.phase === "queued") this.queue.delete(request.id);
				this.permits.delete(request.id);
				request.signal?.removeEventListener("abort", request.abort);
				request.reject(command.reason);
				break;
			}
			case "release":
				if (this.permits.get(command.id)?.phase !== "held") return;
				this.permits.delete(command.id);
				break;
		}

		for (const id of this.queue) {
			if (this.free === 0) break;
			const permit = this.permits.get(id);
			if (permit?.phase !== "queued") throw new Error("Permit queue references a nonqueued reservation");
			const { request } = permit;
			this.queue.delete(id);
			this.permits.set(id, { phase: "preparing", request });
			const ready = () => this.mailbox.send({ type: "ready", id });
			const prepare = this.beforeGrant;
			if (prepare) {
				// External pacing finishes independently and owns no permit state.
				void Promise.resolve().then(() => {
					request.signal?.throwIfAborted();
					return prepare(request.signal);
				}).then(ready, reason => this.mailbox.send({ type: "reject", id, reason }));
			} else ready();
		}
	}
}
