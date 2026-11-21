import { arr, lit, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { defineTool, EVIDENCE_LEVELS, type EvidenceLevel, type Finding, type Recommendation, type SwarmNode, TERMINAL_STATUSES } from "@one-piece/core";
import type { Harness } from "./harness.ts";
import { briefFor } from "./prompts.ts";

const evidenceLevel = union(EVIDENCE_LEVELS.map((l) => lit(l)) as any);

export function childSummary(harness: Harness, child: SwarmNode): string {
	const spent = harness.tree.subtreeSpent(child.id);
	const findings = harness.store.list<Finding>("findings", { runId: child.runId }).filter((f) => f.nodeId === child.id);
	const accepted = findings.filter((f) => f.status === "accepted").length;
	return [
		`- ${child.id} [${child.role}] "${child.goal.title}": ${child.status}${child.statusReason ? ` (${child.statusReason})` : ""}`,
		`  grade ${child.grade?.toFixed(2) ?? "n/a"}, promise ${child.promise.toFixed(2)}, tokens ${spent.tokens ?? 0}/${child.budget.tokens ?? "inf"}, accepted findings ${accepted}/${findings.length}`,
		child.activity ? `  now: ${child.activity}` : "",
		child.checkpoint ? `  checkpoint: ${child.checkpoint.split("\n").slice(0, 3).join(" | ").slice(0, 300)}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function acceptedFindingsText(harness: Harness, nodeIds: Set<string>): string {
	const accepted = harness.store
		.list<Finding>("findings", { runId: harness.run().id })
		.filter((f) => f.status === "accepted" && nodeIds.has(f.nodeId));
	if (!accepted.length) return "No accepted findings yet.";
	return accepted
		.map((f) => `- ${f.id} (${f.level}, confidence ${f.confidence ?? "n/a"}) from ${f.nodeId}: ${f.claim}\n  evidence: ${f.evidence.join(", ")}`)
		.join("\n");
}

/** Tools for root and internal nodes: grow, steer and prune the tree. */
export function managerTools(harness: Harness, node: SwarmNode) {
	if (node.role !== "root" && node.role !== "internal") return [];
	const { tree } = harness;
	const ensureChild = (id: string) => {
		const child = tree.get(id);
		if (!child || child.parentId !== node.id) throw new Error(`${id} is not one of your children`);
		return child;
	};

	return [
		defineTool({
			name: "spawn_children",
			description:
				"Spawn child agents, one per angle. kind 'explore' splits the angle further; 'work' is a leaf that does the work. " +
				"budget_share is the fraction of your currently available budget given to that child (shares should sum to at most ~0.85 to keep a reserve).",
			parameters: obj({
				children: arr(
					obj({
						title: str({ description: "Short name of the angle" }),
						goal: str({ description: "What the child must achieve; it is graded against this" }),
						rubric: opt(str({ description: "What good looks like, which trade-offs matter" })),
						targets: opt(arr(str(), { description: "Concrete measurable targets" })),
						kind: union([lit("explore"), lit("work")]),
						budget_share: num({ minimum: 0.01, maximum: 1 }),
					}),
					{ minItems: 1 },
				),
			}),
			async execute(params) {
				const check = tree.canSpawn(node.id, params.children.length);
				if (!check.ok) throw new Error(`${check.reason}. Ask your reviewer path to raise caps, or cut/merge children first.`);
				const live = harness.liveState(node.id);
				live.spawnCalls += 1;
				const budgets = params.children.map((c) => tree.carve(node.id, c.budget_share, 1));
				const created: string[] = [];
				params.children.forEach((spec, i) => {
					const atDepthCap = node.depth + 2 > node.caps.maxDepth;
					const child = tree.create({
						runId: node.runId,
						epoch: node.epoch,
						role: spec.kind === "explore" && !atDepthCap ? "internal" : "leaf",
						parentId: node.id,
						goal: { title: spec.title, text: spec.goal, rubric: spec.rubric, targets: spec.targets },
						budget: budgets[i],
					});
					harness.launch(child, briefFor(child));
					created.push(`${child.id} (${child.role}): ${spec.title}`);
				});
				harness.bus.emit(node.runId, "tree.spawned", { count: created.length, call: live.spawnCalls }, node.id);
				return `Spawned ${created.length} children:\n${created.join("\n")}\nCall wait_for_children to wait for their results.`;
			},
		}),
		defineTool({
			name: "wait_for_children",
			description:
				"Wait (costs nothing) until something needs you: an accepted finding, a question, a reviewer recommendation, or all children finishing. Returns what happened.",
			parameters: obj({}),
			async execute() {
				for (;;) {
					const inbox = harness.drainInbox(node.id);
					if (inbox.length) return inbox.join("\n\n");
					const children = tree.children(node.id);
					const open = children.filter((c) => !TERMINAL_STATUSES.includes(c.status));
					if (!open.length) {
						const ids = new Set(children.flatMap((c) => tree.subtree(c.id).map((n) => n.id)));
						return `ALL_SETTLED: none of your children are running.\n${children.map((c) => childSummary(harness, c)).join("\n")}\n\nAccepted findings in your subtree:\n${acceptedFindingsText(harness, ids)}`;
					}
					await harness.park(
						node.id,
						Promise.race([harness.inboxSignal(node.id), ...open.map((c) => harness.whenSettled(c.id)), sleep(10 * 60_000)]),
					);
				}
			},
		}),
		defineTool({
			name: "list_children",
			description: "Status, grade, promise, spend and latest checkpoint of each child.",
			parameters: obj({}),
			async execute() {
				const children = tree.children(node.id);
				return children.length ? children.map((c) => childSummary(harness, c)).join("\n") : "You have no children.";
			},
		}),
		defineTool({
			name: "read_findings",
			description: "Accepted findings from one child's subtree, or from all your children if child_id is omitted.",
			parameters: obj({ child_id: opt(str()) }),
			async execute(params) {
				const roots = params.child_id ? [ensureChild(params.child_id)] : tree.children(node.id);
				const ids = new Set(roots.flatMap((c) => tree.subtree(c.id).map((n) => n.id)));
				return acceptedFindingsText(harness, ids);
			},
		}),
		defineTool({
			name: "steer_child",
			description: "Send a redirect or guidance message to one child.",
			parameters: obj({ child_id: str(), message: str() }),
			async execute(params) {
				ensureChild(params.child_id);
				harness.deliver(params.child_id, `[message from your parent]\n${params.message}`);
				return "Delivered.";
			},
		}),
		defineTool({
			name: "cut_child",
			description: "Stop a child and its whole subtree. Its work is archived, never deleted. Unspent budget returns to you.",
			parameters: obj({ child_id: str(), reason: str() }),
			async execute(params) {
				ensureChild(params.child_id);
				harness.stopSubtree(params.child_id, "cut", params.reason);
				return `Cut ${params.child_id}.`;
			},
		}),
		defineTool({
			name: "merge_children",
			description:
				"Stop several similar children, combine their checkpoints and accepted findings, and spawn one successor in their place with their remaining budget.",
			parameters: obj({
				child_ids: arr(str(), { minItems: 2 }),
				title: str(),
				goal: str(),
				rubric: opt(str()),
				kind: union([lit("explore"), lit("work")]),
			}),
			async execute(params) {
				const merged = params.child_ids.map(ensureChild);
				const ids = new Set(merged.flatMap((c) => tree.subtree(c.id).map((n) => n.id)));
				const context = merged.map((c) => `### ${c.goal.title} (${c.id})\n${c.checkpoint ?? "(no checkpoint)"}`).join("\n\n");
				for (const child of merged) tree.reclaim(child.id, 1);
				for (const child of merged) harness.stopSubtree(child.id, "merged", "merged into successor");
				const budget = tree.carve(node.id, 1, 1);
				const share = Object.fromEntries(Object.entries(budget).map(([k, v]) => [k, Math.floor(v * 0.6)]));
				const successor = tree.create({
					runId: node.runId,
					epoch: node.epoch,
					role: params.kind === "explore" ? "internal" : "leaf",
					parentId: node.id,
					goal: { title: params.title, text: params.goal, rubric: params.rubric },
					budget: share,
				});
				for (const child of merged) tree.update(child.id, { mergedInto: successor.id });
				harness.launch(
					successor,
					briefFor(successor, `## You replace merged siblings\n${context}\n\n## Their accepted findings\n${acceptedFindingsText(harness, ids)}`),
				);
				return `Merged ${merged.length} children into ${successor.id}.`;
			},
		}),
		defineTool({
			name: "reallocate_budget",
			description: "Move a fraction of one child's unspent budget to another child.",
			parameters: obj({ from_child: str(), to_child: str(), fraction: num({ minimum: 0.01, maximum: 1 }) }),
			async execute(params) {
				ensureChild(params.from_child);
				ensureChild(params.to_child);
				const taken = tree.reclaim(params.from_child, params.fraction);
				tree.transfer(node.id, params.to_child, taken);
				return `Moved ${JSON.stringify(taken)} from ${params.from_child} to ${params.to_child}.`;
			},
		}),
		defineTool({
			name: "raise_child_caps",
			description: "Raise a child's soft caps (children per node, depth) when a reviewer recommends it.",
			parameters: obj({ child_id: str(), max_children: num({ minimum: 1, maximum: 32 }), max_depth: num({ minimum: 1, maximum: 12 }) }),
			async execute(params) {
				const child = ensureChild(params.child_id);
				tree.update(child.id, { caps: { maxChildren: Math.round(params.max_children), maxDepth: Math.round(params.max_depth) } });
				return "Caps updated.";
			},
		}),
		defineTool({
			name: "resolve_recommendation",
			description: "Record what you did with a reviewer recommendation: applied or dismissed, with a note.",
			parameters: obj({ recommendation_id: str(), outcome: union([lit("applied"), lit("dismissed")]), note: opt(str()) }),
			async execute(params) {
				const rec = harness.store.get<Recommendation>("recommendations", params.recommendation_id);
				if (!rec || rec.deciderNodeId !== node.id) throw new Error("Unknown recommendation");
				harness.bus.save("recommendations", { ...rec, status: params.outcome, details: params.note ?? rec.details });
				return "Recorded.";
			},
		}),
	];
}

