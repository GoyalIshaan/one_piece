import { appendFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	BudgetMode,
	CandidateSnapshot,
	ControlRung,
	EvalTask,
	HarnessAdapter,
	HarnessRunReceipt,
	HarnessRunSpec,
	PromotionBar,
	RunBudget,
	Scorecard,
} from "./contracts.ts";
import { openEvalTraceDb, readRunEvents } from "./event-reader.ts";
import { gitReproducibility, sha256Dir } from "./sandbox.ts";
import { extractScorecard } from "./scorecard.ts";
import { computeCoordinationLift, evaluatePromotionBar, pairedComparison } from "./stats.ts";

export interface ArmSpec {
	id: string;
	controlRung: ControlRung;
	topology?: string;
	swarmSize: number;
	/** Optional task seat count override (used so solo faces the same N-shard task as N-peer swarms). */
	taskN?: number;
	autoNominate?: boolean;
}

export interface CampaignOptions {
	task: EvalTask;
	adapter: HarnessAdapter;
	arms: readonly ArmSpec[];
	seeds: readonly number[];
	budget: RunBudget;
	budgetMode?: BudgetMode;
	taskOptions?: Record<string, string>;
	outDir: string;
	repoRoot: string;
	promotionBar?: PromotionBar;
	baselineArmId?: string;
	candidateArmId?: string;
	log?: (line: string) => void;
}

export interface CampaignResult {
	outDir: string;
	scorecards: Scorecard[];
	summaryPath: string;
	reportPath: string;
}

function splitBudget(total: RunBudget, count: number): RunBudget {
	return {
		tokens: total.tokens !== undefined ? Math.max(1, Math.floor(total.tokens / count)) : undefined,
		usd: total.usd !== undefined ? total.usd / count : undefined,
		wallClockMs: total.wallClockMs,
		cpuSeconds: total.cpuSeconds !== undefined ? total.cpuSeconds / count : undefined,
	};
}

/**
 * Execute `silent_bon`: N completely isolated single-agent runs each receiving `1/N` of the
 * aggregate token/compute budget, with zero shared board or messaging, followed by a
 * deterministic selector over their nominated artifacts.
 */
