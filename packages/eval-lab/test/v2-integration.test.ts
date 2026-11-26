import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
	DriverCapabilities,
	WorkerDriver,
	WorkerSession,
	WorkerSpawnSpec,
	WorkerTurnResult,
} from "@one-piece/core";
import { DriverQuotaRouter } from "@one-piece/drivers";
import type { HarnessRunReceipt } from "../src/contracts.ts";
import { createV2Adapter } from "../src/adapters/v2.ts";
import { runCampaign } from "../src/runner.ts";
import { miniCoopInterpTask } from "../src/tasks/mini-coop-interp/index.ts";
import { miniOptPackTask } from "../src/tasks/mini-opt-pack/index.ts";
import { siloJoinMicroTask } from "../src/tasks/silo-join-micro/index.ts";
import { SwarmOS, substratePeersTopology } from "@one-piece/engine";
import { SqliteStore } from "@one-piece/store";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Deterministic v2 WorkerDriver that exercises the real SwarmOS, git worktrees, TrustLayer, and CloseoutController. */
class ScriptedV2Driver implements WorkerDriver {
	readonly id: string;
	readonly kind = "codex-exec" as const;
	readonly capabilities: DriverCapabilities = {
		supportsSteer: false,
		supportsResume: true,
		supportsOutputSchema: true,
		supportsMcpHttp: true,
	};
	private readonly handler: (spec: WorkerSpawnSpec, prompt: string) => Promise<WorkerTurnResult>;

	constructor(id: string, handler: (spec: WorkerSpawnSpec, prompt: string) => Promise<WorkerTurnResult>) {
		this.id = id;
		this.handler = handler;
	}

	async healthCheck() {
		return { ok: true, driverId: this.id, kind: this.kind, version: "scripted-v2" };
	}

	async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
		const id = this.id;
		const handler = this.handler;
		return {
			driverId: id,
			sessionId: `${id}-${spec.agentId}`,
			async runTurn(prompt) {
				return handler(spec, prompt);
			},
			async close() {},
		};
	}
}

