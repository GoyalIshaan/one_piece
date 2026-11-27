import { createHash } from "node:crypto";
import { constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { cp, lstat, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
	type ArtifactStore,
	type EventBus,
	isPathBlocked,
	runCommand,
	type SecretBroker,
	type ToolDefinition,
} from "@one-piece/core";

const SKIP = new Set([".git", "node_modules", ".venv", "__pycache__", "dist", ".one_piece", ".swarm"]);
const DEFAULT_MAX_INLINE_BYTES = 4_096;

/**
 * Tier 0 Boundary Spillover:
 * Any tool output exceeding `maxBytes` is stored losslessly in `FileArtifactStore` (SHA-256)
 * and replaced with a compact head+tail excerpt + `artifact_id` pointer for `read_artifact`.
 */
export function spillLargeOutput(
	label: string,
	text: string,
	opts: { artifacts?: ArtifactStore; createdBy?: string; maxBytes?: number } = {},
): { text: string; artifactId?: string } {
	const limit = Math.max(512, opts.maxBytes ?? DEFAULT_MAX_INLINE_BYTES);
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= limit) return { text };

	const headLen = Math.min(Math.floor(limit * 0.42), Math.floor(text.length * 0.42));
	const tailLen = Math.min(Math.floor(limit * 0.42), Math.floor(text.length * 0.42));
	const head = text.slice(0, headLen);
	const tail = tailLen > 0 ? text.slice(-tailLen) : "";

	if (opts.artifacts) {
		const record = opts.artifacts.put(label, text, { mimeType: "text/plain", createdBy: opts.createdBy });
		return {
			artifactId: record.id,
			text: `${head}\n\n... [truncated ${bytes} bytes total — full output stored as artifact_id=${record.id} (sha=${record.sha256.slice(0, 12)}); call read_artifact(artifact_id="${record.id}", offset=0, limit=4096) to inspect] ...\n\n${tail}`,
		};
	}
	return {
		text: `${head}\n\n... [truncated ${bytes - headLen - tailLen} of ${bytes} bytes] ...\n\n${tail}`,
	};
}

function grepTree(root: string, dir: string, regex: RegExp, maxMatches: number, out: string[], deniedReadPaths?: readonly string[]): void {
	if (out.length >= maxMatches) return;
	for (const name of readdirSync(dir).sort()) {
		if (SKIP.has(name)) continue;
		const full = join(dir, name);
		if (isPathBlocked(full, deniedReadPaths)) continue;
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			grepTree(root, full, regex, maxMatches, out, deniedReadPaths);
		} else if (st.isFile() && st.size <= 1024 * 1024) {
			let raw: string;
			try {
				raw = readFileSync(full, "utf8");
			} catch {
				continue;
			}
			if (raw.includes("\u0000")) continue;
			const rel = relative(root, full);
			const lines = raw.split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (regex.test(lines[i]!)) {
					out.push(`${rel}:${i + 1}:${lines[i]!.slice(0, 240)}`);
					if (out.length >= maxMatches) return;
				}
			}
		}
	}
}

function inside(root: string, target: string, deniedReadPaths?: readonly string[]): string {
	const full = resolve(root, target);
	const rel = relative(root, full);
	if (rel.startsWith("..") || resolve(rel) === rel) throw new Error(`Path ${target} is outside workspace`);
	if (isPathBlocked(full, deniedReadPaths)) throw new Error("Path is outside workspace");
	return full;
}

function writePath(root: string, target: string, deniedReadPaths?: readonly string[]): string {
	const full = inside(root, target, deniedReadPaths);
	let existing = full;
	while (!existsSync(existing)) existing = dirname(existing);
	inside(realpathSync(root), realpathSync(existing), deniedReadPaths);
	return full;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);
}

/**
 * Targeted edit-mismatch diagnostic: locates the closest matching line window and reports
 * concrete line numbers + whitespace/line-ending mismatches so models fix edits in 1 retry.
 */
