import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	CandidateSnapshot,
	HarnessAdapter,
	HarnessRunReceipt,
	HarnessRunSpec,
} from "../contracts.ts";
import { openEvalTraceDb } from "../event-reader.ts";
import { sha256Dir } from "../sandbox.ts";

export type MockMode =
	| "reference"
	| "starter"
	| "pass_without_nominating"
	| "silent_patch_noop"
	| "stale_verdict"
	| "duplicate_job"
	| "mid_run_crash"
	| "fork_responsive";

export interface MockAdapterOptions {
	mode: MockMode;
	/** Optional directory containing a passing reference artifact to copy into nominated/candidate output. */
	referenceDir?: string;
	/** Optional predicate deciding whether a given run spec succeeds (useful in sweep tests). */
	shouldSolve?: (spec: HarnessRunSpec) => boolean;
	/** Token count per simulated agent turn (default 1200). */
	tokensPerTurn?: number;
}

/**
 * Deterministic zero-cost HarnessAdapter that writes genuine v2-schema SQLite WAL events.
 * Powers calibration checks, statistical runner tests, counterfactual fork tests, and CI.
 */
export function createMockAdapter(options: MockAdapterOptions): HarnessAdapter {
	const tokensPerTurn = options.tokensPerTurn ?? 1200;

	return {
		name: `mock:${options.mode}`,
		async run(spec: HarnessRunSpec): Promise<HarnessRunReceipt> {
			mkdirSync(spec.runDir, { recursive: true });
			const db = openEvalTraceDb(spec.dbPath);
			const insertEvent = db.prepare(
				"INSERT INTO events (ts, run_id, type, node_id, causal_parents, idempotency_key, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
			);
			const upsertDoc = db.prepare(
				"INSERT INTO docs (collection, id, run_id, data, updated_at) VALUES (?, ?, ?, ?, ?) " +
					"ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
			);

			const t0 = Date.now();
			let clock = t0;
			const emit = (type: string, data: Record<string, unknown>, agentId?: string) => {
				clock += 15;
				insertEvent.run(clock, spec.runId, type, agentId ?? null, null, null, JSON.stringify(data));
			};

			try {
				emit("run.started", { taskId: spec.taskId, controlRung: spec.controlRung, swarmSize: spec.swarmSize });

				const n = Math.max(1, spec.swarmSize);
				const spentByAgent = new Map<string, number>();

				for (let i = 0; i < n; i++) {
					const agentId = `worker-${i}`;
					emit("agent.spawned", { role: "leaf", seat: i }, agentId);
					emit("agent.status", { status: "running" }, agentId);
				}

				const chargeCall = (agentId: string, role: string, totalTokens: number, toolName: string, extra?: Record<string, unknown>) => {
					const input = Math.round(totalTokens * 0.75);
					const output = totalTokens - input;
					const cacheReadTokens = Math.round(input * 0.4);
					emit(
						"model.call",
						{
							provider: "sim",
							model: "sim-v2",
							driver: "mock",
							role,
							input: input - cacheReadTokens,
							cacheReadTokens,
							cacheWriteTokens: 0,
							output,
							totalTokens,
							usd: totalTokens * 0.000002,
							durationMs: 45,
							waitedMs: 5,
							stopReason: "stop",
						},
						agentId,
					);
					spentByAgent.set(agentId, (spentByAgent.get(agentId) ?? 0) + totalTokens);
					emit("tool.call", { tool: toolName, args: extra?.args ?? {} }, agentId);
					emit(
						"tool.result",
						{
							tool: toolName,
							isError: Boolean(extra?.isError),
							durationMs: Number(extra?.toolDurationMs ?? 20),
							cpuSeconds: Number(extra?.cpuSeconds ?? 0.02),
							text: String(extra?.text ?? "ok"),
						},
						agentId,
					);
				};

				// Simulate work + coordination across agents
				for (let i = 0; i < n; i++) {
					const agentId = `worker-${i}`;
					chargeCall(agentId, "leaf", tokensPerTurn, "read_file", { cpuSeconds: 0.01 });
					if (spec.controlRung === "swarm" && n > 1) {
						chargeCall(agentId, "leaf", Math.round(tokensPerTurn * 0.5), "post_board", {
							args: { title: `seat-${i} update`, body: `progress from worker-${i}` },
						});
					}
					if (options.mode === "silent_patch_noop" && i === 0) {
						chargeCall(agentId, "leaf", tokensPerTurn, "bash", {
							isError: false,
							text: "bash: apply_patch: command not found\nSimulation exited 0.",
						});
					} else {
						chargeCall(agentId, "leaf", tokensPerTurn, "apply_workspace_change", { cpuSeconds: 0.03 });
					}
				}

				// Optional duplicate job callback fault
				if (options.mode === "duplicate_job") {
					emit("job.finished", { jobId: "job-dup-1", status: "succeeded", durationMs: 120, cpuSeconds: 0.5, charged: true }, "worker-0");
					emit("job.finished", { jobId: "job-dup-1", status: "succeeded", durationMs: 120, cpuSeconds: 0.5, charged: true }, "worker-0");
				}

				// Optional stale verdict fault
				if (options.mode === "stale_verdict") {
					emit("finding.reported", { findingId: "find-1", revision: 1, claim: "draft v1", level: "empirical" }, "worker-0");
					emit("finding.reported", { findingId: "find-1", revision: 2, claim: "draft v2", level: "empirical" }, "worker-0");
					emit("finding.verdict", { findingId: "find-1", revision: 1, appliedToRevision: 2, verdict: "accepted", confidence: 0.9 }, "rev-0");
				}

				const totalTokensSoFar = [...spentByAgent.values()].reduce((s, v) => s + v, 0);

				// Decide whether the candidate artifact solves the task
				const isTreatment = Boolean(spec.injectedPrompt?.includes("[TREATMENT]"));
				const solved =
					options.shouldSolve !== undefined
						? options.shouldSolve(spec)
						: options.mode === "reference" ||
							options.mode === "pass_without_nominating" ||
							(options.mode === "fork_responsive" && isTreatment);

				const candidateDir = join(spec.runDir, "candidates", "cand-1");
				mkdirSync(candidateDir, { recursive: true });
				if (solved && options.referenceDir && existsSync(options.referenceDir)) {
					cpSync(options.referenceDir, candidateDir, { recursive: true });
				} else {
					cpSync(spec.workspaceDir, candidateDir, { recursive: true });
				}
				const candidateSha = sha256Dir(candidateDir);

				// Extra post-optimum turn when solved, to verify stopping-waste telemetry
				if (solved) {
					chargeCall("worker-0", "leaf", Math.round(tokensPerTurn * 0.25), "read_file", { text: "double check" });
				}

				const snapshots: CandidateSnapshot[] = [
					{
						id: "cand-1",
						agentId: "worker-0",
						dir: candidateDir,
						sha256: candidateSha,
						atTokens: totalTokensSoFar,
						atWallMs: clock - t0,
						acceptedByVerifier: solved,
						revision: 1,
						findingId: "find-1",
					},
				];

				// Persist agent docs with honest spend totals for conservation checks
				for (const [agentId, spentTokens] of spentByAgent) {
					const status = options.mode === "mid_run_crash" && agentId === "worker-0" ? "running" : "done";
					emit("agent.status", { status }, agentId);
					upsertDoc.run(
						"agents",
						agentId,
						spec.runId,
						JSON.stringify({
							id: agentId,
							runId: spec.runId,
							role: "leaf",
							driver: "mock",
							model: { provider: "sim", id: "sim-v2" },
							status,
							spent: { tokens: spentTokens },
						}),
						clock,
					);
				}

				if (options.mode !== "mid_run_crash") {
					emit("run.finished", { status: "done", reason: "mock completed" });
				}

				const explicitlyNominated = options.mode !== "pass_without_nominating" && options.mode !== "mid_run_crash" && options.mode !== "silent_patch_noop";
				const autoNominated = !explicitlyNominated && spec.autoNominate && options.mode !== "mid_run_crash";
				const nominatedDir = explicitlyNominated || autoNominated ? candidateDir : undefined;

				return {
					runId: spec.runId,
					status: options.mode === "mid_run_crash" ? "failed" : "done",
					nominatedArtifactDir: nominatedDir,
					nominatedSha256: nominatedDir ? candidateSha : undefined,
					nominatedAtTokens: nominatedDir ? totalTokensSoFar : undefined,
					nominatedAtWallMs: nominatedDir ? clock - t0 : undefined,
					autoNominated,
					candidateSnapshots: snapshots,
					harnessFaults: [],
					driverIds: ["mock"],
					modelIds: ["sim/sim-v2"],
				};
			} finally {
				db.close();
			}
		},
	};
}
