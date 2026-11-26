import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { cpus, freemem, loadavg, platform, totalmem } from "node:os";
import {
	type DriverConfig,
	type DriverKind,
	type DriverWindowState,
	transitionDriverWindow,
} from "@one-piece/core";

export interface HostPhysicsSnapshot {
	readonly freeMemBytes: number;
	readonly cpuLoadRatio: number;
	readonly cpuCount: number;
	readonly freeDiskBytes: number;
	readonly sampledAt: number;
}

export type HostPhysicsProbe = (worktreeRoot: string) => HostPhysicsSnapshot;

export interface PhysicsGovernorOptions {
	/** Mode: "physics" uses AIMD + host RAM/CPU/disk probes; "fixed" pins to static maxConcurrent. */
	mode?: "physics" | "fixed";
	/** Path whose filesystem is probed for worktree disk headroom (default process.cwd()). */
	worktreeRoot?: string;
	/** Minimum host RAM to keep free before throttling scale-up (default 2 GiB). */
	minFreeMemBytes?: number;
	/** Minimum free disk space to keep before throttling new worktrees (default 2 GiB). */
	minFreeDiskBytes?: number;
	/** CPU load average / cores threshold above which additive scale-up pauses (default 1.5). */
	maxCpuLoadRatio?: number;
	/** Consecutive clean turns required before additive +1 scale-up (default 2). */
	scaleUpAfterSuccesses?: number;
	/** Estimated RAM per local CLI subprocess worker (default 350 MiB). */
	cliWorkerMemBytes?: number;
	/** Estimated RAM per in-process API worker (default 64 MiB). */
	inProcessWorkerMemBytes?: number;
	/** Probe cache TTL in ms (default 1_000). */
	probeCacheMs?: number;
	/** Injectable host physics probe for deterministic testing. */
	probe?: HostPhysicsProbe;
	now?: () => number;
}

export interface GovernorScaleEvent {
	readonly driverId: string;
	readonly prevWindow: number;
	readonly nextWindow: number;
	readonly reason: string;
	readonly freeMemMb: number;
	readonly cpuLoadRatio: number;
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function macAvailableMemBytes(): number {
	try {
		const out = execFileSync("vm_stat", [], { encoding: "utf8", timeout: 500 });
		const pageMatch = /page size of (\d+) bytes/i.exec(out);
		const pageSize = pageMatch ? Number(pageMatch[1]) : 16_384;
		const pages = (label: string): number => {
			const m = new RegExp(`${label}:\\s+(\\d+)\\.`, "i").exec(out);
			return m ? Number(m[1]) : 0;
		};
		const availPages = pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable");
		if (availPages > 0) return availPages * pageSize;
	} catch {
		// Fall back cleanly if vm_stat is unavailable.
	}
	return Math.max(freemem(), Math.floor(totalmem() * 0.25));
}

export function defaultHostPhysicsProbe(worktreeRoot: string): HostPhysicsSnapshot {
	const cpuCount = Math.max(1, cpus().length);
	const load1 = loadavg()[0] ?? 0;
	let freeDiskBytes = 16 * GIB;
	try {
		const fsStat = statfsSync(worktreeRoot);
		freeDiskBytes = Number(fsStat.bavail) * Number(fsStat.bsize);
	} catch {
		// Fall back safely if statfs is unavailable on this platform/path.
	}
	const freeMemBytes = platform() === "darwin" ? macAvailableMemBytes() : freemem();
	return {
		freeMemBytes,
		cpuLoadRatio: load1 / cpuCount,
		cpuCount,
		freeDiskBytes,
		sampledAt: Date.now(),
	};
}

/**
 * Physics-Driven AIMD Concurrency Governor.
 * - Replaces arbitrary static `maxConcurrent: 2` caps with real physical bounds
 *   (free RAM, CPU load ratio, free disk space for git worktrees) and live HTTP 429 backpressure.
 * - Additive Increase (+1 every N clean turns when host physics has headroom).
 * - Multiplicative Decrease (halves window immediately on provider rate-limit / 429).
 */
export class PhysicsConcurrencyGovernor {
	readonly mode: "physics" | "fixed";
	private readonly worktreeRoot: string;
	private readonly minFreeMemBytes: number;
	private readonly minFreeDiskBytes: number;
	private readonly maxCpuLoadRatio: number;
	private readonly scaleUpAfterSuccesses: number;
	private readonly cliWorkerMemBytes: number;
	private readonly inProcessWorkerMemBytes: number;
	private readonly probeCacheMs: number;
	private readonly probeFn: HostPhysicsProbe;
	private readonly now: () => number;
	private readonly drivers = new Map<string, DriverWindowState>();
	private cachedSnapshot?: HostPhysicsSnapshot;

	constructor(opts: PhysicsGovernorOptions = {}) {
		this.mode = opts.mode ?? "fixed";
		this.worktreeRoot = opts.worktreeRoot ?? process.cwd();
		this.minFreeMemBytes = opts.minFreeMemBytes ?? 2 * GIB;
		this.minFreeDiskBytes = opts.minFreeDiskBytes ?? 2 * GIB;
		this.maxCpuLoadRatio = opts.maxCpuLoadRatio ?? 1.5;
		this.scaleUpAfterSuccesses = Math.max(1, opts.scaleUpAfterSuccesses ?? 2);
		this.cliWorkerMemBytes = opts.cliWorkerMemBytes ?? 350 * MIB;
		this.inProcessWorkerMemBytes = opts.inProcessWorkerMemBytes ?? 64 * MIB;
		this.probeCacheMs = Math.max(0, opts.probeCacheMs ?? 1_000);
		this.probeFn = opts.probe ?? defaultHostPhysicsProbe;
		this.now = opts.now ?? Date.now;
	}

