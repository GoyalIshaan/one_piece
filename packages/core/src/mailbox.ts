/** A single receiver on the Node event loop. Reentrant sends wait for the current
 * message to finish. Receivers post asynchronous results as subsequent messages. */
export class Mailbox<Message> {
	private readonly receive: (message: Message) => undefined;
	private pending?: Message[];

	constructor(receive: (message: Message) => undefined) {
		this.receive = receive;
	}

	send(message: Message): void {
		if (this.pending) {
			this.pending.push(message);
			return;
		}
		const batch = this.pending = [message];
		let failure: { error: unknown } | undefined;
		try {
			for (const next of batch) {
				try {
					this.receive(next);
				} catch (error) {
					failure ??= { error };
				}
			}
		} finally {
			this.pending = undefined;
		}
		if (failure) throw failure.error;
	}
}