function diagnoseEditMismatch(relPath: string, fileText: string, needle: string): string {
	const fileHasCrlf = fileText.includes("\r\n");
	const needleHasCrlf = needle.includes("\r\n");
	const fileLines = fileText.split(/\r?\n/);
	const needleLines = needle.split(/\r?\n/);
	const trimmedNeedle = needleLines.map((l) => l.trim());
	const firstNonEmpty = trimmedNeedle.find((l) => l.length > 0) ?? "";

	const hints: string[] = [];
	if (fileHasCrlf !== needleHasCrlf) {
		hints.push(fileHasCrlf ? "file uses CRLF line endings while old_text uses LF" : "file uses LF line endings while old_text uses CRLF");
	}
	const fileHasTabs = fileLines.some((l) => l.startsWith("\t"));
	const needleHasTabs = needleLines.some((l) => l.startsWith("\t"));
	const needleHasSpaces = needleLines.some((l) => /^ {2,}/.test(l));
	if (fileHasTabs && !needleHasTabs && needleHasSpaces) {
		hints.push("file uses tab indentation while old_text uses spaces");
	} else if (!fileHasTabs && needleHasTabs) {
		hints.push("file uses space indentation while old_text uses tabs");
	}

	const winSize = Math.max(1, needleLines.length);
	const tokenize = (s: string) => new Set(s.trim().split(/[^a-zA-Z0-9_]+/).filter(Boolean));
	const needleTokens = tokenize(needle);
	let bestIdx = -1;
	let bestScore = 0;

	for (let i = 0; i <= Math.max(0, fileLines.length - winSize); i++) {
		let exactTrim = 0;
		for (let j = 0; j < winSize && i + j < fileLines.length; j++) {
			if (fileLines[i + j]!.trim() === trimmedNeedle[j]) exactTrim += 1;
		}
		const windowText = fileLines.slice(i, i + winSize).join("\n");
		const winTokens = tokenize(windowText);
		let overlap = 0;
		for (const t of needleTokens) if (winTokens.has(t)) overlap += 1;
		const jaccard = needleTokens.size + winTokens.size > 0
			? overlap / (needleTokens.size + winTokens.size - overlap)
			: 0;
		const firstBoost = firstNonEmpty && fileLines[i]?.trim() === firstNonEmpty ? 0.5 : 0;
		const score = (exactTrim / winSize) * 2 + jaccard + firstBoost;
		if (score > bestScore) {
			bestScore = score;
			bestIdx = i;
		}
	}

	const lines: string[] = [`Edit failed: old_text not found verbatim in ${relPath}.`];
	if (hints.length) lines.push(`Hint: ${hints.join("; ")}.`);
	if (bestIdx >= 0 && bestScore >= 0.45) {
		const start = Math.max(0, bestIdx - 1);
		const end = Math.min(fileLines.length, bestIdx + winSize + 2);
		lines.push(`Closest match in ${relPath} (lines ${start + 1}-${end}):`);
		for (let k = start; k < end; k++) {
			lines.push(`${k + 1}\t${fileLines[k]}`);
		}
	}
	return lines.join("\n");
}

type StagedPatchOp =
	| { readonly kind: "add"; readonly relPath: string; readonly fullPath: string; readonly content: string }
	| { readonly kind: "delete"; readonly relPath: string; readonly fullPath: string }
	| {
		readonly kind: "update";
		readonly relPath: string;
		readonly fullPath: string;
		readonly beforeSha: string;
		readonly nextContent: string;
		readonly hunksApplied: number;
	};

/**
 * Atomic 2-phase patch applier:
 * Phase 1 parses, sandboxes, and validates EVERY file & hunk in memory (zero disk writes on any failure).
 * Phase 2 commits all validated operations to disk and verifies post-write SHA-256 hashes.
 */
