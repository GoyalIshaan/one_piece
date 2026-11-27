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
		return { ok: true as const, driverId: this.id, kind: this.kind, version: "spy-1.0" };
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

				// Lean scoped tool menu: Board v3 5-tool surface, NO claim_task, NO complete_task, NO nominate, NO scheduler on default CPU-only config!
				const toolNames = (spy.spawnedSpecs[0]!.tools ?? []).map((t) => t.name);
				expect(toolNames).toContain("board_search");
				expect(toolNames).toContain("board_post");
				expect(toolNames).toContain("board_edit");
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

	it("delegates read-only exploration to sidekick tier and escalates stalled/compacted workers to frontier tier", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-he-tier-"));
		const seed = join(dir, "seed");
		mkdirSync(seed, { recursive: true });
		writeFileSync(join(seed, "auth.ts"), "export const AUTH_MODE = 'oauth2';\n", "utf8");

		try {
			const store = new SqliteStore(":memory:");
			const sidekickCalls: string[] = [];
			const frontierCalls: string[] = [];

			const sidekickSpy = new SpyWorkerDriver("fast-sidekick", async (spec, prompt) => {
				sidekickCalls.push(`${spec.role}:${prompt.slice(0, 40)}`);
				// Emit identical tool activity so 2 repeated turns trigger mechanical stall -> escalate to frontier!
				if (spec.role === "worker") {
					spec.onActivity?.({ type: "tool_call", name: "bash", argsPreview: "npm test" });
					return { status: "completed", finalText: "stuck on bug" };
				}
				return { status: "completed", finalText: "auth.ts:1 defines AUTH_MODE = 'oauth2'" };
			});
			const frontierSpy = new SpyWorkerDriver("smart-frontier", async (spec, prompt) => {
				frontierCalls.push(`${spec.role}:${prompt.slice(0, 40)}`);
				writeFileSync(join(spec.workspace, "fixed.txt"), "resolved by frontier\n", "utf8");
				return { status: "completed", finalText: "Fixed cleanly after escalation" };
			});

			const router = new DriverQuotaRouter({
				drivers: [
					{ driver: sidekickSpy, config: { id: "fast-sidekick", kind: "codex-exec", tier: "sidekick", maxConcurrent: 4 } },
					{ driver: frontierSpy, config: { id: "smart-frontier", kind: "codex-exec", tier: "frontier", maxConcurrent: 4 } },
				],
				roles: {
					default: ["fast-sidekick", "smart-frontier"],
					explorer: ["fast-sidekick", "smart-frontier"],
					worker: ["fast-sidekick", "smart-frontier"],
				},
			});

			const os = await SwarmOS.create({
				runDir: join(dir, "run"),
				workspace: seed,
				topology: "hierarchy",
				goal: { title: "Escalation & Sidekick", text: "Test sidekick delegation and stall escalation" },
				maxRepeatedTurns: 2,
				store,
				router,
			});

			try {
				// 1. Planner exposes delegate_explore -> runs on sidekick tier and returns concise distilled answer
				const planner = await os.spawnWorker({ role: "planner", preferredDriverId: "smart-frontier" });
				const exploreTool = os.mcp.toolsFor(planner.agent.id).find((t) => t.name === "delegate_explore")!;
				expect(exploreTool).toBeDefined();
				const exploreRes = await exploreTool.execute(
					{ query: "Where is AUTH_MODE defined?", paths: ["auth.ts"] },
					{ runId: os.runId, agentId: planner.agent.id, role: "planner", workspace: planner.workspace, signal: new AbortController().signal },
				);
				expect(exploreRes.isError).toBe(false);
				expect(exploreRes.text).toContain("AUTH_MODE");
				expect((exploreRes.data as any)?.driverId).toBe("fast-sidekick");
				await planner.close();

				// 2. Sidekick worker hitting 2x identical state escalates via HANDOFF.md to frontier tier!
				const task = os.createTask({
					title: "Fix auth edge case",
					description: "Fix token refresh",
					ownedPaths: ["auth.ts"],
					acceptanceCriteria: ["OAuth refresh passes unit test"],
					createdBy: "planner",
				});
				const worker = await os.spawnWorker({ role: "worker", taskId: task.id, maxTier: "sidekick" });
				expect(worker.agent.driverId).toBe("fast-sidekick");

				// Turn 1 records sig once; Turn 2 repeats sig -> TriggerEngine arms escalation -> immediately hands off to smart-frontier!
				await worker.runTurn("Attempt fix");
				const escalatedRes = await worker.runTurn("Try again");
				expect(escalatedRes.finalText).toBe("Fixed cleanly after escalation");
				expect(worker.agent.driverId).toBe("smart-frontier");

				const escEvents = store.events(os.runId, { types: ["agent.escalated"] });
				expect(escEvents).toHaveLength(1);
				expect(escEvents[0]!.data.fromTier).toBe("sidekick");
				expect(escEvents[0]!.data.toTier).toBe("frontier");

				const handoffMd = readFileSync(join(worker.workspace, ".swarm", "HANDOFF.md"), "utf8");
				expect(handoffMd).toContain("OAuth refresh passes unit test");
				expect(handoffMd).toContain("auth.ts");
				await worker.close();
			} finally {
				await os.dispose();
				store.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs stacked decorrelated reviewLenses (blind-diff + transcript-audit) with veto semantics", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-he-lenses-"));
		const seed = join(dir, "seed");
		mkdirSync(seed, { recursive: true });
		writeFileSync(join(seed, "app.ts"), "export const ok = true;\n", "utf8");

		try {
			const store = new SqliteStore(":memory:");
			const reviewCalls: Array<{ driverId: string; prompt: string }> = [];
			const mkReviewer = (id: string, verdict: "accepted" | "needs_work", msg: string) =>
				new SpyWorkerDriver(id, async (_spec, prompt) => {
					reviewCalls.push({ driverId: id, prompt });
					return { status: "completed", finalText: JSON.stringify({ verdict, confidence: 0.9, message: msg }) };
				});

			const router = new DriverQuotaRouter({
				drivers: [
					{ driver: mkReviewer("author-drv", "accepted", "n/a"), config: { id: "author-drv", kind: "codex-exec" } },
					{ driver: mkReviewer("rev-a", "accepted", "Diff looks clean"), config: { id: "rev-a", kind: "codex-exec" } },
					{ driver: mkReviewer("rev-b", "needs_work", "Author skipped tests in transcript"), config: { id: "rev-b", kind: "codex-exec" } },
				],
				roles: {
					default: ["author-drv", "rev-a", "rev-b"],
					reviewer: ["rev-a", "rev-b"],
				},
			});

			const os = await SwarmOS.create({
				runDir: join(dir, "run"),
				workspace: seed,
				topology: "single",
				goal: { title: "Stacked Lenses", text: "Test decorrelated review lenses" },
				reviewLenses: ["blind-diff", "transcript-audit"],
				store,
				router,
			});

			try {
				os.bus.emit(os.runId, "driver.tool_call", { tool: "bash", argsPreview: "echo skipped" }, "agt-author");
				const finding = await os.trust.submitFinding({
					agentId: "agt-author",
					driverId: "author-drv",
					workspace: seed,
					claim: "All checks pass",
					summary: "Implemented feature",
					level: "empirical",
				});

				// Both lenses ran on distinct drivers; rev-b (transcript-audit) vetoed acceptance!
				expect(reviewCalls.length).toBeGreaterThanOrEqual(1);
				expect(finding.status).toBe("needs_work");
				expect(finding.rounds.some((r) => r.lens === "blind-diff" || r.lens === "transcript-audit")).toBe(true);
				const transcriptPrompt = reviewCalls.find((c) => c.prompt.includes("Review lens: transcript-audit"))?.prompt;
				if (transcriptPrompt) {
					expect(transcriptPrompt).toContain("echo skipped");
				}
			} finally {
				await os.dispose();
				store.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("wires read-only trace_* navigation tools and anchored transcript brief into transcript-audit lens for scattered long-horizon violations", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-he-trace-nav-"));
		const seed = join(dir, "seed");
		mkdirSync(seed, { recursive: true });
		writeFileSync(join(seed, "app.ts"), "export const v = 1;\n", "utf8");

		try {
			const store = new SqliteStore(":memory:");
			let sawTraceToolMenu: string[] = [];
			let capturedPrompt = "";
			const reviewerDriver = new SpyWorkerDriver("rev-nav", async (spec, prompt) => {
				sawTraceToolMenu = [...(spec.mcp?.toolNames ?? [])];
				capturedPrompt = prompt;
				return {
					status: "completed",
					finalText: JSON.stringify({
						verdict: "needs_work",
						confidence: 0.92,
						message: "Caught early scattered violation via anchored brief & trace nav tools",
					}),
				};
			});
			const authorDriver = new SpyWorkerDriver("author-nav", async () => ({
				status: "completed",
				finalText: "done",
			}));

			const router = new DriverQuotaRouter({
				drivers: [
					{ driver: authorDriver, config: { id: "author-nav", kind: "codex-exec" } },
					{ driver: reviewerDriver, config: { id: "rev-nav", kind: "codex-exec" } },
				],
				roles: { default: ["author-nav", "rev-nav"], reviewer: ["rev-nav"] },
			});

			const os = await SwarmOS.create({
				runDir: join(dir, "run"),
				workspace: seed,
				topology: "single",
				goal: { title: "Long-Horizon Audit", text: "Catch early scattered failure outside last 30 events" },
				reviewLenses: ["transcript-audit"],
				store,
				router,
			});

			try {
				// Emit an early critical error at turn 3, followed by 55 mundane tool events (far outside old .slice(-30)!)
				os.bus.emit(os.runId, "driver.tool_call", { tool: "bash", argsPreview: "pytest tests/critical.py" }, "agt-long");
				os.bus.emit(
					os.runId,
					"driver.tool_result",
					{ tool: "bash", isError: true, outputPreview: "EARLY_SCATTERED_CONSTRAINT_VIOLATION" },
					"agt-long",
				);
				for (let i = 0; i < 55; i++) {
					os.bus.emit(os.runId, "driver.tool_call", { tool: "read_file", argsPreview: `file_${i}.ts` }, "agt-long");
				}

				const finding = await os.trust.submitFinding({
					agentId: "agt-long",
					driverId: "author-nav",
					workspace: seed,
					claim: "All checks pass cleanly",
					summary: "Done",
					level: "empirical",
				});

				expect(finding.status).toBe("needs_work");
				// Anchored brief MUST surface the early error even though >55 events followed it!
				expect(capturedPrompt).toContain("EARLY_SCATTERED_CONSTRAINT_VIOLATION");
				expect(capturedPrompt).toContain("trace_expand_window");
				// Reviewer MUST receive all 5 read-only trace_* navigation tools on MCP!
				expect(sawTraceToolMenu).toContain("trace_list_anchors");
				expect(sawTraceToolMenu).toContain("trace_expand_window");
				expect(sawTraceToolMenu).toContain("trace_search_events");
				expect(sawTraceToolMenu).toContain("trace_get_peer_context");
				expect(sawTraceToolMenu).toContain("trace_read_evidence");
			} finally {
				await os.dispose();
				store.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves pull-refinery merge conflicts via an impartial resolver and flags hotspot files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-he-conflict-"));
		const seed = join(dir, "seed");
		mkdirSync(seed, { recursive: true });
		// >800 lines triggers megafile-hotspot advisory on first conflict
		writeFileSync(join(seed, "shared.txt"), ["HEADER", ...Array.from({ length: 805 }, (_, i) => `line-${i + 1}`)].join("\n") + "\n", "utf8");

		try {
			const store = new SqliteStore(":memory:");
			const spy = new SpyWorkerDriver("refinery-spy", async (spec, prompt) => {
				if (spec.role === "planner") {
					return {
						status: "completed",
						finalText: JSON.stringify({
							tasks: [
								{ key: "t1", title: "Update header A", description: "Change header to A", owned_paths: ["shared.txt"], acceptance_criteria: ["Header includes A"] },
								{ key: "t2", title: "Update header B", description: "Change header to B", owned_paths: ["shared.txt"], acceptance_criteria: ["Header includes B"] },
							],
						}),
					};
				}
				if (spec.role === "integrator") {
					// Impartial resolver sees both diffs and reconciles them cleanly on top of trunk!
					expect(prompt).toContain("Conflicting files: shared.txt");
					const current = readFileSync(join(spec.workspace, "shared.txt"), "utf8");
					writeFileSync(join(spec.workspace, "shared.txt"), current.replace(/^HEADER.*\n/, "HEADER_A_AND_B\n"), "utf8");
					return { status: "completed", finalText: "Resolved shared.txt cleanly keeping both A and B" };
				}
				// Both workers branch from the same initial trunk and edit line 1 of shared.txt -> guaranteed git conflict!
				const current = readFileSync(join(spec.workspace, "shared.txt"), "utf8");
				const tag = prompt.includes("Update header A") ? "HEADER_A" : "HEADER_B";
				writeFileSync(join(spec.workspace, "shared.txt"), current.replace(/^HEADER\n/, `${tag}\n`), "utf8");
				return { status: "completed", finalText: `Wrote ${tag}` };
			});

			const router = new DriverQuotaRouter({
				drivers: [{ driver: spy, config: { id: "refinery-spy", kind: "codex-exec", maxConcurrent: 4 } }],
				roles: { default: ["refinery-spy"] },
			});
			const os = await SwarmOS.create({
				runDir: join(dir, "run"),
				workspace: seed,
				topology: "pull-refinery",
				goal: { title: "Conflict resolution test", text: "Merge two conflicting branches cleanly" },
				store,
				router,
			});

			try {
				const outcome = await os.execute(createTopology("pull-refinery", { concurrency: 2 }));
				expect(outcome.status).toBe("done");

				const resolvedEvents = store.events(os.runId, { types: ["refinery.conflict_resolved"] });
				expect(resolvedEvents).toHaveLength(1);
				expect(resolvedEvents[0]!.data.conflictFiles).toEqual(["shared.txt"]);

				const trunkHead = readFileSync(join(os.worktrees.trunkPath, "shared.txt"), "utf8").split("\n")[0];
				expect(trunkHead).toBe("HEADER_A_AND_B");

				const hotspotPosts = store.list("posts", { runId: os.runId }).filter((p) => p.topic === "megafile-hotspot");
				expect(hotspotPosts.length).toBeGreaterThanOrEqual(1);
			} finally {
				await os.dispose();
				store.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never silently accepts a finding when a configured review lens fails, and never marks a no-op conflict resolver as resolved", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-he-regress-"));
		const seed = join(dir, "seed");
		mkdirSync(seed, { recursive: true });
		writeFileSync(join(seed, "shared.txt"), "HEADER\nbody\n", "utf8");

		try {
			const store = new SqliteStore(":memory:");
			// Lens 1 accepts, Lens 2 crashes -> finding MUST become "unreviewed" (NEVER "accepted")!
			const okRev = new SpyWorkerDriver("ok-rev", async () => ({
				status: "completed",
				finalText: JSON.stringify({ verdict: "accepted", confidence: 0.9, message: "ok" }),
			}));
			const brokenRev = new SpyWorkerDriver("broken-rev", async () => ({
				status: "failed",
				finalText: "",
				error: "reviewer provider crashed",
			}));
			const lensRouter = new DriverQuotaRouter({
				drivers: [
					{ driver: okRev, config: { id: "ok-rev", kind: "codex-exec" } },
					{ driver: brokenRev, config: { id: "broken-rev", kind: "codex-exec" } },
				],
				roles: { default: ["ok-rev", "broken-rev"], reviewer: ["ok-rev", "broken-rev"] },
			});
			const os1 = await SwarmOS.create({
				runDir: join(dir, "run1"),
				workspace: seed,
				topology: "single",
				goal: { title: "Lens error safety", text: "Ensure broken lens never auto-accepts" },
				reviewLenses: ["blind-diff", "transcript-audit"],
				store,
				router: lensRouter,
			});
			try {
				const f = await os1.trust.submitFinding({
					agentId: "agt-x",
					driverId: "author-x",
					workspace: seed,
					claim: "Looks fine",
					summary: "Test",
					level: "empirical",
				});
				expect(f.status).toBe("unreviewed");
				if (f.status === "unreviewed") expect(f.reviewError).toContain("failed");
				expect(store.get("findings", f.id)?.status).toBe("unreviewed");
			} finally {
				await os1.dispose();
			}

			// Pull-refinery with a no-op integrator MUST NOT falsely emit refinery.conflict_resolved
			const noopSpy = new SpyWorkerDriver("noop-ref", async (spec, prompt) => {
				if (spec.role === "planner") {
					return {
						status: "completed",
						finalText: JSON.stringify({
							tasks: [
								{ key: "t1", title: "Edit A", description: "Change header to A" },
								{ key: "t2", title: "Edit B", description: "Change header to B" },
							],
						}),
					};
				}
				if (spec.role === "integrator") {
					// Resolver exits without changing any files!
					return { status: "completed", finalText: "did nothing" };
				}
				const current = readFileSync(join(spec.workspace, "shared.txt"), "utf8");
				const tag = prompt.includes("Edit A") ? "A" : "B";
				writeFileSync(join(spec.workspace, "shared.txt"), current.replace("HEADER", tag), "utf8");
				return { status: "completed", finalText: `wrote ${tag}` };
			});
			const noopRouter = new DriverQuotaRouter({
				drivers: [{ driver: noopSpy, config: { id: "noop-ref", kind: "codex-exec", maxConcurrent: 4 } }],
				roles: { default: ["noop-ref"] },
			});
			const os2 = await SwarmOS.create({
				runDir: join(dir, "run2"),
				workspace: seed,
				topology: "pull-refinery",
				goal: { title: "No-op resolver guard", text: "Reject empty conflict resolution" },
				store,
				router: noopRouter,
			});
			try {
				await os2.execute(createTopology("pull-refinery", { concurrency: 2 }));
				expect(store.events(os2.runId, { types: ["refinery.conflict_resolved"] })).toHaveLength(0);
				const conflictPosts = store.list("posts", { runId: os2.runId }).filter((p) => p.topic === "refinery-conflict");
				expect(conflictPosts.length).toBeGreaterThanOrEqual(1);
			} finally {
				await os2.dispose();
				store.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
