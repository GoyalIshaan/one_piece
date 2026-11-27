import { describe, expect, it } from "vitest";
import {
	PermitActor,
	transitionAgentRecord,
	transitionClaimTask,
	transitionDriverWindow,
	transitionFinding,
	transitionPromotePost,
	transitionQuotaRecord,
	transitionReleaseTask,
	transitionRenewTask,
	transitionRun,
	transitionSlotPermit,
	transitionSupersedePost,
	transitionTrunkRatchet,
	type AgentRecord,
	type AgentStatus,
	type BoardPost,
	type DriverWindowState,
	type Finding,
	type ProviderQuotaRecord,
	type Run,
	type SlotPermitEvent,
	type SlotPermitState,
	type TaskRecord,
	type TrunkRatchetState,
} from "../src/index.ts";

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(rand: () => number, items: readonly T[]): T {
	return items[Math.floor(rand() * items.length)]!;
}

describe("Property-based state machine & concurrency invariant fuzzing", () => {
	it("fuzzes ProviderQuotaRecord (10,000 steps): drained is strictly absorbing and fields obey variant invariants", () => {
		const rand = mulberry32(20261126);
		let now = 1_000_000;

		for (let trial = 0; trial < 200; trial++) {
			let rec: ProviderQuotaRecord = {
				id: `q-${trial}`,
				runId: "run-fuzz",
				driverId: "drv-a",
				state: "healthy",
				consecutiveErrors: 0,
				updatedAt: now,
			};
			let enteredDrained = false;

			for (let step = 0; step < 50; step++) {
				now += Math.floor(rand() * 120_000);
				const roll = rand();
				const ev =
					roll < 0.3
						? ({ type: "tick", now } as const)
						: roll < 0.6
							? ({ type: "success", now } as const)
							: roll < 0.78
								? ({ type: "quota_error", now, error: { kind: "transient_rpm", retryAfterMs: 1000, raw: "429" } } as const)
								: roll < 0.94
									? ({ type: "quota_error", now, error: { kind: "window_exhausted", resetAtMs: now + 60_000, raw: "window" } } as const)
									: ({ type: "quota_error", now, error: { kind: "hard_auth_or_cap", reason: "401 revoked", raw: "401 revoked" } } as const);

				const res = transitionQuotaRecord(rec, ev);
				rec = res.next;

				if (enteredDrained) {
					expect(rec.state).toBe("drained");
					expect(res.changed).toBe(false);
				}
				if (rec.state === "drained") {
					enteredDrained = true;
					expect(rec.reason.length).toBeGreaterThan(0);
					expect("cooldownUntil" in rec).toBe(false);
				} else if (rec.state === "cooldown") {
					expect(typeof rec.cooldownUntil).toBe("number");
					expect(rec.reason.length).toBeGreaterThan(0);
				} else {
					expect("cooldownUntil" in rec).toBe(false);
					expect("reason" in rec).toBe(false);
				}
			}
		}
	});

	it("fuzzes TaskRecord leases (10,000 steps): fencing tokens strictly increase and stale owners can never renew or release", () => {
		const rand = mulberry32(4242);
		const agents = ["a1", "a2", "a3"] as const;
		const releaseTargets = ["open", "done", "failed", "blocked"] as const;
		let now = 10_000;

		for (let trial = 0; trial < 200; trial++) {
			let task: TaskRecord = {
				id: `t-${trial}`,
				runId: "run-fuzz",
				title: "fuzz task",
				description: "desc",
				dependsOn: [],
				createdBy: "planner-0",
				status: "open",
				fencingToken: 0,
				createdAt: now,
				updatedAt: now,
			};
			let lastToken = 0;
			let activeLease: { agentId: string; token: number } | undefined;

			for (let step = 0; step < 50; step++) {
				now += Math.floor(rand() * 4_000);
				const roll = rand();
				if (roll < 0.45) {
					const caller = pick(rand, agents);
					const prevStatus = task.status;
					const prevExpired = task.status === "claimed" && task.leaseExpiresAt <= now;
					const out = transitionClaimTask(task, "run-fuzz", task.id, caller, 3_000, now);
					if (prevStatus === "open" || prevExpired) {
						expect(out.claimed).toBe(true);
						if (out.claimed) {
							expect(out.task.fencingToken).toBe(lastToken + 1);
							lastToken = out.task.fencingToken;
							task = out.task;
							activeLease = { agentId: caller, token: out.task.fencingToken };
						}
					} else {
						expect(out.claimed).toBe(false);
					}
				} else if (roll < 0.72) {
					// Attempt renewal with either valid or deliberately stale owner/token
					const useValid = rand() < 0.5 && activeLease !== undefined;
					const caller = useValid ? activeLease!.agentId : pick(rand, agents);
					const tok = useValid ? activeLease!.token : Math.max(0, lastToken - 1);
					const renewed = transitionRenewTask(task, caller, tok, 3_000, now);
					if (task.status === "claimed" && task.leaseOwner === caller && task.fencingToken === tok) {
						expect(renewed).toBeDefined();
						task = renewed!;
					} else {
						expect(renewed).toBeUndefined();
					}
				} else {
					const useValid = rand() < 0.5 && activeLease !== undefined;
					const caller = useValid ? activeLease!.agentId : pick(rand, agents);
					const tok = useValid ? activeLease!.token : Math.max(0, lastToken - 1);
					const nextStatus = pick(rand, releaseTargets);
					const released = transitionReleaseTask(task, caller, tok, nextStatus, { result: "ok" }, now);
					if (task.status === "claimed" && task.leaseOwner === caller && task.fencingToken === tok) {
						expect(released).toBeDefined();
						task = released!;
						activeLease = undefined;
					} else {
						expect(released).toBeUndefined();
					}
				}

				// Variant shape invariant at every single step
				if (task.status === "claimed") {
					expect(typeof task.leaseOwner).toBe("string");
					expect(typeof task.leaseExpiresAt).toBe("number");
					expect("completedBy" in task).toBe(false);
				} else {
					expect("leaseOwner" in task).toBe(false);
					expect("leaseExpiresAt" in task).toBe(false);
				}
				expect(task.fencingToken).toBeGreaterThanOrEqual(lastToken);
			}
		}
	});

	it("fuzzes Run & Agent lifecycles (10,000 steps): terminal states are absorbing and nomination pairs are atomic", () => {
		const rand = mulberry32(9001);
		const agentStatuses: readonly AgentStatus[] = ["pending", "running", "parked", "done", "stalled", "failed", "stopped"];
		const terminalRunStatuses = new Set(["done", "stopped", "failed"]);
		const terminalAgentStatuses = new Set(["done", "stalled", "failed", "stopped"]);
		let now = 50_000;

		for (let trial = 0; trial < 200; trial++) {
			let run: Run = {
				id: `run-${trial}`,
				topology: "adaptive",
				goal: { title: "g", text: "d" },
				workspace: "/tmp/w",
				budget: { tokens: 10_000 },
				spent: { tokens: 0, usd: 0 },
				config: {},
				status: "running",
				createdAt: now,
				updatedAt: now,
			};
			let runTerminalStatus: string | undefined;

			let agent: AgentRecord = {
				id: `ag-${trial}`,
				runId: run.id,
				handle: "w-1",
				role: "worker",
				driverId: "codex",
				status: "pending",
				workspace: "/tmp/w",
				turns: 0,
				spent: { tokens: 0, usd: 0 },
				createdAt: now,
				updatedAt: now,
			};
			let agentTerminalStatus: string | undefined;

			for (let step = 0; step < 50; step++) {
				now += 100;
				const rRoll = rand();
				const runEv =
					rRoll < 0.35
						? ({ type: "enter_closing", reason: "reserve", now } as const)
						: rRoll < 0.7
							? ({ type: "nominate", findingId: `f-${step}`, revision: step + 1, now } as const)
							: ({ type: "finish", status: pick(rand, ["done", "stopped", "failed"] as const), reason: "end", now } as const);
				const rOut = transitionRun(run, runEv);
				run = rOut.next;

				if (runTerminalStatus) {
					expect(run.status).toBe(runTerminalStatus);
				} else if (terminalRunStatuses.has(run.status)) {
					runTerminalStatus = run.status;
				}
				// Nomination atomicity invariant
				const hasId = run.nominatedFindingId !== undefined;
				const hasRev = run.nominatedRevision !== undefined;
				expect(hasId).toBe(hasRev);

				const nextAgentStatus = pick(rand, agentStatuses);
				const aOut = transitionAgentRecord(agent, {
					type: "set_status",
					status: nextAgentStatus,
					reason: rand() < 0.5 ? "" : "reason-x",
					now,
				});
				agent = aOut.next;

				if (agentTerminalStatus) {
					expect(agent.status).toBe(agentTerminalStatus);
					expect(aOut.changed).toBe(false);
				} else if (terminalAgentStatuses.has(agent.status)) {
					agentTerminalStatus = agent.status;
				}
				if (agent.status === "stalled" || agent.status === "failed") {
					expect(agent.statusReason.trim().length).toBeGreaterThan(0);
				} else if (agent.status === "pending" || agent.status === "running") {
					expect("statusReason" in agent).toBe(false);
				}
			}
		}
	});

	it("fuzzes Finding review, Board supersede/promote, SlotPermit, TrunkRatchet, and PhysicsWindow (10,000+ steps)", () => {
		const rand = mulberry32(1337);
		let now = 100_000;

		for (let trial = 0; trial < 200; trial++) {
			// Finding lifecycle
			let finding: Finding = {
				id: `fnd-${trial}`,
				runId: "r",
				authorAgentId: "a",
				claim: "c",
				summary: "s",
				evidence: [],
				buildsOn: [],
				level: "empirical",
				status: "pending_review",
				submissions: [
					{
						revision: 1,
						claim: "c",
						summary: "s",
						evidence: [],
						level: "empirical",
						checks: [],
						at: now,
						snapshotNote: "init",
					},
				],
				rounds: [],
				createdAt: now,
				updatedAt: now,
			};

			// Board post
			let post: BoardPost = {
				id: `p-${trial}`,
				runId: "r",
				topic: "findings",
				authorAgentId: "a",
				summary: "sum",
				body: "body",
				visibility: "subtree",
				subtreeId: "sub-1",
				createdAt: now,
			};

			// Slot permit
			let permitState: SlotPermitState = "held";
			let runningCount = 1;

			// Trunk ratchet
			let ratchet: TrunkRatchetState = { phase: "base", sha: "sha0" };
			let maxScoreSeen = Number.NEGATIVE_INFINITY;
			let everAccepted = false;

			// Physics window (both fixed and physics)
			let physWin: DriverWindowState = {
				mode: "physics",
				kind: "codex-app-server",
				hardMax: 8,
				window: 2,
				consecutiveSuccesses: 0,
			};
			let fixedWin: DriverWindowState = {
				mode: "fixed",
				kind: "gemini-acp",
				fixedLimit: 3,
			};

			for (let step = 0; step < 50; step++) {
				now += 50;

				// 1. Finding invariants
				const fRoll = rand();
				if (fRoll < 0.25) {
					finding = transitionFinding(finding, {
						type: "new_submission",
						claim: `c-${step}`,
						summary: `s-${step}`,
						level: "empirical",
						score: rand(),
						submission: {
							revision: finding.submissions.length + 1,
							claim: `c-${step}`,
							summary: `s-${step}`,
							evidence: [],
							level: "empirical",
							checks: [],
							at: now,
							snapshotNote: `snap-${step}`,
						},
						now,
					});
				} else if (fRoll < 0.55) {
					finding = transitionFinding(finding, {
						type: "verdict",
						round: {
							round: finding.rounds.length + 1,
							revision: finding.submissions.length,
							reviewerAgentId: "rev",
							verdict: pick(rand, ["accepted", "needs_work", "rejected"] as const),
							confidence: rand(),
							message: "n",
							checksRun: [],
							at: now,
						},
						now,
					});
				} else if (fRoll < 0.8) {
					finding = transitionFinding(finding, {
						type: "review_error",
						error: rand() < 0.5 ? "" : "timeout",
						retryAfter: rand() < 0.5 ? now + 1000 : undefined,
						now,
					});
				} else {
					finding = transitionFinding(finding, { type: "challenge_failed", now });
				}
				if (finding.status === "unreviewed") {
					expect(finding.reviewError.trim().length).toBeGreaterThan(0);
				} else {
					expect("reviewError" in finding).toBe(false);
					expect("retryAfter" in finding).toBe(false);
				}

				// 2. Board supersede & promote invariants
				if (rand() < 0.5) {
					const repId = rand() < 0.2 ? post.id : `p-rep-${step}`;
					const sOut = transitionSupersedePost(post, repId);
					if (repId === post.id) {
						expect(sOut.ok).toBe(false);
						if (!sOut.ok) expect(sOut.reason).toBe("self_supersede");
					} else if (post.supersededBy) {
						expect(sOut.ok).toBe(false);
						if (!sOut.ok) expect(sOut.reason).toBe("already_superseded");
					} else {
						expect(sOut.ok).toBe(true);
						if (sOut.ok) post = sOut.updated;
					}
				} else {
					const pOut = transitionPromotePost(post, { labels: { "os:novelty": "0.9" } });
					if (post.supersededBy) {
						expect(pOut.ok).toBe(false);
						if (!pOut.ok) expect(pOut.reason).toBe("already_superseded");
					} else if (post.visibility === "global" && post.labels?.["os:promoted"] === "true") {
						expect(pOut.ok).toBe(false);
						if (!pOut.ok) expect(pOut.reason).toBe("already_promoted");
					} else {
						expect(pOut.ok).toBe(true);
						if (pOut.ok) {
							post = pOut.updated;
							expect(post.visibility).toBe("global");
							expect(post.labels?.["os:promoted"]).toBe("true");
						}
					}
				}

				// 3. SlotPermit runningDelta conservation
				const pEv = pick<SlotPermitEvent>(rand, ["park", "unpark", "release"]);
				const prevPermit = permitState;
				const pTr = transitionSlotPermit(permitState, pEv);
				permitState = pTr.next;
				runningCount += pTr.runningDelta;
				if (prevPermit === "released") {
					expect(permitState).toBe("released");
					expect(pTr.runningDelta).toBe(0);
				}
				expect(runningCount).toBe(permitState === "held" ? 1 : 0);

				// 4. TrunkRatchet monotonicity
				const score = Math.round(rand() * 100) / 100;
				const advStatus = pick(rand, ["accepted", "needs_work", "pending_review"] as const);
				const advFinding: Finding =
					advStatus === "pending_review"
						? {
								id: finding.id,
								runId: finding.runId,
								authorAgentId: finding.authorAgentId,
								claim: finding.claim,
								summary: finding.summary,
								evidence: finding.evidence,
								buildsOn: finding.buildsOn,
								level: finding.level,
								submissions: finding.submissions,
								rounds: finding.rounds,
								createdAt: finding.createdAt,
								updatedAt: now,
								status: "pending_review",
								score,
							}
						: {
								id: finding.id,
								runId: finding.runId,
								authorAgentId: finding.authorAgentId,
								claim: finding.claim,
								summary: finding.summary,
								evidence: finding.evidence,
								buildsOn: finding.buildsOn,
								level: finding.level,
								submissions: finding.submissions,
								rounds: finding.rounds,
								createdAt: finding.createdAt,
								updatedAt: now,
								status: advStatus,
								score,
							};
				ratchet = transitionTrunkRatchet(ratchet, { sha: `sha-${step}`, finding: advFinding });
				if (advFinding.status === "accepted") everAccepted = true;
				if (everAccepted) {
					expect(ratchet.phase).toBe("accepted");
				}
				if (ratchet.phase !== "base" && typeof ratchet.score === "number") {
					expect(ratchet.score).toBeGreaterThanOrEqual(maxScoreSeen);
					maxScoreSeen = Math.max(maxScoreSeen, ratchet.score);
				}

				// 5. Physics window AIMD bounds & fixed immutability
				const wEv =
					rand() < 0.7
						? ({ type: "success", scaleUpAfter: 2, hostHasHeadroom: rand() < 0.7 } as const)
						: ({ type: "rate_limit" } as const);
				const prevWindow = physWin.mode === "physics" ? physWin.window : 0;
				const pwOut = transitionDriverWindow(physWin, wEv);
				physWin = pwOut.next;
				expect(physWin.mode).toBe("physics");
				if (physWin.mode === "physics") {
					expect(physWin.window).toBeGreaterThanOrEqual(1);
					expect(physWin.window).toBeLessThanOrEqual(8);
					if (wEv.type === "success" && !wEv.hostHasHeadroom) {
						expect(physWin.window).toBeLessThanOrEqual(prevWindow);
					}
					if (wEv.type === "rate_limit") {
						expect(physWin.window).toBe(Math.max(1, Math.floor(prevWindow / 2)));
						expect(physWin.consecutiveSuccesses).toBe(0);
					}
				}
				const fwOut = transitionDriverWindow(fixedWin, wEv);
				fixedWin = fwOut.next;
				expect(fwOut.changed).toBe(false);
				expect(fwOut.nextWindow).toBe(3);
			}
		}
	});

	it("fuzzes async PermitActor under concurrent acquire/pacing/release/cancel with zero leaks and zero over-allocation", async () => {
		const rand = mulberry32(777);
		for (const limit of [1, 2, 4]) {
			const actor = new PermitActor(limit, async () => {
				if (rand() < 0.35) {
					await new Promise((r) => setTimeout(r, 1));
				}
			});
			let activeHeld = 0;
			let maxObservedHeld = 0;

			const tasks = Array.from({ length: 45 }, async (_, idx) => {
				const ac = new AbortController();
				// 15% of queued callers abort mid-wait to test cancellation safety
				if (rand() < 0.15 && idx > limit) {
					setTimeout(() => ac.abort(), Math.floor(rand() * 4));
				}
				let release: () => void;
				try {
					release = await actor.acquire(ac.signal);
				} catch {
					return;
				}
				activeHeld++;
				maxObservedHeld = Math.max(maxObservedHeld, activeHeld);
				expect(activeHeld).toBeLessThanOrEqual(limit);
				expect(actor.running).toBeLessThanOrEqual(limit);

				await new Promise((r) => setTimeout(r, Math.floor(rand() * 3)));
				activeHeld--;
				release();
				// Deliberate double-release must be an idempotent no-op!
				release();
			});

			await Promise.all(tasks);
			expect(activeHeld).toBe(0);
			expect(actor.running).toBe(0);
			expect(actor.free).toBe(limit);
			expect(maxObservedHeld).toBeLessThanOrEqual(limit);
			// Verify all permits were returned cleanly by acquiring `limit` permits
			const verifyReleases = await Promise.all(Array.from({ length: limit }, () => actor.acquire()));
			expect(verifyReleases.length).toBe(limit);
			expect(actor.running).toBe(limit);
			for (const rel of verifyReleases) rel();
			expect(actor.running).toBe(0);
			expect(actor.free).toBe(limit);
		}
	});
});