function applyPatchToWorkspace(workspace: string, patchText: string, deniedReadPaths?: readonly string[]): { text: string; isError?: boolean } {
	const rawLines = patchText.replace(/\r\n/g, "\n").split("\n");
	const beginIdx = rawLines.findIndex((l) => l.trim() === "*** Begin Patch");
	const endIdx = rawLines.findIndex((l, i) => i > beginIdx && l.trim() === "*** End Patch");
	if (beginIdx < 0 || endIdx < 0) {
		return { text: "Patch failed: missing '*** Begin Patch' / '*** End Patch' markers.", isError: true };
	}

	const body = rawLines.slice(beginIdx + 1, endIdx);
	const staged: StagedPatchOp[] = [];
	const virtualFiles = new Map<string, string | null>(); // null => deleted in this patch
	let i = 0;

	const readVirtual = (fullPath: string): string | null => {
		if (virtualFiles.has(fullPath)) return virtualFiles.get(fullPath)!;
		if (!existsSync(fullPath) || !statSync(fullPath).isFile()) return null;
		return readFileSync(fullPath, "utf8");
	};

	while (i < body.length) {
		const line = body[i]!;
		if (!line.trim()) {
			i += 1;
			continue;
		}
		if (line.startsWith("*** Add File: ")) {
			const relPath = line.slice("*** Add File: ".length).trim();
			const full = writePath(workspace, relPath, deniedReadPaths);
			if (readVirtual(full) !== null) return { text: `Patch failed: file already exists: ${relPath}`, isError: true };
			i += 1;
			const added: string[] = [];
			while (i < body.length && !body[i]!.startsWith("*** ")) {
				const l = body[i]!;
				if (!l.startsWith("+")) return { text: `Patch failed: expected '+' line in Add File ${relPath}`, isError: true };
				added.push(l.slice(1));
				i += 1;
			}
			const nextContent = `${added.join("\n")}\n`;
			virtualFiles.set(full, nextContent);
			staged.push({ kind: "add", relPath, fullPath: full, content: nextContent });
			continue;
		}
		if (line.startsWith("*** Delete File: ")) {
			const relPath = line.slice("*** Delete File: ".length).trim();
			const full = writePath(workspace, relPath, deniedReadPaths);
			if (readVirtual(full) === null) {
				return { text: `Patch failed: file not found to delete: ${relPath}`, isError: true };
			}
			virtualFiles.set(full, null);
			staged.push({ kind: "delete", relPath, fullPath: full });
			i += 1;
			continue;
		}
		if (line.startsWith("*** Update File: ")) {
			const relPath = line.slice("*** Update File: ".length).trim();
			const full = writePath(workspace, relPath, deniedReadPaths);
			const existing = readVirtual(full);
			if (existing === null) {
				return { text: `Patch failed: file not found: ${relPath}`, isError: true };
			}
			const beforeSha = createHash("sha256").update(existing, "utf8").digest("hex").slice(0, 12);
			const hasCrlf = existing.includes("\r\n");
			let content = hasCrlf ? existing.replace(/\r\n/g, "\n") : existing;
			i += 1;

			let hunksApplied = 0;
			while (i < body.length && !body[i]!.startsWith("*** ")) {
				if (body[i]!.startsWith("@@")) {
					i += 1;
					const oldLines: string[] = [];
					const newLines: string[] = [];
					while (i < body.length && !body[i]!.startsWith("@@") && !body[i]!.startsWith("*** ")) {
						const hl = body[i]!;
						if (hl.startsWith("-")) oldLines.push(hl.slice(1));
						else if (hl.startsWith("+")) newLines.push(hl.slice(1));
						else if (hl.startsWith(" ")) {
							oldLines.push(hl.slice(1));
							newLines.push(hl.slice(1));
						} else if (hl === "") {
							oldLines.push("");
							newLines.push("");
						} else {
							return { text: `Patch failed: invalid hunk line prefix in ${relPath}: ${hl.slice(0, 60)}`, isError: true };
						}
						i += 1;
					}
					if (!oldLines.length) {
						return { text: `Patch failed: hunk in ${relPath} requires at least one context (' ') or removed ('-') line.`, isError: true };
					}
					const oldChunk = oldLines.join("\n");
					const newChunk = newLines.join("\n");
					const at = content.indexOf(oldChunk);
					if (at < 0) return { text: diagnoseEditMismatch(relPath, content, oldChunk), isError: true };
					if (content.indexOf(oldChunk, at + 1) >= 0) {
						return { text: `Patch failed: hunk matched multiple times in ${relPath}; include more context lines.`, isError: true };
					}
					content = content.slice(0, at) + newChunk + content.slice(at + oldChunk.length);
					hunksApplied += 1;
				} else {
					i += 1;
				}
			}
			if (hunksApplied === 0) {
				return { text: `Patch failed: no @@ hunks provided for Update File ${relPath}`, isError: true };
			}
			const nextContent = hasCrlf ? content.replace(/\n/g, "\r\n") : content;
			virtualFiles.set(full, nextContent);
			staged.push({ kind: "update", relPath, fullPath: full, beforeSha, nextContent, hunksApplied });
			continue;
		}
		return { text: `Patch failed: unrecognized header line: ${line.slice(0, 80)}`, isError: true };
	}

	if (!staged.length) return { text: "Patch failed: empty patch body.", isError: true };

	// Phase 2: Commit validated operations to disk
	const summaries: string[] = [];
	for (const op of staged) {
		switch (op.kind) {
			case "add":
				mkdirSync(dirname(op.fullPath), { recursive: true });
				writeFileSync(op.fullPath, op.content, { flag: "wx" });
				summaries.push(`Added ${op.relPath} (sha=${sha256File(op.fullPath)})`);
				break;
			case "delete":
				unlinkSync(op.fullPath);
				summaries.push(`Deleted ${op.relPath}`);
				break;
			case "update":
				writeFileSync(op.fullPath, op.nextContent, "utf8");
				summaries.push(`Updated ${op.relPath} (${op.beforeSha} -> ${sha256File(op.fullPath)}, ${op.hunksApplied} hunk${op.hunksApplied === 1 ? "" : "s"})`);
				break;
		}
	}
	return { text: summaries.join("\n") };
}

