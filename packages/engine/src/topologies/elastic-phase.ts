import { type JsonSchema, type SwarmOsApi, type TopologyOutcome, type TopologyPlugin } from "@one-piece/core";
import { IntegrationPipeline } from "../integration.ts";
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
		async run(os: SwarmOsApi, { goal, rubric, signal, closeoutSignal }): Promise<TopologyOutcome> {
			const hasSeatConfigs = Boolean(opts.seatConfigs && opts.seatConfigs.length > 0);
			let lanes: ExploreLane[] = [];

			// --- Phase 1: Scout & Contract Partition (N=1, skipped on pre-sharded tasks) ---
			if ((await os.waitIfPaused?.(signal)) === "coalescing") {
				return { status: "stopped", summary: "Elastic-Phase coalesced before scouting." };
			}
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
						defaultChannel: "swarm",
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
			if ((await os.waitIfPaused?.(signal)) === "coalescing") {
				return { status: "stopped", summary: "Elastic-Phase coalesced before wide exploration." };
			}
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
							defaultChannel: "swarm",
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
							"Work cleanly in your isolated git worktree, share key contracts/discoveries/subtotals on `#swarm` via `board_post`, wait for sibling data via `board_wait` when needed, preserve all cross-module invariants, verify locally, and exit cleanly.",
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
			// Delegates to shared OS IntegrationPipeline using closeoutSignal so mechanical Git assembly
			// ALWAYS runs even if workSignal aborted late exploration turns.
			let mergedCount = 0;
			let conflictCount = 0;
			let resolvedConflicts = 0;
			let trunkAccepted = false;

			if (peerBranches.length > 0) {
				os.bus.emit(os.runId, "phase.changed", {
					from: enableDreaming ? "elastic-dream-reset" : "elastic-wide-explore",
					to: "elastic-narrow-integrate",
					reason: `Assembling ${peerBranches.length} committed branches onto isolated trunk`,
				});

				const integration = os.integration ?? new IntegrationPipeline(os);
				const assembled = await integration.assembleBranches({
					branches: peerBranches
						.filter((b): b is typeof b & { branch: string } => Boolean(b.branch))
						.map((b) => ({
							handle: b.handle,
							branch: b.branch,
							agentId: b.agentId,
							driverId: b.driverId,
							laneIdx: b.laneIdx,
							bestScore: b.bestScore,
							accepted: b.accepted,
							summary: b.summary,
						})),
					goal,
					actorName: "elastic-trunk",
					cachePrefix: `${os.runId}:elastic`,
					totalExpectedBranches: peerBranches.length,
					enableConflictResolution: true,
					// Completion/repair pass below handles BOTH semantic failure AND missing planned lanes in one pass.
					enableSemanticRepair: false,
					signal,
					closeoutSignal: closeoutSignal ?? os.closeoutSignal,
				});

				mergedCount = assembled.mergedCount;
				conflictCount = assembled.conflictCount;
				resolvedConflicts = assembled.resolvedConflicts;
				let trunkFinding = assembled.trunkFinding;

				if (trunkFinding) {
					const missingLanes = !hasSeatConfigs
						? lanes
							.map((lane, idx) => ({ lane, idx }))
							.filter(({ idx }) => !assembled.mergedLaneIndices.has(idx))
						: [];
					const needsRepairOrCompletion =
						trunkFinding.status !== "accepted" || missingLanes.length > 0;

					if (enableSemanticRepair && os.trust.verifier && needsRepairOrCompletion && !signal.aborted) {
						const failReason =
							trunkFinding.status !== "accepted"
								? (trunkFinding.rounds.at(-1)?.message ?? "Executable verifier rejected assembled trunk")
								: `${missingLanes.length}/${lanes.length} planned lanes did not land on trunk: ${missingLanes.map((m) => `lane-${m.idx + 1} (${m.lane.title})`).join(", ")}`;
						const completion = await integration.runCompletionPass({
							goal,
							actorName: "elastic-trunk",
							handle: "elastic-integrator",
							cachePrefix: `${os.runId}:elastic-repair`,
							failReason,
							missingLaneSummaries: missingLanes.map((m) => `- lane-${m.idx + 1}: ${m.lane.title} — ${m.lane.description}`),
							previousFinding: trunkFinding,
							baseSha: assembled.bestGreenSha,
							consolidateBefore: enableDreaming,
							signal,
							closeoutSignal: closeoutSignal ?? os.closeoutSignal,
						});
						if (completion.finding) trunkFinding = completion.finding;
						os.bus.emit(os.runId, "peer.trunk_repaired", {
							reason: failReason.slice(0, 300),
							repaired: completion.accepted && completion.improved,
							commitSha: completion.improved ? completion.bestGreenSha : undefined,
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
