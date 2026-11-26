import { assertNever, type SwarmOsApi, type TopologyOutcome, type TopologyPlugin } from "@one-piece/core";

type BranchAssemblyOutcome =
	| { readonly kind: "merged_clean"; readonly commitSha: string }
	| { readonly kind: "conflict_resolved"; readonly conflictFiles: readonly string[]; readonly commitSha: string }
	| { readonly kind: "conflict_unresolved"; readonly conflictFiles: readonly string[]; readonly reason: string };

export interface SubstrateSeatConfig {
	handle?: string;
	seatPrompt?: string;
	deniedReadPaths?: readonly string[];
}

export interface SubstratePeersOptions {
	peers?: number;
	rounds?: number;
	seatConfigs?: readonly SubstrateSeatConfig[];
	/** Automatically run a 1-turn semantic repair integrator if assembled trunk fails verification (default true). */
	enableSemanticRepair?: boolean;
}

/**
 * Native ScaleMAS Bounded-Substrate Peer Topology (Board v2 + Option A Trunk Assembly):
 * - N flat peers work in isolated git worktrees (with optional per-seat Seatbelt shard isolation).
 * - Peers coordinate over the 4-tool bounded Board v2 (`board_search`, `board_publish`, `board_visit`, `board_wait`)
 *   with KV-cache-safe byte-identical static system prompts and 1-line dynamic Board Pulses per turn.
 * - At closeout, non-conflicting committed peer branches are assembled onto isolated `trunk`
 *   (highest verified score first), with an impartial 1-turn `integrator` conflict-resolver fallback
 *   whenever overlapping peer edits hit a git conflict.
 */
