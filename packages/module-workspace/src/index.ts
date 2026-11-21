import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { arr, num, obj, opt, str } from "@earendil-works/pi-schema";
import { defineTool, type HarnessApi, type HarnessEvent, type HarnessModule, type NodeContext, runCommand } from "@one-piece/core";

// Each leaf gets a private folder: a copy of the seed with its own git history, where every
// reported finding is a commit (commit-as-attempt). Reviewers read it but cannot change it.

const SKIP = new Set([".git", "node_modules", ".venv", "__pycache__", "dist", ".one_piece"]);

function git(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "one_piece", GIT_AUTHOR_EMAIL: "agent@one-piece.local", GIT_COMMITTER_NAME: "one_piece", GIT_COMMITTER_EMAIL: "agent@one-piece.local" } }).toString();
	} catch {
		return "";
	}
}

export function ensureWorkspace(harness: HarnessApi, nodeId: string): string {
	const dir = harness.workspaceOf(nodeId);
	if (!dir) throw new Error("This agent has no workspace");
	if (existsSync(dir)) return dir;
	mkdirSync(dir, { recursive: true });
	const seed = harness.run().workspace;
	if (seed && existsSync(seed)) {
		cpSync(seed, dir, { recursive: true, filter: (src) => !SKIP.has(src.split("/").pop() ?? "") });
	}
	git(dir, ["init", "-q"]);
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "--allow-empty", "-m", "seed"]);
	return dir;
}

function inside(root: string, path: string): string {
	const full = resolve(root, path);
	const rel = relative(root, full);
	if (rel.startsWith("..") || resolve(rel) === rel) throw new Error(`Path ${path} is outside your workspace`);
	return full;
}

function listTree(root: string, dir: string, depth: number, out: string[]): void {
	if (out.length > 400) return;
	for (const name of readdirSync(dir).sort()) {
		if (SKIP.has(name)) continue;
		const full = join(dir, name);
		const stat = statSync(full);
		out.push(`${relative(root, full)}${stat.isDirectory() ? "/" : ` (${stat.size} B)`}`);
		if (stat.isDirectory() && depth > 0) listTree(root, full, depth - 1, out);
	}
}