/** Tools every tree node has: contract, checkpoint, finish, enable_module. */
export function commonTools(harness: Harness, node: SwarmNode) {
	if (!["root", "internal", "leaf"].includes(node.role)) return [];
	const tools = [
		defineTool({
			name: "write_checkpoint",
			description:
				"Replace your compact checkpoint: current track, what is verified vs hypothesis, failed approaches, next step, exact paths/commands. Others read it; keep it short.",
			parameters: obj({ checkpoint: str() }),
			async execute(params) {
				harness.tree.update(node.id, { checkpoint: params.checkpoint });
				harness.liveState(node.id).lastCheckpointTurn = node.turns;
				harness.bus.emit(node.runId, "node.checkpoint", { checkpoint: params.checkpoint }, node.id);
				return "Checkpoint saved.";
			},
		}),
		defineTool({
			name: "finish",
			description:
				"End your work. status: finished (goal handled), needs_input (blocked). Report findings before finishing. " +
				"Managers are refused while children are still working or findings are unresolved, unless they pass override_reason.",
			parameters: obj({ status: union([lit("finished"), lit("needs_input")]), summary: str(), override_reason: opt(str()) }),
			async execute(params) {
				if ((node.role === "root" || node.role === "internal") && !params.override_reason) {
					const subtree = harness.tree.subtree(node.id).filter((n) => n.id !== node.id && ["internal", "leaf"].includes(n.role));
					const live = subtree.filter((n) => !TERMINAL_STATUSES.includes(n.status));
					const ids = new Set(subtree.map((n) => n.id));
					const open = harness.store
						.list<Finding>("findings", { runId: node.runId })
						.filter((f) => ids.has(f.nodeId) && (f.status === "pending_review" || f.status === "needs_work"));
					if (live.length || open.length) {
						throw new Error(
							`Not finished yet: ${live.length} descendants still working${open.length ? ` and ${open.length} findings unresolved (${open.map((f) => f.id).join(", ")})` : ""}. ` +
								"Wait for them (wait_for_children), cut them, or call finish again with override_reason explaining why their results are not needed.",
						);
					}
				}
				harness.tree.update(node.id, { finishedSummary: `${params.status}: ${params.summary}` });
				node.finishedSummary = `${params.status}: ${params.summary}`;
				if (node.role === "root") harness.bus.emit(node.runId, "root.finished", { summary: params.summary }, node.id);
				return "Finished.";
			},
		}),
	];
	if (node.role === "leaf") {
		tools.push(
			defineTool({
				name: "set_contract",
				description: "Write (or revise) your contract: success criteria, kill criteria, first decisive check, evidence level you aim for.",
				parameters: obj({
					success: arr(str()),
					kill: arr(str()),
					first_check: str(),
					evidence_level: evidenceLevel,
				}),
				async execute(params) {
					const version = (node.contract?.version ?? 0) + 1;
					harness.tree.update(node.id, {
						contract: { success: params.success, kill: params.kill, firstCheck: params.first_check, evidenceLevel: params.evidence_level as EvidenceLevel, version },
					});
					harness.bus.emit(node.runId, "node.contract", { version }, node.id);
					return `Contract v${version} saved.`;
				},
			}),
		);
	}
	const deferred = harness.deferredModules(node);
	if (deferred.length) {
		tools.push(
			defineTool({
				name: "enable_module",
				description: `Load a deferred module's tools. Available: ${deferred.map((m) => `${m.manifest.name} (${m.manifest.summary})`).join("; ")}`,
				parameters: obj({ name: str() }),
				async execute(params) {
					const module = deferred.find((m) => m.manifest.name === params.name);
					if (!module) throw new Error(`No deferred module named ${params.name}`);
					harness.tree.update(node.id, { modules: { ...node.modules, [params.name]: "active" } });
					harness.refreshTools(node);
					harness.bus.emit(node.runId, "module.enabled", { module: params.name }, node.id);
					const section = module.prompt?.({ node, harness });
					return `Loaded ${params.name}: ${module.manifest.tools.join(", ")}.${section ? `\n${section}` : ""}`;
				},
			}),
		);
	}
	return tools;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
