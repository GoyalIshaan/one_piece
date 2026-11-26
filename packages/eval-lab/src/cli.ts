import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockAdapter } from "./adapters/mock.ts";
import { createCliV2Router, createV2Adapter } from "./adapters/v2.ts";
import { runTaskCalibration } from "./calibration.ts";
import type { BudgetMode, ControlRung, Scorecard } from "./contracts.ts";
import { analyzeProxyToTargetCorrelation, renderCorrelationReport } from "./correlation.ts";
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
				"  run --task <id> [--rungs solo,silent_bon,swarm] [--topology pull-refinery] [--topologies a,b] [--n 2] [--seeds 1..5]",
				"      [--budget-tokens 120000] [--wall-ms 300000] [--budget-mode tokens|wall_clock] [--opt key=val]",
				"      [--no-field-guide] [--no-semantic-repair] [--out <dir>] [--adapter mock:reference|mock:starter|v2] [--drivers codex,gemini,grok]",
				"  correlate --dirs <dir1,dir2,...> [--out <report.md>]  Compute proxy-to-long-horizon rank correlations",
				"  report --dir <campaignDir>           Print saved campaign summary & report",
			].join("\n"),
		);
		return;
	}

	if (command === "list") {
		for (const t of EVAL_TASKS) {
			const tier = (t.tier ?? "proxy").padEnd(13);
			console.log(`${t.id.padEnd(24)} tier=${tier} family=${t.family.padEnd(20)} supportedN=[${t.supportedN.join(",")}]  ${t.title}`);
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
		const wallMsRaw = parseFlag(rest, "--wall-ms");
		const wallClockMs = wallMsRaw !== undefined ? Number(wallMsRaw) : undefined;
		const budgetMode = (parseFlag(rest, "--budget-mode") ?? "tokens") as BudgetMode;
		const adapterArg = parseFlag(rest, "--adapter") ?? "mock:starter";
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const outDir = resolve(parseFlag(rest, "--out") ?? join(REPO_ROOT, ".one_piece", "eval-lab", `${stamp}-${task.id}`));

		const topologiesArg = parseFlag(rest, "--topologies");
		const topology = parseFlag(rest, "--topology") ?? "pull-refinery";
		const swarmTopologies = topologiesArg ? topologiesArg.split(",").map((s) => s.trim()).filter(Boolean) : [topology];
		const driversArg = parseFlag(rest, "--drivers") ?? "codex";
		const enableFieldGuide = !rest.includes("--no-field-guide");
		const enableSemanticRepair = !rest.includes("--no-semantic-repair");

		const arms: ArmSpec[] = [];
		for (const rung of rungs) {
			if (rung === "solo") {
				arms.push({ id: "solo-n1", controlRung: "solo", topology: "single", swarmSize: 1 });
			} else if (rung === "swarm") {
				for (const topo of swarmTopologies) {
					for (const n of nValues) {
						arms.push({ id: `${topo}-n${n}`, controlRung: "swarm", topology: topo, swarmSize: n });
					}
				}
			} else {
				for (const n of nValues) {
					arms.push({ id: `${rung}-n${n}`, controlRung: rung, topology: rung, swarmSize: n });
				}
			}
		}

		const adapter =
			adapterArg === "v2"
				? createV2Adapter({
						router: createCliV2Router(driversArg.split(",")),
						task,
						enableFieldGuide,
						topologyOptions: { enableSemanticRepair },
					})
				: createMockAdapter({
						mode: adapterArg === "mock:reference" ? "reference" : "starter",
					});

		const result = await runCampaign({
			task,
			adapter,
			arms,
			seeds,
			budget: { tokens: budgetTokens, ...(wallClockMs !== undefined ? { wallClockMs } : {}) },
			budgetMode,
			taskOptions: parseOptions(rest),
			outDir,
			repoRoot: REPO_ROOT,
			log: (line) => console.log(line),
		});
		console.log(`\nSaved campaign report -> ${result.reportPath}`);
		return;
	}

	if (command === "correlate") {
		const dirsArg = parseFlag(rest, "--dirs");
		if (!dirsArg) throw new Error("--dirs <dir1,dir2,...> is required");
		const scorecards: Scorecard[] = [];
		for (const rawDir of dirsArg.split(",").map((s) => s.trim()).filter(Boolean)) {
			const dir = resolve(rawDir);
			const jsonl = join(dir, "results.jsonl");
			if (existsSync(jsonl)) {
				for (const line of readFileSync(jsonl, "utf8").split("\n")) {
					if (line.trim()) scorecards.push(JSON.parse(line) as Scorecard);
				}
			} else if (existsSync(join(dir, "scorecards"))) {
				for (const f of readdirSync(join(dir, "scorecards"))) {
					if (f.endsWith(".json")) scorecards.push(JSON.parse(readFileSync(join(dir, "scorecards", f), "utf8")) as Scorecard);
				}
			}
		}
		const seenTasks = [...new Set(scorecards.map((s) => s.taskId))];
		const proxyTaskIds = seenTasks.filter((id) => (EVAL_TASKS.find((t) => t.id === id)?.tier ?? "proxy") === "proxy");
		const targetTaskIds = seenTasks.filter((id) => EVAL_TASKS.find((t) => t.id === id)?.tier === "long-horizon");
		const report = analyzeProxyToTargetCorrelation(scorecards, { proxyTaskIds, targetTaskIds });
		const md = renderCorrelationReport(report);
		const outPath = parseFlag(rest, "--out");
		if (outPath) {
			const absOut = resolve(outPath);
			writeFileSync(absOut, md, "utf8");
			writeFileSync(absOut.replace(/\.md$/i, ".json"), JSON.stringify(report, null, 2) + "\n", "utf8");
			console.log(`Saved correlation report -> ${absOut}`);
		} else {
			console.log(md);
		}
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
