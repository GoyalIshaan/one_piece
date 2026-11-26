import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	DriverCapabilities,
	WorkerDriver,
	WorkerSession,
	WorkerSpawnSpec,
	WorkerTurnResult,
} from "@one-piece/core";
import { DriverQuotaRouter } from "@one-piece/drivers";
import { SqliteStore } from "@one-piece/store";
import { createTopology, SwarmOS } from "../src/index.ts";

class SpyWorkerDriver implements WorkerDriver {
	readonly id: string;
	readonly kind = "codex-exec" as const;
	readonly capabilities: DriverCapabilities = { supportsSteer: false, supportsResume: true, supportsOutputSchema: true, supportsMcpHttp: true };
	readonly spawnedSpecs: WorkerSpawnSpec[] = [];
	private readonly handler: (spec: WorkerSpawnSpec, prompt: string, turn: number) => Promise<WorkerTurnResult>;

	constructor(id: string, handler: (spec: WorkerSpawnSpec, prompt: string, turn: number) => Promise<WorkerTurnResult>) {
		this.id = id;
		this.handler = handler;
	}

	async healthCheck() {
		return { ok: true, driverId: this.id, kind: this.kind, version: "spy-1.0" };
	}

	async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
		this.spawnedSpecs.push(spec);
		let turn = 0;
		const id = this.id;
		const handler = this.handler;
		return {
			driverId: id,
			sessionId: `${id}-${this.spawnedSpecs.length}`,
			async runTurn(prompt) {
				turn += 1;
				return handler(spec, prompt, turn);
			},
			async close() {},
		};
	}
}

