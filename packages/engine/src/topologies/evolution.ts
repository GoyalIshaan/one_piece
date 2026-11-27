import {
	type EvolutionOperator,
	type ExecutionControlMode,
	type Finding,
	newId,
	type SwarmOsApi,
	type ToolDefinition,
	type TopologyOutcome,
	type TopologyPlugin,
	type WorkerHandle,
} from "@one-piece/core";
import {
	type CheckpointPolicy,
	estimateFirstPrinciplesBound,
	evaluateResearcherCheckpoint,
	type HumanCheckpointHandler,
	refineRooflineBound,
	type RooflineBound,
	type TheoreticalBound,
} from "../bounds.ts";
import { EvolutionArchiveService } from "../evolution-archive.ts";

export interface EvolutionTopologyOptions {
	/** Soft backward-compatible alias (async GA runs until convergence, Roofline checkpoint, coalesce, or reserve). */
	generations?: number | "unbounded";
	/** Soft backward-compatible initial-width suggestion (NEVER enforced as a hard worker cap). */
	populationPerGen?: number;
	/** Soft stagnation window before triggering checkpoint/stop in fallback mode. */
	plateauGenerations?: number;
	includeNegativeMemory?: boolean;
	/** Run serial Phase-0 2-Tier Roofline Bound Analyst BEFORE seeding families (guides opening strategy). */
	estimateBounds?: boolean;
	/** Pre-supplied Roofline bound (useful for tests or caller overrides). */
	initialBound?: TheoreticalBound;
	/** Execution control mode ("eval" vs "research"). Defaults to `os.controlMode ?? "research"`. */
	controlMode?: ExecutionControlMode;
	/** Policy when hitting a Researcher Checkpoint. */
	checkpointPolicy?: CheckpointPolicy;
	/** Optional callback when `checkpointPolicy === "interactive"`. */
	onHumanCheckpoint?: HumanCheckpointHandler;
	/** Wave-boundary Field Guide consolidation mode (default "deterministic"). */
	dreamingMode?: "deterministic" | "llm";
	/** Allow mutators to read/post on Board v3 channels (default true in Evolution v4). */
	enableBoard?: boolean;
}

interface ActiveEvolutionJob {
	readonly id: string;
	readonly familyId: string;
	readonly parentDirectorId: string;
	readonly handle: string;
	readonly role: "planner" | "worker";
	readonly operator: EvolutionOperator;
	readonly promise: Promise<{
		readonly id: string;
		readonly familyId: string;
		readonly handle: string;
		readonly role: "planner" | "worker";
		readonly operator: EvolutionOperator;
		readonly status: string;
		readonly branch?: string;
		readonly findingId?: string;
		readonly score?: number;
		readonly accepted?: boolean;
		readonly summary: string;
	}>;
	readonly cancel: () => void;
	readonly steer: (msg: string) => Promise<void>;
}

/**
 * Evolution v4 — Director-Led Asynchronous Recursive Genetic Algorithm:
 * - Serial Phase-0 2-Tier Roofline Bound Analyst runs BEFORE initial family seeding so physical + bottleneck
 *   ceilings guide the Root Director's opening strategy instead of blind guessing.
 * - Thin Root Evolution Director (`role: "planner"`, `canSpawn: true`) backed by pure-TypeScript
 *   `EvolutionArchiveService` drives strict GA operations via dedicated tools (`evo_launch_family`,
 *   `evo_spawn_mutation`, `evo_spawn_crossover`, `evo_stop_family`, `evo_transfer_insight`, `evo_inspect_diff`,
 *   `evo_archive_status`, `evo_await`).
 * - Zero wave barriers & zero artificial wall-clock time-slicing (`await` defaults to `mode="any"`).
 * - Real code-level crossover/merge subtrees inspect Partner B's actual `git diff` + detached read-only checkout.
 * - Unbounded optional recursion: Directors may spawn Child Family Directors (`mode="subdirector"`) OR straight
 *   leaf mutators (`role: "worker"`, compile-time `canSpawn: false`), bounded strictly by budget & PhysicsConcurrencyGovernor.
 * - Reactive Roofline empirical clamping, Paradigm-Shift Steering, and External Control-Plane (`waitIfPaused` / `pollControl`).
 */
