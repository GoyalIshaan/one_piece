import type { SwarmOsApi, TopologyOutcome, TopologyPlugin } from "@one-piece/core";

export interface SubstratePeersOptions {
	peers?: number;
	rounds?: number;
}

/**
 * Native ScaleMAS Bounded-Substrate Peer Topology:
 * N flat peers work in isolated git worktrees and coordinate strictly through the
 * bounded citation-ranked board (`board_search(k=5)`, `board_publish`, `board_visit`)
 * — zero DM prompt-regex hacks and O(1) read load per turn regardless of N.
 */
export function substratePeersTopology(opts: SubstratePeersOptions = {}): TopologyPlugin {
	const peerCount = Math.max(2, opts.peers ?? 3);
	const rounds = Math.max(1, opts.rounds ?? 2);

	return {
		name: "substrate-peers",
		description: "Flat peer swarm coordinating via ScaleMAS bounded citation-ranked board (O(1) read load) in isolated worktrees.",
		async run(os: SwarmOsApi, { goal, rubric, signal }): Promise<TopologyOutcome> {
			os.bus.emit(os.runId, "phase.changed", { to: "peer-explore", reason: `Launching ${peerCount} peers over bounded substrate` });

			const handles = await Promise.all(
				Array.from({ length: peerCount }, (_, idx) =>
					os.spawnWorker({
						role: "worker",
						canSpawn: false,
						systemPrompt: [
							`You are Peer #${idx + 1} of ${peerCount} in a flat ScaleMAS substrate swarm.`,
							"Use `board_search` (top-k bounded reads) before duplicating work, cite useful peer post IDs via `parent_ids` in `board_publish`,",
							"and call `report_finding` when you have a verified improvement or solution in your isolated worktree.",
							rubric ? `Rubric: ${rubric}` : "",
						].filter(Boolean).join("\n"),
					}),
				),
			);

			try {
				for (let round = 1; round <= rounds; round++) {
					if (signal.aborted || os.isInCloseoutReserve()) break;
					await Promise.all(
						handles.map(async (worker, idx) => {
							const prompt = round === 1
								? `Goal: ${goal}\n\nYou are Peer #${idx + 1}. First call \`board_search\` to check existing notes, explore a distinct angle in your worktree, publish concise findings to the board, and submit verified work via \`report_finding\`.`
								: `Round ${round}/${rounds}: Call \`board_search\` to read top-cited discoveries from peers, incorporate the best verified insights into your worktree, and submit your strongest revised finding via \`report_finding\`.`;
							const res = await worker.runTurn(prompt, { signal });
							os.worktrees.commitWip(worker.workspace, `peer-${idx + 1} round ${round}`);
							const hasFinding = os.store.list("findings", { runId: os.runId }).some((f) => f.authorAgentId === worker.agent.id);
							if (!hasFinding && round === rounds && res.status === "completed") {
								await os.trust.submitFinding(
									{
										agentId: worker.agent.id,
										driverId: worker.agent.driverId,
										workspace: worker.workspace,
										claim: `Peer #${idx + 1} solution for: ${goal.slice(0, 100)}`,
										summary: res.finalText.slice(0, 1200) || "Peer completed work.",
										level: "empirical",
									},
									signal,
								);
							}
						}),
					);
				}

				const accepted = os.store.list("findings", { runId: os.runId }).filter((f) => f.status === "accepted").length;
				const posts = os.store.list("posts", { runId: os.runId }).length;
				return {
					status: signal.aborted ? "stopped" : "done",
					summary: `Substrate peers (${peerCount} peers × ${rounds} rounds): ${posts} board posts, ${accepted} accepted findings.`,
				};
			} finally {
				await Promise.allSettled(handles.map((h) => h.close()));
			}
		},
	};
}
