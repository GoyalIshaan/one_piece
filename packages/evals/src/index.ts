import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	allowSandboxReads,
	type BoardPost,
	denySandboxReads,
	type Finding,
	type HarnessModule,
	type HarnessProfile,
	type ModelRouter,
	type Question,
	type Run,
	type SwarmNode,
} from "@one-piece/core";
import { startDashboard } from "@one-piece/dashboard";
import { createHarness, type HarnessConfig } from "@one-piece/engine";
import { SqliteStore } from "@one-piece/store";

// The eval environment. Each task ships a seed (what the swarm sees), an optional prepare step
// that generates a fresh instance (so answers cannot be memorised), and a hidden grader that runs
// outside the swarm on a copy of each worker's workspace. The sandbox is told to refuse reads of
// the graders and hidden answers while a task runs.

export const TASKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "tasks");

export interface TaskSpec {
	id: string;
	title: string;
	category: "optimization" | "coordination" | "engineering";
	inspiredBy: string;
	suites: string[];
	prepare?: boolean;
	goal: string;
	rubric: string;
	budget: Record<string, number>;
	caps: { maxChildren: number; maxDepth: number };
	timeLimitMinutes: number;
}

export interface GradeResult {
	score: number;
	passed: boolean;
	raw?: unknown;
	details: string;
}

export interface HealthIssue {
	level: "fail" | "warn";
	check: string;
	message: string;
}

export interface TaskResult {
	task: TaskSpec;
	runId: string;
	status: Run["status"];
	stoppedByTimeLimit: boolean;
	score: number;
	best?: { nodeId: string; title: string; grade: GradeResult };
	graded: Array<{ nodeId: string; title: string; grade: GradeResult }>;
	health: { status: "ok" | "warn" | "fail"; issues: HealthIssue[] };
	stats: {
		durationMs: number;
		tokens: number;
		usd: number;
		agents: Record<string, number>;
		findings: Record<string, number>;
		modelCalls: number;
		modelErrors: number;
		retries: number;
		toolCalls: number;
		toolErrors: number;
		questions: number;
		boardPosts: number;
		jobs: number;
		modelsUsed: Record<string, number>;
		childModelChoices: string[];
	};
}

export function loadTasks(suite: string, ids?: string[]): TaskSpec[] {
	const all = readdirSync(TASKS_DIR)
		.filter((d) => existsSync(join(TASKS_DIR, d, "task.json")))
		.map((d) => JSON.parse(readFileSync(join(TASKS_DIR, d, "task.json"), "utf8")) as TaskSpec);
	const picked = ids?.length ? all.filter((t) => ids.includes(t.id)) : all.filter((t) => t.suites.includes(suite));
	if (!picked.length) throw new Error(`No eval tasks match (suite ${suite}${ids?.length ? `, ids ${ids.join(", ")}` : ""})`);
	return picked.sort((a, b) => a.id.localeCompare(b.id));
}

