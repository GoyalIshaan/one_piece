import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store, WorktreeManager } from "@one-piece/core";

export interface HandoffInput {
	runId: string;
	agentId: string;
	fromDriver: string;
	reason: string;
	originalPrompt: string;
	workspace: string;
	worktrees: WorktreeManager;
	store: Store;
}

/**
 * Mechanically synthesizes `.swarm/HANDOFF.md` when a CLI subscription hits a Class 2/3 quota cap.
 * Never relies on the rate-limited worker to summarize its own state (it has zero tokens left!).
 */
export function synthesizeHandoffFile(input: HandoffInput): { handoffPath: string; wipCommit?: string; prompt: string } {
	const wipCommit = input.worktrees.commitWip(
		input.workspace,
		`chore(one-piece): wip handoff from ${input.fromDriver} (${input.agentId})`,
	);
	const diffStat = input.worktrees.diffStat(input.workspace);
	const recentEvents = input.store
		.events(input.runId, { nodeId: input.agentId })
		.slice(-10)
		.map((ev) => `- [seq ${ev.seq}] ${ev.type}: ${JSON.stringify(ev.data).slice(0, 220)}`);

	const swarmDir = join(input.workspace, ".swarm");
	mkdirSync(swarmDir, { recursive: true });
	const handoffPath = join(swarmDir, "HANDOFF.md");

	const markdown = [
		`# Automatic Quota Failover Handoff`,
		``,
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
		``,
		`## Last Recorded Swarm Events`,
		recentEvents.length ? recentEvents.join("\n") : "(none)",
		``,
		`## Instructions`,
		`Continue directly from the current state of this worktree. Inspect \`git diff ${input.worktrees.baseSha}...HEAD\` and finish the remaining work cleanly.`,
		``,
	].join("\n");

	writeFileSync(handoffPath, markdown, "utf8");
	const prompt = `Previous worker (${input.fromDriver}) hit a provider quota limit and handed off this exact worktree. Read .swarm/HANDOFF.md and run \`git diff ${input.worktrees.baseSha}...HEAD\`, then complete the remaining work without redoing finished edits.`;
	return { handoffPath, wipCommit, prompt };
}
