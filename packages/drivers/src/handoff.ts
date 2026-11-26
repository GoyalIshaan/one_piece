import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store, WorktreeManager } from "@one-piece/core";

export interface HandoffInput {
	runId: string;
	agentId: string;
	fromDriver: string;
	reason: string;
	reasonKind?: "quota_failover" | "compaction_limit" | "phase_transition";
	originalPrompt: string;
	workspace: string;
	worktrees: WorktreeManager;
	store: Store;
	failedApproaches?: string[];
	verifiedFacts?: string[];
	lastTestSummary?: string;
}

/**
 * Mechanically synthesizes `.swarm/HANDOFF.md` for Tier 2 Clean-Slate Handoffs:
 * - Quota failover (Class 2/3 cap hit — never relies on the rate-limited worker to summarize)
 * - Compaction rollover (2nd compaction threshold — resets muddled context cleanly from disk truth)
 * - Phase transitions (exploration -> implementation -> verification)
 */
export function synthesizeHandoffFile(input: HandoffInput): { handoffPath: string; wipCommit?: string; prompt: string } {
	const kind = input.reasonKind ?? "quota_failover";
	const wipCommit = input.worktrees.commitWip(
		input.workspace,
		`chore(one-piece): wip ${kind} from ${input.fromDriver} (${input.agentId})`,
	);
	const diffStat = input.worktrees.diffStat(input.workspace);
	const recentEvents = input.store
		.events(input.runId, { nodeId: input.agentId })
		.slice(-10)
		.map((ev) => `- [seq ${ev.seq}] ${ev.type}: ${JSON.stringify(ev.data).slice(0, 220)}`);

	const swarmDir = join(input.workspace, ".swarm");
	mkdirSync(swarmDir, { recursive: true });
	const handoffPath = join(swarmDir, "HANDOFF.md");

	const heading = kind === "compaction_limit"
		? "# Clean-Slate Context Rollover Handoff"
		: kind === "phase_transition"
			? "# Phase Transition Handoff"
			: "# Automatic Quota Failover Handoff";

	const markdown = [
		heading,
		``,
		`- **Handoff type:** \`${kind}\``,
		`- **Previous driver:** \`${input.fromDriver}\``,
		`- **Reason:** ${input.reason.slice(0, 240)}`,
		`- **WIP commit:** ${wipCommit ?? "(clean working tree)"}`,
		``,
		`## Original Assignment`,
		input.originalPrompt,
		``,
		`## Changes Made So Far (\`git diff --stat\`)`,
		"```",
		diffStat,
		"```",
		...(input.verifiedFacts?.length
			? [``, `## Verified Facts`, ...input.verifiedFacts.map((f) => `- ${f}`)]
			: []),
		...(input.failedApproaches?.length
			? [``, `## Failed Approaches (DO NOT REPEAT)`, ...input.failedApproaches.map((f) => `- ${f}`)]
			: []),
		...(input.lastTestSummary
			? [``, `## Last Verification / Test Output`, "```", input.lastTestSummary.slice(0, 1200), "```"]
			: []),
		``,
		`## Last Recorded Swarm Events`,
		recentEvents.length ? recentEvents.join("\n") : "(none)",
		``,
		`## Instructions`,
		`Continue directly from the current state of this worktree. Inspect \`git diff ${input.worktrees.baseSha}...HEAD\` and finish the remaining work cleanly without repeating failed approaches.`,
		``,
	].join("\n");

	writeFileSync(handoffPath, markdown, "utf8");
	const reasonPhrase = kind === "compaction_limit"
		? `Previous session reached its context compaction limit and handed off this exact worktree cleanly.`
		: kind === "phase_transition"
			? `Previous phase completed and handed off this exact worktree.`
			: `Previous worker (${input.fromDriver}) hit a provider quota limit and handed off this exact worktree.`;
	const prompt = `${reasonPhrase} Read .swarm/HANDOFF.md and run \`git diff ${input.worktrees.baseSha}...HEAD\`, then complete the remaining work without redoing finished edits or repeating failed approaches.`;
	return { handoffPath, wipCommit, prompt };
}
