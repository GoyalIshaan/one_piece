import { type JsonSchema, type SwarmOsApi, type TopologyOutcome, type TopologyPlugin } from "@one-piece/core";
import type { SubstrateSeatConfig } from "./substrate-peers.ts";

export interface ElasticPhaseOptions {
	/** Wide-phase parallel worker count (default 3). */
	peers?: number;
	/** Max workers alias for adapter compatibility. */
	maxWorkers?: number;
	/** Optional per-seat configs for privately sharded tasks (skips Phase-1 planner). */
	seatConfigs?: readonly SubstrateSeatConfig[];
	/** Disable Phase-3 context reset / dreaming for ablation studies (default true). */
	enableDreaming?: boolean;
	/** Disable Phase-4 semantic repair for ablation studies (default true). */
	enableSemanticRepair?: boolean;
}

const PARTITION_SCHEMA: JsonSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		lanes: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					title: { type: "string" },
					description: { type: "string" },
					owned_paths: { type: "array", items: { type: "string" } },
					cross_contracts: { type: "array", items: { type: "string" } },
				},
				required: ["title", "description", "owned_paths", "cross_contracts"],
			},
		},
	},
	required: ["lanes"],
};

interface ExploreLane {
	title: string;
	description: string;
	owned_paths?: string[];
	cross_contracts?: string[];
}

function tryParseLanes(raw: string): ExploreLane[] | undefined {
	try {
		const obj = JSON.parse(raw) as { lanes?: unknown[] };
		if (!Array.isArray(obj?.lanes) || !obj.lanes.length) return undefined;
		const valid = obj.lanes
			.filter((l): l is Record<string, unknown> => Boolean(l && typeof l === "object"))
			.filter((l) => typeof l.title === "string" && typeof l.description === "string")
			.map((l) => ({
				title: String(l.title),
				description: String(l.description),
				owned_paths: Array.isArray(l.owned_paths) ? l.owned_paths.filter((p): p is string => typeof p === "string") : undefined,
				cross_contracts: Array.isArray(l.cross_contracts)
					? l.cross_contracts.filter((c): c is string => typeof c === "string")
					: undefined,
			}));
		return valid.length ? valid : undefined;
	} catch {
		return undefined;
	}
}

function parseExploreLanes(text: string, goal: string, maxLanes: number): ExploreLane[] {
	const direct = tryParseLanes(text.trim());
	if (direct) return direct.slice(0, maxLanes);
	for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
		const found = tryParseLanes(m[1]!.trim());
		if (found) return found.slice(0, maxLanes);
	}
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "{") continue;
		let depth = 0;
		let inStr = false;
		let esc = false;
		for (let j = i; j < text.length; j++) {
			const ch = text[j]!;
			if (inStr) {
				if (esc) esc = false;
				else if (ch === "\\") esc = true;
				else if (ch === '"') inStr = false;
				continue;
			}
			if (ch === '"') inStr = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					const found = tryParseLanes(text.slice(i, j + 1));
					if (found) return found.slice(0, maxLanes);
					break;
				}
			}
		}
	}
	return [{ title: "Full implementation", description: goal }];
}

/**
 * Flagship Elastic Dynamic Phase-Switching Topology (Exp 2 Frontier):
 * Dynamically changes swarm width N(t) and orchestration mode across 4 clean phases:
 *   Phase 1 (N=1, Scout): Zero-token Field Guide + lean planner partitions work & cross-module contracts
 *                         (skipped automatically on sharded tasks with explicit seatConfigs).
 *   Phase 2 (N=K, Wide Explore): K parallel peers in isolated git worktrees over Board v2 + KV-identical static prompts.
 *   Phase 3 (N=0, Dream & Context Reset): Close exploration workers, distill discoveries/failures into <=80-line Field Guide.
 *   Phase 4 (N=1, Verified Trunk Assembly & Semantic Repair): Mechanically assemble branches onto trunk, resolve git
 *                         conflicts impartially, verify trunk, and auto-repair semantic interference before nominating.
 */
