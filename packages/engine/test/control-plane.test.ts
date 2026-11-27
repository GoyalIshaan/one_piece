import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	clampRooflineBoundEmpirically,
	EventBus,
	MemoryStore,
	Redactor,
	type RunControlCommandRecord,
	type RunControlState,
	type TopologyPlugin,
	transitionRunControl,
	type WorkerDriver,
	type WorkerSession,
	type WorkerSpawnSpec,
} from "@one-piece/core";
import { startDashboard } from "@one-piece/dashboard";
import { DriverQuotaRouter } from "@one-piece/drivers";
import { SqliteStore } from "@one-piece/store";
import {
	evaluateResearcherCheckpoint,
	parseBoundJson,
	refineRooflineBound,
	SwarmOS,
	writeResearcherBrief,
} from "../src/index.ts";

function initTempGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "onepiece-v4-ctrl-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@onepiece.dev"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "OnePieceTest"], { cwd: dir });
	writeFileSync(join(dir, "score.txt"), "0.10\n");
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
	return dir;
}

function makeSimpleDriver(onTurn?: (spec: WorkerSpawnSpec, prompt: string) => Promise<string>): WorkerDriver {
	return {
		id: "ctrl-driver",
		kind: "pi-in-process",
		capabilities: { supportsSteer: true, supportsResume: true, supportsOutputSchema: true, supportsMcpHttp: false },
		async healthCheck() {
			return { ok: true, driverId: "ctrl-driver", kind: "pi-in-process" };
		},
		async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
			return {
				driverId: "ctrl-driver",
				async runTurn(prompt: string) {
					const text = onTurn ? await onTurn(spec, prompt) : "ok";
					return { status: "completed", finalText: text, usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } };
				},
				async close() {},
			};
		},
	};
}

