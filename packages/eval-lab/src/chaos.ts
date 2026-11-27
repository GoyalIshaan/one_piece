import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FindingVerifier,
	type WorkerDriver,
	type WorkerSession,
	type WorkerSpawnSpec,
	type WorkerTurnResult,
} from "@one-piece/core";
import { DriverQuotaRouter } from "@one-piece/drivers";
import {
	IntegrationPipeline,
	recursivePlannersTopology,
	substratePeersTopology,
	SwarmOS,
} from "@one-piece/engine";
import { SqliteStore } from "@one-piece/store";
import { readRunEvents } from "./event-reader.ts";
import { runSandboxedEvalCommand, sha256Text } from "./sandbox.ts";

export type ChaosScenarioName =
	| "provider-crash-failover-and-token-conservation"
	| "rate-limit-storm-aimd-and-permanent-drain"
	| "semantic-regression-repair-and-monotonic-rollback"
	| "recursive-parking-deadlock-freedom"
	| "mcp-authority-and-redteam-isolation"
	| "kv-cache-prefix-stability";

export interface ChaosScenarioResult {
	readonly scenario: ChaosScenarioName;
	readonly passed: boolean;
	readonly durationMs: number;
	readonly invariantsChecked: readonly string[];
	readonly details: string;
}

export interface ChaosSuiteReport {
	readonly allPassed: boolean;
	readonly passedCount: number;
	readonly totalCount: number;
	readonly durationMs: number;
	readonly scenarios: readonly ChaosScenarioResult[];
}

