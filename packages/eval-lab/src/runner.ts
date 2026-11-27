import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runTaskCalibration } from "./calibration.ts";
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
	SeatSpec,
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
	/** Skip the automatic zero-cost pre-campaign task calibration gate (default false). */
	skipCalibration?: boolean;
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

function cloneWorkspaceForSeat(srcWorkspace: string, dstWorkspace: string): void {
	if (existsSync(join(srcWorkspace, ".git"))) {
		try {
			execFileSync("git", ["clone", "--quiet", "--local", "--shared", srcWorkspace, dstWorkspace], {
				stdio: "ignore",
				timeout: 60_000,
			});
			// Mirror top-level gitignored symlinks (e.g. MLE-bench `data -> publicSrc`) & `.eval-exec` helper with 0 copy waste.
			for (const name of readdirSync(srcWorkspace)) {
				if (name === ".git" || name === ".swarm" || name === ".one_piece") continue;
				const src = join(srcWorkspace, name);
				const dst = join(dstWorkspace, name);
				if (existsSync(dst)) continue;
				const st = lstatSync(src);
				if (st.isSymbolicLink()) {
					symlinkSync(readlinkSync(src), dst);
				} else if (name === ".eval-exec" && st.isFile()) {
					copyFileSync(src, dst);
					try {
						chmodSync(dst, 0o755);
					} catch {
						// Ignore chmod errors.
					}
				}
			}
			return;
		} catch {
			// Fall through to recursive copy on non-standard git layouts.
		}
	}
	cpSync(srcWorkspace, dstWorkspace, { recursive: true });
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
			cloneWorkspaceForSeat(spec.workspaceDir, subWorkspace);
			const subDbPath = join(subDir, "trace.db");
			const subRunId = `${spec.runId}-seat-${i}`;

			// Pass full first-class `seats` (plus backward-compatible `privateShards`/`soloSeatPrompts`) with `seatIndex: i`
			// so `createV2Adapter` resolves per-seat prompts and immutable per-worker Seatbelt denies cleanly.
			const subReceipt = await adapter.run({
				...spec,
				runId: subRunId,
				runDir: subDir,
				dbPath: subDbPath,
				workspaceDir: subWorkspace,
				seats: spec.seats,
				privateShards: spec.privateShards,
				seatPrompts: undefined,
				soloSeatPrompts: spec.soloSeatPrompts,
				seatIndex: i,
				totalSeats: spec.totalSeats ?? spec.seats?.length ?? spec.privateShards?.length ?? n,
				hiddenDenyPaths: spec.hiddenDenyPaths,
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
		// On privately sharded tasks, each isolated seat i produces `submissions/seat_i.json` with zero
		// cross-seat communication; mechanically assemble those disjoint seat files just like swarm trunk
		// assembly so `silent_bon` is a fair, non-strawman no-communication baseline (all 4 seats present).
		const higher = task.higherIsBetter ?? true;
		let chosen: { dir: string; sha256: string; score: number; passed: boolean } | undefined;

		const resolvedSeats: readonly SeatSpec[] = spec.seats?.length
			? spec.seats
			: (spec.privateShards ?? []).map((dir, idx) => ({
				index: idx,
				handle: `seat-${idx}`,
				privateDir: dir,
				outputPath: join("submissions", `seat_${idx}.json`),
				prompt: spec.seatPrompts?.[idx] ?? "",
				soloPrompt: spec.soloSeatPrompts?.[idx] ?? "",
			}));

		if (resolvedSeats.length > 0) {
			const assembledDir = join(spec.runDir, "silent-assembled");
			mkdirSync(assembledDir, { recursive: true });
			cpSync(spec.workspaceDir, assembledDir, { recursive: true });

			// Locate the best artifact directory for each isolated seat (nominated dir first, then latest snapshot
			// containing that seat's declared `outputPath` since 1/N seats fail N/N publicCheck).
			const seatArtifactDirs: Array<string | undefined> = resolvedSeats.map((seat) => {
				const sub = subReceipts[seat.index];
				if (!sub) return undefined;
				const candidateDirs: string[] = [];
				if (sub.nominatedArtifactDir) candidateDirs.push(sub.nominatedArtifactDir);
				for (let k = sub.candidateSnapshots.length - 1; k >= 0; k--) {
					const snapDir = sub.candidateSnapshots[k]?.dir;
					if (snapDir) candidateDirs.push(snapDir);
				}
				return candidateDirs.find((d) => existsSync(join(d, seat.outputPath)));
			});

			let mergedSeats = 0;
			if (task.assembleSeats) {
				const assembled = await task.assembleSeats({
					baseWorkspaceDir: spec.workspaceDir,
					seats: resolvedSeats,
					seatArtifactDirs,
					outDir: assembledDir,
					seed: spec.seed,
					n: spec.totalSeats ?? resolvedSeats.length,
					options,
				});
				mergedSeats = assembled.assembledCount;
			} else {
				for (let i = 0; i < resolvedSeats.length; i++) {
					const seat = resolvedSeats[i]!;
					const srcDir = seatArtifactDirs[i];
					if (!srcDir) continue;
					const srcFile = join(srcDir, seat.outputPath);
					if (existsSync(srcFile)) {
						const dstFile = join(assembledDir, seat.outputPath);
						mkdirSync(dirname(dstFile), { recursive: true });
						cpSync(srcFile, dstFile);
						mergedSeats += 1;
					}
				}
			}

			if (mergedSeats > 0) {
				const assembledSha = sha256Dir(assembledDir);
				const pub = task.publicCheck
					? await task.publicCheck({
							artifactDir: assembledDir,
							seed: spec.seed,
							n: spec.totalSeats ?? resolvedSeats.length,
							options,
						})
					: { passed: mergedSeats === n, score: mergedSeats / n, details: `assembled ${mergedSeats}/${n} seats` };
				allSnapshots.push({
					id: "silent-assembled",
					agentId: "silent_bon:assembler",
					dir: assembledDir,
					sha256: assembledSha,
					atTokens: cumulativeTokens,
					atWallMs: Math.max(0, Date.now() - began),
					acceptedByVerifier: pub.passed,
				});
				if (pub.passed) {
					chosen = {
						dir: assembledDir,
						sha256: assembledSha,
						score: pub.score,
						passed: pub.passed,
					};
				}
			}
		}

		// For unsharded tasks (or fallback when no sharded seat files were produced), pick the best
		// individual seat artifact using `task.publicCheck()` only.
		if (!chosen) {
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
		"| Arm | Rung | N | Delivered Pass | Mean Score | Mean AULC | Mean Best Offline | Mean NomLoss | Mean Tokens | Coord Share | KV Hit | Mean Wall (ms) | Faults |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
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
			`| ${arm.id} | ${arm.controlRung} | ${arm.swarmSize} | ${passCount}/${rows.length} | ${avg((r) => r.deliveredScore).toFixed(3)} | ${avg((r) => r.anytime?.aulcTokens ?? 0).toFixed(3)} | ${avg((r) => r.bestOfflineScore).toFixed(3)} | ${avg((r) => r.losses.nominationLoss).toFixed(3)} | ${Math.round(avg((r) => r.tokens.total)).toLocaleString()} | ${(avg((r) => r.tokens.coordinationTokenShare) * 100).toFixed(1)}% | ${(avg((r) => r.tokens.cacheHitRate ?? 0) * 100).toFixed(1)}% | ${Math.round(avg((r) => r.time.wallClockMs)).toLocaleString()} | ${faultCount} |`,
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
	let calibrationReport: { passed: boolean; checksPassed: number; checksTotal: number } | null = null;
	if (!options.skipCalibration && !task.requiresDocker && task.buildReferenceArtifact) {
		const cal = await runTaskCalibration(task, {
			seed: seeds[0] ?? 7,
			repoRoot,
			taskOptions,
		});
		calibrationReport = {
			passed: cal.passed,
			checksPassed: cal.checks.filter((c) => c.passed).length,
			checksTotal: cal.checks.length,
		};
		if (!cal.passed) {
			const failed = cal.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.details}`).join("; ");
			throw new Error(`Pre-campaign calibration failed for task "${task.id}": ${failed}`);
		}
	}
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
		calibration: calibrationReport,
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
				seats: prepared.seats,
				privateShards: prepared.privateShards,
				seatPrompts: prepared.seatPrompts,
				soloSeatPrompts: prepared.soloSeatPrompts,
				seatIndex: arm.controlRung === "solo" ? 0 : undefined,
				totalSeats: prepared.n,
				hiddenDenyPaths: [...new Set([hiddenDir, dbPath, `${dbPath}-wal`, `${dbPath}-shm`, ...(prepared.extraDeniedReadPaths ?? [])])],
				allowDockerSocket: prepared.allowDockerSocket,
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
