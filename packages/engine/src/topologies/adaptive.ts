import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
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

/**
 * Adaptive Meta-Router Topology:
 * Uses a zero-token pre-flight classifier to route each workload to the topology that
 * empirically dominates its structural regime (sharded consensus vs scalar optimization
 * vs tightly coupled single-context SWE vs multi-phase/loosely-coupled/broader repos).
 */
export function adaptiveTopology(opts: AdaptiveTopologyOptions = {}): TopologyPlugin {
	return {
		name: "adaptive",
		description: "Zero-token pre-flight structural regime classifier routing sharded/staged/broad workloads to elastic-phase and compact scalar-opt/coupled repos to evolution.",
		async run(os: SwarmOsApi, { goal, rubric, signal, closeoutSignal }): Promise<TopologyOutcome> {
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
				const out = await evolutionTopology(evoOpts).run(os, { goal, rubric, signal, closeoutSignal });
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
			const out = await elasticPhaseTopology(elasticOpts).run(os, { goal, rubric, signal, closeoutSignal });
			return {
				...out,
				summary: `Adaptive[${cls.regime} -> elastic-phase]: ${out.summary}`,
			};
		},
	};
}
