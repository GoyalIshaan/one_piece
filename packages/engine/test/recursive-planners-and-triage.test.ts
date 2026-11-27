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
import { DriverQuotaRouter } from "@one-piece/drivers";
import { recursivePlannersTopology, SwarmOS } from "../src/index.ts";

function initTempGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "onepiece-v4-rec-"));
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
		id: "scripted-v4",
		kind: "pi-in-process",
		capabilities: { supportsSteer: true, supportsResume: true, supportsOutputSchema: true, supportsMcpHttp: false },
		async healthCheck() {
			return { ok: true, driverId: "scripted-v4", kind: "pi-in-process" };
		},
		async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
			return {
				driverId: "scripted-v4",
				async runTurn(prompt: string) {
					const text = await onTurn(spec, prompt);
					return { status: "completed", finalText: text, usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } };
				},
				async close() {},
			};
		},
	};
}

describe("v4 Two-Role Recursive Planner Forest, Passive Snapshots & Board v3 Planner Crossposting", () => {
	it("lets Planners recursively spawn parallel Planners + Workers, denies Worker spawning, surfaces child #team-* posts on await_agents, and promotes breakthroughs via Planner crossposting to #swarm", async () => {
		const repo = initTempGitRepo();
		const runDir = mkdtempSync(join(tmpdir(), "onepiece-v4-run-"));
		const workerToolsObserved: string[][] = [];
		const plannerToolsObserved: string[][] = [];
		let awaitTextSawChildPost = false;

		try {
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
					const postTool = spec.tools?.find((t) => t.name === "board_post")!;

					if (prompt.includes("Goal:")) {
						await postTool.execute(
							{ channel: "swarm", topic: "forest-plan", title: "Root split", text: "Root split into planner-sub-a + worker-leaf-b" },
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
					// Board v3: await_agents surfaces child #team-* posts so Planner can intentionally crosspost verified breakthroughs!
					const postMatch = /\[(post-[a-zA-Z0-9_-]+)\][^\n]*BREAKTHROUGH/.exec(awaited.text);
					if (postMatch) {
						awaitTextSawChildPost = true;
						await postTool.execute(
							{
								channel: "swarm",
								quote_post_id: postMatch[1],
								topic: "a-note",
								title: "Crossposted: BREAKTHROUGH invariant in part_a",
								text: "Verified worker-leaf-a breakthrough in part_a.txt; broadcasting to #swarm.",
							},
							ctx,
						);
					}
					return `Sub-planner done: ${awaited.text}`;
				}

				workerToolsObserved.push(toolNames);
				const postTool = spec.tools?.find((t) => t.name === "board_post")!;
				if (prompt.includes("part_a.txt")) {
					writeFileSync(join(spec.workspace, "part_a.txt"), "solved-a\n");
					await postTool.execute(
						{ topic: "a-note", title: "BREAKTHROUGH invariant found in part_a", text: "BREAKTHROUGH invariant found in part_a" },
						ctx,
					);
				} else {
					writeFileSync(join(spec.workspace, "part_b.txt"), "solved-b\n");
					await postTool.execute(
						{ topic: "b-note", title: "Routine local progress on part_b", text: "Routine local progress on part_b" },
						ctx,
					);
				}
				// Intentionally do NOT call `report_finding` — verify passive snapshot capture!
				return "Edited file cleanly without manual report_finding.";
			});

			const store = new MemoryStore();
			const router = new DriverQuotaRouter({
				drivers: [{ driver: preciseDriver, config: { id: "scripted-v4", kind: "pi-in-process", maxConcurrent: 8 } }],
				roles: { default: ["scripted-v4"], planner: ["scripted-v4"], worker: ["scripted-v4"], integrator: ["scripted-v4"] },
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
				store,
				router,
			});

			try {
				const out = await os.execute(recursivePlannersTopology());
				expect(out.status).toBe("done");
				expect(out.nominatedFindingId).toBeTruthy();

				// 1. Both Planners had spawn_agents + spawn_topology + board_post + board_edit; NO Worker ever had spawn tools!
				expect(plannerToolsObserved.length).toBe(2);
				for (const pTools of plannerToolsObserved) {
					expect(pTools).toContain("spawn_agents");
					expect(pTools).toContain("await_agents");
					expect(pTools).toContain("spawn_topology");
					expect(pTools).toContain("board_post");
					expect(pTools).toContain("board_edit");
				}
				expect(workerToolsObserved.length).toBe(2);
				for (const wTools of workerToolsObserved) {
					expect(wTools).not.toContain("spawn_agents");
					expect(wTools).not.toContain("spawn_topology");
					expect(wTools).not.toContain("spawn_task");
					expect(wTools).toContain("board_post");
					expect(wTools).toContain("board_edit");
				}

				// 2. Trunk mechanically assembled BOTH workers' passively snapshotted branches!
				expect(readFileSync(join(os.worktrees.trunkPath, "part_a.txt"), "utf8").trim()).toBe("solved-a");
				expect(readFileSync(join(os.worktrees.trunkPath, "part_b.txt"), "utf8").trim()).toBe("solved-b");

				// 3. Board v3: await_agents surfaced child #team-* post; Planner crossposted BREAKTHROUGH to #swarm, while routine post stayed #team-*!
				expect(awaitTextSawChildPost).toBe(true);
				const posts = store.list("posts", { runId: "run-rec-1" });
				const postA = posts.find((p) => p.topic === "a-note" && !p.quotedPostId)!;
				const crosspostA = posts.find((p) => p.quotedPostId === postA.id)!;
				const postB = posts.find((p) => p.topic === "b-note")!;
				expect(postA.channel).toMatch(/^team-/);
				expect(crosspostA.channel).toBe("swarm");
				expect(crosspostA.labels?.["os:promoted"]).toBe("true");
				expect(postB.channel).toMatch(/^team-/);
				expect(postB.visibility).toBe("subtree");
				expect(postB.labels?.["os:promoted"]).toBeUndefined();

				const promotedEvs = store.events("run-rec-1", { types: ["board.promoted"] });
				expect(promotedEvs.length).toBe(1);
				expect(promotedEvs[0]!.data.postId).toBe(crosspostA.id);
				expect(promotedEvs[0]!.data.quotedPostId).toBe(postA.id);

				// Digest for an unrelated subtree sees #swarm crosspostA, NOT routine subtree-local postB!
				const foreignDigest = os.board.digest("run-rec-1", { subtreeId: "unrelated-subtree" });
				expect(foreignDigest).toContain("a-note");
				expect(foreignDigest).not.toContain("b-note");
				expect(foreignDigest).toContain("crossposts=1");
			} finally {
				await os.dispose();
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(runDir, { recursive: true, force: true });
		}
	});
});
