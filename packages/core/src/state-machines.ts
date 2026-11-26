import type { QuotaErrorClass } from "./driver.ts";
import {
	assertNever,
	type ClaimedTaskRecord,
	type ProviderQuotaRecord,
	type Run,
	type TaskRecord,
	type TaskStatus,
} from "./types.ts";

const DEFAULT_COOLDOWN_MS = 15 * 60_000;

// --- 1. Provider Quota Circuit-Breaker State Machine ---
// Invariant: `drained` is a terminal absorbing state (late in-flight successes can NEVER resurrect a drained driver).

export type QuotaTransitionEvent =
	| { readonly type: "tick"; readonly now: number }
	| { readonly type: "success"; readonly now: number }
	| { readonly type: "quota_error"; readonly error: QuotaErrorClass; readonly now: number };

export function transitionQuotaRecord(
	current: ProviderQuotaRecord,
	event: QuotaTransitionEvent,
): { readonly next: ProviderQuotaRecord; readonly changed: boolean; readonly emitted?: "cooldown" | "drained" } {
	switch (event.type) {
		case "tick": {
			if (current.state === "cooldown" && current.cooldownUntil <= event.now) {
				const { cooldownUntil: _c, reason: _r, ...base } = current;
				return {
					next: { ...base, state: "healthy", updatedAt: event.now },
					changed: true,
				};
			}
			return { next: current, changed: false };
		}

		case "success": {
			// Terminal absorbing state: a drained (401/403/deprecated/weekly-cap) driver is NEVER resurrected by a late in-flight turn.
			if (current.state === "drained") {
				return { next: current, changed: false };
			}
			if (current.state === "healthy" && current.consecutiveErrors === 0) {
				return { next: current, changed: false };
			}
			const { cooldownUntil: _c, reason: _r, ...base } = current;
			return {
				next: { ...base, state: "healthy", consecutiveErrors: 0, updatedAt: event.now },
				changed: true,
			};
		}

		case "quota_error": {
			if (current.state === "drained") {
				return { next: current, changed: false };
			}
			const nextErrors = current.consecutiveErrors + 1;
			const { cooldownUntil: _c, reason: _r, ...base } = current;

			switch (event.error.kind) {
				case "hard_auth_or_cap":
					return {
						next: { ...base, state: "drained", reason: event.error.reason, consecutiveErrors: nextErrors, updatedAt: event.now },
						changed: true,
						emitted: "drained",
					};
				case "window_exhausted": {
					const until = event.error.resetAtMs ?? event.now + DEFAULT_COOLDOWN_MS;
					return {
						next: {
							...base,
							state: "cooldown",
							cooldownUntil: until,
							reason: event.error.raw.slice(0, 240),
							consecutiveErrors: nextErrors,
							updatedAt: event.now,
						},
						changed: true,
						emitted: "cooldown",
					};
				}
				case "transient_rpm":
					return {
						next: { ...current, consecutiveErrors: nextErrors, updatedAt: event.now },
						changed: true,
					};
				default:
					return assertNever(event.error, "Unhandled QuotaErrorClass");
			}
		}

		default:
			return assertNever(event, "Unhandled QuotaTransitionEvent");
	}
}

// --- 2. Atomic Task Lease State Machine ---
// Invariant: ONLY `status: "claimed"` carries `leaseOwner` and `leaseExpiresAt`, and `fencingToken` strictly increases on claim.

export type TaskLeaseClaimOutcome =
	| { readonly claimed: true; readonly task: ClaimedTaskRecord; readonly reason?: never }
	| { readonly claimed: false; readonly task?: never; readonly reason: string };

