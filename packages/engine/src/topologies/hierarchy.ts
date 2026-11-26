import type { JsonSchema, SwarmOsApi, TopologyOutcome, TopologyPlugin } from "@one-piece/core";

export interface HierarchyTopologyOptions {
	maxWorkers?: number;
	maxWorkerTurns?: number;
}

const PLAN_SCHEMA: JsonSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		subtasks: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					title: { type: "string" },
					description: { type: "string" },
				},
				required: ["title", "description"],
			},
		},
	},
	required: ["subtasks"],
};

interface PlanSubtask {
	title: string;
	description: string;
}

function parsePlan(text: string, fallbackGoal: string, maxWorkers: number): PlanSubtask[] {
	const match = /\{[\s\S]*\}/.exec(text);
	if (match) {
		try {
			const parsed = JSON.parse(match[0]) as { subtasks?: Array<{ title?: unknown; description?: unknown }> };
			if (Array.isArray(parsed.subtasks) && parsed.subtasks.length) {
				return parsed.subtasks
					.filter((s) => typeof s?.title === "string" && typeof s?.description === "string")
					.slice(0, maxWorkers)
					.map((s) => ({ title: String(s.title), description: String(s.description) }));
			}
		} catch {
			// Fall back to single subtask.
		}
	}
	return [{ title: "Execute goal", description: fallbackGoal }];
}

/**
 * Native Hierarchical Topology:
 * 1. Lean Planner (`role: "planner"`, e.g. thin PiInProcess or stateless `codex exec --output-schema`)
 *    decomposes the goal into independent subtasks.
 * 2. Bounded non-recursive CLI leaf workers (`canSpawn: false`) execute each subtask in isolated git worktrees.
 * 3. Integrator (`role: "integrator"`) synthesizes & merges the verified branches onto a single deliverable.
 */
