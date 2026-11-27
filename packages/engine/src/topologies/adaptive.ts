import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import {
	assertNever,
	type Exclusive,
	type ExecutionControlMode,
	getChoiceAnswer,
	getNoulAnswer,
	type SwarmOsApi,
	type TopologyOutcome,
	type TopologyPlugin,
} from "@one-piece/core";
import type { CheckpointPolicy, HumanCheckpointHandler } from "../bounds.ts";
import { probeWorkspaceEnvironment } from "../field-guide.ts";
import { elasticPhaseTopology, type ElasticPhaseOptions } from "./elastic-phase.ts";
import { evolutionTopology, type EvolutionTopologyOptions } from "./evolution.ts";
import { hierarchyTopology } from "./hierarchy.ts";
import { pullRefineryTopology } from "./pull-refinery.ts";
import { recursivePlannersTopology } from "./recursive-planners.ts";
import { substratePeersTopology, type SubstrateSeatConfig } from "./substrate-peers.ts";

export interface AdaptiveTopologyOptions {
	/** Parallel worker count / width (default 4). */
	peers?: number;
	maxWorkers?: number;
	populationPerGen?: number;
	generations?: number | "unbounded";
	/** Per-seat configs for privately sharded tasks. */
	seatConfigs?: readonly SubstrateSeatConfig[];
	enableDreaming?: boolean;
	enableSemanticRepair?: boolean;
	/** Explicit Field Guide override (when omitted, Jev Meta-Router gates Wave-1 Field Guide automatically). */
	enableFieldGuideOverride?: boolean;
	/** Enable mid-run telemetry morphing check via Decision Model (default true). */
	enableMidRunMorph?: boolean;
	/** First-principles Roofline bound estimation override (when omitted, decided by Jev). */
	estimateBounds?: boolean;
	/** Execution control mode ("eval" vs "research"). */
	controlMode?: ExecutionControlMode;
	/** Researcher checkpoint policy. */
	checkpointPolicy?: CheckpointPolicy;
	onHumanCheckpoint?: HumanCheckpointHandler;
	/** Minimum Jev confidence required to accept its routing choice over structural fallback (default 0.55). */
	minDecisionConfidence?: number;
}

export type AdaptiveDelegateName = "elastic-phase" | "evolution" | "recursive-planners" | "substrate-peers" | "pull-refinery" | "hierarchy";

export interface AdaptiveExecutionPlan {
	readonly source: "decision-model" | "structural-heuristic";
	readonly regime: AdaptiveRegime;
	readonly delegate: AdaptiveDelegateName;
	readonly enableWave1FieldGuide?: boolean;
	readonly dreamingMode: "deterministic" | "llm";
	readonly enableBoard: boolean;
	readonly estimateBounds: boolean;
	readonly widthMultiplier: number;
	readonly confidence: number;
	readonly reason: string;
}

export type AdaptiveRegime = "sharded-consensus" | "scalar-optimization" | "coupled-single-context" | "decomposable-multi-phase";

export interface WorkspaceStructureMetrics {
	codeFiles: number;
	codeBytes: number;
	sourceDirs: number;
	internalImportEdges: number;
	maxImportFanOut: number;
	importCouplingDensity: number;
	specPhaseHeadings: number;
}

export interface AdaptiveClassification {
	regime: AdaptiveRegime;
	delegate: "elastic-phase" | "evolution";
	codeFiles: number;
	codeBytes: number;
	sourceDirs: number;
	internalImportEdges: number;
	maxImportFanOut: number;
	importCouplingDensity: number;
	specPhaseHeadings: number;
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

const TEST_DIRS = new Set(["tests", "test", "__tests__", "spec", "specs"]);
const CODE_EXTENSIONS = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".rs", ".go", ".c", ".cc", ".cpp", ".h", ".java"]);
const MAX_SOURCE_READ_BYTES = 32_768;
const MAX_DOC_READ_BYTES = 65_536;

interface ScannedCodeFile {
	absPath: string;
	relPath: string;
	relDir: string;
	ext: string;
	stem: string;
	bytes: number;
}

function readCappedUtf8(filePath: string, maxBytes: number): string {
	try {
		const raw = readFileSync(filePath);
		return raw.subarray(0, maxBytes).toString("utf8");
	} catch {
		return "";
	}
}

