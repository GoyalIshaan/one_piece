import { describe, expect, it } from "vitest";
import {
	type AgentRecord,
	type BoardPost,
	type BoardPostLabelResult,
	type BoardWaitResult,
	type Finding,
	type FindingSubmission,
	type MergeTrunkResult,
	type ProviderQuotaRecord,
	type Report,
	type Run,
	type TaskRecord,
	type TopologyOutcome,
	transitionAgentRecord,
	transitionClaimTask,
	transitionFinding,
	transitionQuotaRecord,
	transitionReleaseTask,
	transitionRenewTask,
	transitionRun,
	transitionSupersedePost,
	type VerificationReceipt,
	type WorkerTurnResult,
} from "../src/index.ts";

describe("core state machines (runtime invariants + compile-time proofs)", () => {
	it("enforces ProviderQuotaRecord absorbing drained state and cooldown recovery", () => {
		const initial: ProviderQuotaRecord = {
			id: "quota:run-1:codex",
			runId: "run-1",
			driverId: "codex",
			state: "healthy",
			consecutiveErrors: 0,
			updatedAt: 1000,
		};

		// Transient RPM increments error counter without changing state
		const rpm = transitionQuotaRecord(initial, {
			type: "quota_error",
			error: { kind: "transient_rpm", retryAfterMs: 2000, raw: "429 too many requests" },
			now: 1500,
		});
		expect(rpm.changed).toBe(true);
		expect(rpm.next.state).toBe("healthy");
		expect(rpm.next.consecutiveErrors).toBe(1);

		// Window exhausted moves to cooldown with explicit cooldownUntil
		const cooled = transitionQuotaRecord(rpm.next, {
			type: "quota_error",
			error: { kind: "window_exhausted", resetAtMs: 5000, raw: "5-hour window exhausted" },
			now: 2000,
		});
		expect(cooled.changed).toBe(true);
		expect(cooled.emitted).toBe("cooldown");
		expect(cooled.next.state).toBe("cooldown");
		if (cooled.next.state === "cooldown") {
			expect(cooled.next.cooldownUntil).toBe(5000);
		}

		// Tick before expiry is a no-op
		expect(transitionQuotaRecord(cooled.next, { type: "tick", now: 4999 }).changed).toBe(false);

		// Tick at/after expiry recovers to healthy and strips cooldownUntil/reason
		const recovered = transitionQuotaRecord(cooled.next, { type: "tick", now: 5000 });
		expect(recovered.changed).toBe(true);
		expect(recovered.next.state).toBe("healthy");
		expect("cooldownUntil" in recovered.next).toBe(false);

		// Hard auth/cap moves to terminal drained state
		const drained = transitionQuotaRecord(recovered.next, {
			type: "quota_error",
			error: { kind: "hard_auth_or_cap", reason: "HTTP 403 unauthorized", raw: "403" },
			now: 6000,
		});
		expect(drained.changed).toBe(true);
		expect(drained.emitted).toBe("drained");
		expect(drained.next.state).toBe("drained");

		// ABSORBING INVARIANT: late in-flight success, tick, or subsequent quota_error NEVER resurrect a drained driver
		const afterLateSuccess = transitionQuotaRecord(drained.next, { type: "success", now: 7000 });
		expect(afterLateSuccess.changed).toBe(false);
		expect(afterLateSuccess.next.state).toBe("drained");

		const afterTick = transitionQuotaRecord(drained.next, { type: "tick", now: 99_999_999 });
		expect(afterTick.changed).toBe(false);
		expect(afterTick.next.state).toBe("drained");

		const afterMoreErrors = transitionQuotaRecord(drained.next, {
			type: "quota_error",
			error: { kind: "window_exhausted", resetAtMs: 10000, raw: "window" },
			now: 8000,
		});
		expect(afterMoreErrors.changed).toBe(false);
		expect(afterMoreErrors.next.state).toBe("drained");
	});

	it("enforces TaskRecord fencing tokens, lease expiration, and clean terminal release", () => {
		const openTask: TaskRecord = {
			id: "tsk-1",
			runId: "run-1",
			title: "Implement parser",
			description: "Parse expressions",
			dependsOn: [],
			status: "open",
			fencingToken: 0,
			createdBy: "root",
			createdAt: 100,
			updatedAt: 100,
		};

		const claim1 = transitionClaimTask(openTask, "run-1", "tsk-1", "agt-1", 5000, 1000);
		expect(claim1.claimed).toBe(true);
		if (!claim1.claimed) throw new Error("expected claim1");
		expect(claim1.task.fencingToken).toBe(1);
		expect(claim1.task.leaseOwner).toBe("agt-1");
		expect(claim1.task.leaseExpiresAt).toBe(6000);

		// Concurrent claim while lease is live fails
		const blockedClaim = transitionClaimTask(claim1.task, "run-1", "tsk-1", "agt-2", 5000, 3000);
		expect(blockedClaim.claimed).toBe(false);

		// Expired lease can be reclaimed by agt-2 with strictly incremented fencingToken
		const claim2 = transitionClaimTask(claim1.task, "run-1", "tsk-1", "agt-2", 5000, 6000);
		expect(claim2.claimed).toBe(true);
		if (!claim2.claimed) throw new Error("expected claim2");
		expect(claim2.task.fencingToken).toBe(2);
		expect(claim2.task.leaseOwner).toBe("agt-2");

		// Stale owner agt-1 (token=1) cannot renew or release
		expect(transitionRenewTask(claim2.task, "agt-1", 1, 5000, 7000)).toBeUndefined();
		expect(transitionReleaseTask(claim2.task, "agt-1", 1, "done", { result: "stale" }, 7000)).toBeUndefined();

		// Valid owner agt-2 (token=2) renews and then completes; lease fields are stripped and completedBy is set
		const renewed = transitionRenewTask(claim2.task, "agt-2", 2, 5000, 7000);
		expect(renewed?.leaseExpiresAt).toBe(12000);

		const done = transitionReleaseTask(renewed, "agt-2", 2, "done", { result: "shipped" }, 8000);
		expect(done?.status).toBe("done");
		if (done?.status === "done") {
			expect(done.completedBy).toBe("agt-2");
		}
		expect("leaseOwner" in (done ?? {})).toBe(false);
		expect("leaseExpiresAt" in (done ?? {})).toBe(false);

		// Terminal task cannot be re-claimed
		expect(transitionClaimTask(done, "run-1", "tsk-1", "agt-3", 5000, 9000).claimed).toBe(false);
	});

	it("enforces Run monotonic lifecycle and atomic nomination pairs", () => {
		const running: Run = {
			id: "run-1",
			topology: "pull-refinery",
			goal: { title: "Test", text: "Test goal" },
			budget: { tokens: 1000 },
			spent: {},
			status: "running",
			config: {},
			createdAt: 100,
			updatedAt: 100,
		};

		const closing = transitionRun(running, { type: "enter_closing", reason: "wall reserve", now: 200 });
		expect(closing.changed).toBe(true);
		expect(closing.next.status).toBe("closing");

		// Entering closing twice is idempotent
		expect(transitionRun(closing.next, { type: "enter_closing", reason: "again", now: 250 }).changed).toBe(false);

		const nominated = transitionRun(closing.next, { type: "nominate", findingId: "fnd-1", revision: 2, now: 300 });
		expect(nominated.next.nominatedFindingId).toBe("fnd-1");
		expect(nominated.next.nominatedRevision).toBe(2);

		const finished = transitionRun(nominated.next, { type: "finish", status: "done", reason: "complete", now: 400 });
		expect(finished.changed).toBe(true);
		expect(finished.next.status).toBe("done");
		expect(finished.next.nominatedFindingId).toBe("fnd-1");
		expect(finished.next.nominatedRevision).toBe(2);

		// Terminal run NEVER reverts to closing or another finish status
		expect(transitionRun(finished.next, { type: "enter_closing", reason: "late", now: 500 }).changed).toBe(false);
		expect(transitionRun(finished.next, { type: "finish", status: "failed", reason: "late", now: 500 }).changed).toBe(false);
	});

	it("enforces AgentRecord absorbing terminals, Finding review transitions, and BoardPost supersede guards", () => {
		const agent: AgentRecord = {
			id: "agt-1",
			runId: "run-1",
			handle: "peer-1",
			role: "worker",
			driverId: "codex",
			status: "running",
			turns: 0,
			spent: {},
			createdAt: 100,
			updatedAt: 100,
		};
		const stalled = transitionAgentRecord(agent, { type: "set_status", status: "stalled", reason: "looping", now: 200 });
		expect(stalled.changed).toBe(true);
		expect(stalled.next.status).toBe("stalled");
		if (stalled.next.status === "stalled") expect(stalled.next.statusReason).toBe("looping");

		// Absorbing terminal: stalled agent CANNOT revert to running or be overwritten by done
		expect(transitionAgentRecord(stalled.next, { type: "set_status", status: "running", now: 300 }).changed).toBe(false);
		expect(transitionAgentRecord(stalled.next, { type: "set_status", status: "done", now: 300 }).changed).toBe(false);

		const pending: Finding = {
			id: "fnd-1",
			runId: "run-1",
			authorAgentId: "agt-1",
			claim: "c",
			summary: "s",
			evidence: [],
			level: "empirical",
			status: "pending_review",
			submissions: [],
			rounds: [],
			buildsOn: [],
			createdAt: 100,
			updatedAt: 100,
		};
		const unreviewed = transitionFinding(pending, { type: "review_error", error: "lens crashed", now: 200 });
		expect(unreviewed.status).toBe("unreviewed");
		if (unreviewed.status === "unreviewed") expect(unreviewed.reviewError).toBe("lens crashed");

		const accepted = transitionFinding(unreviewed, {
			type: "verdict",
			round: {
				round: 1,
				revision: 1,
				reviewerAgentId: "verifier",
				verdict: "accepted",
				message: "passed",
				confidence: 0.95,
				checksRun: ["suite:passed"],
				at: 300,
			},
			now: 300,
		});
		expect(accepted.status).toBe("accepted");
		expect("reviewError" in accepted).toBe(false);

		const post: BoardPost = {
			id: "post-1",
			runId: "run-1",
			topic: "plan",
			authorAgentId: "agt-1",
			summary: "v1",
			body: "v1",
			createdAt: 100,
		};
		expect(transitionSupersedePost(post, "post-1")).toEqual({ ok: false, reason: "self_supersede" });
		const sup1 = transitionSupersedePost(post, "post-2");
		expect(sup1.ok).toBe(true);
		if (sup1.ok) {
			expect(sup1.updated.supersededBy).toBe("post-2");
			expect(transitionSupersedePost(sup1.updated, "post-3")).toEqual({ ok: false, reason: "already_superseded" });
		}
	});

	it("proves illegal states are unrepresentable at compile time", () => {
		// 1. ProviderQuotaRecord illegal states
		// @ts-expect-error cooldown requires cooldownUntil and reason
		const _badQuotaCooldown: ProviderQuotaRecord = {
			id: "q1",
			driverId: "codex",
			state: "cooldown",
			consecutiveErrors: 1,
			updatedAt: 0,
		};
		// @ts-expect-error healthy forbids cooldownUntil
		const _badQuotaHealthy: ProviderQuotaRecord = {
			id: "q2",
			driverId: "codex",
			state: "healthy",
			cooldownUntil: 1234,
			consecutiveErrors: 0,
			updatedAt: 0,
		};
		// @ts-expect-error drained requires reason
		const _badQuotaDrained: ProviderQuotaRecord = {
			id: "q3",
			driverId: "codex",
			state: "drained",
			consecutiveErrors: 1,
			updatedAt: 0,
		};

		// 2. TaskRecord illegal states
		// @ts-expect-error claimed requires leaseOwner and leaseExpiresAt
		const _badTaskClaimed: TaskRecord = {
			id: "t1",
			runId: "r1",
			title: "t",
			description: "d",
			dependsOn: [],
			status: "claimed",
			fencingToken: 1,
			createdBy: "root",
			createdAt: 0,
			updatedAt: 0,
		};
		// @ts-expect-error terminal tasks forbid leaseOwner
		const _badTaskDone: TaskRecord = {
			id: "t2",
			runId: "r1",
			title: "t",
			description: "d",
			dependsOn: [],
			status: "done",
			leaseOwner: "agt-1",
			fencingToken: 1,
			createdBy: "root",
			createdAt: 0,
			updatedAt: 0,
		};

		// 3. WorkerTurnResult illegal states
		// @ts-expect-error rate_limited requires quotaError and error
		const _badTurnRateLimited: WorkerTurnResult = {
			status: "rate_limited",
			finalText: "",
		};
		// @ts-expect-error completed forbids error
		const _badTurnCompleted: WorkerTurnResult = {
			status: "completed",
			finalText: "ok",
			error: "boom",
		};
		const _badTurnFailed: WorkerTurnResult = {
			status: "failed",
			finalText: "",
			error: "boom",
			// @ts-expect-error failed forbids quotaError
			quotaError: { kind: "transient_rpm", raw: "429" },
		};

		// 4. FindingSubmission snapshot XOR invariant
		// @ts-expect-error artifactSha256 requires snapshotDir
		const _badSubHalfSnapshot: FindingSubmission = {
			revision: 1,
			claim: "c",
			summary: "s",
			evidence: [],
			level: "exact_check",
			artifactSha256: "abc",
			checks: [],
			at: 0,
		};
		// @ts-expect-error snapshot cannot carry both artifactSha256/snapshotDir and snapshotNote
		const _badSubBothSnapshot: FindingSubmission = {
			revision: 1,
			claim: "c",
			summary: "s",
			evidence: [],
			level: "exact_check",
			artifactSha256: "abc",
			snapshotDir: "/tmp/x",
			snapshotNote: "failed",
			checks: [],
			at: 0,
		};

		// 5. VerificationReceipt invariant
		// @ts-expect-error passed receipt cannot carry a counterexample
		const _badReceiptPassed: VerificationReceipt = {
			checker: "test",
			version: "1",
			kind: "suite",
			status: "passed",
			message: "ok",
			counterexample: "{\"x\":1}",
		};

		// 6. Run & Report invariants
		// @ts-expect-error terminal Run requires statusReason
		const _badRunDone: Run = {
			id: "r1",
			topology: "single",
			goal: { title: "g", text: "g" },
			budget: {},
			spent: {},
			status: "done",
			config: {},
			createdAt: 0,
			updatedAt: 0,
		};
		// @ts-expect-error Run nomination requires both nominatedFindingId and nominatedRevision
		const _badRunHalfNom: Run = {
			id: "r2",
			topology: "single",
			goal: { title: "g", text: "g" },
			budget: {},
			spent: {},
			status: "running",
			nominatedFindingId: "fnd-1",
			config: {},
			createdAt: 0,
			updatedAt: 0,
		};
		// @ts-expect-error Report nomination requires both nominatedFindingId and nominatedRevision
		const _badReportHalfNom: Report = {
			id: "rpt-1",
			runId: "r1",
			kind: "final",
			title: "t",
			markdown: "# hi",
			nominatedFindingId: "fnd-1",
			createdAt: 0,
		};

		// 7. MergeTrunkResult discriminated union invariants
		// @ts-expect-error successful merge forbids conflictFiles
		const _badMergeOkWithConflicts: MergeTrunkResult = {
			ok: true,
			commitSha: "abc123",
			conflictFiles: ["src/a.ts"],
		};
		// @ts-expect-error failed merge requires conflictFiles
		const _badMergeFailMissingConflicts: MergeTrunkResult = {
			ok: false,
			error: "merge failed",
		};
		// @ts-expect-error failed merge forbids commitSha
		const _badMergeFailWithSha: MergeTrunkResult = {
			ok: false,
			conflictFiles: ["src/a.ts"],
			error: "conflict",
			commitSha: "abc123",
		};

		// 8. AgentRecord illegal states
		// @ts-expect-error stalled requires statusReason
		const _badAgentStalled: AgentRecord = {
			id: "a1",
			runId: "r1",
			handle: "peer-1",
			role: "worker",
			driverId: "codex",
			status: "stalled",
			turns: 1,
			spent: {},
			createdAt: 0,
			updatedAt: 0,
		};
		// @ts-expect-error running forbids statusReason
		const _badAgentRunning: AgentRecord = {
			id: "a2",
			runId: "r1",
			handle: "peer-2",
			role: "worker",
			driverId: "codex",
			status: "running",
			statusReason: "should not exist",
			turns: 1,
			spent: {},
			createdAt: 0,
			updatedAt: 0,
		};

		// 9. Finding illegal states
		// @ts-expect-error unreviewed requires reviewError
		const _badFindingUnreviewed: Finding = {
			id: "f1",
			runId: "r1",
			authorAgentId: "a1",
			claim: "c",
			summary: "s",
			evidence: [],
			level: "empirical",
			status: "unreviewed",
			submissions: [],
			rounds: [],
			buildsOn: [],
			createdAt: 0,
			updatedAt: 0,
		};
		// @ts-expect-error accepted forbids reviewError
		const _badFindingAccepted: Finding = {
			id: "f2",
			runId: "r1",
			authorAgentId: "a1",
			claim: "c",
			summary: "s",
			evidence: [],
			level: "empirical",
			status: "accepted",
			reviewError: "stale error",
			submissions: [],
			rounds: [],
			buildsOn: [],
			createdAt: 0,
			updatedAt: 0,
		};

		// 10. BoardPostLabelResult, BoardWaitResult, and TopologyOutcome invariants
		// @ts-expect-error conflict requires currentLabels
		const _badLabelConflict: BoardPostLabelResult = { ok: false, reason: "conflict" };
		// @ts-expect-error not_found forbids currentLabels
		const _badLabelNotFound: BoardPostLabelResult = { ok: false, reason: "not_found", currentLabels: {} };
		// @ts-expect-error matched wait result forbids empty posts tuple
		const _badWaitMatchedEmpty: BoardWaitResult = { status: "matched", timedOut: false, posts: [], cursor: 0, topics: [] };
		// @ts-expect-error TopologyOutcome nomination requires both nominatedFindingId and nominatedRevision
		const _badTopoHalfNom: TopologyOutcome = { status: "done", summary: "ok", nominatedFindingId: "fnd-1" };

		// Silence unused-variable warnings while proving every type assertion compiled
		expect([
			_badQuotaCooldown,
			_badQuotaHealthy,
			_badQuotaDrained,
			_badTaskClaimed,
			_badTaskDone,
			_badTurnRateLimited,
			_badTurnCompleted,
			_badTurnFailed,
			_badSubHalfSnapshot,
			_badSubBothSnapshot,
			_badReceiptPassed,
			_badRunDone,
			_badRunHalfNom,
			_badReportHalfNom,
			_badMergeOkWithConflicts,
			_badMergeFailMissingConflicts,
			_badMergeFailWithSha,
			_badAgentStalled,
			_badAgentRunning,
			_badFindingUnreviewed,
			_badFindingAccepted,
			_badLabelConflict,
			_badLabelNotFound,
			_badWaitMatchedEmpty,
			_badTopoHalfNom,
		]).toBeDefined();
	});
});
