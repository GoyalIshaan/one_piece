import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	MemoryStore,
	type WorkerDriver,
	type WorkerSession,
	type WorkerSpawnSpec,
} from "@one-piece/core";
import { DriverQuotaRouter, MockDecisionClient } from "@one-piece/drivers";
import { recursivePlannersTopology, SwarmOS } from "../src/index.ts";

function initTempGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "onepiece-v3-rec-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@onepiece.dev"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "OnePieceTest"], { cwd: dir });
	writeFileSync(join(dir, "README.md"), "# Recursive Forest Repo\n");
	writeFileSync(join(dir, "part_a.txt"), "base-a\n");
	writeFileSync(join(dir, "part_b.txt"), "base-b\n");
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
	return dir;
}

function makeScriptedDriver(
	onTurn: (spec: WorkerSpawnSpec, prompt: string) => Promise<string>,
): WorkerDriver {
	return {
		id: "scripted-v3",
		kind: "pi-in-process",
		capabilities: { supportsSteer: true, supportsResume: true, supportsOutputSchema: true, supportsMcpHttp: false },
		async healthCheck() {
			return { ok: true, driverId: "scripted-v3", kind: "pi-in-process" };
		},
		async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
			return {
				driverId: "scripted-v3",
				async runTurn(prompt: string) {
					const text = await onTurn(spec, prompt);
					return { status: "completed", finalText: text, usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } };
				},
				async close() {},
			};
		},
	};
}

