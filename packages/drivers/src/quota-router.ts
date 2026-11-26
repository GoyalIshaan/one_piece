import {
	type DriverConfig,
	type DriverHealth,
	type DriverPoolSelection,
	type DriverTier,
	type EventBus,
	type ProviderQuotaRecord,
	type QuotaErrorClass,
	type QuotaPoolRouter,
	type Role,
	type SlotPermitState,
	transitionQuotaRecord,
	transitionSlotPermit,
	type WorkerDriver,
} from "@one-piece/core";
import { PhysicsConcurrencyGovernor, type PhysicsGovernorOptions } from "./physics-governor.ts";

const TIER_RANK: Record<DriverTier, number> = {
	sidekick: 0,
	standard: 1,
	frontier: 2,
};

export interface QuotaRouterOptions {
	drivers: Array<{ driver: WorkerDriver; config: DriverConfig }>;
	roles: Record<string, string[]>;
	bus?: EventBus;
	runId?: string;
	/** Concurrency scaling mode: "fixed" preserves static maxConcurrent; "physics" enables AIMD + RAM/CPU/disk backpressure. */
	concurrencyMode?: "physics" | "fixed";
	/** Optional physics governor tuning (e.g., worktreeRoot, probe override for testing). */
	physics?: PhysicsGovernorOptions;
	now?: () => number;
}

interface AcquireOpts {
	preferredDriverId?: string;
	avoidDrivers?: readonly string[];
	minTier?: DriverTier;
	maxTier?: DriverTier;
	requireOutputSchema?: boolean;
	strictCapabilities?: boolean;
	preferInProcess?: boolean;
	signal?: AbortSignal;
}

interface PoolWaiter {
	readonly role: Role;
	readonly opts: AcquireOpts;
	readonly enqueuedAt: number;
	readonly resolve: (selection: DriverPoolSelection) => void;
	readonly reject: (err: Error) => void;
	readonly cleanup: () => void;
}

/**
 * Unified Pool Condition-Queue Router for multi-CLI + API drivers.
 * - Eliminates two-phase select-then-wait hold-and-wait deadlocks by construction:
 *   callers wait on a single pool queue and immediately acquire whichever eligible
 *   driver frees a slot first.
 * - Tracks healthy / cooldown / drained state in SQLite (zero retries on Class 3 hard auth/cap).
 * - Enforces cross-provider exclusion (`avoidDrivers`), capability routing (`requireOutputSchema`,
 *   `strictCapabilities`, `preferInProcess`), and least-loaded provider diversity.
 */
export class DriverQuotaRouter implements QuotaPoolRouter {
	private readonly driverMap = new Map<
		string,
		{ driver: WorkerDriver; config: DriverConfig; maxConcurrent: number; running: number }
	>();
	private readonly states = new Map<string, ProviderQuotaRecord>();
	private readonly waiters: PoolWaiter[] = [];
	private readonly roles: Record<string, string[]>;
	private readonly governor: PhysicsConcurrencyGovernor;
	private bus?: EventBus;
	private runId?: string;
	private readonly now: () => number;
	private rotation = 0;

	constructor(opts: QuotaRouterOptions) {
		this.roles = opts.roles;
		this.bus = opts.bus;
		this.runId = opts.runId;
		this.now = opts.now ?? Date.now;
		const resolvedMode = opts.concurrencyMode ?? opts.physics?.mode ?? (opts.drivers.some((d) => d.config.concurrencyMode === "physics") ? "physics" : "fixed");
		this.governor = new PhysicsConcurrencyGovernor({
			...opts.physics,
			mode: resolvedMode,
			now: this.now,
		});
		for (const entry of opts.drivers) {
			const maxConcurrent = Math.max(1, entry.config.maxConcurrent ?? (entry.config.kind === "pi-in-process" ? 4 : 2));
			this.governor.registerDriver(entry.driver.id, entry.config);
			this.driverMap.set(entry.driver.id, {
				driver: entry.driver,
				config: entry.config,
				maxConcurrent,
				running: 0,
			});
			this.states.set(entry.driver.id, {
				id: `quota-${entry.driver.id}`,
				runId: opts.runId,
				driverId: entry.driver.id,
				state: "healthy",
				consecutiveErrors: 0,
				updatedAt: this.now(),
			});
		}
	}

	attachBus(bus: EventBus, runId: string): void {
		this.bus = bus;
		this.runId = runId;
		for (const rec of this.states.values()) {
			rec.runId = runId;
			this.persistState(rec);
		}
	}

	drivers(): WorkerDriver[] {
		return [...this.driverMap.values()].map((d) => d.driver);
	}

	getDriver(id: string): WorkerDriver | undefined {
		return this.driverMap.get(id)?.driver;
	}

	getDriverTier(id: string): DriverTier {
		return this.driverMap.get(id)?.config.tier ?? "standard";
	}

	getDriverConfig(id: string): DriverConfig | undefined {
		return this.driverMap.get(id)?.config;
	}

