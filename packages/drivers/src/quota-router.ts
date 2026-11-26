import {
	type DriverConfig,
	type DriverHealth,
	type DriverPoolSelection,
	type DriverTier,
	type EventBus,
	PermitActor,
	type ProviderQuotaRecord,
	type QuotaErrorClass,
	type QuotaPoolRouter,
	type Role,
	transitionQuotaRecord,
	type WorkerDriver,
} from "@one-piece/core";

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
	now?: () => number;
}

/**
 * Quota-aware multi-CLI + API driver pool router.
 * - Enforces per-subscription concurrency limits via PermitActor (default 2)
 * - Tracks healthy / cooldown / drained state in SQLite
 * - Enforces cross-provider exclusion (`avoidDrivers`) for blind review
 * - Zero retries on Class 3 (`401`/`403`) hard auth/cap errors
 */
export class DriverQuotaRouter implements QuotaPoolRouter {
	private readonly driverMap = new Map<
		string,
		{ driver: WorkerDriver; config: DriverConfig; permit: PermitActor; maxConcurrent: number; reserved: number }
	>();
	private readonly states = new Map<string, ProviderQuotaRecord>();
	private readonly roles: Record<string, string[]>;
	private bus?: EventBus;
	private runId?: string;
	private readonly now: () => number;
	private rotation = 0;

