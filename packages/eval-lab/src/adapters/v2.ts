import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	allowSandboxReads,
	denySandboxReads,
	type DriverConfig,
	type FindingVerifier,
	type QuotaPoolRouter,
} from "@one-piece/core";
import { createDriver, DriverQuotaRouter } from "@one-piece/drivers";
import { createTopology, SwarmOS, TOPOLOGY_NAMES } from "@one-piece/engine";
import { SqliteStore } from "@one-piece/store";
import type {
	CandidateSnapshot,
	EvalTask,
	HarnessAdapter,
	HarnessRunReceipt,
	HarnessRunSpec,
} from "../contracts.ts";
import { sha256Dir } from "../sandbox.ts";

export interface V2AdapterOptions {
	/** Configured v2 QuotaPoolRouter (multi-CLI drivers, PiInProcessDriver, or scripted WorkerDriver). */
	router: QuotaPoolRouter;
	/** Optional EvalTask so its `publicCheck` can be exposed to v2's online `TrustLayer` verifier. */
	task?: EvalTask;
	enableBlindReview?: boolean;
	reservePct?: number;
	/** Optional overrides passed to `createTopology(name, options)`. */
	topologyOptions?: Record<string, unknown>;
}

const TOPOLOGY_ALIASES: Record<string, string> = {
	solo: "single",
	swarm: "pull-refinery",
	"scalemas-peers": "substrate-peers",
};

function resolveV2TopologyName(spec: HarnessRunSpec): string {
	if (spec.controlRung === "solo") return "single";
	const raw = spec.topology ?? "pull-refinery";
	const mapped = TOPOLOGY_ALIASES[raw] ?? raw;
	if ((TOPOLOGY_NAMES as readonly string[]).includes(mapped)) return mapped;
	return "pull-refinery";
}

function bridgePublicVerifier(task: EvalTask | undefined, spec: HarnessRunSpec): FindingVerifier | undefined {
	if (!task?.publicCheck) return undefined;
	const checkFn = task.publicCheck.bind(task);
	return {
		name: `${task.id}-public-check`,
		version: "1.0.0",
		scopes: ["deliverable"],
		defaultScope: "deliverable",
		async check({ workspace }) {
			const res = await checkFn({
				artifactDir: workspace,
				seed: spec.seed,
				n: spec.swarmSize,
				options: spec.taskOptions ?? {},
			});
			return {
				status: res.passed ? "passed" : "failed",
				message: res.details,
				score: res.score,
			};
		},
	};
}

/**
 * Live Layer-E adapter for `one_piece` v2 (`SwarmOS` + 5 native `TopologyPlugin`s +
 * `DriverQuotaRouter` + `TrustLayer` + `CloseoutController`).
 *
 * Captures every intermediate frozen finding snapshot with `(atTokens, atWallMs)` so
 * `extractScorecard` reconstructs exact Anytime Frontiers Q*(b, t) and `nominationLoss`.
 */