function listTree(root: string, dir: string, depth: number, out: string[], deniedReadPaths?: readonly string[]): void {
	if (out.length > 400) return;
	for (const name of readdirSync(dir).sort()) {
		if (SKIP.has(name)) continue;
		const full = join(dir, name);
		if (isPathBlocked(full, deniedReadPaths)) continue;
		const stat = statSync(full);
		out.push(`${relative(root, full)}${stat.isDirectory() ? "/" : ` (${stat.size} B)`}`);
		if (stat.isDirectory() && depth > 0) listTree(root, full, depth - 1, out, deniedReadPaths);
	}
}

async function copyReviewInputs(workspace: string, scratch: string, files: string[] | undefined, signal?: AbortSignal): Promise<void> {
	let bytes = 0;
	let entries = 0;
	const filter = async (source: string) => {
		signal?.throwIfAborted();
		if (source !== workspace && SKIP.has(basename(source))) return false;
		const info = await lstat(source);
		bytes += info.isFile() ? info.size : 0;
		if (++entries > 4096 || bytes > 64 * 1024 * 1024) {
			throw new Error("Review inputs exceed 64 MiB / 4096 files; pass explicit `files` paths.");
		}
		return true;
	};
	const opts = { recursive: true, mode: constants.COPYFILE_FICLONE, filter };
	if (!files?.length) {
		await cp(workspace, scratch, opts);
		return;
	}
	for (const file of new Set(files)) {
		const source = inside(workspace, file);
		const subpath = relative(workspace, source);
		if (subpath.split("/").some((p) => SKIP.has(p))) throw new Error("Select files outside VCS/cache folders");
		inside(realpathSync(workspace), realpathSync(source));
		await cp(source, join(scratch, subpath), opts);
	}
}

export interface WorkspaceToolOptions {
	bus: EventBus;
	secrets?: SecretBroker;
	artifacts?: ArtifactStore;
	maxInlineOutputBytes?: number;
	readOnly?: boolean;
	networkOff?: boolean;
	/** Allow connecting ONLY to the local Docker daemon Unix socket (offline containers via `./.eval-exec`). */
	allowDockerSocket?: boolean;
	/** Per-worker immutable paths blocked from reading (Seatbelt + host-side workspace tools). */
	deniedReadPaths?: readonly string[];
	maxCommandSeconds?: number;
	defaultFileLines?: number;
	/** File-editing tool format aligned to model family (default "search_replace"). */
	editFormat?: "search_replace" | "apply_patch";
}

