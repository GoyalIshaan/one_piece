import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMockAdapter } from "../src/adapters/mock.ts";
import { extractScorecard } from "../src/scorecard.ts";
import { siloJoinMicroTask } from "../src/tasks/silo-join-micro/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("universal cross-eval scorecard extractor", () => {
	it("extracts tokens by role/category, time/compute splits, parallelism, anytime frontier, and nomination loss", async () => {
		const root = mkdtempSync(join(tmpdir(), "eval-card-"));
		try {
			const workDir = join(root, "work");
			const hiddenDir = join(root, "hidden");
			const prepared = await siloJoinMicroTask.prepare({
				seed: 19,
				n: 4,
				options: { mode: "prefix" },
				workDir,
				hiddenDir,
			});
			const refDir = join(root, "ref");
			cpSync(prepared.workspaceDir, refDir, { recursive: true });
			await siloJoinMicroTask.buildReferenceArtifact!({ prepared, outDir: refDir });

			// Run 1: autoNominate = false, worker solves but never nominates -> nominationLoss = 1
			const adapter = createMockAdapter({
				mode: "pass_without_nominating",
				referenceDir: refDir,
				tokensPerTurn: 1000,
			});
			const runDirOff = join(root, "run-off");
			const specOff = {
				runId: "card-off",
				runDir: runDirOff,
				dbPath: join(runDirOff, "trace.db"),
				taskId: siloJoinMicroTask.id,
				seed: 19,
				goal: prepared.goal,
				workspaceDir: prepared.workspaceDir,
				privateShards: prepared.privateShards,
				hiddenDenyPaths: [hiddenDir],
				controlRung: "swarm" as const,
				topology: "scalemas-peers",
				swarmSize: 4,
				budget: { tokens: 100_000 },
				budgetMode: "tokens" as const,
				autoNominate: false,
				sandboxProfile: prepared.sandboxProfile,
				taskOptions: prepared.options,
			};
			const receiptOff = await adapter.run(specOff);
			const cardOff = await extractScorecard({
				task: siloJoinMicroTask,
				prepared,
				spec: specOff,
				receipt: receiptOff,
				adapterName: adapter.name,
				armOrderIndex: 0,
				repoRoot: REPO_ROOT,
			});

			expect(cardOff.hasHarnessFault).toBe(false);
			expect(cardOff.deliveredPass).toBe(false);
			expect(cardOff.deliveredScore).toBe(0);
			expect(cardOff.bestOfflinePass).toBe(true);
			expect(cardOff.bestOfflineScore).toBe(1);
			expect(cardOff.losses.nominationLoss).toBe(1);
			expect(cardOff.losses.discoveryLoss).toBe(0);
			expect(cardOff.losses.postOptimumTokens).toBeGreaterThan(0);
			expect(cardOff.tokens.total).toBe(10_250); // 4 seats * (1000 + 500 + 1000) + 250 post-opt
			expect(cardOff.tokens.byCategory.coordination).toBe(2000); // 4 * 500 post_board calls
			expect(cardOff.tokens.coordinationTokenShare).toBeGreaterThan(0.15);
			expect(cardOff.dynamics.peakParallelism).toBe(4);
			expect(cardOff.dynamics.messageCount).toBe(4);
			expect(cardOff.time.llmWaitMs).toBeGreaterThan(0);
			expect(cardOff.time.toolExecMs).toBeGreaterThan(0);
			expect(cardOff.time.cpuSeconds).toBeGreaterThan(0);
			expect(cardOff.anytimeFrontier.length).toBeGreaterThanOrEqual(1);

			// Run 2: autoNominate = true -> recovers nominationLoss to 0
			const runDirOn = join(root, "run-on");
			const specOn = { ...specOff, runId: "card-on", runDir: runDirOn, dbPath: join(runDirOn, "trace.db"), autoNominate: true };
			const receiptOn = await adapter.run(specOn);
			const cardOn = await extractScorecard({
				task: siloJoinMicroTask,
				prepared,
				spec: specOn,
				receipt: receiptOn,
				adapterName: adapter.name,
				armOrderIndex: 1,
				repoRoot: REPO_ROOT,
			});
			expect(cardOn.deliveredPass).toBe(true);
			expect(cardOn.deliveredScore).toBe(1);
			expect(cardOn.autoNominated).toBe(true);
			expect(cardOn.losses.nominationLoss).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
