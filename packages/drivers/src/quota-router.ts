import {
	type DriverConfig,
	type DriverHealth,
	type DriverPoolSelection,
	type EventBus,
	PermitActor,
	type ProviderQuotaRecord,
	type QuotaErrorClass,
	type QuotaPoolRouter,
	type Role,
	type WorkerDriver,
} from "@one-piece/core";

const DEFAULT_COOLDOWN_MS = 15 * 60_000;

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
	private readonly driverMap = new Map<string, { driver: WorkerDriver; config: DriverConfig; permit: PermitActor }>();
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

	async healthCheckAll(): Promise<DriverHealth[]> {
		return Promise.all(this.drivers().map((d) => d.healthCheck()));
	}

	private isHealthy(driverId: string): boolean {
		const record = this.states.get(driverId);
		if (!record) return false;
		if (record.state === "drained") return false;
		if (record.state === "cooldown") {
			if ((record.cooldownUntil ?? 0) <= this.now()) {
				record.state = "healthy";
				record.cooldownUntil = undefined;
				record.updatedAt = this.now();
				this.persistState(record);
				return true;
			}
			return false;
		}
		return true;
	}

	async acquireForRole(
		role: Role,
		opts: { preferredDriverId?: string; avoidDrivers?: readonly string[]; signal?: AbortSignal } = {},
	): Promise<DriverPoolSelection> {
		const configuredIds = this.roles[role] ?? this.roles.default ?? [...this.driverMap.keys()];
		const eligible = configuredIds.filter((id) => this.driverMap.has(id) && this.isHealthy(id));
		if (!eligible.length) {
			throw new Error(`No healthy drivers available for role "${role}" (configured: ${configuredIds.join(", ")})`);
		}

		let chosenId: string | undefined;
		if (opts.preferredDriverId && eligible.includes(opts.preferredDriverId)) {
			chosenId = opts.preferredDriverId;
		} else {
			const avoided = new Set(opts.avoidDrivers ?? []);
			const preferred = eligible.filter((id) => !avoided.has(id));
			const pool = preferred.length ? preferred : eligible;
			const weights = pool.map((id) => Math.max(0.01, this.driverMap.get(id)!.config.weight ?? 1));
			const total = weights.reduce((a, b) => a + b, 0);
			this.rotation = (this.rotation + 0.618_033_988_75) % 1;
			let point = this.rotation * total;
			chosenId = pool[0]!;
			for (let i = 0; i < pool.length; i++) {
				point -= weights[i]!;
				if (point <= 0) {
					chosenId = pool[i]!;
					break;
				}
			}
		}

		const entry = this.driverMap.get(chosenId)!;
		const waitStart = this.now();
		const release = await entry.permit.acquire(opts.signal);
		const waitedMs = Math.max(0, this.now() - waitStart);
		return { driver: entry.driver, release, waitedMs };
	}

	reportQuotaError(driverId: string, error: QuotaErrorClass): void {
		const record = this.states.get(driverId);
		if (!record) return;
		const ts = this.now();
		record.consecutiveErrors += 1;
		record.updatedAt = ts;

		if (error.kind === "hard_auth_or_cap") {
			record.state = "drained";
			record.reason = error.reason;
			record.cooldownUntil = undefined;
			this.persistState(record);
			if (this.bus && this.runId) {
				this.bus.emit(this.runId, "quota.drained", { driverId, reason: error.reason });
			}
		} else if (error.kind === "window_exhausted") {
			record.state = "cooldown";
			record.cooldownUntil = error.resetAtMs ?? ts + DEFAULT_COOLDOWN_MS;
			record.reason = error.raw.slice(0, 240);
			this.persistState(record);
			if (this.bus && this.runId) {
				this.bus.emit(this.runId, "quota.cooldown", { driverId, until: record.cooldownUntil, reason: record.reason });
			}
		}
	}

	reportSuccess(driverId: string): void {
		const record = this.states.get(driverId);
		if (!record) return;
		if (record.state !== "healthy" || record.consecutiveErrors > 0) {
			record.state = "healthy";
			record.cooldownUntil = undefined;
			record.reason = undefined;
			record.consecutiveErrors = 0;
			record.updatedAt = this.now();
			this.persistState(record);
		}
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