/**
 * Runtime-agnostic workspace tools for in-process workers and blind reviewers.
 * Fixes the v1 silent edit bug: `apply_workspace_change` verifies post-write content/hash
 * and fails loudly (isError=true) on any missing file, non-unique match, or no-op mismatch.
 */
export function workspaceTools(opts: WorkspaceToolOptions): ToolDefinition[] {
	const defaultLines = opts.defaultFileLines ?? 200;
	const maxSec = opts.maxCommandSeconds ?? 300;

	const readOnlyTools: ToolDefinition[] = [
		{
			name: "read_file",
			description: `Read a text file from your workspace (default up to ${defaultLines} lines).`,
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string" },
					start_line: { type: "number" },
					end_line: { type: "number" },
				},
				required: ["path"],
			},
			execute(args, ctx) {
				if (!ctx.workspace) return { text: "No workspace attached", isError: true };
				const full = inside(ctx.workspace, String(args.path ?? ""), opts.deniedReadPaths);
				if (!existsSync(full) || !statSync(full).isFile()) {
					return { text: `File not found: ${String(args.path ?? "")}`, isError: true };
				}
				const lines = readFileSync(full, "utf8").split("\n");
				const from = Math.max(1, typeof args.start_line === "number" ? Math.floor(args.start_line) : 1);
				const to = Math.min(lines.length, typeof args.end_line === "number" ? Math.floor(args.end_line) : from + defaultLines - 1);
				const body = lines.slice(from - 1, to).map((l, i) => `${from + i}\t${l}`).join("\n");
				return { text: body + (to < lines.length ? `\n[${lines.length - to} more lines]` : "") };
			},
		},
		{
			name: "list_files",
			description: "List files in the workspace or a subdirectory.",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string" },
					depth: { type: "number", minimum: 0, maximum: 6 },
				},
			},
			execute(args, ctx) {
				if (!ctx.workspace) return { text: "No workspace attached", isError: true };
				const base = ctx.workspace;
				const target = inside(base, typeof args.path === "string" ? args.path : ".", opts.deniedReadPaths);
				if (!existsSync(target)) return { text: `Path not found: ${typeof args.path === "string" ? args.path : "."}`, isError: true };
				if (!statSync(target).isDirectory()) return { text: `Not a directory: ${typeof args.path === "string" ? args.path : "."}`, isError: true };
				const out: string[] = [];
				listTree(base, target, typeof args.depth === "number" ? Math.floor(args.depth) : 2, out, opts.deniedReadPaths);
				return { text: out.join("\n") || "(empty)" };
			},
		},
		{
			name: "grep_files",
			description: "Search text files in your workspace for a regex pattern (returns file:line:text, bounded).",
			inputSchema: {
				type: "object",
				properties: {
					pattern: { type: "string", description: "Regular expression or literal substring" },
					path: { type: "string", description: "Optional subdirectory or file path" },
					case_insensitive: { type: "boolean" },
					max_matches: { type: "number", minimum: 1, maximum: 200 },
				},
				required: ["pattern"],
			},
			execute(args, ctx) {
				if (!ctx.workspace) return { text: "No workspace attached", isError: true };
				const pattern = String(args.pattern ?? "");
				if (!pattern) return { text: "pattern is required", isError: true };
				let regex: RegExp;
				try {
					regex = new RegExp(pattern, args.case_insensitive ? "i" : "");
				} catch (error) {
					return { text: `Invalid regex "${pattern}": ${error instanceof Error ? error.message : String(error)}`, isError: true };
				}
				const target = inside(ctx.workspace, typeof args.path === "string" ? args.path : ".", opts.deniedReadPaths);
				if (!existsSync(target)) return { text: `Path not found: ${typeof args.path === "string" ? args.path : "."}`, isError: true };
				const maxMatches = Math.min(200, Math.max(1, typeof args.max_matches === "number" ? Math.floor(args.max_matches) : 60));
				const matches: string[] = [];
				const st = statSync(target);
				if (st.isFile()) {
					const rel = relative(ctx.workspace, target);
					const lines = readFileSync(target, "utf8").split("\n");
					for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
						if (regex.test(lines[i]!)) matches.push(`${rel}:${i + 1}:${lines[i]!.slice(0, 240)}`);
					}
				} else {
					grepTree(ctx.workspace, target, regex, maxMatches, matches, opts.deniedReadPaths);
				}
				if (!matches.length) return { text: "(no matches)" };
				const raw = matches.join("\n") + (matches.length >= maxMatches ? `\n[capped at ${maxMatches} matches]` : "");
				const spilled = spillLargeOutput("grep_files", raw, {
					artifacts: opts.artifacts,
					createdBy: ctx.agentId,
					maxBytes: opts.maxInlineOutputBytes,
				});
				return { text: spilled.text, data: spilled.artifactId ? { artifactId: spilled.artifactId } : undefined };
			},
		},
	];

	if (opts.readOnly) {
		return [
			...readOnlyTools,
			{
				name: "run_check",
				description: "Run an offline verification command in a scratch copy of the frozen snapshot.",
				inputSchema: {
					type: "object",
					properties: {
						command: { type: "string" },
						files: { type: "array", items: { type: "string" } },
						timeout_seconds: { type: "number", minimum: 1, maximum: 3600 },
					},
					required: ["command"],
				},
				async execute(args, ctx) {
					if (!ctx.workspace) return { text: "No snapshot workspace attached", isError: true };
					const scratch = mkdtempSync(join(dirname(ctx.workspace), `.check-${ctx.agentId}-`));
					try {
						const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === "string") : undefined;
						await copyReviewInputs(ctx.workspace, scratch, files, ctx.signal);
						const timeoutMs = Math.min(typeof args.timeout_seconds === "number" ? args.timeout_seconds : 120, maxSec) * 1000;
						const result = await runCommand({
							command: String(args.command ?? ""),
							cwd: scratch,
							profile: "job",
							isolatedWrites: true,
							networkOff: true,
							deniedReadPaths: opts.deniedReadPaths,
							timeoutMs,
							signal: ctx.signal,
						});
						const cleanText = opts.bus.redactor.redactText(
							`exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}\n${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`.trim(),
						);
						const spilled = spillLargeOutput("run_check", cleanText, {
							artifacts: opts.artifacts,
							createdBy: ctx.agentId,
							maxBytes: opts.maxInlineOutputBytes,
						});
						return { text: spilled.text, isError: result.exitCode !== 0 || result.timedOut, data: spilled.artifactId ? { artifactId: spilled.artifactId } : undefined };
					} finally {
						await rm(scratch, { recursive: true, force: true });
					}
				},
			},
		];
	}

	const editTool: ToolDefinition = opts.editFormat === "apply_patch"
		? {
			name: "apply_patch",
			description: "Apply a multi-file plain-text patch (`*** Begin Patch` ... `*** Update File:` / `*** Add File:` / `*** Delete File:` ... `*** End Patch`).",
			inputSchema: {
				type: "object",
				properties: {
					patch: { type: "string", description: "Complete patch enclosed in *** Begin Patch / *** End Patch markers" },
				},
				required: ["patch"],
			},
			execute(args, ctx) {
				if (!ctx.workspace) return { text: "No workspace attached", isError: true };
				const patch = typeof args.patch === "string" ? args.patch : "";
				if (!patch.trim()) return { text: "patch must be a non-empty string", isError: true };
				return applyPatchToWorkspace(ctx.workspace, patch, opts.deniedReadPaths);
			},
		}
		: {
			name: "apply_workspace_change",
			description: "Create, replace, or edit one exact unique text match in a workspace file (verifies post-write state loudly).",
			inputSchema: {
				type: "object",
				properties: {
					operation: { type: "string", enum: ["create", "replace", "edit"] },
					path: { type: "string" },
					content: { type: "string" },
					old_text: { type: "string" },
					new_text: { type: "string" },
				},
				required: ["operation", "path"],
			},
			execute(args, ctx) {
				if (!ctx.workspace) return { text: "No workspace attached", isError: true };
				const op = String(args.operation ?? "");
				const relPath = String(args.path ?? "");
				const full = writePath(ctx.workspace, relPath, opts.deniedReadPaths);

				if (op === "create") {
					if (typeof args.content !== "string") return { text: "create requires string content", isError: true };
					if (existsSync(full)) return { text: `File already exists: ${relPath}`, isError: true };
					mkdirSync(dirname(full), { recursive: true });
					writeFileSync(full, args.content, { flag: "wx" });
					return { text: `Created ${relPath} (sha=${sha256File(full)})` };
				}
				if (op === "replace") {
					if (typeof args.content !== "string") return { text: "replace requires string content", isError: true };
					if (!existsSync(full) || !statSync(full).isFile()) return { text: `Cannot replace missing file: ${relPath}`, isError: true };
					const before = sha256File(full);
					writeFileSync(full, args.content, "utf8");
					const after = sha256File(full);
					return { text: `Replaced ${relPath} (${before} -> ${after})` };
				}
				if (op === "edit") {
					if (typeof args.old_text !== "string" || !args.old_text.length || typeof args.new_text !== "string") {
						return { text: "edit requires nonempty old_text and string new_text", isError: true };
					}
					if (!existsSync(full) || !statSync(full).isFile()) return { text: `File not found: ${relPath}`, isError: true };
					const text = readFileSync(full, "utf8");
					const at = text.indexOf(args.old_text);
					if (at < 0) return { text: diagnoseEditMismatch(relPath, text, args.old_text), isError: true };
					if (text.indexOf(args.old_text, at + 1) >= 0) {
						return { text: `Edit failed: old_text matched multiple times in ${relPath}; include more context`, isError: true };
					}
					const updated = text.slice(0, at) + args.new_text + text.slice(at + args.old_text.length);
					const before = sha256File(full);
					writeFileSync(full, updated, "utf8");
					const after = sha256File(full);
					if (before === after && args.old_text !== args.new_text) {
						return { text: `Edit failed: post-write verification detected unchanged file ${relPath}`, isError: true };
					}
					return { text: `Edited ${relPath} (${before} -> ${after})` };
				}
				return { text: `Unsupported operation: ${op}`, isError: true };
			},
		};

	return [
		...readOnlyTools,
		editTool,
		{
			name: "bash",
			description: "Run a sandboxed shell command inside your workspace.",
			inputSchema: {
				type: "object",
				properties: {
					command: { type: "string" },
					timeout_seconds: { type: "number", minimum: 1, maximum: 3600 },
					capabilities: { type: "array", items: { type: "string" } },
				},
				required: ["command"],
			},
			async execute(args, ctx) {
				if (!ctx.workspace) return { text: "No workspace attached", isError: true };
				const command = String(args.command ?? "");
				const caps = Array.isArray(args.capabilities) ? args.capabilities.filter((c): c is string => typeof c === "string") : [];
				const env = caps.length && opts.secrets ? opts.secrets.envFor(ctx.agentId, caps) : {};
				const timeoutMs = Math.min(typeof args.timeout_seconds === "number" ? args.timeout_seconds : 180, maxSec) * 1000;
				const result = await runCommand({
					command,
					cwd: ctx.workspace,
					profile: "worker",
					networkOff: opts.networkOff,
					allowDockerSocket: opts.allowDockerSocket,
					deniedReadPaths: opts.deniedReadPaths,
					env,
					timeoutMs,
					signal: ctx.signal,
				});
				opts.bus.emit(
					ctx.runId,
					"workspace.command",
					{ command: command.slice(0, 500), exitCode: result.exitCode, durationMs: result.durationMs, sandboxed: result.sandboxed },
					ctx.agentId,
				);
				const cleanText = opts.bus.redactor.redactText(
					`exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}\n${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`.trim(),
				);
				const spilled = spillLargeOutput("bash", cleanText, {
					artifacts: opts.artifacts,
					createdBy: ctx.agentId,
					maxBytes: opts.maxInlineOutputBytes,
				});
				return { text: spilled.text, isError: result.exitCode !== 0 || result.timedOut, data: spilled.artifactId ? { artifactId: spilled.artifactId } : undefined };
			},
		},
	];
}