function python(args: string[], cwd: string, timeoutMs: number): string {
	return execFileSync("python3", args, { cwd, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

export function grade(taskDir: string, hidden: string, workspace: string): GradeResult {
	const copy = mkdtempSync(join(tmpdir(), "op-grade-"));
	cpSync(workspace, copy, { recursive: true, filter: (src) => !src.includes(`${"/"}.git`) });
	try {
		const out = python([join(hidden, "grade.py"), copy, hidden], copy, 15 * 60_000);
		const line = out.trim().split("\n").at(-1) ?? "{}";
		const parsed = JSON.parse(line) as GradeResult;
		return { score: Number(parsed.score) || 0, passed: Boolean(parsed.passed), raw: parsed.raw, details: String(parsed.details ?? "") };
	} catch (error) {
		return { score: 0, passed: false, details: `grader failed: ${String(error).slice(0, 400)}` };
	}
}

/** Everything that would mean the harness broke, checked from the run's own telemetry. */
export async function checkHealth(store: SqliteStore, dbPath: string, run: Run, runDir: string, budget: Record<string, number>): Promise<{ status: "ok" | "warn" | "fail"; issues: HealthIssue[] }> {
	const issues: HealthIssue[] = [];
	const fail = (check: string, message: string) => issues.push({ level: "fail", check, message });
	const warn = (check: string, message: string) => issues.push({ level: "warn", check, message });
	const nodes = store.list<SwarmNode>("nodes", { runId: run.id });
	const events = store.events(run.id);
	const findings = store.list<Finding>("findings", { runId: run.id });

	if (!events.some((e) => e.type === "run.finished")) fail("run finished", "no run.finished event");
	if (run.status !== "done") warn("run finished", `run status is ${run.status}`);
	const failed = nodes.filter((n) => n.status === "failed");
	if (failed.length) fail("no failed agents", `${failed.length} agents failed: ${failed.map((n) => `${n.role} "${n.goal.title}": ${n.statusReason ?? ""}`.slice(0, 160)).join("; ")}`);
	const stuck = nodes.filter((n) => ["running", "parked", "pending"].includes(n.status));
	if (stuck.length) fail("nothing left running", `${stuck.length} agents still ${[...new Set(stuck.map((n) => n.status))].join("/")} after the run ended`);
	const errors = events.filter((e) => e.type === "agent.error");
	const retries = events.filter((e) => e.type === "agent.retry").length;
	const unrecovered = errors.length - retries;
	if (unrecovered > 0) warn("model errors recovered", `${errors.length} model or agent errors, ${retries} retried: ${[...new Set(errors.map((e) => String(e.data.error).slice(0, 100)))].slice(0, 3).join(" | ")}`);
	const toolResults = events.filter((e) => e.type === "tool.result");
	const toolErrors = toolResults.filter((e) => e.data.isError);
	if (toolResults.length && toolErrors.length / toolResults.length > 0.25) {
		warn("tool error rate", `${toolErrors.length}/${toolResults.length} tool calls failed; most common: ${topCounts(toolErrors.map((e) => `${e.data.tool}: ${String(e.data.text).split("\n")[0].slice(0, 80)}`), 3)}`);
	}
	if (!existsSync(join(runDir, "report.md"))) fail("report written", "no report.md");
	else if (!readFileSync(join(runDir, "report.md"), "utf8").includes("Appendix: evidence trail")) fail("report written", "report.md has no evidence appendix");
	const callTokens = events.filter((e) => e.type === "model.call").reduce((a, e) => a + Number(e.data.totalTokens ?? 0), 0);
	const ownTokens = nodes.reduce((a, n) => a + (n.spent.tokens ?? 0), 0);
	if (callTokens !== ownTokens) fail("spend counted once", `model calls total ${callTokens} tokens but agents' own spend totals ${ownTokens}`);
	if (budget.tokens && ownTokens > budget.tokens * 1.1) fail("budget respected", `spent ${ownTokens} tokens against a budget of ${budget.tokens}`);
	if (findings.some((f) => f.status === "accepted" && !f.rounds.length)) fail("findings reviewed", "an accepted finding has no review round");
	const unresolved = findings.filter((f) => f.status === "pending_review" || f.status === "needs_work");
	if (unresolved.length) warn("findings resolved", `${unresolved.length} findings ended unresolved (${unresolved.map((f) => f.status).join(", ")})`);
	if (!findings.some((f) => f.status === "accepted")) warn("progress", "no finding was accepted");
	if (!nodes.some((n) => n.role === "leaf")) fail("work happened", "no worker was ever spawned");

	// The dashboard must be able to show this run.
	const port = 48000 + Math.floor(Math.random() * 1000);
	const dash = startDashboard({ dbPath, port });
	try {
		await new Promise((r) => setTimeout(r, 150));
		const page = await fetch(`${dash.url}/`);
		const state = await fetch(`${dash.url}/api/runs/${run.id}/state`);
		const body = (await state.json()) as { nodes?: unknown[] };
		if (!page.ok || !state.ok || !Array.isArray(body.nodes) || body.nodes.length !== nodes.length) fail("dashboard shows the run", `page ${page.status}, state ${state.status}, nodes ${body.nodes?.length ?? "none"}/${nodes.length}`);
	} catch (error) {
		fail("dashboard shows the run", String(error));
	} finally {
		dash.close();
	}
	const status = issues.some((i) => i.level === "fail") ? "fail" : issues.length ? "warn" : "ok";
	return { status, issues };
}

function topCounts(items: string[], n: number): string {
	const counts = new Map<string, number>();
	for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
	return [...counts]
		.sort((a, b) => b[1] - a[1])
		.slice(0, n)
		.map(([k, v]) => `${k} (×${v})`)
		.join("; ");
}

export interface EvalOptions {
	suite: string;
	taskIds?: string[];
	dataDir: string;
	router: ModelRouter;
	modules: () => HarnessModule[];
	profile: HarnessProfile;
	maxConcurrentAgents: number;
	extraConfig?: Partial<HarnessConfig>;
	/** Scale every task's token budget (e.g. 0.5 for a cheaper pass). */
	budgetScale?: number;
	/**
	 * "swarm" (default) or "solo": the single-agent baseline. Same task, budget and models, but the
	 * root may spawn exactly one worker and there are no hidden reviews (claims review stays on).
	 */
	mode?: "swarm" | "solo";
	log?: (line: string) => void;
}

export async function runTask(task: TaskSpec, options: EvalOptions, evalDir: string, store: SqliteStore, dbPath: string): Promise<TaskResult> {
	const log = options.log ?? (() => {});
	const taskDir = join(TASKS_DIR, task.id);
	const root = join(evalDir, task.id);
	const seed = join(root, "seed");
	const hidden = mkdtempSync(join(tmpdir(), `op-hidden-${task.id}-`));
	mkdirSync(root, { recursive: true });
	cpSync(join(taskDir, "seed"), seed, { recursive: true });
	cpSync(join(taskDir, "grader"), hidden, { recursive: true });
	if (task.prepare) python([join(taskDir, "prepare.py"), seed, hidden, String(Math.floor(Math.random() * 1e9))], taskDir, 5 * 60_000);
	denySandboxReads([hidden, TASKS_DIR]);

	const runDir = join(root, "run");
	const budget = Object.fromEntries(Object.entries(task.budget).map(([k, v]) => [k, k === "tokens" ? Math.round(v * (options.budgetScale ?? 1)) : v]));
	const modules = options.modules();
	const harness = createHarness({
		store,
		router: options.router,
		modules,
		config: {
			runDir,
			seedWorkspace: seed,
			maxConcurrentAgents: options.maxConcurrentAgents,
			profile: options.profile,
			caps: options.mode === "solo" ? { maxChildren: 1, maxDepth: 1 } : task.caps,
			...(options.mode === "solo" ? { reviewFractions: [], epochCheckpoints: [], saturationWindow: 1e9, stallTurns: 1e9 } : {}),
			...options.extraConfig,
		},
	});
	const began = Date.now();
	const run = await harness.start(
		{
			title: `[eval${options.mode === "solo" ? " solo" : ""}] ${task.title}`,
			text: `${task.goal}\n\nThe task files are in your workspace (each worker gets its own copy).${options.mode === "solo" ? "\n\nThis is a single-agent baseline: spawn exactly one worker to do the whole task." : ""}`,
			rubric: task.rubric,
		},
		budget,
		{ workspace: seed, config: { eval: task.id } },
	);
	log(`  ${task.id}: run ${run.id} started`);
	let stoppedByTimeLimit = false;
	const timer = setTimeout(() => {
		stoppedByTimeLimit = true;
		log(`  ${task.id}: time limit (${task.timeLimitMinutes} min) reached, stopping`);
		harness.finishRun("stopped", "eval time limit");
	}, task.timeLimitMinutes * 60_000);
	await harness.done;
	clearTimeout(timer);
	// Give in-flight agent loops a moment to settle before inspecting state.
	await new Promise((r) => setTimeout(r, 1500));
	for (const m of modules) await m.dispose?.();
	allowSandboxReads([hidden, TASKS_DIR]);

	const nodes = harness.tree.all();
	const graded = nodes
		.filter((n) => n.role === "leaf" && existsSync(join(runDir, "workspaces", n.id)))
		.map((n) => ({ nodeId: n.id, title: n.goal.title, grade: grade(taskDir, hidden, join(runDir, "workspaces", n.id)) }));
	const best = [...graded].sort((a, b) => b.grade.score - a.grade.score)[0];
	const finalRun = store.get<Run>("runs", run.id)!;
	const health = await checkHealth(store, dbPath, finalRun, runDir, budget);
	if (stoppedByTimeLimit) health.issues.push({ level: "warn", check: "finished in time", message: `stopped at the ${task.timeLimitMinutes}-minute limit` });
	if (health.status === "ok" && health.issues.length) health.status = "warn";

	const events = store.events(run.id);
	const count = <T>(items: T[], key: (t: T) => string) => items.reduce<Record<string, number>>((acc, i) => ((acc[key(i)] = (acc[key(i)] ?? 0) + 1), acc), {});
	const calls = events.filter((e) => e.type === "model.call");
	const result: TaskResult = {
		task,
		runId: run.id,
		status: finalRun.status,
		stoppedByTimeLimit,
		score: best?.grade.score ?? 0,
		best,
		graded,
		health,
		stats: {
			durationMs: Date.now() - began,
			tokens: nodes.reduce((a, n) => a + (n.spent.tokens ?? 0), 0),
			usd: nodes.reduce((a, n) => a + (n.spent.usd ?? 0), 0),
			agents: count(nodes, (n) => n.role),
			findings: count(store.list<Finding>("findings", { runId: run.id }), (f) => f.status),
			modelCalls: calls.length,
			modelErrors: events.filter((e) => e.type === "agent.error").length,
			retries: events.filter((e) => e.type === "agent.retry").length,
			toolCalls: events.filter((e) => e.type === "tool.call").length,
			toolErrors: events.filter((e) => e.type === "tool.result" && e.data.isError).length,
			questions: store.list<Question>("questions", { runId: run.id }).length,
			boardPosts: store.list<BoardPost>("posts", { runId: run.id }).length,
			jobs: store.list("jobs", { runId: run.id }).length,
			modelsUsed: count(calls, (e) => `${e.data.provider}/${e.data.model}`),
			childModelChoices: events.filter((e) => e.type === "tool.call" && e.data.tool === "spawn_children").flatMap((e) => [...String(JSON.stringify(e.data.args)).matchAll(/"model":"([^"]+)"/g)].map((m) => m[1])),
		},
	};
	log(`  ${task.id}: score ${result.score.toFixed(3)}, health ${health.status}${health.issues.length ? ` (${health.issues.map((i) => i.check).join(", ")})` : ""}`);
	return result;
}

export async function runEval(options: EvalOptions): Promise<{ results: TaskResult[]; dir: string; reportPath: string }> {
	const tasks = loadTasks(options.suite, options.taskIds);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dir = join(options.dataDir, "evals", `${stamp}${options.mode === "solo" ? "-solo" : ""}`);
	mkdirSync(dir, { recursive: true });
	const dbPath = join(options.dataDir, "one_piece.db");
	const store = new SqliteStore(dbPath);
	const results: TaskResult[] = [];
	options.log?.(`Eval ${options.suite} (${tasks.length} tasks) -> ${dir}`);
	for (const task of tasks) results.push(await runTask(task, options, dir, store, dbPath));
	store.close();
	const reportPath = join(dir, "report.md");
	writeFileSync(join(dir, "results.json"), JSON.stringify(results, null, 2));
	writeFileSync(reportPath, renderReport(`${options.suite}${options.mode === "solo" ? " (solo baseline)" : ""}`, results));
	return { results, dir, reportPath };
}

export function renderReport(suite: string, results: TaskResult[]): string {
	const ok = results.filter((r) => r.health.status !== "fail").length;
	const total = (k: keyof TaskResult["stats"]) => results.reduce((a, r) => a + Number(r.stats[k]), 0);
	const lines = [
		`# one_piece eval: ${suite}`,
		"",
		`${results.length} tasks · mean score ${(results.reduce((a, r) => a + r.score, 0) / results.length).toFixed(3)} · ${ok}/${results.length} ran without breaking · ${total("tokens").toLocaleString()} tokens · $${total("usd").toFixed(2)} est.`,
		"",
		"| Task | Category | Score | Health | Tokens | Time | Agents | Findings | Errors |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		...results.map(
			(r) =>
				`| ${r.task.id} | ${r.task.category} | ${r.score.toFixed(3)} | ${r.health.status} | ${r.stats.tokens.toLocaleString()} | ${Math.round(r.stats.durationMs / 1000)}s | ${Object.entries(r.stats.agents).map(([k, v]) => `${v} ${k}`).join(", ")} | ${Object.entries(r.stats.findings).map(([k, v]) => `${v} ${k}`).join(", ") || "none"} | ${r.stats.modelErrors} model, ${r.stats.toolErrors}/${r.stats.toolCalls} tool |`,
		),
		"",
	];
	for (const r of results) {
		lines.push(`## ${r.task.id}: ${r.task.title}`, "", `Inspired by ${r.task.inspiredBy}. Run \`${r.runId}\`, status ${r.status}${r.stoppedByTimeLimit ? " (time limit)" : ""}.`, "");
		lines.push(`**Score ${r.score.toFixed(3)}**${r.best ? ` from worker "${r.best.title}": ${r.best.grade.details}` : " (no worker workspace to grade)"}`, "");
		if (r.graded.length > 1) lines.push("Every worker graded:", ...r.graded.map((g) => `- ${g.title}: ${g.grade.score.toFixed(3)} (${g.grade.details})`), "");
		lines.push(`**Health: ${r.health.status}**`, ...(r.health.issues.length ? r.health.issues.map((i) => `- ${i.level}: ${i.check}: ${i.message}`) : ["- all checks passed"]), "");
		lines.push(
			`Models: ${Object.entries(r.stats.modelsUsed).map(([m, c]) => `${m} ×${c}`).join(", ")}${r.stats.childModelChoices.length ? `; managers chose ${r.stats.childModelChoices.join(", ")} for children` : ""}. Questions ${r.stats.questions}, board posts ${r.stats.boardPosts}, jobs ${r.stats.jobs}, retries ${r.stats.retries}.`,
			"",
		);
	}
	return lines.join("\n");
}