export function elasticPhaseTopology(opts: ElasticPhaseOptions = {}): TopologyPlugin {
	const targetPeers = Math.max(2, opts.peers ?? opts.maxWorkers ?? opts.seatConfigs?.length ?? 3);
	const enableDreaming = opts.enableDreaming ?? true;
	const enableSemanticRepair = opts.enableSemanticRepair ?? true;

	return {
		name: "elastic-phase",
		description: "Dynamic N(t) phase-switching: Scout (N=1) -> Wide Parallel Explore (N=K) -> Dream & Reset -> Narrow Verified Integration & Semantic Repair (N=1).",
		async run(os: SwarmOsApi, { goal, rubric, signal }): Promise<TopologyOutcome> {
			const hasSeatConfigs = Boolean(opts.seatConfigs && opts.seatConfigs.length > 0);
			let lanes: ExploreLane[] = [];

			// --- Phase 1: Scout & Contract Partition (N=1, skipped on pre-sharded tasks) ---
			if (!hasSeatConfigs && !signal.aborted && !os.isInCloseoutReserve()) {
				os.bus.emit(os.runId, "phase.changed", { to: "elastic-scout", reason: `Scouting & partitioning into <= ${targetPeers} parallel lanes` });
				const scout = await os.spawnWorker({
					role: "planner",
					handle: "scout",
					readOnly: true,
					canSpawn: false,
					requireOutputSchema: true,
					cacheKeyPrefix: `${os.runId}:elastic-scout`,
					toolScope: {
						board: "read-write",
						artifacts: true,
						findings: false,
						tasks: false,
						nominate: false,
						scheduler: "never",
						skills: false,
					},
					systemPrompt: [
						"You are a fast Scout & Architect for an elastic-phase swarm.",
						"Be FAST (read ONLY the spec doc like SPEC.md / FEATURES.md / TASK.md — the Field Guide already lists the repo layout).",
						"Identify cross-module invariants/contracts that parallel workers must preserve so merged code won't break, and partition the goal into clean parallel lanes immediately.",
						'Respond ONLY with JSON: {"lanes":[{"title":"...","description":"...","owned_paths":["..."],"cross_contracts":["..."]}]}',
					].join("\n"),
				});
				try {
					const scoutPrompt = [
						`Goal: ${goal}`,
						rubric ? `Rubric: ${rubric}` : "",
						`Read the spec quickly (at most 2 file reads) and partition into 2 to ${targetPeers} disjoint parallel lanes with explicit cross_contracts (invariants every lane must preserve).`,
					].filter(Boolean).join("\n\n");
					const res = await scout.runTurn(scoutPrompt, { signal, outputSchema: PARTITION_SCHEMA, timeoutMs: 55_000 });
					lanes = parseExploreLanes(res.finalText, goal, targetPeers);
					const contracts = [...new Set(lanes.flatMap((l) => l.cross_contracts ?? []))];
					if (contracts.length) {
						os.board.publish({
							runId: os.runId,
							authorAgentId: scout.agent.id,
							authorHandle: "scout",
							topic: "cross-contracts",
							summary: `Shared cross-module invariants (${contracts.length}): ${contracts.slice(0, 4).join("; ").slice(0, 320)}`,
							body: contracts.map((c, i) => `${i + 1}. ${c}`).join("\n"),
						});
					}
				} finally {
					await scout.close();
				}
				if (enableDreaming) await os.consolidateFieldGuide?.();
			}

			// --- Phase 2: Wide Parallel Exploration (N = K) ---
			const wideCount = hasSeatConfigs ? opts.seatConfigs!.length : Math.max(1, lanes.length);
			os.bus.emit(os.runId, "phase.changed", {
				from: hasSeatConfigs ? undefined : "elastic-scout",
				to: "elastic-wide-explore",
				reason: `Launching ${wideCount} parallel isolated exploration workers`,
			});

			const peerBranches: Array<{
				handle: string;
				laneIdx: number;
				agentId: string;
				driverId: string;
				branch?: string;
				bestScore: number;
				accepted: number;
				summary: string;
			}> = [];

			const workers = await Promise.all(
				Array.from({ length: wideCount }, (_, idx) => {
					const seatCfg = opts.seatConfigs?.[idx];
					const lane = lanes[idx];
					const handle = seatCfg?.handle ?? `lane-${idx + 1}`;
					const task = lane
						? os.createTask({
							title: lane.title,
							description: lane.description,
							ownedPaths: lane.owned_paths,
							acceptanceCriteria: lane.cross_contracts,
							createdBy: "scout",
						})
						: undefined;
					return os.spawnWorker({
						role: "worker",
						handle,
						taskId: task?.id,
						canSpawn: false,
						deniedReadPaths: seatCfg?.deniedReadPaths,
						cacheKeyPrefix: `${os.runId}:elastic-worker`,
						toolScope: {
							board: "read-write",
							artifacts: true,
							// When running multiple parallel lanes, individual 1/K branches are partial;
							// hide report_finding so lanes never pollute findings or waste turns on partial rejections —
							// Phase 4 integrated trunk assembly owns deliverable verification & nomination.
							findings: wideCount <= 1 && !hasSeatConfigs,
							tasks: false,
							nominate: false,
							scheduler: "auto",
						},
						systemPrompt: [
							"You are a focused specialist engineer in the Wide Exploration phase of an elastic swarm.",
							"Work cleanly in your isolated git worktree, publish key contracts/discoveries/subtotals via `board_publish`, wait for sibling data via `board_wait` when needed, preserve all cross-module invariants, verify locally, and exit cleanly.",
						].join("\n"),
					});
				}),
			);

			try {
				// Phase-budget reservation: cap wide-exploration turn time so Phase 3 (Dreaming) and
				// Phase 4 (Verified Trunk Assembly + Semantic Auto-Repair) ALWAYS get dedicated time!
				const remWall = os.remainingWallMs?.();
				const wideTimeoutMs =
					remWall !== undefined && remWall > 20_000
						? Math.max(15_000, Math.floor(remWall * (hasSeatConfigs ? 0.85 : 0.62)))
						: undefined;

				await Promise.all(
					workers.map(async (worker, idx) => {
						if (signal.aborted) return;
						const seatCfg = opts.seatConfigs?.[idx];
						const lane = lanes[idx];
						const pulse = os.board.digest(os.runId);
						const prompt = seatCfg?.seatPrompt
							? [
								`Goal: ${goal}`,
								rubric ? `Rubric: ${rubric}` : "",
								`You are ${worker.agent.handle} (${idx + 1}/${wideCount}).`,
								pulse,
								seatCfg.seatPrompt,
							].filter(Boolean).join("\n\n")
							: [
								`Goal: ${goal}`,
								rubric ? `Rubric: ${rubric}` : "",
								`Lane ${idx + 1}/${wideCount}: ${lane?.title ?? "Implement goal"}`,
								lane?.description ?? goal,
								lane?.owned_paths?.length ? `Owned paths (avoid unnecessary edits outside): ${lane.owned_paths.join(", ")}` : "",
								lane?.cross_contracts?.length
									? `Cross-module contracts to preserve:\n${lane.cross_contracts.map((c) => `- ${c}`).join("\n")}`
									: "",
								pulse,
								"Implement your lane cleanly, coordinate interfaces on the board if needed, run tests, and finish promptly so Phase 4 trunk assembly verifies the integrated codebase.",
							].filter(Boolean).join("\n\n");

						const res = await worker.runTurn(prompt, { signal, ...(wideTimeoutMs ? { timeoutMs: wideTimeoutMs } : {}) });
						os.worktrees.commitWip(worker.workspace, `elastic(${worker.agent.handle})`);
						const headSha = os.worktrees.headSha(worker.workspace);
						const hasCommits = Boolean(worker.branch && headSha && headSha !== os.worktrees.baseSha);

						const workerFindings = os.store.list("findings", { runId: os.runId }).filter((f) => f.authorAgentId === worker.agent.id);
						if (!workerFindings.length && res.status === "completed" && hasCommits && wideCount <= 1 && !hasSeatConfigs && !signal.aborted) {
							const f = await os.trust.submitFinding(
								{
									agentId: worker.agent.id,
									driverId: worker.agent.driverId,
									workspace: worker.workspace,
									claim: `${worker.agent.handle}: ${lane?.title ?? goal.slice(0, 80)}`,
									summary: res.finalText.slice(0, 1000) || "Lane completed.",
									level: "empirical",
								},
								signal,
							);
							workerFindings.push(f);
						}

						const bestScore = workerFindings.reduce((m, f) => Math.max(m, f.score ?? f.confidence ?? 0), -Infinity);
						const accepted = workerFindings.some((f) => f.status === "accepted") ? 1 : 0;
						if (hasCommits) {
							peerBranches.push({
								handle: worker.agent.handle,
								laneIdx: idx,
								agentId: worker.agent.id,
								driverId: worker.agent.driverId,
								branch: worker.branch,
								bestScore,
								accepted,
								summary: res.finalText.slice(0, 400),
							});
						}
					}),
				);
			} finally {
				// --- Phase 3: Context Reset (close all wide-phase workers) + Wave-Boundary Dreaming ---
				await Promise.allSettled(workers.map((w) => w.close()));
			}

			if (enableDreaming && !signal.aborted) {
				os.bus.emit(os.runId, "phase.changed", {
					from: "elastic-wide-explore",
					to: "elastic-dream-reset",
					reason: "Consolidating Field Guide and resetting worker contexts before narrow integration",
				});
				await os.consolidateFieldGuide?.();
			}

			// --- Phase 4: Narrow Single-Writer Trunk Assembly, Conflict Resolution & Semantic Repair (N=1) ---
			// Mechanical Git assembly of committed lane branches ALWAYS runs (zero LLM tokens, <50ms)
			// even if the wall cutoff fired right as lanes finished committing!
			let mergedCount = 0;
			let conflictCount = 0;
			let resolvedConflicts = 0;
			let trunkAccepted = false;
			let lastTrunkSha = os.worktrees.baseSha;

			if (peerBranches.length > 0) {
				os.bus.emit(os.runId, "phase.changed", {
					from: enableDreaming ? "elastic-dream-reset" : "elastic-wide-explore",
					to: "elastic-narrow-integrate",
					reason: `Assembling ${peerBranches.length} committed branches onto isolated trunk`,
				});

				const mergedLaneIndices = new Set<number>();
				const ordered = [...peerBranches].sort((a, b) => b.accepted - a.accepted || b.bestScore - a.bestScore);
				for (const cand of ordered) {
					if (!cand.branch) continue;
					const merged = os.worktrees.mergeIntoTrunk(cand.branch, {
						message: `elastic: merge ${cand.handle} (${cand.branch})`,
					});
					if (merged.ok) {
						lastTrunkSha = merged.commitSha;
						mergedCount += 1;
						mergedLaneIndices.add(cand.laneIdx);
						continue;
					}
					conflictCount += 1;
					os.bus.emit(os.runId, "peer.conflict_detected", {
						peerHandle: cand.handle,
						branch: cand.branch,
						conflictFiles: merged.conflictFiles,
					}, "elastic-trunk");

					if (merged.conflictFiles.length > 0 && !signal.aborted) {
						const preview = os.worktrees.mergePreviewDiff(cand.branch);
						const resolver = await os.spawnWorker({
							role: "integrator",
							handle: "elastic-conflict-resolver",
							baseRef: lastTrunkSha,
							canSpawn: false,
							cacheKeyPrefix: `${os.runId}:elastic-resolver`,
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
								"You are an impartial merge-conflict integrator in the Narrow Integration phase.",
								"Reconcile both trunk and incoming changes cleanly without losing either lane's functionality or violating cross-module contracts.",
							].join("\n"),
						});
						try {
							const resolvePrompt = [
								`Goal: ${goal}`,
								`Resolve merge conflict for ${cand.handle} (${cand.branch}) in: ${merged.conflictFiles.join(", ")}`,
								`## Current trunk diff\n\`\`\`diff\n${preview.trunkDiff.slice(0, 8000)}\n\`\`\``,
								`## Incoming ${cand.handle} diff\n\`\`\`diff\n${preview.branchDiff.slice(0, 8000)}\n\`\`\``,
								"Reconcile cleanly, verify tests, and exit.",
							].join("\n\n");
							await resolver.runTurn(resolvePrompt, { signal });
							const wipSha = os.worktrees.commitWip(resolver.workspace, `elastic-resolve(${cand.handle})`);
							const headAfter = os.worktrees.headSha(resolver.workspace);
							if (resolver.branch && (wipSha || (headAfter && headAfter !== lastTrunkSha))) {
								const resMerge = os.worktrees.mergeIntoTrunk(resolver.branch, {
									message: `elastic: resolved ${cand.handle} conflict`,
								});
								if (resMerge.ok) {
									lastTrunkSha = resMerge.commitSha;
									mergedCount += 1;
									mergedLaneIndices.add(cand.laneIdx);
									resolvedConflicts += 1;
									os.bus.emit(os.runId, "peer.conflict_resolved", {
										peerHandle: cand.handle,
										branch: cand.branch,
										conflictFiles: merged.conflictFiles,
										commitSha: resMerge.commitSha,
									}, resolver.agent.id);
								}
							}
						} finally {
							await resolver.close();
						}
					}
				}

				if (mergedCount > 0) {
					// Use a fresh closeout signal for mechanical trunk verification so assembled work is never dropped on wall abort!
					const verifySig = signal.aborted ? new AbortController().signal : signal;
					let trunkFinding = await os.trust.submitFinding(
						{
							agentId: "elastic-trunk",
							workspace: os.worktrees.trunkPath,
							claim: `Elastic integrated trunk (${mergedCount}/${peerBranches.length} lanes) for: ${goal.slice(0, 100)}`,
							summary: `Assembled ${mergedCount} lane branches onto trunk (conflicts=${conflictCount}, resolved=${resolvedConflicts}).`,
							level: "empirical",
						},
						verifySig,
					);

					// Phase-4 Narrow Single-Writer Integration & Semantic Repair:
					// Trigger if verifier rejects assembled trunk OR if planned parallel lanes failed to land
					// (e.g. straggler workers left missing lanes even when lightweight public smoke tests passed!).
					const missingLanes = !hasSeatConfigs
						? lanes
							.map((lane, idx) => ({ lane, idx }))
							.filter(({ idx }) => !mergedLaneIndices.has(idx))
						: [];
					const needsRepairOrCompletion =
						trunkFinding.status !== "accepted" || missingLanes.length > 0;

					if (enableSemanticRepair && os.trust.verifier && needsRepairOrCompletion && !signal.aborted) {
						const failReason =
							trunkFinding.status !== "accepted"
								? (trunkFinding.rounds.at(-1)?.message ?? "Executable verifier rejected assembled trunk")
								: `${missingLanes.length}/${lanes.length} planned lanes did not land on trunk: ${missingLanes.map((m) => `lane-${m.idx + 1} (${m.lane.title})`).join(", ")}`;
						if (enableDreaming) await os.consolidateFieldGuide?.();
						const repairer = await os.spawnWorker({
							role: "integrator",
							handle: "elastic-integrator",
							baseRef: lastTrunkSha,
							canSpawn: false,
							cacheKeyPrefix: `${os.runId}:elastic-repair`,
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
								"You are the single-writer Integrator in Phase 4 (Narrow Integration & Semantic Repair).",
								"Committed exploration lanes have been merged onto your workspace. Complete any missing/unmerged lanes and fix any cross-module semantic interference without reverting landed lane features, verify tests, and exit.",
							].join("\n"),
						});
						let repaired = false;
						let repairedSha: string | undefined;
						try {
							const missingBlock = missingLanes.length
								? `Unmerged/missing planned lanes that STILL need implementation:\n${missingLanes.map((m) => `- lane-${m.idx + 1}: ${m.lane.title} — ${m.lane.description}`).join("\n")}`
								: "";
							const repairPrompt = [
								`Goal: ${goal}`,
								rubric ? `Rubric: ${rubric}` : "",
								trunkFinding.status !== "accepted" ? `Assembled trunk verifier failure:\n${failReason}` : "",
								missingBlock,
								`Merged lanes:\n${peerBranches.map((b) => `- ${b.handle}: ${b.summary.slice(0, 180)}`).join("\n")}`,
								"Complete all remaining requirements cleanly, resolve any cross-module semantic bugs, run tests, and leave the workspace ready to commit.",
							].filter(Boolean).join("\n\n");
							const repRes = await repairer.runTurn(repairPrompt, { signal });
							const repWip = os.worktrees.commitWip(repairer.workspace, "elastic: semantic integration repair");
							const repHead = os.worktrees.headSha(repairer.workspace);
							const repMadeChanges = Boolean(repWip) || (Boolean(repHead) && repHead !== lastTrunkSha);
							if ((repRes.status === "completed" || repRes.status === "interrupted") && repairer.branch && repMadeChanges) {
								const prevSha = lastTrunkSha;
								const prevAccepted = trunkFinding.status === "accepted";
								const repMerge = os.worktrees.mergeIntoTrunk(repairer.branch, {
									message: "elastic: semantic integration repair",
								});
								if (repMerge.ok) {
									const repVerifySig = signal.aborted ? new AbortController().signal : signal;
									const nextFinding = await os.trust.submitFinding(
										{
											agentId: repairer.agent.id,
											driverId: repairer.agent.driverId,
											findingId: trunkFinding.id,
											workspace: os.worktrees.trunkPath,
											claim: `Elastic repaired integrated trunk (${repMerge.commitSha.slice(0, 8)})`,
											summary: `Phase-4 narrow integration completed missing lanes / resolved trunk verifier failure cleanly.`,
											level: "empirical",
										},
										repVerifySig,
									);
									if (nextFinding.status === "accepted") {
										trunkFinding = nextFinding;
										repaired = true;
										repairedSha = repMerge.commitSha;
										lastTrunkSha = repMerge.commitSha;
									} else if (prevAccepted) {
										// Monotonic guard: never let a broken completion regress a previously green trunk!
										os.worktrees.resetTrunk?.(prevSha);
									} else {
										trunkFinding = nextFinding;
									}
								}
							}
						} finally {
							await repairer.close();
						}
						os.bus.emit(os.runId, "peer.trunk_repaired", {
							reason: failReason.slice(0, 300),
							repaired,
							commitSha: repairedSha,
						}, "elastic-trunk");
					}

					if (trunkFinding.status === "accepted") {
						trunkAccepted = true;
						const rev = trunkFinding.submissions.at(-1)?.revision ?? 1;
						os.nominate(trunkFinding.id, rev, false);
					}
				}
			}

			const best = os.trust.bestVerifiedFinding(os.runId);
			const status = signal.aborted ? "stopped" : best || mergedCount > 0 ? "done" : "failed";
			const summary = `Elastic-Phase (wide=${wideCount}, merged=${mergedCount}, conflicts=${resolvedConflicts}/${conflictCount}, trunkAccepted=${trunkAccepted}).`;
			if (best) {
				return {
					status,
					summary,
					nominatedFindingId: best.finding.id,
					nominatedRevision: best.revision,
				};
			}
			return { status, summary };
		},
	};
}
