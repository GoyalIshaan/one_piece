import type { SwarmOsApi, TopologyOutcome, TopologyPlugin } from "@one-piece/core";

export interface SingleTopologyOptions {
	maxTurns?: number;
	handle?: string;
	seatPrompt?: string;
	deniedReadPaths?: readonly string[];
}

/**
 * Baseline single-worker topology:
 * 1 bounded worker in an isolated git worktree + blind verification + guaranteed closeout nomination.
 */
export function singleTopology(opts: SingleTopologyOptions = {}): TopologyPlugin {
	return {
		name: "single",
		description: "Single bounded worker in an isolated git worktree with frozen snapshot verification.",
		async run(os: SwarmOsApi, { goal, rubric, signal }): Promise<TopologyOutcome> {
			const worker = await os.spawnWorker({
				role: "worker",
				handle: opts.handle ?? "solo",
				canSpawn: false,
				maxTurns: opts.maxTurns,
				deniedReadPaths: opts.deniedReadPaths,
				cacheKeyPrefix: `${os.runId}:single-worker`,
				toolScope: {
					board: "none",
					artifacts: true,
					findings: true,
					tasks: false,
					nominate: false,
					scheduler: "auto",
				},
				systemPrompt: [
					"You are a focused solo engineer working in an isolated git worktree.",
					"Implement, verify with tests, and call report_finding when your solution is ready.",
				].join("\n"),
			});

			try {
				const res = await worker.runTurn(
					[
						`Goal: ${goal}`,
						rubric ? `Rubric: ${rubric}` : "",
						opts.seatPrompt ?? "",
						"Work directly in your workspace, verify your changes, and call `report_finding` (or return a clear summary of your verified changes).",
					].filter(Boolean).join("\n\n"),
					{ signal },
				);

				// If the worker made changes or finished without explicitly calling report_finding,
				// capture a frozen snapshot mechanically so CloseoutController can verify & nominate it.
				const existing = os.store.list("findings", { runId: os.runId });
				if (!existing.length && res.status === "completed") {
					os.worktrees.commitWip(worker.workspace, `one-piece: ${worker.agent.id} final`);
					await os.trust.submitFinding(
						{
							agentId: worker.agent.id,
							driverId: worker.agent.driverId,
							workspace: worker.workspace,
							claim: `Single-worker solution for: ${goal.slice(0, 120)}`,
							summary: res.finalText.slice(0, 2000) || "Completed task in isolated worktree.",
							level: "empirical",
						},
						signal,
					);
				}

				return {
					status: res.status === "completed" ? "done" : res.status === "interrupted" ? "stopped" : "failed",
					summary: res.finalText.slice(0, 1000) || res.error || `Worker finished (${res.status})`,
				};
			} finally {
				await worker.close();
			}
		},
	};
}
