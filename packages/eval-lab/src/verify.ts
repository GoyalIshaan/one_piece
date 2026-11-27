import { spawnSync } from "node:child_process";
import type { EvalTask } from "./contracts.ts";
import { runTaskCalibration, type TaskCalibrationReport } from "./calibration.ts";
import { runRealOsChaosSuite, type ChaosSuiteReport } from "./chaos.ts";
import { runFaultInjectionSuite, type FaultSuiteReport } from "./faults.ts";
import { gitReproducibility, sha256Text } from "./sandbox.ts";
import { EVAL_TASKS } from "./tasks/registry.ts";

export interface VerificationLayerSummary {
	readonly name: string;
	readonly passed: boolean;
	readonly durationMs: number;
	readonly summary: string;
}

export interface HarnessHealthCertificate {
	readonly schemaVersion: 1;
	readonly generatedAt: string;
	readonly harnessGitSha: string;
	readonly dirtyDiffSha: string;
	readonly nodeVersion: string;
	readonly platform: string;
	readonly allPassed: boolean;
	readonly layers: readonly VerificationLayerSummary[];
	readonly chaos: ChaosSuiteReport;
	readonly faultIntegrity: FaultSuiteReport;
	readonly calibrations: readonly TaskCalibrationReport[];
	readonly certificateSha256: string;
}

export interface HarnessVerifyOptions {
	readonly repoRoot: string;
	readonly tasks?: readonly EvalTask[];
	/** Run `npm run typecheck` as part of the verification gate (default true). */
	readonly runTypecheck?: boolean;
	readonly log?: (line: string) => void;
}

/**
 * Run the full zero-token Harness Verification Gate:
 *   1. Static typecheck & compile-time state-machine proof check (optional)
 *   2. Eval-lab integrity fault-injection detector suite
 *   3. Real-OS chaos, concurrency, budget-conservation, and security red-team suite
 *   4. Zero-cost 6-check calibration gate across all registered benchmarks
 *
 * Emits a tamper-evident `HarnessHealthCertificate` bound to `(harnessGitSha, dirtyDiffSha)`.
 */
