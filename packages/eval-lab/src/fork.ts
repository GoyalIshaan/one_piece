import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalTask, HarnessAdapter, PreparedTask, RunBudget, Scorecard } from "./contracts.ts";
import { openEvalTraceDb, readRunEvents } from "./event-reader.ts";
import { extractScorecard } from "./scorecard.ts";

export type ForkBranch = "unchanged" | "placebo" | "treatment";

export interface CounterfactualForkOptions {
	sourceDbPath: string;
	sourceRunId: string;
	/** Replay events up to and including this sequence number before forking. */
	atSeq: number;
	task: EvalTask;
	prepared: PreparedTask;
	adapter: HarnessAdapter;
	totalBudget: RunBudget;
	swarmSize: number;
	topology?: string;
	/** Neutral message carrying zero task evidence (controls for extra test-time compute). */
	placeboPrompt?: string;
	/** Exact intervention payload under test (e.g., missing peer offset receipt). */
	treatmentPrompt: string;
	outDir: string;
	repoRoot: string;
}

export interface CounterfactualForkReport {
	sourceRunId: string;
	atSeq: number;
	spentBeforeForkTokens: number;
	remainingBudget: RunBudget;
	branches: Record<ForkBranch, Scorecard>;
	/** `treatment.deliveredScore - placebo.deliveredScore` (isolates information/mechanism value). */
	causalMechanismGain: number;
	/** `placebo.deliveredScore - unchanged.deliveredScore` (isolates extra-turn/compute effect). */
	placeboComputeGain: number;
	/** `treatment.deliveredScore - unchanged.deliveredScore` (total raw gain). */
	totalRecoveryGain: number;
	diagnosis: "MECHANISM_CAUSAL_WIN" | "PLACEBO_COMPUTE_EFFECT" | "NO_RECOVERY" | "REGRESSION";
}

function cloneTruncatedTrace(sourceDbPath: string, sourceRunId: string, atSeq: number, targetDbPath: string, newRunId: string): number {
	const { events } = readRunEvents(sourceDbPath, sourceRunId, atSeq);
	const db = openEvalTraceDb(targetDbPath);
	try {
		const insert = db.prepare(
			"INSERT INTO events (ts, run_id, type, node_id, causal_parents, idempotency_key, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		let spentTokens = 0;
		for (const ev of events) {
			if (ev.type === "run.finished") continue;
			if (ev.type === "model.call") spentTokens += Number(ev.data.totalTokens ?? 0);
			insert.run(
				ev.ts,
				newRunId,
				ev.type,
				ev.agentId ?? null,
				ev.causalParents ? JSON.stringify(ev.causalParents) : null,
				null,
				JSON.stringify(ev.data),
			);
		}
		return spentTokens;
	} finally {
		db.close();
	}
}

/**
 * Mid-trajectory 3-way counterfactual trace forking (`unchanged` vs. `placebo` vs. `treatment`).
 * Truncates a saved failed SQLite WAL trace at `atSeq`, clones the workspace and remaining
 * budget across 3 branches, and separates true mechanism value from extra-compute placebo effects.
 */
export async function runCounterfactualFork(options: CounterfactualForkOptions): Promise<CounterfactualForkReport> {
	const {
		sourceDbPath,
		sourceRunId,
		atSeq,
		task,
		prepared,
		adapter,
		totalBudget,
		swarmSize,
		outDir,
		repoRoot,
	} = options;
	mkdirSync(outDir, { recursive: true });
	const placeboPrompt =
		options.placeboPrompt ??
		"[fork-placebo] Status check: continue working on your current assignment with the information you already have.";

	const prompts: Record<ForkBranch, string | undefined> = {
		unchanged: undefined,
		placebo: placeboPrompt,
		treatment: options.treatmentPrompt,
	};

	const higher = task.higherIsBetter ?? true;
	const branches = {} as Record<ForkBranch, Scorecard>;
	let spentBeforeForkTokens = 0;
	let remainingBudget: RunBudget = totalBudget;

	const branchOrder: ForkBranch[] = ["unchanged", "placebo", "treatment"];
	for (let idx = 0; idx < branchOrder.length; idx++) {
		const branch = branchOrder[idx]!;
		const branchDir = join(outDir, branch);
		const runDir = join(branchDir, "run");
		const workDir = join(branchDir, "workspace");
		mkdirSync(runDir, { recursive: true });
		cpSync(prepared.workspaceDir, workDir, { recursive: true });
		const dbPath = join(runDir, "trace.db");
		const runId = `${sourceRunId}-fork-${atSeq}-${branch}`;

		spentBeforeForkTokens = cloneTruncatedTrace(sourceDbPath, sourceRunId, atSeq, dbPath, runId);
		remainingBudget = {
			tokens:
				totalBudget.tokens !== undefined
					? Math.max(1000, totalBudget.tokens - spentBeforeForkTokens)
					: undefined,
			usd: totalBudget.usd,
			wallClockMs: totalBudget.wallClockMs,
			cpuSeconds: totalBudget.cpuSeconds,
		};

		const spec = {
			runId,
			runDir,
			dbPath,
			taskId: task.id,
			seed: prepared.seed,
			goal: prepared.goal,
			rubric: prepared.rubric,
			workspaceDir: workDir,
			privateShards: prepared.privateShards,
			hiddenDenyPaths: [prepared.hiddenDir, dbPath, `${dbPath}-wal`, `${dbPath}-shm`],
			controlRung: "swarm" as const,
			topology: options.topology ?? "fork",
			swarmSize,
			budget: remainingBudget,
			budgetMode: "tokens" as const,
			autoNominate: true,
			sandboxProfile: prepared.sandboxProfile,
			taskOptions: prepared.options,
			injectedPrompt: prompts[branch],
		};

		const receipt = await adapter.run(spec);
		branches[branch] = await extractScorecard({
			task,
			prepared: { ...prepared, workspaceDir: workDir },
			spec,
			receipt,
			adapterName: adapter.name,
			armOrderIndex: idx,
			repoRoot,
		});
	}

	const diff = (a: number, b: number) => Math.round((higher ? a - b : b - a) * 1e6) / 1e6;
	const causalMechanismGain = diff(branches.treatment.deliveredScore, branches.placebo.deliveredScore);
	const placeboComputeGain = diff(branches.placebo.deliveredScore, branches.unchanged.deliveredScore);
	const totalRecoveryGain = diff(branches.treatment.deliveredScore, branches.unchanged.deliveredScore);

	let diagnosis: CounterfactualForkReport["diagnosis"];
	if (causalMechanismGain > 1e-6) diagnosis = "MECHANISM_CAUSAL_WIN";
	else if (totalRecoveryGain < -1e-6) diagnosis = "REGRESSION";
	else if (placeboComputeGain > 1e-6) diagnosis = "PLACEBO_COMPUTE_EFFECT";
	else diagnosis = "NO_RECOVERY";

	const report: CounterfactualForkReport = {
		sourceRunId,
		atSeq,
		spentBeforeForkTokens,
		remainingBudget,
		branches,
		causalMechanismGain,
		placeboComputeGain,
		totalRecoveryGain,
		diagnosis,
	};
	writeFileSync(join(outDir, "fork-report.json"), JSON.stringify(report, null, 2) + "\n");
	return report;
}
