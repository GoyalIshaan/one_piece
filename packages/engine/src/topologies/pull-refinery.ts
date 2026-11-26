import type { JsonSchema, SwarmOsApi, TaskRecord, TopologyOutcome, TopologyPlugin } from "@one-piece/core";

export interface PullRefineryOptions {
	concurrency?: number;
	leaseTtlMs?: number;
}

const BACKLOG_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		tasks: {
			type: "array",
			items: {
				type: "object",
				properties: {
					key: { type: "string" },
					title: { type: "string" },
					description: { type: "string" },
					depends_on: { type: "array", items: { type: "string" } },
				},
				required: ["key", "title", "description"],
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
}

function parseBacklog(text: string, fallbackGoal: string): BacklogItem[] {
	const match = /\{[\s\S]*\}/.exec(text);
	if (match) {
		try {
			const parsed = JSON.parse(match[0]) as { tasks?: BacklogItem[] };
			if (Array.isArray(parsed.tasks) && parsed.tasks.length) {
				return parsed.tasks
					.filter((t) => typeof t?.title === "string" && typeof t?.description === "string")
					.map((t, i) => ({
						key: typeof t.key === "string" && t.key ? t.key : `t${i + 1}`,
						title: t.title,
						description: t.description,
						depends_on: Array.isArray(t.depends_on) ? t.depends_on.filter((d): d is string => typeof d === "string") : [],
					}));
			}
		} catch {
			// Fall back below.
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
				systemPrompt: [
					"You are a backlog sharder. Split the goal into atomic, cleanly mergeable tickets with optional depends_on keys.",
					'Respond ONLY with JSON: {"tasks":[{"key":"t1","title":"...","description":"...","depends_on":[]}]}',
				].join("\n"),
			});
			let items: BacklogItem[];
			try {
				const res = await planner.runTurn(
					`Goal: ${goal}\n${rubric ? `Rubric: ${rubric}\n` : ""}Produce 2 to 6 atomic tasks with clean module boundaries.`,
					{ signal, outputSchema: BACKLOG_SCHEMA },
				);
				items = parseBacklog(res.finalText, goal);
			} finally {
				await planner.close();
			}

			const keyToTaskId = new Map<string, string>();
			const tasks: TaskRecord[] = [];
			for (const item of items) {
				const deps = (item.depends_on ?? []).map((k) => keyToTaskId.get(k)).filter((id): id is string => Boolean(id));
				const created = os.createTask({ title: item.title, description: item.description, dependsOn: deps, createdBy: "planner" });
				keyToTaskId.set(item.key, created.id);
				tasks.push(created);
			}

			// 2. Serialized Refinery merge queue (single-threaded trunk writer)
			let mergeChain: Promise<void> = Promise.resolve();
			const mergedBranches: string[] = [];
			let lastTrunkSha = os.worktrees.baseSha;

			const enqueueRefinery = (task: TaskRecord, branch: string, authorAgentId: string, authorDriverId: string) => {
				const job = mergeChain.then(async () => {
					const merged = os.worktrees.mergeIntoTrunk(branch, { message: `refinery(${task.id}): ${task.title}` });
					if (merged.ok && merged.commitSha) {
						lastTrunkSha = merged.commitSha;
						mergedBranches.push(branch);
						await os.trust.submitFinding(
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
						os.board.publish({
							runId: os.runId,
							authorAgentId: "refinery",
							topic: "refinery",
							summary: `Merged ${task.id} (${branch}) -> trunk ${merged.commitSha.slice(0, 8)}`,
						});
					} else {
						os.board.publish({
							runId: os.runId,
							authorAgentId: "refinery",
							topic: "refinery-conflict",
							summary: `Merge conflict on ${task.id} (${branch}): ${merged.error ?? "unknown"}`,
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
					const target = ready[0]!;
					const worker = await os.spawnWorker({
						role: "worker",
						taskId: target.id,
						baseRef: lastTrunkSha,
						canSpawn: false,
						systemPrompt: [
							`You are pull-queue worker #${slotIdx + 1} in an isolated git worktree branched from trunk.`,
							"Implement ONLY your leased ticket, run local tests, and exit cleanly so the Refinery can merge your branch.",
						].join("\n"),
					});
					const claim = os.store.claimTaskLease(os.runId, target.id, worker.agent.id, leaseTtlMs);
					if (!claim.claimed || !claim.task) {
						await worker.close();
						continue;
					}
					os.bus.emit(
						os.runId,
						"task.claimed",
						{ taskId: claim.task.id, agentId: worker.agent.id, fencingToken: claim.task.fencingToken, leaseExpiresAt: claim.task.leaseExpiresAt! },
						worker.agent.id,
					);
					try {
						const res = await worker.runTurn(
							`Ticket ${target.id}: ${target.title}\n\n${target.description}\n\nGlobal goal: ${goal}`,
							{ signal },
						);
						const wip = os.worktrees.commitWip(worker.workspace, `ticket(${target.id}): ${target.title}`);
						const status = res.status === "completed" ? "done" : "blocked";
						os.store.releaseTaskLease(target.id, worker.agent.id, claim.task.fencingToken, status, {
							result: res.finalText.slice(0, 800),
						});
						os.bus.emit(os.runId, "task.status", { taskId: target.id, status, result: res.finalText.slice(0, 400) }, worker.agent.id);
						if (status === "done" && wip && worker.branch) {
							await enqueueRefinery(target, worker.branch, worker.agent.id, worker.agent.driverId);
						}
					} finally {
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