export function transitionClaimTask(
	task: TaskRecord | undefined,
	runId: string,
	taskId: string,
	agentId: string,
	ttlMs: number,
	now: number,
): TaskLeaseClaimOutcome {
	if (!task || task.runId !== runId) {
		return { claimed: false, reason: `Task ${taskId} not found` };
	}
	const isExpiredClaim = task.status === "claimed" && task.leaseExpiresAt <= now;
	if (task.status !== "open" && !isExpiredClaim) {
		const ownerNote = task.status === "claimed" ? ` (owned by ${task.leaseOwner})` : "";
		return { claimed: false, reason: `Task ${taskId} is ${task.status}${ownerNote}` };
	}
	const { leaseOwner: _o, leaseExpiresAt: _e, completedBy: _c, ...base } = task;
	const updated: ClaimedTaskRecord = {
		...base,
		status: "claimed",
		leaseOwner: agentId,
		leaseExpiresAt: now + ttlMs,
		fencingToken: task.fencingToken + 1,
		updatedAt: now,
	};
	return { claimed: true, task: updated };
}

export function transitionRenewTask(
	task: TaskRecord | undefined,
	agentId: string,
	fencingToken: number,
	ttlMs: number,
	now: number,
): ClaimedTaskRecord | undefined {
	if (!task || task.status !== "claimed") return undefined;
	if (task.leaseOwner !== agentId || task.fencingToken !== fencingToken) return undefined;
	return { ...task, leaseExpiresAt: now + ttlMs, updatedAt: now };
}

export function transitionReleaseTask(
	task: TaskRecord | undefined,
	agentId: string,
	fencingToken: number,
	nextStatus: Exclude<TaskStatus, "claimed">,
	update: { result?: string; artifactIds?: string[]; findingId?: string } = {},
	now: number,
): TaskRecord | undefined {
	if (!task || task.status !== "claimed") return undefined;
	if (task.leaseOwner !== agentId || task.fencingToken !== fencingToken) return undefined;
	const { leaseOwner: _o, leaseExpiresAt: _e, ...base } = task;
	const common = {
		...base,
		result: update.result ?? task.result,
		artifactIds: update.artifactIds ?? task.artifactIds,
		findingId: update.findingId ?? task.findingId,
		updatedAt: now,
	};
	if (nextStatus === "open") {
		return { ...common, status: "open" };
	}
	return { ...common, status: nextStatus, completedBy: agentId };
}

// --- 3. Run Lifecycle & Nomination State Machine ---
// Invariant: Terminal runs (`done | stopped | failed`) NEVER revert to `running` or `closing`; nominations always carry both ID and revision.

export type RunTransitionEvent =
	| { readonly type: "enter_closing"; readonly reason: string; readonly now: number }
	| { readonly type: "nominate"; readonly findingId: string; readonly revision: number; readonly now: number }
	| { readonly type: "finish"; readonly status: "done" | "stopped" | "failed"; readonly reason: string; readonly now: number };

export function transitionRun(current: Run, event: RunTransitionEvent): { readonly next: Run; readonly changed: boolean } {
	const nomination = current.nominatedFindingId !== undefined
		? { nominatedFindingId: current.nominatedFindingId, nominatedRevision: current.nominatedRevision }
		: {};

	switch (event.type) {
		case "enter_closing": {
			if (current.status !== "running") return { next: current, changed: false };
			const { status: _s, statusReason: _r, nominatedFindingId: _nf, nominatedRevision: _nr, ...base } = current;
			return {
				next: { ...base, ...nomination, status: "closing", statusReason: event.reason, updatedAt: event.now },
				changed: true,
			};
		}

		case "nominate": {
			const { nominatedFindingId: _nf, nominatedRevision: _nr, ...rest } = current;
			return {
				next: { ...rest, nominatedFindingId: event.findingId, nominatedRevision: event.revision, updatedAt: event.now } as Run,
				changed: true,
			};
		}

		case "finish": {
			if (current.status === "done" || current.status === "stopped" || current.status === "failed") {
				return { next: current, changed: false };
			}
			const { status: _s, statusReason: _r, nominatedFindingId: _nf, nominatedRevision: _nr, ...base } = current;
			return {
				next: { ...base, ...nomination, status: event.status, statusReason: event.reason, updatedAt: event.now },
				changed: true,
			};
		}

		default:
			return assertNever(event, "Unhandled RunTransitionEvent");
	}
}
