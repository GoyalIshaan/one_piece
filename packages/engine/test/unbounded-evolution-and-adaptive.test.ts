import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type DecisionAnswer,
	MemoryStore,
	type WorkerDriver,
	type WorkerSession,
	type WorkerSpawnSpec,
} from "@one-piece/core";
import { DriverQuotaRouter, MockDecisionClient } from "@one-piece/drivers";
import { adaptiveTopology, evolutionTopology, SwarmOS } from "../src/index.ts";

function initTempGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "onepiece-v3-evo-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@onepiece.dev"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "OnePieceTest"], { cwd: dir });
	writeFileSync(join(dir, "SPEC.md"), "# Spec\n## Phase A\n## Phase B\n");
	writeFileSync(join(dir, "kernel.py"), "VALUE = 1\n");
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
	return dir;
}

function scriptedDriver(fn: (spec: WorkerSpawnSpec, prompt: string) => Promise<string>): WorkerDriver {
	return {
		id: "evo-sim",
		kind: "pi-in-process",
		capabilities: { supportsSteer: true, supportsResume: true, supportsOutputSchema: true, supportsMcpHttp: false },
		async healthCheck() {
			return { ok: true, driverId: "evo-sim", kind: "pi-in-process" };
		},
		async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
			return {
				driverId: "evo-sim",
				async runTurn(prompt: string) {
					const text = await fn(spec, prompt);
					return { status: "completed", finalText: text, usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 } };
				},
				async close() {},
			};
		},
	};
}

