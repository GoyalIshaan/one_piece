import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type DriverCapabilities,
	type FindingVerifier,
	type WorkerDriver,
	type WorkerSession,
	type WorkerSpawnSpec,
	type WorkerTurnResult,
} from "@one-piece/core";
import { DriverQuotaRouter } from "@one-piece/drivers";
import { SqliteStore } from "@one-piece/store";
import { createTopology, SwarmOS, TOPOLOGY_NAMES } from "../src/index.ts";

/** Scripted deterministic WorkerDriver for testing SwarmOS, triggers, failover, and all 5 topologies. */
class MockWorkerDriver implements WorkerDriver {
	readonly id: string;
	readonly kind = "codex-exec" as const;
	readonly capabilities: DriverCapabilities = { supportsSteer: false, supportsResume: true, supportsOutputSchema: true, supportsMcpHttp: true };
	private readonly handler: (spec: WorkerSpawnSpec, prompt: string, turn: number) => Promise<WorkerTurnResult>;

	constructor(id: string, handler: (spec: WorkerSpawnSpec, prompt: string, turn: number) => Promise<WorkerTurnResult>) {
		this.id = id;
		this.handler = handler;
	}

	async healthCheck() {
		return { ok: true as const, driverId: this.id, kind: this.kind, version: "mock-1.0" };
	}

	async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
		let turn = 0;
		const id = this.id;
		const handler = this.handler;
		return {
			driverId: id,
			sessionId: `${id}-${spec.agentId}`,
			async runTurn(prompt) {
				turn += 1;
				return handler(spec, prompt, turn);
			},
			async close() {},
		};
	}
}