	async healthCheckAll(): Promise<DriverHealth[]> {
		return Promise.all(this.drivers().map((d) => d.healthCheck()));
	}

	private isHealthy(driverId: string): boolean {
		const record = this.states.get(driverId);
		if (!record) return false;
		const { next, changed } = transitionQuotaRecord(record, { type: "tick", now: this.now() });
		if (changed) {
			this.states.set(driverId, next);
			this.persistState(next);
		}
		return next.state === "healthy";
	}

	/** Compute the ordered candidate pool of healthy drivers satisfying the caller's role & capability constraints. */
	private computeEligibleIds(role: Role, opts: AcquireOpts): string[] {
		const configuredIds = this.roles[role] ?? this.roles.default ?? [...this.driverMap.keys()];
		const healthy = configuredIds.filter((id) => this.driverMap.has(id) && this.isHealthy(id));
		if (!healthy.length) {
			throw new Error(`No healthy drivers available for role "${role}" (configured: ${configuredIds.join(", ")})`);
		}

		let eligible = healthy;
		if (opts.requireOutputSchema) {
			const schemaCapable = eligible.filter((id) => this.driverMap.get(id)?.driver.capabilities.supportsOutputSchema);
			if (schemaCapable.length) {
				eligible = schemaCapable;
			} else if (opts.strictCapabilities) {
				throw new Error(`No healthy driver supports required outputSchema for role "${role}" (healthy: ${healthy.join(", ")})`);
			}
		}

		if (opts.minTier !== undefined || opts.maxTier !== undefined) {
			const minRank = opts.minTier ? TIER_RANK[opts.minTier] : 0;
			const maxRank = opts.maxTier ? TIER_RANK[opts.maxTier] : 2;
			const inBand = eligible.filter((id) => {
				const r = TIER_RANK[this.getDriverTier(id)];
				return r >= minRank && r <= maxRank;
			});
			if (inBand.length) {
				eligible = inBand;
			} else if (opts.minTier !== undefined) {
				const bestRank = Math.max(...eligible.map((id) => TIER_RANK[this.getDriverTier(id)]));
				eligible = eligible.filter((id) => TIER_RANK[this.getDriverTier(id)] === bestRank);
			} else if (opts.maxTier !== undefined) {
				const lowestRank = Math.min(...eligible.map((id) => TIER_RANK[this.getDriverTier(id)]));
				eligible = eligible.filter((id) => TIER_RANK[this.getDriverTier(id)] === lowestRank);
			}
		}

		if (opts.preferredDriverId && eligible.includes(opts.preferredDriverId)) {
			return [opts.preferredDriverId];
		}

		const avoided = new Set(opts.avoidDrivers ?? []);
		const preferred = eligible.filter((id) => !avoided.has(id));
		let basePool = preferred.length ? preferred : eligible;

		// Control-plane preference: route planner/reviewer to fast in-process API driver when available in the pool.
		if (opts.preferInProcess && !opts.preferredDriverId) {
			const inProc = basePool.filter((id) => this.driverMap.get(id)?.driver.kind === "pi-in-process");
			if (inProc.length) basePool = inProc;
		}

		return basePool;
	}

	/** Pick the least-loaded eligible driver that currently has free capacity, or undefined if all eligible drivers are busy. */
	private pickFreeDriver(eligibleIds: readonly string[]): string | undefined {
		const withFreeSlots = eligibleIds.filter((id) => {
			const d = this.driverMap.get(id);
			if (!d) return false;
			const limit = this.governor.effectiveLimit(id, d.running);
			return d.running < limit;
		});
		if (!withFreeSlots.length) return undefined;

		const utilOf = (id: string): number => {
			const d = this.driverMap.get(id)!;
			const w = Math.max(0.01, d.config.weight ?? 1);
			const limit = Math.max(1, this.governor.effectiveLimit(id, d.running));
			return d.running / limit / w;
		};
		const minUtil = Math.min(...withFreeSlots.map(utilOf));
		const tiedPool = withFreeSlots.filter((id) => utilOf(id) <= minUtil + 1e-9);
		const weights = tiedPool.map((id) => Math.max(0.01, this.driverMap.get(id)!.config.weight ?? 1));
		const total = weights.reduce((a, b) => a + b, 0);
		this.rotation = (this.rotation + 0.618_033_988_75) % 1;
		let point = this.rotation * total;
		let chosenId = tiedPool[0]!;
		for (let i = 0; i < tiedPool.length; i++) {
			point -= weights[i]!;
			if (point <= 0) {
				chosenId = tiedPool[i]!;
				break;
			}
		}
		return chosenId;
	}

	private grantSlot(driverId: string, waitedMs: number): DriverPoolSelection {
		const entry = this.driverMap.get(driverId)!;
		entry.running += 1;
		let permitState: SlotPermitState = "held";
		const apply = (event: "park" | "unpark" | "release") => {
			const res = transitionSlotPermit(permitState, event);
			permitState = res.next;
			if (res.runningDelta !== 0) {
				entry.running = Math.max(0, entry.running + res.runningDelta);
			}
			if (res.shouldDispatch) {
				this.dispatchWaiters();
			}
		};
		return {
			driver: entry.driver,
			park: () => apply("park"),
			unpark: () => apply("unpark"),
			release: () => apply("release"),
			waitedMs,
		};
	}