	constructor(opts: QuotaRouterOptions) {
		this.roles = opts.roles;
		this.bus = opts.bus;
		this.runId = opts.runId;
		this.now = opts.now ?? Date.now;
		for (const entry of opts.drivers) {
			const maxConcurrent = entry.config.maxConcurrent ?? (entry.config.kind === "pi-in-process" ? 4 : 2);
			this.driverMap.set(entry.driver.id, {
				driver: entry.driver,
				config: entry.config,
				permit: new PermitActor(maxConcurrent),
				maxConcurrent,
				reserved: 0,
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

	async acquireForRole(
		role: Role,
		opts: {
			preferredDriverId?: string;
			avoidDrivers?: readonly string[];
			minTier?: DriverTier;
			maxTier?: DriverTier;
			signal?: AbortSignal;
		} = {},
	): Promise<DriverPoolSelection> {
		const configuredIds = this.roles[role] ?? this.roles.default ?? [...this.driverMap.keys()];
		const healthy = configuredIds.filter((id) => this.driverMap.has(id) && this.isHealthy(id));
		if (!healthy.length) {
			throw new Error(`No healthy drivers available for role "${role}" (configured: ${configuredIds.join(", ")})`);
		}

		let eligible = healthy;
		if (opts.minTier !== undefined || opts.maxTier !== undefined) {
			const minRank = opts.minTier ? TIER_RANK[opts.minTier] : 0;
			const maxRank = opts.maxTier ? TIER_RANK[opts.maxTier] : 2;
			const inBand = healthy.filter((id) => {
				const r = TIER_RANK[this.getDriverTier(id)];
				return r >= minRank && r <= maxRank;
			});
			if (inBand.length) {
				eligible = inBand;
			} else if (opts.minTier !== undefined) {
				// Graceful fallback: pick the highest-tier healthy driver(s) available
				const bestRank = Math.max(...healthy.map((id) => TIER_RANK[this.getDriverTier(id)]));
				eligible = healthy.filter((id) => TIER_RANK[this.getDriverTier(id)] === bestRank);
			} else if (opts.maxTier !== undefined) {
				// Graceful fallback: pick the lowest-tier healthy driver(s) available
				const lowestRank = Math.min(...healthy.map((id) => TIER_RANK[this.getDriverTier(id)]));
				eligible = healthy.filter((id) => TIER_RANK[this.getDriverTier(id)] === lowestRank);
			}
		}

		let chosenId: string | undefined;
		if (opts.preferredDriverId && eligible.includes(opts.preferredDriverId)) {
			chosenId = opts.preferredDriverId;
		} else {
			const avoided = new Set(opts.avoidDrivers ?? []);
			const preferred = eligible.filter((id) => !avoided.has(id));
			const basePool = preferred.length ? preferred : eligible;
			// Availability-aware selection: ALWAYS prefer drivers with free immediate permit capacity
			// using synchronous `reserved` counts so same-tick Promise.all spawns NEVER hold-and-wait deadlock!
			const withFreeSlots = basePool.filter((id) => {
				const d = this.driverMap.get(id)!;
				return d.reserved < d.maxConcurrent;
			});
			const pool = withFreeSlots.length
				? withFreeSlots
				: [...basePool].sort((a, b) => {
					const da = this.driverMap.get(a)!;
					const db = this.driverMap.get(b)!;
					return da.reserved / da.maxConcurrent - db.reserved / db.maxConcurrent;
				});
			if (!withFreeSlots.length) {
				chosenId = pool[0]!;
			} else {
				// Least-loaded provider diversity: prefer drivers with minimum weighted utilization
				// (reserved / maxConcurrent / weight) so concurrent waves spread evenly across providers!
				const utilOf = (id: string): number => {
					const d = this.driverMap.get(id)!;
					const w = Math.max(0.01, d.config.weight ?? 1);
					return d.reserved / d.maxConcurrent / w;
				};
				const minUtil = Math.min(...pool.map(utilOf));
				const tiedPool = pool.filter((id) => utilOf(id) <= minUtil + 1e-9);
				const weights = tiedPool.map((id) => Math.max(0.01, this.driverMap.get(id)!.config.weight ?? 1));
				const total = weights.reduce((a, b) => a + b, 0);
				this.rotation = (this.rotation + 0.618_033_988_75) % 1;
				let point = this.rotation * total;
				chosenId = tiedPool[0]!;
				for (let i = 0; i < tiedPool.length; i++) {
					point -= weights[i]!;
					if (point <= 0) {
						chosenId = tiedPool[i]!;
						break;
					}
				}
			}
		}

		const entry = this.driverMap.get(chosenId)!;
		entry.reserved += 1;
		const waitStart = this.now();
		let rawRelease: () => void;
		try {
			rawRelease = await entry.permit.acquire(opts.signal);
		} catch (error) {
			entry.reserved = Math.max(0, entry.reserved - 1);
			throw error;
		}
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			entry.reserved = Math.max(0, entry.reserved - 1);
			rawRelease();
		};
		const waitedMs = Math.max(0, this.now() - waitStart);
		return { driver: entry.driver, release, waitedMs };
	}

	reportQuotaError(driverId: string, error: QuotaErrorClass): void {
		const record = this.states.get(driverId);
		if (!record) return;
		const { next, changed, emitted } = transitionQuotaRecord(record, { type: "quota_error", error, now: this.now() });
		if (!changed) return;
		this.states.set(driverId, next);
		this.persistState(next);
		if (this.bus && this.runId) {
			if (emitted === "drained" && next.state === "drained") {
				this.bus.emit(this.runId, "quota.drained", { driverId, reason: next.reason });
			} else if (emitted === "cooldown" && next.state === "cooldown") {
				this.bus.emit(this.runId, "quota.cooldown", { driverId, until: next.cooldownUntil, reason: next.reason });
			}
		}
	}

	reportSuccess(driverId: string): void {
		const record = this.states.get(driverId);
		if (!record) return;
		const { next, changed } = transitionQuotaRecord(record, { type: "success", now: this.now() });
		if (!changed) return;
		this.states.set(driverId, next);
		this.persistState(next);
	}

	status() {
		return [...this.driverMap.entries()].map(([driverId, entry]) => {
			this.isHealthy(driverId);
			const rec = this.states.get(driverId)!;
			return {
				driverId,
				kind: entry.driver.kind,
				state: rec.state,
				cooldownUntil: rec.cooldownUntil,
				running: entry.permit.running,
				waiting: entry.permit.waiting,
			};
		});
	}

	private persistState(record: ProviderQuotaRecord): void {
		this.bus?.store.put("quotas", structuredClone(record));
	}
}
