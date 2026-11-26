import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ArtifactStore,
	type EventBus,
	runCommand,
	type Store,
	type ToolDefinition,
	type WorktreeManager,
} from "@one-piece/core";
import { spillLargeOutput } from "@one-piece/module-workspace";

export interface CodeModeDeps {
	runId: string;
	runDir: string;
	bus: EventBus;
	store: Store;
	artifacts: ArtifactStore;
	worktrees: WorktreeManager;
	maxInlineBytes?: number;
}

const RUNNER_PRELUDE = `
import { existsSync, readFileSync } from "node:fs";
const SNAP = JSON.parse(readFileSync(process.env.ONE_PIECE_SWARM_SNAP, "utf8"));

function tokenize(s) {
  return String(s || "").toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
}

export const swarm = {
  run: SNAP.run,
  board: {
    recent(limit = 20) {
      return [...SNAP.posts].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    },
    search(query, k = 10) {
      const q = tokenize(query);
      if (!q.length) return swarm.board.recent(k);
      const citeMap = new Map();
      for (const p of SNAP.posts) {
        for (const ref of p.references || []) {
          let set = citeMap.get(ref.postId);
          if (!set) { set = new Set(); citeMap.set(ref.postId, set); }
          set.add(p.authorAgentId);
        }
      }
      return SNAP.posts
        .map((post) => {
          const hay = tokenize(post.topic + " " + post.summary + " " + post.body);
          let hits = 0;
          for (const tok of q) if (hay.includes(tok)) hits++;
          const citations = (citeMap.get(post.id)?.size) || 0;
          return { post, citations, score: hits * (1 + 0.5 * Math.log1p(citations)) };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },
  },
  findings: {
    list() { return SNAP.findings; },
    accepted() { return SNAP.findings.filter((f) => f.status === "accepted"); },
  },
  tasks: {
    list() { return SNAP.tasks; },
  },
  agents: {
    list() { return SNAP.agents; },
  },
  artifacts: {
    list() { return SNAP.artifacts.map(({ path, ...meta }) => meta); },
    read(idOrSha, offset = 0, limit = 8192) {
      const rec = SNAP.artifacts.find((a) => a.id === idOrSha || a.sha256 === idOrSha || a.sha256.startsWith(idOrSha));
      if (!rec || !existsSync(rec.path)) return null;
      const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
      const safeLimit = Math.min(262144, Math.max(1, Math.floor(Number(limit) || 8192)));
      const buf = readFileSync(rec.path);
      const slice = buf.subarray(safeOffset, safeOffset + safeLimit).toString("utf8");
      return { id: rec.id, sha256: rec.sha256, totalBytes: buf.length, offset: safeOffset, content: slice };
    },
  },
  worktrees: {
    diffStat(branch) { return SNAP.diffStats[branch] ?? ""; },
    branches() { return Object.keys(SNAP.diffStats); },
  },
};
`;

/**
 * Coordinator Code Mode (`run_swarm_script`):
 * Exposes a sandboxed, network-off Node script environment pre-bound to a frozen read-only
 * `swarm` SDK (board, findings, tasks, agents, artifacts, worktree diffStats) so coordinators,
 * integrators, and reviewers can aggregate/rank many candidates in 1 turn instead of 15 tool calls.
 */
export function createCodeModeTool(deps: CodeModeDeps): ToolDefinition {
	return {
		name: "run_swarm_script",
		description: "Run an offline sandboxed JS snippet with the read-only `swarm` SDK (board, findings, tasks, agents, artifacts, worktrees) to aggregate/rank many items in one turn.",
		inputSchema: {
			type: "object",
			properties: {
				code: {
					type: "string",
					description: "Async JS function body (no top-level import statements; use `swarm` directly and `return` or `console.log` your compact summary).",
				},
				timeout_seconds: { type: "number", minimum: 1, maximum: 60 },
			},
			required: ["code"],
		},
		async execute(args, ctx) {
			const code = String(args.code ?? "").trim();
			if (!code) return { text: "code is required", isError: true };
			const timeoutMs = Math.min(60, Math.max(1, typeof args.timeout_seconds === "number" ? args.timeout_seconds : 20)) * 1000;

			const scratch = mkdtempSync(join(tmpdir(), "op-codemode-"));
			try {
				const run = deps.store.get("runs", deps.runId);
				const posts = deps.store.list("posts", { runId: deps.runId });
				const findings = deps.store.list("findings", { runId: deps.runId });
				const tasks = deps.store.list("tasks", { runId: deps.runId });
				const agents = deps.store.list("agents", { runId: deps.runId });
				const artifacts = deps.store.list("artifacts", { runId: deps.runId }).map((a) => ({
					id: a.id,
					label: a.label,
					sha256: a.sha256,
					bytes: a.bytes,
					mimeType: a.mimeType,
					path: a.path,
				}));

				const diffStats: Record<string, string> = {};
				for (const ag of agents) {
					if (ag.branch && ag.workspace) {
						try {
							diffStats[ag.branch] = deps.worktrees.diffStat(ag.workspace);
						} catch {
							// Worktree may already be cleaned up.
						}
					}
				}

				const snapPath = join(scratch, "snapshot.json");
				writeFileSync(
					snapPath,
					JSON.stringify({
						run: run ? { id: run.id, topology: run.topology, goal: run.goal, baseCommitSha: run.baseCommitSha } : { id: deps.runId },
						posts,
						findings,
						tasks,
						agents: agents.map((a) => ({ id: a.id, role: a.role, driverId: a.driverId, model: a.model, branch: a.branch, status: a.status, turns: a.turns })),
						artifacts,
						diffStats,
					}),
					"utf8",
				);

				const sdkPath = join(scratch, "sdk.mjs");
				const entryPath = join(scratch, "entry.mjs");
				writeFileSync(sdkPath, RUNNER_PRELUDE, "utf8");
				writeFileSync(
					entryPath,
					[
						`import { swarm } from "./sdk.mjs";`,
						`const __result = await (async () => {`,
						code,
						`})();`,
						`if (__result !== undefined) {`,
						`  console.log(typeof __result === "string" ? __result : JSON.stringify(__result, null, 2));`,
						`}`,
					].join("\n"),
					"utf8",
				);

				const res = await runCommand({
					command: `${JSON.stringify(process.execPath)} ${JSON.stringify(entryPath)}`,
					cwd: scratch,
					profile: "job",
					isolatedWrites: true,
					networkOff: true,
					env: { ONE_PIECE_SWARM_SNAP: snapPath },
					timeoutMs,
					signal: ctx.signal,
				});

				const rawOut = deps.bus.redactor.redactText(
					[res.stdout.trim(), res.stderr.trim() ? `[stderr]\n${res.stderr.trim()}` : ""].filter(Boolean).join("\n") || `(exit ${res.exitCode}, no output)`,
				);
				const spilled = spillLargeOutput("codemode", rawOut, {
					artifacts: deps.artifacts,
					createdBy: ctx.agentId,
					maxBytes: deps.maxInlineBytes ?? 4_096,
				});

				deps.bus.emit(
					deps.runId,
					"codemode.executed",
					{
						exitCode: res.exitCode,
						durationMs: res.durationMs,
						outputBytes: Buffer.byteLength(rawOut, "utf8"),
						artifactId: spilled.artifactId,
					},
					ctx.agentId,
				);

				return {
					text: spilled.text,
					isError: res.exitCode !== 0 || res.timedOut,
					data: { exitCode: res.exitCode, durationMs: res.durationMs, artifactId: spilled.artifactId },
				};
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
		},
	};
}
