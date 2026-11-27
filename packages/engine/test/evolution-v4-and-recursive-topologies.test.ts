import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	MemoryStore,
	type TopologyPlugin,
	type WorkerDriver,
	type WorkerSession,
	type WorkerSpawnSpec,
} from "@one-piece/core";
import { DriverQuotaRouter, MockDecisionClient } from "@one-piece/drivers";
import {
	adaptiveTopology,
	evolutionTopology,
	IntegrationPipeline,
	recursivePlannersTopology,
	SwarmOS,
} from "../src/index.ts";

function initTempGitRepo(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "onepiece-v4-evo-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@onepiece.dev"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "OnePieceTest"], { cwd: dir });
	for (const [rel, content] of Object.entries(files)) {
		writeFileSync(join(dir, rel), content);
	}
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
	return dir;
}

function makeScriptedDriver(
	onTurn: (spec: WorkerSpawnSpec, prompt: string) => Promise<string>,
	id = "scripted-v4",
): WorkerDriver {
	return {
		id,
		kind: "pi-in-process",
		capabilities: { supportsSteer: true, supportsResume: true, supportsOutputSchema: true, supportsMcpHttp: false },
		async healthCheck() {
			return { ok: true, driverId: id, kind: "pi-in-process" };
		},
		async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
			return {
				driverId: id,
				async runTurn(prompt: string) {
					const text = await onTurn(spec, prompt);
					return { status: "completed", finalText: text, usage: { inputTokens: 120, outputTokens: 50, totalTokens: 170 } };
				},
				async close() {},
			};
		},
	};
}

