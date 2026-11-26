import { createHash } from "node:crypto";
import { constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { cp, lstat, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
	type ArtifactStore,
	type EventBus,
	isOperatorArchivePath,
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

function grepTree(root: string, dir: string, regex: RegExp, maxMatches: number, out: string[]): void {
	if (out.length >= maxMatches) return;
	for (const name of readdirSync(dir).sort()) {
		if (SKIP.has(name)) continue;
		const full = join(dir, name);
		if (isOperatorArchivePath(full)) continue;
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			grepTree(root, full, regex, maxMatches, out);
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

function inside(root: string, target: string): string {
	const full = resolve(root, target);
	const rel = relative(root, full);
	if (rel.startsWith("..") || resolve(rel) === rel) throw new Error(`Path ${target} is outside workspace`);
	if (isOperatorArchivePath(full)) throw new Error("Path is outside workspace");
	return full;
}

function writePath(root: string, target: string): string {
	const full = inside(root, target);
	let existing = full;
	while (!existsSync(existing)) existing = dirname(existing);
	inside(realpathSync(root), realpathSync(existing));
	return full;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);
}

function listTree(root: string, dir: string, depth: number, out: string[]): void {
	if (out.length > 400) return;
	for (const name of readdirSync(dir).sort()) {
		if (SKIP.has(name)) continue;
		const full = join(dir, name);
		if (isOperatorArchivePath(full)) continue;
		const stat = statSync(full);
		out.push(`${relative(root, full)}${stat.isDirectory() ? "/" : ` (${stat.size} B)`}`);
		if (stat.isDirectory() && depth > 0) listTree(root, full, depth - 1, out);
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
	maxCommandSeconds?: number;
	defaultFileLines?: number;
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
				const full = inside(ctx.workspace, String(args.path ?? ""));
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
				const target = inside(base, typeof args.path === "string" ? args.path : ".");
				if (!existsSync(target)) return { text: `Path not found: ${typeof args.path === "string" ? args.path : "."}`, isError: true };
				if (!statSync(target).isDirectory()) return { text: `Not a directory: ${typeof args.path === "string" ? args.path : "."}`, isError: true };
				const out: string[] = [];
				listTree(base, target, typeof args.depth === "number" ? Math.floor(args.depth) : 2, out);
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
				const target = inside(ctx.workspace, typeof args.path === "string" ? args.path : ".");
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
					grepTree(ctx.workspace, target, regex, maxMatches, matches);
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

	return [
		...readOnlyTools,
		{
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
				const full = writePath(ctx.workspace, relPath);

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
					if (at < 0) return { text: `Edit failed: old_text not found in ${relPath}`, isError: true };
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
		},
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
