import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type JsonSchema, newId, type SwarmOsApi, type TaskRecord, type TopologyOutcome, type TopologyPlugin } from "@one-piece/core";

export interface PullRefineryOptions {
	concurrency?: number;
	leaseTtlMs?: number;
	/** Automatically invoke an impartial integrator when a clean git merge breaks the verifier (default true). */
	enableSemanticRepair?: boolean;
}

const BACKLOG_SCHEMA: JsonSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		tasks: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					key: { type: "string" },
					title: { type: "string" },
					description: { type: "string" },
					depends_on: { type: "array", items: { type: "string" } },
					owned_paths: { type: "array", items: { type: "string" } },
					acceptance_criteria: { type: "array", items: { type: "string" } },
				},
				required: ["key", "title", "description", "depends_on", "owned_paths", "acceptance_criteria"],
			},
		},
	},
	required: ["tasks"],
};

interface BacklogItem {
	key: string;
	title: string;
	description: string;
	depends_on?: string[];
	owned_paths?: string[];
	acceptance_criteria?: string[];
}

function tryExtractBacklog(candidate: string): BacklogItem[] | undefined {
	try {
		const parsed = JSON.parse(candidate) as { tasks?: BacklogItem[] };
		if (Array.isArray(parsed?.tasks) && parsed.tasks.length) {
			const items = parsed.tasks
				.filter((t) => typeof t?.title === "string" && typeof t?.description === "string")
				.map((t, i) => ({
					key: typeof t.key === "string" && t.key ? t.key : `t${i + 1}`,
					title: t.title,
					description: t.description,
					depends_on: Array.isArray(t.depends_on) ? t.depends_on.filter((d): d is string => typeof d === "string") : [],
					owned_paths: Array.isArray(t.owned_paths) ? t.owned_paths.filter((p): p is string => typeof p === "string") : undefined,
					acceptance_criteria: Array.isArray(t.acceptance_criteria)
						? t.acceptance_criteria.filter((c): c is string => typeof c === "string")
						: undefined,
				}));
			if (items.length) return items;
		}
	} catch {
		// Invalid JSON candidate.
	}
	return undefined;
}

function parseBacklog(text: string, fallbackGoal: string): BacklogItem[] {
	// 1. Direct JSON response
	const direct = tryExtractBacklog(text.trim());
	if (direct) return direct;

	// 2. Markdown fenced JSON blocks (e.g. ```json ... ```)
	for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
		const found = tryExtractBacklog(m[1]!.trim());
		if (found) return found;
	}

	// 3. Balanced-brace scan (safe when prose contains other braces)
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
					const found = tryExtractBacklog(text.slice(i, j + 1));
					if (found) return found;
					break;
				}
			}
		}
	}
	return [{ key: "t1", title: "Implement goal", description: fallbackGoal, depends_on: [] }];
}

/**
 * Native Pull-Queue + Serialized Refinery ("Brownian Ratchet") Topology:
 * 1. Planner shards goal into a DAG of atomic tickets with dependencies.
 * 2. N parallel CLI workers atomically lease ready tickets (SQLite BEGIN IMMEDIATE + fencing token)
 *    and implement them in fresh isolated git worktrees.
 * 3. A serialized single-writer Refinery merges each verified branch onto trunk one-by-one,
 *    verifying trunk monotonically on green (inspired by Gas Town / Multiclaude).
 */