export function substratePeersTopology(opts: SubstratePeersOptions = {}): TopologyPlugin {
	const peerCount = Math.max(2, opts.peers ?? opts.seatConfigs?.length ?? 3);
	const rounds = Math.max(1, opts.rounds ?? 2);
	const enableSemanticRepair = opts.enableSemanticRepair ?? true;

	return {
		name: "substrate-peers",
		description: "Flat peer swarm coordinating via bounded Board v2 in isolated worktrees with verified trunk assembly.",
		async run(os: SwarmOsApi, { goal, rubric, signal }): Promise<TopologyOutcome> {
			os.bus.emit(os.runId, "phase.changed", { to: "peer-explore", reason: `Launching ${peerCount} peers over Board v2 substrate` });

			const handles = await Promise.all(
				Array.from({ length: peerCount }, (_, idx) => {
					const seatCfg = opts.seatConfigs?.[idx];
					return os.spawnWorker({
						role: "worker",
						handle: seatCfg?.handle ?? `peer-${idx + 1}`,
						canSpawn: false,
						deniedReadPaths: seatCfg?.deniedReadPaths,
						cacheKeyPrefix: `${os.runId}:substrate-peer`,
						toolScope: {
							board: "read-write",
							artifacts: true,
							findings: true,
							tasks: false,
							nominate: false,
							scheduler: "auto",
						},
						systemPrompt: [
							"You are a peer engineer in a flat ScaleMAS substrate swarm working in an isolated git worktree.",
							"Coordinate cleanly with peers using the 4 shared board tools:",
							"- `board_publish(topic, summary, body?, labels?, parent_ids?, supersedes?)` to publish concise results or updates immediately.",
							"- `board_search(query?, topic?, labels?, after?, thread_id?)` to read peer notes (omit query to list latest posts + active topics).",
							"- `board_wait(topic?, after?, min_posts?, timeout_seconds?)` to wait reactively (up to 25s, zero polling) for peers to publish before proceeding.",
							"- `board_visit(post_id)` to read full untruncated posts.",
							"Cite useful peer post IDs via `parent_ids`, avoid overwriting peers' files unnecessarily, and call `report_finding` when your worktree has a verified deliverable.",
						].join("\n"),
					});
				}),
			);

			try {
				for (let round = 1; round <= rounds; round++) {
					if (signal.aborted || os.isInCloseoutReserve()) break;
					await Promise.all(
						handles.map(async (worker, idx) => {
							const seatCfg = opts.seatConfigs?.[idx];
							const handle = worker.agent.handle;
							const pulse = os.board.digest(os.runId);
							const rubricLine = rubric ? `Rubric: ${rubric}` : "";
							const seatLine = seatCfg?.seatPrompt ? seatCfg.seatPrompt : "";
							const prompt = round === 1
								? [
									`Goal: ${goal}`,
									rubricLine,
									`You are ${handle} (Peer #${idx + 1} of ${peerCount}).`,
									pulse,
									seatLine,
									"Coordinate via `board_publish` + `board_wait` / `board_search`. Publish your local findings/subtotals promptly so peers can build on them, wait for needed peer inputs with `board_wait(min_posts=...)` if peers are still computing, write your deliverable cleanly in your worktree, and call `report_finding` when ready.",
								].filter(Boolean).join("\n\n")
								: [
									`Round ${round}/${rounds} (${handle}, Peer #${idx + 1} of ${peerCount}):`,
									pulse,
									seatLine,
									"Check the latest board updates with `board_search` (or `board_wait` if any peer is still publishing), finalize your deliverable in your worktree using all verified peer inputs, and submit via `report_finding`.",
								].filter(Boolean).join("\n\n");
							const res = await worker.runTurn(prompt, { signal });
							os.worktrees.commitWip(worker.workspace, `${handle} round ${round}`);
							const hasFinding = os.store.list("findings", { runId: os.runId }).some((f) => f.authorAgentId === worker.agent.id);
							if (!hasFinding && round === rounds && res.status === "completed") {
								await os.trust.submitFinding(
									{
										agentId: worker.agent.id,
										driverId: worker.agent.driverId,
										workspace: worker.workspace,
										claim: `${handle} solution for: ${goal.slice(0, 100)}`,
										summary: res.finalText.slice(0, 1200) || "Peer completed work.",
										level: "empirical",
									},
									signal,
								);
							}
						}),
					);
					// Wave-boundary dreaming: consolidate discoveries & failure receipts between rounds.
					if (round < rounds && !signal.aborted) {
						await os.consolidateFieldGuide?.();
					}
				}

				// Closeout Option A: assemble committed peer branches onto isolated `trunk`
				// (highest verified score first), with an impartial 1-turn conflict-resolver fallback.
				const assemblyOutcomes: BranchAssemblyOutcome[] = [];
				if (!signal.aborted) {
					os.bus.emit(os.runId, "phase.changed", { to: "trunk-assembly", reason: "Assembling committed peer branches onto trunk" });
					const findings = os.store.list("findings", { runId: os.runId });
					const peerCandidates = handles
						.map((worker, idx) => {
							os.worktrees.commitWip(worker.workspace, `${worker.agent.handle} final`);
							const headSha = os.worktrees.headSha(worker.workspace);
							const hasCommits = Boolean(worker.branch && headSha && headSha !== os.worktrees.baseSha);
							const peerFindings = findings.filter((f) => f.authorAgentId === worker.agent.id);
							const bestScore = peerFindings.reduce((max, f) => Math.max(max, f.score ?? f.confidence ?? 0), -Infinity);
							const accepted = peerFindings.some((f) => f.status === "accepted") ? 1 : 0;
							return { worker, idx, hasCommits, bestScore, accepted };
						})
						.filter((c) => c.hasCommits)
						.sort((a, b) => b.accepted - a.accepted || b.bestScore - a.bestScore || a.idx - b.idx);

					let lastTrunkSha = os.worktrees.baseSha;
					for (const cand of peerCandidates) {
						const branch = cand.worker.branch!;
						const peerHandle = cand.worker.agent.handle;
						const merged = os.worktrees.mergeIntoTrunk(branch, {
							message: `substrate-peers: merge ${peerHandle} (${branch})`,
						});
						if (merged.ok) {
							lastTrunkSha = merged.commitSha;
							assemblyOutcomes.push({ kind: "merged_clean", commitSha: merged.commitSha });
							continue;
						}

						os.bus.emit(
							os.runId,
							"peer.conflict_detected",
							{ peerHandle, branch, conflictFiles: merged.conflictFiles },
							"substrate-trunk",
						);
						os.board.publish({
							runId: os.runId,
							authorAgentId: "substrate-trunk",
							authorHandle: "os",
							topic: "merge-conflict",
							summary: `Merge conflict combining ${peerHandle} (${branch}) onto trunk in: ${merged.conflictFiles.join(", ") || "unknown"}`,
							labels: { "os:conflict": "true" },
							isOsActor: true,
						});

						// Impartial 1-turn conflict resolver fallback (Option A); allowed during closeout reserve so work isn't dropped.
						let outcome: BranchAssemblyOutcome = {
							kind: "conflict_unresolved",
							conflictFiles: merged.conflictFiles,
							reason: merged.error,
						};
						if (merged.conflictFiles.length > 0 && !signal.aborted) {
							const preview = os.worktrees.mergePreviewDiff(branch);
							const resolver = await os.spawnWorker({
								role: "integrator",
								handle: "integrator",
								baseRef: lastTrunkSha,
								canSpawn: false,
								cacheKeyPrefix: `${os.runId}:substrate-resolver`,
								toolScope: {
									board: "read",
									artifacts: true,
									findings: false,
									tasks: false,
									nominate: false,
									scheduler: "never",
									sidekick: false,
									codeMode: false,
								},
								systemPrompt: [
									"You are an impartial merge-conflict integrator for a peer swarm.",
									"Your workspace starts at current trunk HEAD. Combine both intended changes in the conflicting files cleanly (deduplicating any repeated implementations) without dropping either peer's functionality.",
								].join("\n"),
							});
							try {
								const resolvePrompt = [
									`Goal: ${goal}`,
									`Resolve merge conflict from ${peerHandle} (${branch}) onto trunk.`,
									`Conflicting files: ${merged.conflictFiles.join(", ")}`,
									"",
									`## Current trunk diff (${preview.baseSha.slice(0, 8)}..HEAD)`,
									"```diff",
									preview.trunkDiff.slice(0, 8000),
									"```",
									"",
									`## Incoming ${peerHandle} diff (${preview.baseSha.slice(0, 8)}..${branch})`,
									"```diff",
									preview.branchDiff.slice(0, 8000),
									"```",
									"",
									"Edit the conflicting files in your workspace to reconcile both sides cleanly, verify, and leave the workspace ready to commit.",
								].join("\n");
								await resolver.runTurn(resolvePrompt, { signal });
								const wipSha = os.worktrees.commitWip(resolver.workspace, `integrator: resolve ${peerHandle} conflict`);
								const headAfter = os.worktrees.headSha(resolver.workspace);
								if (resolver.branch && (wipSha || (headAfter && headAfter !== lastTrunkSha))) {
									const resolvedMerge = os.worktrees.mergeIntoTrunk(resolver.branch, {
										message: `substrate-peers: resolved ${peerHandle} conflict`,
									});
									if (resolvedMerge.ok) {
										lastTrunkSha = resolvedMerge.commitSha;
										outcome = {
											kind: "conflict_resolved",
											conflictFiles: merged.conflictFiles,
											commitSha: resolvedMerge.commitSha,
										};
										os.bus.emit(
											os.runId,
											"peer.conflict_resolved",
											{ peerHandle, branch, conflictFiles: merged.conflictFiles, commitSha: resolvedMerge.commitSha },
											resolver.agent.id,
										);
									} else {
										outcome = {
											kind: "conflict_unresolved",
											conflictFiles: resolvedMerge.conflictFiles,
											reason: resolvedMerge.error,
										};
									}
								}
							} finally {
								await resolver.close();
							}
						}
						assemblyOutcomes.push(outcome);
					}

					let mergedCount = 0;
					let conflictCount = 0;
					let resolvedConflicts = 0;
					for (const item of assemblyOutcomes) {
						switch (item.kind) {
							case "merged_clean":
								mergedCount += 1;
								break;
							case "conflict_resolved":
								mergedCount += 1;
								conflictCount += 1;
								resolvedConflicts += 1;
								break;
							case "conflict_unresolved":
								conflictCount += 1;
								break;
							default:
								assertNever(item, "Unhandled BranchAssemblyOutcome");
						}
					}

					if (mergedCount > 0 && !signal.aborted) {
						const trunkFinding = await os.trust.submitFinding(
							{
								agentId: "substrate-trunk",
								workspace: os.worktrees.trunkPath,
								claim: `Assembled multi-peer trunk (${mergedCount}/${handles.length} branches) for: ${goal.slice(0, 100)}`,
								summary: `Assembled ${mergedCount} peer branches onto isolated trunk (conflicts=${conflictCount}, resolved=${resolvedConflicts}).`,
								level: "empirical",
							},
							signal,
						);

						// If the assembled trunk merged cleanly in Git yet failed the executable verifier
						// (semantic interference across peer branches!), run a 1-turn impartial repair integrator.
						if (enableSemanticRepair && os.trust.verifier && trunkFinding.status !== "accepted" && !signal.aborted) {
							const failReason = trunkFinding.rounds.at(-1)?.message ?? "Executable verifier rejected assembled trunk";
							await os.consolidateFieldGuide?.();
							const repairer = await os.spawnWorker({
								role: "integrator",
								handle: "trunk-repairer",
								baseRef: lastTrunkSha,
								canSpawn: false,
								cacheKeyPrefix: `${os.runId}:substrate-trunk-repair`,
								toolScope: {
									board: "read",
									artifacts: true,
									findings: false,
									tasks: false,
									nominate: false,
									scheduler: "never",
									sidekick: false,
									codeMode: false,
								},
								systemPrompt: [
									"You are an impartial semantic-integration repair engineer.",
									"Multiple peer branches were assembled onto trunk, yet executable verification failed.",
									"Inspect the verifier failure, reconcile any cross-module semantic interference without discarding peer work, and verify.",
								].join("\n"),
							});
							let repaired = false;
							let repairedSha: string | undefined;
							try {
								const repairPrompt = [
									`Goal: ${goal}`,
									rubric ? `Rubric: ${rubric}` : "",
									`Assembled trunk failed verification: ${failReason}`,
									os.board.digest(os.runId),
									"Diagnose and repair the cross-feature / integration issue in your workspace, run tests, and leave the workspace ready to commit.",
								].filter(Boolean).join("\n\n");
								const repRes = await repairer.runTurn(repairPrompt, { signal });
								const repWip = os.worktrees.commitWip(repairer.workspace, "substrate-peers: semantic trunk repair");
								const repHead = os.worktrees.headSha(repairer.workspace);
								if (repRes.status === "completed" && repairer.branch && (repWip || (repHead && repHead !== lastTrunkSha))) {
									const repMerge = os.worktrees.mergeIntoTrunk(repairer.branch, {
										message: "substrate-peers: semantic trunk repair",
									});
									if (repMerge.ok) {
										const repFinding = await os.trust.submitFinding(
											{
												agentId: repairer.agent.id,
												driverId: repairer.agent.driverId,
												findingId: trunkFinding.id,
												workspace: os.worktrees.trunkPath,
												claim: `Repaired assembled multi-peer trunk (${repMerge.commitSha.slice(0, 8)})`,
												summary: `Impartial semantic repair fixed trunk verifier failure after ${mergedCount}-branch assembly.`,
												level: "empirical",
											},
											signal,
										);
										if (repFinding.status === "accepted") {
											repaired = true;
											repairedSha = repMerge.commitSha;
											lastTrunkSha = repMerge.commitSha;
										}
									}
								}
							} finally {
								await repairer.close();
							}
							os.bus.emit(
								os.runId,
								"peer.trunk_repaired",
								{ reason: failReason.slice(0, 300), repaired, commitSha: repairedSha },
								"substrate-trunk",
							);
						}
					}
				}

				const mergedCount = assemblyOutcomes.filter((o) => o.kind === "merged_clean" || o.kind === "conflict_resolved").length;
				const conflictCount = assemblyOutcomes.filter((o) => o.kind === "conflict_resolved" || o.kind === "conflict_unresolved").length;
				const resolvedConflicts = assemblyOutcomes.filter((o) => o.kind === "conflict_resolved").length;
				const accepted = os.store.list("findings", { runId: os.runId }).filter((f) => f.status === "accepted").length;
				const posts = os.store.list("posts", { runId: os.runId }).length;
				return {
					status: signal.aborted ? "stopped" : "done",
					summary: `Substrate peers (${peerCount} peers × ${rounds} rounds): ${posts} board posts, ${mergedCount} merged onto trunk (${resolvedConflicts}/${conflictCount} conflicts resolved), ${accepted} accepted findings.`,
				};
			} finally {
				await Promise.allSettled(handles.map((h) => h.close()));
			}
		},
	};
}