describe("v3 Unbounded Evolution, First-Principles Bound Analyst & Jev Adaptive Meta-Router", () => {
	it("runs unbounded evolution with Phase-0 First-Principles Bound Analyst and stops via coalesce Researcher Checkpoint near ceiling", async () => {
		const repo = initTempGitRepo();
		const runDir = mkdtempSync(join(tmpdir(), "onepiece-v3-evorun-"));
		let genSeen = 0;

		try {
			const driver = scriptedDriver(async (spec, prompt) => {
				if (spec.role === "planner") {
					// First-Principles Bound Analyst returns structured ceiling = 10.0, stop@92%
					return JSON.stringify({
						metric_name: "throughput_x",
						higher_is_better: true,
						estimated_ceiling: 10.0,
						derivation_summary: "Memory bandwidth limit caps speedup at 10x.",
						key_assumptions: ["FP16 weights", "Single node DRAM bandwidth"],
						stopping_fraction: 0.92,
						confidence: 0.9,
					});
				}
				const m = /Generation (\d+)/.exec(prompt);
				const gen = m ? Number(m[1]) : 1;
				genSeen = Math.max(genSeen, gen);
				// Gen 1 -> 6.0, Gen 2 -> 9.5 (>= 92% of 10.0 ceiling -> triggers coalesce checkpoint!)
				const val = gen === 1 ? 6.0 : 9.5;
				writeFileSync(join(spec.workspace, "kernel.py"), `VALUE = ${val}\n`);
				return `Improved throughput to ${val}x`;
			});

			const store = new MemoryStore();
			const router = new DriverQuotaRouter({
				drivers: [{ driver, config: { id: "evo-sim", kind: "pi-in-process", maxConcurrent: 4 } }],
				roles: { default: ["evo-sim"], planner: ["evo-sim"], worker: ["evo-sim"] },
			});

			const os = await SwarmOS.create({
				runId: "run-unbounded-1",
				runDir,
				workspace: repo,
				topology: "evolution",
				goal: { title: "Maximize kernel speedup", text: "Optimize kernel.py for maximum throughput_x" },
				verifier: {
					name: "kernel-bench",
					version: "1.0.0",
					scopes: ["deliverable"],
					defaultScope: "deliverable",
					async check({ workspace }) {
						const raw = (await import("node:fs")).readFileSync(join(workspace, "kernel.py"), "utf8");
						const match = /VALUE\s*=\s*([0-9.]+)/.exec(raw);
						const score = match ? Number(match[1]) : 1;
						return { status: "passed", score, message: `throughput=${score}x` };
					},
				},
				store,
				router,
			});

			try {
				const out = await os.execute(
					evolutionTopology({
						generations: "unbounded",
						populationPerGen: 1,
						estimateBounds: true,
						checkpointPolicy: "coalesce",
					}),
				);
				expect(out.status).toBe("done");
				expect(genSeen).toBe(2); // Stopped cleanly on Gen 2 instead of looping forever!
				expect(out.nominatedFindingId).toBeTruthy();

				const boundEvents = store.events("run-unbounded-1", { types: ["bound.estimated"] });
				expect(boundEvents.length).toBe(1);
				expect(boundEvents[0]?.data.estimatedCeiling).toBe(10);

				const ckptEvents = store.events("run-unbounded-1", { types: ["researcher.checkpoint"] });
				expect(ckptEvents.length).toBe(1);
				expect(ckptEvents[0]?.data.action).toBe("coalesce");
				expect(ckptEvents[0]?.data.trigger).toBe("approaching_bound");

				// Bound estimate was published globally to Board v2
				const boundPosts = store.list("posts", { runId: "run-unbounded-1" }).filter((p) => p.kind === "bound_estimate");
				expect(boundPosts.length).toBe(1);
				expect(boundPosts[0]?.visibility).toBe("global");
			} finally {
				await os.dispose();
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(runDir, { recursive: true, force: true });
		}
	});

	it("uses Jev Adaptive Meta-Router to gate Wave-1 Field Guide OFF and morph mid-run from elastic-phase to evolution on failure", async () => {
		const repo = initTempGitRepo();
		const runDir = mkdtempSync(join(tmpdir(), "onepiece-v3-adapt-"));
		const workerSystemPrompts: string[] = [];

		try {
			const decisionClient = new MockDecisionClient((req): Record<string, DecisionAnswer> => {
				if (req.questions.initial_topology) {
					return {
						initial_topology: {
							type: "choice",
							choice: "elastic-phase",
							confidence: 0.9,
							probabilities: { "elastic-phase": 0.9, evolution: 0.1 },
						},
						// Gate Wave-1 Field Guide OFF (acting on clean A/B finding!)
						enable_wave1_field_guide: { type: "noul", noul: 0.1, confidence: 0.85 },
						enable_llm_dreaming: { type: "noul", noul: 0.2, confidence: 0.7 },
						enable_board: { type: "noul", noul: 0.85, confidence: 0.8 },
						estimate_first_principles_bound: { type: "noul", noul: 0.1, confidence: 0.8 },
						initial_width_tier: {
							type: "choice",
							choice: "narrow",
							confidence: 0.85,
							probabilities: { narrow: 0.85, balanced: 0.15 },
						},
					};
				}
				// Mid-run morph check after elastic-phase failed to pass verifier -> morph to evolution!
				return {
					should_pivot_to_evolution: { type: "noul", noul: 0.91, confidence: 0.88 },
					should_widen_with_recursive_planners: { type: "noul", noul: 0.15, confidence: 0.8 },
				};
			});

			const driver = scriptedDriver(async (spec, prompt) => {
				if (spec.systemPrompt) workerSystemPrompts.push(spec.systemPrompt);
				if (spec.role === "planner") {
					return JSON.stringify({
						lanes: [{ title: "Lane 1", description: "Try initial edit", owned_paths: ["kernel.py"], cross_contracts: [] }],
					});
				}
				if (prompt.includes("Generation ")) {
					// Morphed evolution phase succeeds!
					writeFileSync(join(spec.workspace, "kernel.py"), "VALUE = 42\n");
					return "Morphed evolution solved VALUE = 42";
				}
				// Initial elastic-phase attempt produces failing value = 2
				writeFileSync(join(spec.workspace, "kernel.py"), "VALUE = 2\n");
				return "Initial attempt VALUE = 2";
			});

			const store = new MemoryStore();
			const router = new DriverQuotaRouter({
				drivers: [{ driver, config: { id: "evo-sim", kind: "pi-in-process", maxConcurrent: 4 } }],
				roles: { default: ["evo-sim"], planner: ["evo-sim"], worker: ["evo-sim"], integrator: ["evo-sim"] },
			});

			const os = await SwarmOS.create({
				runId: "run-adapt-morph",
				runDir,
				workspace: repo,
				topology: "adaptive",
				goal: { title: "Reach VALUE 42", text: "Update kernel.py so VALUE == 42" },
				verifier: {
					name: "exact-42",
					version: "1.0.0",
					scopes: ["deliverable"],
					defaultScope: "deliverable",
					async check({ workspace }) {
						const raw = (await import("node:fs")).readFileSync(join(workspace, "kernel.py"), "utf8");
						const ok = /VALUE\s*=\s*42\b/.test(raw);
						return { status: ok ? "passed" : "failed", score: ok ? 1 : 0, message: ok ? "ok" : "not 42" };
					},
				},
				enableFieldGuide: true, // Started true, Jev Meta-Router should dynamically gate it OFF!
				decisionClient,
				store,
				router,
			});

			try {
				const out = await os.execute(adaptiveTopology({ peers: 2, enableSemanticRepair: false }));
				expect(out.status).toBe("done");
				expect(out.nominatedFindingId).toBeTruthy();
				expect(out.summary).toContain("morphed:evolution");

				// Verify Wave-1 Field Guide was gated OFF by Jev!
				expect(workerSystemPrompts.length).toBeGreaterThan(0);
				for (const sp of workerSystemPrompts) {
					expect(sp).not.toContain("# Swarm Field Guide");
				}

				// Verify decision.evaluated + adaptive.morphed events persisted in SQLite!
				const decEvents = store.events("run-adapt-morph", { types: ["decision.evaluated"] });
				expect(decEvents.some((e) => e.data.purpose === "adaptive_preflight_router")).toBe(true);
				expect(decEvents.some((e) => e.data.purpose === "adaptive_midrun_morph")).toBe(true);

				const morphEvents = store.events("run-adapt-morph", { types: ["adaptive.morphed"] });
				expect(morphEvents.length).toBe(1);
				expect(morphEvents[0]?.data.from).toBe("elastic-phase");
				expect(morphEvents[0]?.data.to).toBe("evolution");
			} finally {
				await os.dispose();
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(runDir, { recursive: true, force: true });
		}
	});
});