export function createV2Adapter(options: V2AdapterOptions): HarnessAdapter {
	const driverIds = options.router.drivers().map((d) => d.id);
	return {
		name: `v2-swarm(${driverIds.join("+") || "custom"})`,
		async run(spec: HarnessRunSpec, signal?: AbortSignal): Promise<HarnessRunReceipt> {
			const store = new SqliteStore(spec.dbPath);
			const began = Date.now();
			const topologyName = resolveV2TopologyName(spec);
			const denyPaths = [...spec.hiddenDenyPaths];
			denySandboxReads(denyPaths);

			let cumulativeTokens = 0;
			const snapshotMeta = new Map<string, { atTokens: number; atWallMs: number }>();

			let os: SwarmOS | undefined;
			try {
				os = await SwarmOS.create({
					runId: spec.runId,
					runDir: spec.runDir,
					workspace: spec.workspaceDir,
					topology: topologyName,
					goal: {
						title: `${spec.taskId} (seed ${spec.seed})`,
						text: spec.injectedPrompt ? `${spec.goal}\n\n${spec.injectedPrompt}` : spec.goal,
						rubric: spec.rubric,
					},
					budget: {
						...(spec.budget.tokens !== undefined ? { tokens: spec.budget.tokens } : {}),
						...(spec.budget.usd !== undefined ? { usd: spec.budget.usd } : {}),
						...(spec.budget.cpuSeconds !== undefined ? { cpu_seconds: spec.budget.cpuSeconds } : {}),
					},
					wallSeconds:
						spec.budget.wallClockMs !== undefined
							? Math.max(1, Math.ceil(spec.budget.wallClockMs / 1000))
							: undefined,
					reservePct: options.reservePct ?? 0.12,
					verifier: bridgePublicVerifier(options.task, spec),
					enableBlindReview: options.enableBlindReview ?? false,
					networkOffWorkers: true,
					rawConfig: {
						evalLab: {
							taskId: spec.taskId,
							seed: spec.seed,
							controlRung: spec.controlRung,
							swarmSize: spec.swarmSize,
							budgetMode: spec.budgetMode,
						},
					},
					store,
					router: options.router,
				});

				const unsub = os.bus.on((ev) => {
					if (ev.type === "budget.charged") {
						cumulativeTokens += Number(ev.data.tokens ?? 0);
					} else if (ev.type === "finding.reported") {
						const key = `${String(ev.data.findingId ?? "")}:${String(ev.data.revision ?? 1)}`;
						snapshotMeta.set(key, { atTokens: cumulativeTokens, atWallMs: Date.now() - began });
					}
				});

				const n = Math.max(1, spec.swarmSize);
				const plugin = createTopology(topologyName, {
					maxWorkers: n,
					concurrency: n,
					peers: Math.max(2, n),
					populationPerGen: n,
					generations: 2,
					rounds: 2,
					...options.topologyOptions,
				});

				const outcome = await os.execute(plugin, signal);
				unsub();

				// Build complete CandidateSnapshot[] from persisted findings + frozen snapshots
				const findings = store.list("findings", { runId: spec.runId });
				const snapshots: CandidateSnapshot[] = [];
				for (const f of findings) {
					for (const sub of f.submissions) {
						const dir = sub.snapshotDir ?? join(spec.runDir, "submissions", f.id, String(sub.revision));
						if (!existsSync(dir)) continue;
						const key = `${f.id}:${sub.revision}`;
						const meta = snapshotMeta.get(key);
						const verdictForRev = f.rounds.findLast((r) => r.revision === sub.revision)?.verdict;
						const accepted = verdictForRev === "accepted" || (verdictForRev === undefined && f.status === "accepted");
						snapshots.push({
							id: `${f.id}-r${sub.revision}`,
							agentId: f.authorAgentId,
							dir,
							sha256: sub.artifactSha256 ?? sha256Dir(dir),
							atTokens: meta?.atTokens ?? cumulativeTokens,
							atWallMs: meta?.atWallMs ?? Math.max(0, sub.at - began),
							acceptedByVerifier: accepted,
							revision: sub.revision,
							findingId: f.id,
						});
					}
				}

				const nomEvents = store.events(spec.runId, { types: ["run.nominated"] });
				const lastNom = nomEvents.at(-1);
				const wasAutoNominated = Boolean(lastNom?.data.auto);
				const nominatedFindingId = outcome.nominatedFindingId;
				const nominatedRevision = outcome.nominatedRevision ?? 1;

				// Respect spec.autoNominate: when autoNominate is disabled, ignore mechanical closeout nomination
				const allowNomination = Boolean(nominatedFindingId) && (spec.autoNominate || !wasAutoNominated);
				const nomDir = allowNomination
					? join(spec.runDir, "submissions", nominatedFindingId!, String(nominatedRevision))
					: undefined;
				const validNomDir = nomDir && existsSync(nomDir) ? nomDir : undefined;
				const nomSnap = validNomDir
					? snapshots.find((s) => s.findingId === nominatedFindingId && s.revision === nominatedRevision)
					: undefined;

				const agents = store.list("agents", { runId: spec.runId });
				const usedDrivers = [...new Set(agents.map((a) => a.driverId).filter(Boolean))];
				const usedModels = [...new Set(agents.map((a) => a.model).filter((m): m is string => Boolean(m)))];

				return {
					runId: spec.runId,
					status: outcome.status,
					nominatedArtifactDir: validNomDir,
					nominatedSha256: validNomDir ? (nomSnap?.sha256 ?? sha256Dir(validNomDir)) : undefined,
					nominatedAtTokens: nomSnap?.atTokens ?? (validNomDir ? cumulativeTokens : undefined),
					nominatedAtWallMs: nomSnap?.atWallMs ?? (validNomDir ? Date.now() - began : undefined),
					autoNominated: allowNomination && wasAutoNominated,
					candidateSnapshots: snapshots,
					harnessFaults: [],
					driverIds: usedDrivers.length ? usedDrivers : driverIds,
					modelIds: usedModels,
				};
			} finally {
				allowSandboxReads(denyPaths);
				if (os) await os.dispose();
				store.close();
			}
		},
	};
}

/**
 * Convenience helper to construct a v2 `DriverQuotaRouter` from CLI driver specs
 * (`codex`, `codex-exec`, `gemini`/`agy`, `grok`, with optional `:model` suffix like `codex:gpt-6.2-sol`)
 * for live CLI benchmark runs.
 */
export function createCliV2Router(driverSpecs: readonly string[]): DriverQuotaRouter {
	const configs: DriverConfig[] = driverSpecs.map((raw) => {
		const trimmed = raw.trim();
		const colonIdx = trimmed.indexOf(":");
		const id = (colonIdx > 0 ? trimmed.slice(0, colonIdx) : trimmed).toLowerCase();
		const model = colonIdx > 0 ? trimmed.slice(colonIdx + 1).trim() || undefined : undefined;
		const modelOpt = model ? { model } : {};
		switch (id) {
			case "codex":
			case "codex-app-server":
				return { id: "codex", kind: "codex-app-server", maxConcurrent: 2, subscriptionMode: true, ...modelOpt };
			case "codex-exec":
				return { id: "codex-exec", kind: "codex-exec", maxConcurrent: 2, subscriptionMode: true, ...modelOpt };
			case "gemini":
			case "agy":
			case "agy-acp":
				return { id: "gemini", kind: "agy-acp", maxConcurrent: 2, subscriptionMode: true, ...modelOpt };
			case "gemini-cli":
			case "gemini-legacy":
				return { id: "gemini-cli", kind: "gemini-cli", maxConcurrent: 2, subscriptionMode: true, ...modelOpt };
			case "grok":
			case "grok-acp":
				return { id: "grok", kind: "grok-acp", maxConcurrent: 2, subscriptionMode: true, ...modelOpt };
			case "grok-cli":
				return { id: "grok-cli", kind: "grok-cli", maxConcurrent: 2, subscriptionMode: true, ...modelOpt };
			default:
				throw new Error(`Unknown CLI driver "${raw}". Supported: codex, codex-exec, gemini, agy, grok`);
		}
	});
	const entries = configs.map((config) => ({ driver: createDriver(config), config }));
	const ids = configs.map((c) => c.id);
	return new DriverQuotaRouter({
		drivers: entries,
		roles: { default: ids, worker: ids, planner: ids, reviewer: ids, refinery: ids },
	});
}