describe("v2 Harness Engineering: Static KV Prefixes, Scoped Tools, Skills, Code Mode, & Tier-2 Handoff", () => {
	it("gives sibling peers byte-identical static system prompts and lean scoped tool menus", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-he-prefix-"));
		try {
			const seed = join(dir, "seed");
			mkdirSync(seed, { recursive: true });
			writeFileSync(join(seed, "app.txt"), "v0\n", "utf8");

			const store = new SqliteStore(":memory:");
			const spy = new SpyWorkerDriver("spy", async (spec) => {
				writeFileSync(join(spec.workspace, `out-${spec.agentId.slice(-4)}.txt`), "ok\n", "utf8");
				// CLI drivers (codex/grok/agy) report inputTokens inclusive of cachedTokens (900 cached out of 1000 total input = 0.90)
				return { status: "completed", finalText: "done", usage: { inputTokens: 1000, cachedTokens: 900, outputTokens: 20, durationMs: 5 } };
			});
			const router = new DriverQuotaRouter({
				drivers: [{ driver: spy, config: { id: "spy", kind: "codex-exec", maxConcurrent: 4 } }],
				roles: { default: ["spy"] },
			});
			const os = await SwarmOS.create({
				runDir: join(dir, "run"),
				workspace: seed,
				topology: "substrate-peers",
				goal: { title: "Prefix test", text: "Check static prompt invariance" },
				store,
				router,
			});

			try {
				const plugin = createTopology("substrate-peers", { peers: 3, rounds: 1 });
				await os.execute(plugin);

				expect(spy.spawnedSpecs).toHaveLength(3);
				// All 3 sibling peers must receive byte-identical systemPrompt and shared cacheKeyPrefix!
				const prompts = new Set(spy.spawnedSpecs.map((s) => s.systemPrompt));
				expect(prompts.size).toBe(1);
				const cacheKeys = new Set(spy.spawnedSpecs.map((s) => s.cacheKeyPrefix));
				expect(cacheKeys.size).toBe(1);

				// Lean scoped tool menu: NO claim_task, NO complete_task, NO nominate, NO scheduler on default CPU-only config!
				const toolNames = (spy.spawnedSpecs[0]!.tools ?? []).map((t) => t.name);
				expect(toolNames).toContain("board_search");
				expect(toolNames).toContain("board_publish");
				expect(toolNames).toContain("read_artifact");
				expect(toolNames).toContain("report_finding");
				expect(toolNames).toContain("load_skill");
				expect(toolNames).not.toContain("claim_task");
				expect(toolNames).not.toContain("complete_task");
				expect(toolNames).not.toContain("nominate");
				expect(toolNames).not.toContain("submit_job");

				// Verify cacheHitRate was emitted on agent.turn events
				const turns = store.events(os.runId, { types: ["agent.turn"] });
				expect(turns.length).toBe(3);
				expect(turns[0]!.data.cacheHitRate).toBe(0.9);
			} finally {
				await os.dispose();
				store.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("injects Tier-1 static role skills, exposes sorted Tier-2 load_skill, runs offline Coordinator Code Mode, and rolls over on Tier-2 compaction handoff", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-he-full-"));
		try {
			const seed = join(dir, "seed");
			mkdirSync(seed, { recursive: true });
			writeFileSync(join(seed, "app.txt"), "v0\n", "utf8");

			const store = new SqliteStore(":memory:");
			const promptsSeen: string[] = [];
			const spy = new SpyWorkerDriver("spy", async (spec, prompt) => {
				promptsSeen.push(prompt);
				// First session requests Tier-2 compaction handoff
				if (promptsSeen.length === 1) {
					writeFileSync(join(spec.workspace, "wip.txt"), "saved before rollover\n", "utf8");
					return {
						status: "completed",
						finalText: "turn 1 done",
						needsHandoff: true,
						failedApproaches: ["naive-loop timed out"],
					};
				}
				return { status: "completed", finalText: "turn 2 fresh session" };
			});
			const router = new DriverQuotaRouter({
				drivers: [{ driver: spy, config: { id: "spy", kind: "codex-exec", maxConcurrent: 4 } }],
				roles: { default: ["spy"] },
			});
			const os = await SwarmOS.create({
				runDir: join(dir, "run"),
				workspace: seed,
				topology: "hierarchy",
				goal: { title: "Skills + CodeMode + Rollover", text: "Test full harness features" },
				store,
				router,
			});

			try {
				// Publish board posts + artifacts to inspect via Code Mode
				os.board.publish({ runId: os.runId, authorAgentId: "peer-1", topic: "perf", summary: "Tiling gave 2.4x speedup" });
				os.board.publish({ runId: os.runId, authorAgentId: "peer-2", topic: "bug", summary: "Fixed off-by-one in parser" });

				// Spawn an integrator with Code Mode enabled
				const integ = await os.spawnWorker({
					role: "integrator",
					toolScope: { codeMode: true, board: "read-write", artifacts: true, findings: true, nominate: true, tasks: false, scheduler: "never" },
				});

				// Tier-1 static skill `refinery-merge` must be in integrator's static systemPrompt
				expect(spy.spawnedSpecs[0]!.systemPrompt).toContain("## Skill: refinery-merge");
				// Tier-2 catalog must list on-demand skills without dumping their body
				expect(spy.spawnedSpecs[0]!.systemPrompt).toContain("benchmark-hygiene");

				const tools = os.mcp.toolsFor(integ.agent.id);
				const loadSkill = tools.find((t) => t.name === "load_skill")!;
				const codeMode = tools.find((t) => t.name === "run_swarm_script")!;
				expect(loadSkill).toBeDefined();
				expect(codeMode).toBeDefined();

				// Tier-2 on-demand load_skill returns body cleanly
				const loaded = await loadSkill.execute({ name: "benchmark-hygiene" }, {
					runId: os.runId,
					agentId: integ.agent.id,
					role: "integrator",
					workspace: integ.workspace,
					signal: new AbortController().signal,
				});
				expect(loaded.isError).toBeFalsy();
				expect(loaded.text).toContain("warmup pass");

				// Role-restricted skill (reviewer-only) must be rejected for integrator role
				const forbiddenSkill = await loadSkill.execute({ name: "blind-verification" }, {
					runId: os.runId,
					agentId: integ.agent.id,
					role: "integrator",
					workspace: integ.workspace,
					signal: new AbortController().signal,
				});
				expect(forbiddenSkill.isError).toBe(true);

				// Coordinator Code Mode aggregates board posts offline under Seatbelt networkOff
				const cmRes = await codeMode.execute(
					{ code: `const hits = swarm.board.search("speedup", 5); return { count: hits.length, top: hits[0]?.post.summary };` },
					{
						runId: os.runId,
						agentId: integ.agent.id,
						role: "integrator",
						workspace: integ.workspace,
						signal: new AbortController().signal,
					},
				);
				expect(cmRes.isError).toBe(false);
				const parsed = JSON.parse(cmRes.text);
				expect(parsed.count).toBe(1);
				expect(parsed.top).toContain("2.4x speedup");

				// Turn 1 sets needsHandoff -> Turn 2 automatically triggers Tier-2 Clean-Slate Handoff rollover!
				await integ.runTurn("Start integrating");
				expect(spy.spawnedSpecs).toHaveLength(1);
				await integ.runTurn("Continue after verification");
				expect(spy.spawnedSpecs).toHaveLength(2);
				expect(existsSync(join(integ.workspace, ".swarm", "HANDOFF.md"))).toBe(true);
				const handoffMd = readFileSync(join(integ.workspace, ".swarm", "HANDOFF.md"), "utf8");
				expect(handoffMd).toContain("naive-loop timed out");
				expect(promptsSeen[1]).toContain(".swarm/HANDOFF.md");

				const handoffs = store.events(os.runId, { types: ["agent.handoff"] });
				expect(handoffs).toHaveLength(1);
				expect(handoffs[0]!.data.reasonKind).toBe("compaction_limit");

				await integ.close();
			} finally {
				await os.dispose();
				store.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("enforces WorkerHandle lifecycle (no concurrent turns, no runTurn after close) and permanent drained quota state", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-sm-guard-"));
		const seed = join(dir, "seed");
		mkdirSync(seed, { recursive: true });
		writeFileSync(join(seed, "app.txt"), "v0\n", "utf8");
		let releaseTurn!: () => void;
		const turnGate = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});

		const gatedDriver = new SpyWorkerDriver("gated-spy", async () => {
			await turnGate;
			return { status: "completed", finalText: "done", usage: { inputTokens: 10, outputTokens: 5 } };
		});

		try {
			const store = new SqliteStore(join(dir, "trace.db"));
			const router = new DriverQuotaRouter({
				drivers: [{ driver: gatedDriver, config: { id: "gated-spy", kind: "codex-exec", maxConcurrent: 2 } }],
				roles: { default: ["gated-spy"] },
			});
			const os = await SwarmOS.create({
				runDir: join(dir, "run"),
				workspace: seed,
				topology: "single",
				goal: { title: "State machine guards", text: "Verify lifecycle transitions" },
				store,
				router,
			});

			try {
				const worker = await os.spawnWorker({ role: "worker" });

				// 1. Concurrent overlapping runTurn() on the same handle must throw immediately
				const firstTurn = worker.runTurn("Turn 1");
				await expect(worker.runTurn("Overlapping Turn 2")).rejects.toThrow(/already has an active turn/i);
				releaseTurn();
				const res1 = await firstTurn;
				expect(res1.status).toBe("completed");

				// 2. Calling runTurn() after close() must throw immediately
				await worker.close();
				await expect(worker.runTurn("Post-close Turn")).rejects.toThrow(/already closed/i);

				// 3. Drained driver in DriverQuotaRouter is NEVER resurrected by a late reportSuccess()
				router.reportQuotaError("gated-spy", { kind: "hard_auth_or_cap", reason: "HTTP 403 revoked", raw: "403" });
				router.reportSuccess("gated-spy");
				const quotas = store.list("quotas", { runId: os.runId });
				expect(quotas.find((q) => q.driverId === "gated-spy")?.state).toBe("drained");
			} finally {
				await os.dispose();
				store.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