export async function runHarnessVerificationGate(
	options: HarnessVerifyOptions,
): Promise<HarnessHealthCertificate> {
	const log = options.log ?? (() => {});
	const tasks = options.tasks ?? EVAL_TASKS;
	const git = gitReproducibility(options.repoRoot);
	const layers: VerificationLayerSummary[] = [];

	// Layer 1: Static TypeScript + compile-time proof gate
	if (options.runTypecheck !== false) {
		const t0 = Date.now();
		log("▶ [1/4] Static typecheck & compile-time proofs...");
		const tc = spawnSync("npm", ["run", "typecheck"], {
			cwd: options.repoRoot,
			encoding: "utf8",
			timeout: 120_000,
		});
		const passed = tc.status === 0;
		const dur = Date.now() - t0;
		layers.push({
			name: "static_typecheck",
			passed,
			durationMs: dur,
			summary: passed ? "tsc + dashboard typecheck clean" : (tc.stderr || tc.stdout).slice(0, 400),
		});
		log(`  ${passed ? "✓" : "✗"} static_typecheck (${dur}ms)`);
	}

	// Layer 2: Deterministic fault-detector integrity suite
	const f0 = Date.now();
	log("▶ [2/4] Eval-lab fault-detector integrity suite...");
	const representativeTask = tasks[0] ?? EVAL_TASKS[0]!;
	const faultIntegrity = await runFaultInjectionSuite(representativeTask, { repoRoot: options.repoRoot });
	const fDur = Date.now() - f0;
	const fPassedCount = faultIntegrity.scenarios.filter((s) => s.integrityDetected).length;
	layers.push({
		name: "fault_detector_integrity",
		passed: faultIntegrity.allIntegrityChecksPassed,
		durationMs: fDur,
		summary: `${fPassedCount}/${faultIntegrity.scenarios.length} fault classes caught on ${representativeTask.id}`,
	});
	log(`  ${faultIntegrity.allIntegrityChecksPassed ? "✓" : "✗"} fault_detector_integrity (${fPassedCount}/${faultIntegrity.scenarios.length}, ${fDur}ms)`);

	// Layer 3: Real-OS chaos, concurrency & security red-team suite
	log("▶ [3/4] Real-OS chaos, concurrency & security red-team suite...");
	const chaos = await runRealOsChaosSuite();
	layers.push({
		name: "real_os_chaos_and_security",
		passed: chaos.allPassed,
		durationMs: chaos.durationMs,
		summary: `${chaos.passedCount}/${chaos.totalCount} real-OS chaos/security scenarios passed`,
	});
	for (const sc of chaos.scenarios) {
		log(`  ${sc.passed ? "✓" : "✗"} ${sc.scenario} (${sc.durationMs}ms): ${sc.details}`);
	}

	// Layer 4: Zero-cost calibration gate across all eval tasks
	const c0 = Date.now();
	log(`▶ [4/4] Zero-cost benchmark calibration gate (${tasks.length} tasks)...`);
	const calibrations: TaskCalibrationReport[] = [];
	for (const task of tasks) {
		const cal = await runTaskCalibration(task, { repoRoot: options.repoRoot });
		calibrations.push(cal);
		const okCount = cal.checks.filter((c) => c.passed).length;
		log(`  ${cal.passed ? "✓" : "✗"} ${cal.taskId} (${okCount}/${cal.checks.length} checks)`);
	}
	const cDur = Date.now() - c0;
	const calPassed = calibrations.filter((c) => c.passed).length;
	layers.push({
		name: "benchmark_calibration_gates",
		passed: calPassed === calibrations.length,
		durationMs: cDur,
		summary: `${calPassed}/${calibrations.length} tasks passed all calibration & Seatbelt checks`,
	});

	const allPassed = layers.every((l) => l.passed);
	const unsigned = {
		schemaVersion: 1 as const,
		generatedAt: new Date().toISOString(),
		harnessGitSha: git.harnessGitSha,
		dirtyDiffSha: git.dirtyDiffSha,
		nodeVersion: process.version,
		platform: process.platform,
		allPassed,
		layers,
		chaos,
		faultIntegrity,
		calibrations,
	};
	const certificateSha256 = sha256Text(JSON.stringify(unsigned));
	return { ...unsigned, certificateSha256 };
}

export function renderHealthCertificateMarkdown(cert: HarnessHealthCertificate): string {
	const lines: string[] = [
		`# Harness Health Certificate (${cert.allPassed ? "PASS" : "FAIL"})`,
		"",
		`- **Git SHA:** \`${cert.harnessGitSha}\``,
		`- **Dirty Diff SHA:** \`${cert.dirtyDiffSha.slice(0, 16)}\``,
		`- **Runtime:** Node \`${cert.nodeVersion}\` on \`${cert.platform}\``,
		`- **Certificate SHA-256:** \`${cert.certificateSha256.slice(0, 24)}\``,
		"",
		"## Verification Layers",
		"",
		"| Layer | Status | Duration (ms) | Summary |",
		"| --- | :---: | ---: | --- |",
	];
	for (const l of cert.layers) {
		lines.push(`| \`${l.name}\` | ${l.passed ? "PASS" : "FAIL"} | ${l.durationMs} | ${l.summary} |`);
	}
	lines.push("", "## Real-OS Chaos & Red-Team Scenarios", "", "| Scenario | Status | Duration (ms) | Details |", "| --- | :---: | ---: | --- |");
	for (const s of cert.chaos.scenarios) {
		lines.push(`| \`${s.scenario}\` | ${s.passed ? "PASS" : "FAIL"} | ${s.durationMs} | ${s.details} |`);
	}
	return lines.join("\n") + "\n";
}
