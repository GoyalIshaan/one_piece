import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockAdapter } from "./adapters/mock.ts";
import { createCliV2Router, createV2Adapter } from "./adapters/v2.ts";
import { runTaskCalibration } from "./calibration.ts";
import type { BudgetMode, ControlRung } from "./contracts.ts";
import { runFaultInjectionSuite } from "./faults.ts";
import { runCampaign, type ArmSpec } from "./runner.ts";
import { EVAL_TASKS, getEvalTask } from "./tasks/registry.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function parseFlag(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	if (idx < 0 || idx + 1 >= args.length) return undefined;
	return args[idx + 1];
}

function parseSeeds(spec: string | undefined): number[] {
	if (!spec) return [1, 2, 3, 4, 5];
	if (spec.includes("..")) {
		const [start, end] = spec.split("..").map(Number);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end! < start!) {
			throw new Error(`Invalid seed range: ${spec}`);
		}
		return Array.from({ length: end! - start! + 1 }, (_, i) => start! + i);
	}
	return spec.split(",").map((s) => {
		const n = Number(s.trim());
		if (!Number.isSafeInteger(n)) throw new Error(`Invalid seed: ${s}`);
		return n;
	});
}

function parseOptions(args: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--opt" && i + 1 < args.length) {
			const pair = args[++i]!;
			const eq = pair.indexOf("=");
			if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
		}
	}
	return out;
}

async function main(): Promise<void> {
	const [, , command, ...rest] = process.argv;
	if (!command || command === "--help" || command === "-h") {
		console.log(
			[
				"one-piece eval-lab CLI",
				"",
				"Commands:",
				"  list                                 List registered eval-lab tasks",
				"  calibrate [--task <id|all>]          Run the 6-check zero-cost calibration gate",
				"  faults [--task <id|all>]             Run the deterministic fault-injection integrity suite",
				"  run --task <id> [--rungs solo,silent_bon,swarm] [--topology pull-refinery] [--n 2] [--seeds 1..5]",
				"      [--budget-tokens 120000] [--budget-mode tokens|wall_clock] [--opt key=val]",
				"      [--out <dir>] [--adapter mock:reference|mock:starter|v2] [--drivers codex,gemini,grok]",
				"  report --dir <campaignDir>           Print saved campaign summary & report",
			].join("\n"),
		);
		return;
	}

	if (command === "list") {
		for (const t of EVAL_TASKS) {
			console.log(`${t.id.padEnd(20)} family=${t.family.padEnd(20)} supportedN=[${t.supportedN.join(",")}]  ${t.title}`);
		}
		return;
	}

	if (command === "calibrate") {
		const taskArg = parseFlag(rest, "--task") ?? "all";
		const tasks = taskArg === "all" ? EVAL_TASKS : [getEvalTask(taskArg)];
		let allPassed = true;
		for (const task of tasks) {
			const report = await runTaskCalibration(task, { repoRoot: REPO_ROOT, taskOptions: parseOptions(rest) });
			console.log(`\n[${report.passed ? "PASS" : "FAIL"}] ${report.taskId}`);
			for (const c of report.checks) {
				console.log(`  ${c.passed ? "✓" : "✗"} ${c.name}: ${c.details}`);
			}
			if (!report.passed) allPassed = false;
		}
		if (!allPassed) process.exitCode = 1;
		return;
	}

	if (command === "faults") {
		const taskArg = parseFlag(rest, "--task") ?? "all";
		const tasks = taskArg === "all" ? EVAL_TASKS : [getEvalTask(taskArg)];
		let allPassed = true;
		for (const task of tasks) {
			const report = await runFaultInjectionSuite(task, { repoRoot: REPO_ROOT });
			console.log(`\n[${report.allIntegrityChecksPassed ? "PASS" : "FAIL"}] faults: ${report.taskId}`);
			for (const s of report.scenarios) {
				console.log(
					`  ${s.integrityDetected ? "✓" : "✗"} ${s.scenario}: expected=${s.expectedFault} detected=[${s.detectedFaultCodes.join(",")}] liveness=${s.livenessDelivered}`,
				);
			}
			if (!report.allIntegrityChecksPassed) allPassed = false;
		}
		if (!allPassed) process.exitCode = 1;
		return;
	}

	if (command === "run") {
		const taskId = parseFlag(rest, "--task");
		if (!taskId) throw new Error("--task <id> is required");
		const task = getEvalTask(taskId);
		const rungs = (parseFlag(rest, "--rungs") ?? "solo,silent_bon,swarm").split(",") as ControlRung[];
		const nValues = (parseFlag(rest, "--n") ?? String(task.supportedN.find((v) => v >= 2) ?? 2))
			.split(",")
			.map((s) => Number(s.trim()));
		const seeds = parseSeeds(parseFlag(rest, "--seeds"));
		const budgetTokens = Number(parseFlag(rest, "--budget-tokens") ?? 120_000);
		const budgetMode = (parseFlag(rest, "--budget-mode") ?? "tokens") as BudgetMode;
		const adapterArg = parseFlag(rest, "--adapter") ?? "mock:starter";
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const outDir = resolve(parseFlag(rest, "--out") ?? join(REPO_ROOT, ".one_piece", "eval-lab", `${stamp}-${task.id}`));

		const topology = parseFlag(rest, "--topology") ?? "pull-refinery";
		const driversArg = parseFlag(rest, "--drivers") ?? "codex";

		const arms: ArmSpec[] = [];
		for (const rung of rungs) {
			if (rung === "solo") {
				arms.push({ id: "solo-n1", controlRung: "solo", topology: "single", swarmSize: 1 });
			} else {
				for (const n of nValues) {
					const topo = rung === "swarm" ? topology : rung;
					arms.push({ id: `${topo}-n${n}`, controlRung: rung, topology: topo, swarmSize: n });
				}
			}
		}

		const adapter =
			adapterArg === "v2"
				? createV2Adapter({
						router: createCliV2Router(driversArg.split(",")),
						task,
					})
				: createMockAdapter({
						mode: adapterArg === "mock:reference" ? "reference" : "starter",
					});

		const result = await runCampaign({
			task,
			adapter,
			arms,
			seeds,
			budget: { tokens: budgetTokens },
			budgetMode,
			taskOptions: parseOptions(rest),
			outDir,
			repoRoot: REPO_ROOT,
			log: (line) => console.log(line),
		});
		console.log(`\nSaved campaign report -> ${result.reportPath}`);
		return;
	}

	if (command === "report") {
		const dir = parseFlag(rest, "--dir");
		if (!dir) throw new Error("--dir <campaignDir> is required");
		const reportPath = join(resolve(dir), "report.md");
		if (!existsSync(reportPath)) throw new Error(`No report.md found in ${dir}`);
		console.log(readFileSync(reportPath, "utf8"));
		return;
	}

	throw new Error(`Unknown command "${command}". Run with --help for usage.`);
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
