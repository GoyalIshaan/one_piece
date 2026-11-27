import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDecisionClientFromEnv } from "@one-piece/drivers";
import { createMockAdapter } from "./adapters/mock.ts";
import { createCliV2Router, createV2Adapter } from "./adapters/v2.ts";
import { runTaskCalibration } from "./calibration.ts";
import type { BudgetMode, ControlRung, Scorecard } from "./contracts.ts";
import {
	analyzeDeltaTransferCorrelation,
	analyzeProxyToTargetCorrelation,
	renderCorrelationReport,
} from "./correlation.ts";
import { runFaultInjectionSuite } from "./faults.ts";
import { runRealOsChaosSuite } from "./chaos.ts";
import {
	analyzeFailureBuckets,
	compareBucketsAcrossGenerations,
	computeJudgeCalibration,
	escalateUnexplainedFailures,
	renderFailureBucketsMarkdown,
	runFrontierAudit,
	sampleAuditQueue,
} from "./diagnose.ts";
import { EvalLedger, type TraceAuditRecord } from "./ledger.ts";
import { generateObservatory } from "./observatory.ts";
import { runCampaign, type ArmSpec } from "./runner.ts";
import { ALL_EVAL_TASKS, EVAL_TASKS, EXTERNAL_EVAL_TASKS, getEvalTask } from "./tasks/registry.ts";
import { indexLedgerTraces, SYSTEM1_PROBE_CATALOG } from "./trace-indexer.ts";
import { analyzeTrajectory, renderTrajectoryMarkdown } from "./trajectory.ts";
import { renderHealthCertificateMarkdown, runHarnessVerificationGate } from "./verify.ts";

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
				"  chaos                                Run the zero-token Real-OS chaos, concurrency & security red-team suite",
				"  verify [--skip-typecheck] [--out <cert.json>]  Run full Harness Verification Gate & emit Health Certificate",
				"  run --task <id> [--rungs solo,silent_bon,swarm] [--topology pull-refinery] [--topologies a,b] [--n 2] [--seeds 1..5]",
				"      [--budget-tokens 120000] [--wall-ms 300000] [--budget-mode tokens|wall_clock] [--opt key=val]",
				"      [--no-field-guide] [--no-semantic-repair] [--out <dir>] [--adapter mock:reference|mock:starter|v2] [--drivers codex,gemini,grok]",
				"  correlate --dirs <dir1,dir2,...> [--out <report.md>]  Compute proxy-to-long-horizon rank correlations",
				"  ledger <backfill|ingest|status> [--root <dir>] [--dir <campaignDir>] [--gen <id>] [--label <name>] [--ledger <db>] [--index]",
				"  index [--ledger <db>] [--gen <id>] [--task <id>] [--only-suboptimal] [--probes a,b] [--no-jev] [--limit <N>] [--concurrency 4]",
				"  diagnose [--ledger <db>] [--gen <id>] [--compare-gen <prev>] [--task <id>] [--judge <name>] [--version <v>] [--min-prob 0.75]",
				"           [--show-evidence] [--escalate] [--drivers codex] [--max-escalate 5]",
				"  audit-judges [--ledger <db>] [--sample 20] [--judge <name>] [--auditor frontier|print] [--drivers codex] [--import <file.json>]",
				"  observatory [--ledger <db>] [--backfill-root <dir>] [--out <dir>]  Build Trajectory Report, SVGs & interactive HTML Observatory",
				"  report --dir <campaignDir>           Print saved campaign summary & report",
			].join("\n"),
		);
		return;
	}

	if (command === "list") {
		console.log("Built-in Eval-Lab Tasks (Zero-Docker):");
		for (const t of EVAL_TASKS) {
			const tier = (t.tier ?? "proxy").padEnd(13);
			console.log(`  ${t.id.padEnd(24)} tier=${tier} family=${t.family.padEnd(20)} supportedN=[${t.supportedN.join(",")}]  ${t.title}`);
		}
		console.log("\nExternal Industry-Standard Tasks (Strict Docker-Only):");
		for (const t of EXTERNAL_EVAL_TASKS) {
			const tier = (t.tier ?? "long-horizon").padEnd(13);
			console.log(`  ${t.id.padEnd(24)} tier=${tier} family=${t.family.padEnd(20)} supportedN=[${t.supportedN.join(",")}]  ${t.title}`);
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

	if (command === "chaos") {
		const report = await runRealOsChaosSuite();
		console.log(`\n[${report.allPassed ? "PASS" : "FAIL"}] real-OS chaos suite (${report.passedCount}/${report.totalCount}, ${report.durationMs}ms)`);
		for (const s of report.scenarios) {
			console.log(`  ${s.passed ? "✓" : "✗"} ${s.scenario} (${s.durationMs}ms): ${s.details}`);
		}
		if (!report.allPassed) process.exitCode = 1;
		return;
	}

	if (command === "verify") {
		const runTypecheck = !rest.includes("--skip-typecheck");
		const outPath = parseFlag(rest, "--out");
		const cert = await runHarnessVerificationGate({
			repoRoot: REPO_ROOT,
			runTypecheck,
			log: (line) => console.log(line),
		});
		console.log("\n" + renderHealthCertificateMarkdown(cert));
		if (outPath) {
			const absOut = resolve(outPath);
			writeFileSync(absOut, JSON.stringify(cert, null, 2) + "\n", "utf8");
			writeFileSync(absOut.replace(/\.json$/i, ".md"), renderHealthCertificateMarkdown(cert), "utf8");
			console.log(`Saved health certificate -> ${absOut}`);
		}
		if (!cert.allPassed) process.exitCode = 1;
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
		const explicitNoFieldGuide = rest.includes("--no-field-guide");
		const explicitFieldGuide = rest.includes("--field-guide");
		const enableFieldGuide = !explicitNoFieldGuide;
		const enableSemanticRepair = !rest.includes("--no-semantic-repair");
		const decisionArg = (parseFlag(rest, "--decision-model") ?? "none") as "jev" | "auto" | "none";
		const concurrencyMode = (parseFlag(rest, "--concurrency") ?? "fixed") as "physics" | "fixed";
		const generationsRaw = parseFlag(rest, "--generations");
		const generations = generationsRaw === "unbounded"
			? ("unbounded" as const)
			: generationsRaw !== undefined
				? Number(generationsRaw)
				: undefined;
		const estimateBounds = rest.includes("--bound-analyst") ? true : undefined;
		const checkpointPolicy = (parseFlag(rest, "--checkpoint-policy") ?? "coalesce") as "coalesce" | "interactive";
		const decisionClient = createDecisionClientFromEnv({ provider: decisionArg, cwd: REPO_ROOT });

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
						router: createCliV2Router(driversArg.split(","), { concurrencyMode }),
						task,
						enableFieldGuide,
						decisionClient,
						topologyOptions: {
							enableSemanticRepair,
							...(explicitNoFieldGuide ? { enableFieldGuideOverride: false } : explicitFieldGuide ? { enableFieldGuideOverride: true } : {}),
							...(generations !== undefined ? { generations } : {}),
							...(estimateBounds !== undefined ? { estimateBounds } : {}),
							checkpointPolicy,
						},
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
		const loadDirs = (rawArg: string): Scorecard[] => {
			const out: Scorecard[] = [];
			for (const rawDir of rawArg.split(",").map((s) => s.trim()).filter(Boolean)) {
				const dir = resolve(rawDir);
				const jsonl = join(dir, "results.jsonl");
				if (existsSync(jsonl)) {
					for (const line of readFileSync(jsonl, "utf8").split("\n")) {
						if (line.trim()) out.push(JSON.parse(line) as Scorecard);
					}
				} else if (existsSync(join(dir, "scorecards"))) {
					for (const f of readdirSync(join(dir, "scorecards"))) {
						if (f.endsWith(".json")) out.push(JSON.parse(readFileSync(join(dir, "scorecards", f), "utf8")) as Scorecard);
					}
				}
			}
			return out;
		};

		const excludeFaulted = !rest.includes("--include-faulted");
		const baseDirsArg = parseFlag(rest, "--baseline-dirs");
		const candDirsArg = parseFlag(rest, "--candidate-dirs");
		if (baseDirsArg && candDirsArg) {
			const baseCards = loadDirs(baseDirsArg);
			const candCards = loadDirs(candDirsArg);
			const proxyTaskId = parseFlag(rest, "--proxy-task") ?? [...new Set(baseCards.map((c) => c.taskId))].find((id) => (EVAL_TASKS.find((t) => t.id === id)?.tier ?? "proxy") === "proxy");
			const targetTaskId = parseFlag(rest, "--target-task") ?? [...new Set(baseCards.map((c) => c.taskId))].find((id) => EVAL_TASKS.find((t) => t.id === id)?.tier === "long-horizon");
			if (!proxyTaskId || !targetTaskId) throw new Error("Could not infer --proxy-task and --target-task from baseline dirs");
			const delta = analyzeDeltaTransferCorrelation(baseCards, candCards, { proxyTaskId, targetTaskId, excludeFaulted });
			console.log(JSON.stringify(delta, null, 2));
			return;
		}

		const dirsArg = parseFlag(rest, "--dirs");
		if (!dirsArg) throw new Error("--dirs <dir1,dir2,...> (or --baseline-dirs + --candidate-dirs) is required");
		const scorecards = loadDirs(dirsArg);
		const seenTasks = [...new Set(scorecards.map((s) => s.taskId))];
		const proxyTaskIds = seenTasks.filter((id) => (ALL_EVAL_TASKS.find((t) => t.id === id)?.tier ?? "proxy") === "proxy");
		const targetTaskIds = seenTasks.filter((id) => ALL_EVAL_TASKS.find((t) => t.id === id)?.tier === "long-horizon");
		const report = analyzeProxyToTargetCorrelation(scorecards, { proxyTaskIds, targetTaskIds, excludeFaulted });
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

	if (command === "ledger") {
		const sub = rest[0] ?? "status";
		const ledgerPath = resolve(parseFlag(rest, "--ledger") ?? join(REPO_ROOT, ".one_piece", "eval-lab", "ledger.sqlite"));
		const ledger = new EvalLedger(ledgerPath);
		try {
			if (sub === "backfill") {
				const rootDir = resolve(parseFlag(rest, "--root") ?? join(REPO_ROOT, ".one_piece", "eval-lab"));
				const res = ledger.backfillDirectory(rootDir, { repoRoot: REPO_ROOT });
				console.log(
					`Backfilled ${res.totalRunsIngested} run(s) across ${res.campaigns.length}/${res.campaignsScanned} campaign(s) into ${res.generationsCount} generation(s) -> ${ledgerPath}`,
				);
				if (rest.includes("--index")) {
					const decisionClient = rest.includes("--no-jev")
						? undefined
						: createDecisionClientFromEnv({ provider: "auto", cwd: REPO_ROOT });
					const idxRes = await indexLedgerTraces({
						ledger,
						decisionClient,
						repoRoot: REPO_ROOT,
						skipJev: rest.includes("--no-jev"),
						log: (line) => console.log(line),
					});
					console.log(
						`Indexed ${idxRes.runsIndexed}/${idxRes.runsScanned} run(s): +${idxRes.deterministicRowsWritten} det, +${idxRes.system1RowsWritten} sys1 (${idxRes.jevRequestsSent} Jev calls, ${idxRes.jevInputTokens} in-tok)`,
					);
				}
			} else if (sub === "ingest") {
				const dir = parseFlag(rest, "--dir");
				if (!dir) throw new Error("ledger ingest requires --dir <campaignDir>");
				const res = ledger.ingestCampaignDir(dir, {
					genId: parseFlag(rest, "--gen"),
					label: parseFlag(rest, "--label"),
					repoRoot: REPO_ROOT,
				});
				console.log(`Ingested ${res.runsIngested} run(s) from ${res.campaignDir} as ${res.genId} (${res.label}) -> ${ledgerPath}`);
				if (rest.includes("--index")) {
					const decisionClient = rest.includes("--no-jev")
						? undefined
						: createDecisionClientFromEnv({ provider: "auto", cwd: REPO_ROOT });
					const idxRes = await indexLedgerTraces({
						ledger,
						decisionClient,
						repoRoot: REPO_ROOT,
						genId: res.genId,
						skipJev: rest.includes("--no-jev"),
						log: (line) => console.log(line),
					});
					console.log(
						`Indexed ${idxRes.runsIndexed}/${idxRes.runsScanned} run(s) for ${res.genId}: +${idxRes.deterministicRowsWritten} det, +${idxRes.system1RowsWritten} sys1 (${idxRes.jevRequestsSent} Jev calls)`,
					);
				}
			} else if (sub === "status") {
				const gens = ledger.listGenerations();
				const runs = ledger.listRuns();
				const scores = ledger.listTraceScores();
				const audits = ledger.listTraceAudits();
				console.log(
					`Eval Ledger: ${ledgerPath} (${gens.length} generations, ${runs.length} runs, ${scores.length} trace_scores, ${audits.length} audits)`,
				);
				for (const g of gens) {
					const gRuns = runs.filter((r) => r.genId === g.genId);
					const pass = gRuns.filter((r) => r.deliveredPass).length;
					console.log(`  ${g.genId.padEnd(14)} ${g.label.padEnd(28)} runs=${String(gRuns.length).padStart(3)} pass=${pass}/${gRuns.length} created=${g.createdAt.slice(0, 19)}`);
				}
			} else {
				throw new Error(`Unknown ledger subcommand "${sub}". Use backfill, ingest, or status.`);
			}
		} finally {
			ledger.close();
		}
		return;
	}

	if (command === "index") {
		const ledgerPath = resolve(parseFlag(rest, "--ledger") ?? join(REPO_ROOT, ".one_piece", "eval-lab", "ledger.sqlite"));
		const genId = parseFlag(rest, "--gen");
		const taskId = parseFlag(rest, "--task");
		const onlySuboptimal = rest.includes("--only-suboptimal");
		const skipJev = rest.includes("--no-jev");
		const limitRaw = parseFlag(rest, "--limit");
		const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
		const concurrencyRaw = parseFlag(rest, "--concurrency");
		const concurrency = concurrencyRaw !== undefined ? Number(concurrencyRaw) : 4;
		const probesArg = parseFlag(rest, "--probes");
		const probes = probesArg
			? SYSTEM1_PROBE_CATALOG.filter((p) =>
					probesArg
						.split(",")
						.map((s) => s.trim())
						.includes(p.judgeName),
				)
			: SYSTEM1_PROBE_CATALOG;
		if (probesArg && probes.length === 0) {
			throw new Error(`No matching probes for --probes ${probesArg}. Available: ${SYSTEM1_PROBE_CATALOG.map((p) => p.judgeName).join(", ")}`);
		}
		const decisionClient = skipJev ? undefined : createDecisionClientFromEnv({ provider: "auto", cwd: REPO_ROOT });
		if (!skipJev && !decisionClient) {
			console.log("Note: No TYPESAFE_API_KEY / JEV_API_KEY found in env or .env — running Layer 1 deterministic indexing only (pass --no-jev to silence).");
		}
		const ledger = new EvalLedger(ledgerPath);
		try {
			const res = await indexLedgerTraces({
				ledger,
				decisionClient,
				repoRoot: REPO_ROOT,
				genId,
				taskId,
				onlySuboptimal,
				limit,
				probes,
				concurrency,
				skipJev,
				log: (line) => console.log(line),
			});
			console.log(
				`\nTrace Indexing Complete: scanned=${res.runsScanned} indexed=${res.runsIndexed} missingTrace=${res.skippedMissingTrace} ` +
					`detRows=+${res.deterministicRowsWritten} sys1Rows=+${res.system1RowsWritten} jevCalls=${res.jevRequestsSent} jevInTok=${res.jevInputTokens}`,
			);
			if (res.errors.length) {
				console.error(`Errors (${res.errors.length}):`);
				for (const err of res.errors.slice(0, 10)) console.error(`  - ${err}`);
			}
		} finally {
			ledger.close();
		}
		return;
	}

	if (command === "diagnose") {
		const ledgerPath = resolve(parseFlag(rest, "--ledger") ?? join(REPO_ROOT, ".one_piece", "eval-lab", "ledger.sqlite"));
		const genId = parseFlag(rest, "--gen");
		const compareGenId = parseFlag(rest, "--compare-gen");
		const taskId = parseFlag(rest, "--task");
		const judgeName = parseFlag(rest, "--judge");
		const judgeVersion = parseFlag(rest, "--version");
		const minProbRaw = parseFlag(rest, "--min-prob");
		const minProb = minProbRaw !== undefined ? Number(minProbRaw) : undefined;
		const showEvidence = rest.includes("--show-evidence");
		const doEscalate = rest.includes("--escalate");
		const driversArg = parseFlag(rest, "--drivers") ?? "codex";
		const maxEscalate = Number(parseFlag(rest, "--max-escalate") ?? 5);

		const ledger = new EvalLedger(ledgerPath);
		try {
			if (doEscalate) {
				const router = createCliV2Router(driversArg.split(","));
				const escalated = await escalateUnexplainedFailures({
					ledger,
					router,
					genId,
					taskId,
					maxEscalate,
					repoRoot: REPO_ROOT,
					log: (line) => console.log(line),
				});
				console.log(`\nTier-2 Escalation completed: ${escalated.length} run(s) diagnosed.`);
				for (const f of escalated) {
					if (f.isNovelPattern && f.suggestedAtomicProbe) {
						console.log(`  [NEW PROBE CANDIDATE] ${f.rootCauseTag}: "${f.suggestedAtomicProbe}"`);
					}
				}
			}

			const report = analyzeFailureBuckets(ledger, {
				genId,
				taskId,
				judgeName,
				judgeVersion,
				minProb,
				repoRoot: REPO_ROOT,
			});
			const gens = ledger.listGenerations();
			const targetGen = genId ?? gens.at(-1)?.genId;
			const deltas =
				compareGenId && targetGen
					? compareBucketsAcrossGenerations(ledger, compareGenId, targetGen, { taskId, minProb })
					: undefined;
			console.log(renderFailureBucketsMarkdown(report, { showEvidence, deltas }));
		} finally {
			ledger.close();
		}
		return;
	}

	if (command === "audit-judges") {
		const ledgerPath = resolve(parseFlag(rest, "--ledger") ?? join(REPO_ROOT, ".one_piece", "eval-lab", "ledger.sqlite"));
		const sampleSize = Number(parseFlag(rest, "--sample") ?? 20);
		const judgeName = parseFlag(rest, "--judge");
		const judgeVersion = parseFlag(rest, "--version");
		const auditorMode = (parseFlag(rest, "--auditor") ?? "print") as "frontier" | "print";
		const driversArg = parseFlag(rest, "--drivers") ?? "codex";
		const importPath = parseFlag(rest, "--import");
		const outPath = parseFlag(rest, "--out");

		const ledger = new EvalLedger(ledgerPath);
		try {
			if (importPath) {
				const raw = JSON.parse(readFileSync(resolve(importPath), "utf8")) as Array<Partial<TraceAuditRecord> & { scoreId: string; groundTruth: "flagged" | "clean" }>;
				let imported = 0;
				for (const row of raw) {
					if (!row.scoreId || (row.groundTruth !== "flagged" && row.groundTruth !== "clean")) continue;
					ledger.recordTraceAudit({
						auditId: row.auditId ?? `aud_imp_${imported}_${Date.now()}`,
						scoreId: row.scoreId,
						auditor: row.auditor ?? "human",
						groundTruth: row.groundTruth,
						notes: row.notes,
						auditedAt: row.auditedAt ?? new Date().toISOString(),
					});
					imported += 1;
				}
				console.log(`Imported ${imported} calibration audit verdict(s) into ${ledgerPath}`);
			} else {
				const queue = sampleAuditQueue(ledger, { sampleSize, judgeName, judgeVersion });
				if (!queue.length) {
					console.log("No unaudited System-1 trace_scores available to sample.");
				} else if (auditorMode === "frontier") {
					const router = createCliV2Router(driversArg.split(","));
					const recorded = await runFrontierAudit({
						ledger,
						router,
						items: queue,
						log: (line) => console.log(line),
					});
					console.log(`Recorded ${recorded.length} frontier calibration audit(s).`);
				} else {
					const pack = queue.map((q) => ({
						scoreId: q.score.scoreId,
						stratum: q.stratum,
						judgeName: q.score.judgeName,
						judgeVersion: q.score.judgeVersion,
						system1Label: q.score.label,
						system1Prob: q.score.prob,
						runId: q.run.runId,
						taskId: q.run.taskId,
						deliveredPass: q.run.deliveredPass,
						seqStart: q.score.seqStart,
						seqEnd: q.score.seqEnd,
						rawExcerpt: q.rawExcerpt,
						groundTruth: "",
						notes: "",
					}));
					const payload = JSON.stringify(pack, null, 2) + "\n";
					if (outPath) {
						writeFileSync(resolve(outPath), payload, "utf8");
						console.log(`Exported ${pack.length} stratified audit sample(s) -> ${resolve(outPath)}`);
					} else {
						console.log(payload);
					}
				}
			}

			const cal = computeJudgeCalibration(ledger, { judgeName, judgeVersion });
			if (cal.length) {
				console.log("\nJudge Calibration Summary:");
				for (const c of cal) {
					console.log(
						`  ${c.judgeName} (${c.judgeVersion}): n=${c.auditedCount} P=${(c.precision * 100).toFixed(1)}% R=${(c.recall * 100).toFixed(1)}% F1=${(c.f1 * 100).toFixed(1)}% FNR=${(c.falseNegativeRate * 100).toFixed(1)}%${c.warning ? `  ⚠ ${c.warning}` : ""}`,
					);
				}
			}
		} finally {
			ledger.close();
		}
		return;
	}

	if (command === "observatory") {
		const ledgerPath = resolve(parseFlag(rest, "--ledger") ?? join(REPO_ROOT, ".one_piece", "eval-lab", "ledger.sqlite"));
		const backfillRoot = parseFlag(rest, "--backfill-root");
		const outDir = resolve(parseFlag(rest, "--out") ?? join(REPO_ROOT, ".one_piece", "eval-lab", "observatory"));
		const ledger = new EvalLedger(ledgerPath);
		try {
			if (backfillRoot || ledger.listRuns().length === 0) {
				const rootDir = resolve(backfillRoot ?? join(REPO_ROOT, ".one_piece", "eval-lab"));
				const bf = ledger.backfillDirectory(rootDir, { repoRoot: REPO_ROOT });
				console.log(`Synced ${bf.totalRunsIngested} run(s) across ${bf.generationsCount} generation(s) from ${rootDir}`);
			}
			const report = analyzeTrajectory(ledger);
			const artifacts = generateObservatory(report, outDir);
			console.log(renderTrajectoryMarkdown(report));
			console.log(`Observatory HTML -> ${artifacts.htmlPath}`);
			console.log(`Standalone SVGs  -> ${join(artifacts.outDir, "charts")}`);
		} finally {
			ledger.close();
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
