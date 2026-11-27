import type { IntegrationBranchCandidate, SwarmOsApi, TopologyOutcome, TopologyPlugin } from "@one-piece/core";
import { IntegrationPipeline } from "../integration.ts";

export interface RecursivePlannersOptions {
	/** Enable semantic repair on mechanical closeout integration (default true). */
	enableSemanticRepair?: boolean;
	/** Enable LLM vs deterministic wave-boundary dreaming (default "deterministic"). */
	dreamingMode?: "deterministic" | "llm";
}

/**
 * Strict Two-Role Recursive Planner Forest Topology (`Planner` + `Worker`):
 * - Only two roles exist:
 *   1. `Planner`: search-space manager with `"read-write"` Board v2 access and first-class
 *      `spawn_agents` / `await_agents` / `steer_or_cancel_agent` tools to dynamically spawn
 *      arbitrary parallel or back-to-back child `Planner`s and leaf `Worker`s.
 *   2. `Worker`: focused leaf executor in an isolated git worktree (`canSpawn: false` enforced by OS).
 * - Concurrency is bounded strictly by budget and the PhysicsConcurrencyGovernor (no static `maxWorkers` cap).
 * - At closeout, all committed branches across the entire forest are mechanically assembled onto trunk
 *   via `IntegrationPipeline` with conflict resolution, semantic auto-repair, and monotonic rollback.
 */