describe("Evolution v4 Director-Led Async Recursive GA, Composable Topologies, Live Morph & Gen-14 Fixes", () => {
	it("runs serial Phase-0 Roofline -> Root Director + recursive Child Family Director on a 1-slot pool (no permit deadlock) -> real git diff inspection -> code-level crossover beating both parents", async () => {
		const repo = initTempGitRepo({
			"opt_a.txt": "0\n",
			"opt_b.txt": "0\n",
		});
		const runDir = mkdtempSync(join(tmpdir(), "onepiece-v4-evo-run-"));
		const callOrder: string[] = [];
		let directorSawRooflineBeforeSeeding = false;
		let inspectedRealGitDiff = false;
		let crossoverSawPartnerBRef = false;
		let subDirectorLeafHadNoSpawnTools = false;

		const store = new MemoryStore();

		try {
			const driver = makeScriptedDriver(async (spec, prompt) => {
				const handle = store.get("agents", spec.agentId)?.handle ?? "";
				const ctx = {
					runId: spec.runId,
					agentId: spec.agentId,
					role: spec.role,
					workspace: spec.workspace,
					signal: new AbortController().signal,
				};
				const tool = (name: string) => spec.tools?.find((t) => t.name === name);

				// Phase-0 Roofline Bound Analyst
				if (handle === "bound-analyst") {
					callOrder.push("phase0-bound-analyst");
					return JSON.stringify({
						metric_name: "combined_score",
						higher_is_better: true,
						hard_ceiling: 1.0,
						is_proven_hard: true,
						paradigm_ceiling: 0.95,
						active_bottleneck: "Separate optimizations not yet fused",
						breakable_assumptions: [
							{
								id: "A1",
								assumption: "Independent opt_a and opt_b edits",
								unlock_hint: "Fuse opt_a and opt_b via crossover",
								tier: "paradigm",
							},
						],
						paradigm_shift_fraction: 0.9,
						stopping_fraction: 0.96,
						confidence: 0.9,
						derivation_summary: "Combining opt_a (0.45) and opt_b (0.55) reaches hard ceiling 1.0.",
						key_assumptions: ["Additive gains"],
					});
				}

				// Root Evolution Director
				if (handle === "evolution-director") {
					callOrder.push("root-director");
					directorSawRooflineBeforeSeeding =
						prompt.includes("combined_score") &&
						prompt.includes("1") &&
						prompt.includes("Separate optimizations not yet fused");

					const launch = tool("evo_launch_family")!;
					const awaitTool = tool("evo_await")!;
					const inspect = tool("evo_inspect_diff")!;
					const crossover = tool("evo_spawn_crossover")!;

					// Launch Family A (straight leaf worker) and Family B (recursive Child Family Director)
					await launch.execute(
						{
							name: "Family Alpha",
							hypothesis: "Optimize opt_a.txt first",
							niche_tag: "alpha",
							seed_prompt: "Set opt_a.txt to 0.45",
							mode: "worker",
						},
						ctx,
					);
					await launch.execute(
						{
							name: "Family Beta",
							hypothesis: "Recursively optimize opt_b.txt via subdirector",
							niche_tag: "beta",
							seed_prompt: "Set opt_b.txt to 0.55 via recursive child worker",
							mode: "subdirector",
						},
						ctx,
					);

					// Async await(mode='any') collects completions reactively without wave barriers
					const collectedFindingIds: string[] = [];
					for (let i = 0; i < 6; i++) {
						const aw = await awaitTool.execute({ mode: "any" }, ctx);
						const data = aw.data as { remainingCount?: number; results?: Array<{ findingId?: string }> } | undefined;
						for (const c of data?.results ?? []) {
							if (c.findingId) collectedFindingIds.push(c.findingId);
						}
						if ((data?.remainingCount ?? 0) === 0) break;
					}

					// Inspect archive status to find both family elites
					const statusRes = await tool("evo_archive_status")!.execute({}, ctx);
					const findingMatches = [...statusRes.text.matchAll(/\b(fnd-[a-zA-Z0-9_-]+)\b/g)].map((m) => m[1]!);
					const uniqueIds = [...new Set([...collectedFindingIds, ...findingMatches])];
					expect(uniqueIds.length).toBeGreaterThanOrEqual(2);

					// Inspect real git diff of Parent B before designing crossover
					const diffRes = await inspect.execute({ branch_or_finding_id: uniqueIds[1]! }, ctx);
					inspectedRealGitDiff = diffRes.text.includes("diff --git") && (diffRes.text.includes("+0.55") || diffRes.text.includes("+0.45"));

					// Spawn code-level crossover combining Family A × Family B
					await crossover.execute(
						{
							parent_a_finding_id: uniqueIds[0]!,
							parent_b_finding_id: uniqueIds[1]!,
							synthesis_hypothesis: "Fuse opt_a and opt_b cleanly to hit 1.0 hard ceiling",
						},
						ctx,
					);
					await awaitTool.execute({ mode: "all" }, ctx);
					return "Evolution complete after verified crossover reached 1.0.";
				}

				// Recursive Child Family Director (depth=1)
				if (spec.role === "planner" && handle.startsWith("dir-")) {
					callOrder.push(`subdirector:${handle}`);
					const launch = tool("evo_launch_family")!;
					const awaitTool = tool("evo_await")!;
					await launch.execute(
						{
							name: "Beta Leaf Sub-Family",
							hypothesis: "Leaf worker modifies opt_b.txt",
							niche_tag: "beta-leaf",
							seed_prompt: "Write 0.55 to opt_b.txt",
							mode: "worker",
						},
						ctx,
					);
					await awaitTool.execute({ mode: "all" }, ctx);
					return "Sub-director completed leaf family.";
				}

				// Code-Level Crossover Worker
				if (handle.startsWith("xov-")) {
					callOrder.push(`crossover:${handle}`);
					const refMatch = /mounted at:\s*(\S+)/.exec(prompt);
					if (refMatch && existsSync(refMatch[1]!)) {
						crossoverSawPartnerBRef = true;
						const bOptA = readFileSync(join(refMatch[1]!, "opt_a.txt"), "utf8").trim();
						const bOptB = readFileSync(join(refMatch[1]!, "opt_b.txt"), "utf8").trim();
						if (Number(bOptA) > Number(readFileSync(join(spec.workspace, "opt_a.txt"), "utf8").trim())) {
							writeFileSync(join(spec.workspace, "opt_a.txt"), `${bOptA}\n`);
						}
						if (Number(bOptB) > Number(readFileSync(join(spec.workspace, "opt_b.txt"), "utf8").trim())) {
							writeFileSync(join(spec.workspace, "opt_b.txt"), `${bOptB}\n`);
						}
					} else {
						writeFileSync(join(spec.workspace, "opt_a.txt"), "0.45\n");
						writeFileSync(join(spec.workspace, "opt_b.txt"), "0.55\n");
					}
					const rep = tool("report_finding")!;
					await rep.execute(
						{ claim: "Fused crossover A+B = 1.0", summary: "Combined opt_a + opt_b", level: "empirical", score: 1.0 },
						ctx,
					);
					return "Crossover fused cleanly.";
				}

				// Leaf Workers (depth=1 or depth=2)
				const names = (spec.tools ?? []).map((t) => t.name);
				if (handle.includes("beta")) {
					subDirectorLeafHadNoSpawnTools =
						!names.includes("spawn_agents") && !names.includes("spawn_topology") && !names.includes("evo_launch_family");
					writeFileSync(join(spec.workspace, "opt_b.txt"), "0.55\n");
					await tool("report_finding")!.execute(
						{ claim: "opt_b = 0.55", summary: "Set opt_b to 0.55", level: "empirical", score: 0.55 },
						ctx,
					);
				} else {
					writeFileSync(join(spec.workspace, "opt_a.txt"), "0.45\n");
					await tool("report_finding")!.execute(
						{ claim: "opt_a = 0.45", summary: "Set opt_a to 0.45", level: "empirical", score: 0.45 },
						ctx,
					);
				}
				return "Leaf mutation done.";
			});

			// maxConcurrent: 1 proves park()/unpark() prevents permit deadlock with Root -> Child Director -> Leaf Worker!
			const router = new DriverQuotaRouter({
				drivers: [{ driver, config: { id: "scripted-v4", kind: "pi-in-process", maxConcurrent: 1 } }],
				roles: { default: ["scripted-v4"], planner: ["scripted-v4"], worker: ["scripted-v4"] },
				concurrencyMode: "fixed",
			});

			const os = await SwarmOS.create({
				runId: "run-evo-v4",
				runDir,
				workspace: repo,
				topology: "evolution",
				controlMode: "eval",
				goal: { title: "Maximize combined_score", text: "Optimize opt_a.txt and opt_b.txt and fuse them." },
				verifier: {
					name: "ab-sum",
					version: "1.0.0",
					scopes: ["deliverable"],
					defaultScope: "deliverable",
					async check({ workspace }) {
						const a = Number(readFileSync(join(workspace, "opt_a.txt"), "utf8").trim()) || 0;
						const b = Number(readFileSync(join(workspace, "opt_b.txt"), "utf8").trim()) || 0;
						const score = Number((a + b).toFixed(4));
						return { status: score >= 0.99 ? "passed" : "failed", score, message: `a=${a}, b=${b}` };
					},
				},
				store,
				router,
			});

			try {
				const out = await os.execute(evolutionTopology({ estimateBounds: true, controlMode: "eval" }));
				expect(out.status).toBe("done");
				expect(out.nominatedFindingId).toBeTruthy();

				// 1. Serial Phase-0 Roofline ran STRICTLY BEFORE Root Director seeded families!
				expect(callOrder[0]).toBe("phase0-bound-analyst");
				expect(callOrder[1]).toBe("root-director");
				expect(directorSawRooflineBeforeSeeding).toBe(true);

				// 2. Recursive Child Director spawned depth=2 leaf worker with zero spawn tools on 1-slot pool
				expect(subDirectorLeafHadNoSpawnTools).toBe(true);

				// 3. Real git diff inspection & code-level crossover with Partner B detached ref
				expect(inspectedRealGitDiff).toBe(true);
				expect(crossoverSawPartnerBRef).toBe(true);

				const xovDone = store.events("run-evo-v4", { types: ["evolution.crossover_completed"] });
				expect(xovDone.length).toBe(1);
				expect(xovDone[0]!.data.beatBothParents).toBe(true);
				expect(Number(xovDone[0]!.data.childScore)).toBeCloseTo(1.0, 3);

				const famLaunched = store.events("run-evo-v4", { types: ["evolution.family_launched"] });
				expect(famLaunched.length).toBeGreaterThanOrEqual(3);
			} finally {
				await os.dispose();
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(runDir, { recursive: true, force: true });
		}
	});

	it("composes nested topologies via unbounded spawn_topology and emits topology.spawned / topology.completed", async () => {
		const repo = initTempGitRepo({ "part_x.txt": "base\n" });
		const runDir = mkdtempSync(join(tmpdir(), "onepiece-v4-subtopo-"));
		try {
			const driver = makeScriptedDriver(async (spec, prompt) => {
				const ctx = {
					runId: spec.runId,
					agentId: spec.agentId,
					role: spec.role,
					workspace: spec.workspace,
					signal: new AbortController().signal,
				};
				if (spec.role === "planner") {
					const spawnTopo = spec.tools?.find((t) => t.name === "spawn_topology")!;
					const awaitTool = spec.tools?.find((t) => t.name === "await_agents")!;
					expect(spawnTopo).toBeDefined();
					const res = await spawnTopo.execute(
						{
							topology: "substrate-peers",
							goal: "Solve part_x.txt via nested substrate-peers sub-topology",
						},
						ctx,
					);
					const awaited = await awaitTool.execute({ mode: "all" }, ctx);
					return `Composed sub-topology finished: ${res.text}\n${awaited.text}`;
				}
				// Sub-topology worker
				if (prompt.includes("part_x.txt") || spec.role === "worker") {
					writeFileSync(join(spec.workspace, "part_x.txt"), "solved-by-subtopo\n");
				}
				return "Sub-topology worker edited part_x.txt";
			});

			const store = new MemoryStore();
			const router = new DriverQuotaRouter({
				drivers: [{ driver, config: { id: "scripted-v4", kind: "pi-in-process", maxConcurrent: 4 } }],
				roles: { default: ["scripted-v4"], planner: ["scripted-v4"], worker: ["scripted-v4"] },
			});
			const os = await SwarmOS.create({
				runId: "run-subtopo",
				runDir,
				workspace: repo,
				topology: "recursive-planners",
				goal: { title: "Compose Sub-Topology", text: "Solve part_x.txt" },
				verifier: {
					name: "x-check",
					version: "1.0.0",
					scopes: ["deliverable"],
					defaultScope: "deliverable",
					async check({ workspace }) {
						const ok = readFileSync(join(workspace, "part_x.txt"), "utf8").trim() === "solved-by-subtopo";
						return { status: ok ? "passed" : "failed", score: ok ? 1 : 0, message: ok ? "ok" : "no" };
					},
				},
				store,
				router,
			});

			try {
				const out = await os.execute(recursivePlannersTopology());
				expect(out.status).toBe("done");
				expect(out.nominatedFindingId).toBeTruthy();
				expect(store.events("run-subtopo", { types: ["topology.spawned"] }).length).toBe(1);
				expect(store.events("run-subtopo", { types: ["topology.completed"] }).length).toBe(1);
				expect(readFileSync(join(os.worktrees.trunkPath, "part_x.txt"), "utf8").trim()).toBe("solved-by-subtopo");
			} finally {
				await os.dispose();
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(runDir, { recursive: true, force: true });
		}
	});

	it("keeps adaptive Meta-Router prompts domain-unbiased and pivots mid-flight via LiveMorphWatchdog on consecutive un-repaired rollbacks", async () => {
		const repo = initTempGitRepo({ "target.txt": "0\n" });
		const runDir = mkdtempSync(join(tmpdir(), "onepiece-v4-morph-"));
		const decisionPrompts: string[] = [];

		const store = new MemoryStore();
		try {
			const decisionClient = new MockDecisionClient((req): Record<string, any> => {
				decisionPrompts.push(String(req.state) + "\n" + JSON.stringify(req.questions));
				if (req.questions.initial_topology) {
					return {
						initial_topology: { type: "choice", choice: "substrate-peers", confidence: 0.85 },
						enable_wave1_field_guide: { type: "noul", noul: 0.1, confidence: 0.8 },
						enable_llm_dreaming: { type: "noul", noul: 0.1, confidence: 0.8 },
						enable_board: { type: "noul", noul: 0.9, confidence: 0.9 },
						estimate_first_principles_bound: { type: "noul", noul: 0.1, confidence: 0.8 },
						initial_width_tier: { type: "choice", choice: "narrow", confidence: 0.8 },
					};
				}
				// LiveMorphWatchdog distress call -> pivot mid-flight to evolution!
				return {
					should_pivot_to_evolution: { type: "noul", noul: 0.91, confidence: 0.88 },
					should_widen_with_recursive_planners: { type: "noul", noul: 0.12, confidence: 0.8 },
				};
			});

			let osRef: SwarmOS | undefined;
			const driver = makeScriptedDriver(async (spec) => {
				const handle = store.get("agents", spec.agentId)?.handle ?? "";
				if (handle.startsWith("peer-")) {
					// Emit 2 consecutive un-repaired semantic rollbacks to trigger LiveMorphWatchdog mid-flight!
					if (handle === "peer-1" && osRef) {
						osRef.bus.emit(osRef.runId, "refinery.semantic_regression", { taskId: "t1", branch: "b1", reason: "regression", rolledBack: true, repaired: false });
						osRef.bus.emit(osRef.runId, "refinery.semantic_regression", { taskId: "t2", branch: "b2", reason: "regression", rolledBack: true, repaired: false });
					}
					await new Promise((r) => setTimeout(r, 150));
					return "stalled peer";
				}
				// After live morph into evolution, solve target.txt!
				writeFileSync(join(spec.workspace, "target.txt"), "1\n");
				return "Solved after live morph!";
			});

			const router = new DriverQuotaRouter({
				drivers: [{ driver, config: { id: "scripted-v4", kind: "pi-in-process", maxConcurrent: 4 } }],
				roles: { default: ["scripted-v4"], planner: ["scripted-v4"], worker: ["scripted-v4"] },
			});
			const os = await SwarmOS.create({
				runId: "run-live-morph",
				runDir,
				workspace: repo,
				topology: "adaptive",
				controlMode: "eval",
				budget: { wallSeconds: 30 },
				goal: { title: "Live Morph Test", text: "Solve target.txt" },
				verifier: {
					name: "target-check",
					version: "1.0.0",
					scopes: ["deliverable"],
					defaultScope: "deliverable",
					async check({ workspace }) {
						const ok = readFileSync(join(workspace, "target.txt"), "utf8").trim() === "1";
						return { status: ok ? "passed" : "failed", score: ok ? 1 : 0, message: ok ? "ok" : "no" };
					},
				},
				decisionClient,
				store,
				router,
			});
			osRef = os;

			try {
				const out = await os.execute(adaptiveTopology({ peers: 2, generations: 1, enableMidRunMorph: true }));
				expect(out.nominatedFindingId).toBeTruthy();

				// 1. Initial Meta-Router prompt has ZERO task-domain bias or heuristic baseline leak!
				const initialPrompt = decisionPrompts[0] ?? "";
				expect(initialPrompt).not.toContain("Heuristic Baseline Recommendation");
				expect(initialPrompt).not.toContain("repo migrations");
				expect(initialPrompt).not.toContain("scalar optimization");

				// 2. LiveMorphWatchdog fired mid-flight (`live: true`) -> pivoted substrate-peers -> evolution!
				const morphEvents = store.events("run-live-morph", { types: ["adaptive.morphed"] });
				expect(morphEvents.length).toBeGreaterThanOrEqual(1);
				expect(morphEvents[0]!.data.live).toBe(true);
				expect(morphEvents[0]!.data.from).toBe("substrate-peers");
				expect(morphEvents[0]!.data.to).toBe("evolution");
			} finally {
				await os.dispose();
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(runDir, { recursive: true, force: true });
		}
	});

	it("Gen-14 Fix A: advances partial multi-ticket trunk ratchet on semantic repair when repScore > bestGreenScore", async () => {
		const repo = initTempGitRepo({
			"shared.txt": "base-a\nbase-b\n",
			"ticket_c.txt": "base-c\n",
		});
		const runDir = mkdtempSync(join(tmpdir(), "onepiece-v4-repair-"));
		try {
			const driver = makeScriptedDriver(async (spec) => {
				// Integrator resolves conflict on shared.txt combining BOTH ticket A and ticket B (partial 0.67 since ticket C still base)
				if (spec.role === "integrator") {
					writeFileSync(join(spec.workspace, "shared.txt"), "solved-a\nsolved-b\n");
					return "Resolved conflict cleanly preserving both A and B.";
				}
				return "ok";
			});
			const store = new MemoryStore();
			const router = new DriverQuotaRouter({
				drivers: [{ driver, config: { id: "scripted-v4", kind: "pi-in-process", maxConcurrent: 2 } }],
				roles: { default: ["scripted-v4"], integrator: ["scripted-v4"] },
			});
			const os = await SwarmOS.create({
				runId: "run-partial-repair",
				runDir,
				workspace: repo,
				topology: "pull-refinery",
				goal: { title: "Multi-ticket repair", text: "Solve A, B, C" },
				verifier: {
					name: "abc-partial",
					version: "1.0.0",
					scopes: ["deliverable"],
					defaultScope: "deliverable",
					async check({ workspace }) {
						const shared = readFileSync(join(workspace, "shared.txt"), "utf8");
						const c = readFileSync(join(workspace, "ticket_c.txt"), "utf8");
						const hasA = shared.includes("solved-a");
						const hasB = shared.includes("solved-b");
						const hasC = c.includes("solved-c");
						const score = Number((((hasA ? 1 : 0) + (hasB ? 1 : 0) + (hasC ? 1 : 0)) / 3).toFixed(4));
						return { status: hasA && hasB && hasC ? "passed" : "failed", score, message: `a=${hasA},b=${hasB},c=${hasC}` };
					},
				},
				store,
				router,
			});

			try {
				const pipeline = new IntegrationPipeline(os);
				const wtA = os.worktrees.create("agt-a");
				writeFileSync(join(wtA.path, "shared.txt"), "solved-a\nbase-b\n");
				os.worktrees.commitWip(wtA.path, "ticket A");

				const wtB = os.worktrees.create("agt-b");
				writeFileSync(join(wtB.path, "shared.txt"), "base-a\nsolved-b\n");
				os.worktrees.commitWip(wtB.path, "ticket B");

				const sig = new AbortController().signal;
				const r1 = await pipeline.integrateBranch({
					branch: wtA.branch,
					authorAgentId: "agt-a",
					label: "ticket-A",
					goal: "Solve A, B, C",
					enableConflictResolution: true,
					enableSemanticRepair: true,
					signal: sig,
				});
				expect(r1.merged).toBe(true);
				expect(r1.finding?.score).toBeCloseTo(0.3333, 3);

				// Ticket B conflicts on shared.txt; semantic repair raises partial score 0.3333 -> 0.6667 (still status="failed")
				const r2 = await pipeline.integrateBranch({
					branch: wtB.branch,
					authorAgentId: "agt-b",
					label: "ticket-B",
					goal: "Solve A, B, C",
					enableConflictResolution: true,
					enableSemanticRepair: true,
					signal: sig,
				});
				expect(r2.merged).toBe(true);
				expect(r2.repaired).toBe(true);
				expect(r2.finding?.score).toBeCloseTo(0.6667, 3);
				expect(readFileSync(join(os.worktrees.trunkPath, "shared.txt"), "utf8")).toBe("solved-a\nsolved-b\n");
			} finally {
				await os.dispose();
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(runDir, { recursive: true, force: true });
		}
	});

	it("Gen-14 Fix B: Two-Step Mechanical Closeout Salvage (Step 1 zero-LLM clean-merge salvage; Step 2 verified partialFallback keeping accepted=false)", async () => {
		// Step 1: Two disjoint unmerged worker branches clean-merged at closeout with 0 LLM turns -> accepted 1.0!
		const repo1 = initTempGitRepo({ "a.txt": "0\n", "b.txt": "0\n" });
		const runDir1 = mkdtempSync(join(tmpdir(), "onepiece-v4-salvage1-"));
		let driverTurns = 0;
		try {
			const driver = makeScriptedDriver(async () => {
				driverTurns += 1;
				return "done";
			});
			const store = new MemoryStore();
			const router = new DriverQuotaRouter({
				drivers: [{ driver, config: { id: "scripted-v4", kind: "pi-in-process", maxConcurrent: 2 } }],
				roles: { default: ["scripted-v4"] },
			});
			const os = await SwarmOS.create({
				runId: "run-salvage-merge",
				runDir: runDir1,
				workspace: repo1,
				topology: "custom-salvage",
				goal: { title: "Salvage merge", text: "Solve a and b" },
				verifier: {
					name: "ab-salvage",
					version: "1.0.0",
					scopes: ["deliverable"],
					defaultScope: "deliverable",
					async check({ workspace }) {
						const a = readFileSync(join(workspace, "a.txt"), "utf8").trim() === "1";
						const b = readFileSync(join(workspace, "b.txt"), "utf8").trim() === "1";
						return { status: a && b ? "passed" : "failed", score: (a ? 0.5 : 0) + (b ? 0.5 : 0), message: `a=${a},b=${b}` };
					},
				},
				store,
				router,
			});

			const topo1: TopologyPlugin = {
				name: "custom-salvage",
				description: "Leaves 2 disjoint committed worker branches unmerged at cutoff",
				async run(api) {
					const w1 = await api.spawnWorker({ role: "worker", handle: "w1" });
					writeFileSync(join(w1.workspace, "a.txt"), "1\n");
					api.worktrees.commitWip(w1.workspace, "worker 1 solved a");
					await w1.close();

					const w2 = await api.spawnWorker({ role: "worker", handle: "w2" });
					writeFileSync(join(w2.workspace, "b.txt"), "1\n");
					api.worktrees.commitWip(w2.workspace, "worker 2 solved b");
					await w2.close();
					// Intentionally exit BEFORE merging into trunk!
					return { status: "stopped", summary: "Wall cutoff before Phase-4 merge" };
				},
			};

			try {
				const out = await os.execute(topo1);
				expect(driverTurns).toBe(0); // Zero LLM turns used during closeout salvage!
				expect(out.nominatedFindingId).toBeTruthy();
				const finding = store.get("findings", out.nominatedFindingId!)!;
				expect(finding.status).toBe("accepted");
				expect(finding.score).toBe(1.0);
				const nomEv = store.events("run-salvage-merge", { types: ["run.nominated"] })[0];
				expect(nomEv?.data.partialFallback).toBeUndefined();
			} finally {
				await os.dispose();
			}
		} finally {
			rmSync(repo1, { recursive: true, force: true });
			rmSync(runDir1, { recursive: true, force: true });
		}

		// Step 2: Verified partial fallback when no accepted finding exists (keeps status="rejected" for honest falseCertification!)
		const repo2 = initTempGitRepo({ "p.txt": "0\n" });
		const runDir2 = mkdtempSync(join(tmpdir(), "onepiece-v4-salvage2-"));
		try {
			const driver = makeScriptedDriver(async () => "done");
			const store = new MemoryStore();
			const router = new DriverQuotaRouter({
				drivers: [{ driver, config: { id: "scripted-v4", kind: "pi-in-process", maxConcurrent: 2 } }],
				roles: { default: ["scripted-v4"] },
			});
			const os = await SwarmOS.create({
				runId: "run-salvage-partial",
				runDir: runDir2,
				workspace: repo2,
				topology: "custom-partial",
				goal: { title: "Partial fallback", text: "Reach 1.0" },
				verifier: {
					name: "p-partial",
					version: "1.0.0",
					scopes: ["deliverable"],
					defaultScope: "deliverable",
					async check({ workspace }) {
						const v = Number(readFileSync(join(workspace, "p.txt"), "utf8").trim()) || 0;
						return { status: v >= 1.0 ? "passed" : "failed", score: v, message: `v=${v}` };
					},
				},
				store,
				router,
			});

			const topo2: TopologyPlugin = {
				name: "custom-partial",
				description: "Submits partial verified 0.65 finding only",
				async run(api, { signal }) {
					const w = await api.spawnWorker({ role: "worker", handle: "w-partial" });
					writeFileSync(join(w.workspace, "p.txt"), "0.65\n");
					await api.trust.submitFinding(
						{
							agentId: w.agent.id,
							workspace: w.workspace,
							claim: "Partial progress 0.65",
							summary: "Got 65% passing",
							level: "empirical",
							score: 0.65,
						},
						signal,
					);
					await w.close();
					return { status: "stopped", summary: "Hit cutoff at 0.65" };
				},
			};

			try {
				const out = await os.execute(topo2);
				expect(out.nominatedFindingId).toBeTruthy();
				const finding = store.get("findings", out.nominatedFindingId!)!;
				expect(finding.status).toBe("needs_work"); // Never falsely upgraded to accepted!
				expect(finding.score).toBe(0.65);
				const nomEv = store.events("run-salvage-partial", { types: ["run.nominated"] })[0];
				expect(nomEv?.data.partialFallback).toBe(true);
			} finally {
				await os.dispose();
			}
		} finally {
			rmSync(repo2, { recursive: true, force: true });
			rmSync(runDir2, { recursive: true, force: true });
		}
	});
});