export function hierarchyTopology(opts: HierarchyTopologyOptions = {}): TopologyPlugin {
	const maxWorkers = opts.maxWorkers ?? 3;

	return {
		name: "hierarchy",
		description: "Lean Planner decomposes goal -> parallel bounded CLI leaf workers in isolated worktrees -> single-writer Integrator.",
		async run(os: SwarmOsApi, { goal, rubric, signal }): Promise<TopologyOutcome> {
			// Phase 1: Lean Planning
			os.bus.emit(os.runId, "phase.changed", { to: "plan", reason: "Decomposing goal into bounded subtasks" });
			const planner = await os.spawnWorker({
				role: "planner",
				readOnly: true,
				canSpawn: false,
				cacheKeyPrefix: `${os.runId}:hierarchy-planner`,
				toolScope: {
					board: "read",
					artifacts: true,
					findings: false,
					tasks: false,
					nominate: false,
					scheduler: "never",
					skills: false,
				},
				systemPrompt: [
					"You are a concise engineering lead. Decompose the goal into disjoint, testable subtasks.",
					'Respond ONLY with JSON: {"subtasks":[{"title":"...","description":"..."}]}',
				].join("\n"),
			});

			let subtasks: PlanSubtask[];
			try {
				const planRes = await planner.runTurn(
					`Goal: ${goal}\n${rubric ? `Rubric: ${rubric}\n` : ""}Produce up to ${maxWorkers} disjoint subtasks with clear file boundaries.`,
					{ signal, outputSchema: PLAN_SCHEMA },
				);
				subtasks = parsePlan(planRes.finalText, goal, maxWorkers);
			} finally {
				await planner.close();
			}

			const createdTasks = subtasks.map((st) =>
				os.createTask({ title: st.title, description: st.description, createdBy: "planner" }),
			);

			// Phase 2: Parallel Bounded Leaf Workers (canSpawn: false)
			os.bus.emit(os.runId, "phase.changed", { from: "plan", to: "execute", reason: `Dispatching ${createdTasks.length} bounded leaf workers` });
			const workerResults = await Promise.all(
				createdTasks.map(async (task) => {
					if (os.isInCloseoutReserve() || signal.aborted) {
						return { task, branch: undefined as string | undefined, summary: "Skipped due to reserve/abort", findingId: undefined as string | undefined };
					}
					const worker = await os.spawnWorker({
						role: "worker",
						taskId: task.id,
						canSpawn: false,
						maxTurns: opts.maxWorkerTurns,
						cacheKeyPrefix: `${os.runId}:hierarchy-worker`,
						toolScope: {
							board: "read-write",
							artifacts: true,
							findings: true,
							tasks: false,
							nominate: false,
							scheduler: "auto",
						},
						systemPrompt: [
							"You are a focused leaf engineer in an isolated git worktree.",
							"Stay strictly within your assigned subtask. Run tests, then call report_finding or summarize your work.",
						].join("\n"),
					});
					const claim = os.store.claimTaskLease(os.runId, task.id, worker.agent.id, 300_000);
					try {
						const res = await worker.runTurn(
							`Subtask: ${task.title}\n\n${task.description}\n\nOverall goal context: ${goal}`,
							{ signal },
						);
						os.worktrees.commitWip(worker.workspace, `one-piece(${task.id}): ${task.title}`);
						const diff = os.worktrees.diffStat(worker.workspace);
						let findingId = os.store.list("findings", { runId: os.runId }).find((f) => f.authorAgentId === worker.agent.id)?.id;
						if (!findingId && res.status === "completed") {
							const f = await os.trust.submitFinding(
								{
									agentId: worker.agent.id,
									driverId: worker.agent.driverId,
									taskId: task.id,
									workspace: worker.workspace,
									claim: `${task.title}`,
									summary: `${res.finalText.slice(0, 1200)}\nDiff:\n${diff}`,
									level: "empirical",
								},
								signal,
							);
							findingId = f.id;
						}
						if (claim.claimed && claim.task) {
							os.store.releaseTaskLease(task.id, worker.agent.id, claim.task.fencingToken, res.status === "completed" ? "done" : "blocked", {
								result: res.finalText.slice(0, 800),
								findingId,
							});
							os.bus.emit(os.runId, "task.status", { taskId: task.id, status: res.status === "completed" ? "done" : "blocked", result: res.finalText.slice(0, 400) }, worker.agent.id);
						}
						return { task, branch: worker.branch, summary: res.finalText.slice(0, 800), findingId };
					} finally {
						await worker.close();
					}
				}),
			);

			// Phase 3: Single-Writer Integration (when multiple subtasks ran)
			if (workerResults.length > 1 && !signal.aborted) {
				os.bus.emit(os.runId, "phase.changed", { from: "execute", to: "integrate", reason: "Synthesizing verified leaf branches" });
				const integrator = await os.spawnWorker({
					role: "integrator",
					canSpawn: false,
					cacheKeyPrefix: `${os.runId}:hierarchy-integrator`,
					toolScope: {
						board: "read-write",
						artifacts: true,
						findings: true,
						tasks: false,
						nominate: true,
						scheduler: "auto",
						codeMode: true,
					},
					systemPrompt: [
						"You are the single-writer Integrator. Combine the completed subtask branches cleanly, resolve any conflicts,",
						"run end-to-end checks, and call report_finding + nominate with the final integrated solution.",
					].join("\n"),
				});
				try {
					const branchReport = workerResults
						.map((r) => `- Task ${r.task.id} (${r.task.title}): branch=${r.branch ?? "none"}, finding=${r.findingId ?? "none"}\n  Summary: ${r.summary}`)
						.join("\n");
					const res = await integrator.runTurn(
						`Goal: ${goal}\n\nCompleted leaf worker branches:\n${branchReport}\n\nMerge or integrate these changes cleanly in your worktree, run full tests, and call report_finding + nominate.`,
						{ signal },
					);
					os.worktrees.commitWip(integrator.workspace, "one-piece: integrated deliverable");
					const existingInt = os.store.list("findings", { runId: os.runId }).find((f) => f.authorAgentId === integrator.agent.id);
					if (!existingInt && res.status === "completed") {
						const f = await os.trust.submitFinding(
							{
								agentId: integrator.agent.id,
								driverId: integrator.agent.driverId,
								workspace: integrator.workspace,
								claim: `Integrated solution for: ${goal.slice(0, 120)}`,
								summary: res.finalText.slice(0, 1500),
								level: "empirical",
								buildsOn: workerResults.map((r) => r.findingId).filter((id): id is string => Boolean(id)),
							},
							signal,
						);
						if (f.status === "accepted") os.nominate(f.id);
					}
					return { status: "done", summary: res.finalText.slice(0, 1000) || "Hierarchy integration completed." };
				} finally {
					await integrator.close();
				}
			}

			return {
				status: signal.aborted ? "stopped" : "done",
				summary: workerResults.map((r) => `${r.task.title}: ${r.summary.slice(0, 200)}`).join("\n"),
			};
		},
	};
}
