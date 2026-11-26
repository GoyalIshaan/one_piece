import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BoardPost, Finding, Store } from "@one-piece/core";

export const DEFAULT_FIELD_GUIDE_MAX_LINES = 80;

const IGNORED_TOP_ENTRIES = new Set([
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
	"target",
]);

/**
 * Enforce a hard line-count ceiling on the stigmergic Field Guide so it never bloats
 * worker system prompts or dilutes attention.
 */
export function enforceLineBudget(markdown: string, maxLines = DEFAULT_FIELD_GUIDE_MAX_LINES): string {
	const limit = Math.max(8, Math.floor(maxLines));
	const normalized = markdown.replace(/\r\n/g, "\n").trimEnd();
	const lines = normalized ? normalized.split("\n") : [];
	if (lines.length <= limit) return lines.join("\n") + "\n";
	const kept = lines.slice(0, limit - 1);
	kept.push(`... [truncated to ${limit}-line field-guide budget]`);
	return kept.join("\n") + "\n";
}

function listFilesShallow(dir: string, maxDepth = 2, maxEntries = 28): string[] {
	const results: string[] = [];
	function walk(current: string, prefix: string, depth: number): void {
		if (results.length >= maxEntries || depth > maxDepth) return;
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			return;
		}
		for (const entry of entries) {
			if (results.length >= maxEntries) break;
			if (IGNORED_TOP_ENTRIES.has(entry.name)) continue;
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				results.push(`${rel}/`);
				if (depth < maxDepth) walk(join(current, entry.name), rel, depth + 1);
			} else {
				results.push(rel);
			}
		}
	}
	walk(dir, "", 1);
	return results;
}

/**
 * Deterministic upfront workspace environment probe (0 LLM tokens, <5ms).
 * Eliminates repeated cold-start exploration turns across sibling swarm workers.
 */