function countInternalImports(
	file: ScannedCodeFile,
	content: string,
	localStems: ReadonlySet<string>,
	topLevelPackages: ReadonlySet<string>,
): number {
	const targets = new Set<string>();

	if (file.ext === ".py") {
		// Relative imports: `from .foo import ...`, `from ..bar import ...`, `from . import a, b`
		for (const m of content.matchAll(/^\s*from\s+(\.+[A-Za-z0-9_.]*)\s+import\s+([^\n#]+)/gm)) {
			const modPath = m[1]!;
			const imported = m[2]!;
			if (/^\.+$/.test(modPath)) {
				for (const item of imported.split(",")) {
					const name = item.trim().split(/\s+as\s+/)[0]?.trim();
					if (name && name !== "*" && name !== file.stem) targets.add(`rel:${name}`);
				}
			} else {
				const clean = modPath.replace(/^\.+/, "");
				if (clean && clean !== file.stem) targets.add(`rel:${clean}`);
			}
		}
		// Intra-repo package imports: `from pkg.mod import ...` or `import pkg.mod`
		for (const m of content.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/gm)) {
			const full = m[1]!;
			const root = full.split(".")[0]!;
			if (full === file.stem) continue;
			if (topLevelPackages.has(root) && full.includes(".")) {
				targets.add(`pkg:${full}`);
			} else if (localStems.has(root) && root !== file.stem && root !== "__init__") {
				targets.add(`mod:${root}`);
			}
		}
	} else if (file.ext === ".ts" || file.ext === ".tsx" || file.ext === ".js" || file.ext === ".jsx") {
		for (const m of content.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*["'](\.[^"']+)["']/g)) {
			const spec = m[1]!;
			if (spec) targets.add(`rel:${spec}`);
		}
	} else if (file.ext === ".rs") {
		for (const m of content.matchAll(/^\s*use\s+(?:crate|super|self)::([A-Za-z_][A-Za-z0-9_:]*)/gm)) {
			const target = m[1]!.split("::")[0]!;
			if (target && target !== file.stem) targets.add(`rs:${target}`);
		}
		for (const m of content.matchAll(/^\s*(?:pub\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm)) {
			const target = m[1]!;
			if (target && target !== file.stem) targets.add(`rs:${target}`);
		}
	} else if (file.ext === ".c" || file.ext === ".cc" || file.ext === ".cpp" || file.ext === ".h") {
		for (const m of content.matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)) {
			const hdr = m[1]!;
			if (hdr) targets.add(`inc:${hdr}`);
		}
	} else if (file.ext === ".go") {
		for (const m of content.matchAll(/["'](\.[^"']+)["']/g)) {
			const spec = m[1]!;
			if (spec) targets.add(`go:${spec}`);
		}
	}

	return targets.size;
}

function countSpecPhaseHeadings(rootDir: string): number {
	let entries;
	try {
		entries = readdirSync(rootDir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let total = 0;
	let docsRead = 0;
	for (const entry of entries) {
		if (docsRead >= 10) break;
		if (!entry.isFile()) continue;
		if (extname(entry.name).toLowerCase() !== ".md") continue;
		docsRead += 1;
		const text = readCappedUtf8(join(rootDir, entry.name), MAX_DOC_READ_BYTES);
		const matches = text.match(/^#{1,3}\s+(?:phase|stage|milestone|part|step)\b/gim);
		if (matches) total += matches.length;
	}
	return total;
}

/**
 * Inspect workspace footprint, static intra-repo import coupling, and markdown spec phase structure
 * in <5ms with zero LLM tokens.
 */
export function inspectWorkspaceStructure(rootDir: string, maxFiles = 64): WorkspaceStructureMetrics {
	const files: ScannedCodeFile[] = [];
	let codeBytes = 0;

	function walk(dir: string, depth: number): void {
		if (depth > 4 || files.length >= maxFiles) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= maxFiles) break;
			if (IGNORED_DIRS.has(entry.name)) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (TEST_DIRS.has(entry.name.toLowerCase())) continue;
				walk(full, depth + 1);
			} else if (entry.isFile()) {
				const ext = extname(entry.name).toLowerCase();
				if (!CODE_EXTENSIONS.has(ext)) continue;
				let bytes = 0;
				try {
					bytes = statSync(full).size;
				} catch {
					// ignore stat error
				}
				const relPath = relative(rootDir, full);
				const relDir = dirname(relPath);
				const stem = basename(entry.name, ext);
				files.push({ absPath: full, relPath, relDir, ext, stem, bytes });
				codeBytes += bytes;
			}
		}
	}

	walk(rootDir, 0);

	const distinctDirs = new Set(files.map((f) => f.relDir));
	const topLevelPackages = new Set(
		files
			.map((f) => f.relDir.split(/[\\/]/)[0]!)
			.filter((d) => d && d !== "."),
	);
	const localStems = new Set(files.map((f) => f.stem));

	let internalImportEdges = 0;
	let maxImportFanOut = 0;
	for (const file of files) {
		const content = readCappedUtf8(file.absPath, MAX_SOURCE_READ_BYTES);
		const fanOut = countInternalImports(file, content, localStems, topLevelPackages);
		internalImportEdges += fanOut;
		if (fanOut > maxImportFanOut) maxImportFanOut = fanOut;
	}

	const codeFiles = files.length;
	const importCouplingDensity = codeFiles > 0 ? Math.round((internalImportEdges / codeFiles) * 1000) / 1000 : 0;
	const specPhaseHeadings = countSpecPhaseHeadings(rootDir);

	return {
		codeFiles,
		codeBytes,
		sourceDirs: distinctDirs.size,
		internalImportEdges,
		maxImportFanOut,
		importCouplingDensity,
		specPhaseHeadings,
	};
}

// Purely domain-agnostic structural cues (no benchmark-specific identifiers or domain jargon).
const SCALAR_OBJECTIVE_RE =
	/\b(minimize|maximize|speedup|optimize|incumbent|scalar\s+objective|higher\s+\w+(?:\s+\w+){0,2}\s+is\s+better|lower\s+\w+(?:\s+\w+){0,2}\s+is\s+better|reduce\s+(?:cycles|latency|runtime|cost|loss|memory|error))\b/i;
const STAGED_WORKFLOW_RE =
	/\b(multi-?phase|multi-?stage|all\s+\d+\s+(?:phases|stages|milestones)|migrat(?:e|ion))\b|\b(phase|stage|milestone)\s+([a-z0-9]+)\b[\s\S]{0,200}\b\2\s+(?!\3\b)[a-z0-9]+\b/i;
const GENERIC_COUPLING_RE = /\b(cross-module|cross-component|cross-feature|shared\s+invariant|tightly\s+coupled)\b/i;

/**
 * Deterministic 0-token (<5ms) regime classifier that routes tasks to the empirically
 * strongest native topology family based on sharding, codebase footprint, static import
 * coupling graph, markdown spec phase structure, and domain-agnostic problem structure.
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
			sourceDirs: 0,
			internalImportEdges: 0,
			maxImportFanOut: 0,
			importCouplingDensity: 0,
			specPhaseHeadings: 0,
			reason: "Privately sharded seats detected -> routing to elastic-phase for mandatory Board v2 consensus and mechanical trunk assembly.",
		};
	}

	const s = inspectWorkspaceStructure(workspaceDir);
	const text = `${goal}\n${rubric ?? ""}`;
	const isStaged = s.specPhaseHeadings >= 2 || STAGED_WORKFLOW_RE.test(text);

	if (s.codeFiles <= 4 && s.sourceDirs <= 1 && !isStaged && SCALAR_OBJECTIVE_RE.test(text)) {
		return {
			regime: "scalar-optimization",
			delegate: "evolution",
			...s,
			reason: `Compact scalar optimization workspace (${s.codeFiles} files, ${s.codeBytes}B) -> routing to evolution (MAP-Elites + crossover) to maximize objective without decomposition overhead.`,
		};
	}

	const isCompactSingleContext = s.codeFiles <= 12 && s.codeBytes <= 32_768 && s.sourceDirs <= 2;
	const isStructurallyCoupled = s.codeFiles >= 3 && (s.maxImportFanOut >= 3 || s.importCouplingDensity >= 0.5);
	const hasGenericCouplingCue = GENERIC_COUPLING_RE.test(text);

	if (!isStaged && isCompactSingleContext && (isStructurallyCoupled || hasGenericCouplingCue)) {
		return {
			regime: "coupled-single-context",
			delegate: "evolution",
			...s,
			reason: `Compact coupled repo (${s.codeFiles} files, ${s.codeBytes}B, maxFanOut=${s.maxImportFanOut}, density=${s.importCouplingDensity}) -> routing to evolution (full-context diverse search + crossover) to avoid cross-lane semantic interference.`,
		};
	}

	return {
		regime: "decomposable-multi-phase",
		delegate: "elastic-phase",
		...s,
		reason: `Staged, loosely coupled, or broader workspace (${s.codeFiles} files, ${s.codeBytes}B, dirs=${s.sourceDirs}, phases=${s.specPhaseHeadings}, maxFanOut=${s.maxImportFanOut}) -> routing to elastic-phase (Scout -> Wide Explore -> Dream -> Narrow Verified Integration).`,
	};
}

const VALID_DELEGATES = new Set<AdaptiveDelegateName>([
	"elastic-phase",
	"evolution",
	"recursive-planners",
	"substrate-peers",
	"pull-refinery",
	"hierarchy",
]);

/** Strictly neutral, structure-only descriptions (zero task-domain biasing!). */
export const NEUTRAL_TOPOLOGY_CRITERIA = {
	"elastic-phase": "Four-stage sequential width schedule: 1 scout partitions work into lanes -> K parallel isolated workers execute lanes -> context reset/consolidation -> 1 integrator merges branches and repairs.",
	evolution: "Asynchronous Director-led genetic search over a shared verified git archive: optional serial Phase-0 2-tier Roofline analysis -> seeds distinct parallel families -> supports recursive child family directors, pruning, and code-level branch crossover/merging.",
	"recursive-planners": "Dynamic two-role Planner/Worker tree: root planner recursively spawns child planners, leaf workers, and nested sub-topologies over shared board channels, assembling committed branches at closeout.",
	"substrate-peers": "Flat symmetric communicating peers in isolated worktrees coordinating directly over a shared message board, followed by mechanical trunk assembly.",
	"pull-refinery": "Upfront dependency-DAG task queue with atomic ticket leasing by parallel workers and a serialized one-by-one merge refinery.",
	hierarchy: "Planner decomposes work into subtasks (optionally spawning recursive sub-topologies), parallel leaf workers execute, and a single integrator synthesizes results.",
} as const;

/**
 * Calibrated System-1 Decision-Model Pre-Flight Meta-Router (TypeSafe Jev).
 * Evaluates 6 atomic routing questions using strictly neutral structural topology descriptions
 * (zero task-domain biasing or heuristic leakage) and falls back to `classifyAdaptiveRegime()` offline.
 */
export async function resolveAdaptiveExecutionPlan(
	os: SwarmOsApi,
	params: {
		workspaceDir: string;
		goal: string;
		rubric?: string;
		hasSeatConfigs: boolean;
		minConfidence?: number;
		signal?: AbortSignal;
	},
): Promise<AdaptiveExecutionPlan> {
	const fallback = classifyAdaptiveRegime(params);
	const minConf = params.minConfidence ?? 0.55;

	if (!os.decisionClient) {
		return {
			source: "structural-heuristic",
			regime: fallback.regime,
			delegate: fallback.delegate,
			dreamingMode: "deterministic",
			enableBoard: true,
			estimateBounds: fallback.regime === "scalar-optimization",
			widthMultiplier: 1,
			confidence: 0.7,
			reason: fallback.reason,
		};
	}

	const probe = probeWorkspaceEnvironment(params.workspaceDir, os.worktrees.baseSha);
	// Strictly neutral state: NEVER inject heuristic delegate recommendation or domain biases into Jev!
	const state = [
		`Goal: ${params.goal}`,
		params.rubric ? `Rubric: ${params.rubric}` : "",
		`Privately Sharded Seats: ${params.hasSeatConfigs ? "YES (mandatory cross-seat board consensus)" : "NO"}`,
		`Structural Metrics: codeFiles=${fallback.codeFiles}, codeBytes=${fallback.codeBytes}, sourceDirs=${fallback.sourceDirs}, internalImportEdges=${fallback.internalImportEdges}, maxImportFanOut=${fallback.maxImportFanOut}, importCouplingDensity=${fallback.importCouplingDensity}, specPhaseHeadings=${fallback.specPhaseHeadings}`,
		"",
		probe,
	].filter(Boolean).join("\n");

	try {
		const res = await os.decisionClient.decide({
			state,
			questions: {
				initial_topology: {
					type: "choice",
					instructions: "Which swarm execution structure fits this workspace and goal best?",
					criteria: NEUTRAL_TOPOLOGY_CRITERIA,
				},
				enable_wave1_field_guide: {
					type: "noul",
					instructions: "Does this workspace lack clear top-level spec/test docs such that injecting a Wave-1 Field Guide will help more than it costs in prompt overhead?",
				},
				enable_llm_dreaming: {
					type: "noul",
					instructions: "Would semantic LLM wave-boundary dreaming consolidation meaningfully improve multi-wave synthesis on this task?",
				},
				enable_board: {
					type: "noul",
					instructions: "Should workers actively share discoveries and dead-ends via Board v3 channels during execution?",
				},
				estimate_first_principles_bound: {
					type: "noul",
					instructions: "Would deriving a serial Phase-0 2-tier Roofline bound (hard speed-of-light ceiling + current-paradigm bottleneck ceiling + breakable assumptions) help guide initial search strategy and paradigm shifts?",
				},
				initial_width_tier: {
					type: "choice",
					instructions: "What initial parallel worker width tier fits this workload best?",
					criteria: {
						narrow: "Small focused parallelism (2 workers)",
						balanced: "Standard parallelism (4 workers)",
						wide: "High parallelism (6-8 workers)",
					},
				},
			},
			signal: params.signal,
		});

		os.bus.emit(os.runId, "decision.evaluated", {
			purpose: "adaptive_preflight_router",
			provider: res.provider,
			model: res.model,
			questionCount: 6,
			inputTokens: res.inputTokens,
			latencyMs: res.latencyMs,
		});

		const topoAns = getChoiceAnswer(res.answers, "initial_topology");
		const fgAns = getNoulAnswer(res.answers, "enable_wave1_field_guide");
		const dreamAns = getNoulAnswer(res.answers, "enable_llm_dreaming");
		const boardAns = getNoulAnswer(res.answers, "enable_board");
		const boundAns = getNoulAnswer(res.answers, "estimate_first_principles_bound");
		const widthAns = getChoiceAnswer(res.answers, "initial_width_tier");

		let delegate: AdaptiveDelegateName =
			topoAns && VALID_DELEGATES.has(topoAns.choice as AdaptiveDelegateName) && topoAns.confidence >= minConf
				? (topoAns.choice as AdaptiveDelegateName)
				: fallback.delegate;

		if (params.hasSeatConfigs && delegate !== "elastic-phase" && delegate !== "substrate-peers") {
			delegate = "elastic-phase";
		}

		const widthMultiplier =
			widthAns && widthAns.confidence >= minConf
				? widthAns.choice === "wide"
					? 1.5
					: widthAns.choice === "narrow"
						? 0.5
						: 1
				: 1;

		const enableWave1FieldGuide =
			fgAns && fgAns.confidence >= minConf ? fgAns.p >= 0.55 : undefined;
		const dreamingMode: "deterministic" | "llm" =
			dreamAns && dreamAns.confidence >= minConf && dreamAns.p >= 0.65 ? "llm" : "deterministic";
		const enableBoard =
			params.hasSeatConfigs || (boardAns && boardAns.confidence >= minConf ? boardAns.p >= 0.5 : delegate !== "evolution");
		const estimateBounds =
			boundAns && boundAns.confidence >= minConf ? boundAns.p >= 0.65 : fallback.regime === "scalar-optimization";

		const usedDecisionModel = Boolean(topoAns && topoAns.confidence >= minConf);
		return {
			source: usedDecisionModel ? "decision-model" : "structural-heuristic",
			regime: fallback.regime,
			delegate,
			enableWave1FieldGuide,
			dreamingMode,
			enableBoard,
			estimateBounds,
			widthMultiplier,
			confidence: topoAns?.confidence ?? 0.5,
			reason: usedDecisionModel
				? `Jev Meta-Router selected ${delegate} (conf=${topoAns!.confidence.toFixed(2)}, wave1FG=${enableWave1FieldGuide ?? "default"}, dream=${dreamingMode}, bound=${estimateBounds})`
				: `Low Jev confidence (${(topoAns?.confidence ?? 0).toFixed(2)} < ${minConf}) -> fallback: ${fallback.reason}`,
		};
	} catch {
		return {
			source: "structural-heuristic",
			regime: fallback.regime,
			delegate: fallback.delegate,
			dreamingMode: "deterministic",
			enableBoard: fallback.delegate !== "evolution",
			estimateBounds: fallback.regime === "scalar-optimization",
			widthMultiplier: 1,
			confidence: 0.5,
			reason: `Decision model error -> fallback: ${fallback.reason}`,
		};
	}
}

async function runDelegateTopology(
	delegate: AdaptiveDelegateName,
	os: SwarmOsApi,
	opts: AdaptiveTopologyOptions,
	plan: AdaptiveExecutionPlan,
	input: { goal: string; rubric?: string; signal: AbortSignal; closeoutSignal?: AbortSignal },
): Promise<TopologyOutcome> {
	const baseWidth = opts.peers ?? opts.maxWorkers ?? opts.seatConfigs?.length ?? 4;
	const scaledWidth = opts.seatConfigs?.length
		? opts.seatConfigs.length
		: Math.max(2, Math.round(baseWidth * plan.widthMultiplier));

	switch (delegate) {
		case "evolution": {
			const evoOpts: EvolutionTopologyOptions = {
				populationPerGen: opts.populationPerGen ?? scaledWidth,
				generations: opts.generations ?? "unbounded",
				estimateBounds: opts.estimateBounds ?? plan.estimateBounds,
				controlMode: opts.controlMode ?? os.controlMode,
				checkpointPolicy: opts.checkpointPolicy,
				onHumanCheckpoint: opts.onHumanCheckpoint,
				dreamingMode: plan.dreamingMode,
				enableBoard: plan.enableBoard,
			};
			return evolutionTopology(evoOpts).run(os, input);
		}
		case "recursive-planners":
			return recursivePlannersTopology({
				enableSemanticRepair: opts.enableSemanticRepair,
				dreamingMode: plan.dreamingMode,
			}).run(os, input);
		case "substrate-peers":
			return substratePeersTopology({
				peers: scaledWidth,
				seatConfigs: opts.seatConfigs,
				enableSemanticRepair: opts.enableSemanticRepair,
				allowPeerSpawning: !opts.seatConfigs?.length,
			}).run(os, input);
		case "pull-refinery":
			return pullRefineryTopology({
				concurrency: scaledWidth,
				enableSemanticRepair: opts.enableSemanticRepair,
			}).run(os, input);
		case "elastic-phase": {
			const elasticOpts: ElasticPhaseOptions = {
				peers: scaledWidth,
				maxWorkers: scaledWidth,
				seatConfigs: opts.seatConfigs,
				enableDreaming: opts.enableDreaming,
				enableSemanticRepair: opts.enableSemanticRepair,
			};
			return elasticPhaseTopology(elasticOpts).run(os, input);
		}
		case "hierarchy":
			return hierarchyTopology({
				maxWorkers: scaledWidth,
				recursive: true,
			}).run(os, input);
		default:
			return assertNever(delegate, "Unhandled AdaptiveDelegateName");
	}
}

/**
 * Adaptive Meta-Router Topology (v4):
 * - Uses TypeSafe Jev (`os.decisionClient`) with strictly neutral structure-only topology descriptions
 *   (zero task-domain biasing or heuristic leakage).
 * - Bus-driven `LiveMorphWatchdog` detects mid-flight distress (consecutive un-repaired rollbacks or stall bursts)
 *   while real wall/token budget remains, aborts the stalling delegate via a child AbortController (preserving commits),
 *   and pivots live before closeout reserve hits—plus retains post-hoc fallback morphing.
 */
export function adaptiveTopology(opts: AdaptiveTopologyOptions = {}): TopologyPlugin {
	return {
		name: "adaptive",
		description: "Unbiased System-1 Decision-Model Meta-Router with live bus-driven mid-run morphing and composable sub-topologies.",
		async run(os: SwarmOsApi, { goal, rubric, signal, closeoutSignal }): Promise<TopologyOutcome> {
			const hasSeatConfigs = Boolean(opts.seatConfigs && opts.seatConfigs.length > 0);
			const plan = await resolveAdaptiveExecutionPlan(os, {
				workspaceDir: os.worktrees.trunkPath,
				goal,
				rubric,
				hasSeatConfigs,
				minConfidence: opts.minDecisionConfidence,
				signal,
			});

			if (opts.enableFieldGuideOverride !== undefined) {
				os.setFieldGuideEnabled?.(opts.enableFieldGuideOverride);
			} else if (plan.enableWave1FieldGuide !== undefined) {
				os.setFieldGuideEnabled?.(plan.enableWave1FieldGuide);
			}

			os.bus.emit(os.runId, "phase.changed", {
				to: `adaptive:${plan.delegate}`,
				reason: `[${plan.source}/${plan.regime}] ${plan.reason}`,
			});

			const allowMorph = (opts.enableMidRunMorph ?? true) && Boolean(os.decisionClient) && !hasSeatConfigs;
			const minConf = opts.minDecisionConfidence ?? 0.55;
			const firstAbort = new AbortController();
			const firstSignal = AbortSignal.any([signal, firstAbort.signal]);
			let liveMorphTarget: { readonly target: AdaptiveDelegateName; readonly confidence: number; readonly reason: string } | undefined;
			let liveMorphCheckInFlight = false;
			let consecutiveUnrepairedRollbacks = 0;
			let liveStalls = 0;
			let liveConflicts = 0;

			const initialWallBudgetMs = os.remainingWallMs?.();
			const unsubWatchdog = allowMorph
				? os.bus.on((ev) => {
					if (ev.runId !== os.runId || liveMorphTarget || liveMorphCheckInFlight || signal.aborted || os.isInCloseoutReserve()) {
						return;
					}
					if (ev.type === "refinery.semantic_regression") {
						if (ev.data.repaired === true) {
							consecutiveUnrepairedRollbacks = 0;
						} else if (ev.data.rolledBack === true) {
							consecutiveUnrepairedRollbacks += 1;
						}
					} else if (ev.type === "agent.stalled") {
						liveStalls += 1;
					} else if (ev.type === "peer.conflict_detected" || ev.type === "refinery.conflict_resolved") {
						liveConflicts += 1;
					} else {
						return;
					}

					const remWall = os.remainingWallMs?.();
					const enoughWallLeft =
						remWall === undefined ||
						initialWallBudgetMs === undefined ||
						remWall > initialWallBudgetMs * 0.30;
					const distressTripped =
						enoughWallLeft &&
						(consecutiveUnrepairedRollbacks >= 2 || liveStalls >= 2 || liveConflicts >= 3);
					if (!distressTripped) return;

					liveMorphCheckInFlight = true;
					void os.decisionClient!
						.decide({
							state: [
								`Goal: ${goal}`,
								`Live Delegate In-Flight: ${plan.delegate}`,
								`Live Distress Signals: consecutiveUnrepairedRollbacks=${consecutiveUnrepairedRollbacks}, stalls=${liveStalls}, mergeConflicts=${liveConflicts}, remainingWallMs=${remWall ?? "unbounded"}`,
							].join("\n"),
							questions: {
								should_pivot_to_evolution: {
									type: "noul",
									instructions: "Should we abort the stalling delegate mid-flight and morph to async Director-led `evolution` now while budget remains?",
								},
								should_widen_with_recursive_planners: {
									type: "noul",
									instructions: "Should we abort the stalling delegate mid-flight and morph to `recursive-planners` now while budget remains?",
								},
							},
							signal,
						})
						.then((morphRes) => {
							os.bus.emit(os.runId, "decision.evaluated", {
								purpose: "adaptive_live_morph_watchdog",
								provider: morphRes.provider,
								model: morphRes.model,
								questionCount: 2,
								inputTokens: morphRes.inputTokens,
								latencyMs: morphRes.latencyMs,
							});
							const pivotEvo = getNoulAnswer(morphRes.answers, "should_pivot_to_evolution");
							const pivotRec = getNoulAnswer(morphRes.answers, "should_widen_with_recursive_planners");
							if (plan.delegate !== "evolution" && pivotEvo && pivotEvo.p >= 0.72 && pivotEvo.confidence >= minConf) {
								liveMorphTarget = {
									target: "evolution",
									confidence: pivotEvo.confidence,
									reason: `LiveMorphWatchdog pivoted mid-flight -> evolution (P=${pivotEvo.p.toFixed(2)}, rollbacks=${consecutiveUnrepairedRollbacks}, stalls=${liveStalls})`,
								};
								firstAbort.abort(new Error(liveMorphTarget.reason));
							} else if (plan.delegate !== "recursive-planners" && pivotRec && pivotRec.p >= 0.72 && pivotRec.confidence >= minConf) {
								liveMorphTarget = {
									target: "recursive-planners",
									confidence: pivotRec.confidence,
									reason: `LiveMorphWatchdog pivoted mid-flight -> recursive-planners (P=${pivotRec.p.toFixed(2)}, stalls=${liveStalls})`,
								};
								firstAbort.abort(new Error(liveMorphTarget.reason));
							}
						})
						.catch(() => {})
						.finally(() => {
							liveMorphCheckInFlight = false;
						});
				})
				: undefined;

			let firstOut: TopologyOutcome;
			try {
				firstOut = await runDelegateTopology(plan.delegate, os, opts, plan, {
					goal,
					rubric,
					signal: firstSignal,
					closeoutSignal,
				});
			} finally {
				unsubWatchdog?.();
			}

			if (liveMorphTarget && !signal.aborted && !os.isInCloseoutReserve()) {
				os.bus.emit(os.runId, "adaptive.morphed", {
					from: plan.delegate,
					to: liveMorphTarget.target,
					reason: liveMorphTarget.reason,
					confidence: liveMorphTarget.confidence,
					live: true,
				});
				const morphedOut = await runDelegateTopology(
					liveMorphTarget.target,
					os,
					opts,
					{ ...plan, delegate: liveMorphTarget.target },
					{ goal, rubric, signal, closeoutSignal },
				);
				return {
					...morphedOut,
					summary: `Adaptive[${plan.delegate} -> live-morphed:${liveMorphTarget.target}]: ${morphedOut.summary}`,
				};
			}

			const bestAfterFirst = os.trust.bestVerifiedFinding(os.runId);
			if (allowMorph && !bestAfterFirst && !signal.aborted && !os.isInCloseoutReserve()) {
				const events = os.store.events(os.runId);
				const conflicts = events.filter((e) => e.type === "peer.conflict_detected" || e.type === "refinery.conflict_resolved").length;
				const semanticRegs = events.filter((e) => e.type === "refinery.semantic_regression").length;
				const stalls = events.filter((e) => e.type === "agent.stalled").length;
				const findings = os.store.list("findings", { runId: os.runId });
				const bestRawScore = findings.reduce((m, f) => Math.max(m, f.score ?? -Infinity), -Infinity);
				const remWall = os.remainingWallMs?.();

				try {
					const morphRes = await os.decisionClient!.decide({
						state: [
							`Goal: ${goal}`,
							`Initial Topology: ${plan.delegate} (finished without accepted verified deliverable)`,
							`Live Telemetry: findings=${findings.length}, bestRawScore=${Number.isFinite(bestRawScore) ? bestRawScore.toFixed(4) : "none"}, mergeConflicts=${conflicts}, semanticRegressions=${semanticRegs}, stalledAgents=${stalls}, remainingWallMs=${remWall ?? "unbounded"}`,
							`Initial Summary: ${firstOut.summary.slice(0, 500)}`,
						].join("\n"),
						questions: {
							should_pivot_to_evolution: {
								type: "noul",
								instructions: "Should the swarm morph to async Director-led `evolution` search to recover from merge conflicts, semantic regressions, or decomposition stalls?",
							},
							should_widen_with_recursive_planners: {
								type: "noul",
								instructions: "Should the swarm morph to `recursive-planners` to dynamically restructure and widen exploration of this problem?",
							},
						},
						signal,
					});

					os.bus.emit(os.runId, "decision.evaluated", {
						purpose: "adaptive_midrun_morph",
						provider: morphRes.provider,
						model: morphRes.model,
						questionCount: 2,
						inputTokens: morphRes.inputTokens,
						latencyMs: morphRes.latencyMs,
					});

					const pivotEvo = getNoulAnswer(morphRes.answers, "should_pivot_to_evolution");
					const pivotRec = getNoulAnswer(morphRes.answers, "should_widen_with_recursive_planners");

					type MidRunMorphDecision = Exclusive<
						| { readonly morph: false }
						| {
							readonly morph: true;
							readonly target: AdaptiveDelegateName;
							readonly confidence: number;
							readonly reason: string;
						}
					>;
					let decision: MidRunMorphDecision = { morph: false };
					if (plan.delegate !== "evolution" && pivotEvo && pivotEvo.p >= 0.72 && pivotEvo.confidence >= minConf) {
						decision = {
							morph: true,
							target: "evolution",
							confidence: pivotEvo.confidence,
							reason: `Jev mid-run morph -> evolution (P=${pivotEvo.p.toFixed(2)}, conflicts=${conflicts}, semanticRegs=${semanticRegs})`,
						};
					} else if (plan.delegate !== "recursive-planners" && pivotRec && pivotRec.p >= 0.72 && pivotRec.confidence >= minConf) {
						decision = {
							morph: true,
							target: "recursive-planners",
							confidence: pivotRec.confidence,
							reason: `Jev mid-run morph -> recursive-planners (P=${pivotRec.p.toFixed(2)}, stalls=${stalls})`,
						};
					}

					if (decision.morph) {
						os.bus.emit(os.runId, "adaptive.morphed", {
							from: plan.delegate,
							to: decision.target,
							reason: decision.reason,
							confidence: decision.confidence,
							live: false,
						});
						const morphedOut = await runDelegateTopology(
							decision.target,
							os,
							{ ...opts, generations: decision.target === "evolution" ? 1 : opts.generations },
							{ ...plan, delegate: decision.target },
							{ goal, rubric, signal, closeoutSignal },
						);
						return {
							...morphedOut,
							summary: `Adaptive[${plan.delegate} -> morphed:${decision.target}]: ${morphedOut.summary}`,
						};
					}
				} catch {
					// Non-fatal: keep firstOut cleanly.
				}
			}

			return {
				...firstOut,
				summary: `Adaptive[${plan.source}:${plan.regime} -> ${plan.delegate}]: ${firstOut.summary}`,
			};
		},
	};
}