function initGitRepo(prefix: string, files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), `eval-chaos-${prefix}-`));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "chaos@onepiece.dev"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "ChaosSuite"], { cwd: dir });
	for (const [rel, content] of Object.entries(files)) {
		const full = join(dir, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	return dir;
}

function makeScriptedDriver(opts: {
	id: string;
	supportsMcpHttp?: boolean;
	onTurn: (spec: WorkerSpawnSpec, prompt: string, turnIdx: number) => Promise<WorkerTurnResult>;
}): WorkerDriver {
	return {
		id: opts.id,
		kind: "pi-in-process",
		capabilities: {
			supportsSteer: true,
			supportsResume: true,
			supportsOutputSchema: true,
			supportsMcpHttp: opts.supportsMcpHttp ?? false,
		},
		async healthCheck() {
			return { ok: true, driverId: opts.id, kind: "pi-in-process" };
		},
		async spawn(spec: WorkerSpawnSpec): Promise<WorkerSession> {
			let turnIdx = 0;
			return {
				driverId: opts.id,
				async runTurn(prompt: string): Promise<WorkerTurnResult> {
					return opts.onTurn(spec, prompt, turnIdx++);
				},
				async close() {},
			};
		},
	};
}

async function runScenario(
	scenario: ChaosScenarioName,
	invariantsChecked: readonly string[],
	fn: () => Promise<{ passed: boolean; details: string }>,
): Promise<ChaosScenarioResult> {
	const began = Date.now();
	try {
		const res = await fn();
		return {
			scenario,
			passed: res.passed,
			durationMs: Date.now() - began,
			invariantsChecked,
			details: res.details,
		};
	} catch (error) {
		return {
			scenario,
			passed: false,
			durationMs: Date.now() - began,
			invariantsChecked,
			details: `Exception: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Scenario 1: Provider hard auth crash -> automatic cross-provider failover + strict SQLite token ledger conservation.
 */
async function scenarioCrashAndConservation(): Promise<{ passed: boolean; details: string }> {
	const repo = initGitRepo("crash", { "target.txt": "v0\n" });
	const runDir = mkdtempSync(join(tmpdir(), "eval-chaos-run-crash-"));
	const dbPath = join(runDir, "trace.db");
	const store = new SqliteStore(dbPath);
	let crashCalls = 0;
	let healthyCalls = 0;

	try {
		const crashingDriver = makeScriptedDriver({
			id: "drv-crash",
			async onTurn() {
				crashCalls++;
				return {
					status: "rate_limited",
					finalText: "",
					quotaError: {
						kind: "hard_auth_or_cap",
						reason: "HTTP 401 unauthorized: invalid_api_key",
						raw: "HTTP 401 unauthorized: invalid_api_key",
					},
					error: "HTTP 401 unauthorized: invalid_api_key",
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				};
			},
		});
		const healthyDriver = makeScriptedDriver({
			id: "drv-healthy",
			async onTurn(spec) {
				healthyCalls++;
				writeFileSync(join(spec.workspace, "target.txt"), "v1-recovered\n");
				execFileSync("git", ["add", "-A"], { cwd: spec.workspace });
				execFileSync("git", ["commit", "-q", "-m", "recover"], { cwd: spec.workspace });
				return {
					status: "completed",
					finalText: "Recovered cleanly after failover.",
					usage: { inputTokens: 210, outputTokens: 90, totalTokens: 300 },
				};
			},
		});

		const router = new DriverQuotaRouter({
			drivers: [
				{ driver: crashingDriver, config: { id: "drv-crash", kind: "pi-in-process", tier: "standard", maxConcurrent: 2 } },
				{ driver: healthyDriver, config: { id: "drv-healthy", kind: "pi-in-process", tier: "standard", maxConcurrent: 2 } },
			],
			roles: { default: ["drv-crash", "drv-healthy"], worker: ["drv-crash", "drv-healthy"] },
		});

		const os = await SwarmOS.create({
			runDir,
			workspace: repo,
			topology: "chaos-crash-probe",
			goal: { title: "Crash Failover", text: "Update target.txt safely despite provider crash." },
			budget: { tokens: 50_000 },
			enableFieldGuide: false,
			store,
			router,
		});
		try {
			const outcome = await os.execute({
				name: "chaos-crash-probe",
				description: "Force initial turn onto drv-crash and verify failover + token conservation",
				async run(api, { goal, signal }) {
					const w = await api.spawnWorker({
						role: "worker",
						handle: "w-crash",
						preferredDriverId: "drv-crash",
					});
					try {
						const turn = await w.runTurn(goal, { signal });
						return { status: turn.status === "completed" ? "done" : "failed", summary: turn.finalText };
					} finally {
						await w.close();
					}
				},
			});
			const { events, recordedLedgerTokens } = readRunEvents(dbPath, os.runId);
			const eventChargedTokens = events
				.filter((e) => e.type === "budget.charged")
				.reduce((sum, e) => sum + Number(e.data.tokens ?? 0), 0);
			const drained = events.some((e) => e.type === "quota.drained" && e.data.driverId === "drv-crash");
			const handoff = events.some((e) => e.type === "agent.handoff");
			const nonTerminalAgents = store
				.list("agents", { runId: os.runId })
				.filter((a) => a.status === "running" || a.status === "parked" || a.status === "pending");

			const conservationOk =
				recordedLedgerTokens !== undefined &&
				eventChargedTokens === recordedLedgerTokens &&
				eventChargedTokens === 300;
			const passed =
				outcome.status === "done" &&
				crashCalls >= 1 &&
				healthyCalls >= 1 &&
				drained &&
				handoff &&
				conservationOk &&
				nonTerminalAgents.length === 0;

			return {
				passed,
				details: `status=${outcome.status} crashCalls=${crashCalls} healthyCalls=${healthyCalls} drained=${drained} handoff=${handoff} tokens(events=${eventChargedTokens},ledger=${recordedLedgerTokens}) orphans=${nonTerminalAgents.length}`,
			};
		} finally {
			await os.dispose();
		}
	} finally {
		store.close();
		rmSync(repo, { recursive: true, force: true });
		rmSync(runDir, { recursive: true, force: true });
	}
}

/**
 * Scenario 2: Rate-limit storm triggers AIMD window halving, permanent drain cannot be resurrected.
 */
async function scenarioAimdAndDrain(): Promise<{ passed: boolean; details: string }> {
	const repo = initGitRepo("aimd", { "note.txt": "init\n" });
	const runDir = mkdtempSync(join(tmpdir(), "eval-chaos-run-aimd-"));
	const dbPath = join(runDir, "trace.db");
	const store = new SqliteStore(dbPath);

	try {
		const noopDriver = (id: string) =>
			makeScriptedDriver({
				id,
				async onTurn() {
					return { status: "completed", finalText: "ok", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
				},
			});

		const router = new DriverQuotaRouter({
			drivers: [
				{ driver: noopDriver("drv-a"), config: { id: "drv-a", kind: "pi-in-process", tier: "standard", maxConcurrent: 4, concurrencyMode: "physics" } },
				{ driver: noopDriver("drv-b"), config: { id: "drv-b", kind: "pi-in-process", tier: "standard", maxConcurrent: 2, concurrencyMode: "physics" } },
			],
			roles: { default: ["drv-a", "drv-b"], worker: ["drv-a", "drv-b"] },
			concurrencyMode: "physics",
			physics: {
				mode: "physics",
				scaleUpAfterSuccesses: 2,
				probe: () => ({
					freeMemBytes: 16 * 1024 ** 3,
					cpuLoadRatio: 0.25,
					cpuCount: 8,
					freeDiskBytes: 64 * 1024 ** 3,
					sampledAt: Date.now(),
				}),
			},
		});

		const os = await SwarmOS.create({
			runDir,
			workspace: repo,
			topology: "single",
			goal: { title: "AIMD Chaos", text: "Probe AIMD backoff and permanent drain" },
			enableFieldGuide: false,
			store,
			router,
		});
		try {
			router.attachBus(os.bus, os.runId);

			const getStatus = (id: string) => router.status().find((s) => s.driverId === id);

			// Scale up drv-a with consecutive successes, then hit transient 429 to force AIMD multiplicative decrease
			router.reportSuccess("drv-a");
			router.reportSuccess("drv-a");
			const beforeRl = getStatus("drv-a")?.effectiveLimit ?? 0;
			router.reportQuotaError("drv-a", { kind: "transient_rpm", retryAfterMs: 500, raw: "429 rate_limit_exceeded" });
			const afterRl = getStatus("drv-a")?.effectiveLimit ?? 0;

			// Permanent Class-3 hard_auth_or_cap drain
			router.reportQuotaError("drv-a", { kind: "hard_auth_or_cap", reason: "403 billing_hard_limit_reached", raw: "403 billing_hard_limit_reached" });
			// Attempt illegal resurrection via late in-flight success
			router.reportSuccess("drv-a");
			const finalStateA = getStatus("drv-a")?.state;

			// Acquiring a worker must route cleanly to drv-b without deadlocking
			const sel = await router.acquireForRole("worker");
			const pickedId = sel.driver.id;
			sel.release();

			const { events } = readRunEvents(dbPath, os.runId);
			const scaleDowns = events.filter(
				(e) => e.type === "governor.scaled" && Number(e.data.nextWindow) < Number(e.data.prevWindow),
			).length;
			const drainedCount = events.filter((e) => e.type === "quota.drained" && e.data.driverId === "drv-a").length;

			const passed =
				beforeRl >= 2 &&
				afterRl < beforeRl &&
				scaleDowns >= 1 &&
				drainedCount === 1 &&
				finalStateA === "drained" &&
				pickedId === "drv-b";

			return {
				passed,
				details: `window(${beforeRl}->${afterRl}) scaleDowns=${scaleDowns} drainedEvents=${drainedCount} finalStateA=${finalStateA} failoverDriver=${pickedId}`,
			};
		} finally {
			await os.dispose();
		}
	} finally {
		store.close();
		rmSync(repo, { recursive: true, force: true });
		rmSync(runDir, { recursive: true, force: true });
	}
}

/**
 * Scenario 3: Clean-merge semantic regression triggers auto-repair AND monotonic rollback on failed repair.
 */
async function scenarioSemanticRegressionAndRollback(): Promise<{ passed: boolean; details: string }> {
	const runCase = async (repairShouldSucceed: boolean) => {
		const repo = initGitRepo("semreg", {
			"version.txt": "1\n",
			"consumer.txt": "1\n",
		});
		const runDir = mkdtempSync(join(tmpdir(), `eval-chaos-run-semreg-${repairShouldSucceed}-`));
		const dbPath = join(runDir, "trace.db");
		const store = new SqliteStore(dbPath);
		try {
			const verifier: FindingVerifier = {
				name: "cross-file-match",
				version: "1.0.0",
				scopes: ["default"],
				defaultScope: "default",
				async check({ workspace }) {
					const v = readFileSync(join(workspace, "version.txt"), "utf8").trim();
					const c = readFileSync(join(workspace, "consumer.txt"), "utf8").trim();
					if (v === c && v === "2") return { status: "passed", score: 1.0, message: "coupled v2 match" };
					if (v === c && v === "1") return { status: "passed", score: 0.5, message: "coupled v1 match" };
					return { status: "failed", score: 0, message: `semantic mismatch: version=${v} vs consumer=${c}` };
				},
			};

			const driver = makeScriptedDriver({
				id: "drv-sem",
				async onTurn(spec) {
					if (spec.role === "integrator") {
						if (repairShouldSucceed) {
							writeFileSync(join(spec.workspace, "consumer.txt"), "2\n");
							execFileSync("git", ["add", "-A"], { cwd: spec.workspace });
							execFileSync("git", ["commit", "-q", "-m", "semantic repair"], { cwd: spec.workspace });
						} else {
							writeFileSync(join(spec.workspace, "consumer.txt"), "999\n");
							execFileSync("git", ["add", "-A"], { cwd: spec.workspace });
							execFileSync("git", ["commit", "-q", "-m", "bad repair"], { cwd: spec.workspace });
						}
						return { status: "completed", finalText: "repair attempt", usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 } };
					}
					return { status: "completed", finalText: "ok", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
				},
			});

			const router = new DriverQuotaRouter({
				drivers: [{ driver, config: { id: "drv-sem", kind: "pi-in-process", tier: "standard", maxConcurrent: 2 } }],
				roles: { default: ["drv-sem"], worker: ["drv-sem"], refinery: ["drv-sem"], integrator: ["drv-sem"] },
			});

			const os = await SwarmOS.create({
				runDir,
				workspace: repo,
				topology: "pull-refinery",
				goal: { title: "Semantic Regression Chaos", text: "Check repair + monotonic rollback" },
				verifier,
				enableBlindReview: false,
				enableFieldGuide: false,
				store,
				router,
			});
			try {
				// Establish an already-accepted green trunk at score 0.5
				await os.trust.submitFinding({
					agentId: "seed-agent",
					claim: "Baseline green trunk",
					summary: "v1==v1",
					level: "exact_check",
					workspace: os.worktrees.trunkPath,
				});

				// Create a branch that changes ONLY version.txt -> 2 (clean git merge, breaks cross-file invariant!)
				const wt = os.worktrees.create("worker-break");
				writeFileSync(join(wt.path, "version.txt"), "2\n");
				execFileSync("git", ["add", "-A"], { cwd: wt.path });
				execFileSync("git", ["commit", "-q", "-m", "bump version without consumer"], { cwd: wt.path });

				const pipeline = new IntegrationPipeline(os);
				const ac = new AbortController();
				const res = await pipeline.integrateBranch({
					branch: wt.branch,
					label: "worker-break",
					authorAgentId: "worker-break",
					goal: "Keep version.txt and consumer.txt synchronized",
					enableSemanticRepair: true,
					actorName: "refinery",
					signal: ac.signal,
				});

				const finalV = readFileSync(join(os.worktrees.trunkPath, "version.txt"), "utf8").trim();
				const finalC = readFileSync(join(os.worktrees.trunkPath, "consumer.txt"), "utf8").trim();
				const best = os.trust.bestVerifiedFinding(os.runId);
				const { events } = readRunEvents(dbPath, os.runId);
				const regEvents = events.filter((e) => e.type === "refinery.semantic_regression");

				return {
					outcome: res.outcome,
					finalV,
					finalC,
					bestScore: best?.finding.score ?? 0,
					bestStatus: best?.finding.status ?? "none",
					regEventsCount: regEvents.length,
					repairedFlag: Boolean(regEvents.at(-1)?.data.repaired),
					rolledBackFlag: Boolean(regEvents.at(-1)?.data.rolledBack),
				};
			} finally {
				await os.dispose();
			}
		} finally {
			store.close();
			rmSync(repo, { recursive: true, force: true });
			rmSync(runDir, { recursive: true, force: true });
		}
	};

	const rollbackCase = await runCase(false);
	const repairCase = await runCase(true);

	const rollbackOk =
		rollbackCase.regEventsCount >= 1 &&
		rollbackCase.rolledBackFlag &&
		rollbackCase.finalV === "1" &&
		rollbackCase.finalC === "1" &&
		rollbackCase.bestStatus === "accepted" &&
		rollbackCase.bestScore === 0.5;

	const repairOk =
		repairCase.regEventsCount >= 1 &&
		repairCase.repairedFlag &&
		repairCase.finalV === "2" &&
		repairCase.finalC === "2" &&
		repairCase.bestStatus === "accepted" &&
		repairCase.bestScore === 1.0;

	return {
		passed: rollbackOk && repairOk,
		details: `rollback(ok=${rollbackOk}, trunk=${rollbackCase.finalV}/${rollbackCase.finalC}, best=${rollbackCase.bestStatus}:${rollbackCase.bestScore}) repair(ok=${repairOk}, trunk=${repairCase.finalV}/${repairCase.finalC}, best=${repairCase.bestStatus}:${repairCase.bestScore})`,
	};
}

/**
 * Scenario 4: Recursive planner forest under maxConcurrent=1 proves permit-parking deadlock freedom.
 */
async function scenarioRecursiveParkingDeadlockFreedom(): Promise<{ passed: boolean; details: string }> {
	const repo = initGitRepo("park", { "a.txt": "0\n", "b.txt": "0\n" });
	const runDir = mkdtempSync(join(tmpdir(), "eval-chaos-run-park-"));
	const dbPath = join(runDir, "trace.db");
	const store = new SqliteStore(dbPath);
	let plannerIndex = 0;
	let workerIndex = 0;

	try {
		const driver = makeScriptedDriver({
			id: "drv-park",
			async onTurn(spec) {
				const ctx = {
					runId: spec.runId,
					agentId: spec.agentId,
					role: spec.role,
					workspace: spec.workspace,
					signal: new AbortController().signal,
				};
				if (spec.role === "planner") {
					const myIdx = plannerIndex++;
					const spawn = spec.tools?.find((t) => t.name === "spawn_agents");
					const wait = spec.tools?.find((t) => t.name === "await_agents");
					if (!spawn || !wait) throw new Error("Planner missing spawn/await tools");
					if (myIdx === 0) {
						await spawn.execute({
							agents: [{ role: "planner", handle: "sub-planner", prompt: "delegate leaves" }],
						}, ctx);
						await wait.execute({ mode: "all" }, ctx);
						return { status: "completed", finalText: "root done", usage: { inputTokens: 60, outputTokens: 20, totalTokens: 80 } };
					}
					await spawn.execute({
						agents: [
							{ role: "worker", handle: "leaf-a", prompt: "write a" },
							{ role: "worker", handle: "leaf-b", prompt: "write b" },
						],
					}, ctx);
					await wait.execute({ mode: "all" }, ctx);
					return { status: "completed", finalText: "sub-planner done", usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 } };
				}
				const file = workerIndex++ === 0 ? "a.txt" : "b.txt";
				writeFileSync(join(spec.workspace, file), "done\n");
				execFileSync("git", ["add", "-A"], { cwd: spec.workspace });
				execFileSync("git", ["commit", "-q", "-m", `update ${file}`], { cwd: spec.workspace });
				return { status: "completed", finalText: `wrote ${file}`, usage: { inputTokens: 40, outputTokens: 15, totalTokens: 55 } };
			},
		});

		const router = new DriverQuotaRouter({
			// Deliberately maxConcurrent=1! Without permit parking, depth-2 recursive awaiting deadlocks immediately.
			drivers: [{ driver, config: { id: "drv-park", kind: "pi-in-process", tier: "standard", maxConcurrent: 1 } }],
			roles: { default: ["drv-park"], planner: ["drv-park"], worker: ["drv-park"], integrator: ["drv-park"] },
		});

		const os = await SwarmOS.create({
			runDir,
			workspace: repo,
			topology: "recursive-planners",
			goal: { title: "Parking Deadlock Test", text: "Depth-2 forest on 1 slot" },
			wallSeconds: 15,
			enableFieldGuide: false,
			store,
			router,
		});
		try {
			const outcome = await os.execute(recursivePlannersTopology({ enableSemanticRepair: false }));

			const a = readFileSync(join(os.worktrees.trunkPath, "a.txt"), "utf8").trim();
			const b = readFileSync(join(os.worktrees.trunkPath, "b.txt"), "utf8").trim();
			const agents = store.list("agents", { runId: os.runId });
			const orphans = agents.filter((ag) => ag.status === "running" || ag.status === "parked" || ag.status === "pending");
			const maxDepth = Math.max(...agents.map((ag) => ag.depth ?? 0));

			// Confirm single slot was fully returned after run
			const probe = await router.acquireForRole("worker");
			probe.release();

			const passed = outcome.status === "done" && a === "done" && b === "done" && orphans.length === 0 && maxDepth === 2;
			return {
				passed,
				details: `status=${outcome.status} a=${a} b=${b} agents=${agents.length} maxDepth=${maxDepth} orphans=${orphans.length}`,
			};
		} finally {
			await os.dispose();
		}
	} finally {
		store.close();
		rmSync(repo, { recursive: true, force: true });
		rmSync(runDir, { recursive: true, force: true });
	}
}

/**
 * Scenario 5: Live MCP Bus authority red-team + macOS Seatbelt hidden read denial.
 */
async function scenarioMcpAuthorityAndRedteam(): Promise<{ passed: boolean; details: string }> {
	const repo = initGitRepo("redteam", { "ok.txt": "hi\n" });
	const runDir = mkdtempSync(join(tmpdir(), "eval-chaos-run-redteam-"));
	const hiddenDir = join(runDir, "hidden-secret");
	mkdirSync(hiddenDir, { recursive: true });
	writeFileSync(join(hiddenDir, "answer.txt"), "TOP_SECRET_ORACLE\n");
	const dbPath = join(runDir, "trace.db");
	const store = new SqliteStore(dbPath);

	const checks = {
		unauthStatus: 0,
		badTokenStatus: 0,
		workerMenuSorted: false,
		workerHasNoSpawn: false,
		workerSpawnCallBlocked: false,
		seatbeltHiddenDenied: process.platform !== "darwin",
	};

	try {
		const driver = makeScriptedDriver({
			id: "drv-mcp",
			supportsMcpHttp: true,
			async onTurn(spec) {
				if (spec.role === "planner") {
					const ctx = {
						runId: spec.runId,
						agentId: spec.agentId,
						role: spec.role,
						workspace: spec.workspace,
						signal: new AbortController().signal,
					};
					const spawn = spec.tools?.find((t) => t.name === "spawn_agents");
					const wait = spec.tools?.find((t) => t.name === "await_agents");
					if (spawn && wait) {
						await spawn.execute({
							agents: [{ role: "worker", handle: "redteam-leaf", prompt: "probe mcp" }],
						}, ctx);
						await wait.execute({ mode: "all" }, ctx);
					}
					return { status: "completed", finalText: "planner done", usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } };
				}

				if (spec.mcp) {
					const unauth = await fetch(spec.mcp.url, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
					});
					checks.unauthStatus = unauth.status;

					const badTok = await fetch(spec.mcp.url, {
						method: "POST",
						headers: { "Content-Type": "application/json", Authorization: "Bearer forged-token" },
						body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
					});
					checks.badTokenStatus = badTok.status;

					const listRes = await fetch(spec.mcp.url, {
						method: "POST",
						headers: { "Content-Type": "application/json", Authorization: `Bearer ${spec.mcp.token}` },
						body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
					});
					const listBody = (await listRes.json()) as { result?: { tools?: Array<{ name: string }> } };
					const names = (listBody.result?.tools ?? []).map((t) => t.name);
					const sorted = [...names].sort((a, b) => a.localeCompare(b));
					checks.workerMenuSorted = names.length > 0 && JSON.stringify(names) === JSON.stringify(sorted);
					checks.workerHasNoSpawn = !names.includes("spawn_agents") && !names.includes("steer_or_cancel_agent");

					// Attempt unauthorized direct RPC call to `spawn_agents` as a leaf worker
					const callRes = await fetch(spec.mcp.url, {
						method: "POST",
						headers: { "Content-Type": "application/json", Authorization: `Bearer ${spec.mcp.token}` },
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: 4,
							method: "tools/call",
							params: { name: "spawn_agents", arguments: { agents: [{ role: "worker", handle: "rogue", prompt: "x" }] } },
						}),
					});
					const callBody = (await callRes.json()) as { error?: { code: number }; result?: { isError?: boolean } };
					checks.workerSpawnCallBlocked = Boolean(callBody.error || callBody.result?.isError);
				}

				if (process.platform === "darwin") {
					const probe = await runSandboxedEvalCommand({
						cwd: spec.workspace,
						profile: "eval-offline",
						deniedDirs: [hiddenDir],
						command: `cat "${join(hiddenDir, "answer.txt")}"`,
						timeoutMs: 5000,
					});
					checks.seatbeltHiddenDenied = probe.exitCode !== 0 && !probe.stdout.includes("TOP_SECRET_ORACLE");
				}

				return { status: "completed", finalText: "redteam probed", usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } };
			},
		});

		const router = new DriverQuotaRouter({
			drivers: [{ driver, config: { id: "drv-mcp", kind: "pi-in-process", tier: "standard", maxConcurrent: 2 } }],
			roles: { default: ["drv-mcp"], planner: ["drv-mcp"], worker: ["drv-mcp"], integrator: ["drv-mcp"] },
		});

		const os = await SwarmOS.create({
			runDir,
			workspace: repo,
			topology: "recursive-planners",
			goal: { title: "Redteam MCP", text: "Verify MCP authority and sandbox" },
			deniedReadPaths: [hiddenDir],
			enableFieldGuide: false,
			store,
			router,
		});
		try {
			await os.execute(recursivePlannersTopology({ enableSemanticRepair: false }));
		} finally {
			await os.dispose();
		}

		const passed =
			checks.unauthStatus === 401 &&
			checks.badTokenStatus === 401 &&
			checks.workerMenuSorted &&
			checks.workerHasNoSpawn &&
			checks.workerSpawnCallBlocked &&
			checks.seatbeltHiddenDenied;

		return {
			passed,
			details: JSON.stringify(checks),
		};
	} finally {
		store.close();
		rmSync(repo, { recursive: true, force: true });
		rmSync(runDir, { recursive: true, force: true });
	}
}

/**
 * Scenario 6: KV-Cache prefix stability across N=4 substrate peers (identical system prompts & tool menus).
 */
async function scenarioKvCachePrefixStability(): Promise<{ passed: boolean; details: string }> {
	const repo = initGitRepo("kv", { "app.py": "print('ok')\n" });
	const runDir = mkdtempSync(join(tmpdir(), "eval-chaos-run-kv-"));
	const dbPath = join(runDir, "trace.db");
	const store = new SqliteStore(dbPath);
	const captured: Array<{ agentId: string; sysHash: string; toolDigest: string }> = [];

	try {
		const driver = makeScriptedDriver({
			id: "drv-kv",
			async onTurn(spec) {
				const toolNames = (spec.tools ?? []).map((t) => t.name);
				captured.push({
					agentId: spec.agentId,
					sysHash: sha256Text(spec.systemPrompt ?? ""),
					toolDigest: sha256Text(JSON.stringify(toolNames)),
				});
				return { status: "completed", finalText: "peer done", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
			},
		});

		const router = new DriverQuotaRouter({
			drivers: [{ driver, config: { id: "drv-kv", kind: "pi-in-process", tier: "standard", maxConcurrent: 4 } }],
			roles: { default: ["drv-kv"], worker: ["drv-kv"], integrator: ["drv-kv"] },
		});

		const os = await SwarmOS.create({
			runDir,
			workspace: repo,
			topology: "substrate-peers",
			goal: { title: "KV Prefix Stability", text: "Verify identical wave-1 peer prefixes" },
			enableFieldGuide: true,
			store,
			router,
		});
		try {
			await os.execute(substratePeersTopology({ peers: 4, rounds: 1, enableSemanticRepair: false }));
		} finally {
			await os.dispose();
		}

		const uniqueSysHashes = new Set(captured.map((c) => c.sysHash));
		const uniqueToolDigests = new Set(captured.map((c) => c.toolDigest));
		const passed = captured.length === 4 && uniqueSysHashes.size === 1 && uniqueToolDigests.size === 1;

		return {
			passed,
			details: `peers=${captured.length} uniqueSystemPrompts=${uniqueSysHashes.size} uniqueToolMenus=${uniqueToolDigests.size}`,
		};
	} finally {
		store.close();
		rmSync(repo, { recursive: true, force: true });
		rmSync(runDir, { recursive: true, force: true });
	}
}

/**
 * Execute the full zero-token Real-OS Fault-Injection, Concurrency & Security Red-Team Suite.
 */
export async function runRealOsChaosSuite(): Promise<ChaosSuiteReport> {
	const began = Date.now();
	const scenarios: ChaosScenarioResult[] = [
		await runScenario(
			"provider-crash-failover-and-token-conservation",
			["quota.drained emitted", "agent.handoff failover", "sum(budget.charged) == recordedLedgerTokens", "0 orphan agents"],
			scenarioCrashAndConservation,
		),
		await runScenario(
			"rate-limit-storm-aimd-and-permanent-drain",
			["AIMD multiplicative decrease on 429", "governor.scaled emitted", "drained state absorbing after late success", "healthy failover"],
			scenarioAimdAndDrain,
		),
		await runScenario(
			"semantic-regression-repair-and-monotonic-rollback",
			["clean-merge semantic regression detected", "failed repair rolls back monotonically", "accepted SQLite finding uncorrupted", "valid repair advances trunk"],
			scenarioSemanticRegressionAndRollback,
		),
		await runScenario(
			"recursive-parking-deadlock-freedom",
			["depth-2 recursive forest completes on maxConcurrent=1", "0 deadlocks", "0 leaked permits", "0 orphan agents"],
			scenarioRecursiveParkingDeadlockFreedom,
		),
		await runScenario(
			"mcp-authority-and-redteam-isolation",
			["HTTP 401 on missing/forged bearer", "tools/list strictly alphabetical", "leaf worker denied spawn_agents", "Seatbelt denies hiddenDir read"],
			scenarioMcpAuthorityAndRedteam,
		),
		await runScenario(
			"kv-cache-prefix-stability",
			["all N=4 peers receive byte-identical systemPrompt", "all N=4 peers receive identical sorted tool menu digest"],
			scenarioKvCachePrefixStability,
		),
	];

	const passedCount = scenarios.filter((s) => s.passed).length;
	return {
		allPassed: passedCount === scenarios.length,
		passedCount,
		totalCount: scenarios.length,
		durationMs: Date.now() - began,
		scenarios,
	};
}