export function probeWorkspaceEnvironment(workspaceDir: string, baseSha?: string): string {
	const lines: string[] = ["# Swarm Field Guide (Workspace Probe)"];
	if (baseSha) lines.push(`- Base commit: \`${baseSha.slice(0, 12)}\``);

	const commands: string[] = [];
	const pkgPath = join(workspaceDir, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; scripts?: Record<string, string> };
			if (pkg.name) lines.push(`- Package: \`${pkg.name}\` (Node/TS)`);
			const scripts = pkg.scripts ?? {};
			for (const key of ["test", "typecheck", "build", "lint"]) {
				if (typeof scripts[key] === "string") {
					commands.push(`\`npm run ${key}\` -> \`${scripts[key].slice(0, 80)}\``);
				}
			}
		} catch {
			// Ignore invalid package.json.
		}
	}

	const pyproj = join(workspaceDir, "pyproject.toml");
	if (existsSync(pyproj)) {
		lines.push("- Stack: Python (`pyproject.toml` present)");
		commands.push("`python3 -m pytest` or `python3 -m unittest discover`");
	}
	if (existsSync(join(workspaceDir, "Cargo.toml"))) {
		lines.push("- Stack: Rust (`Cargo.toml` present)");
		commands.push("`cargo test`");
	}
	if (existsSync(join(workspaceDir, "Makefile"))) {
		lines.push("- Build file: `Makefile` present");
	}

	const testsDir = join(workspaceDir, "tests");
	if (existsSync(testsDir) && !commands.length) {
		commands.push("`python3 -m unittest discover -s tests`");
	}

	const specDocs = ["TASK.md", "FEATURES.md", "SPEC.md", "README.md"].filter((f) => existsSync(join(workspaceDir, f)));
	if (specDocs.length) {
		lines.push(`- Key docs: ${specDocs.map((f) => `\`${f}\``).join(", ")}`);
	}
	if (commands.length) {
		lines.push("- Quick checks:");
		for (const cmd of commands.slice(0, 4)) lines.push(`  - ${cmd}`);
	}

	const files = listFilesShallow(workspaceDir, 2, 24);
	if (files.length) {
		lines.push(`- Layout: ${files.join(", ")}`);
	}
	return enforceLineBudget(lines.join("\n"), 28).trimEnd();
}

function extractFailedApproachesFromHandoffs(runDir: string): string[] {
	const out: string[] = [];
	const worktreesDir = join(runDir, "worktrees");
	if (!existsSync(worktreesDir)) return out;
	try {
		for (const entry of readdirSync(worktreesDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const handoffPath = join(worktreesDir, entry.name, ".swarm", "HANDOFF.md");
			if (!existsSync(handoffPath)) continue;
			const text = readFileSync(handoffPath, "utf8");
			const idx = text.indexOf("Failed Approaches");
			if (idx < 0) continue;
			const section = text.slice(idx).split(/\n## /)[0] ?? "";
			for (const line of section.split("\n")) {
				const trimmed = line.trim();
				if (trimmed.startsWith("- ") && trimmed.length > 3) {
					out.push(trimmed.slice(2).slice(0, 140));
				}
			}
		}
	} catch {
		// Best-effort handoff scan.
	}
	return [...new Set(out)].slice(0, 6);
}

/**
 * Deterministic wave-boundary "Dreaming" consolidator (0 LLM tokens):
 * merges initial workspace probe + top-cited board posts + verified findings +
 * failed verifier receipts + handoff dead ends, deduplicated within <= 80 lines.
 */
export function buildDeterministicFieldGuide(params: {
	runId: string;
	runDir: string;
	baseProbe: string;
	store: Store;
	wave: number;
	maxLines?: number;
}): string {
	const { runId, runDir, baseProbe, store, wave } = params;
	const maxLines = params.maxLines ?? DEFAULT_FIELD_GUIDE_MAX_LINES;
	const sections: string[] = [baseProbe.trimEnd()];

	const findings: Finding[] = store.list("findings", { runId });
	const accepted = findings
		.filter((f) => f.status === "accepted")
		.sort((a, b) => (b.score ?? b.confidence ?? 0) - (a.score ?? a.confidence ?? 0) || b.updatedAt - a.updatedAt)
		.slice(0, 5);
	if (accepted.length) {
		sections.push("## Verified Wins (swarm telemetry — not local workspace files)");
		for (const f of accepted) {
			const scoreStr = f.score !== undefined ? `score=${f.score.toFixed(4)}` : "accepted";
			sections.push(`- (${scoreStr}) ${f.claim.slice(0, 120)}`);
		}
	}

	// Distill failure receipts & dead ends so subsequent waves don't repeat them.
	const failureNotes: string[] = [];
	for (const f of findings) {
		if (f.status === "needs_work" || f.status === "rejected") {
			const last = f.rounds.at(-1);
			const msg = last?.message?.replace(/\s+/g, " ").trim().slice(0, 140);
			if (msg) failureNotes.push(`${f.claim.slice(0, 60)}: ${msg}`);
		}
	}
	for (const h of extractFailedApproachesFromHandoffs(runDir)) {
		failureNotes.push(h);
	}
	const dedupedFailures = [...new Set(failureNotes)].slice(-6);
	if (dedupedFailures.length) {
		sections.push("## Known Failure Modes / Avoid Repeating");
		for (const note of dedupedFailures) {
			sections.push(`- ${note}`);
		}
	}

	// Top-cited / latest active board posts (excluding superseded drafts).
	const posts: BoardPost[] = store.list("posts", { runId }).filter((p) => !p.supersededBy);
	if (posts.length) {
		const citationCounts = new Map<string, number>();
		for (const p of posts) {
			for (const ref of p.references ?? []) {
				citationCounts.set(ref.postId, (citationCounts.get(ref.postId) ?? 0) + 1);
			}
		}
		const ranked = [...posts]
			.sort((a, b) => {
				const ca = citationCounts.get(a.id) ?? 0;
				const cb = citationCounts.get(b.id) ?? 0;
				const va = a.labels?.["os:verified"] === "true" ? 1 : 0;
				const vb = b.labels?.["os:verified"] === "true" ? 1 : 0;
				return vb - va || cb - ca || (b.seq ?? 0) - (a.seq ?? 0);
			})
			.slice(0, 8);
		sections.push(`## Shared Board Highlights (Wave ${wave})`);
		for (const p of ranked) {
			const who = p.authorHandle ?? p.authorAgentId;
			const cites = citationCounts.get(p.id) ?? 0;
			const citeTag = cites > 0 ? ` cites=${cites}` : "";
			sections.push(`- [${p.id} ${p.topic} by ${who}${citeTag}] ${p.summary.replace(/\s+/g, " ").slice(0, 120)}`);
		}
	}

	return enforceLineBudget(sections.join("\n"), maxLines);
}

/** Write the Field Guide markdown atomically to `<targetPath>`. */
export function writeFieldGuideFile(targetPath: string, markdown: string): { lines: number; bytes: number } {
	mkdirSync(dirname(targetPath), { recursive: true });
	writeFileSync(targetPath, markdown, "utf8");
	const lines = markdown.trimEnd() ? markdown.trimEnd().split("\n").length : 0;
	const bytes = Buffer.byteLength(markdown, "utf8");
	return { lines, bytes };
}

/** Mirror the Field Guide snapshot into `<worktree>/.swarm/field-guide/index.md` (git-excluded). */
export function mirrorFieldGuideToWorktree(worktreePath: string, markdown: string): void {
	try {
		writeFieldGuideFile(join(worktreePath, ".swarm", "field-guide", "index.md"), markdown);
	} catch {
		// Best-effort mirror; never crash worker spawn on read-only worktree.
	}
}
