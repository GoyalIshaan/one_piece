import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalTask } from "./contracts.ts";
import { runSandboxedEvalCommand, sha256Dir } from "./sandbox.ts";
import { extractScorecard } from "./scorecard.ts";
import { createMockAdapter } from "./adapters/mock.ts";

export interface CalibrationCheckResult {
	name: string;
	passed: boolean;
	details: string;
}

export interface TaskCalibrationReport {
	taskId: string;
	passed: boolean;
	checks: CalibrationCheckResult[];
}

/**
 * Zero-cost deterministic 6-check calibration gate that every EvalTask must pass
 * before a single real LLM token is spent on it.
 */
export async function runTaskCalibration(
	task: EvalTask,
	options: { seed?: number; n?: number; repoRoot: string; taskOptions?: Record<string, string> },
): Promise<TaskCalibrationReport> {
	const seed = options.seed ?? 7;
	const n = options.n ?? task.supportedN.find((v) => v >= 2) ?? task.supportedN[0] ?? 1;
	const taskOptions = { ...task.defaultOptions, ...options.taskOptions };
	const root = mkdtempSync(join(tmpdir(), `eval-lab-cal-${task.id}-`));
	const checks: CalibrationCheckResult[] = [];

	try {
		const workDir = join(root, "seed-work");
		const hiddenDir = join(root, "hidden");
		const prepared = await task.prepare({ seed, n, options: taskOptions, workDir, hiddenDir });

		// 1. Starter / untouched check
		const starterGrade = await task.grade({
			artifactDir: prepared.workspaceDir,
			hiddenDir: prepared.hiddenDir,
			seed,
			n,
			options: taskOptions,
		});
		const starterOk =
			prepared.incumbentScore !== undefined
				? Math.abs(starterGrade.score - prepared.incumbentScore) < 1e-4
				: !starterGrade.passed;
		checks.push({
			name: "starter_fails_or_matches_incumbent",
			passed: starterOk,
			details: `starter passed=${starterGrade.passed}, score=${starterGrade.score}, expectedIncumbent=${prepared.incumbentScore ?? "fail"} (${starterGrade.details})`,
		});

		// 2. Oracle reference check
		const refDir = join(root, "reference");
		if (task.buildReferenceArtifact) {
			cpSync(prepared.workspaceDir, refDir, { recursive: true });
			await task.buildReferenceArtifact({ prepared, outDir: refDir });
			const oracleGrade = await task.grade({
				artifactDir: refDir,
				hiddenDir: prepared.hiddenDir,
				seed,
				n,
				options: taskOptions,
			});
			const expectedPass = prepared.incumbentScore !== undefined ? oracleGrade.score > prepared.incumbentScore : oracleGrade.passed;
			checks.push({
				name: "oracle_passes",
				passed: oracleGrade.passed && expectedPass,
				details: `oracle passed=${oracleGrade.passed}, score=${oracleGrade.score} (${oracleGrade.details})`,
			});
		} else {
			checks.push({
				name: "oracle_passes",
				passed: false,
				details: "Task did not implement buildReferenceArtifact()",
			});
		}

		// Optional semantic interference check (for coupled code tasks)
		if (task.buildSemanticInterferenceArtifact) {
			const brokenDir = join(root, "semantic-conflict");
			cpSync(prepared.workspaceDir, brokenDir, { recursive: true });
			const built = await task.buildSemanticInterferenceArtifact({ prepared, outDir: brokenDir });
			if (built !== false) {
				const brokenGrade = await task.grade({
					artifactDir: brokenDir,
					hiddenDir: prepared.hiddenDir,
					seed,
					n,
					options: taskOptions,
				});
				checks.push({
					name: "semantic_interference_caught",
					passed: !brokenGrade.passed && Boolean(brokenGrade.customMetrics.semanticInterferenceLoss),
					details: `naive merge passed=${brokenGrade.passed}, semanticInterferenceLoss=${String(brokenGrade.customMetrics.semanticInterferenceLoss)} (${brokenGrade.details})`,
				});
			}
		}

		// 3. Nomination loss detection (un-nominated passing workspace vs auto-nominated)
		if (task.buildReferenceArtifact) {
			const mockUnnominated = createMockAdapter({
				mode: "pass_without_nominating",
				referenceDir: refDir,
			});
			const runDirA = join(root, "nom-loss-off");
			const specA = {
				runId: "cal-nom-off",
				runDir: runDirA,
				dbPath: join(runDirA, "trace.db"),
				taskId: task.id,
				seed,
				goal: prepared.goal,
				workspaceDir: prepared.workspaceDir,
				privateShards: prepared.privateShards,
				hiddenDenyPaths: [hiddenDir],
				controlRung: "swarm" as const,
				swarmSize: n,
				budget: { tokens: 100_000 },
				budgetMode: "tokens" as const,
				autoNominate: false,
				sandboxProfile: prepared.sandboxProfile,
				taskOptions,
			};
			const receiptA = await mockUnnominated.run(specA);
			const cardA = await extractScorecard({
				task,
				prepared,
				spec: specA,
				receipt: receiptA,
				adapterName: mockUnnominated.name,
				armOrderIndex: 0,
				repoRoot: options.repoRoot,
			});

			const runDirB = join(root, "nom-loss-on");
			const specB = { ...specA, runId: "cal-nom-on", runDir: runDirB, dbPath: join(runDirB, "trace.db"), autoNominate: true };
			const receiptB = await mockUnnominated.run(specB);
			const cardB = await extractScorecard({
				task,
				prepared,
				spec: specB,
				receipt: receiptB,
				adapterName: mockUnnominated.name,
				armOrderIndex: 1,
				repoRoot: options.repoRoot,
			});

			const nomOk =
				!cardA.deliveredPass &&
				cardA.bestOfflinePass &&
				cardA.losses.nominationLoss > 0 &&
				cardB.deliveredPass &&
				cardB.autoNominated &&
				cardB.losses.nominationLoss === 0;
			checks.push({
				name: "nomination_loss_detected",
				passed: nomOk,
				details: `autoOff(delivered=${cardA.deliveredScore}, bestOffline=${cardA.bestOfflineScore}, nomLoss=${cardA.losses.nominationLoss}); autoOn(delivered=${cardB.deliveredScore}, nomLoss=${cardB.losses.nominationLoss})`,
			});
		}

		// 4. Loud harness fault detection (exit-0 silent missing edit tool)
		const mockFault = createMockAdapter({ mode: "silent_patch_noop" });
		const faultDir = join(root, "fault-run");
		const faultSpec = {
			runId: "cal-fault",
			runDir: faultDir,
			dbPath: join(faultDir, "trace.db"),
			taskId: task.id,
			seed,
			goal: prepared.goal,
			workspaceDir: prepared.workspaceDir,
			hiddenDenyPaths: [hiddenDir],
			controlRung: "solo" as const,
			swarmSize: 1,
			budget: { tokens: 50_000 },
			budgetMode: "tokens" as const,
			autoNominate: false,
			sandboxProfile: prepared.sandboxProfile,
		};
		const faultReceipt = await mockFault.run(faultSpec);
		const faultCard = await extractScorecard({
			task,
			prepared,
			spec: faultSpec,
			receipt: faultReceipt,
			adapterName: mockFault.name,
			armOrderIndex: 0,
			repoRoot: options.repoRoot,
		});
		checks.push({
			name: "loud_fault_not_masked",
			passed: faultCard.hasHarnessFault && faultCard.harnessFaults.some((f) => f.code === "SILENT_PATCH_NOOP"),
			details: `faults=[${faultCard.harnessFaults.map((f) => f.code).join(", ")}]`,
		});

		// 5. Offline Seatbelt sandbox probe (positive control + denies outbound network + hiddenDir read + sibling shard read)
		if (process.platform === "darwin") {
			const probeDir = join(root, "sandbox-probe");
			cpSync(prepared.workspaceDir, probeDir, { recursive: true });
			const denyDirs = [hiddenDir, ...(prepared.privateShards ? prepared.privateShards.slice(1) : [])];
			const readableDirs = prepared.privateShards?.[0] ? [prepared.privateShards[0]] : undefined;
			const posProbe = await runSandboxedEvalCommand({
				cwd: probeDir,
				profile: prepared.sandboxProfile,
				readableDirs,
				deniedDirs: denyDirs,
				command: `echo SANDBOX_OK`,
				timeoutMs: 5000,
			});
			const netProbe = await runSandboxedEvalCommand({
				cwd: probeDir,
				profile: prepared.sandboxProfile,
				readableDirs,
				deniedDirs: denyDirs,
				command: `python3 -c "import socket; s=socket.create_connection(('1.1.1.1', 80), timeout=1)"`,
				timeoutMs: 5000,
			});
			const hiddenProbe = await runSandboxedEvalCommand({
				cwd: probeDir,
				profile: prepared.sandboxProfile,
				readableDirs,
				deniedDirs: denyDirs,
				command: `ls -la "${hiddenDir}"`,
				timeoutMs: 5000,
			});
			let shardProbeOk = true;
			let shardNote = "n/a";
			if (prepared.privateShards && prepared.privateShards.length >= 2) {
				const sibProbe = await runSandboxedEvalCommand({
					cwd: probeDir,
					profile: prepared.sandboxProfile,
					readableDirs,
					deniedDirs: denyDirs,
					command: `ls -la "${prepared.privateShards[1]}"`,
					timeoutMs: 5000,
				});
				shardProbeOk = sibProbe.exitCode !== 0;
				shardNote = `siblingShardExit=${sibProbe.exitCode}`;
			}
			const posOk = posProbe.exitCode === 0 && posProbe.stdout.includes("SANDBOX_OK");
			const sandboxOk = posOk && netProbe.exitCode !== 0 && hiddenProbe.exitCode !== 0 && shardProbeOk;
			checks.push({
				name: "sandbox_denies_network_and_hidden",
				passed: sandboxOk,
				details: `posExit=${posProbe.exitCode}, netExit=${netProbe.exitCode}, hiddenExit=${hiddenProbe.exitCode}, ${shardNote}`,
			});
		} else {
			checks.push({
				name: "sandbox_denies_network_and_hidden",
				passed: true,
				details: `Skipped Seatbelt check on non-darwin platform (${process.platform})`,
			});
		}

		// 6. Stale verdict integrity check
		const mockStale = createMockAdapter({ mode: "stale_verdict", referenceDir: refDir });
		const staleDir = join(root, "stale-run");
		const staleSpec = {
			...faultSpec,
			runId: "cal-stale",
			runDir: staleDir,
			dbPath: join(staleDir, "trace.db"),
		};
		const staleReceipt = await mockStale.run(staleSpec);
		const staleCard = await extractScorecard({
			task,
			prepared,
			spec: staleSpec,
			receipt: staleReceipt,
			adapterName: mockStale.name,
			armOrderIndex: 0,
			repoRoot: options.repoRoot,
		});
		checks.push({
			name: "stale_verdict_integrity",
			passed: staleCard.hasHarnessFault && staleCard.harnessFaults.some((f) => f.code === "STALE_VERDICT_APPLIED"),
			details: `faults=[${staleCard.harnessFaults.map((f) => f.code).join(", ")}], refSha=${sha256Dir(refDir).slice(0, 12)}`,
		});

		// 7. PublicCheck calibration (starter fails non-optimization tasks; oracle strictly beats starter)
		if (task.publicCheck && task.buildReferenceArtifact) {
			const higher = task.higherIsBetter ?? true;
			const starterPub = await task.publicCheck({ artifactDir: prepared.workspaceDir, seed, n, options: taskOptions });
			const oraclePub = await task.publicCheck({ artifactDir: refDir, seed, n, options: taskOptions });
			const isScalarOpt = task.family === "scalar-optimization" || prepared.incumbentScore !== undefined;
			const starterCalOk = isScalarOpt ? true : !starterPub.passed && starterPub.score < 1.0;
			const oracleBeatsStarter = higher ? oraclePub.score > starterPub.score + 1e-9 : oraclePub.score < starterPub.score - 1e-9;
			checks.push({
				name: "public_check_calibrated",
				passed: starterCalOk && oraclePub.passed && oracleBeatsStarter,
				details: `starter(passed=${starterPub.passed}, score=${starterPub.score}); oracle(passed=${oraclePub.passed}, score=${oraclePub.score})`,
			});

			// 8. PublicCheck tamper-resistance (mutating in-tree public test/sim files cannot fake a pass or speedup)
			const tamperDir = join(root, "tamper-probe");
			cpSync(prepared.workspaceDir, tamperDir, { recursive: true });
			const pubTestPath = join(tamperDir, "tests", "test_public.py");
			const vliwSimPath = join(tamperDir, "vliw_sim.py");
			let tamperedCheckOk = true;
			let tamperDetail = "no mutable in-tree public harness file";
			if (existsSync(pubTestPath)) {
				writeFileSync(
					pubTestPath,
					"import unittest\nclass Tampered(unittest.TestCase):\n    def test_fake(self):\n        self.assertTrue(True)\n",
				);
				const tamperedPub = await task.publicCheck({ artifactDir: tamperDir, seed, n, options: taskOptions });
				tamperedCheckOk = !tamperedPub.passed && Math.abs(tamperedPub.score - starterPub.score) <= 1e-6;
				tamperDetail = `tampered tests/test_public.py -> passed=${tamperedPub.passed}, score=${tamperedPub.score} (starter=${starterPub.score})`;
			} else if (existsSync(vliwSimPath)) {
				writeFileSync(vliwSimPath, "# tampered simulator\ndef simulate(*args, **kwargs):\n    return 1, {}\n");
				const tamperedPub = await task.publicCheck({ artifactDir: tamperDir, seed, n, options: taskOptions });
				tamperedCheckOk = Math.abs(tamperedPub.score - starterPub.score) <= 1e-4;
				tamperDetail = `tampered vliw_sim.py -> score=${tamperedPub.score} (starter=${starterPub.score})`;
			}
			checks.push({
				name: "public_check_tamper_resistant",
				passed: tamperedCheckOk,
				details: tamperDetail,
			});
		}

		return {
			taskId: task.id,
			passed: checks.every((c) => c.passed),
			checks,
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
