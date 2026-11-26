import type { SwarmOsApi, TopologyOutcome, TopologyPlugin } from "@one-piece/core";
import { IntegrationPipeline } from "../integration.ts";

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
	/** Allow peers to act as Planner-capable peers that can dynamically spawn child Planners/Workers (default false for classic flat peers). */
	allowPeerSpawning?: boolean;
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
		async run(os: SwarmOsApi, { goal, rubric, signal, closeoutSignal }): Promise<TopologyOutcome> {
			os.bus.emit(os.runId, "phase.changed", { to: "peer-explore", reason: `Launching ${peerCount} peers over Board v2 substrate` });

			const isSharded = Boolean(opts.seatConfigs && opts.seatConfigs.length > 0);
			const peerSpawning = Boolean(opts.allowPeerSpawning && !isSharded);
			const handles = await Promise.all(
				Array.from({ length: peerCount }, (_, idx) => {
					const seatCfg = opts.seatConfigs?.[idx];
					const peerHandle = seatCfg?.handle ?? `peer-${idx + 1}`;
					const baseReq = {
						handle: peerHandle,
						subtreeId: peerHandle,
						depth: 0,
						deniedReadPaths: seatCfg?.deniedReadPaths,
						cacheKeyPrefix: `${os.runId}:substrate-peer`,
						systemPrompt: [
							"You are a peer engineer in a flat ScaleMAS substrate swarm working in an isolated git worktree.",
							"Coordinate cleanly with peers using the 4 shared board tools:",
							"- `board_publish(topic, summary, body?, labels?, parent_ids?, supersedes?)` to publish concise results or updates immediately.",
							"- `board_search(query?, topic?, labels?, after?, thread_id?)` to read peer notes (omit query to list latest posts + active topics).",
							"- `board_wait(topic?, after?, min_posts?, timeout_seconds?)` to wait reactively (up to 25s, zero polling) for peers to publish before proceeding.",
							"- `board_visit(post_id)` to read full untruncated posts.",
							isSharded
								? "Cite useful peer post IDs via `parent_ids`, write ONLY your seat deliverable cleanly, and exit once verified — trunk assembly verifies the combined N-seat output."
								: "Cite useful peer post IDs via `parent_ids`, avoid overwriting peers' files unnecessarily, and call `report_finding` when your worktree has a verified deliverable.",
						].join("\n"),
					};
					const sharedScope = {
						board: "read-write" as const,
						artifacts: true,
						// On privately sharded tasks, a single 1/N seat cannot satisfy the full N-seat verifier;
						// hide report_finding so peers don't waste turns retrying partial rejections before trunk assembly.
						findings: !isSharded,
						tasks: false,
						nominate: false,
						scheduler: "auto" as const,
						subtreeId: peerHandle,
						defaultPostVisibility: "global" as const,
					};
					return peerSpawning
						? os.spawnWorker({
							...baseReq,
							role: "planner",
							canSpawn: true,
							toolScope: { ...sharedScope, canSpawn: true, spawnAgents: true },
						})
						: os.spawnWorker({
							...baseReq,
							role: "worker",
							canSpawn: false,
							toolScope: { ...sharedScope, canSpawn: false, spawnAgents: false },
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
							const prompt = seatLine
								? [
									round === 1 ? `Goal: ${goal}` : `Round ${round}/${rounds} (${handle}, Peer #${idx + 1} of ${peerCount}):`,
									round === 1 ? rubricLine : "",
									round === 1 ? `You are ${handle} (Peer #${idx + 1} of ${peerCount}).` : "",
									pulse,
									seatLine,
								].filter(Boolean).join("\n\n")
								: round === 1
									? [
										`Goal: ${goal}`,
										rubricLine,
										`You are ${handle} (Peer #${idx + 1} of ${peerCount}).`,
										pulse,
										"Coordinate via `board_publish` + `board_wait` / `board_search`. Publish your local findings/subtotals promptly so peers can build on them, wait for needed peer inputs with `board_wait(min_posts=...)` if peers are still computing, write your deliverable cleanly in your worktree, and call `report_finding` when ready.",
									].filter(Boolean).join("\n\n")
									: [
										`Round ${round}/${rounds} (${handle}, Peer #${idx + 1} of ${peerCount}):`,
										pulse,
										"Check the latest board updates with `board_search` (or `board_wait` if any peer is still publishing), finalize your deliverable in your worktree using all verified peer inputs, and submit via `report_finding`.",
									].filter(Boolean).join("\n\n");
							const res = await worker.runTurn(prompt, { signal });
							os.worktrees.commitWip(worker.workspace, `${handle} round ${round}`);
							const hasFinding = os.store.list("findings", { runId: os.runId }).some((f) => f.authorAgentId === worker.agent.id);
							if (!isSharded && !hasFinding && round === rounds && res.status === "completed") {
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

				// Closeout Option A: delegate mechanical Git assembly, conflict resolution, and semantic repair
				// to the shared OS IntegrationPipeline (always runs under closeoutSignal even after work abort).
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
						return {
							handle: worker.agent.handle,
							branch: worker.branch ?? "",
							agentId: worker.agent.id,
							driverId: worker.agent.driverId,
							laneIdx: idx,
							hasCommits,
							bestScore,
							accepted,
						};
					})
					.filter((c) => c.hasCommits);

				const integration = os.integration ?? new IntegrationPipeline(os);
				const assembled = await integration.assembleBranches({
					branches: peerCandidates,
					goal,
					actorName: "substrate-trunk",
					cachePrefix: `${os.runId}:substrate`,
					totalExpectedBranches: handles.length,
					enableConflictResolution: true,
					enableSemanticRepair,
					consolidateAfterRepair: true,
					signal,
					closeoutSignal: closeoutSignal ?? os.closeoutSignal,
				});

				const accepted = os.store.list("findings", { runId: os.runId }).filter((f) => f.status === "accepted").length;
				const posts = os.store.list("posts", { runId: os.runId }).length;
				return {
					status: signal.aborted ? "stopped" : "done",
					summary: `Substrate peers (${peerCount} peers × ${rounds} rounds): ${posts} board posts, ${assembled.mergedCount} merged onto trunk (${assembled.resolvedConflicts}/${assembled.conflictCount} conflicts resolved), ${accepted} accepted findings.`,
				};
			} finally {
				await Promise.allSettled(handles.map((h) => h.close()));
			}
		},
	};
}
