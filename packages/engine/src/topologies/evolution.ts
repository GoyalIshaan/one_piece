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
	diffStat: string;
	diffSha: string;
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
		async run(os: SwarmOsApi, { goal, rubric, signal, closeoutSignal }): Promise<TopologyOutcome> {
			const archive: ArchiveEntry[] = [];
			const negativeMemory: NegativeEntry[] = [];
			let bestScore = Number.NEGATIVE_INFINITY;
			let staleGens = 0;

			for (let gen = 1; gen <= maxGenerations; gen++) {
				if (signal.aborted || os.isInCloseoutReserve()) break;
				os.bus.emit(os.runId, "phase.changed", { to: `evolution-gen-${gen}`, reason: `Generation ${gen}/${maxGenerations}, archive=${archive.length}` });

				// Deduplicate archive by diffSha so slots explore genuinely distinct basins rather than re-mutating clones.
				const uniqueByBasin = new Map<string, ArchiveEntry>();
				for (const entry of archive) {
					const existing = uniqueByBasin.get(entry.diffSha);
					if (!existing || entry.score > existing.score) {
						uniqueByBasin.set(entry.diffSha, entry);
					}
				}
				const sortedElites = [...uniqueByBasin.values()].sort((a, b) => b.score - a.score || b.generation - a.generation);
				let genImproved = false;
				// Pace each generation against remaining wall-clock budget so Gen 2+ crossover & dreaming always run!
				const remWall = os.remainingWallMs?.();
				const remainingGens = Math.max(1, maxGenerations - gen + 1);
				const genTimeoutMs =
					remWall !== undefined && remWall > 20_000
						? Math.max(20_000, Math.floor((remWall * 0.9) / remainingGens))
						: undefined;

				await Promise.all(
					Array.from({ length: popSize }, async (_, slot) => {
						// Diverse MAP-Elites parent selection + explicit crossover:
						// - Slot 0: exploit global best elite
						// - Slot 1 (when >= 2 distinct elites exist): crossover global best with 2nd distinct basin
						// - Slot >= 2: explore diverse archive elite
						const isCrossover = slot === 1 && sortedElites.length >= 2;
						const parent = isCrossover
							? sortedElites[0]
							: sortedElites.length
								? sortedElites[slot % Math.min(sortedElites.length, 4)]
								: undefined;
						const partner = isCrossover ? sortedElites[1] : undefined;

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
							const baseHeadSha = os.worktrees.headSha(worker.workspace);
							const eliteSummary = sortedElites.slice(0, 4)
								.map((e, i) => `${i + 1}. [score=${e.score.toFixed(4)}, gen=${e.generation}, basin=${e.diffSha.slice(0, 8)}] ${e.summary.slice(0, 200)}`)
								.join("\n");
							const crossoverHint = partner
								? [
									`CROSSOVER ASSIGNMENT: Your worktree starts from Elite #1 (score=${parent!.score.toFixed(4)}).`,
									`Combine its strengths with Elite #2's distinct basin (score=${partner.score.toFixed(4)}):`,
									`Elite #2 summary: ${partner.summary.slice(0, 320)}`,
									partner.diffStat ? `Elite #2 changed files:\n${partner.diffStat.slice(0, 500)}` : "",
								].filter(Boolean).join("\n")
								: "";
							const negSummary = includeNegativeMemory && negativeMemory.length
								? `\n\nPreviously failed ideas (avoid repeating verbatim):\n${negativeMemory.slice(-6).map((n) => `- ${n.idea.slice(0, 120)} -> Failed: ${n.failureReason.slice(0, 140)}`).join("\n")}`
								: "";

							const strategyDirective = isCrossover
								? "Synthesize the best algorithmic ideas from Elite #1 and Elite #2 into a single stronger candidate, verify strictly, and call `report_finding`."
								: slot === 0
									? "Exploit the current best incumbent with a targeted, high-precision optimization, verify strictly, and call `report_finding`."
									: "Explore a structurally DIFFERENT algorithmic strategy/basin from the top elite so the archive gains diversity, verify strictly, and call `report_finding`.";

							const prompt = [
								`Generation ${gen}/${maxGenerations}, Slot ${slot + 1}/${popSize}${isCrossover ? " [CROSSOVER]" : slot === 0 ? " [EXPLOIT]" : " [EXPLORE]"}`,
								`Goal: ${goal}`,
								rubric ? `Rubric: ${rubric}` : "",
								parent ? `Parent incumbent (score=${parent.score.toFixed(4)}): ${parent.summary.slice(0, 300)}` : "Starting from base repository seed.",
								crossoverHint,
								eliteSummary ? `Top distinct verified archive elites (${sortedElites.length} basins):\n${eliteSummary}` : "",
								negSummary,
								strategyDirective,
							].filter(Boolean).join("\n\n");

							const res = await worker.runTurn(prompt, { signal, ...(genTimeoutMs ? { timeoutMs: genTimeoutMs } : {}) });
							const wipSha = res.workspaceSnapshot?.wipSha ?? os.worktrees.commitWip(worker.workspace, `evo-gen-${gen}-slot-${slot + 1}`);
							const headAfter = res.workspaceSnapshot?.headSha ?? os.worktrees.headSha(worker.workspace);
							const hasEdits = Boolean(res.workspaceSnapshot?.hasEdits) || Boolean(wipSha) || (Boolean(headAfter) && Boolean(baseHeadSha) && headAfter !== baseHeadSha);
							const diffSha = res.workspaceSnapshot?.treeSha ?? os.worktrees.diffSha(worker.workspace);
							const diffStat = os.worktrees.diffStat(worker.workspace, baseHeadSha ?? os.worktrees.baseSha);

							let finding: Finding | undefined = os.store
								.list("findings", { runId: os.runId })
								.filter((f) => f.authorAgentId === worker.agent.id)
								.at(-1);

							if (!finding && (res.status === "completed" || (res.status === "interrupted" && hasEdits))) {
								const verifySig = closeoutSignal ?? os.closeoutSignal ?? new AbortController().signal;
								finding = await os.trust.submitFinding(
									{
										agentId: worker.agent.id,
										driverId: worker.agent.driverId,
										workspace: worker.workspace,
										claim: `Gen ${gen} Slot ${slot + 1} mutation`,
										summary: res.finalText.slice(0, 1200) || "Evolutionary candidate",
										level: "empirical",
									},
									verifySig,
								);
							}

							if (finding && finding.status === "accepted" && worker.branch) {
								const score = finding.score ?? finding.confidence ?? 0.5;
								archive.push({
									findingId: finding.id,
									branch: worker.branch,
									score,
									summary: finding.summary,
									diffStat,
									diffSha,
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

				// Wave-boundary dreaming between generations.
				if (gen < maxGenerations && !signal.aborted) {
					await os.consolidateFieldGuide?.();
				}

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
			const bestRev = best ? (os.store.get("findings", best.findingId)?.submissions.at(-1)?.revision ?? 1) : undefined;
			if (best && bestRev !== undefined) os.nominate(best.findingId, bestRev);
			const nomination = best && bestRev !== undefined
				? { nominatedFindingId: best.findingId, nominatedRevision: bestRev }
				: {};
			return {
				status: signal.aborted ? "stopped" : "done",
				summary: `Evolution completed: ${archive.length} verified archive entries, ${negativeMemory.length} negative records${best ? `, best=${best.findingId} (score=${best.score.toFixed(4)})` : ""}.`,
				...nomination,
			};
		},
	};
}
