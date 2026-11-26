import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalTask, HarnessFaultCode } from "./contracts.ts";
import { createMockAdapter } from "./adapters/mock.ts";
import { extractScorecard } from "./scorecard.ts";

export type FaultScenarioName =
	| "stale-verdict"
	| "duplicate-job-callback"
	| "missing-tool-exit0"
	| "mid-run-crash";

export interface FaultScenarioOutcome {
	scenario: FaultScenarioName;
	expectedFault: HarnessFaultCode;
	/** Hard zero-tolerance gate: did the eval layer catch the integrity breach? */
	integrityDetected: boolean;
	/** Separate liveness metric: did a valid artifact still get delivered? */
	livenessDelivered: boolean;
	detectedFaultCodes: HarnessFaultCode[];
}

export interface FaultSuiteReport {
	taskId: string;
	allIntegrityChecksPassed: boolean;
	scenarios: FaultScenarioOutcome[];
}

/**
 * Deterministic fault-injection suite scoring Integrity (zero tolerance for undetected
 * corruption) separately from Liveness (whether a valid artifact survived).
 */
export async function runFaultInjectionSuite(
	task: EvalTask,
	options: { seed?: number; n?: number; repoRoot: string },
): Promise<FaultSuiteReport> {
	const seed = options.seed ?? 11;
	const n = options.n ?? task.supportedN.find((v) => v >= 2) ?? 1;
	const root = mkdtempSync(join(tmpdir(), `eval-lab-faults-${task.id}-`));
	try {
		const workDir = join(root, "work");
		const hiddenDir = join(root, "hidden");
		const prepared = await task.prepare({
			seed,
			n,
			options: { ...task.defaultOptions },
			workDir,
			hiddenDir,
		});
		const refDir = join(root, "ref");
		if (task.buildReferenceArtifact) {
			cpSync(prepared.workspaceDir, refDir, { recursive: true });
			await task.buildReferenceArtifact({ prepared, outDir: refDir });
		}

		const matrix: Array<{
			scenario: FaultScenarioName;
			mode: "stale_verdict" | "duplicate_job" | "silent_patch_noop" | "mid_run_crash";
			expectedFault: HarnessFaultCode;
		}> = [
			{ scenario: "stale-verdict", mode: "stale_verdict", expectedFault: "STALE_VERDICT_APPLIED" },
			{ scenario: "duplicate-job-callback", mode: "duplicate_job", expectedFault: "DUPLICATE_JOB_CHARGE" },
			{ scenario: "missing-tool-exit0", mode: "silent_patch_noop", expectedFault: "SILENT_PATCH_NOOP" },
			{ scenario: "mid-run-crash", mode: "mid_run_crash", expectedFault: "MISSING_TERMINAL_EVENT" },
		];

		const scenarios: FaultScenarioOutcome[] = [];
		for (const item of matrix) {
			const runDir = join(root, item.scenario);
			const adapter = createMockAdapter({ mode: item.mode, referenceDir: refDir });
			const spec = {
				runId: `fault-${item.scenario}`,
				runDir,
				dbPath: join(runDir, "trace.db"),
				taskId: task.id,
				seed,
				goal: prepared.goal,
				workspaceDir: prepared.workspaceDir,
				privateShards: prepared.privateShards,
				hiddenDenyPaths: [hiddenDir],
				controlRung: "swarm" as const,
				swarmSize: n,
				budget: { tokens: 80_000 },
				budgetMode: "tokens" as const,
				autoNominate: false,
				sandboxProfile: prepared.sandboxProfile,
				taskOptions: prepared.options,
			};
			const receipt = await adapter.run(spec);
			const card = await extractScorecard({
				task,
				prepared,
				spec,
				receipt,
				adapterName: adapter.name,
				armOrderIndex: 0,
				repoRoot: options.repoRoot,
			});
			const codes = card.harnessFaults.map((f) => f.code);
			scenarios.push({
				scenario: item.scenario,
				expectedFault: item.expectedFault,
				integrityDetected: codes.includes(item.expectedFault),
				livenessDelivered: card.deliveredPass,
				detectedFaultCodes: codes,
			});
		}

		return {
			taskId: task.id,
			allIntegrityChecksPassed: scenarios.every((s) => s.integrityDetected),
			scenarios,
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