export function recursivePlannersTopology(opts: RecursivePlannersOptions = {}): TopologyPlugin {
	const enableSemanticRepair = opts.enableSemanticRepair ?? true;

	return {
		name: "recursive-planners",
		description: "Strict 2-role recursive Planner/Worker search forest with Reddit/X Board v3 channels, composable spawn_topology, and verified trunk assembly.",
		async run(os: SwarmOsApi, { goal, rubric, signal, closeoutSignal }): Promise<TopologyOutcome> {
			if ((await os.waitIfPaused?.(signal)) === "coalescing") {
				return { status: "stopped", summary: "Recursive-Planners coalesced before launch." };
			}
			os.bus.emit(os.runId, "phase.changed", {
				to: "recursive-forest",
				reason: "Launching root recursive Planner with Board v3 read-write, Planner/Worker spawning, and composable spawn_topology",
			});

			const root = await os.spawnWorker({
				role: "planner",
				handle: "root-planner",
				subtreeId: "root",
				depth: 0,
				canSpawn: true,
				passiveSnapshotOnExit: true,
				cacheKeyPrefix: `${os.runId}:recursive-planner`,
				toolScope: {
					board: "read-write",
					defaultChannel: "swarm",
					artifacts: true,
					findings: true,
					tasks: false,
					nominate: false,
					scheduler: "auto",
					canSpawn: true,
					spawnAgents: true,
					spawnTopology: true,
					passiveSnapshotOnExit: true,
					subtreeId: "root",
					defaultPostVisibility: "global",
					codeMode: true,
				},
				systemPrompt: [
					"You are the root recursive Planner of a physics-bounded swarm operating in isolated git worktrees.",
					"There are strictly two roles: `planner` (recursive search-tree manager with Board read-write + spawning) and `worker` (leaf executor, cannot spawn).",
					"You may:",
					"1. Spawn multiple `planner` and/or `worker` agents in parallel or back-to-back via `spawn_agents(agents=[...])`, or compose any registered sub-topology via `spawn_topology(topology, goal)`.",
					"2. Collect child results reactively with `await_agents(mode='all'|'any')` and redirect/prune branches with `steer_or_cancel_agent`.",
					"3. Share discoveries and dead-ends via `board_post` (`#swarm` for global, `#team-<subtree>` for local); crosspost verified child findings from `#team-X` up to `#swarm` with `board_post(quote_post_id=..., channel='swarm')`, and mark stale claims `outdated: true` via `board_edit`.",
					"4. Solve compact tasks directly in your own worktree when decomposition is unnecessary.",
					"All committed branches across your forest are automatically snapshotted, verified, and mechanically assembled onto trunk at closeout.",
				].join("\n"),
			});

			let rootSummary = "";
			let rootRawText = "";
			try {
				const pulse = os.board.digest(os.runId, { subtreeId: "root" });
				const prompt = [
					`Goal: ${goal}`,
					rubric ? `Rubric: ${rubric}` : "",
					pulse,
					"Decide the best search/execution structure for this problem: solve directly if compact, or spawn parallel child Planners/Workers for independent search subtrees or modules, coordinate via Board v2, and await them before concluding.",
				].filter(Boolean).join("\n\n");
				const res = await root.runTurn(prompt, { signal });
				rootRawText = res.finalText;
				rootSummary = res.finalText.slice(0, 1000);
			} finally {
				await root.close();
			}

			// Fallback resilience: if the root Planner replied with a JSON `{ subtasks }` plan instead of
			// calling `spawn_agents` (and committed no files itself), dispatch those subtasks as leaf Workers!
			const spawnedCount = os.store.list("agents", { runId: os.runId }).length - 1;
			const rootHead = os.worktrees.headSha(root.workspace);
			const rootCommitted = Boolean(rootHead && rootHead !== os.worktrees.baseSha);
			if (spawnedCount === 0 && !rootCommitted && !signal.aborted && !os.isInCloseoutReserve()) {
				let fallbackSubtasks: Array<{ title: string; description: string }> = [];
				const jsonMatch = /\{[\s\S]*\}/.exec(rootRawText);
				if (jsonMatch) {
					try {
						const parsed = JSON.parse(jsonMatch[0]) as { subtasks?: Array<{ title?: unknown; description?: unknown }> };
						if (Array.isArray(parsed.subtasks)) {
							fallbackSubtasks = parsed.subtasks
								.filter((s) => typeof s?.title === "string" && typeof s?.description === "string")
								.map((s) => ({ title: String(s.title), description: String(s.description) }));
						}
					} catch {
						// Ignore malformed fallback JSON.
					}
				}
				if (!fallbackSubtasks.length) {
					fallbackSubtasks = [{ title: "Execute goal", description: goal }];
				}
				await Promise.all(
					fallbackSubtasks.map(async (st, idx) => {
						const leaf = await os.spawnWorker({
							role: "worker",
							handle: `leaf-${idx + 1}`,
							parentAgentId: root.agent.id,
							subtreeId: "root",
							depth: 1,
							canSpawn: false,
							passiveSnapshotOnExit: true,
							cacheKeyPrefix: `${os.runId}:recursive-worker`,
							toolScope: {
								board: "read-write",
								artifacts: true,
								findings: true,
								tasks: false,
								nominate: false,
								scheduler: "auto",
								passiveSnapshotOnExit: true,
								subtreeId: "root",
								defaultPostVisibility: "subtree",
							},
							systemPrompt: "You are a focused leaf Worker in an isolated git worktree. Complete your assigned subtask cleanly.",
						});
						try {
							await leaf.runTurn(`Subtask: ${st.title}\n\n${st.description}\n\nOverall goal: ${goal}`, { signal });
						} finally {
							await leaf.close();
						}
					}),
				);
			}

			if ((await os.waitIfPaused?.(signal)) === "coalescing") {
				// Proceed directly to mechanical trunk assembly of committed branches so zero verified work is lost.
			}
			if (!signal.aborted) {
				await os.consolidateFieldGuide?.({ mode: opts.dreamingMode ?? "deterministic" });
			}

			// Collect every agent branch in the forest that committed edits beyond baseSha.
			os.bus.emit(os.runId, "phase.changed", {
				from: "recursive-forest",
				to: "trunk-assembly",
				reason: "Assembling verified branches from recursive Planner/Worker forest",
			});

			const allAgents = os.store.list("agents", { runId: os.runId });
			const allFindings = os.store.list("findings", { runId: os.runId });
			const candidates: IntegrationBranchCandidate[] = [];
			const seenBranches = new Set<string>();

			for (const ag of allAgents) {
				if (!ag.branch || seenBranches.has(ag.branch)) continue;
				const headSha = ag.workspace ? os.worktrees.headSha(ag.workspace) : undefined;
				if (!headSha || headSha === os.worktrees.baseSha) continue;
				seenBranches.add(ag.branch);
				const agFindings = allFindings.filter((f) => f.authorAgentId === ag.id);
				const bestScore = agFindings.reduce((max, f) => Math.max(max, f.score ?? f.confidence ?? 0), -Infinity);
				const accepted = agFindings.some((f) => f.status === "accepted") ? 1 : 0;
				candidates.push({
					handle: ag.handle,
					branch: ag.branch,
					agentId: ag.id,
					driverId: ag.driverId,
					bestScore: Number.isFinite(bestScore) ? bestScore : undefined,
					accepted,
					summary: ag.summary,
				});
			}

			if (candidates.length > 0) {
				const integration = os.integration ?? new IntegrationPipeline(os);
				const assembled = await integration.assembleBranches({
					branches: candidates,
					goal,
					actorName: "recursive-trunk",
					cachePrefix: `${os.runId}:recursive`,
					totalExpectedBranches: candidates.length,
					enableConflictResolution: true,
					enableSemanticRepair,
					signal,
					closeoutSignal,
				});
				if (assembled.trunkFinding && assembled.trunkAccepted) {
					const rev = assembled.trunkFinding.submissions.at(-1)?.revision ?? 1;
					os.nominate(assembled.trunkFinding.id, rev, false);
					return {
						status: signal.aborted ? "stopped" : "done",
						summary: `Recursive forest assembled ${assembled.mergedCount}/${candidates.length} branches cleanly. ${rootSummary}`.trim(),
						nominatedFindingId: assembled.trunkFinding.id,
						nominatedRevision: rev,
					};
				}
			}

			const best = os.trust.bestVerifiedFinding(os.runId);
			if (best) {
				os.nominate(best.finding.id, best.revision, true);
				return {
					status: signal.aborted ? "stopped" : "done",
					summary: `Recursive forest nominated verified finding ${best.finding.id}. ${rootSummary}`.trim(),
					nominatedFindingId: best.finding.id,
					nominatedRevision: best.revision,
				};
			}

			return {
				status: signal.aborted ? "stopped" : "done",
				summary: rootSummary || `Recursive forest completed (${allAgents.length} agents, ${candidates.length} branches).`,
			};
		},
	};
}
