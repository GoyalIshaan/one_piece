import type { Finding, SwarmOsApi, TopologyOutcome, TopologyPlugin } from "@one-piece/core";

export interface EvolutionTopologyOptions {
	generations?: number;
	populationPerGen?: number;
	plateauGenerations?: number;
	includeNegativeMemory?: boolean;
}

interface ArchiveEntry {
	findingId: string;
	branch: string;
	score: number;
	summary: string;
	generation: number;
}

interface NegativeEntry {
	generation: number;
	idea: string;
	failureReason: string;
}

/**
 * Native Evolutionary / Archive-Guided Search Topology (AlphaEvolve / ShinkaEvolve / autoresearch style):
 * - Pure mechanical TypeScript control loop (ZERO LLM context rot in the scheduler!)
 * - Maintains a verified elite archive + optional structured negative-results memory
 * - Dispatches fresh-context CLI mutator bursts branched from sampled archive elites
 * - Stops early on plateau or closeout reserve, handing the verified best elite to CloseoutController.
 */
export function evolutionTopology(opts: EvolutionTopologyOptions = {}): TopologyPlugin {
	const maxGenerations = Math.max(1, opts.generations ?? 3);
	const popSize = Math.max(1, opts.populationPerGen ?? 2);
	const plateauLimit = Math.max(1, opts.plateauGenerations ?? 2);
	const includeNegativeMemory = opts.includeNegativeMemory ?? true;

	return {
		name: "evolution",
		description: "Pure mechanical TypeScript archive loop dispatching fresh-context CLI mutation bursts with verified ratcheting.",
		async run(os: SwarmOsApi, { goal, rubric, signal }): Promise<TopologyOutcome> {
			const archive: ArchiveEntry[] = [];
			const negativeMemory: NegativeEntry[] = [];
			let bestScore = Number.NEGATIVE_INFINITY;
			let staleGens = 0;

			for (let gen = 1; gen <= maxGenerations; gen++) {
				if (signal.aborted || os.isInCloseoutReserve()) break;
				os.bus.emit(os.runId, "phase.changed", { to: `evolution-gen-${gen}`, reason: `Generation ${gen}/${maxGenerations}, archive=${archive.length}` });

				const sortedElites = [...archive].sort((a, b) => b.score - a.score);
				let genImproved = false;

				await Promise.all(
					Array.from({ length: popSize }, async (_, slot) => {
						// Sample either global best (slot 0) or diverse elite (slot > 0)
						const parent = sortedElites.length
							? sortedElites[slot % Math.min(sortedElites.length, 3)]
							: undefined;

						const worker = await os.spawnWorker({
							role: "worker",
							baseRef: parent?.branch ?? os.worktrees.baseSha,
							canSpawn: false,
							cacheKeyPrefix: `${os.runId}:evolution-mutator`,
							skills: ["evolution-hygiene"],
							toolScope: {
								board: "none",
								artifacts: true,
								findings: true,
								tasks: false,
								nominate: false,
								scheduler: "auto",
							},
							systemPrompt: [
								"You are an evolutionary mutator starting from a fresh context in an isolated git worktree.",
								"Propose ONE concrete, testable improvement over the current code, verify it, and call `report_finding` with a numeric `score` if measurable.",
							].join("\n"),
						});

						try {
							const eliteSummary = sortedElites.slice(0, 3)
								.map((e, i) => `${i + 1}. [score=${e.score.toFixed(4)}] ${e.summary.slice(0, 220)}`)
								.join("\n");
							const negSummary = includeNegativeMemory && negativeMemory.length
								? `\n\nPreviously failed ideas (avoid repeating verbatim):\n${negativeMemory.slice(-5).map((n) => `- ${n.idea.slice(0, 120)} -> Failed: ${n.failureReason.slice(0, 140)}`).join("\n")}`
								: "";

							const prompt = [
								`Generation ${gen}/${maxGenerations}, Slot ${slot + 1}/${popSize}`,
								`Goal: ${goal}`,
								rubric ? `Rubric: ${rubric}` : "",
								parent ? `Parent incumbent (score=${parent.score.toFixed(4)}): ${parent.summary.slice(0, 300)}` : "Starting from base repository seed.",
								eliteSummary ? `Top verified archive elites:\n${eliteSummary}` : "",
								negSummary,
								"Make a focused mutation, verify correctness & performance, and call `report_finding`.",
							].filter(Boolean).join("\n\n");

							const res = await worker.runTurn(prompt, { signal });
							os.worktrees.commitWip(worker.workspace, `evo-gen-${gen}-slot-${slot + 1}`);

							let finding: Finding | undefined = os.store
								.list("findings", { runId: os.runId })
								.filter((f) => f.authorAgentId === worker.agent.id)
								.at(-1);

							if (!finding && res.status === "completed") {
								finding = await os.trust.submitFinding(
									{
										agentId: worker.agent.id,
										driverId: worker.agent.driverId,
										workspace: worker.workspace,
										claim: `Gen ${gen} Slot ${slot + 1} mutation`,
										summary: res.finalText.slice(0, 1200) || "Evolutionary candidate",
										level: "empirical",
									},
									signal,
								);
							}

							if (finding && finding.status === "accepted" && worker.branch) {
								const score = finding.score ?? finding.confidence ?? 0.5;
								archive.push({
									findingId: finding.id,
									branch: worker.branch,
									score,
									summary: finding.summary,
									generation: gen,
								});
								if (score > bestScore) {
									bestScore = score;
									genImproved = true;
								}
							} else {
								const failReason = finding?.rounds.at(-1)?.message ?? res.error ?? "Candidate failed verification";
								negativeMemory.push({
									generation: gen,
									idea: finding?.claim ?? res.finalText.slice(0, 120) ?? `Gen ${gen} slot ${slot + 1}`,
									failureReason: failReason,
								});
							}
						} finally {
							await worker.close();
						}
					}),
				);

				if (genImproved) staleGens = 0;
				else staleGens += 1;

				if (staleGens >= plateauLimit && archive.length > 0) {
					os.bus.emit(os.runId, "phase.changed", {
						from: `evolution-gen-${gen}`,
						to: "plateau-stop",
						reason: `No archive score improvement for ${staleGens} consecutive generations`,
					});
					break;
				}
			}

			const best = [...archive].sort((a, b) => b.score - a.score)[0];
			if (best) os.nominate(best.findingId);
			return {
				status: signal.aborted ? "stopped" : "done",
				summary: `Evolution completed: ${archive.length} verified archive entries, ${negativeMemory.length} negative records${best ? `, best=${best.findingId} (score=${best.score.toFixed(4)})` : ""}.`,
				nominatedFindingId: best?.findingId,
			};
		},
	};
}
