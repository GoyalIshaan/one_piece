import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { SwarmOsApi, TopologyOutcome, TopologyPlugin } from "@one-piece/core";
import { elasticPhaseTopology, type ElasticPhaseOptions } from "./elastic-phase.ts";
import { evolutionTopology, type EvolutionTopologyOptions } from "./evolution.ts";
import type { SubstrateSeatConfig } from "./substrate-peers.ts";

export interface AdaptiveTopologyOptions {
	/** Parallel worker count / width (default 4). */
	peers?: number;
	maxWorkers?: number;
	populationPerGen?: number;
	generations?: number;
	/** Per-seat configs for privately sharded tasks. */
	seatConfigs?: readonly SubstrateSeatConfig[];
	enableDreaming?: boolean;
	enableSemanticRepair?: boolean;
}

export type AdaptiveRegime = "sharded-consensus" | "scalar-optimization" | "coupled-single-context" | "decomposable-multi-phase";

export interface AdaptiveClassification {
	regime: AdaptiveRegime;
	delegate: "elastic-phase" | "evolution";
	codeFiles: number;
	codeBytes: number;
	reason: string;
}

const IGNORED_DIRS = new Set([
	".git",
	".one_piece",
	".swarm",
	".gemini",
	".grok",
	"node_modules",
	"__pycache__",
	".pytest_cache",
	".venv",
	"venv",
	"dist",
	"build",
	"target",
]);

const CODE_EXTENSIONS = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".rs", ".go", ".c", ".cc", ".cpp", ".h", ".java"]);

function inspectCodebaseFootprint(rootDir: string, maxFiles = 64): { codeFiles: number; codeBytes: number } {
	let codeFiles = 0;
	let codeBytes = 0;
	function walk(dir: string, depth: number): void {
		if (depth > 4 || codeFiles >= maxFiles) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (codeFiles >= maxFiles) break;
			if (IGNORED_DIRS.has(entry.name)) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "tests" || entry.name === "test" || entry.name === "__tests__") continue;
				walk(full, depth + 1);
			} else if (CODE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
				codeFiles += 1;
				try {
					codeBytes += statSync(full).size;
				} catch {
					// ignore stat error
				}
			}
		}
	}
	walk(rootDir, 0);
	return { codeFiles, codeBytes };
}

const SCALAR_OPT_RE = /\b(speedup|cycles|minimize|maximize|optimize\s+build_kernel|packing|radius|geometric-mean|throughput\s+score|scalar\s+objective)\b/i;
const MULTI_PHASE_RE = /\b(phase\s*[a-c1-3]|3-phase|multi-phase|migration|forensics\s*\+|migrate)\b/i;
const TIGHT_COUPLING_RE = /\b(cross-module|cross-feature|semantic\s+invariant|semantic\s+interference|mvcc|snapshot\s+isolation|constant\s+folding|interacting\s+(modules|compiler\s+passes))\b/i;

/**
 * Deterministic 0-token (<5ms) regime classifier that routes tasks to the empirically
 * strongest native topology family based on sharding, codebase footprint, and coupling cues.
 */
export function classifyAdaptiveRegime(params: {
	workspaceDir: string;
	goal: string;
	rubric?: string;
	hasSeatConfigs: boolean;
}): AdaptiveClassification {
	const { workspaceDir, goal, rubric, hasSeatConfigs } = params;
	if (hasSeatConfigs) {
		return {
			regime: "sharded-consensus",
			delegate: "elastic-phase",
			codeFiles: 0,
			codeBytes: 0,
			reason: "Privately sharded seats detected -> routing to elastic-phase for mandatory Board v2 consensus and mechanical trunk assembly.",
		};
	}

	const { codeFiles, codeBytes } = inspectCodebaseFootprint(workspaceDir);
	const text = `${goal}\n${rubric ?? ""}`;

	if (SCALAR_OPT_RE.test(text) && codeFiles <= 4) {
		return {
			regime: "scalar-optimization",
			delegate: "evolution",
			codeFiles,
			codeBytes,
			reason: `Compact scalar optimization workspace (${codeFiles} files, ${codeBytes}B) -> routing to evolution (MAP-Elites + crossover) to maximize speedup without decomposition overhead.`,
		};
	}

	if (TIGHT_COUPLING_RE.test(text) && !MULTI_PHASE_RE.test(text) && codeFiles <= 12 && codeBytes <= 32_768) {
		return {
			regime: "coupled-single-context",
			delegate: "evolution",
			codeFiles,
			codeBytes,
			reason: `Tightly coupled single-context repo (${codeFiles} files, ${codeBytes}B) -> routing to evolution (full-context diverse search + crossover) to eliminate straggler decomposition penalty.`,
		};
	}

	return {
		regime: "decomposable-multi-phase",
		delegate: "elastic-phase",
		codeFiles,
		codeBytes,
		reason: `Multi-phase / broader workspace (${codeFiles} files, ${codeBytes}B) -> routing to elastic-phase (Scout -> Wide Explore -> Dream -> Narrow Verified Integration).`,
	};
}

/**
 * Adaptive Meta-Router Topology:
 * Uses a zero-token pre-flight classifier to route each workload to the topology that
 * empirically dominates its structural regime (sharded consensus vs scalar optimization
 * vs tightly coupled single-context SWE vs multi-phase decomposable migration).
 */
export function adaptiveTopology(opts: AdaptiveTopologyOptions = {}): TopologyPlugin {
	return {
		name: "adaptive",
		description: "Zero-token pre-flight regime classifier routing sharded/multi-phase workloads to elastic-phase and scalar-opt/tightly-coupled repos to evolution.",
		async run(os: SwarmOsApi, { goal, rubric, signal }): Promise<TopologyOutcome> {
			const hasSeatConfigs = Boolean(opts.seatConfigs && opts.seatConfigs.length > 0);
			const cls = classifyAdaptiveRegime({
				workspaceDir: os.worktrees.trunkPath,
				goal,
				rubric,
				hasSeatConfigs,
			});

			os.bus.emit(os.runId, "phase.changed", {
				to: `adaptive:${cls.delegate}`,
				reason: `[${cls.regime}] ${cls.reason}`,
			});

			if (cls.delegate === "evolution") {
				const evoOpts: EvolutionTopologyOptions = {
					populationPerGen: opts.populationPerGen ?? opts.peers ?? opts.maxWorkers ?? 4,
					generations: opts.generations ?? 2,
				};
				const out = await evolutionTopology(evoOpts).run(os, { goal, rubric, signal });
				return {
					...out,
					summary: `Adaptive[${cls.regime} -> evolution]: ${out.summary}`,
				};
			}

			const elasticOpts: ElasticPhaseOptions = {
				peers: opts.peers ?? opts.maxWorkers ?? opts.seatConfigs?.length ?? 4,
				maxWorkers: opts.maxWorkers,
				seatConfigs: opts.seatConfigs,
				enableDreaming: opts.enableDreaming,
				enableSemanticRepair: opts.enableSemanticRepair,
			};
			const out = await elasticPhaseTopology(elasticOpts).run(os, { goal, rubric, signal });
			return {
				...out,
				summary: `Adaptive[${cls.regime} -> elastic-phase]: ${out.summary}`,
			};
		},
	};
}