describe("SwarmOS v2 core, failover, triggers, closeout, and all 5 native topologies", () => {
	it.each(TOPOLOGY_NAMES)("runs native topology '%s' end-to-end with verified auto-nomination", async (topologyName) => {
		const dir = mkdtempSync(join(tmpdir(), `op-topo-${topologyName}-`));
		try {
			const seed = join(dir, "seed");
			mkdirSync(seed, { recursive: true });
			writeFileSync(join(seed, "app.txt"), "v0\n", "utf8");

			const store = new SqliteStore(":memory:");
			const mock = new MockWorkerDriver("mock-1", async (spec, prompt) => {
				if (spec.role === "planner") {
					if (topologyName === "pull-refinery") {
						return {
							status: "completed",
							finalText: JSON.stringify({
								tasks: [
									{ key: "t1", title: "Create part 1", description: "Write part1.txt", depends_on: [] },
									{ key: "t2", title: "Create part 2", description: "Write part2.txt", depends_on: ["t1"] },
								],
							}),
							usage: { inputTokens: 100, outputTokens: 40, durationMs: 5 },
						};
					}
					return {
						status: "completed",
						finalText: JSON.stringify({
							subtasks: [
								{ title: "Subtask A", description: "Write a.txt" },
								{ title: "Subtask B", description: "Write b.txt" },
							],
						}),
						usage: { inputTokens: 100, outputTokens: 40, durationMs: 5 },
					};
				}
				const fileName = `out-${spec.agentId.slice(-4)}.txt`;
				writeFileSync(join(spec.workspace, fileName), `solved:${prompt.slice(0, 40)}\n`, "utf8");
				return { status: "completed", finalText: `Wrote ${fileName}`, usage: { inputTokens: 120, outputTokens: 30, durationMs: 5 } };
			});

			const router = new DriverQuotaRouter({
				drivers: [{ driver: mock, config: { id: "mock-1", kind: "codex-exec", maxConcurrent: 4 } }],
				roles: { default: ["mock-1"] },
			});

			const os = await SwarmOS.create({
				runDir: join(dir, "run"),
				workspace: seed,
				topology: topologyName,
				goal: { title: `Test ${topologyName}`, text: `Verify ${topologyName} topology end-to-end` },
				store,
				router,
			});

			try {
				const plugin = createTopology(topologyName, { generations: 2, populationPerGen: 2, peers: 2, rounds: 1, maxWorkers: 2, concurrency: 2 });
				const result = await os.execute(plugin);
				expect(result.status).toBe("done");
				expect(result.nominatedFindingId).toBeTruthy();
				expect(existsSync(result.reportPath)).toBe(true);
				expect(readFileSync(result.reportPath, "utf8")).toContain(result.nominatedFindingId!);
			} finally {
				await os.dispose();
				store.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("automatically fails over worktree with .swarm/HANDOFF.md when Driver A hits Class 2 quota cap", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-failover-"));
		try {
			const seed = join(dir, "seed");
			mkdirSync(seed, { recursive: true });
			writeFileSync(join(seed, "code.txt"), "start\n", "utf8");

			const store = new SqliteStore(":memory:");
			const failingDriver = new MockWorkerDriver("grok", async (spec) => {
				writeFileSync(join(spec.workspace, "wip.txt"), "partial progress from grok\n", "utf8");
				return {
					status: "rate_limited",
					finalText: "",
					quotaError: { kind: "window_exhausted", raw: "5-hour usage limit reached" },
					error: "5-hour usage limit reached",
				};
			});
			const backupDriver = new MockWorkerDriver("gemini", async (spec, prompt) => {
				expect(prompt).toContain(".swarm/HANDOFF.md");
				expect(existsSync(join(spec.workspace, ".swarm", "HANDOFF.md"))).toBe(true);
				expect(readFileSync(join(spec.workspace, "wip.txt"), "utf8")).toContain("partial progress from grok");
				writeFileSync(join(spec.workspace, "done.txt"), "finished by gemini\n", "utf8");
				return { status: "completed", finalText: "Completed after seamless handoff" };
			});

			const router = new DriverQuotaRouter({
				drivers: [
					{ driver: failingDriver, config: { id: "grok", kind: "grok-cli" } },
					{ driver: backupDriver, config: { id: "gemini", kind: "gemini-cli" } },
				],
				roles: { worker: ["grok", "gemini"] },
			});

			const os = await SwarmOS.create({
				runDir: join(dir, "run"),
				workspace: seed,
				topology: "single",
				goal: { title: "Failover test", text: "Test quota handoff" },
				store,
				router,
			});

			try {
				const worker = await os.spawnWorker({ role: "worker", preferredDriverId: "grok" });
				const res = await worker.runTurn("Implement feature X");
				expect(res.status).toBe("completed");
				expect(res.finalText).toContain("seamless handoff");
				expect(worker.agent.driverId).toBe("gemini");
				expect(router.status().find((s) => s.driverId === "grok")?.state).toBe("cooldown");
				const handoffEvents = store.events(os.runId, { types: ["agent.handoff"] });
				expect(handoffEvents).toHaveLength(1);
				await worker.close();
			} finally {
				await os.dispose();
				store.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("catches looping stalled agents mechanically and replays TrustLayer counterexamples", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-trust-"));
		try {
			const seed = join(dir, "seed");
			mkdirSync(seed, { recursive: true });
			writeFileSync(join(seed, "sol.txt"), "bad\n", "utf8");

			const store = new SqliteStore(":memory:");
			const looper = new MockWorkerDriver("mock-loop", async (spec) => {
				spec.onActivity?.({ type: "tool_call", name: "bash", argsPreview: "pytest" });
				return { status: "completed", finalText: "still trying" };
			});
			const router = new DriverQuotaRouter({
				drivers: [{ driver: looper, config: { id: "mock-loop", kind: "codex-exec" } }],
				roles: { default: ["mock-loop"] },
			});

			const verifier: FindingVerifier = {
				name: "toy-verifier",
				version: "1.0.0",
				defaultScope: "integrated",
				scopes: ["integrated"],
				async check({ workspace, challenge }) {
					const val = readFileSync(join(workspace, "sol.txt"), "utf8").trim();
					if (challenge === '{"edge":true}' && val !== "good+edge") {
						return { status: "failed", message: "failed edge counterexample", counterexample: '{"edge":true}' };
					}
					if (val === "bad") return { status: "failed", message: "wrong answer", counterexample: '{"edge":true}' };
					return { status: "passed", message: "ok" };
				},
			};

			const os = await SwarmOS.create({
				runDir: join(dir, "run"),
				workspace: seed,
				topology: "single",
				goal: { title: "Trust & Stall test", text: "Verify invariants" },
				verifier,
				maxRepeatedTurns: 3,
				store,
				router,
			});

			try {
				// 1. Stall detector catches 3 repeated identical turns
				const w = await os.spawnWorker({ role: "worker" });
				await w.runTurn("t1");
				await w.runTurn("t2");
				await w.runTurn("t3");
				expect(store.events(os.runId, { types: ["agent.stalled"] })).toHaveLength(1);

				// 2. TrustLayer records counterexample on rev 1 and replays it on rev 2!
				const f1 = await os.trust.submitFinding({ agentId: w.agent.id, workspace: w.workspace, claim: "try 1", summary: "bad", level: "exact_check" });
				expect(f1.status).toBe("needs_work");

				writeFileSync(join(w.workspace, "sol.txt"), "good-without-edge\n", "utf8");
				const f2 = await os.trust.submitFinding({ findingId: f1.id, agentId: w.agent.id, workspace: w.workspace, claim: "try 2", summary: "partial", level: "exact_check" });
				expect(f2.status).toBe("needs_work");
				expect(f2.rounds.at(-1)?.message).toContain("replayed counterexample");

				writeFileSync(join(w.workspace, "sol.txt"), "good+edge\n", "utf8");
				const f3 = await os.trust.submitFinding({ findingId: f1.id, agentId: w.agent.id, workspace: w.workspace, claim: "try 3", summary: "fixed", level: "exact_check" });
				expect(f3.status).toBe("accepted");
				await w.close();
			} finally {
				await os.dispose();
				store.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