	registerDriver(driverId: string, config: DriverConfig): void {
		const isInProc = config.kind === "pi-in-process";
		const fixedLimit = Math.max(1, config.maxConcurrent ?? (isInProc ? 4 : 2));
		if (this.mode === "fixed") {
			this.drivers.set(driverId, { mode: "fixed", kind: config.kind, fixedLimit });
			return;
		}
		const initialWindow = Math.max(fixedLimit, isInProc ? 8 : 4);
		const hardMax = config.hardMaxConcurrent !== undefined ? Math.max(1, config.hardMaxConcurrent) : undefined;
		this.drivers.set(driverId, {
			mode: "physics",
			kind: config.kind,
			...(hardMax !== undefined ? { hardMax } : {}),
			window: hardMax !== undefined ? Math.min(initialWindow, hardMax) : initialWindow,
			consecutiveSuccesses: 0,
		});
	}

	sampleHost(force = false): HostPhysicsSnapshot {
		const ts = this.now();
		if (!force && this.cachedSnapshot && ts - this.cachedSnapshot.sampledAt < this.probeCacheMs) {
			return this.cachedSnapshot;
		}
		this.cachedSnapshot = this.probeFn(this.worktreeRoot);
		return this.cachedSnapshot;
	}

	private workerMemFor(kind: DriverKind): number {
		return kind === "pi-in-process" ? this.inProcessWorkerMemBytes : this.cliWorkerMemBytes;
	}

	/** Compute how many additional slots host RAM + disk can safely sustain right now. */
	private hostHeadroomSlots(kind: DriverKind, snap: HostPhysicsSnapshot): number {
		if (snap.freeDiskBytes < this.minFreeDiskBytes) return 0;
		const usableRam = snap.freeMemBytes - this.minFreeMemBytes;
		if (usableRam <= 0) return 0;
		return Math.max(0, Math.floor(usableRam / this.workerMemFor(kind)));
	}

	/**
	 * Effective concurrency limit for `driverId` right now given current active workers.
	 * Always permits at least 1 running worker per healthy driver (or up to currently running)
	 * so the swarm never deadlocks even under temporary host memory pressure.
	 */
	effectiveLimit(driverId: string, driverRunning: number): number {
		const state = this.drivers.get(driverId);
		if (!state) return 1;
		if (state.mode === "fixed") return state.fixedLimit;

		const snap = this.sampleHost();
		const additionalAllowed = this.hostHeadroomSlots(state.kind, snap);
		const physicsCap = Math.max(1, driverRunning + additionalAllowed);
		let limit = Math.min(state.window, physicsCap);
		if (state.hardMax !== undefined) {
			limit = Math.min(limit, state.hardMax);
		}
		return Math.max(1, limit);
	}

	/** AIMD additive increase on clean turn completion when host physics permits scale-up. */
	onSuccess(driverId: string): GovernorScaleEvent | undefined {
		const state = this.drivers.get(driverId);
		if (!state || state.mode === "fixed") return undefined;

		const willEvaluateScale = state.consecutiveSuccesses + 1 >= this.scaleUpAfterSuccesses;
		const snap = willEvaluateScale ? this.sampleHost(true) : undefined;
		const hostHasHeadroom = snap
			? this.hostHeadroomSlots(state.kind, snap) >= 1 && snap.cpuLoadRatio <= this.maxCpuLoadRatio
			: false;
		const res = transitionDriverWindow(state, {
			type: "success",
			scaleUpAfter: this.scaleUpAfterSuccesses,
			hostHasHeadroom,
		});
		this.drivers.set(driverId, res.next);
		if (!res.changed || !snap) return undefined;
		return {
			driverId,
			prevWindow: res.prevWindow,
			nextWindow: res.nextWindow,
			reason: "aimd_additive_increase",
			freeMemMb: Math.round(snap.freeMemBytes / MIB),
			cpuLoadRatio: Math.round(snap.cpuLoadRatio * 100) / 100,
		};
	}

	/** AIMD multiplicative decrease on provider rate-limit / HTTP 429 backpressure. */
	onRateLimit(driverId: string, reason = "provider_rate_limit"): GovernorScaleEvent | undefined {
		const state = this.drivers.get(driverId);
		if (!state || state.mode === "fixed") return undefined;

		const res = transitionDriverWindow(state, { type: "rate_limit" });
		this.drivers.set(driverId, res.next);
		if (!res.changed) return undefined;
		const snap = this.sampleHost();
		return {
			driverId,
			prevWindow: res.prevWindow,
			nextWindow: res.nextWindow,
			reason,
			freeMemMb: Math.round(snap.freeMemBytes / MIB),
			cpuLoadRatio: Math.round(snap.cpuLoadRatio * 100) / 100,
		};
	}

	currentWindow(driverId: string): number {
		const state = this.drivers.get(driverId);
		if (!state) return 1;
		return state.mode === "fixed" ? state.fixedLimit : state.window;
	}
}