describe("eval-lab <-> one_piece v2 SwarmOS end-to-end integration", () => {
	it("runs real SwarmOS topologies (single, pull-refinery, substrate-peers) through V2Adapter and extracts full scorecards", async () => {
		const root = mkdtempSync(join(tmpdir(), "eval-v2-e2e-"));
		try {
			// Precompute a valid improved circle-packing reference once so scripted workers can apply it
			const refDir = join(root, "pack-ref");
			const tmpHidden = join(root, "pack-hidden");
			const prepRef = await miniOptPackTask.prepare({
				seed: 1,
				n: 2,
				options: {},
				workDir: refDir,
				hiddenDir: tmpHidden,
			});
			await miniOptPackTask.buildReferenceArtifact!({ prepared: prepRef, outDir: refDir });
			const improvedCircles = readFileSync(join(refDir, "circles.json"), "utf8");

			// Scripted driver:
			// - Emits full v2 activity telemetry (session+model, local CLI tool_call/tool_result, token splits)
			// - For `single` and `silent_bon`: leaves starter unchanged (scores incumbent 2.6219, fails improvement bar)
			// - For `substrate-peers` and `pull-refinery`: applies improved packing
			let firstPeerRateLimited = false;
			const driver = new ScriptedV2Driver("v2-sim", async (spec) => {
				spec.onActivity?.({ type: "session", sessionId: `sess-${spec.agentId}`, model: "v2-sim-model" });
				if (spec.role === "planner") {
					return {
						status: "completed",
						model: "v2-sim-model",
						finalText: JSON.stringify({
							tasks: [
								{ key: "opt-1", title: "Relax packing", description: "Improve circles.json", depends_on: [] },
								{ key: "opt-2", title: "Verify packing", description: "Check circles.json", depends_on: ["opt-1"] },
							],
						}),
						usage: {
							inputTokens: 200,
							cachedTokens: 40,
							outputTokens: 80,
							reasoningTokens: 20,
							totalTokens: 280,
							usd: 0.001,
							durationMs: 12,
						},
					};
				}

				const isSwarmRun = spec.runId.includes("peers") || spec.runId.includes("refinery");
				if (isSwarmRun && !firstPeerRateLimited && spec.runId.includes("peers")) {
					firstPeerRateLimited = true;
					return {
						status: "rate_limited",
						model: "v2-sim-model",
						finalText: "",
						usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60, usd: 0.0002, durationMs: 5 },
						quotaError: { kind: "transient_rpm", retryAfterMs: 15, raw: "429 Too Many Requests" },
						error: "429 Too Many Requests",
					};
				}

				spec.onActivity?.({ type: "tool_call", name: "bash", argsPreview: "python3 verify.py circles.json", isMcp: false });
				if (isSwarmRun) {
					cpSync(join(refDir, "circles.json"), join(spec.workspace, "circles.json"));
					expect(readFileSync(join(spec.workspace, "circles.json"), "utf8")).toBe(improvedCircles);
				}
				spec.onActivity?.({
					type: "tool_result",
					name: "bash",
					isError: false,
					outputPreview: "Feasible sum=2.627099",
					durationMs: 8,
					isMcp: false,
				});

				return {
					status: "completed",
					model: "v2-sim-model",
					finalText: isSwarmRun ? "Improved circles.json packing" : "Checked incumbent",
					usage: {
						inputTokens: 300,
						cachedTokens: 100,
						outputTokens: 100,
						reasoningTokens: 25,
						totalTokens: 400,
						usd: 0.0015,
						durationMs: 15,
					},
				};
			});

			const router = new DriverQuotaRouter({
				drivers: [{ driver, config: { id: "v2-sim", kind: "codex-exec", maxConcurrent: 4 } }],
				roles: { default: ["v2-sim"], worker: ["v2-sim"], planner: ["v2-sim"], refinery: ["v2-sim"] },
			});

			const v2Adapter = createV2Adapter({ router, task: miniOptPackTask });
			const outDir = join(root, "campaign-v2");
			const result = await runCampaign({
				task: miniOptPackTask,
				adapter: v2Adapter,
				arms: [
					{ id: "solo-n1", controlRung: "solo", topology: "single", swarmSize: 1 },
					{ id: "silent-n2", controlRung: "silent_bon", topology: "silent_bon", swarmSize: 2 },
					{ id: "peers-n2", controlRung: "swarm", topology: "substrate-peers", swarmSize: 2 },
					{ id: "refinery-n2", controlRung: "swarm", topology: "pull-refinery", swarmSize: 2 },
				],
				seeds: [1, 2],
				budget: { tokens: 80_000 },
				outDir,
				repoRoot: REPO_ROOT,
				candidateArmId: "peers-n2",
			});

			expect(result.scorecards).toHaveLength(8);

			const soloCards = result.scorecards.filter((c) => c.reproducibility.controlRung === "solo");
			const silentCards = result.scorecards.filter((c) => c.reproducibility.controlRung === "silent_bon");
			const peerCards = result.scorecards.filter((c) => c.reproducibility.topology === "substrate-peers");
			const refineryCards = result.scorecards.filter((c) => c.reproducibility.topology === "pull-refinery");

			for (const c of soloCards) {
				expect(c.harnessFaults).toEqual([]);
				expect(c.hasHarnessFault).toBe(false);
				expect(c.deliveredPass).toBe(false);
				expect(c.tokens.total).toBeGreaterThan(0);
			}
			for (const c of silentCards) {
				expect(c.harnessFaults).toEqual([]);
				expect(c.hasHarnessFault).toBe(false);
				expect(c.deliveredPass).toBe(false);
				expect(c.tokens.total).toBeGreaterThan(0);
			}
			for (const c of [...peerCards, ...refineryCards]) {
				expect(c.harnessFaults).toEqual([]);
				expect(c.hasHarnessFault).toBe(false);
				expect(c.deliveredPass).toBe(true);
				expect(c.deliveredScore).toBeGreaterThan(2.627);
				expect(c.losses.nominationLoss).toBe(0);
				expect(c.losses.stoppingWasteShare).toBeLessThan(1);
				expect(c.tokens.total).toBeGreaterThan(0);
				expect(c.tokens.input).toBeGreaterThan(0);
				expect(c.tokens.output).toBeGreaterThan(0);
				expect(c.tokens.cacheRead).toBeGreaterThan(0);
				expect(c.tokens.reasoning).toBeGreaterThan(0);
				expect(c.tokens.peakInputPerCall).toBeGreaterThan(0);
				expect(c.tokens.peakInputPerCall).toBeLessThanOrEqual(c.tokens.total);
				expect(c.dynamics.peakParallelism).toBeGreaterThanOrEqual(2);
				expect(c.dynamics.toolCalls).toBeGreaterThan(0);
				expect(c.dynamics.toolCallsByName.bash).toBeGreaterThan(0);
				expect(c.reproducibility.modelIds).toContain("v2-sim-model");
				expect(c.anytimeFrontier.length).toBeGreaterThanOrEqual(1);

				// Verify durable redacted worker transcripts exist on disk
				const tDir = join(outDir, "runs", c.runId, "run", "transcripts");
				expect(existsSync(tDir)).toBe(true);
				const files = readdirSync(tDir).filter((f) => f.endsWith(".jsonl"));
				expect(files.length).toBeGreaterThanOrEqual(2);
				const firstEntry = JSON.parse(readFileSync(join(tDir, files[0]!), "utf8").trim().split("\n")[0]!) as {
					prompt: string;
					finalText: string;
					model?: string;
					tools: unknown[];
				};
				expect(firstEntry.prompt.length).toBeGreaterThan(10);
				expect(firstEntry.model).toBe("v2-sim-model");
			}

			// Verify transient_rpm retry telemetry was recorded on the first peer run
			expect(peerCards.some((c) => c.time.quotaWaitMs >= 15 && c.dynamics.modelErrors >= 1)).toBe(true);

			// Verify Coordination Lift vs silent_bon is strictly positive in campaign summary
			const summary = JSON.parse(readFileSync(result.summaryPath, "utf8")) as {
				coordinationLift?: { communicationLift?: { passRateGain: number; scoreGain: { mean: number } } };
			};
			expect(summary.coordinationLift?.communicationLift).toBeDefined();
			expect(summary.coordinationLift!.communicationLift!.passRateGain).toBe(1);
			expect(summary.coordinationLift!.communicationLift!.scoreGain.mean).toBeGreaterThan(0.005);

			// Verify silent_bon never touches task.grade() during candidate selection (publicCheck only)
			let gradeCalls = 0;
			let publicCalls = 0;
			const spyTask = {
				...miniOptPackTask,
				async publicCheck(args: Parameters<NonNullable<typeof miniOptPackTask.publicCheck>>[0]) {
					publicCalls++;
					return miniOptPackTask.publicCheck!(args);
				},
				async grade(args: Parameters<typeof miniOptPackTask.grade>[0]) {
					gradeCalls++;
					return miniOptPackTask.grade(args);
				},
			};
			const spyRes = await runCampaign({
				task: spyTask,
				adapter: createV2Adapter({ router, task: spyTask }),
				arms: [{ id: "silent-spy", controlRung: "silent_bon", topology: "silent_bon", swarmSize: 2 }],
				seeds: [1],
				budget: { tokens: 20_000 },
				outDir: join(root, "campaign-spy"),
				repoRoot: REPO_ROOT,
			});
			expect(spyRes.scorecards[0]?.hasHarnessFault).toBe(false);
			expect(publicCalls).toBeGreaterThanOrEqual(2); // 2 workers checked via publicCheck (plus TrustLayer)
			// Only offline scorecard extraction calls grade() (1 nominated + 2 candidate snapshots = 3), never during selection
			expect(gradeCalls).toBeLessThanOrEqual(4);

			// Verify publicCheck works cleanly without touching hiddenDir on mini-coop-interp
			const interpDir = join(root, "interp-pub");
			const interpHidden = join(root, "interp-hidden");
			const interpPrep = await miniCoopInterpTask.prepare({
				seed: 7,
				n: 2,
				options: { coupling: "high" },
				workDir: interpDir,
				hiddenDir: interpHidden,
			});
			const pubRes = await miniCoopInterpTask.publicCheck!({
				artifactDir: interpPrep.workspaceDir,
				seed: 7,
				n: 2,
				options: { coupling: "high" },
			});
			expect(pubRes.passed).toBe(true);

			// Verify provider auth/model outage is flagged as a HarnessFault (never silently masked as 0.0)
			const outageDriver = new ScriptedV2Driver("v2-outage", async () => ({
				status: "rate_limited",
				finalText: "",
				usage: { durationMs: 5 },
				quotaError: { kind: "hard_auth_or_cap", reason: "model_not_found", raw: "model_not_found" },
				error: "model_not_found",
			}));
			const outageRouter = new DriverQuotaRouter({
				drivers: [{ driver: outageDriver, config: { id: "v2-outage", kind: "codex-exec", maxConcurrent: 2 } }],
				roles: { default: ["v2-outage"], worker: ["v2-outage"] },
			});
			const outageRes = await runCampaign({
				task: miniOptPackTask,
				adapter: createV2Adapter({ router: outageRouter, task: miniOptPackTask }),
				arms: [{ id: "solo-outage", controlRung: "solo", topology: "single", swarmSize: 1 }],
				seeds: [1],
				budget: { tokens: 20_000 },
				outDir: join(root, "campaign-outage"),
				repoRoot: REPO_ROOT,
			});
			expect(outageRes.scorecards[0]?.hasHarnessFault).toBe(true);
			expect(outageRes.scorecards[0]?.harnessFaults.some((f) => f.code === "PROVIDER_AUTH_FAILURE")).toBe(true);
			expect(outageRes.scorecards[0]?.reproducibility.dirtyDiffSha).not.toBe("unknown");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("solves silo-join-micro (N=4) via Board v2 (board_publish + board_wait) + substrate-peers disjoint trunk assembly with +1.0 communication lift", async () => {
		const root = mkdtempSync(join(tmpdir(), "eval-v2-silo-"));
		try {
			const driver = new ScriptedV2Driver("v2-silo-sim", async (spec, prompt) => {
				spec.onActivity?.({ type: "session", sessionId: `sess-${spec.agentId}`, model: "v2-silo-model" });
				const shardMatch = /Your private shard file is at:\s*(\S+)/.exec(prompt);
				const seatMatch = /You are Seat (\d+) of (\d+)/.exec(prompt);
				if (!shardMatch || !seatMatch) {
					return { status: "completed", model: "v2-silo-model", finalText: "No shard assigned", usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70, durationMs: 5 } };
				}
				const seat = Number(seatMatch[1]);
				const totalSeats = Number(seatMatch[2]);
				const shard = JSON.parse(readFileSync(shardMatch[1]!, "utf8")) as { seat: number; values: number[] };
				const subtotal = shard.values.reduce((a, b) => a + b, 0);

				const publishTool = spec.tools?.find((t) => t.name === "board_publish");
				const waitTool = spec.tools?.find((t) => t.name === "board_wait");
				const ctx = { runId: spec.runId, agentId: spec.agentId, role: spec.role, workspace: spec.workspace, signal: new AbortController().signal };

				let offset = 0;
				if (publishTool && waitTool) {
					// Swarm peer: publish subtotal and wait reactively for all N seats
					await publishTool.execute(
						{
							topic: "shard-subtotal",
							summary: `seat=${seat} subtotal=${subtotal}`,
							body: JSON.stringify({ seat, subtotal }),
							labels: { seat: String(seat) },
						},
						ctx,
					);
					const waited = await waitTool.execute(
						{ topic: "shard-subtotal", min_posts: totalSeats, timeout_seconds: 5 },
						ctx,
					);
					const matches = [...waited.text.matchAll(/\{"seat":(\d+),"subtotal":(\d+)\}/g)];
					const bySeat = new Map<number, number>();
					for (const m of matches) bySeat.set(Number(m[1]), Number(m[2]));
					for (let s = 0; s < seat; s++) offset += bySeat.get(s) ?? 0;
				}
				// Solo / silent_bon has no board tools, so offset stays 0 (only seat 0 can be right, and 3/4 files are missing)
				let acc = offset;
				const prefix = shard.values.map((v) => {
					acc += v;
					return acc;
				});
				mkdirSync(join(spec.workspace, "submissions"), { recursive: true });
				writeFileSync(
					join(spec.workspace, "submissions", `seat_${seat}.json`),
					JSON.stringify({ seat, prefix }, null, 2) + "\n",
				);
				return {
					status: "completed",
					model: "v2-silo-model",
					finalText: `Wrote submissions/seat_${seat}.json`,
					usage: { inputTokens: 150, outputTokens: 60, totalTokens: 210, durationMs: 10 },
				};
			});

			const router = new DriverQuotaRouter({
				drivers: [{ driver, config: { id: "v2-silo-sim", kind: "codex-exec", maxConcurrent: 4 } }],
				roles: { default: ["v2-silo-sim"], worker: ["v2-silo-sim"] },
			});
			const adapter = createV2Adapter({ router, task: siloJoinMicroTask });
			const outDir = join(root, "campaign-silo");
			const result = await runCampaign({
				task: siloJoinMicroTask,
				adapter,
				arms: [
					{ id: "solo-n1", controlRung: "solo", topology: "single", swarmSize: 1 },
					{ id: "silent-n4", controlRung: "silent_bon", topology: "silent_bon", swarmSize: 4 },
					{ id: "peers-n4", controlRung: "swarm", topology: "substrate-peers", swarmSize: 4 },
				],
				seeds: [1],
				budget: { tokens: 80_000 },
				taskOptions: { mode: "prefix" },
				outDir,
				repoRoot: REPO_ROOT,
				candidateArmId: "peers-n4",
			});

			const solo = result.scorecards.find((c) => c.reproducibility.controlRung === "solo")!;
			const silent = result.scorecards.find((c) => c.reproducibility.controlRung === "silent_bon")!;
			const swarm = result.scorecards.find((c) => c.reproducibility.controlRung === "swarm")!;
			expect(solo.hasHarnessFault).toBe(false);
			expect(silent.hasHarnessFault).toBe(false);
			expect(swarm.hasHarnessFault).toBe(false);
			expect(solo.deliveredPass).toBe(false);
			expect(silent.deliveredPass).toBe(false);
			expect(silent.autoNominated).toBe(false);
			expect(swarm.deliveredPass).toBe(true);
			expect(swarm.deliveredScore).toBe(1);
			expect(swarm.losses.nominationLoss).toBe(0);

			// Compile-time proofs for HarnessRunReceipt nomination invariants
			// @ts-expect-error autoNominated cannot be true when no artifact was nominated
			const _badReceiptAutoWithoutArtifact: HarnessRunReceipt = {
				runId: "r1",
				status: "done",
				autoNominated: true,
				candidateSnapshots: [],
				harnessFaults: [],
			};
			// @ts-expect-error nominatedArtifactDir requires nominatedSha256
			const _badReceiptHalfNom: HarnessRunReceipt = {
				runId: "r2",
				status: "done",
				nominatedArtifactDir: "/tmp/out",
				autoNominated: false,
				candidateSnapshots: [],
				harnessFaults: [],
			};
			expect([_badReceiptAutoWithoutArtifact, _badReceiptHalfNom]).toBeDefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("invokes Option A impartial integrator fallback when substrate-peers hit a git merge conflict", async () => {
		const root = mkdtempSync(join(tmpdir(), "eval-v2-conflict-"));
		const workDir = join(root, "ws");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		writeFileSync(join(workDir, "shared.txt"), "base-line\n");
		const store = new SqliteStore(join(runDir, "trace.db"));
		try {
			const driver = new ScriptedV2Driver("v2-conflict-sim", async (spec, prompt) => {
				if (spec.role === "integrator") {
					expect(prompt).toContain("shared.txt");
					writeFileSync(join(spec.workspace, "shared.txt"), "base-line\npeer-1-feature\npeer-2-feature\n");
					return { status: "completed", finalText: "Merged both peer features cleanly", usage: { totalTokens: 100, durationMs: 5 } };
				}
				const isPeer1 = prompt.includes("peer-1");
				writeFileSync(join(spec.workspace, "shared.txt"), isPeer1 ? "peer-1-feature\n" : "peer-2-feature\n");
				return { status: "completed", finalText: `Edited shared.txt (${isPeer1 ? "peer-1" : "peer-2"})`, usage: { totalTokens: 80, durationMs: 5 } };
			});
			const router = new DriverQuotaRouter({
				drivers: [{ driver, config: { id: "v2-conflict-sim", kind: "codex-exec", maxConcurrent: 4 } }],
				roles: { default: ["v2-conflict-sim"], worker: ["v2-conflict-sim"], integrator: ["v2-conflict-sim"] },
			});
			const os = await SwarmOS.create({
				runId: "run-conflict-opt-a",
				runDir,
				workspace: workDir,
				topology: "substrate-peers",
				goal: { title: "Conflict test", text: "Add both features to shared.txt" },
				store,
				router,
			});
			try {
				const outcome = await os.execute(substratePeersTopology({ peers: 2, rounds: 1 }));
				expect(outcome.status).toBe("done");
				const trunkContent = readFileSync(join(os.worktrees.trunkPath, "shared.txt"), "utf8");
				expect(trunkContent).toContain("peer-1-feature");
				expect(trunkContent).toContain("peer-2-feature");
				const evs = store.events("run-conflict-opt-a");
				expect(evs.some((e) => e.type === "peer.conflict_detected")).toBe(true);
				expect(evs.some((e) => e.type === "peer.conflict_resolved")).toBe(true);
			} finally {
				await os.dispose();
			}
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
