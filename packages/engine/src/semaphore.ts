/** Fair FIFO counting semaphore. Agent slots and pool slots both use it. */
export class Semaphore {
	private available: number;
	private readonly waiters: Array<() => void> = [];

	constructor(size: number) {
		this.available = size;
	}

	acquire(): Promise<void> {
		if (this.available > 0) {
			this.available -= 1;
			return Promise.resolve();
		}
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	release(): void {
		const next = this.waiters.shift();
		if (next) next();
		else this.available += 1;
	}

	get free(): number {
		return this.available;
	}

	get waiting(): number {
		return this.waiters.length;
	}
}
