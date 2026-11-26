import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	DriverCapabilities,
	FindingVerifier,
	WorkerDriver,
	WorkerSession,
	WorkerSpawnSpec,
	WorkerTurnResult,
} from "@one-piece/core";
import { DriverQuotaRouter } from "@one-piece/drivers";
import {
	createTopology,
	enforceLineBudget,
	probeWorkspaceEnvironment,
	SwarmOS,
} from "../src/index.ts";
import { SqliteStore } from "@one-piece/store";

class MockDriver implements WorkerDriver {
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
		return { ok: true, driverId: this.id, kind: this.kind, version: "mock" };
	}

	async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
		return {
			driverId: this.id,
			sessionId: `${this.id}-${spec.agentId}`,
			runTurn: (prompt) => this.handler(spec, prompt),
			close: async () => {},
		};
	}
}

describe("RSI Harness Upgrades: Field Guide, Semantic Auto-Repair, Fail-Closed Trust, Crossover & Elastic-Phase", () => {
	it("probes workspace deterministically, enforces <=80-line Field Guide budget, preserves KV-identical peer prompts, and hides guide from blind reviewers", async () => {
		const root = mkdtempSync(join(tmpdir(), "rsi-fg-"));
		try {
			const seed = join(root, "seed");
			mkdirSync(join(seed, "tests"), { recursive: true });
			writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "demo-pkg", scripts: { test: "vitest --run" } }));
			writeFileSync(join(seed, "TASK.md"), "# Demo Task\n");
			writeFileSync(join(seed, "app.py"), "x = 1\n");

			const probe = probeWorkspaceEnvironment(seed, "abcdef1234567890");
			expect(probe).toContain("demo-pkg");
			expect(probe).toContain("npm run test");
			expect(probe).toContain("TASK.md");

			const longText = Array.from({ length: 120 }, (_, i) => `line-${i + 1}`).join("\n");
			const clipped = enforceLineBudget(longText, 80);
			expect(clipped.trimEnd().split("\n").length).toBeLessThanOrEqual(80);
			expect(clipped).toContain("truncated to 80-line");

			const seenPrompts = new Map<string, string | undefined>();
			const driver = new MockDriver("d1", async (spec) => {
				seenPrompts.set(`${spec.role}:${spec.agentId}`, spec.systemPrompt);
				if (spec.role === "reviewer") {
					return { status: "completed", finalText: '{"verdict":"accepted","confidence":0.9,"message":"ok"}' };
				}
				// Verify mirrored field guide exists and is git-excluded!
				expect(existsSync(join(spec.workspace, ".swarm", "field-guide", "index.md"))).toBe(true);
				return { status: "completed", finalText: "done" };
			});

			const store = new SqliteStore(join(root, "trace.db"));
			const router = new DriverQuotaRouter({
				drivers: [{ driver, config: { id: "d1", kind: "codex-exec", maxConcurrent: 4 } }],
				roles: { default: ["d1"] },
			});
			const os = await SwarmOS.create({
				runDir: join(root, "run"),
				workspace: seed,
				topology: "substrate-peers",
				goal: { title: "FG test", text: "Test field guide" },
				store,
				router,
			});
			try {
				const w1 = await os.spawnWorker({ role: "worker", handle: "p1", systemPrompt: "PEER PROMPT" });
				const w2 = await os.spawnWorker({ role: "worker", handle: "p2", systemPrompt: "PEER PROMPT" });
				const rev = await os.spawnWorker({ role: "reviewer", workspace: w1.workspace, readOnly: true, systemPrompt: "BLIND REVIEW" });
				await w1.runTurn("hi");
				await w2.runTurn("hi");
				await rev.runTurn("review");

				// Sibling peers get byte-identical system prompts containing the Field Guide
				const workerPrompts = [...seenPrompts.entries()].filter(([k]) => k.startsWith("worker:")).map(([, v]) => v);
				expect(workerPrompts.length).toBe(2);
				expect(workerPrompts[0]).toBe(workerPrompts[1]);
				expect(workerPrompts[0]).toContain("Swarm Field Guide");

				// Blind reviewer must NEVER receive generator Field Guide content
				const revPrompt = [...seenPrompts.entries()].find(([k]) => k.startsWith("reviewer:"))?.[1] ?? "";
				expect(revPrompt).not.toContain("Swarm Field Guide");

				// `.swarm/field-guide/index.md` must NOT dirty git status (fixed --git-common-dir!)
				expect(os.worktrees.commitWip(w1.workspace, "should be empty")).toBeUndefined();

				// Wave-boundary dreaming updates guide and emits field_guide.updated
				os.board.publish({ runId: os.runId, authorAgentId: w1.agent.id, topic: "invariant", summary: "Keep INT_MIN/INT_MAX checked" });
				const updated = await os.consolidateFieldGuide();
				expect(updated.lines).toBeLessThanOrEqual(80);
				expect(readFileSync(updated.path, "utf8")).toContain("Keep INT_MIN/INT_MAX checked");
				expect(store.events(os.runId, { types: ["field_guide.updated"] }).length).toBe(1);

				await w1.close();
				await w2.close();
				await rev.close();
			} finally {
				await os.dispose();
				store.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("auto-repairs semantic interference on clean Git merges in pull-refinery AND rolls back trunk when repair is disabled", async () => {
		const root = mkdtempSync(join(tmpdir(), "rsi-sem-"));
		try {
			const seed = join(root, "seed");
			mkdirSync(seed, { recursive: true });
			writeFileSync(join(seed, "a.txt"), "base-a\n");
			writeFileSync(join(seed, "b.txt"), "base-b\n");

			// Verifier fails when a.txt="A" and b.txt="B-BROKEN" coexist (pure semantic interference, zero git conflict!)
			const semanticVerifier: FindingVerifier = {
				name: "semantic-check",
				version: "1.0.0",
				scopes: ["deliverable"],
				defaultScope: "deliverable",
				async check({ workspace }) {
					const a = readFileSync(join(workspace, "a.txt"), "utf8").trim();
					const b = readFileSync(join(workspace, "b.txt"), "utf8").trim();
					if (a === "A" && b === "B-BROKEN") {
						return { status: "failed", score: 0.5, message: "Semantic clash: B-BROKEN breaks A invariant" };
					}
					if (a === "A" && b === "B-FIXED") {
						return { status: "passed", score: 1.0, message: "A + B-FIXED integrated cleanly" };
					}
					return { status: "passed", score: 0.6, message: "Single feature passes" };
				},
			};

			const makeDriver = () =>
				new MockDriver("sem-drv", async (spec, prompt) => {
					if (spec.role === "planner") {
						return {
							status: "completed",
							finalText: JSON.stringify({
								tasks: [
									{ key: "t1", title: "Feature A", description: "Edit a.txt", depends_on: [] },
									{ key: "t2", title: "Feature B", description: "Edit b.txt", depends_on: ["t1"] },
								],
							}),
						};
					}
					if (spec.role === "integrator") {
						writeFileSync(join(spec.workspace, "b.txt"), "B-FIXED\n");
						return { status: "completed", finalText: "Repaired B to respect A invariant" };
					}
					if (prompt.includes("Feature A")) {
						writeFileSync(join(spec.workspace, "a.txt"), "A\n");
					} else {
						writeFileSync(join(spec.workspace, "b.txt"), "B-BROKEN\n");
					}
					return { status: "completed", finalText: "done" };
				});

			// Case 1: Semantic auto-repair ON -> catches clash, repairs, trunk ends green with score=1.0
			const store1 = new SqliteStore(join(root, "t1.db"));
			const os1 = await SwarmOS.create({
				runDir: join(root, "run1"),
				workspace: seed,
				topology: "pull-refinery",
				goal: { title: "Semantic repair", text: "Implement A and B" },
				verifier: semanticVerifier,
				store: store1,
				router: new DriverQuotaRouter({
					drivers: [{ driver: makeDriver(), config: { id: "sem-drv", kind: "codex-exec", maxConcurrent: 4 } }],
					roles: { default: ["sem-drv"] },
				}),
			});
			try {
				const out = await os1.execute(createTopology("pull-refinery", { concurrency: 2, enableSemanticRepair: true }));
				const regEvents = store1.events(os1.runId, { types: ["refinery.semantic_regression"] });
				expect(regEvents.length).toBe(1);
				expect(regEvents[0]!.data.repaired).toBe(true);
				expect(regEvents[0]!.data.rolledBack).toBe(false);
				expect(readFileSync(join(os1.worktrees.trunkPath, "b.txt"), "utf8").trim()).toBe("B-FIXED");
				expect(out.nominatedFindingId).toBeTruthy();
			} finally {
				await os1.dispose();
				store1.close();
			}

			// Case 2: Semantic auto-repair OFF -> rolls back trunk to monotonically green prevTrunkSha!
			const store2 = new SqliteStore(join(root, "t2.db"));
			const os2 = await SwarmOS.create({
				runDir: join(root, "run2"),
				workspace: seed,
				topology: "pull-refinery",
				goal: { title: "Semantic rollback", text: "Implement A and B" },
				verifier: semanticVerifier,
				store: store2,
				router: new DriverQuotaRouter({
					drivers: [{ driver: makeDriver(), config: { id: "sem-drv", kind: "codex-exec", maxConcurrent: 4 } }],
					roles: { default: ["sem-drv"] },
				}),
			});
			try {
				await os2.execute(createTopology("pull-refinery", { concurrency: 2, enableSemanticRepair: false }));
				const regEvents = store2.events(os2.runId, { types: ["refinery.semantic_regression"] });
				expect(regEvents.length).toBe(1);
				expect(regEvents[0]!.data.repaired).toBe(false);
				expect(regEvents[0]!.data.rolledBack).toBe(true);
				expect(readFileSync(join(os2.worktrees.trunkPath, "a.txt"), "utf8").trim()).toBe("A");
				expect(readFileSync(join(os2.worktrees.trunkPath, "b.txt"), "utf8").trim()).toBe("base-b");
			} finally {
				await os2.dispose();
				store2.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed on unparseable blind-review responses and refuses self-reported score spoofing when verifier is installed", async () => {
		const root = mkdtempSync(join(tmpdir(), "rsi-trust-"));
		try {
			const seed = join(root, "seed");
			mkdirSync(seed, { recursive: true });
			writeFileSync(join(seed, "x.txt"), "ok\n");

			const garbageReviewer = new MockDriver("rev-garbage", async () => ({
				status: "completed",
				finalText: "Hmm, interesting code, here are some general observations.",
			}));
			const store = new SqliteStore(join(root, "trust.db"));
			const os = await SwarmOS.create({
				runDir: join(root, "run"),
				workspace: seed,
				topology: "single",
				goal: { title: "Trust test", text: "Check fail-closed review" },
				verifier: {
					name: "exact",
					version: "1.0.0",
					scopes: ["deliverable"],
					defaultScope: "deliverable",
					async check() {
						return { status: "passed", score: 0.42, message: "Verifier score 0.42" };
					},
				},
				enableBlindReview: true,
				store,
				router: new DriverQuotaRouter({
					drivers: [{ driver: garbageReviewer, config: { id: "rev-garbage", kind: "codex-exec", maxConcurrent: 2 } }],
					roles: { default: ["rev-garbage"] },
				}),
			});
			try {
				const finding = await os.trust.submitFinding({
					agentId: "w1",
					workspace: seed,
					claim: "Spoofed score",
					summary: "Trying to claim score 9999",
					level: "empirical",
					score: 9999,
				});
				// Fail-closed: non-JSON commentary without explicit accepted verdict -> needs_work!
				expect(finding.status).toBe("needs_work");
				// Authoritative verifier score (0.42) overrides self-reported 9999!
				expect(finding.score).toBe(0.42);
			} finally {
				await os.dispose();
				store.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("executes evolution crossover + dreaming and elastic-phase semantic repair end-to-end", async () => {
		const root = mkdtempSync(join(tmpdir(), "rsi-evo-elastic-"));
		try {
			const seed = join(root, "seed");
			mkdirSync(seed, { recursive: true });
			writeFileSync(join(seed, "val.txt"), "0\n");

			let seenCrossoverPrompt = false;
			let callCount = 0;
			const evoDriver = new MockDriver("evo", async (spec, prompt) => {
				callCount += 1;
				if (prompt.includes("[CROSSOVER]")) seenCrossoverPrompt = true;
				writeFileSync(join(spec.workspace, "val.txt"), `${callCount}\n`);
				return { status: "completed", finalText: `Mutation #${callCount}` };
			});

			const store1 = new SqliteStore(join(root, "evo.db"));
			const os1 = await SwarmOS.create({
				runDir: join(root, "run-evo"),
				workspace: seed,
				topology: "evolution",
				goal: { title: "Evo test", text: "Maximize val.txt" },
				verifier: {
					name: "val-check",
					version: "1.0.0",
					scopes: ["deliverable"],
					defaultScope: "deliverable",
					async check({ workspace }) {
						const v = Number(readFileSync(join(workspace, "val.txt"), "utf8").trim());
						return { status: "passed", score: v, message: `val=${v}` };
					},
				},
				store: store1,
				router: new DriverQuotaRouter({
					drivers: [{ driver: evoDriver, config: { id: "evo", kind: "codex-exec", maxConcurrent: 4 } }],
					roles: { default: ["evo"] },
				}),
			});
			try {
				await os1.execute(createTopology("evolution", { generations: 2, populationPerGen: 2 }));
				expect(seenCrossoverPrompt).toBe(true);
				expect(store1.events(os1.runId, { types: ["field_guide.updated"] }).length).toBeGreaterThanOrEqual(1);
			} finally {
				await os1.dispose();
				store1.close();
			}

			// Elastic-phase end-to-end with semantic interference repair
			const elasticDriver = new MockDriver("el", async (spec, prompt) => {
				if (spec.role === "planner") {
					return {
						status: "completed",
						finalText: JSON.stringify({
							lanes: [
								{ title: "Lane 1", description: "Write f1.txt", owned_paths: ["f1.txt"], cross_contracts: ["Must agree with f2"] },
								{ title: "Lane 2", description: "Write f2.txt", owned_paths: ["f2.txt"], cross_contracts: ["Must agree with f1"] },
							],
						}),
					};
				}
				if (spec.role === "integrator") {
					writeFileSync(join(spec.workspace, "f2.txt"), "OK\n");
					return { status: "completed", finalText: "Repaired f2.txt to match f1.txt" };
				}
				if (prompt.includes("Lane 1")) writeFileSync(join(spec.workspace, "f1.txt"), "OK\n");
				else writeFileSync(join(spec.workspace, "f2.txt"), "CLASH\n");
				return { status: "completed", finalText: "lane done" };
			});

			const store2 = new SqliteStore(join(root, "el.db"));
			const os2 = await SwarmOS.create({
				runDir: join(root, "run-el"),
				workspace: seed,
				topology: "elastic-phase",
				goal: { title: "Elastic test", text: "Build coherent f1 + f2" },
				verifier: {
					name: "pair-check",
					version: "1.0.0",
					scopes: ["deliverable"],
					defaultScope: "deliverable",
					async check({ workspace }) {
						const f1 = existsSync(join(workspace, "f1.txt")) ? readFileSync(join(workspace, "f1.txt"), "utf8").trim() : "";
						const f2 = existsSync(join(workspace, "f2.txt")) ? readFileSync(join(workspace, "f2.txt"), "utf8").trim() : "";
						const ok = f1 === "OK" && f2 === "OK";
						return { status: ok ? "passed" : "failed", score: ok ? 1 : 0, message: `f1=${f1}, f2=${f2}` };
					},
				},
				store: store2,
				router: new DriverQuotaRouter({
					drivers: [{ driver: elasticDriver, config: { id: "el", kind: "codex-exec", maxConcurrent: 4 } }],
					roles: { default: ["el"] },
				}),
			});
			try {
				const out = await os2.execute(createTopology("elastic-phase", { peers: 2 }));
				expect(out.status).toBe("done");
				expect(out.nominatedFindingId).toBeTruthy();
				const phases = store2.events(os2.runId, { types: ["phase.changed"] }).map((e) => e.data.to);
				expect(phases).toEqual(["elastic-scout", "elastic-wide-explore", "elastic-dream-reset", "elastic-narrow-integrate"]);
				const repairEvs = store2.events(os2.runId, { types: ["peer.trunk_repaired"] });
				expect(repairEvs.length).toBe(1);
				expect(repairEvs[0]!.data.repaired).toBe(true);
			} finally {
				await os2.dispose();
				store2.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