export function evolutionTopology(opts: EvolutionTopologyOptions = {}): TopologyPlugin {
	const isUnbounded = opts.generations === "unbounded" || opts.generations === Number.POSITIVE_INFINITY;
	const softMaxFallbackWaves = isUnbounded
		? Number.POSITIVE_INFINITY
		: Math.max(1, typeof opts.generations === "number" ? opts.generations : 3);
	const softInitialWidth = Math.max(1, opts.populationPerGen ?? 4);
	const plateauLimit = Math.max(1, opts.plateauGenerations ?? (isUnbounded ? 3 : 2));
	const includeNegativeMemory = opts.includeNegativeMemory ?? true;
	const dreamingMode = opts.dreamingMode ?? "deterministic";
	const enableBoard = opts.enableBoard ?? true;

	return {
		name: "evolution",
		description:
			"Asynchronous Director-led recursive genetic algorithm over a shared verified git archive with serial Phase-0 Roofline guidance, code-level crossover, Board v3 cross-family transfer, and paradigm-shift steering.",
		async run(os: SwarmOsApi, { goal, rubric, signal, closeoutSignal }): Promise<TopologyOutcome> {
			const controlMode: ExecutionControlMode = opts.controlMode ?? os.controlMode ?? "research";
			const checkpointPolicy: CheckpointPolicy | undefined = opts.checkpointPolicy;
			const activeJobs = new Map<string, ActiveEvolutionJob>();
			const directorHandles = new Map<string, WorkerHandle>();
			let activeSteeringNotes: string[] = [...(os.activeSteeringNotes?.() ?? [])];
			let stopRequestedByCheckpoint = false;
			let checkpointStopReason = "";
			let lastCheckpointTick = 0;

			// Pause gate before Phase-0
			const initCtrl = await os.waitIfPaused?.(signal);
			if (initCtrl === "coalescing" || signal.aborted) {
				return { status: "stopped", summary: "Evolution stopped before Phase-0." };
			}

			// 1. SERIAL Phase-0 2-Tier Roofline Bound Discovery (runs BEFORE seeding so bounds guide initial families!)
			let currentBound: RooflineBound | undefined = opts.initialBound;
			if (!currentBound && opts.estimateBounds && !signal.aborted && !os.isInCloseoutReserve()) {
				os.bus.emit(os.runId, "phase.changed", {
					to: "evolution-roofline-phase0",
					reason: "Deriving serial Phase-0 2-Tier Roofline Limit Ladder before family seeding",
				});
				currentBound = await estimateFirstPrinciplesBound(os, { goal, rubric, signal });
			}

			const archive = new EvolutionArchiveService({
				initialBound: currentBound,
				higherIsBetter: currentBound?.higherIsBetter ?? true,
			});

			const syncControlPlane = async (): Promise<"running" | "coalescing" | "aborted"> => {
				const gate = (await os.waitIfPaused?.(signal)) ?? (signal.aborted ? "aborted" : "running");
				const polled = os.pollControl?.();
				if (polled?.newSteeringNotes.length) {
					activeSteeringNotes = [...activeSteeringNotes, ...polled.newSteeringNotes];
				}
				if (polled?.boundOverride && archive.roofline) {
					archive.applyBoundOverride(polled.boundOverride);
				}
				return gate;
			};

			const runReactiveRooflineAndCheckpoint = async (recentEvidence?: string): Promise<string> => {
				const best = archive.bestElite();
				if (!best) return "";
				const notes: string[] = [];

				if (archive.roofline) {
					const refined = await refineRooflineBound(os, {
						bound: archive.roofline,
						bestScore: best.score,
						goal,
						recentEvidence,
						allowLlmRefinement: false,
						signal,
					});
					archive.setRoofline(refined.bound);
					if (refined.paradigmBroken) {
						notes.push(
							`ROOFLINE BREAKTHROUGH: Verified score ${best.score.toFixed(4)} broke the prior Tier-2 paradigm ceiling!`,
						);
					}
				}

				if (archive.evaluations > lastCheckpointTick && (archive.roofline || isUnbounded)) {
					lastCheckpointTick = archive.evaluations;
					const ckpt = await evaluateResearcherCheckpoint(os, {
						goal,
						generation: archive.evaluations,
						bestScore: best.score,
						bound: archive.roofline,
						scoreHistory: archive.getScoreHistory(),
						distinctBasins: archive.distinctNicheCount(),
						controlMode,
						checkpointPolicy,
						onHumanCheckpoint: opts.onHumanCheckpoint,
						negativeMemory: archive.getNegativeMemory().map((n) => `[${n.familyId}] ${n.hypothesis} -> ${n.failureReason}`),
						signal,
					});
					switch (ckpt.action) {
						case "paradigm_shift": {
							archive.setParadigmShift({
								targetAssumption: ckpt.targetAssumption,
								directive: ckpt.directive,
								triggeredAtBestScore: best.score,
								triggeredAt: Date.now(),
							});
							try {
								os.board.publish({
									runId: os.runId,
									authorAgentId: "evolution-os",
									authorHandle: "roofline-governor",
									channel: "swarm",
									topic: "paradigm-shift",
									summary: `PARADIGM SHIFT [${ckpt.targetAssumption.id}]: ${ckpt.targetAssumption.assumption}`,
									body: ckpt.directive,
									isOsActor: true,
								});
							} catch {
								// Non-fatal board post.
							}
							notes.push(`*** PARADIGM-SHIFT DIRECTIVE [${ckpt.targetAssumption.id}] *** ${ckpt.directive}`);
							break;
						}
						case "interrupt_researcher": {
							notes.push(`Researcher Checkpoint Lab Brief written: ${ckpt.briefPath} (${ckpt.reason})`);
							if (ckpt.pauseRun && controlMode === "research") {
								os.store.put("control_commands", {
									id: newId("ctl"),
									runId: os.runId,
									issuedBy: "os",
									createdAt: Date.now(),
									payload: { type: "pause", reason: `Researcher checkpoint: ${ckpt.reason}` },
								});
								const gate = await syncControlPlane();
								if (gate === "coalescing") {
									stopRequestedByCheckpoint = true;
									checkpointStopReason = "Human chose to coalesce during Researcher Checkpoint pause";
								}
							}
							break;
						}
						case "coalesce": {
							stopRequestedByCheckpoint = true;
							checkpointStopReason = ckpt.reason;
							os.bus.emit(os.runId, "phase.changed", {
								to: "researcher-coalesce",
								reason: ckpt.reason,
							});
							notes.push(`CHECKPOINT COALESCE: ${ckpt.reason}. Wrap up immediately so the best verified elite is nominated.`);
							break;
						}
						case "continue": {
							if (ckpt.steeringNote) activeSteeringNotes.push(ckpt.steeringNote);
							if (ckpt.updatedBound) archive.applyBoundOverride(ckpt.updatedBound);
							if (ckpt.advisoryBriefPath) {
								notes.push(`Eval-mode advisory checkpoint logged (${ckpt.advisoryBriefPath}); continuing search.`);
							}
							break;
						}
					}
				}
				return notes.join("\n");
			};

			const spawnLeafWorkerJob = (params: {
				directorAgentId: string;
				familyId: string;
				operator: EvolutionOperator;
				handle: string;
				baseRef: string;
				prompt: string;
				parentFindingIds?: readonly string[];
				crossoverMeta?: { crossoverId: string; parentA: string; parentB: string; branchA: string; branchB: string; parentMaxScore: number; refPath?: string };
			}): ActiveEvolutionJob => {
				const jobId = newId("evo");
				const family = archive.getFamily(params.familyId);
				const channel = family?.channel ?? `team-${params.familyId}`;
				const jobAbort = new AbortController();
				let runningHandle: WorkerHandle | undefined;
				let cancelled = false;

				const promise = (async () => {
					let worker: WorkerHandle | undefined;
					try {
						const combined = AbortSignal.any([signal, jobAbort.signal]);
						worker = await os.spawnWorker({
							role: "worker",
							handle: params.handle,
							parentAgentId: params.directorAgentId,
							subtreeId: params.familyId,
							depth: (family?.depth ?? 0) + 1,
							baseRef: params.baseRef,
							canSpawn: false,
							passiveSnapshotOnExit: false,
							cacheKeyPrefix: `${os.runId}:evolution-mutator`,
							skills: ["evolution-hygiene"],
							toolScope: {
								board: enableBoard ? "read-write" : "none",
								defaultChannel: channel,
								defaultPostVisibility: "subtree",
								artifacts: true,
								findings: true,
								tasks: false,
								nominate: false,
								scheduler: "auto",
								canSpawn: false,
								spawnAgents: false,
								spawnTopology: false,
								evolutionDirector: false,
							},
							systemPrompt: [
								"You are an asynchronous evolutionary mutator in an isolated git worktree (cannot spawn sub-agents).",
								"Implement ONE focused, testable improvement (or code-level merge if assigned crossover), verify it rigorously, call `report_finding` with a numeric `score` when measurable, and post concise insights/dead-ends via `board_post`.",
							].join("\n"),
						});
						runningHandle = worker;
						archive.attachAgent(params.familyId, worker.agent.id);
						if (cancelled || jobAbort.signal.aborted) {
							return {
								id: jobId,
								familyId: params.familyId,
								handle: worker.agent.handle,
								role: "worker" as const,
								operator: params.operator,
								status: "interrupted",
								branch: worker.branch,
								summary: "Cancelled before turn start.",
							};
						}

						const baseHeadSha = os.worktrees.headSha(worker.workspace) ?? params.baseRef;
						const res = await worker.runTurn(params.prompt, { signal: combined });
						const wipSha = res.workspaceSnapshot?.wipSha ?? os.worktrees.commitWip(worker.workspace, `evo(${params.familyId}:${params.operator})`);
						const headAfter = res.workspaceSnapshot?.headSha ?? os.worktrees.headSha(worker.workspace) ?? baseHeadSha;
						// Compare strictly against this worker's own parent branch head (`baseHeadSha`), NOT global repo baseSha!
						const hasEdits = Boolean(wipSha) || (Boolean(headAfter) && headAfter !== baseHeadSha);
						const treeSha = res.workspaceSnapshot?.treeSha ?? os.worktrees.treeSha?.(worker.workspace) ?? os.worktrees.diffSha(worker.workspace);
						const diffStat = os.worktrees.diffStat(worker.workspace, baseHeadSha);

						let finding: Finding | undefined = os.store
							.list("findings", { runId: os.runId })
							.filter((f) => f.authorAgentId === worker!.agent.id)
							.at(-1);

						if (!finding && (res.status === "completed" || (res.status === "interrupted" && hasEdits))) {
							const verifySig = closeoutSignal ?? os.closeoutSignal ?? new AbortController().signal;
							finding = await os.trust.submitFinding(
								{
									agentId: worker.agent.id,
									driverId: worker.agent.driverId,
									workspace: worker.workspace,
									claim: `${params.handle} (${params.operator})`,
									summary: res.finalText.slice(0, 1200) || `Evolution ${params.operator} candidate`,
									level: "empirical",
									buildsOn: params.parentFindingIds?.length ? [...params.parentFindingIds] : undefined,
								},
								verifySig,
							);
						}

						let score: number | undefined;
						let accepted = false;
						if (finding && worker.branch) {
							const rec = archive.recordCandidate({
								finding,
								familyId: params.familyId,
								branch: worker.branch,
								commitSha: headAfter,
								treeSha,
								operator: params.operator,
								parentFindingIds: params.parentFindingIds,
								diffStat,
								summary: finding.summary || res.finalText.slice(0, 320),
							});
							score = rec.elite?.score ?? finding.score;
							accepted = finding.status === "accepted";
						} else {
							archive.recordNegativeMemory(
								params.familyId,
								params.prompt.slice(0, 140),
								res.error ?? "Worker exited without verifiable edits",
							);
						}

						if (params.crossoverMeta) {
							const beatBothParents =
								Boolean(accepted) &&
								score !== undefined &&
								(archive.roofline?.higherIsBetter === false
									? score < params.crossoverMeta.parentMaxScore - 1e-9
									: score > params.crossoverMeta.parentMaxScore + 1e-9);
							os.bus.emit(os.runId, "evolution.crossover_completed", {
								crossoverId: params.crossoverMeta.crossoverId,
								parentA: params.crossoverMeta.parentA,
								parentB: params.crossoverMeta.parentB,
								beatBothParents,
								childScore: score,
								parentMaxScore: params.crossoverMeta.parentMaxScore,
								findingId: finding?.id,
							});
						}

						return {
							id: jobId,
							familyId: params.familyId,
							handle: worker.agent.handle,
							role: "worker" as const,
							operator: params.operator,
							status: res.status,
							branch: worker.branch,
							findingId: finding?.id,
							score,
							accepted,
							summary: (finding?.summary || res.finalText || "Worker finished.").slice(0, 360),
						};
					} catch (err) {
						return {
							id: jobId,
							familyId: params.familyId,
							handle: params.handle,
							role: "worker" as const,
							operator: params.operator,
							status: "failed",
							summary: err instanceof Error ? err.message : String(err),
						};
					} finally {
						if (worker) {
							archive.detachAgent(params.familyId, worker.agent.id);
							await worker.close().catch(() => {});
						}
						if (params.crossoverMeta?.refPath) {
							os.worktrees.remove(params.crossoverMeta.refPath);
						}
					}
				})();

				const job: ActiveEvolutionJob = {
					id: jobId,
					familyId: params.familyId,
					parentDirectorId: params.directorAgentId,
					handle: params.handle,
					role: "worker",
					operator: params.operator,
					promise,
					cancel: () => {
						cancelled = true;
						jobAbort.abort(new Error(`Cancelled ${params.handle}`));
						void runningHandle?.interrupt?.().catch(() => {});
					},
					steer: async (msg: string) => {
						await runningHandle?.steer?.(msg);
					},
				};
				activeJobs.set(jobId, job);
				return job;
			};

			const buildDirectorTools = (directorAgentId: string, scopeFamilyId?: string, depth = 0): ToolDefinition[] => {
				const baseTools = os.defaultToolsFor("planner", {
					board: "read-write",
					defaultChannel: scopeFamilyId ? `team-${scopeFamilyId}` : "swarm",
					defaultPostVisibility: scopeFamilyId ? "subtree" : "global",
					subtreeId: scopeFamilyId ?? "root",
					artifacts: true,
					findings: true,
					tasks: false,
					nominate: false,
					scheduler: "auto",
					canSpawn: false,
					spawnAgents: false,
					spawnTopology: true,
					evolutionDirector: true,
					sidekick: true,
				});

				const gaTools: ToolDefinition[] = [
					{
						name: "evo_archive_status",
						description: "Read the live compact Evolution v4 archive ledger (families, distinct-niche elites, recommended crossover pairs, negative memory, and 2-Tier Roofline status).",
						inputSchema: {
							type: "object",
							properties: {
								family_id: { type: "string", description: "Optional family ID filter" },
							},
						},
						execute: async (args) => {
							await syncControlPlane();
							const fid = typeof args.family_id === "string" && args.family_id.trim() ? args.family_id.trim() : scopeFamilyId;
							const running = [...activeJobs.values()]
								.filter((j) => !fid || j.familyId === fid)
								.map((j) => `${j.id}:${j.handle}[${j.operator}, fam=${j.familyId}]`);
							const digest = archive.renderDirectorDigest(fid);
							const steerLine = activeSteeringNotes.length
								? `\nHuman Steering Notes: ${activeSteeringNotes.slice(-3).join(" | ")}`
								: "";
							return {
								text: `${digest}\nRunning slots (${running.length}): ${running.join(", ") || "none"}${steerLine}`,
								data: { runningCount: running.length, evaluations: archive.evaluations },
							};
						},
					},
					{
						name: "evo_inspect_diff",
						description: "Inspect the REAL git diff of an elite branch/finding (vs base or directly vs another elite) or read a specific file at that ref before designing crossover or mutations.",
						inputSchema: {
							type: "object",
							properties: {
								branch_or_finding_id: { type: "string", description: "Elite finding ID or git branch name" },
								compare_to_ref: { type: "string", description: "Optional second finding ID or git ref to diff against (defaults to run baseSha)" },
								file_path: { type: "string", description: "Optional relative file path to read verbatim at that ref" },
							},
							required: ["branch_or_finding_id"],
						},
						execute: (args) => {
							const resolveRef = (raw: string): string => {
								const clean = raw.trim();
								const byFinding = archive.getEliteByFinding(clean);
								if (byFinding) return byFinding.branch;
								return clean;
							};
							const targetRef = resolveRef(String(args.branch_or_finding_id ?? ""));
							if (!targetRef) return { text: "branch_or_finding_id is required.", isError: true };
							const filePath = typeof args.file_path === "string" && args.file_path.trim() ? args.file_path.trim() : undefined;
							if (filePath && os.worktrees.showFileAtRef) {
								try {
									const content = os.worktrees.showFileAtRef(targetRef, filePath, { maxChars: 16_000 });
									return { text: `File ${filePath} @ ${targetRef}:\n\n${content}` };
								} catch (err) {
									return { text: `Failed to read ${filePath} @ ${targetRef}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
								}
							}
							const baseRef = typeof args.compare_to_ref === "string" && args.compare_to_ref.trim()
								? resolveRef(args.compare_to_ref)
								: os.worktrees.baseSha;
							const diff = os.worktrees.diffRefs
								? os.worktrees.diffRefs(baseRef, targetRef, { maxChars: 18_000 })
								: "(diffRefs unavailable)";
							return { text: `git diff ${baseRef}..${targetRef}:\n\n${diff}` };
						},
					},
					{
						name: "evo_launch_family",
						description: "Register a new orthogonal genetic family (#team-<familyId>) and asynchronously launch either a straight leaf mutator (mode='worker') OR a recursive Child Family Director (mode='subdirector') for deeper sub-spaces.",
						inputSchema: {
							type: "object",
							properties: {
								name: { type: "string", description: "Short descriptive family name" },
								hypothesis: { type: "string", description: "Distinct structural/algorithmic hypothesis this family explores" },
								niche_tag: { type: "string", description: "Behavioral niche tag (e.g. 'memory-layout', 'tree-broadcast', 'loop-unroll')" },
								seed_prompt: { type: "string", description: "Concrete opening prompt for this family's seed worker or Child Director" },
								base_ref: { type: "string", description: "Optional git branch or finding ID to seed from (defaults to baseSha)" },
								mode: { type: "string", enum: ["worker", "subdirector"], description: "Spawn a straight leaf mutator ('worker', default) or a recursive Child Family Director ('subdirector')" },
							},
							required: ["name", "hypothesis", "niche_tag", "seed_prompt"],
						},
						execute: async (args, ctx) => {
							if (signal.aborted || os.isInCloseoutReserve() || stopRequestedByCheckpoint) {
								return { text: "Cannot launch new family: run is closing or coalescing.", isError: true };
							}
							const gate = await syncControlPlane();
							if (gate !== "running") return { text: `Cannot launch family while run is ${gate}.`, isError: true };

							const famName = String(args.name ?? "").trim();
							const hypothesis = String(args.hypothesis ?? "").trim();
							const nicheTag = String(args.niche_tag ?? "general").trim();
							const seedPrompt = String(args.seed_prompt ?? "").trim();
							if (!famName || !hypothesis || !seedPrompt) {
								return { text: "name, hypothesis, and seed_prompt are required.", isError: true };
							}
							const rawBase = typeof args.base_ref === "string" && args.base_ref.trim() ? args.base_ref.trim() : undefined;
							const resolvedBase = rawBase ? (archive.getEliteByFinding(rawBase)?.branch ?? rawBase) : os.worktrees.baseSha;
							const mode = args.mode === "subdirector" ? "subdirector" : "worker";

							const fam = archive.launchFamily({
								parentFamilyId: scopeFamilyId,
								directorAgentId: ctx.agentId,
								name: famName,
								hypothesis,
								nicheTag,
								depth: depth + 1,
							});
							os.bus.emit(
								os.runId,
								"evolution.family_launched",
								{
									familyId: fam.id,
									parentFamilyId: scopeFamilyId,
									directorAgentId: ctx.agentId,
									name: fam.name,
									hypothesis: fam.hypothesis,
									nicheTag: fam.nicheTag,
									depth: fam.depth,
								},
								ctx.agentId,
							);

							const rooflineBlock = archive.roofline
								? `Roofline (${archive.roofline.metricName}): Tier-1 Hard=${archive.roofline.hardCeiling ?? "unbounded"} | Tier-2 Paradigm=${archive.roofline.paradigmCeiling ?? "open"} | Bottleneck: ${archive.roofline.activeBottleneck}`
								: "";
							const shiftBlock = archive.paradigmShift
								? `ACTIVE PARADIGM-SHIFT DIRECTIVE: ${archive.paradigmShift.directive}`
								: "";
							const negBlock = includeNegativeMemory && archive.getNegativeMemory().length
								? `Avoid repeating known dead-ends:\n${archive.getNegativeMemory().slice(-5).map((n) => `- ${n.hypothesis} -> ${n.failureReason}`).join("\n")}`
								: "";

							if (mode === "subdirector") {
								const subJob = spawnSubDirectorJob({
									parentDirectorId: ctx.agentId,
									familyId: fam.id,
									handle: `dir-${fam.nicheTag.slice(0, 14)}-${fam.id.slice(-4)}`,
									baseRef: resolvedBase,
									depth: depth + 1,
									prompt: [
										`You are Child Family Director for family ${fam.id} ("${fam.name}", niche=${fam.nicheTag}, channel=#${fam.channel}).`,
										`Goal: ${goal}`,
										rubric ? `Rubric: ${rubric}` : "",
										`Family Hypothesis: ${fam.hypothesis}`,
										rooflineBlock,
										shiftBlock,
										negBlock,
										seedPrompt,
										`Manage mutations and code-level refinements inside your family asynchronously using evo_* tools + evo_await(mode='any'). Crosspost verified breakthroughs from #${fam.channel} up to #swarm via board_post(quote_post_id=..., channel='swarm').`,
									].filter(Boolean).join("\n\n"),
								});
								return {
									text: `Launched family ${fam.id} ("${fam.name}", #${fam.channel}) with recursive Child Family Director job=${subJob.id}. Call evo_await(mode='any') to collect results reactively.`,
									data: { familyId: fam.id, jobId: subJob.id, channel: fam.channel, mode: "subdirector" },
								};
							}

							const workerJob = spawnLeafWorkerJob({
								directorAgentId: ctx.agentId,
								familyId: fam.id,
								operator: "seed",
								handle: `seed-${fam.nicheTag.slice(0, 14)}-${fam.id.slice(-4)}`,
								baseRef: resolvedBase,
								prompt: [
									`Family ${fam.id} ("${fam.name}", niche=${fam.nicheTag}, channel=#${fam.channel}) [SEED]`,
									`Goal: ${goal}`,
									rubric ? `Rubric: ${rubric}` : "",
									`Family Hypothesis: ${fam.hypothesis}`,
									rooflineBlock,
									shiftBlock,
									negBlock,
									seedPrompt,
									`Verify rigorously, call report_finding with a numeric score, and post key findings/dead-ends to #${fam.channel} (or #swarm for urgent repo-wide discoveries) via board_post.`,
								].filter(Boolean).join("\n\n"),
							});
							return {
								text: `Launched family ${fam.id} ("${fam.name}", #${fam.channel}) with async seed worker job=${workerJob.id}. Call evo_await(mode='any') when ready to collect completions.`,
								data: { familyId: fam.id, jobId: workerJob.id, channel: fam.channel, mode: "worker" },
							};
						},
					},
					{
						name: "evo_spawn_mutation",
						description: "Asynchronously spawn a leaf mutator worker branched directly from a verified parent elite's git branch.",
						inputSchema: {
							type: "object",
							properties: {
								family_id: { type: "string", description: "Target active family ID" },
								parent_finding_id: { type: "string", description: "Verified elite finding ID to branch from" },
								mutation_directive: { type: "string", description: "Specific mutation or ablation instruction" },
							},
							required: ["family_id", "parent_finding_id", "mutation_directive"],
						},
						execute: async (args, ctx) => {
							if (signal.aborted || os.isInCloseoutReserve() || stopRequestedByCheckpoint) {
								return { text: "Cannot spawn mutation: run is closing or coalescing.", isError: true };
							}
							const gate = await syncControlPlane();
							if (gate !== "running") return { text: `Cannot spawn mutation while run is ${gate}.`, isError: true };

							const famId = String(args.family_id ?? "").trim();
							const parentId = String(args.parent_finding_id ?? "").trim();
							const directive = String(args.mutation_directive ?? "").trim();
							const fam = archive.getFamily(famId);
							if (!fam || fam.status !== "active") {
								return { text: `Active family not found: ${famId}`, isError: true };
							}
							const parent = archive.getEliteByFinding(parentId);
							if (!parent) {
								return { text: `Parent elite finding not found in archive: ${parentId}`, isError: true };
							}
							const negBlock = includeNegativeMemory && archive.getNegativeMemory().length
								? `Negative memory (do not repeat):\n${archive.getNegativeMemory().slice(-5).map((n) => `- ${n.hypothesis} -> ${n.failureReason}`).join("\n")}`
								: "";
							const shiftBlock = archive.paradigmShift
								? `ACTIVE PARADIGM-SHIFT DIRECTIVE: ${archive.paradigmShift.directive}`
								: "";
							const job = spawnLeafWorkerJob({
								directorAgentId: ctx.agentId,
								familyId: fam.id,
								operator: "mutate",
								handle: `mut-${fam.nicheTag.slice(0, 12)}-${newId("m").slice(-4)}`,
								baseRef: parent.branch,
								parentFindingIds: [parent.findingId],
								prompt: [
									`Family ${fam.id} ("${fam.name}") [MUTATE from ${parent.findingId}, score=${parent.score.toFixed(4)}]`,
									`Goal: ${goal}`,
									rubric ? `Rubric: ${rubric}` : "",
									shiftBlock,
									`Parent Summary: ${parent.summary}`,
									`Mutation Directive: ${directive}`,
									negBlock,
									"Verify strictly, beat the parent score, and call `report_finding` with a numeric `score`.",
								].filter(Boolean).join("\n\n"),
							});
							return {
								text: `Spawned async mutation job=${job.id} (${job.handle}) in family ${fam.id} off ${parent.branch}.`,
								data: { jobId: job.id, familyId: fam.id, baseBranch: parent.branch },
							};
						},
					},
					{
						name: "evo_spawn_crossover",
						description: "Asynchronously spawn a dedicated Code-Level Crossover/Merge Subtree starting on Parent A's git branch while providing Parent B's FULL real git diff AND a read-only reference checkout of Parent B.",
						inputSchema: {
							type: "object",
							properties: {
								parent_a_finding_id: { type: "string", description: "Primary elite finding ID (worktree starts on its branch)" },
								parent_b_finding_id: { type: "string", description: "Partner elite finding ID (full git diff + read-only checkout attached)" },
								synthesis_hypothesis: { type: "string", description: "Why combining A and B should beat max(score(A), score(B))" },
								target_family_id: { type: "string", description: "Optional target active family ID (defaults to Parent A's family)" },
							},
							required: ["parent_a_finding_id", "parent_b_finding_id", "synthesis_hypothesis"],
						},
						execute: async (args, ctx) => {
							if (signal.aborted || os.isInCloseoutReserve() || stopRequestedByCheckpoint) {
								return { text: "Cannot spawn crossover: run is closing or coalescing.", isError: true };
							}
							const gate = await syncControlPlane();
							if (gate !== "running") return { text: `Cannot spawn crossover while run is ${gate}.`, isError: true };

							const idA = String(args.parent_a_finding_id ?? "").trim();
							const idB = String(args.parent_b_finding_id ?? "").trim();
							const hypothesis = String(args.synthesis_hypothesis ?? "").trim();
							const eliteA = archive.getEliteByFinding(idA);
							const eliteB = archive.getEliteByFinding(idB);
							if (!eliteA || !eliteB) {
								return { text: `Both parent_a (${idA}) and parent_b (${idB}) must exist in archive.`, isError: true };
							}
							if (eliteA.findingId === eliteB.findingId) {
								return { text: "Crossover requires two distinct elite findings.", isError: true };
							}
							const famId = typeof args.target_family_id === "string" && args.target_family_id.trim()
								? args.target_family_id.trim()
								: eliteA.familyId;
							const crossoverId = newId("xov");
							const parentDiffB = os.worktrees.diffRefs
								? os.worktrees.diffRefs(os.worktrees.baseSha, eliteB.branch, { maxChars: 14_000 })
								: eliteB.diffStat;
							let refPath: string | undefined;
							try {
								refPath = os.worktrees.createReadOnlyReference?.(eliteB.branch, `xov-${crossoverId}`);
							} catch {
								refPath = undefined;
							}
							const parentMaxScore = archive.roofline?.higherIsBetter === false
								? Math.min(eliteA.score, eliteB.score)
								: Math.max(eliteA.score, eliteB.score);

							os.bus.emit(
								os.runId,
								"evolution.crossover_started",
								{
									crossoverId,
									parentA: eliteA.findingId,
									parentB: eliteB.findingId,
									branchA: eliteA.branch,
									branchB: eliteB.branch,
									mode: "subtree",
								},
								ctx.agentId,
							);

							const job = spawnLeafWorkerJob({
								directorAgentId: ctx.agentId,
								familyId: famId,
								operator: "crossover",
								handle: `xov-${crossoverId.slice(-5)}`,
								baseRef: eliteA.branch,
								parentFindingIds: [eliteA.findingId, eliteB.findingId],
								crossoverMeta: {
									crossoverId,
									parentA: eliteA.findingId,
									parentB: eliteB.findingId,
									branchA: eliteA.branch,
									branchB: eliteB.branch,
									parentMaxScore,
									refPath,
								},
								prompt: [
									`CODE-LEVEL CROSSOVER ${crossoverId}: Parent A=${eliteA.findingId} (score=${eliteA.score.toFixed(4)}) × Parent B=${eliteB.findingId} (score=${eliteB.score.toFixed(4)})`,
									`Goal: ${goal}`,
									rubric ? `Rubric: ${rubric}` : "",
									`Synthesis Hypothesis: ${hypothesis}`,
									`Your writable worktree starts on Parent A (${eliteA.branch}).`,
									refPath ? `Read-only full source checkout of Parent B (${eliteB.branch}) is mounted at: ${refPath}` : "",
									`## Parent B Actual Git Diff (${os.worktrees.baseSha.slice(0, 8)}..${eliteB.branch})\n\`\`\`diff\n${parentDiffB}\n\`\`\``,
									`Target Acceptance Bar: Combine the complementary mechanisms of A and B cleanly so the verified score beats ${parentMaxScore.toFixed(4)} (or passes the union of checks), then call \`report_finding\` with a numeric \`score\`.`,
								].filter(Boolean).join("\n\n"),
							});
							return {
								text: `Spawned code-level crossover job=${job.id} (${crossoverId}) combining ${eliteA.findingId} × ${eliteB.findingId}${refPath ? ` (Partner B ref mounted at ${refPath})` : ""}.`,
								data: { jobId: job.id, crossoverId, parentA: eliteA.findingId, parentB: eliteB.findingId },
							};
						},
					},
					{
						name: "evo_stop_family",
						description: "Cancel running agents in a stagnating family, mark it pruned, record negative memory, and optionally crosspost lessons to #swarm.",
						inputSchema: {
							type: "object",
							properties: {
								family_id: { type: "string" },
								reason: { type: "string" },
								transfer_summary: { type: "string", description: "Optional concise lessons to share with remaining families on #swarm" },
							},
							required: ["family_id", "reason"],
						},
						execute: (args, ctx) => {
							const famId = String(args.family_id ?? "").trim();
							const reason = String(args.reason ?? "").trim() || "Pruned by Evolution Director";
							let cancelledCount = 0;
							for (const job of activeJobs.values()) {
								if (job.familyId === famId) {
									job.cancel();
									cancelledCount += 1;
								}
							}
							const pruned = archive.pruneFamily(famId, reason);
							if (!pruned.ok) {
								return { text: `Could not prune family ${famId} (missing or already terminal).`, isError: true };
							}
							os.bus.emit(
								os.runId,
								"evolution.family_pruned",
								{ familyId: famId, reason, bestScore: pruned.bestScore },
								ctx.agentId,
							);
							const transfer = typeof args.transfer_summary === "string" && args.transfer_summary.trim() ? args.transfer_summary.trim() : undefined;
							if (transfer) {
								os.board.publish({
									runId: os.runId,
									authorAgentId: ctx.agentId,
									channel: "swarm",
									topic: "family-lessons",
									summary: `Pruned family ${famId}: ${transfer.slice(0, 260)}`,
									body: `Reason: ${reason}\n\nLessons for other families:\n${transfer}`,
								});
							}
							return {
								text: `Pruned family ${famId} (cancelled ${cancelledCount} active job(s)).`,
								data: { familyId: famId, cancelledCount },
							};
						},
					},
					{
						name: "evo_transfer_insight",
						description: "Transfer a verified discovery or dead-end across families via Board v3 crossposting (#team -> #swarm or target #team) and live worker steering.",
						inputSchema: {
							type: "object",
							properties: {
								from_family_id: { type: "string" },
								to_family_id_or_all: { type: "string", description: "'all' (crossposts to #swarm + steers active workers) or a specific target family ID" },
								summary: { type: "string" },
								quote_post_id: { type: "string", description: "Optional source board post ID to quote/crosspost" },
							},
							required: ["from_family_id", "to_family_id_or_all", "summary"],
						},
						execute: async (args, ctx) => {
							const fromFam = String(args.from_family_id ?? "").trim();
							const target = String(args.to_family_id_or_all ?? "all").trim();
							const summary = String(args.summary ?? "").trim();
							const quotePostId = typeof args.quote_post_id === "string" && args.quote_post_id.trim() ? args.quote_post_id.trim() : undefined;
							if (!summary) return { text: "summary is required.", isError: true };

							const targetFam = target !== "all" ? archive.getFamily(target) : undefined;
							const channel = targetFam ? targetFam.channel : "swarm";
							const post = os.board.publish({
								runId: os.runId,
								authorAgentId: ctx.agentId,
								channel,
								topic: "cross-family-insight",
								quotedPostId: quotePostId,
								summary: `[${fromFam} -> ${target}] ${summary.slice(0, 260)}`,
								body: summary,
							});
							let steered = 0;
							for (const job of activeJobs.values()) {
								if (target === "all" ? job.familyId !== fromFam : job.familyId === target) {
									await job.steer(`[Insight from family ${fromFam}] ${summary}`).catch(() => {});
									steered += 1;
								}
							}
							return {
								text: `Transferred insight via ${post.id} in #${channel} and steered ${steered} active worker(s).`,
								data: { postId: post.id, channel, steered },
							};
						},
					},
					{
						name: "evo_await",
						description: "Wait asynchronously for running evolution workers or Child Family Directors (defaults to mode='any' so there are ZERO wave barrier stalls). Runs reactive Roofline checks & returns updated archive digest.",
						inputSchema: {
							type: "object",
							properties: {
								job_ids: { type: "array", items: { type: "string" }, description: "Optional specific job IDs to await" },
								mode: { type: "string", enum: ["any", "all"], description: "Default 'any' (reactive zero-barrier scheduling)" },
								timeout_seconds: { type: "number", minimum: 1, maximum: 600 },
							},
						},
						execute: async (args, ctx) => {
							const gate = await syncControlPlane();
							if (gate === "coalescing") {
								return { text: "Run is coalescing — finish up so best verified elite is nominated." };
							}
							const requested = Array.isArray(args.job_ids)
								? args.job_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
								: [];
							const targets = requested.length
								? requested.map((id) => activeJobs.get(id)).filter((j): j is ActiveEvolutionJob => Boolean(j))
								: [...activeJobs.values()].filter((j) => j.parentDirectorId === ctx.agentId);
							if (!targets.length) {
								return { text: "No active evolution jobs to await.\n\n" + archive.renderDirectorDigest(scopeFamilyId) };
							}

							const mode = args.mode === "all" ? "all" : "any";
							const timeoutMs = typeof args.timeout_seconds === "number" && Number.isFinite(args.timeout_seconds)
								? Math.max(1_000, Math.floor(args.timeout_seconds * 1_000))
								: undefined;
							const raceWithTimeout = async <T>(p: Promise<T>): Promise<T | "TIMED_OUT"> => {
								if (!timeoutMs) return p;
								return Promise.race([
									p,
									new Promise<"TIMED_OUT">((r) => {
										const t = setTimeout(() => r("TIMED_OUT"), timeoutMs);
										t.unref?.();
									}),
								]);
							};

							// Park director's concurrency permit while awaiting children so 1-slot pools never deadlock!
							const dirHandle = directorHandles.get(directorAgentId);
							dirHandle?.selection.park?.();
							let settled: Array<Awaited<ActiveEvolutionJob["promise"]>> | "TIMED_OUT";
							try {
								settled = mode === "all"
									? await raceWithTimeout(Promise.all(targets.map((t) => t.promise)))
									: await raceWithTimeout(Promise.race(targets.map((t) => t.promise)).then((r) => [r]));
							} finally {
								dirHandle?.selection.unpark?.();
							}

							if (settled === "TIMED_OUT") {
								return { text: `evo_await timed out after ${args.timeout_seconds}s while ${targets.length} job(s) remain running.` };
							}

							for (const s of settled) {
								activeJobs.delete(s.id);
							}

							// Run reactive Roofline refinement & checkpoint check on wakeup (only at root level or on accepted wins)
							const evidence = settled.map((s) => `${s.handle}[${s.operator}]: score=${s.score ?? "n/a"} ${s.summary}`).join("\n");
							const ckptNotes = !scopeFamilyId ? await runReactiveRooflineAndCheckpoint(evidence) : "";
							const resultLines = settled.map(
								(s) =>
									`- ${s.id} (${s.handle}, fam=${s.familyId}, op=${s.operator}, status=${s.status}${s.findingId ? `, finding=${s.findingId}` : ""}${s.score !== undefined ? `, score=${s.score.toFixed(4)}` : ""}${s.accepted ? " [ACCEPTED]" : ""}): ${s.summary.slice(0, 220)}`,
							);
							const remainingCount = [...activeJobs.values()].filter((j) => j.parentDirectorId === ctx.agentId).length;
							return {
								text: [
									`Collected ${settled.length} evolution job(s) (${remainingCount} still running):`,
									...resultLines,
									...(ckptNotes ? ["", ckptNotes] : []),
									"",
									archive.renderDirectorDigest(scopeFamilyId),
								].join("\n"),
								data: { results: settled, remainingCount, shouldStop: stopRequestedByCheckpoint },
							};
						},
					},
				];

				return [...baseTools, ...gaTools].sort((a, b) => a.name.localeCompare(b.name));
			};

			const spawnSubDirectorJob = (params: {
				parentDirectorId: string;
				familyId: string;
				handle: string;
				baseRef: string;
				depth: number;
				prompt: string;
			}): ActiveEvolutionJob => {
				const jobId = newId("sdir");
				const jobAbort = new AbortController();
				let runningHandle: WorkerHandle | undefined;
				let cancelled = false;

				const promise = (async () => {
					let subDir: WorkerHandle | undefined;
					try {
						const combined = AbortSignal.any([signal, jobAbort.signal]);
						const subIdHint = newId("agt");
						const subTools = buildDirectorTools(subIdHint, params.familyId, params.depth);
						subDir = await os.spawnWorker({
							role: "planner",
							handle: params.handle,
							parentAgentId: params.parentDirectorId,
							subtreeId: params.familyId,
							depth: params.depth,
							baseRef: params.baseRef,
							canSpawn: true,
							passiveSnapshotOnExit: true,
							cacheKeyPrefix: `${os.runId}:evolution-subdirector`,
							tools: subTools,
							toolScope: {
								board: "read-write",
								defaultChannel: `team-${params.familyId}`,
								artifacts: true,
								findings: true,
								tasks: false,
								nominate: false,
								canSpawn: true,
								spawnTopology: true,
								evolutionDirector: true,
							},
							systemPrompt: [
								"You are a recursive Child Family Director managing a focused search subspace in Evolution v4.",
								"Use `evo_spawn_mutation`, `evo_launch_family` (worker or nested subdirector), `evo_inspect_diff`, `evo_spawn_crossover`, `evo_transfer_insight`, and `evo_await(mode='any')` asynchronously.",
								"Crosspost verified breakthroughs from your team channel to `#swarm` via `board_post(quote_post_id=..., channel='swarm')`.",
							].join("\n"),
						});
						runningHandle = subDir;
						directorHandles.set(subIdHint, subDir);
						directorHandles.set(subDir.agent.id, subDir);
						archive.attachAgent(params.familyId, subDir.agent.id);

						if (cancelled || jobAbort.signal.aborted) {
							return {
								id: jobId,
								familyId: params.familyId,
								handle: subDir.agent.handle,
								role: "planner" as const,
								operator: "subdirector" as const,
								status: "interrupted",
								summary: "Sub-director cancelled before turn start.",
							};
						}
						const res = await subDir.runTurn(params.prompt, { signal: combined });
						const famBest = archive.bestElite(params.familyId);
						return {
							id: jobId,
							familyId: params.familyId,
							handle: subDir.agent.handle,
							role: "planner" as const,
							operator: "subdirector" as const,
							status: res.status,
							branch: famBest?.branch ?? subDir.branch,
							findingId: famBest?.findingId,
							score: famBest?.score,
							accepted: famBest?.accepted,
							summary: (res.finalText || `Sub-director finished (best=${famBest?.score?.toFixed(4) ?? "n/a"}).`).slice(0, 360),
						};
					} catch (err) {
						return {
							id: jobId,
							familyId: params.familyId,
							handle: params.handle,
							role: "planner" as const,
							operator: "subdirector" as const,
							status: "failed",
							summary: err instanceof Error ? err.message : String(err),
						};
					} finally {
						if (subDir) {
							archive.detachAgent(params.familyId, subDir.agent.id);
							directorHandles.delete(subDir.agent.id);
							await subDir.close().catch(() => {});
						}
					}
				})();

				const job: ActiveEvolutionJob = {
					id: jobId,
					familyId: params.familyId,
					parentDirectorId: params.parentDirectorId,
					handle: params.handle,
					role: "planner",
					operator: "subdirector",
					promise,
					cancel: () => {
						cancelled = true;
						jobAbort.abort(new Error(`Cancelled subdirector ${params.handle}`));
						void runningHandle?.interrupt?.().catch(() => {});
					},
					steer: async (msg: string) => {
						await runningHandle?.steer?.(msg);
					},
				};
				activeJobs.set(jobId, job);
				return job;
			};

			// 2. Launch Root Evolution Director (`role: "planner"`, `canSpawn: true`)
			os.bus.emit(os.runId, "phase.changed", {
				to: "evolution-director",
				reason: "Launching Director-Led Asynchronous Recursive GA (zero wave barriers, code-level crossover)",
			});

			const rootKey = newId("rootdir");
			const rootTools = buildDirectorTools(rootKey, undefined, 0);
			const rootDirector = await os.spawnWorker({
				role: "planner",
				handle: "evolution-director",
				subtreeId: "root",
				depth: 0,
				canSpawn: true,
				passiveSnapshotOnExit: true,
				cacheKeyPrefix: `${os.runId}:evolution-director`,
				tools: rootTools,
				toolScope: {
					board: "read-write",
					defaultChannel: "swarm",
					artifacts: true,
					findings: true,
					tasks: false,
					nominate: false,
					canSpawn: true,
					spawnTopology: true,
					evolutionDirector: true,
					sidekick: true,
				},
				systemPrompt: [
					"You are the Root Evolution Director running a true Asynchronous, Recursive Genetic Algorithm over a shared verified git archive.",
					"You have dedicated GA tools (`evo_launch_family`, `evo_spawn_mutation`, `evo_spawn_crossover`, `evo_inspect_diff`, `evo_stop_family`, `evo_transfer_insight`, `evo_archive_status`, `evo_await`) plus Board v3 (`board_post`, `board_edit`, `board_search`, `board_visit`, `board_wait`) and composable `spawn_topology`.",
					"Protocol:",
					"1. Seed distinct orthogonal genetic families immediately via `evo_launch_family` (never duplicate generic prompts!). Use the Phase-0 Roofline Limit Ladder below to pick structurally distinct algorithmic hypotheses aimed at the real bottleneck.",
					"2. Schedule asynchronously with `evo_await(mode='any')` so you react the instant ANY worker lands a win or fails (zero wave barriers!).",
					"3. Inspect actual winning code diffs with `evo_inspect_diff`. Whenever two families achieve complementary gains, launch a code-level `evo_spawn_crossover(parent_a, parent_b, synthesis_hypothesis)` so the merge subtree sees both real implementations.",
					"4. Prune stagnating families with `evo_stop_family`, transfer lessons via `evo_transfer_insight`, and spawn recursive Child Family Directors (`mode='subdirector'`) whenever a promising basin warrants dedicated deep search.",
					"5. If a `[PARADIGM-SHIFT DIRECTIVE]` arrives, stop micro-tuning the saturated Tier-2 paradigm and launch a family explicitly breaking the named assumption.",
					"6. Conclude once converged, coalesced, or approaching closeout reserve—the highest-scoring verified elite is nominated automatically.",
				].join("\n"),
			});
			directorHandles.set(rootKey, rootDirector);
			directorHandles.set(rootDirector.agent.id, rootDirector);

			let directorSummary = "";
			try {
				const rooflineBrief = archive.roofline
					? [
						"## Phase-0 2-Tier Roofline Limit Ladder (use this to guide initial family hypotheses!)",
						`- Metric: ${archive.roofline.metricName} (${archive.roofline.higherIsBetter ? "higher is better" : "lower is better"})`,
						`- Tier-1 Hard Speed-of-Light Ceiling: ${archive.roofline.hardCeiling ?? "unbounded"}${archive.roofline.isProvenHard ? " [PROVEN]" : ""}`,
						`- Tier-2 Current-Paradigm Ceiling: ${archive.roofline.paradigmCeiling ?? "open"}`,
						`- Active Bottleneck: ${archive.roofline.activeBottleneck}`,
						`- Derivation: ${archive.roofline.derivationSummary}`,
						...(archive.roofline.breakableAssumptions.length
							? [
								"- Breakable Assumptions:",
								...archive.roofline.breakableAssumptions.map((a) => `  * [${a.id} · ${a.tier}] ${a.assumption} -> Unlock: ${a.unlockHint}`),
							]
							: []),
					].join("\n")
					: "";

				const rootPrompt = [
					`Goal: ${goal}`,
					rubric ? `Rubric: ${rubric}` : "",
					rooflineBrief,
					activeSteeringNotes.length ? `Human Steering Notes:\n${activeSteeringNotes.map((s) => `- ${s}`).join("\n")}` : "",
					"Inspect the problem briefly if needed (or delegate_explore), then launch structurally orthogonal genetic families via `evo_launch_family`, await completions reactively with `evo_await(mode='any')`, inspect real diffs, run code-level crossovers, and manage families until optimal or coalesced.",
				].filter(Boolean).join("\n\n");

				const res = await rootDirector.runTurn(rootPrompt, { signal });
				directorSummary = res.finalText.slice(0, 800);
			} finally {
				// Drain any remaining launched jobs gracefully if work hasn't been hard-aborted
				const lingering = [...activeJobs.values()];
				if (lingering.length && !signal.aborted && !stopRequestedByCheckpoint) {
					await Promise.allSettled(lingering.map((j) => j.promise));
				} else {
					for (const j of lingering) j.cancel();
					await Promise.allSettled(lingering.map((j) => j.promise));
				}
				activeJobs.clear();
				directorHandles.delete(rootKey);
				directorHandles.delete(rootDirector.agent.id);
				await rootDirector.close().catch(() => {});
			}

			// 3. Resilience Fallback: if the Director returned without launching ANY family
			// (e.g., scripted test driver without MCP tool calling), execute an async OS-driven evolutionary loop
			// with zero artificial time-slicing, full Roofline clamping, Paradigm-Shift steering, and waitIfPaused!
			if (archive.listFamilies().length === 0 && !signal.aborted && !os.isInCloseoutReserve()) {
				const fallbackFam = archive.launchFamily({
					directorAgentId: rootDirector.agent.id,
					name: "autonomous-fallback",
					hypothesis: "Direct archive-guided evolutionary refinement",
					nicheTag: "fallback",
					depth: 1,
				});
				let staleWaves = 0;
				const genDenom = Number.isFinite(softMaxFallbackWaves) ? `/${softMaxFallbackWaves}` : "";
				for (let gen = 1; gen <= softMaxFallbackWaves; gen++) {
					const gate = await syncControlPlane();
					if (gate !== "running" || signal.aborted || os.isInCloseoutReserve() || stopRequestedByCheckpoint) break;
					os.bus.emit(os.runId, "phase.changed", { to: `evolution-gen-${gen}`, reason: `Async fallback wave ${gen}, archive=${archive.listElites().length}` });
					const elites = archive.listElites();
					const prevBest = archive.bestElite()?.score ?? Number.NEGATIVE_INFINITY;
					const jobs = Array.from({ length: softInitialWidth }, (_, slot) => {
						const isCrossoverSlot = slot === 1 && elites.length >= 2;
						const parent = isCrossoverSlot ? elites[0] : elites.length ? elites[slot % Math.min(elites.length, 4)] : undefined;
						const partner = isCrossoverSlot ? elites[1] : undefined;
						const shiftLine = archive.paradigmShift && slot >= 1
							? `[PARADIGM-SHIFT] ${archive.paradigmShift.directive}`
							: "";
						const boundLine = archive.roofline
							? `Roofline (${archive.roofline.metricName}): Hard=${archive.roofline.hardCeiling ?? "unbounded"}, Paradigm=${archive.roofline.paradigmCeiling ?? "open"}, Bottleneck=${archive.roofline.activeBottleneck}`
							: "";
						const partnerDiff = partner && os.worktrees.diffRefs
							? `\nPartner B diff:\n${os.worktrees.diffRefs(os.worktrees.baseSha, partner.branch, { maxChars: 6000 })}`
							: "";
						return spawnLeafWorkerJob({
							directorAgentId: rootDirector.agent.id,
							familyId: fallbackFam.id,
							operator: partner ? "crossover" : parent ? "mutate" : "seed",
							handle: `evo-g${gen}-s${slot + 1}`,
							baseRef: parent?.branch ?? os.worktrees.baseSha,
							parentFindingIds: partner && parent ? [parent.findingId, partner.findingId] : parent ? [parent.findingId] : undefined,
							prompt: [
								`Generation ${gen}${genDenom}, Slot ${slot + 1}/${softInitialWidth}${shiftLine ? " [PARADIGM-SHIFT]" : partner ? " [CROSSOVER]" : slot === 0 ? " [EXPLOIT]" : " [EXPLORE]"}`,
								`Goal: ${goal}`,
								rubric ? `Rubric: ${rubric}` : "",
								boundLine,
								shiftLine,
								activeSteeringNotes.length ? `Researcher Steering Note: ${activeSteeringNotes.at(-1)}` : "",
								parent ? `Parent incumbent (score=${parent.score.toFixed(4)}): ${parent.summary}` : "Starting from base repository seed.",
								partnerDiff,
								"Propose ONE concrete, testable improvement, verify strictly, and call `report_finding`.",
							].filter(Boolean).join("\n\n"),
						});
					});
					await Promise.allSettled(jobs.map((j) => j.promise));
					for (const j of jobs) activeJobs.delete(j.id);

					if (gen < softMaxFallbackWaves && !signal.aborted) {
						await os.consolidateFieldGuide?.({ mode: dreamingMode });
					}

					const ckptNotes = await runReactiveRooflineAndCheckpoint();
					if (stopRequestedByCheckpoint) break;

					const newBest = archive.bestElite()?.score ?? Number.NEGATIVE_INFINITY;
					const improved = archive.roofline?.higherIsBetter === false
						? newBest < prevBest - 1e-9
						: newBest > prevBest + 1e-9;
					if (improved || ckptNotes.includes("PARADIGM-SHIFT")) staleWaves = 0;
					else staleWaves += 1;

					if (staleWaves >= plateauLimit && archive.listElites().length > 0) {
						if (controlMode === "research" && archive.roofline && archive.roofline.hardCeiling !== null) {
							// Never silently drop a real research run with Tier-1 headroom; emit a checkpoint instead.
							await runReactiveRooflineAndCheckpoint("Stagnation reached with open Tier-1 headroom");
							if (stopRequestedByCheckpoint) break;
						} else {
							os.bus.emit(os.runId, "phase.changed", {
								from: `evolution-gen-${gen}`,
								to: "plateau-stop",
								reason: `No archive score improvement for ${staleWaves} consecutive waves`,
							});
							break;
						}
					}
				}
			}

			// 4. Nominate single best verified elite (if any)
			const best = archive.bestElite();
			if (best && best.accepted) {
				os.nominate(best.findingId, best.revision);
				return {
					status: signal.aborted ? "stopped" : "done",
					summary: `Evolution v4 completed: ${archive.listFamilies().length} families, ${archive.listElites().length} archive elites, best=${best.findingId} (score=${best.score.toFixed(4)})${checkpointStopReason ? ` [${checkpointStopReason}]` : ""}. ${directorSummary}`.trim(),
					nominatedFindingId: best.findingId,
					nominatedRevision: best.revision,
				};
			}

			const trustBest = os.trust.bestVerifiedFinding(os.runId);
			if (trustBest) {
				os.nominate(trustBest.finding.id, trustBest.revision, true);
				return {
					status: signal.aborted ? "stopped" : "done",
					summary: `Evolution v4 completed: ${archive.listFamilies().length} families, nominated ${trustBest.finding.id}. ${directorSummary}`.trim(),
					nominatedFindingId: trustBest.finding.id,
					nominatedRevision: trustBest.revision,
				};
			}

			return {
				status: signal.aborted ? "stopped" : "done",
				summary: `Evolution v4 completed: ${archive.listFamilies().length} families, ${archive.listElites().length} archive entries. ${directorSummary}`.trim(),
			};
		},
	};
}