describe("v3 Two-Role Recursive Planner Forest, Passive Snapshots & Two-Tier Board Triage", () => {
	it("lets Planners recursively spawn parallel Planners + Workers, denies Worker spawning, captures passive snapshots, and promotes high-novelty subtree posts via Jev triage", async () => {
		const repo = initTempGitRepo();
		const runDir = mkdtempSync(join(tmpdir(), "onepiece-v3-run-"));
		const workerToolsObserved: string[][] = [];
		const plannerToolsObserved: string[][] = [];

		try {
			const decisionClient = new MockDecisionClient((req) => {
				const out: Record<string, any> = {};
				const stateLines = String(req.state).split("\n");
				for (const key of Object.keys(req.questions)) {
					const m = /^p(\d+)_/.exec(key);
					const postLine = m ? (stateLines.find((l) => l.startsWith(`POST_${m[1]} `)) ?? "") : "";
					const isBreakthrough = postLine.includes("BREAKTHROUGH");
					if (key.endsWith("_broadcast") || key.endsWith("_novel")) {
						out[key] = { type: "noul", noul: isBreakthrough ? 0.92 : 0.15, confidence: 0.88 };
					} else if (key.endsWith("_crossover")) {
						out[key] = { type: "noul", noul: isBreakthrough ? 0.81 : 0.1, confidence: 0.8 };
					} else {
						out[key] = { type: "noul", noul: 0.2, confidence: 0.7 };
					}
				}
				return out;
			});

			const preciseDriver = makeScriptedDriver(async (spec, prompt) => {
				const toolNames = (spec.tools ?? []).map((t) => t.name);
				const ctx = {
					runId: spec.runId,
					agentId: spec.agentId,
					role: spec.role,
					workspace: spec.workspace,
					signal: new AbortController().signal,
				};

				if (spec.role === "planner") {
					plannerToolsObserved.push(toolNames);
					const spawnTool = spec.tools?.find((t) => t.name === "spawn_agents")!;
					const awaitTool = spec.tools?.find((t) => t.name === "await_agents")!;
					const publishTool = spec.tools?.find((t) => t.name === "board_publish")!;

					if (prompt.includes("Goal:")) {
						await publishTool.execute(
							{ topic: "forest-plan", kind: "hypothesis", summary: "Root split into planner-sub-a + worker-leaf-b" },
							ctx,
						);
						await spawnTool.execute(
							{
								agents: [
									{ role: "planner", handle: "planner-sub-a", prompt: "Own part_a.txt recursively" },
									{ role: "worker", handle: "worker-leaf-b", prompt: "Edit part_b.txt" },
								],
							},
							ctx,
						);
						const awaited = await awaitTool.execute({ mode: "all" }, ctx);
						return `Root done: ${awaited.text}`;
					}
					await spawnTool.execute(
						{
							agents: [{ role: "worker", handle: "worker-leaf-a", prompt: "Edit part_a.txt" }],
						},
						ctx,
					);
					const awaited = await awaitTool.execute({ mode: "all" }, ctx);
					return `Sub-planner done: ${awaited.text}`;
				}

				workerToolsObserved.push(toolNames);
				const publishTool = spec.tools?.find((t) => t.name === "board_publish")!;
				if (prompt.includes("part_a.txt")) {
					writeFileSync(join(spec.workspace, "part_a.txt"), "solved-a\n");
					await publishTool.execute(
						{ topic: "a-note", kind: "discovery", summary: "BREAKTHROUGH invariant found in part_a" },
						ctx,
					);
				} else {
					writeFileSync(join(spec.workspace, "part_b.txt"), "solved-b\n");
					await publishTool.execute(
						{ topic: "b-note", kind: "update", summary: "Routine local progress on part_b" },
						ctx,
					);
				}
				// Intentionally do NOT call `report_finding` — verify passive snapshot capture!
				return "Edited file cleanly without manual report_finding.";
			});

			const store = new MemoryStore();
			const router = new DriverQuotaRouter({
				drivers: [{ driver: preciseDriver, config: { id: "scripted-v3", kind: "pi-in-process", maxConcurrent: 8 } }],
				roles: { default: ["scripted-v3"], planner: ["scripted-v3"], worker: ["scripted-v3"], integrator: ["scripted-v3"] },
				concurrencyMode: "physics",
			});

			const os = await SwarmOS.create({
				runId: "run-rec-1",
				runDir,
				workspace: repo,
				topology: "recursive-planners",
				goal: { title: "Solve A and B", text: "Update both part_a.txt and part_b.txt" },
				verifier: {
					name: "ab-check",
					version: "1.0.0",
					scopes: ["deliverable"],
					defaultScope: "deliverable",
					async check({ workspace }) {
						const a = readFileSync(join(workspace, "part_a.txt"), "utf8").trim() === "solved-a";
						const b = readFileSync(join(workspace, "part_b.txt"), "utf8").trim() === "solved-b";
						const score = (a ? 0.5 : 0) + (b ? 0.5 : 0);
						return { status: a && b ? "passed" : "failed", score, message: `a=${a}, b=${b}` };
					},
				},
				decisionClient,
				store,
				router,
			});

			try {
				const out = await os.execute(recursivePlannersTopology());
				expect(out.status).toBe("done");
				expect(out.nominatedFindingId).toBeTruthy();

				// 1. Both Planners had spawn_agents + board_publish; NO Worker ever had spawn tools!
				expect(plannerToolsObserved.length).toBe(2);
				for (const pTools of plannerToolsObserved) {
					expect(pTools).toContain("spawn_agents");
					expect(pTools).toContain("await_agents");
					expect(pTools).toContain("board_publish");
				}
				expect(workerToolsObserved.length).toBe(2);
				for (const wTools of workerToolsObserved) {
					expect(wTools).not.toContain("spawn_agents");
					expect(wTools).not.toContain("spawn_task");
					expect(wTools).toContain("board_publish");
				}

				// 2. Trunk mechanically assembled BOTH workers' passively snapshotted branches!
				expect(readFileSync(join(os.worktrees.trunkPath, "part_a.txt"), "utf8").trim()).toBe("solved-a");
				expect(readFileSync(join(os.worktrees.trunkPath, "part_b.txt"), "utf8").trim()).toBe("solved-b");

				// 3. Two-tier Board triage: BREAKTHROUGH post promoted to global; routine post stays subtree-local!
				const posts = store.list("posts", { runId: "run-rec-1" });
				const postA = posts.find((p) => p.topic === "a-note")!;
				const postB = posts.find((p) => p.topic === "b-note")!;
				expect(postA.visibility).toBe("global");
				expect(postA.labels?.["os:promoted"]).toBe("true");
				expect(postA.labels?.["os:crossover_candidate"]).toBe("true");
				expect(postB.visibility).toBe("subtree");
				expect(postB.labels?.["os:promoted"]).toBeUndefined();

				// Digest for another subtree sees global + promoted postA, NOT routine subtree-local postB!
				const foreignDigest = os.board.digest("run-rec-1", { subtreeId: "unrelated-subtree" });
				expect(foreignDigest).toContain("a-note");
				expect(foreignDigest).not.toContain("b-note");
				expect(foreignDigest).toContain("promoted=1");
			} finally {
				await os.dispose();
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(runDir, { recursive: true, force: true });
		}
	});
});