	private dispatchWaiters(): void {
		let idx = 0;
		while (idx < this.waiters.length) {
			const waiter = this.waiters[idx]!;
			let eligible: string[];
			try {
				eligible = this.computeEligibleIds(waiter.role, waiter.opts);
			} catch (error) {
				this.waiters.splice(idx, 1);
				waiter.cleanup();
				waiter.reject(error instanceof Error ? error : new Error(String(error)));
				continue;
			}
			const chosenId = this.pickFreeDriver(eligible);
			if (!chosenId) {
				idx += 1;
				continue;
			}
			this.waiters.splice(idx, 1);
			waiter.cleanup();
			const waitedMs = Math.max(0, this.now() - waiter.enqueuedAt);
			waiter.resolve(this.grantSlot(chosenId, waitedMs));
		}
	}

	async acquireForRole(role: Role, opts: AcquireOpts = {}): Promise<DriverPoolSelection> {
		if (opts.signal?.aborted) {
			throw new Error("Driver acquisition aborted");
		}
		const eligible = this.computeEligibleIds(role, opts);
		const immediate = this.pickFreeDriver(eligible);
		if (immediate) {
			return this.grantSlot(immediate, 0);
		}

		// All eligible drivers are currently at capacity: enqueue on the single unified pool waiter queue
		// so whichever eligible driver frees a slot first wakes this caller immediately (zero hold-and-wait!).
		return new Promise<DriverPoolSelection>((resolve, reject) => {
			const enqueuedAt = this.now();
			const onAbort = () => {
				const pos = this.waiters.indexOf(waiter);
				if (pos >= 0) this.waiters.splice(pos, 1);
				reject(new Error("Driver acquisition aborted"));
			};
			const cleanup = () => {
				opts.signal?.removeEventListener("abort", onAbort);
			};
			const waiter: PoolWaiter = {
				role,
				opts,
				enqueuedAt,
				resolve,
				reject,
				cleanup,
			};
			opts.signal?.addEventListener("abort", onAbort, { once: true });
			this.waiters.push(waiter);
		});
	}

	reportQuotaError(driverId: string, error: QuotaErrorClass): void {
		const record = this.states.get(driverId);
		if (!record) return;
		if (error.kind === "transient_rpm" || error.kind === "window_exhausted") {
			const scaled = this.governor.onRateLimit(driverId, error.kind);
			if (scaled && this.bus && this.runId) {
				this.bus.emit(this.runId, "governor.scaled", scaled);
			}
		}
		const { next, changed, emitted } = transitionQuotaRecord(record, { type: "quota_error", error, now: this.now() });
		if (!changed) {
			this.dispatchWaiters();
			return;
		}
		this.states.set(driverId, next);
		this.persistState(next);
		if (this.bus && this.runId) {
			if (emitted === "drained" && next.state === "drained") {
				this.bus.emit(this.runId, "quota.drained", { driverId, reason: next.reason });
			} else if (emitted === "cooldown" && next.state === "cooldown") {
				this.bus.emit(this.runId, "quota.cooldown", { driverId, until: next.cooldownUntil, reason: next.reason });
			}
		}
		this.dispatchWaiters();
	}

	reportSuccess(driverId: string): void {
		const record = this.states.get(driverId);
		if (!record) return;
		const scaled = this.governor.onSuccess(driverId);
		if (scaled && this.bus && this.runId) {
			this.bus.emit(this.runId, "governor.scaled", scaled);
		}
		const { next, changed } = transitionQuotaRecord(record, { type: "success", now: this.now() });
		if (changed) {
			this.states.set(driverId, next);
			this.persistState(next);
		}
		this.dispatchWaiters();
	}

	status() {
		const waitingByDriver = new Map<string, number>();
		for (const waiter of this.waiters) {
			try {
				for (const id of this.computeEligibleIds(waiter.role, waiter.opts)) {
					waitingByDriver.set(id, (waitingByDriver.get(id) ?? 0) + 1);
				}
			} catch {
				// Ignore waiters with no currently healthy drivers.
			}
		}
		return [...this.driverMap.entries()].map(([driverId, entry]) => {
			this.isHealthy(driverId);
			const rec = this.states.get(driverId)!;
			return {
				driverId,
				kind: entry.driver.kind,
				state: rec.state,
				cooldownUntil: rec.cooldownUntil,
				running: entry.running,
				waiting: waitingByDriver.get(driverId) ?? 0,
				effectiveLimit: this.governor.effectiveLimit(driverId, entry.running),
			};
		});
	}

	private persistState(record: ProviderQuotaRecord): void {
		this.bus?.store.put("quotas", structuredClone(record));
	}
}