export function workspaceModule(): HarnessModule {
	let harness: HarnessApi;
	return {
		manifest: {
			name: "workspace",
			version: "0.1.0",
			summary: "Private sandboxed folder per leaf: shell, read, write, edit; reviewers read only",
			roles: ["leaf", "claims_reviewer", "hidden_reviewer"],
			tools: ["bash", "read_file", "write_file", "edit_file", "list_files", "run_check"],
			contextCostTokens: 900,
		},
		setup(h) {
			harness = h;
			h.bus.on((event: HarnessEvent) => {
				if (event.type !== "finding.reported" && event.type !== "finding.verdict") return;
				const node = event.nodeId ? h.tree.get(event.nodeId) : undefined;
				const dir = node?.role === "leaf" ? h.workspaceOf(node.id) : undefined;
				if (!dir || !existsSync(dir)) return;
				git(dir, ["add", "-A"]);
				const label = event.type === "finding.reported" ? `attempt ${event.data.findingId}` : `${event.data.verdict} ${event.data.findingId}`;
				git(dir, ["commit", "-q", "--allow-empty", "-m", label]);
			});
		},
		prompt(ctx: NodeContext) {
			return ctx.node.role === "leaf"
				? "Workspace: you have a private folder (a copy of the project). Use bash, read_file, write_file, edit_file, list_files. Commands run sandboxed: no sudo, no writes outside your folder. Every reported finding is committed."
				: "You can read the author's workspace with read_file and list_files, and rerun commands in a scratch copy with run_check.";
		},
		tools(ctx: NodeContext) {
			const { node } = ctx;
			const root = () => ensureWorkspace(harness, node.id);
			const read = [
				defineTool({
					name: "read_file",
					description: "Read a text file from the workspace (optionally a line range).",
					parameters: obj({ path: str(), start_line: opt(num()), end_line: opt(num()) }),
					async execute(params) {
						const text = readFileSync(inside(root(), params.path), "utf8");
						const lines = text.split("\n");
						const from = Math.max(1, params.start_line ?? 1);
						const to = Math.min(lines.length, params.end_line ?? Math.min(lines.length, from + 399));
						return lines
							.slice(from - 1, to)
							.map((l, i) => `${from + i}\t${l}`)
							.join("\n") + (to < lines.length ? `\n[${lines.length - to} more lines]` : "");
					},
				}),
				defineTool({
					name: "list_files",
					description: "List files in the workspace (or a subfolder).",
					parameters: obj({ path: opt(str()), depth: opt(num({ minimum: 0, maximum: 6 })) }),
					async execute(params) {
						const base = root();
						const out: string[] = [];
						listTree(base, inside(base, params.path ?? "."), params.depth ?? 2, out);
						return out.join("\n") || "(empty)";
					},
				}),
			];
			if (node.role !== "leaf") {
				return [
					...read,
					defineTool({
						name: "run_check",
						description: "Rerun a command in a scratch copy of the author's workspace (the original is never changed).",
						parameters: obj({ command: str(), timeout_seconds: opt(num({ minimum: 1, maximum: 3600 })) }),
						async execute(params, signal) {
							// A fresh copy per check: never reuse a previous run's state (or its read-only git objects).
							const scratch = join(harness.workspaceOf(node.id)!, "..", `.check-${node.id}`);
							rmSync(scratch, { recursive: true, force: true });
							cpSync(root(), scratch, { recursive: true });
							const result = await runCommand({ command: params.command, cwd: scratch, profile: "job", timeoutMs: (params.timeout_seconds ?? 300) * 1000, signal });
							return harness.bus.redactor.redactText(`exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}\n${result.stdout}\n${result.stderr}`.trim());
						},
					}),
				];
			}
			return [
				...read,
				defineTool({
					name: "write_file",
					description: "Create or overwrite a file in your workspace.",
					parameters: obj({ path: str(), content: str() }),
					async execute(params) {
						const full = inside(root(), params.path);
						mkdirSync(dirname(full), { recursive: true });
						writeFileSync(full, params.content);
						return `Wrote ${params.path} (${params.content.length} chars).`;
					},
				}),
				defineTool({
					name: "edit_file",
					description: "Replace an exact, unique piece of text in a file.",
					parameters: obj({ path: str(), old_text: str(), new_text: str() }),
					async execute(params) {
						const full = inside(root(), params.path);
						const text = readFileSync(full, "utf8");
						const at = text.indexOf(params.old_text);
						if (at < 0) throw new Error("old_text not found");
						if (text.indexOf(params.old_text, at + 1) >= 0) throw new Error("old_text appears more than once; include more context");
						writeFileSync(full, text.slice(0, at) + params.new_text + text.slice(at + params.old_text.length));
						return "Edited.";
					},
				}),
				defineTool({
					name: "bash",
					description:
						"Run a shell command in your workspace (sandboxed: writes only inside it, no sudo or destructive system commands). " +
						"Pass capabilities to inject named secrets as environment variables.",
					parameters: obj({ command: str(), timeout_seconds: opt(num({ minimum: 1, maximum: 3600 })), capabilities: opt(arr(str())) }),
					async execute(params, signal) {
						const secrets = params.capabilities?.length ? harness.services.require("secrets").envFor(node.id, params.capabilities) : {};
						const result = await runCommand({ command: params.command, cwd: root(), profile: "worker", env: secrets, timeoutMs: (params.timeout_seconds ?? 300) * 1000, signal });
						harness.bus.emit(node.runId, "workspace.command", { command: params.command.slice(0, 500), exitCode: result.exitCode, durationMs: result.durationMs, sandboxed: result.sandboxed }, node.id);
						return harness.bus.redactor.redactText(`exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}\n${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`.trim());
					},
				}),
			];
		},
	};
}