describe("2-Tier Roofline Limit Ladder & External Research/Eval Control Plane", () => {
	it("parses both 2-tier Roofline JSON and legacy single-ceiling JSON, clamps empirically, and separates Tier-2 paradigm shift from Tier-1 stopping", async () => {
		const roofline = parseBoundJson(
			JSON.stringify({
				metric_name: "throughput_ops_s",
				higher_is_better: true,
				hard_ceiling: 1000,
				is_proven_hard: true,
				paradigm_ceiling: 500,
				active_bottleneck: "Scalar Python inner loop",
				breakable_assumptions: [
					{
						id: "A1",
						assumption: "Single-threaded Python loop",
						unlock_hint: "Vectorized SIMD C extension",
						tier: "paradigm",
					},
				],
				paradigm_shift_fraction: 0.9,
				stopping_fraction: 0.96,
				confidence: 0.85,
				derivation_summary: "Memory BW caps hard ceiling at 1000; current Python loop caps paradigm at 500.",
				key_assumptions: ["FP32 data fits in L2"],
			}),
			1,
		);
		expect(roofline).toBeDefined();
		expect(roofline!.hardCeiling).toBe(1000);
		expect(roofline!.paradigmCeiling).toBe(500);
		expect(roofline!.breakableAssumptions).toHaveLength(1);

		// Legacy backward-compatible single-ceiling JSON
		const legacy = parseBoundJson(
			JSON.stringify({
				metric_name: "score",
				higher_is_better: true,
				estimated_ceiling: 10.0,
				stopping_fraction: 0.92,
				confidence: 0.8,
				derivation_summary: "Legacy format",
				key_assumptions: ["a1"],
			}),
			1,
		);
		expect(legacy).toBeDefined();
		expect(legacy!.hardCeiling).toBe(10.0);
		expect(legacy!.paradigmCeiling).toBe(10.0);

		// Empirical clamping when a worker breaks Tier-2 paradigm ceiling (620 > 500) opens paradigmCeiling -> null
		const clamped = clampRooflineBoundEmpirically(roofline!, 620);
		expect(clamped.paradigmBroken).toBe(true);
		expect(clamped.hardBroken).toBe(false);
		expect(clamped.next.paradigmCeiling).toBeNull();
		expect(clamped.next.hardCeiling).toBe(1000);

		// Tier-2 saturated (470 / 500 = 0.94 >= 0.90) while Tier-1 has huge headroom (1000) -> paradigm_shift!
		const store = new MemoryStore();
		const bus = new EventBus(store, new Redactor());
		const repo = initTempGitRepo();
		const runDir = mkdtempSync(join(tmpdir(), "onepiece-v4-cp-eval-"));
		try {
			const router = new DriverQuotaRouter({
				drivers: [{ driver: makeSimpleDriver(), config: { id: "ctrl-driver", kind: "pi-in-process", maxConcurrent: 2 } }],
				roles: { default: ["ctrl-driver"] },
			});
			const os = await SwarmOS.create({
				runId: "run-cp-1",
				runDir,
				workspace: repo,
				topology: "evolution",
				controlMode: "eval",
				goal: { title: "Opt", text: "Maximize throughput" },
				store,
				router,
			});
			try {
				const shiftOut = await evaluateResearcherCheckpoint(os, {
					goal: "Maximize throughput",
					bound: roofline!,
					bestScore: 470,
					generation: 1,
					scoreHistory: [300, 470],
					distinctBasins: 2,
					controlMode: "eval",
				});
				expect(shiftOut.action).toBe("paradigm_shift");
				if (shiftOut.action === "paradigm_shift") {
					expect(shiftOut.targetAssumption.assumption).toContain("Single-threaded");
				}
				expect(store.events("run-cp-1", { types: ["bound.paradigm_shift"] }).length).toBe(1);

				// In "eval" mode, paradigm exhaustion below hard ceiling emits non-blocking advisory_interrupt and NEVER blocks/pauses
				const advisoryOut = await evaluateResearcherCheckpoint(os, {
					goal: "Maximize throughput",
					bound: { ...roofline!, breakableAssumptions: [], paradigmCeiling: 650 },
					bestScore: 600,
					generation: 3,
					scoreHistory: [600, 600, 600],
					distinctBasins: 2,
					controlMode: "eval",
				});
				expect(advisoryOut.action).toBe("continue");
				const cpEvents = store.events("run-cp-1", { types: ["researcher.checkpoint"] });
				expect(cpEvents.some((e) => e.data.action === "advisory_interrupt")).toBe(true);

				// Approaching proven-hard Tier-1 ceiling (970 / 1000 = 0.97 >= 0.96) -> coalesce even in eval mode!
				const hardStop = await evaluateResearcherCheckpoint(os, {
					goal: "Maximize throughput",
					bound: roofline!,
					bestScore: 970,
					generation: 4,
					scoreHistory: [600, 970],
					distinctBasins: 2,
					controlMode: "eval",
				});
				expect(hardStop.action).toBe("coalesce");

				// Mid-run refineRooflineBound marks older #swarm post outdated via Board v3!
				const initialPost = os.board.publish({
					runId: "run-cp-1",
					authorAgentId: "bound-analyst",
					channel: "swarm",
					topic: "first-principles-bound",
					kind: "bound_estimate",
					summary: "Initial Roofline v1",
					body: "Hard=1000, Paradigm=500",
					isOsActor: true,
				});
				const refined = await refineRooflineBound(os, {
					bound: { ...roofline!, boardPostId: initialPost.id },
					bestScore: 650,
					goal: "Maximize throughput",
					allowLlmRefinement: false,
					signal: new AbortController().signal,
				});
				expect(refined.refined).toBe(true);
				expect(refined.paradigmBroken).toBe(true);
				expect(store.get("posts", initialPost.id)?.outdated).toBe(true);
				expect(refined.bound.boardPostId).toBeTruthy();
				expect(refined.bound.boardPostId).not.toBe(initialPost.id);
			} finally {
				await os.dispose();
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(runDir, { recursive: true, force: true });
			void bus;
		}
	});

	it("enforces transitionRunControl state machine invariants (eval unpausable, coalescing absorbing)", () => {
		const running: RunControlState = { status: "running", totalPausedMs: 0 };

		// Eval mode rejects pause!
		const evalPause = transitionRunControl(running, { type: "pause", reason: "check" }, { mode: "eval", now: 1000 });
		expect(evalPause.accepted).toBe(false);
		expect(evalPause.next.status).toBe("running");

		// Research mode pauses, resumes accumulating pausedMs, then coalesces as terminal absorbing state
		const resPause = transitionRunControl(running, { type: "pause", reason: "inspect" }, { mode: "research", now: 1000 });
		expect(resPause.accepted).toBe(true);
		expect(resPause.next.status).toBe("paused");

		const resResume = transitionRunControl(
			resPause.next,
			{ type: "resume", steeringNote: "focus on FFT" },
			{ mode: "research", now: 2500 },
		);
		expect(resResume.accepted).toBe(true);
		expect(resResume.next.status).toBe("running");
		expect(resResume.next.totalPausedMs).toBe(1500);
		if (resResume.accepted) expect(resResume.steeringNote).toBe("focus on FFT");

		const resCoalesce = transitionRunControl(resResume.next, { type: "coalesce", reason: "good enough" }, { mode: "research", now: 3000 });
		expect(resCoalesce.accepted).toBe(true);
		expect(resCoalesce.next.status).toBe("coalescing");

		// Coalescing is strictly absorbing — resume/pause/steer cannot resurrect it!
		const resurrect = transitionRunControl(resCoalesce.next, { type: "resume" }, { mode: "research", now: 4000 });
		expect(resurrect.accepted).toBe(false);
		expect(resurrect.next.status).toBe("coalescing");
	});

	it("pauses cleanly in research mode via cross-process SQLite WAL, freezes wallSeconds timer while paused, delivers steering + bound override, writes Lab Brief & best-so-far.json, and coalesces gracefully", async () => {
		const repo = initTempGitRepo();
		const runDir = mkdtempSync(join(tmpdir(), "onepiece-v4-ctrl-live-"));
		const dbPath = join(runDir, "swarm.sqlite");
		const store = new SqliteStore(dbPath);
		// Second independent SQLite connection simulates external `one-piece pause/steer/bound/resume` CLI!
		const cliStore = new SqliteStore(dbPath);

		try {
			const router = new DriverQuotaRouter({
				drivers: [{ driver: makeSimpleDriver(), config: { id: "ctrl-driver", kind: "pi-in-process", maxConcurrent: 2 } }],
				roles: { default: ["ctrl-driver"] },
			});
			const os = await SwarmOS.create({
				runId: "run-live-ctrl",
				runDir,
				workspace: repo,
				topology: "custom-ctrl",
				controlMode: "research",
				budget: { wallSeconds: 2 },
				goal: { title: "Live Control Test", text: "Pause, steer, update bound, and coalesce cleanly" },
				verifier: {
					name: "score-file",
					version: "1.0.0",
					scopes: ["deliverable"],
					defaultScope: "deliverable",
					async check({ workspace }) {
						const v = Number(readFileSync(join(workspace, "score.txt"), "utf8").trim());
						return { status: v >= 0.9 ? "passed" : "failed", score: v, message: `v=${v}` };
					},
				},
				store,
				router,
			});

			let observedSteer = "";
			let observedBoundHard: number | null | undefined;
			let pausedWallMsDelta = 0;

			const enqueueExternal = (payload: RunControlCommandRecord["payload"], suffix: string) => {
				cliStore.put("control_commands", {
					id: `ctl-ext-${suffix}`,
					runId: "run-live-ctrl",
					issuedBy: "cli",
					createdAt: Date.now(),
					payload,
				});
			};

			const topo: TopologyPlugin = {
				name: "custom-ctrl",
				description: "Control plane live test topology",
				async run(api, { signal }) {
					// 1. Write an initial verified finding -> updates best-so-far.json atomically
					const w = await api.spawnWorker({ role: "worker", handle: "w-ctrl", toolScope: { board: "read-write" } });
					writeFileSync(join(w.workspace, "score.txt"), "0.95\n");
					await api.trust.submitFinding(
						{
							agentId: w.agent.id,
							workspace: w.workspace,
							claim: "Initial score 0.95",
							summary: "Score updated to 0.95",
							level: "empirical",
							score: 0.95,
						},
						signal,
					);
					await w.close();

					// Write a Lab Brief under <runDir>/checkpoints/
					const briefPath = writeResearcherBrief(api.runDir, {
						runId: api.runId,
						generation: 1,
						trigger: "diminishing_returns",
						bestScore: 0.95,
						distinctBasins: 2,
						summary: "plateau_checkpoint reached at 0.95",
					});
					expect(existsSync(briefPath)).toBe(true);
					expect(readFileSync(briefPath, "utf8")).toContain("plateau_checkpoint");

					// 2. External CLI writes PAUSE into SQLite WAL
					enqueueExternal({ type: "pause", reason: "cli review" }, "1");

					// Schedule external steer + update_bound + resume after 220ms while paused!
					const pauseStart = Date.now();
					setTimeout(() => {
						enqueueExternal({ type: "steer", message: "Try cache blocking next", scope: "both" }, "2");
						enqueueExternal({ type: "update_bound", override: { hardCeiling: 2.0 }, reason: "recalibrated" }, "3");
						enqueueExternal({ type: "resume", steeringNote: "Resumed from CLI" }, "4");
					}, 220);

					const gate = await api.waitIfPaused!(signal);
					pausedWallMsDelta = Date.now() - pauseStart;
					expect(gate).toBe("running");

					const polled = api.pollControl!();
					observedSteer = api.activeSteeringNotes!().join(" | ");
					observedBoundHard = polled.boundOverride?.hardCeiling;

					// 3. Request coalesce -> aborts workAbort cleanly while closeout nominates best finding!
					api.requestCoalesce!("researcher satisfied");
					expect(signal.aborted).toBe(true);
					return { status: "stopped", summary: "Coalesced gracefully via control plane" };
				},
			};

			try {
				const out = await os.execute(topo);
				expect(out.nominatedFindingId).toBeTruthy();
				expect(pausedWallMsDelta).toBeGreaterThanOrEqual(180);
				expect(observedSteer).toContain("Try cache blocking next");
				expect(observedSteer).toContain("Resumed from CLI");
				expect(observedBoundHard).toBe(2.0);

				// best-so-far.json written atomically!
				const bestJsonPath = join(runDir, "best-so-far.json");
				expect(existsSync(bestJsonPath)).toBe(true);
				const bestPointer = JSON.parse(readFileSync(bestJsonPath, "utf8")) as { score: number; accepted: boolean };
				expect(bestPointer.score).toBe(0.95);
				expect(bestPointer.accepted).toBe(true);

				// run.paused + run.resumed events recorded with frozen pausedMs!
				expect(store.events("run-live-ctrl", { types: ["run.paused"] }).length).toBe(1);
				const resumedEv = store.events("run-live-ctrl", { types: ["run.resumed"] })[0];
				expect(resumedEv).toBeDefined();
				expect(Number(resumedEv!.data.pausedMs)).toBeGreaterThanOrEqual(150);

				// All external control commands were acknowledged in SQLite!
				const acked = store.list("control_commands", { runId: "run-live-ctrl" });
				expect(acked.length).toBeGreaterThanOrEqual(4);
				expect(acked.every((c) => c.acknowledgedAt !== undefined)).toBe(true);
			} finally {
				await os.dispose();
			}
		} finally {
			cliStore.close();
			store.close();
			rmSync(repo, { recursive: true, force: true });
			rmSync(runDir, { recursive: true, force: true });
		}
	});

	it("serves POST /api/runs/:id/control and GET /api/runs/:id/briefs over local Dashboard HTTP", async () => {
		const runDir = mkdtempSync(join(tmpdir(), "onepiece-v4-dash-ctrl-"));
		const store = new SqliteStore(join(runDir, "swarm.sqlite"));
		const dashboard = await startDashboard(store, { port: 0 });
		try {
			store.put("runs", {
				id: "run-dash-1",
				status: "running",
				topology: "evolution",
				goal: { title: "Dash Test", text: "Test control endpoints" },
				config: { runDir },
				budget: { wallSeconds: 60 },
				spent: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			writeResearcherBrief(runDir, {
				runId: "run-dash-1",
				generation: 2,
				trigger: "paradigm_exhausted",
				bestScore: 0.88,
				distinctBasins: 3,
				summary: "Need researcher review",
			});

			const postRes = await fetch(`${dashboard.url}/api/runs/run-dash-1/control`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: "steer", message: "Try SIMD", scope: "both" }),
			});
			expect(postRes.status).toBe(202);

			const briefsRes = await fetch(`${dashboard.url}/api/runs/run-dash-1/briefs`);
			const briefsBody = (await briefsRes.json()) as { briefs: Array<{ name: string; markdown: string }> };
			expect(briefsBody.briefs.length).toBe(1);
			expect(briefsBody.briefs[0]!.markdown).toContain("paradigm_exhausted");

			const detailRes = await fetch(`${dashboard.url}/api/runs/run-dash-1`);
			const detail = (await detailRes.json()) as { controlCommands: RunControlCommandRecord[] };
			expect(detail.controlCommands.length).toBe(1);
		} finally {
			await dashboard.close();
			store.close();
			rmSync(runDir, { recursive: true, force: true });
		}
	});
});
