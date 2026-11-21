import { arr, lit, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import {
	type BudgetVector,
	defineTool,
	type Epoch,
	type EpochMode,
	type EpochTrigger,
	type Finding,
	type HarnessEvent,
	newId,
	type Recommendation,
	type ReviewerAction,
	type SwarmNode,
	TERMINAL_STATUSES,
} from "@one-piece/core";
import type { Harness } from "./harness.ts";
import { briefFor } from "./prompts.ts";
import { childSummary } from "./tree-tools.ts";

const ACTIONS: ReviewerAction[] = ["continue", "redirect", "reallocate", "cut", "merge", "promote", "revamp", "raise_caps"];

interface EpochDecision {
	start: boolean;
	trigger?: EpochTrigger;
	mode?: EpochMode;
	carry?: string[];
	handoff?: string;
	reason: string;
}

const epochDecisions = new Map<string, EpochDecision>();

function recentActivity(harness: Harness, nodeId: string, count: number): string {
	const messages = harness.store
		.events(harness.run().id, { nodeId, types: ["agent.message"] })
		.slice(-count)
		.map((e) => `- ${String(e.data.text || `(tools: ${(e.data.toolCalls as string[] | undefined)?.join(", ")})`).slice(0, 400)}`);
	return messages.join("\n") || "(no messages yet)";
}

function findingsOf(harness: Harness, nodeIds: Set<string>): Finding[] {
	return harness.store.list<Finding>("findings", { runId: harness.run().id }).filter((f) => nodeIds.has(f.nodeId));
}

function dossier(harness: Harness, target: SwarmNode, reason: string): string {
	const spent = harness.tree.subtreeSpent(target.id);
	const findings = findingsOf(harness, new Set([target.id]));
	const contract = target.contract
		? `success: ${target.contract.success.join("; ")}\nkill: ${target.contract.kill.join("; ")}\nfirst check: ${target.contract.firstCheck}\naims for: ${target.contract.evidenceLevel}`
		: "(no contract)";
	return [
		`Reason for this review: ${reason}`,
		`Agent ${target.id} (${target.role}), status ${target.status}, turns ${target.turns}`,
		`Goal from its parent: ${target.goal.title}\n${target.goal.text}`,
		target.goal.rubric ? `Parent's rubric: ${target.goal.rubric}` : "",
		target.goal.targets?.length ? `Targets: ${target.goal.targets.join("; ")}` : "",
		`Its contract:\n${contract}`,
		`Spend: ${JSON.stringify(spent)} of budget ${JSON.stringify(target.budget)}`,
		`Checkpoint:\n${target.checkpoint ?? "(none)"}`,
		`Findings:\n${findings.map((f) => `- ${f.id} [${f.status}] (${f.level}) ${f.claim}`).join("\n") || "(none)"}`,
		target.children.length ? `Children:\n${harness.tree.children(target.id).map((c) => childSummary(harness, c)).join("\n")}` : "",
		`Recent messages:\n${recentActivity(harness, target.id, 6)}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

export function runFraction(harness: Harness): number {
	const run = harness.run();
	const spent = harness.runSpent();
	let max = 0;
	for (const [k, total] of Object.entries(run.budget)) if (total > 0) max = Math.max(max, (spent[k] ?? 0) / total);
	return max;
}

/** Hidden reviewers, the root reviewer and epoch transitions. */
export function installOversight(harness: Harness): void {
	const state = { checkpointsDone: new Set<number>(), reviewsSinceAccepted: 0, consulting: false };
	const { tree } = harness;

	const scheduleReview = (nodeId: string | undefined, reason: string) => {
		if (!nodeId) return;
		const node = tree.get(nodeId);
		if (!node || !["internal", "leaf"].includes(node.role) || TERMINAL_STATUSES.includes(node.status)) return;
		const run = harness.run();
		if (run.status !== "running" || tree.require(run.rootNodeId).wrapUp) return;
		if (tree.all().some((reviewer) => reviewer.role === "claims_reviewer" && reviewer.targetNodeId === nodeId && !tree.isTerminal(reviewer.id))) return;
		const live = harness.liveState(nodeId);
		if (live.reviewing) return;
		// Space reviews out: one review every few turns per node, so oversight stays cheaper than the work.
		if (node.turns - live.lastReviewTurn < harness.config.reviewCooldownTurns) return;
		live.reviewing = true;
		live.lastReviewTurn = node.turns;
		void runHiddenReview(node, reason)
			.catch((error) => harness.bus.emit(node.runId, "review.error", { error: String(error) }, nodeId))
			.finally(() => {
				live.reviewing = false;
				state.reviewsSinceAccepted += 1;
				if (state.reviewsSinceAccepted >= harness.config.saturationWindow) {
					state.reviewsSinceAccepted = 0;
					void consultRootReviewer("A_saturation");
				}
			});
	};

	const runHiddenReview = async (target: SwarmNode, reason: string) => {
		const reviewer = tree.create({
			runId: target.runId,
			epoch: target.epoch,
			role: "hidden_reviewer",
			parentId: target.id,
			goal: { title: `Hidden review of ${target.id}`, text: dossier(harness, target, reason) },
			budget: {},
			modules: { ...target.modules, questions: "off", board: "off", scheduler: "off" },
		});
		tree.update(reviewer.id, { targetNodeId: target.id });
		harness.bus.emit(target.runId, "review.started", { reviewer: reviewer.id, reason }, target.id);
		await harness.runNode(reviewer, `${reviewer.goal.text}\n\nCall recommend once.`);
	};

	const epochHasBudget = (trigger: EpochTrigger): boolean => {
		const run = harness.run();
		if (tree.isTerminal(run.rootNodeId)) return false;
		if (!tree.require(run.rootNodeId).wrapUp && 1 - runFraction(harness) >= harness.config.epochMinRemaining) return true;
		harness.bus.emit(run.id, "epoch.skipped", { trigger, reason: "too little run budget left for a new epoch" }, run.rootNodeId);
		return false;
	};

	const consultRootReviewer = async (trigger: EpochTrigger) => {
		const run = harness.run();
		if (state.consulting || run.status !== "running") return;
		if (!epochHasBudget(trigger)) return;
		state.consulting = true;
		try {
			const root = tree.require(run.rootNodeId);
			const subtree = new Set(tree.subtree(root.id).map((n) => n.id));
			const findings = findingsOf(harness, subtree);
			const text = [
				`Trigger: ${trigger}. Epoch ${run.epoch}. Run budget used: ${(runFraction(harness) * 100).toFixed(1)}%.`,
				`Run goal: ${run.goal.title}\n${run.goal.text}`,
				`Root checkpoint:\n${root.checkpoint ?? "(none)"}`,
				`Tree (root's children):\n${tree.children(root.id).map((c) => childSummary(harness, c)).join("\n") || "(none)"}`,
				`Accepted findings:\n${findings.filter((f) => f.status === "accepted").map((f) => `- ${f.id} from ${f.nodeId}: ${f.claim} (${f.level})`).join("\n") || "(none)"}`,
				`Rejected or unresolved findings: ${findings.filter((f) => f.status !== "accepted").length}`,
				`Recent root messages:\n${recentActivity(harness, root.id, 4)}`,
			].join("\n\n");
			const reviewer = tree.create({
				runId: run.id,
				epoch: run.epoch,
				role: "root_reviewer",
				parentId: root.id,
				goal: { title: `Epoch review (${trigger})`, text },
				budget: {},
				modules: {},
			});
			tree.update(reviewer.id, { targetNodeId: root.id });
			harness.bus.emit(run.id, "epoch.consulted", { trigger, reviewer: reviewer.id }, root.id);
			await harness.runNode(reviewer, `${text}\n\nCall decide_epoch once.`);
			const decision = epochDecisions.get(reviewer.id);
			epochDecisions.delete(reviewer.id);
			const decidedTrigger = decision?.trigger ?? trigger;
			// Workers keep spending while the root reviewer is deciding.
			if (decision?.start && harness.run().status === "running" && epochHasBudget(decidedTrigger)) startEpoch(decision, decidedTrigger);
		} finally {
			state.consulting = false;
		}
	};

	const startEpoch = (decision: EpochDecision, trigger: EpochTrigger) => {
		const run = harness.run();
		const oldRoot = tree.require(run.rootNodeId);
		const mode: EpochMode = decision.mode ?? (trigger === "A_saturation" ? "mix" : trigger === "B_reframe" ? "fresh" : "carry");
		const inTree = new Set(tree.subtree(oldRoot.id).map((n) => n.id));
		const carry = mode === "fresh" ? [] : (decision.carry ?? []).filter((id) => id !== oldRoot.id && inTree.has(id) && !tree.isTerminal(id));
		const spent = harness.runSpent();
		const remaining: BudgetVector = {};
		for (const [k, v] of Object.entries(run.budget)) remaining[k] = Math.max(0, v - (spent[k] ?? 0));
		const number = run.epoch + 1;
		const handoff = decision.handoff ?? "(no handoff written)";
		const newRoot = tree.create({
			runId: run.id,
			epoch: number,
			role: "root",
			goal: run.goal,
			budget: remaining,
			modules: oldRoot.modules,
			caps: oldRoot.caps,
		});
		for (const id of carry) {
			tree.reparent(id, newRoot.id);
			const carried = tree.require(id);
			const used = tree.subtreeSpent(id);
			for (const [k, v] of Object.entries(carried.budget)) {
				newRoot.allocatedToChildren[k] = (newRoot.allocatedToChildren[k] ?? 0) + Math.max(0, v - (used[k] ?? 0));
			}
		}
		tree.update(newRoot.id, { allocatedToChildren: newRoot.allocatedToChildren });
		harness.stopSubtree(oldRoot.id, "archived", `epoch ${number} started (${trigger}, ${mode})`);
		for (const epoch of harness.store.list<Epoch>("epochs", { runId: run.id })) {
			if (epoch.number === run.epoch && !epoch.endedAt) harness.bus.save("epochs", { ...epoch, endedAt: Date.now() });
		}
		harness.bus.save("epochs", { id: newId("epoch"), runId: run.id, number, rootNodeId: newRoot.id, trigger, mode, handoff, carried: carry, startedAt: Date.now() });
		harness.bus.save("reports", { id: newId("report"), runId: run.id, epoch: run.epoch, kind: "handoff", title: `Handoff to epoch ${number}`, markdown: handoff, createdAt: Date.now() });
		harness.saveRun({ rootNodeId: newRoot.id, epoch: number });
		harness.bus.emit(run.id, "epoch.started", { number, trigger, mode, carried: carry, reason: decision.reason }, newRoot.id);
		const carriedText = carry.length ? `\n\n## Branches carried over (now your children)\n${carry.map((id) => childSummary(harness, tree.require(id))).join("\n")}` : "";
		harness.launch(newRoot, briefFor(newRoot, `## State of knowledge from epoch ${number - 1}\n${handoff}${carriedText}`));
	};

	// --- triggers ---------------------------------------------------------------------------
	harness.onCall((caller) => {
		if (harness.run().status !== "running") return;
		const payerId = ["root", "internal", "leaf"].includes(caller.role) ? caller.id : caller.targetNodeId;
		if (!payerId || !tree.get(payerId)) return;
		for (const node of [tree.require(payerId), ...tree.ancestors(payerId)]) {
			if (node.role === "root") continue;
			const live = harness.liveState(node.id);
			const fraction = tree.fractionSpent(node.id);
			// Mark every threshold already crossed at once, so a fast spender gets one review, not three in a row.
			const crossed = harness.config.reviewFractions.filter((t) => fraction >= t && !live.reviewedFractions.has(t));
			if (crossed.length) {
				for (const t of crossed) live.reviewedFractions.add(t);
				scheduleReview(node.id, `spent ${Math.round(Math.max(...crossed) * 100)}% of its budget`);
			}
		}
		const fraction = runFraction(harness);
		const crossedRun = harness.config.epochCheckpoints.filter((t) => fraction >= t && !state.checkpointsDone.has(t));
		if (crossedRun.length) {
			for (const t of crossedRun) state.checkpointsDone.add(t);
			void consultRootReviewer("C_checkpoint");
		}
	});

	harness.onTurn((node) => {
		const live = harness.liveState(node.id);
		if (node.role === "leaf" && node.turns - live.lastCheckpointTurn >= harness.config.stallTurns) {
			live.lastCheckpointTurn = node.turns;
			scheduleReview(node.id, `no new checkpoint for ${harness.config.stallTurns} turns (possible stall)`);
		}
	});

	harness.bus.on((event: HarnessEvent) => {
		if (event.type === "finding.verdict") {
			if (event.data.verdict === "accepted") state.reviewsSinceAccepted = 0;
			scheduleReview(event.nodeId, `claims review returned ${String(event.data.verdict)}`);
		}
		if (event.type === "tree.spawned" && Number(event.data.call) > 1) scheduleReview(event.nodeId, "it asked to spawn more children");
	});

	// --- reviewer tools ---------------------------------------------------------------------
	harness.addTools((h, node) => {
		if (node.role === "hidden_reviewer") {
			return [
				defineTool({
					name: "recommend",
					description: "Your one recommendation for the reviewed agent. The parent decides what to do with it.",
					parameters: obj({
						action: union(ACTIONS.map((a) => lit(a)) as any),
						grade: num({ minimum: 0, maximum: 1 }),
						promise: num({ minimum: 0, maximum: 1 }),
						reason: str(),
						details: opt(str()),
					}),
					async execute(params) {
						const target = tree.require(node.targetNodeId!);
						const rec: Recommendation = {
							id: newId("rec"),
							runId: node.runId,
							reviewerNodeId: node.id,
							targetNodeId: target.id,
							deciderNodeId: target.parentId ?? target.id,
							action: params.action as ReviewerAction,
							reason: params.reason,
							grade: params.grade,
							promise: params.promise,
							details: params.details,
							status: params.action === "continue" ? "applied" : "open",
							createdAt: Date.now(),
						};
						h.bus.save("recommendations", rec, target.id);
						tree.update(target.id, { grade: params.grade, promise: params.promise });
						if (params.action !== "continue" && target.parentId) {
							h.deliver(
								target.parentId,
								`[reviewer recommendation ${rec.id} about child ${target.id} "${target.goal.title}"]\naction: ${rec.action}; grade ${rec.grade.toFixed(2)}, promise ${rec.promise.toFixed(2)}\n${rec.reason}${rec.details ? `\n${rec.details}` : ""}\nYou decide. Act, then call resolve_recommendation.`,
							);
						}
						node.finishedSummary = `recommended ${params.action}`;
						return "Recommendation recorded.";
					},
				}),
			];
		}
		if (node.role === "root_reviewer") {
			return [
				defineTool({
					name: "decide_epoch",
					description: "Decide whether to start a new root epoch. If start is true, give mode, the node ids to carry, and a full handoff.",
					parameters: obj({
						start: union([lit(true), lit(false)]),
						trigger: opt(union([lit("A_saturation"), lit("B_reframe"), lit("C_checkpoint")])),
						mode: opt(union([lit("fresh"), lit("carry"), lit("mix")])),
						carry: opt(arr(str())),
						handoff: opt(str()),
						reason: str(),
					}),
					async execute(params) {
						epochDecisions.set(node.id, params as EpochDecision);
						h.bus.emit(node.runId, "epoch.decision", { ...params, handoff: params.handoff?.slice(0, 500) }, node.targetNodeId);
						node.finishedSummary = params.start ? "new epoch" : "keep epoch";
						return "Decision recorded.";
					},
				}),
			];
		}
		return [];
	});
}
