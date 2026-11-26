import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMockAdapter } from "../src/adapters/mock.ts";
import { runFaultInjectionSuite } from "../src/faults.ts";
import { runCounterfactualFork } from "../src/fork.ts";
import { siloJoinMicroTask } from "../src/tasks/silo-join-micro/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("counterfactual trace forking & fault-injection integrity suite", () => {
	it("isolates treatment mechanism gain from placebo compute gain on a forked SQLite trace", async () => {
		const root = mkdtempSync(join(tmpdir(), "eval-fork-"));
		try {
			const workDir = join(root, "work");
			const hiddenDir = join(root, "hidden");
			const prepared = await siloJoinMicroTask.prepare({
				seed: 31,
				n: 4,
				options: { mode: "prefix" },
				workDir,
				hiddenDir,
			});
			const refDir = join(root, "ref");
			cpSync(prepared.workspaceDir, refDir, { recursive: true });
			await siloJoinMicroTask.buildReferenceArtifact!({ prepared, outDir: refDir });

			// Produce an initial failed trace
			const initialDir = join(root, "initial-run");
			const initialDb = join(initialDir, "trace.db");
			const starterAdapter = createMockAdapter({ mode: "starter", tokensPerTurn: 1000 });
			await starterAdapter.run({
				runId: "orig-run",
				runDir: initialDir,
				dbPath: initialDb,
				taskId: siloJoinMicroTask.id,
				seed: 31,
				goal: prepared.goal,
				workspaceDir: prepared.workspaceDir,
				privateShards: prepared.privateShards,
				hiddenDenyPaths: [hiddenDir],
				controlRung: "swarm",
				swarmSize: 4,
				budget: { tokens: 50_000 },
				budgetMode: "tokens",
				autoNominate: true,
				sandboxProfile: prepared.sandboxProfile,
				taskOptions: prepared.options,
			});

			// Fork at seq 12 with an adapter that only succeeds when receiving [TREATMENT]
			const forkAdapter = createMockAdapter({ mode: "fork_responsive", referenceDir: refDir, tokensPerTurn: 800 });
			const report = await runCounterfactualFork({
				sourceDbPath: initialDb,
				sourceRunId: "orig-run",
				atSeq: 12,
				task: siloJoinMicroTask,
				prepared,
				adapter: forkAdapter,
				totalBudget: { tokens: 50_000 },
				swarmSize: 4,
				treatmentPrompt: "[TREATMENT] Missing shard subtotal from seat 1 is 312.",
				outDir: join(root, "fork-out"),
				repoRoot: REPO_ROOT,
			});

			expect(report.spentBeforeForkTokens).toBeGreaterThan(0);
			expect(report.remainingBudget.tokens).toBeLessThan(50_000);
			expect(report.branches.unchanged.deliveredPass).toBe(false);
			expect(report.branches.placebo.deliveredPass).toBe(false);
			expect(report.branches.treatment.deliveredPass).toBe(true);
			expect(report.placeboComputeGain).toBe(0);
			expect(report.causalMechanismGain).toBe(1);
			expect(report.diagnosis).toBe("MECHANISM_CAUSAL_WIN");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("catches all 4 deterministic integrity faults cleanly", async () => {
		const report = await runFaultInjectionSuite(siloJoinMicroTask, { repoRoot: REPO_ROOT });
		expect(report.allIntegrityChecksPassed).toBe(true);
		expect(report.scenarios).toHaveLength(4);
		for (const s of report.scenarios) {
			expect(s.integrityDetected).toBe(true);
		}
	});
});
