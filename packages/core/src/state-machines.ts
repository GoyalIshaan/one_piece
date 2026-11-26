import type { DriverKind, QuotaErrorClass } from "./driver.ts";
import {
	type AgentRecord,
	type AgentStatus,
	assertNever,
	type BoardPost,
	type ClaimedTaskRecord,
	type EvidenceLevel,
	type Exclusive,
	type Finding,
	type FindingSubmission,
	type ProviderQuotaRecord,
	type ReviewRound,
	type Run,
	type TaskRecord,
	type TaskStatus,
	TERMINAL_AGENT_STATUSES,
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

// --- 4. Agent Lifecycle State Machine ---
// Invariant: Terminal agent states (`done | stalled | failed | stopped`) are absorbing;
// `stalled` and `failed` ALWAYS carry a non-empty `statusReason`, and `pending | running` never carry one.

export type AgentTransitionEvent =
	| { readonly type: "set_status"; readonly status: AgentStatus; readonly reason?: string; readonly now: number };

const TERMINAL_AGENT_SET = new Set<string>(TERMINAL_AGENT_STATUSES);

export function transitionAgentRecord(
	current: AgentRecord,
	event: AgentTransitionEvent,
): { readonly next: AgentRecord; readonly changed: boolean } {
	if (TERMINAL_AGENT_SET.has(current.status)) {
		return { next: current, changed: false };
	}
	const { status: _s, statusReason: _r, ...base } = current;
	switch (event.status) {
		case "pending":
		case "running":
			return {
				next: { ...base, status: event.status, updatedAt: event.now },
				changed: current.status !== event.status,
			};
		case "parked":
		case "done":
		case "stopped":
			return {
				next: {
					...base,
					status: event.status,
					...(event.reason ? { statusReason: event.reason } : {}),
					updatedAt: event.now,
				},
				changed: true,
			};
		case "stalled":
		case "failed":
			return {
				next: {
					...base,
					status: event.status,
					statusReason: event.reason?.trim() || `Agent ${event.status}`,
					updatedAt: event.now,
				},
				changed: true,
			};
		default:
			return assertNever(event.status, "Unhandled AgentStatus");
	}
}

// --- 5. Finding Review Lifecycle State Machine ---
// Invariant: `unreviewed` ALWAYS carries `reviewError` (never silently accepted);
// `accepted | rejected | needs_work` NEVER retain stale `reviewError` or `retryAfter`.

export type FindingTransitionEvent =
	| {
		readonly type: "new_submission";
		readonly claim: string;
		readonly summary: string;
		readonly evidence?: string[];
		readonly level: EvidenceLevel;
		readonly score?: number;
		readonly submission: FindingSubmission;
		readonly now: number;
	}
	| { readonly type: "verdict"; readonly round: ReviewRound; readonly now: number }
	| { readonly type: "review_error"; readonly error: string; readonly retryAfter?: number; readonly now: number }
	| { readonly type: "challenge_failed"; readonly now: number };

export function transitionFinding(current: Finding, event: FindingTransitionEvent): Finding {
	const { status: _s, confidence: _c, reviewError: _re, retryAfter: _ra, ...base } = current;
	switch (event.type) {
		case "new_submission":
			return {
				...base,
				claim: event.claim,
				summary: event.summary,
				evidence: event.evidence ?? base.evidence,
				level: event.level,
				score: event.score ?? base.score,
				submissions: [...base.submissions, event.submission],
				status: "pending_review",
				updatedAt: event.now,
			};
		case "verdict":
			return {
				...base,
				status: event.round.verdict,
				confidence: event.round.confidence ?? current.confidence,
				rounds: [...base.rounds, event.round],
				updatedAt: event.now,
			};
		case "review_error":
			return {
				...base,
				status: "unreviewed",
				reviewError: event.error.trim() || "Review lens failed",
				...(event.retryAfter !== undefined ? { retryAfter: event.retryAfter } : {}),
				updatedAt: event.now,
			};
		case "challenge_failed":
			return {
				...base,
				status: "needs_work",
				confidence: current.confidence,
				updatedAt: event.now,
			};
		default:
			return assertNever(event, "Unhandled FindingTransitionEvent");
	}
}

// --- 6. BoardPost Supersede Transition ---
// Invariant: A post can never supersede itself, and an already-superseded post cannot be superseded again.

export type SupersedePostOutcome =
	| { readonly ok: true; readonly updated: BoardPost; readonly reason?: never }
	| { readonly ok: false; readonly reason: "self_supersede" | "already_superseded"; readonly updated?: never };

export function transitionSupersedePost(target: BoardPost, replacementId: string): SupersedePostOutcome {
	if (target.id === replacementId) return { ok: false, reason: "self_supersede" };
	if (target.supersededBy) return { ok: false, reason: "already_superseded" };
	return { ok: true, updated: { ...target, supersededBy: replacementId } };
}

// --- 7. BoardPost Epistemic Promotion State Machine ---
// Invariant: A superseded draft can NEVER be promoted to global visibility, and an already-promoted post is idempotent.

export type PromotedBoardPost = BoardPost & { readonly visibility: "global" };

export type PromotePostOutcome = Exclusive<
	| { readonly ok: true; readonly updated: PromotedBoardPost }
	| { readonly ok: false; readonly reason: "already_superseded" | "already_promoted" }
>;

export function transitionPromotePost(
	target: BoardPost,
	opts: { labels?: Record<string, string> } = {},
): PromotePostOutcome {
	if (target.supersededBy) {
		return { ok: false, reason: "already_superseded" };
	}
	if (target.visibility === "global" && target.labels?.["os:promoted"] === "true") {
		return { ok: false, reason: "already_promoted" };
	}
	const nextLabels: Record<string, string> = {
		...(target.labels ?? {}),
		...(opts.labels ?? {}),
		"os:promoted": "true",
	};
	return {
		ok: true,
		updated: {
			...target,
			visibility: "global",
			labels: nextLabels,
		},
	};
}

// --- 8. Driver Slot Permit State Machine (Prevents double-release & unpark-after-release) ---
// Invariant: `released` is terminal absorbing; illegal `{ released: true, parked: true }` is unrepresentable.

export type SlotPermitState = "held" | "parked" | "released";
export type SlotPermitEvent = "park" | "unpark" | "release";

export interface SlotPermitTransition {
	readonly next: SlotPermitState;
	readonly runningDelta: -1 | 0 | 1;
	readonly shouldDispatch: boolean;
}

export function transitionSlotPermit(current: SlotPermitState, event: SlotPermitEvent): SlotPermitTransition {
	switch (current) {
		case "held":
			switch (event) {
				case "park":
					return { next: "parked", runningDelta: -1, shouldDispatch: true };
				case "unpark":
					return { next: "held", runningDelta: 0, shouldDispatch: false };
				case "release":
					return { next: "released", runningDelta: -1, shouldDispatch: true };
				default:
					return assertNever(event, "Unhandled SlotPermitEvent");
			}
		case "parked":
			switch (event) {
				case "park":
					return { next: "parked", runningDelta: 0, shouldDispatch: false };
				case "unpark":
					return { next: "held", runningDelta: 1, shouldDispatch: false };
				case "release":
					return { next: "released", runningDelta: 0, shouldDispatch: true };
				default:
					return assertNever(event, "Unhandled SlotPermitEvent");
			}
		case "released":
			return { next: "released", runningDelta: 0, shouldDispatch: false };
		default:
			return assertNever(current, "Unhandled SlotPermitState");
	}
}

// --- 9. Monotonic Green-Trunk Ratchet State Machine ---
// Invariant: `base` never carries a findingId/score; `accepted` always carries a concrete findingId and
// NEVER downgrades back to `partial` or `base`.

export type TrunkRatchetState = Exclusive<
	| { readonly phase: "base"; readonly sha: string }
	| { readonly phase: "partial"; readonly sha: string; readonly findingId: string; readonly score?: number }
	| { readonly phase: "accepted"; readonly sha: string; readonly findingId: string; readonly score?: number }
>;

export function transitionTrunkRatchet(
	current: TrunkRatchetState,
	advance: { readonly sha: string; readonly finding: Finding },
): TrunkRatchetState {
	const nextScore =
		typeof advance.finding.score === "number"
			? Math.max(current.score ?? Number.NEGATIVE_INFINITY, advance.finding.score)
			: current.score;

	if (advance.finding.status === "accepted") {
		return {
			phase: "accepted",
			sha: advance.sha,
			findingId: advance.finding.id,
			...(nextScore !== undefined ? { score: nextScore } : {}),
		};
	}

	// Never downgrade an already-accepted trunk to partial!
	if (current.phase === "accepted") {
		return {
			phase: "accepted",
			sha: advance.sha,
			findingId: current.findingId,
			...(nextScore !== undefined ? { score: nextScore } : {}),
		};
	}

	return {
		phase: "partial",
		sha: advance.sha,
		findingId: advance.finding.id,
		...(nextScore !== undefined ? { score: nextScore } : {}),
	};
}

// --- 10. Physics Concurrency Governor Window State Machine ---
// Invariant: `fixed` drivers NEVER carry or mutate AIMD window/streak counters.

export type DriverWindowState = Exclusive<
	| { readonly mode: "fixed"; readonly kind: DriverKind; readonly fixedLimit: number }
	| {
		readonly mode: "physics";
		readonly kind: DriverKind;
		readonly hardMax?: number;
		readonly window: number;
		readonly consecutiveSuccesses: number;
	}
>;

export type DriverWindowEvent =
	| { readonly type: "success"; readonly scaleUpAfter: number; readonly hostHasHeadroom: boolean }
	| { readonly type: "rate_limit" };

export function transitionDriverWindow(
	current: DriverWindowState,
	event: DriverWindowEvent,
): { readonly next: DriverWindowState; readonly prevWindow: number; readonly nextWindow: number; readonly changed: boolean } {
	if (current.mode === "fixed") {
		return { next: current, prevWindow: current.fixedLimit, nextWindow: current.fixedLimit, changed: false };
	}

	switch (event.type) {
		case "success": {
			const nextStreak = current.consecutiveSuccesses + 1;
			if (nextStreak < event.scaleUpAfter) {
				return {
					next: { ...current, consecutiveSuccesses: nextStreak },
					prevWindow: current.window,
					nextWindow: current.window,
					changed: false,
				};
			}
			const resetState: DriverWindowState = { ...current, consecutiveSuccesses: 0 };
			if (!event.hostHasHeadroom) {
				return { next: resetState, prevWindow: current.window, nextWindow: current.window, changed: false };
			}
			const nextRaw = current.window + 1;
			const nextWindow = current.hardMax !== undefined ? Math.min(nextRaw, current.hardMax) : nextRaw;
			if (nextWindow <= current.window) {
				return { next: resetState, prevWindow: current.window, nextWindow: current.window, changed: false };
			}
			return {
				next: { ...resetState, window: nextWindow },
				prevWindow: current.window,
				nextWindow,
				changed: true,
			};
		}
		case "rate_limit": {
			const nextWindow = Math.max(1, Math.floor(current.window / 2));
			return {
				next: { ...current, window: nextWindow, consecutiveSuccesses: 0 },
				prevWindow: current.window,
				nextWindow,
				changed: nextWindow !== current.window,
			};
		}
		default:
			return assertNever(event, "Unhandled DriverWindowEvent");
	}
}