export function pullRefineryTopology(opts: PullRefineryOptions = {}): TopologyPlugin {
	const concurrency = Math.max(1, opts.concurrency ?? 3);
	const leaseTtlMs = opts.leaseTtlMs ?? 300_000;
	const enableSemanticRepair = opts.enableSemanticRepair ?? true;

	return {
		name: "pull-refinery",
		description: "DAG backlog -> parallel lease-claiming CLI workers -> serialized CI-gated Refinery merge queue.",
		async run(os: SwarmOsApi, { goal, rubric, signal }): Promise<TopologyOutcome> {
			// 1. Shard backlog
			os.bus.emit(os.runId, "phase.changed", { to: "shard", reason: "Building leased task DAG" });
			const planner = await os.spawnWorker({
				role: "planner",
				readOnly: true,
				canSpawn: false,
				cacheKeyPrefix: `${os.runId}:refinery-planner`,
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
					"You are a fast backlog sharder. Read ONLY the spec doc (SPEC.md / FEATURES.md / TASK.md — layout is already in the Field Guide) and split the goal into atomic, cleanly mergeable tickets with disjoint owned_paths and concrete acceptance_criteria so parallel workers do not collide.",
					'Respond ONLY with JSON: {"tasks":[{"key":"t1","title":"...","description":"...","depends_on":[],"owned_paths":["src/a.ts"],"acceptance_criteria":["..."]}]}',
				].join("\n"),
			});
			let items: BacklogItem[];
			try {
				const res = await planner.runTurn(
					`Goal: ${goal}\n${rubric ? `Rubric: ${rubric}\n` : ""}Be fast (at most 2 file reads). Produce 2 to ${Math.max(2, Math.min(6, concurrency))} parallel atomic tasks with clean module boundaries.`,
					{ signal, outputSchema: BACKLOG_SCHEMA, timeoutMs: 55_000 },
				);
				items = parseBacklog(res.finalText, goal);
			} finally {
				await planner.close();
			}

			const keyToTaskId = new Map<string, string>();
			const tasks: TaskRecord[] = [];
			for (const item of items) {
				const deps = (item.depends_on ?? []).map((k) => keyToTaskId.get(k)).filter((id): id is string => Boolean(id));
				const created = os.createTask({
					title: item.title,
					description: item.description,
					dependsOn: deps,
					ownedPaths: item.owned_paths,
					acceptanceCriteria: item.acceptance_criteria,
					createdBy: "planner",
				});
				keyToTaskId.set(item.key, created.id);
				tasks.push(created);
			}

			// 2. Serialized Refinery merge queue (single-threaded trunk writer + neutral conflict resolver + megafile guard)
			let mergeChain: Promise<void> = Promise.resolve();
			const mergedBranches: string[] = [];
			const conflictCounts = new Map<string, number>();
			let lastTrunkSha = os.worktrees.baseSha;

			const enqueueRefinery = (task: TaskRecord, branch: string, authorAgentId: string, authorDriverId: string) => {
				const job = mergeChain.then(async () => {
					const prevTrunkSha = lastTrunkSha;
					const previewBeforeMerge = os.worktrees.mergePreviewDiff(branch);
					const merged = os.worktrees.mergeIntoTrunk(branch, { message: `refinery(${task.id}): ${task.title}` });
					if (merged.ok) {
						const finding = await os.trust.submitFinding(
							{
								agentId: authorAgentId,
								driverId: authorDriverId,
								taskId: task.id,
								workspace: os.worktrees.trunkPath,
								claim: `Refinery merged ${task.title} (${merged.commitSha.slice(0, 8)})`,
								summary: `Serialized merge of ${branch} onto isolated trunk worktree succeeded cleanly.`,
								level: "empirical",
							},
							signal,
						);

						// Monotonic green trunk ratchet: if an executable verifier rejects a clean Git merge
						// (pure semantic interference!), attempt impartial repair or roll back trunk cleanly.
						if (os.trust.verifier && finding.status !== "accepted") {
							const failReason = finding.rounds.at(-1)?.message ?? "Executable verifier rejected merged trunk";
							let repaired = false;
							if (enableSemanticRepair && !signal.aborted) {
								const repairer = await os.spawnWorker({
									role: "integrator",
									handle: "semantic-integrator",
									baseRef: merged.commitSha,
									canSpawn: false,
									cacheKeyPrefix: `${os.runId}:refinery-semantic-repair`,
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
										"You are an impartial semantic-integration repair engineer for the Refinery merge queue.",
										"Two branches merged cleanly in Git without text conflicts, yet the combined trunk failed executable verification.",
										"Diagnose the cross-module semantic interference, preserve ALL merged features, fix the interaction cleanly, and verify.",
									].join("\n"),
								});
								try {
									const repairPrompt = [
										`Goal: ${goal}`,
										`Semantic regression after cleanly merging ticket ${task.id}: ${task.title}`,
										`Verifier failure: ${failReason}`,
										"",
										`## Incoming branch diff (${previewBeforeMerge.baseSha.slice(0, 8)}..${branch})`,
										"```diff",
										previewBeforeMerge.branchDiff.slice(0, 8000),
										"```",
										"",
										"Fix the cross-feature interaction in your workspace while keeping both existing trunk features and the new ticket working.",
									].join("\n");
									const repRes = await repairer.runTurn(repairPrompt, { signal });
									const repWip = os.worktrees.commitWip(repairer.workspace, `refinery-semantic-repair(${task.id})`);
									const repHead = os.worktrees.headSha(repairer.workspace);
									const repChanged = Boolean(repWip) || (Boolean(repHead) && repHead !== merged.commitSha);
									if (repRes.status === "completed" && repChanged && repairer.branch) {
										const repMerge = os.worktrees.mergeIntoTrunk(repairer.branch, {
											message: `refinery-semantic-repair(${task.id}): ${task.title}`,
										});
										if (repMerge.ok) {
											const repFinding = await os.trust.submitFinding(
												{
													agentId: repairer.agent.id,
													driverId: repairer.agent.driverId,
													taskId: task.id,
													findingId: finding.id,
													workspace: os.worktrees.trunkPath,
													claim: `Refinery repaired semantic regression for ${task.title} (${repMerge.commitSha.slice(0, 8)})`,
													summary: `Impartial semantic repair reconciled cross-feature verifier failure on trunk.`,
													level: "empirical",
												},
												signal,
											);
											if (repFinding.status === "accepted") {
												repaired = true;
												lastTrunkSha = repMerge.commitSha;
												mergedBranches.push(branch, repairer.branch);
												os.board.publish({
													runId: os.runId,
													authorAgentId: "refinery",
													authorHandle: "refinery",
													topic: "refinery",
													summary: `Repaired semantic regression & merged ${task.id} -> trunk ${repMerge.commitSha.slice(0, 8)}`,
													isOsActor: true,
												});
											}
										}
									}
								} finally {
									await repairer.close();
								}
							}
							const rolledBack = !repaired && Boolean(os.worktrees.resetTrunk?.(prevTrunkSha));
							os.bus.emit(
								os.runId,
								"refinery.semantic_regression",
								{ taskId: task.id, branch, reason: failReason.slice(0, 300), repaired, rolledBack },
								"refinery",
							);
							if (!repaired) {
								os.board.publish({
									runId: os.runId,
									authorAgentId: "refinery",
									authorHandle: "refinery",
									topic: "refinery-conflict",
									summary: `Semantic regression on ${task.id} (${branch}): ${failReason.slice(0, 220)}${rolledBack ? " [trunk rolled back]" : ""}`,
									isOsActor: true,
								});
							}
							await os.consolidateFieldGuide?.();
							return;
						}

						lastTrunkSha = merged.commitSha;
						mergedBranches.push(branch);
						os.board.publish({
							runId: os.runId,
							authorAgentId: "refinery",
							authorHandle: "refinery",
							topic: "refinery",
							summary: `Merged ${task.id} (${branch}) -> trunk ${merged.commitSha.slice(0, 8)}`,
							isOsActor: true,
						});
						await os.consolidateFieldGuide?.();
					} else {
						const conflictFiles = merged.conflictFiles;
						for (const relFile of conflictFiles) {
							const nextCount = (conflictCounts.get(relFile) ?? 0) + 1;
							conflictCounts.set(relFile, nextCount);
							let lineCount = 0;
							const absFile = join(os.worktrees.trunkPath, relFile);
							if (existsSync(absFile)) {
								try {
									lineCount = readFileSync(absFile, "utf8").split("\n").length;
								} catch {
									// Ignore unreadable file.
								}
							}
							if (nextCount >= 2 || lineCount > 800) {
								os.board.publish({
									runId: os.runId,
									authorAgentId: "refinery",
									topic: "megafile-hotspot",
									summary: `Hotspot file ${relFile} (${lineCount} lines, ${nextCount} merge conflicts) — consider decomposing into smaller modules.`,
								});
							}
						}

						// Impartial third-party conflict resolver (neutral to both branches).
						// Allowed during closeout reserve so finished work isn't dropped at the finish line.
						if (conflictFiles.length > 0 && !signal.aborted) {
							const preview = os.worktrees.mergePreviewDiff(branch);
							const resolver = await os.spawnWorker({
								role: "integrator",
								baseRef: lastTrunkSha,
								canSpawn: false,
								cacheKeyPrefix: `${os.runId}:refinery-resolver`,
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
									"You are an impartial merge-conflict resolver for the Refinery merge queue.",
									"Your workspace starts at current trunk HEAD. Apply the incoming branch's intended changes cleanly alongside trunk's changes in the conflicting files without dropping either side's functionality.",
								].join("\n"),
							});
							try {
								const resolvePrompt = [
									`Resolve merge conflict for ticket ${task.id}: ${task.title}`,
									`Ticket description: ${task.description}`,
									...(task.acceptanceCriteria?.length
										? [`Acceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`]
										: []),
									`Conflicting files: ${conflictFiles.join(", ")}`,
									``,
									`## Trunk diff since merge-base (${preview.baseSha.slice(0, 8)}..HEAD)`,
									"```diff",
									preview.trunkDiff,
									"```",
									``,
									`## Incoming branch diff since merge-base (${preview.baseSha.slice(0, 8)}..${branch})`,
									"```diff",
									preview.branchDiff,
									"```",
									``,
									`Edit the workspace files cleanly so both trunk and incoming changes work together, then exit.`,
								].join("\n");
								const resolveRes = await resolver.runTurn(resolvePrompt, { signal });
								const resolverWip = os.worktrees.commitWip(resolver.workspace, `refinery-resolve(${task.id}): ${task.title}`);
								const resolvedHead = os.worktrees.headSha(resolver.workspace);
								const resolverMadeChanges = Boolean(resolverWip) || (Boolean(resolvedHead) && resolvedHead !== lastTrunkSha);
								if (resolveRes.status === "completed" && resolverMadeChanges && resolver.branch) {
									const resolved = os.worktrees.mergeIntoTrunk(resolver.branch, {
										message: `refinery-resolve(${task.id}): ${task.title}`,
									});
									if (resolved.ok) {
										lastTrunkSha = resolved.commitSha;
										mergedBranches.push(resolver.branch);
										os.bus.emit(
											os.runId,
											"refinery.conflict_resolved",
											{ taskId: task.id, branch, conflictFiles, commitSha: resolved.commitSha },
											resolver.agent.id,
										);
										await os.trust.submitFinding(
											{
												agentId: resolver.agent.id,
												driverId: resolver.agent.driverId,
												taskId: task.id,
												workspace: os.worktrees.trunkPath,
												claim: `Refinery resolved conflict & merged ${task.title} (${resolved.commitSha.slice(0, 8)})`,
												summary: `Neutral resolver reconciled conflicts in ${conflictFiles.join(", ")} cleanly on trunk.`,
												level: "empirical",
											},
											signal,
										);
										os.board.publish({
											runId: os.runId,
											authorAgentId: "refinery",
											topic: "refinery",
											summary: `Resolved conflict & merged ${task.id} (${conflictFiles.join(", ")}) -> trunk ${resolved.commitSha.slice(0, 8)}`,
										});
										return;
									}
								}
							} finally {
								await resolver.close();
							}
						}

						os.board.publish({
							runId: os.runId,
							authorAgentId: "refinery",
							topic: "refinery-conflict",
							summary: `Merge conflict on ${task.id} (${branch}; files: ${conflictFiles.join(", ") || "unknown"}): ${merged.error}`,
						});
					}
				});
				mergeChain = job.catch(() => {});
				return job;
			};

			// 3. Pull-queue worker slots
			os.bus.emit(os.runId, "phase.changed", { from: "shard", to: "pull-execute", reason: `Starting ${concurrency} pull-queue worker slots` });
			const runSlot = async (slotIdx: number): Promise<void> => {
				while (!signal.aborted && !os.isInCloseoutReserve()) {
					const ready = os.readyTasks();
					if (!ready.length) {
						const remaining = os.store.list("tasks", { runId: os.runId }).some((t) => t.status === "open" || t.status === "claimed");
						if (!remaining) break;
						// Wait reactively for any task.ready or task.status event instead of polling.
						await waitForTaskEvent(os, signal, 5_000);
						continue;
					}
					// Claim the atomic SQLite lease BEFORE spawning a worker so losing slots never spawn idle CLIs/worktrees.
					let claimedTarget: TaskRecord | undefined;
					let claimedLeaseOwner: string | undefined;
					let claimedFencingToken = 0;
					let claimedExpiresAt = 0;
					for (const candidate of ready) {
						const holderId = `slot-${slotIdx}-${newId("lse")}`;
						const attempt = os.store.claimTaskLease(os.runId, candidate.id, holderId, leaseTtlMs);
						if (attempt.claimed && attempt.task) {
							claimedTarget = attempt.task;
							claimedLeaseOwner = holderId;
							claimedFencingToken = attempt.task.fencingToken;
							claimedExpiresAt = attempt.task.leaseExpiresAt!;
							break;
						}
					}
					if (!claimedTarget || !claimedLeaseOwner) {
						await waitForTaskEvent(os, signal, 2_000);
						continue;
					}

					const target = claimedTarget;
					const branchBaseRef = lastTrunkSha;
					let worker;
					try {
						worker = await os.spawnWorker({
							role: "worker",
							taskId: target.id,
							baseRef: branchBaseRef,
							canSpawn: false,
							cacheKeyPrefix: `${os.runId}:refinery-worker`,
							toolScope: {
								board: "read-write",
								artifacts: true,
								findings: true,
								tasks: false,
								nominate: false,
								scheduler: "auto",
							},
							systemPrompt: [
								"You are a pull-queue worker in an isolated git worktree branched from trunk.",
								"Implement ONLY your leased ticket, run local tests, and exit cleanly so the Refinery can merge your branch.",
							].join("\n"),
						});
					} catch (error) {
						os.store.releaseTaskLease(target.id, claimedLeaseOwner, claimedFencingToken, "open");
						throw error;
					}

					os.bus.emit(
						os.runId,
						"task.claimed",
						{ taskId: target.id, agentId: worker.agent.id, fencingToken: claimedFencingToken, leaseExpiresAt: claimedExpiresAt },
						worker.agent.id,
					);

					// Heartbeat-renew the lease while the worker turn is actively running so long turns aren't stolen mid-flight.
					const renewEveryMs = Math.max(15_000, Math.floor(leaseTtlMs / 3));
					const renewTimer = setInterval(() => {
						os.store.renewTaskLease(target.id, claimedLeaseOwner, claimedFencingToken, leaseTtlMs);
					}, renewEveryMs);
					renewTimer.unref?.();

					try {
						const ownershipBlock = target.ownedPaths?.length
							? `\nOwned paths (stay within scope): ${target.ownedPaths.join(", ")}`
							: "";
						const criteriaBlock = target.acceptanceCriteria?.length
							? `\nAcceptance criteria:\n${target.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
							: "";
						const res = await worker.runTurn(
							`Worker slot #${slotIdx + 1} — Ticket ${target.id}: ${target.title}\n\n${target.description}${ownershipBlock}${criteriaBlock}\n\nGlobal goal: ${goal}`,
							{ signal },
						);
						const wip = os.worktrees.commitWip(worker.workspace, `ticket(${target.id}): ${target.title}`);
						const headAfter = os.worktrees.headSha(worker.workspace);
						const hasChanges = Boolean(wip) || (Boolean(headAfter) && headAfter !== branchBaseRef);
						const status = res.status === "completed" ? "done" : "blocked";
						os.store.releaseTaskLease(target.id, claimedLeaseOwner, claimedFencingToken, status, {
							result: res.finalText.slice(0, 800),
						});
						os.bus.emit(os.runId, "task.status", { taskId: target.id, status, result: res.finalText.slice(0, 400) }, worker.agent.id);
						// Salvage committed WIP even if wall cutoff interrupted right after edits/tests;
						// the Refinery's monotonic verifier ratchet ensures broken WIP is safely rolled back.
						if ((status === "done" || res.status === "interrupted") && hasChanges && worker.branch) {
							await enqueueRefinery(target, worker.branch, worker.agent.id, worker.agent.driverId);
						}
					} finally {
						clearInterval(renewTimer);
						await worker.close();
					}
				}
			};

			await Promise.all(Array.from({ length: concurrency }, (_, i) => runSlot(i)));
			await mergeChain;

			const doneCount = os.store.list("tasks", { runId: os.runId }).filter((t) => t.status === "done").length;
			return {
				status: signal.aborted ? "stopped" : doneCount > 0 ? "done" : "failed",
				summary: `Pull-Refinery completed ${doneCount}/${tasks.length} tickets; merged ${mergedBranches.length} branches onto trunk (${lastTrunkSha.slice(0, 8)}).`,
			};
		},
	};
}

function waitForTaskEvent(os: SwarmOsApi, signal: AbortSignal, maxWaitMs: number): Promise<void> {
	return new Promise((resolve) => {
		let unsub: (() => void) | undefined;
		const timer = setTimeout(done, maxWaitMs);
		function done() {
			clearTimeout(timer);
			unsub?.();
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
		unsub = os.bus.on((ev) => {
			if (ev.runId === os.runId && (ev.type === "task.ready" || ev.type === "task.status")) done();
		});
	});
}