async function runSilentBestOfN(
	adapter: HarnessAdapter,
	spec: HarnessRunSpec,
	task: EvalTask,
	options: Record<string, string>,
): Promise<HarnessRunReceipt> {
	const n = Math.max(1, spec.swarmSize);
	const perWorkerBudget = splitBudget(spec.budget, n);
	const mergedDb = openEvalTraceDb(spec.dbPath);
	const insertEvent = mergedDb.prepare(
		"INSERT INTO events (ts, run_id, type, node_id, causal_parents, idempotency_key, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const began = Date.now();
	insertEvent.run(began, spec.runId, "run.started", null, null, null, JSON.stringify({ controlRung: "silent_bon", n }));

	const subReceipts: HarnessRunReceipt[] = [];
	const allSnapshots: CandidateSnapshot[] = [];
	const faults: HarnessRunReceipt["harnessFaults"][number][] = [];
	const driverSet = new Set<string>();
	const modelSet = new Set<string>();
	let cumulativeTokens = 0;

	try {
		const runOneSeat = async (i: number): Promise<{ idx: number; subDir: string; subDbPath: string; subRunId: string; receipt: HarnessRunReceipt }> => {
			const subDir = join(spec.runDir, `silent-seat-${i}`);
			const subWorkspace = join(subDir, "workspace");
			mkdirSync(subDir, { recursive: true });
			cpSync(spec.workspaceDir, subWorkspace, { recursive: true });
			const subDbPath = join(subDir, "trace.db");
			const subRunId = `${spec.runId}-seat-${i}`;

			const otherShards = (spec.privateShards ?? []).filter((_, idx) => idx !== i);
			const subReceipt = await adapter.run({
				...spec,
				runId: subRunId,
				runDir: subDir,
				dbPath: subDbPath,
				workspaceDir: subWorkspace,
				privateShards: spec.privateShards?.[i] ? [spec.privateShards[i]!] : undefined,
				seatPrompts: undefined,
				soloSeatPrompts: spec.soloSeatPrompts?.[i] ? [spec.soloSeatPrompts[i]!] : undefined,
				seatIndex: i,
				totalSeats: spec.totalSeats ?? spec.privateShards?.length ?? n,
				hiddenDenyPaths: [...spec.hiddenDenyPaths, ...otherShards],
				controlRung: "solo",
				topology: "silent_bon_member",
				swarmSize: 1,
				budget: perWorkerBudget,
			});
			return { idx: i, subDir, subDbPath, subRunId, receipt: subReceipt };
		};

		const seatResults =
			spec.budgetMode === "wall_clock"
				? await Promise.all(Array.from({ length: n }, (_, i) => runOneSeat(i)))
				: await (async () => {
					const out: Array<Awaited<ReturnType<typeof runOneSeat>>> = [];
					for (let i = 0; i < n; i++) out.push(await runOneSeat(i));
					return out;
				})();

		for (const { idx: i, subDbPath, subRunId, receipt: subReceipt } of seatResults) {
			subReceipts.push(subReceipt);
			faults.push(...subReceipt.harnessFaults);
			for (const d of subReceipt.driverIds ?? []) driverSet.add(d);
			for (const m of subReceipt.modelIds ?? []) modelSet.add(m);

			const { events } = readRunEvents(subDbPath, subRunId);
			let seatTokens = 0;
			for (const ev of events) {
				if (ev.type === "run.started" || ev.type === "run.finished") continue;
				if (ev.type === "model.call") seatTokens += Number(ev.data.totalTokens ?? 0);
				else if (ev.type === "budget.charged") seatTokens += Number(ev.data.tokens ?? 0);
				insertEvent.run(
					ev.ts,
					spec.runId,
					ev.type,
					ev.agentId ? `seat${i}:${ev.agentId}` : `seat${i}`,
					ev.causalParents ? JSON.stringify(ev.causalParents) : null,
					null,
					JSON.stringify(ev.data),
				);
			}
			for (const snap of subReceipt.candidateSnapshots) {
				allSnapshots.push({
					...snap,
					id: `seat${i}-${snap.id}`,
					agentId: `seat${i}:${snap.agentId}`,
					atTokens: cumulativeTokens + snap.atTokens,
					atWallMs: Math.max(0, Date.now() - began),
				});
			}
			cumulativeTokens += seatTokens;
		}

		// Fair public-only selector: NEVER peeks at hidden `task.grade()`!
		// Uses `task.publicCheck()` when available, breaking ties deterministically by first valid submission.
		const higher = task.higherIsBetter ?? true;
		let chosen: { dir: string; sha256: string; score: number; passed: boolean } | undefined;
		for (const sub of subReceipts) {
			if (!sub.nominatedArtifactDir || !existsSync(sub.nominatedArtifactDir)) continue;
			const pub = task.publicCheck
				? await task.publicCheck({
						artifactDir: sub.nominatedArtifactDir,
						seed: spec.seed,
						n: spec.totalSeats ?? spec.privateShards?.length ?? n,
						options,
					})
				: {
						passed: sub.candidateSnapshots.some((c) => c.sha256 === sub.nominatedSha256 && c.acceptedByVerifier),
						score: 0,
						details: "no publicCheck defined; deterministic first-valid selection",
					};
			if (
				!chosen ||
				(pub.passed && !chosen.passed) ||
				(pub.passed === chosen.passed && (higher ? pub.score > chosen.score : pub.score < chosen.score))
			) {
				chosen = {
					dir: sub.nominatedArtifactDir,
					sha256: sub.nominatedSha256,
					score: pub.score,
					passed: pub.passed,
				};
			}
		}

		insertEvent.run(Date.now(), spec.runId, "run.finished", null, null, null, JSON.stringify({ status: "done" }));
		const nomination = chosen
			? {
				nominatedArtifactDir: chosen.dir,
				nominatedSha256: chosen.sha256,
				nominatedAtTokens: cumulativeTokens,
				nominatedAtWallMs: Date.now() - began,
				autoNominated: true as const,
			}
			: { autoNominated: false as const };
		return {
			runId: spec.runId,
			status: "done",
			...nomination,
			candidateSnapshots: allSnapshots,
			harnessFaults: faults,
			driverIds: [...driverSet],
			modelIds: [...modelSet],
		};
	} finally {
		mergedDb.close();
	}
}

export function renderCampaignReport(
	task: EvalTask,
	arms: readonly ArmSpec[],
	scorecards: readonly Scorecard[],
	summary: Record<string, unknown>,
): string {
	const lines: string[] = [
		`# Eval-Lab Report: ${task.id} (${task.title})`,
		"",
		`Family: \`${task.family}\` · Runs: ${scorecards.length}`,
		"",
		"| Arm | Rung | N | Delivered Pass | Mean Delivered Score | Mean Best Offline | Mean Nomination Loss | Mean Tokens | Coord Share | Mean Wall (ms) | Faults |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	for (const arm of arms) {
		const rows = scorecards.filter(
			(s) =>
				s.runId.endsWith(`-${arm.id}`) ||
				(s.reproducibility.topology === (arm.topology ?? arm.controlRung) &&
					s.dynamics.swarmSize === arm.swarmSize &&
					s.reproducibility.controlRung === arm.controlRung),
		);
		if (!rows.length) continue;
		const avg = (fn: (s: Scorecard) => number) => rows.reduce((acc, r) => acc + fn(r), 0) / rows.length;
		const passCount = rows.filter((r) => r.deliveredPass).length;
		const faultCount = rows.filter((r) => r.hasHarnessFault).length;
		lines.push(
			`| ${arm.id} | ${arm.controlRung} | ${arm.swarmSize} | ${passCount}/${rows.length} | ${avg((r) => r.deliveredScore).toFixed(3)} | ${avg((r) => r.bestOfflineScore).toFixed(3)} | ${avg((r) => r.losses.nominationLoss).toFixed(3)} | ${Math.round(avg((r) => r.tokens.total)).toLocaleString()} | ${(avg((r) => r.tokens.coordinationTokenShare) * 100).toFixed(1)}% | ${Math.round(avg((r) => r.time.wallClockMs)).toLocaleString()} | ${faultCount} |`,
		);
	}
	lines.push("", "## Summary JSON", "", "```json", JSON.stringify(summary, null, 2), "```", "");
	return lines.join("\n");
}

/**
 * Execute a frozen, paired, interleaved multi-seed benchmark campaign.
 * Locks `protocol.json` before running, interleaves arm order on odd/even seeds,
 * and saves per-run scorecards + statistical summary + Markdown report.
 */
export async function runCampaign(options: CampaignOptions): Promise<CampaignResult> {
	const { task, adapter, arms, seeds, budget, outDir, repoRoot } = options;
	const budgetMode: BudgetMode = options.budgetMode ?? "tokens";
	const taskOptions = { ...task.defaultOptions, ...options.taskOptions };
	const log = options.log ?? (() => {});

	mkdirSync(join(outDir, "scorecards"), { recursive: true });
	const git = gitReproducibility(repoRoot);
	const protocol = {
		schemaVersion: 1,
		createdAt: new Date().toISOString(),
		taskId: task.id,
		family: task.family,
		adapter: adapter.name,
		arms,
		seeds,
		budget,
		budgetMode,
		taskOptions,
		promotionBar: options.promotionBar ?? null,
		git,
	};
	writeFileSync(join(outDir, "protocol.json"), JSON.stringify(protocol, null, 2) + "\n");

	const scorecards: Scorecard[] = [];
	const byArmId = new Map<string, Scorecard[]>();
	for (const arm of arms) byArmId.set(arm.id, []);

	for (const seed of seeds) {
		// Interleave arm order across odd/even seeds to cancel provider latency/cache drift.
		const orderedArms = seed % 2 === 1 ? [...arms].reverse() : [...arms];
		for (let orderIdx = 0; orderIdx < orderedArms.length; orderIdx++) {
			const arm = orderedArms[orderIdx]!;
			const runId = `${task.id}-s${seed}-${arm.id}`;
			const cellDir = join(outDir, "runs", runId);
			const workDir = join(cellDir, "workspace");
			const hiddenDir = join(cellDir, "hidden");
			const runDir = join(cellDir, "run");
			mkdirSync(workDir, { recursive: true });
			mkdirSync(hiddenDir, { recursive: true });
			mkdirSync(runDir, { recursive: true });

			const defaultTaskN =
				task.family === "info-routing"
					? Math.max(...arms.map((a) => a.taskN ?? a.swarmSize), 2)
					: arm.swarmSize;
			const taskN = arm.taskN ?? defaultTaskN;
			const prepared = await task.prepare({
				seed,
				n: taskN,
				options: taskOptions,
				workDir,
				hiddenDir,
			});

			const dbPath = join(runDir, "trace.db");
			const spec: HarnessRunSpec = {
				runId,
				runDir,
				dbPath,
				taskId: task.id,
				seed,
				goal: prepared.goal,
				rubric: prepared.rubric,
				workspaceDir: prepared.workspaceDir,
				privateShards: prepared.privateShards,
				seatPrompts: prepared.seatPrompts,
				soloSeatPrompts: prepared.soloSeatPrompts,
				seatIndex: arm.controlRung === "solo" ? 0 : undefined,
				totalSeats: prepared.n,
				hiddenDenyPaths: [hiddenDir, dbPath, `${dbPath}-wal`, `${dbPath}-shm`],
				controlRung: arm.controlRung,
				topology: arm.topology ?? arm.controlRung,
				swarmSize: arm.swarmSize,
				budget,
				budgetMode,
				autoNominate: arm.autoNominate ?? true,
				sandboxProfile: prepared.sandboxProfile,
				taskOptions,
			};

			const receipt =
				arm.controlRung === "silent_bon"
					? await runSilentBestOfN(adapter, spec, task, taskOptions)
					: await adapter.run(spec);

			const scorecard = await extractScorecard({
				task,
				prepared,
				spec,
				receipt,
				adapterName: adapter.name,
				armOrderIndex: orderIdx,
				repoRoot,
			});

			scorecards.push(scorecard);
			byArmId.get(arm.id)!.push(scorecard);
			writeFileSync(join(outDir, "scorecards", `${runId}.json`), JSON.stringify(scorecard, null, 2) + "\n");
			appendFileSync(join(outDir, "results.jsonl"), JSON.stringify(scorecard) + "\n");
			log(
				`  [${runId}] pass=${scorecard.deliveredPass} score=${scorecard.deliveredScore.toFixed(3)} ` +
					`bestOffline=${scorecard.bestOfflineScore.toFixed(3)} nomLoss=${scorecard.losses.nominationLoss.toFixed(3)} ` +
					`tokens=${scorecard.tokens.total} faults=${scorecard.harnessFaults.length}`,
			);
		}
	}

	const soloArm = arms.find((a) => a.controlRung === "solo");
	const silentArm = arms.find((a) => a.controlRung === "silent_bon");
	const dagArm = arms.find((a) => a.controlRung === "scripted_dag");
	const swarmArm = arms.find((a) => a.id === options.candidateArmId) ?? arms.find((a) => a.controlRung === "swarm");
	const baselineArm = arms.find((a) => a.id === options.baselineArmId) ?? soloArm ?? arms[0];

	const primaryComparison =
		baselineArm && swarmArm && baselineArm.id !== swarmArm.id
			? pairedComparison(byArmId.get(baselineArm.id)!, byArmId.get(swarmArm.id)!, task.higherIsBetter ?? true)
			: undefined;

	const lift = swarmArm
		? computeCoordinationLift({
				swarmRows: byArmId.get(swarmArm.id)!,
				silentBonRows: silentArm ? byArmId.get(silentArm.id) : undefined,
				scriptedDagRows: dagArm ? byArmId.get(dagArm.id) : undefined,
				higherIsBetter: task.higherIsBetter ?? true,
			})
		: undefined;

	const promotion =
		primaryComparison && options.promotionBar
			? evaluatePromotionBar(primaryComparison, options.promotionBar)
			: undefined;

	const summary = {
		taskId: task.id,
		seeds: seeds.length,
		baselineArm: baselineArm?.id ?? null,
		candidateArm: swarmArm?.id ?? null,
		primaryComparison: primaryComparison ?? null,
		coordinationLift: lift ?? null,
		promotion: promotion ?? null,
	};

	const summaryPath = join(outDir, "summary.json");
	const reportPath = join(outDir, "report.md");
	writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
	writeFileSync(reportPath, renderCampaignReport(task, arms, scorecards, summary));

	return { outDir, scorecards, summaryPath, reportPath };
}
