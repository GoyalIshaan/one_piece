import { type JsonSchema, newId, type SwarmOsApi, type TaskRecord, type TopologyOutcome, type TopologyPlugin } from "@one-piece/core";
import { IntegrationPipeline } from "../integration.ts";

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
		async run(os: SwarmOsApi, { goal, rubric, signal, closeoutSignal }): Promise<TopologyOutcome> {
			// 1. Shard backlog
			if ((await os.waitIfPaused?.(signal)) === "coalescing") {
				return { status: "stopped", summary: "Pull-Refinery coalesced before sharding." };
			}
			os.bus.emit(os.runId, "phase.changed", { to: "shard", reason: "Building leased task DAG" });
			const planner = await os.spawnWorker({
				role: "planner",
				readOnly: true,
				canSpawn: false,
				requireOutputSchema: true,
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

			// 2. Serialized Refinery merge queue delegating to shared OS IntegrationPipeline
			const integration = os.integration ?? new IntegrationPipeline(os);
			let mergeChain: Promise<void> = Promise.resolve();

			const enqueueRefinery = (task: TaskRecord, branch: string, authorAgentId: string, authorDriverId: string) => {
				const job = mergeChain.then(async () => {
					await integration.integrateBranch({
						branch,
						label: task.title,
						task,
						authorAgentId,
						authorDriverId,
						goal,
						totalExpectedBranches: tasks.length,
						enableConflictResolution: true,
						enableSemanticRepair,
						actorName: "refinery",
						cachePrefix: `${os.runId}:refinery`,
						signal,
						closeoutSignal: closeoutSignal ?? os.closeoutSignal,
					});
				});
				mergeChain = job.catch(() => {});
				return job;
			};

			// 3. Pull-queue worker slots
			os.bus.emit(os.runId, "phase.changed", { from: "shard", to: "pull-execute", reason: `Starting ${concurrency} pull-queue worker slots` });
			const avoidDriversByTask = new Map<string, string[]>();
			const runSlot = async (slotIdx: number): Promise<void> => {
				while (!signal.aborted && !os.isInCloseoutReserve()) {
					const gate = await os.waitIfPaused?.(signal);
					if (gate === "coalescing" || gate === "aborted") break;
					const ready = os.readyTasks();
					if (!ready.length) {
						const remaining = os.store.list("tasks", { runId: os.runId }).some((t) => t.status === "open" || t.status === "claimed");
						if (!remaining) break;
						// Wait reactively for any task.ready or task.status event instead of polling.
						await waitForTaskEvent(os, signal, 5_000);
						continue;
					}
					// Claim the atomic SQLite lease BEFORE spawning a worker so losing slots never spawn idle CLIs/worktrees.
					type LeasedTicketSlot =
						| { readonly state: "unclaimed" }
						| {
							readonly state: "leased";
							readonly task: TaskRecord;
							readonly owner: string;
							readonly fencingToken: number;
							readonly expiresAt: number;
						};
					let lease: LeasedTicketSlot = { state: "unclaimed" };
					for (const candidate of ready) {
						const holderId = `slot-${slotIdx}-${newId("lse")}`;
						const attempt = os.store.claimTaskLease(os.runId, candidate.id, holderId, leaseTtlMs);
						if (attempt.claimed) {
							lease = {
								state: "leased",
								task: attempt.task,
								owner: holderId,
								fencingToken: attempt.task.fencingToken,
								expiresAt: attempt.task.leaseExpiresAt,
							};
							break;
						}
					}
					if (lease.state === "unclaimed") {
						await waitForTaskEvent(os, signal, 2_000);
						continue;
					}

					const target = lease.task;
					const claimedLeaseOwner = lease.owner;
					const claimedFencingToken = lease.fencingToken;
					const claimedExpiresAt = lease.expiresAt;
					const branchBaseRef = integration.bestGreenSha;
					const avoidedDrivers = avoidDriversByTask.get(target.id);
					let worker;
					try {
						worker = await os.spawnWorker({
							role: "worker",
							taskId: target.id,
							baseRef: branchBaseRef,
							canSpawn: false,
							...(avoidedDrivers?.length ? { avoidDrivers: avoidedDrivers } : {}),
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
						const remWall = os.remainingWallMs?.();
						const priorRetries = avoidDriversByTask.get(target.id)?.length ?? 0;
						const attemptTimeoutMs =
							priorRetries === 0 && remWall !== undefined && remWall > 40_000
								? Math.max(45_000, Math.min(125_000, Math.floor(remWall * 0.6)))
								: undefined;
						const res = await worker.runTurn(
							`Worker slot #${slotIdx + 1} — Ticket ${target.id}: ${target.title}\n\n${target.description}${ownershipBlock}${criteriaBlock}\n\nGlobal goal: ${goal}`,
							{ signal, ...(attemptTimeoutMs ? { timeoutMs: attemptTimeoutMs } : {}) },
						);
						const wip = res.workspaceSnapshot?.wipSha ?? os.worktrees.commitWip(worker.workspace, `ticket(${target.id}): ${target.title}`);
						const headAfter = res.workspaceSnapshot?.headSha ?? os.worktrees.headSha(worker.workspace);
						const hasChanges = Boolean(res.workspaceSnapshot?.hasEdits) || Boolean(wip) || (Boolean(headAfter) && headAfter !== branchBaseRef);

						// Cross-provider zero-diff straggler handoff: if a worker timed out on its first attempt
						// with ZERO edits while wall budget remains, re-open the ticket avoiding that provider so
						// an idle slot on another provider can finish it cleanly!
						if (
							res.status === "interrupted" &&
							!hasChanges &&
							priorRetries === 0 &&
							!signal.aborted &&
							!os.isInCloseoutReserve()
						) {
							const nextAvoid = [...(avoidDriversByTask.get(target.id) ?? []), worker.agent.driverId];
							avoidDriversByTask.set(target.id, nextAvoid);
							os.store.releaseTaskLease(target.id, claimedLeaseOwner, claimedFencingToken, "open", {
								result: `Straggler timeout with 0 edits on ${worker.agent.driverId}; re-queued for cross-provider handoff.`,
							});
							os.bus.emit(os.runId, "task.ready", { taskId: target.id, title: target.title, reason: "straggler-handoff", avoidedDriver: worker.agent.driverId }, worker.agent.id);
							continue;
						}

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
				summary: `Pull-Refinery completed ${doneCount}/${tasks.length} tickets; merged ${integration.mergedBranches.length} branches onto trunk (${integration.bestGreenSha.slice(0, 8)}).`,
			};
		},
	};
}

function waitForTaskEvent(os: SwarmOsApi, signal: AbortSignal, maxWaitMs: number): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	type WaiterState =
		| { readonly phase: "waiting"; readonly timer: ReturnType<typeof setTimeout>; readonly unsub: () => void }
		| { readonly phase: "settled" };
	return new Promise((resolve) => {
		let state: WaiterState | undefined;
		function settle() {
			if (!state || state.phase === "settled") return;
			const prev = state;
			state = { phase: "settled" };
			clearTimeout(prev.timer);
			prev.unsub();
			signal.removeEventListener("abort", settle);
			resolve();
		}
		const timer = setTimeout(settle, maxWaitMs);
		timer.unref?.();
		const unsub = os.bus.on((ev) => {
			if (ev.runId === os.runId && (ev.type === "task.ready" || ev.type === "task.status")) settle();
		});
		state = { phase: "waiting", timer, unsub };
		signal.addEventListener("abort", settle, { once: true });
	});
}
