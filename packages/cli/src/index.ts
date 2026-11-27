import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type BoundOverride,
	EventBus,
	type ExecutionControlMode,
	loadVerificationModule,
	MemoryStore,
	newId,
	Redactor,
	type Run,
	type RunControlCommandRecord,
	type RunControlPayload,
	runCommand,
} from "@one-piece/core";
import { startDashboard } from "@one-piece/dashboard";
import { createDecisionClientFromEnv, createDriver, DriverQuotaRouter } from "@one-piece/drivers";
import { type CheckpointPolicy, createTopology, SwarmOS, TOPOLOGY_NAMES } from "@one-piece/engine";
import { McpBusServer } from "@one-piece/mcp-bus";
import { KEYCHAIN_SERVICE } from "@one-piece/module-secrets";
import { PROVIDER_FACTORIES, Router } from "@one-piece/router";
import { SqliteStore } from "@one-piece/store";
import { homeDir, loadConfig } from "./config.ts";

function parseArgs(argv: string[]) {
	const flags: Record<string, string[]> = {};
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i]!;
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			if (eq >= 0) {
				const k = token.slice(2, eq);
				(flags[k] ??= []).push(token.slice(eq + 1));
			} else {
				const k = token.slice(2);
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith("--")) {
					(flags[k] ??= []).push(next);
					i += 1;
				} else {
					(flags[k] ??= []).push("true");
				}
			}
		} else {
			positional.push(token);
		}
	}
	return { command: positional[0] ?? "help", args: positional.slice(1), flags };
}

function splitCsv(values?: string[]): string[] {
	if (!values?.length) return [];
	return values.flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);
}

function buildDrivers(cfg: ReturnType<typeof loadConfig>) {
	let piRouter: Router | undefined;
	if (cfg.drivers.some((d) => d.kind === "pi-in-process")) {
		const providers = cfg.providers.length ? cfg.providers : [{ id: "sim", models: { default: "sim-1" } }];
		const hasSim = providers.some((p) => p.id === "sim");
		piRouter = new Router({
			providers,
			credentialsPath: join(homeDir(), "auth.json"),
			providerFactories: PROVIDER_FACTORIES,
			simPolicy: hasSim
				? () => ({
					role: "assistant" as const,
					api: "faux",
					provider: "sim",
					model: "sim-1",
					content: [{ type: "text" as const, text: JSON.stringify({ subtasks: [{ title: "Simulated subtask", description: "Execute goal in sim mode." }] }) }],
					usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop" as const,
					timestamp: Date.now(),
				})
				: undefined,
		});
	}
	return cfg.drivers.map((driverCfg) => ({
		config: driverCfg,
		driver: createDriver(driverCfg, { piRouter }),
	}));
}

function resolveTargetRun(store: SqliteStore, explicitId?: string): Run | undefined {
	if (explicitId) return store.get("runs", explicitId);
	const runs = store.list("runs").sort((a, b) => b.createdAt - a.createdAt);
	const active = runs.filter((r) => r.status === "running");
	if (active.length === 1) return active[0];
	return active[0] ?? runs[0];
}

function writeControlCommand(store: SqliteStore, runId: string, payload: RunControlPayload): RunControlCommandRecord {
	const rec: RunControlCommandRecord = {
		id: newId("ctl"),
		runId,
		issuedBy: "cli",
		createdAt: Date.now(),
		payload,
	};
	store.put("control_commands", rec);
	return rec;
}

async function cmdDoctor(projectDir: string, flags: Record<string, string[]>): Promise<void> {
	const cfg = loadConfig(projectDir, {
		drivers: splitCsv(flags.drivers ?? flags.driver),
		providers: splitCsv(flags.provider),
	});
	console.log("one_piece v4 doctor\n");

	// 1. Check all configured drivers
	const drivers = buildDrivers(cfg);
	const health = await Promise.all(drivers.map((d) => d.driver.healthCheck()));
	console.log("Drivers:");
	for (const h of health) {
		const mark = h.ok ? "OK  " : "FAIL";
		console.log(`  [${mark}] ${h.driverId} (${h.kind}) ${h.version ?? ""} ${h.binaryPath ?? ""} ${h.detail ?? ""}`.trimEnd());
	}

	// 2. Check embedded local MCP loopback server
	const bus = new EventBus(new MemoryStore(), new Redactor());
	const mcp = await McpBusServer.start(bus);
	try {
		const healthUrl = mcp.url.replace(/\/mcp$/, "/health");
		const res = await fetch(healthUrl);
		const body = await res.json();
		console.log(`\nLocal MCP Bus:\n  [OK  ] ${mcp.url} (${JSON.stringify(body)})`);
	} finally {
		await mcp.close();
	}

	// 3. Check Seatbelt sandbox isolation
	const sb = await runCommand({
		command: "echo sandbox-ok",
		cwd: projectDir,
		profile: "job",
		networkOff: true,
		timeoutMs: 5_000,
	});
	console.log(`\nSandbox:\n  [${sb.exitCode === 0 ? "OK  " : "FAIL"}] platform=${process.platform} seatbelt=${sb.sandboxed} output=${sb.stdout.trim()}`);
}

async function cmdRun(projectDir: string, args: string[], flags: Record<string, string[]>): Promise<void> {
	const goalText = args.join(" ").trim();
	if (!goalText) {
		console.error('Usage: one-piece run "<goal>" [--topology adaptive|evolution|recursive-planners|...] [--mode research|eval] [--checkpoint-policy pause|notify|coalesce] [--bound-analyst] [--generations unbounded|N]');
		process.exitCode = 1;
		return;
	}

	const workspace = resolve(projectDir, flags.workspace?.[0] ?? ".");
	const cfg = loadConfig(projectDir, {
		topology: flags.topology?.[0],
		drivers: splitCsv(flags.drivers ?? flags.driver),
		providers: splitCsv(flags.provider),
		model: flags.model?.[0],
	});

	if (flags["budget-tokens"]?.[0]) cfg.budget.tokens = Number(flags["budget-tokens"][0]);
	if (flags["budget-usd"]?.[0]) cfg.budget.usd = Number(flags["budget-usd"][0]);
	if (flags["wall-seconds"]?.[0]) cfg.budget.wallSeconds = Number(flags["wall-seconds"][0]);

	const controlMode: ExecutionControlMode = flags.mode?.[0] === "eval" ? "eval" : "research";
	const rawPolicy = flags["checkpoint-policy"]?.[0];
	const checkpointPolicy: CheckpointPolicy | undefined =
		rawPolicy === "pause" || rawPolicy === "notify" || rawPolicy === "coalesce" || rawPolicy === "interactive"
			? rawPolicy
			: flags.interactive
				? "pause"
				: undefined;
	const estimateBounds = Boolean(flags["bound-analyst"]);
	const rawGen = flags.generations?.[0];
	const generations = rawGen === "unbounded" ? "unbounded" : rawGen && Number.isFinite(Number(rawGen)) ? Number(rawGen) : undefined;

	const store = new SqliteStore(join(cfg.dataDir, "one_piece.db"));
	const drivers = buildDrivers(cfg);
	const plugin = createTopology(cfg.topology, {
		controlMode,
		...(checkpointPolicy ? { checkpointPolicy } : {}),
		...(estimateBounds ? { estimateBounds: true } : {}),
		...(generations !== undefined ? { generations } : {}),
	});
	const verifier = cfg.verification ? (await loadVerificationModule(projectDir, cfg.verification)).findingVerifier : undefined;

	const runId = `run-${Date.now().toString(36)}`;
	const runDir = join(cfg.dataDir, "runs", runId);

	const router = new DriverQuotaRouter({
		drivers,
		roles: cfg.roles,
		runId,
		concurrencyMode: (flags.concurrency?.[0] as "physics" | "fixed" | undefined) ?? cfg.concurrencyMode ?? "physics",
		physics: { worktreeRoot: cfg.dataDir },
	});
	const decisionClient = createDecisionClientFromEnv({
		provider: (flags["decision-model"]?.[0] as "jev" | "auto" | "none" | undefined) ?? cfg.decisionModel?.provider ?? "auto",
		model: cfg.decisionModel?.model,
		baseUrl: cfg.decisionModel?.baseUrl,
		cwd: projectDir,
	});

	const os = await SwarmOS.create({
		runId,
		runDir,
		workspace,
		topology: plugin.name,
		controlMode,
		goal: { title: goalText.slice(0, 120), text: goalText, rubric: flags.rubric?.[0] },
		budget: {
			...(cfg.budget.tokens ? { tokens: cfg.budget.tokens } : {}),
			...(cfg.budget.usd ? { usd: cfg.budget.usd } : {}),
		},
		reservePct: cfg.budget.reservePct,
		wallSeconds: cfg.budget.wallSeconds,
		pools: cfg.pools,
		secrets: cfg.secrets,
		verifier,
		enableBlindReview: cfg.enableBlindReview,
		networkOffWorkers: cfg.networkOffWorkers,
		skillsDirs: cfg.skillsDirs,
		autoHandoffOnSecondCompaction: cfg.autoHandoffOnSecondCompaction,
		decisionClient,
		rawConfig: { runDir, controlMode, checkpointPolicy },
		store,
		router,
	});

	let dashboardHandle: Awaited<ReturnType<typeof startDashboard>> | undefined;
	if (flags.dashboard) {
		dashboardHandle = await startDashboard(store, { port: Number(flags.port?.[0] ?? 4747) });
		console.log(`Dashboard: ${dashboardHandle.url}`);
	}

	const loggedEvents = new Set([
		"run.started",
		"phase.changed",
		"agent.spawned",
		"agent.compacted",
		"agent.handoff",
		"agent.stalled",
		"finding.verdict",
		"run.nominated",
		"quota.cooldown",
		"quota.drained",
		"bound.estimated",
		"bound.paradigm_shift",
		"researcher.checkpoint",
		"run.paused",
		"run.resumed",
		"run.control_applied",
		"evolution.family_launched",
		"evolution.crossover_completed",
		"topology.spawned",
	]);
	os.bus.on((ev) => {
		if (loggedEvents.has(ev.type)) {
			console.log(`[${ev.type}] ${JSON.stringify(ev.data)}`);
		}
	});

	const ac = new AbortController();
	const onSig = () => ac.abort(new Error("SIGINT"));
	process.on("SIGINT", onSig);

	try {
		console.log(`Starting run ${os.runId} (topology=${plugin.name}, mode=${controlMode}, drivers=${cfg.drivers.map((d) => d.id).join(",")}, mcp=${os.mcp.url})`);
		const result = await os.execute(plugin, ac.signal);
		console.log(`\nRun ${os.runId} finished: status=${result.status}`);
		if (result.nominatedFindingId) {
			console.log(`Nominated deliverable: ${result.nominatedFindingId} (rev ${result.nominatedRevision ?? 1})`);
		}
		console.log(`Report: ${result.reportPath}`);
	} finally {
		process.off("SIGINT", onSig);
		await os.dispose();
		await dashboardHandle?.close();
		store.close();
	}
}

async function cmdStatus(projectDir: string, args: string[]): Promise<void> {
	const cfg = loadConfig(projectDir);
	const store = new SqliteStore(join(cfg.dataDir, "one_piece.db"));
	try {
		const run = resolveTargetRun(store, args[0]);
		if (!run) {
			console.log("No runs recorded yet.");
			return;
		}
		const events = store.events(run.id);
		const pausedEvs = events.filter((e) => e.type === "run.paused");
		const resumedEvs = events.filter((e) => e.type === "run.resumed");
		const totalPausedMs = resumedEvs.reduce((s, e) => s + Number(e.data.pausedMs ?? 0), 0);
		const controlEvs = events.filter((e) => e.type === "run.control_applied");
		const latestControlState = controlEvs.at(-1)?.data.nextState ?? (pausedEvs.length > resumedEvs.length ? "paused" : "running");
		const latestBound = events.filter((e) => e.type === "bound.estimated").at(-1)?.data;
		const runDir = typeof run.config.runDir === "string" ? run.config.runDir : join(cfg.dataDir, "runs", run.id);
		const bestPtrPath = join(runDir, "best-so-far.json");
		const bestPtr = existsSync(bestPtrPath) ? JSON.parse(readFileSync(bestPtrPath, "utf8")) : undefined;
		const briefsDir = join(runDir, "checkpoints");
		const latestBrief = existsSync(briefsDir)
			? readdirSync(briefsDir).filter((f) => f.endsWith(".md")).sort().at(-1)
			: undefined;

		console.log(`Run: ${run.id}`);
		console.log(`Topology: ${run.topology} | Status: ${run.status} | Control: ${String(latestControlState)}`);
		console.log(`Goal: ${run.goal.title}`);
		console.log(`Tokens Spent: ${(run.spent.tokens ?? 0).toLocaleString()} | Paused Time: ${(totalPausedMs / 1000).toFixed(1)}s`);
		if (bestPtr) {
			console.log(`Best So Far: ${bestPtr.findingId} rev ${bestPtr.revision} (score=${bestPtr.score ?? "n/a"}, sha=${String(bestPtr.artifactSha256 ?? "").slice(0, 12)})`);
		}
		if (latestBound) {
			console.log(`Roofline (${String(latestBound.metricName ?? "score")}): Tier-1 Hard=${String(latestBound.hardCeiling ?? "unbounded")} | Tier-2 Paradigm=${String(latestBound.paradigmCeiling ?? latestBound.estimatedCeiling ?? "open")} | Bottleneck=${String(latestBound.activeBottleneck ?? "n/a")}`);
		}
		if (latestBrief) {
			console.log(`Latest Lab Brief: ${join(briefsDir, latestBrief)}`);
		}
	} finally {
		store.close();
	}
}

async function cmdControl(
	projectDir: string,
	action: "pause" | "resume" | "steer" | "bound" | "coalesce",
	args: string[],
	flags: Record<string, string[]>,
): Promise<void> {
	const cfg = loadConfig(projectDir);
	const store = new SqliteStore(join(cfg.dataDir, "one_piece.db"));
	try {
		let runIdArg: string | undefined;
		let restArgs = args;
		if (args[0] && store.get("runs", args[0])) {
			runIdArg = args[0];
			restArgs = args.slice(1);
		}
		const run = resolveTargetRun(store, runIdArg);
		if (!run) {
			console.error("No target run found.");
			process.exitCode = 1;
			return;
		}

		let payload: RunControlPayload;
		switch (action) {
			case "pause":
				payload = { type: "pause", reason: flags.reason?.[0] ?? (restArgs.join(" ").trim() || undefined) };
				break;
			case "resume":
				payload = { type: "resume", steeringNote: flags.steer?.[0] ?? (restArgs.join(" ").trim() || undefined) };
				break;
			case "steer": {
				const message = restArgs.join(" ").trim() || flags.message?.[0]?.trim() || "";
				if (!message) {
					console.error('Usage: one-piece steer [runId] "<message>" [--agent <id>] [--live]');
					process.exitCode = 1;
					return;
				}
				payload = {
					type: "steer",
					message,
					targetAgentId: flags.agent?.[0],
					scope: flags.live ? "live_workers" : "both",
				};
				break;
			}
			case "bound": {
				const override: BoundOverride = {
					...(flags.hard?.[0] !== undefined ? { hardCeiling: flags.hard[0] === "null" ? null : Number(flags.hard[0]) } : {}),
					...(flags.paradigm?.[0] !== undefined ? { paradigmCeiling: flags.paradigm[0] === "null" ? null : Number(flags.paradigm[0]) } : {}),
					...(flags.bottleneck?.[0] ? { activeBottleneck: flags.bottleneck[0] } : {}),
					...(flags["break-assumption"]?.[0] ? { markAssumptionBroken: flags["break-assumption"][0] } : {}),
				};
				payload = { type: "update_bound", override, reason: flags.reason?.[0] };
				break;
			}
			case "coalesce":
				payload = { type: "coalesce", reason: flags.reason?.[0] ?? (restArgs.join(" ").trim() || undefined) };
				break;
		}

		const rec = writeControlCommand(store, run.id, payload);
		console.log(`Queued control command ${rec.id} (${action}) for run ${run.id}.`);
	} finally {
		store.close();
	}
}

async function cmdRuns(projectDir: string): Promise<void> {
	const cfg = loadConfig(projectDir);
	const store = new SqliteStore(join(cfg.dataDir, "one_piece.db"));
	try {
		const runs = store.list("runs").sort((a, b) => b.createdAt - a.createdAt);
		if (!runs.length) {
			console.log("No runs recorded yet.");
			return;
		}
		for (const r of runs) {
			console.log(`${r.id}  [${r.topology}]  ${r.status.padEnd(8)}  nominated=${r.nominatedFindingId ?? "-"}  ${r.goal.title}`);
		}
	} finally {
		store.close();
	}
}

async function cmdDashboard(projectDir: string, flags: Record<string, string[]>): Promise<void> {
	const cfg = loadConfig(projectDir);
	const store = new SqliteStore(join(cfg.dataDir, "one_piece.db"));
	const handle = await startDashboard(store, { port: Number(flags.port?.[0] ?? 4747) });
	console.log(`one_piece v4 dashboard running at ${handle.url} (Ctrl+C to stop)`);
	await new Promise<void>((resolve) => {
		process.once("SIGINT", () => {
			void handle.close().finally(() => {
				store.close();
				resolve();
			});
		});
	});
}

function cmdSecrets(args: string[]): void {
	const sub = args[0];
	if (sub === "set" && args[1] && args[2]) {
		if (process.platform !== "darwin") {
			console.error("Keychain storage is macOS-only; set ONE_PIECE_SECRET_<NAME> in your environment.");
			process.exitCode = 1;
			return;
		}
		execFileSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", args[1], "-w", args[2]]);
		console.log(`Stored secret "${args[1]}" in macOS Keychain.`);
		return;
	}
	console.log("Usage: one-piece secrets set <name> <value>");
}

function printHelp(): void {
	console.log([
		"one_piece v4 — Topology-Engineered Multi-CLI Swarm OS",
		"",
		"Commands:",
		'  run "<goal>"        Run a swarm (--topology, --mode research|eval, --checkpoint-policy, --bound-analyst, --generations, --drivers, --dashboard)',
		"  status [runId]      Show run status, control state, best-so-far, Roofline bound, and latest Lab Brief",
		"  pause [runId]       Pause a research run (freezes wall-clock countdown)",
		"  resume [runId]      Resume a paused research run (--steer \"...\")",
		'  steer [runId] "<m>" Inject steering guidance (--agent <id>, --live)',
		"  bound [runId]       Override Roofline ceilings (--hard N, --paradigm N, --bottleneck \"...\", --break-assumption A1)",
		"  coalesce [runId]    Gracefully stop work and ship best verified deliverable",
		"  doctor              Check codex/grok/gemini/pi drivers, local MCP bus, and Seatbelt sandbox",
		"  runs                List runs recorded in this project",
		"  dashboard           Launch the local telemetry & control dashboard (127.0.0.1:4747)",
		"  secrets set <k> <v> Store a capability secret in macOS Keychain",
		"",
		`Topologies: ${TOPOLOGY_NAMES.join(", ")}`,
		"Driver presets: codex, codex-exec, grok, grok-cli, agy, gemini, gemini-legacy, openrouter, openai, sim",
	].join("\n"));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const { command, args, flags } = parseArgs(argv);
	const projectDir = resolve(flags.project?.[0] ?? process.cwd());
	switch (command) {
		case "doctor":
			await cmdDoctor(projectDir, flags);
			break;
		case "run":
			await cmdRun(projectDir, args, flags);
			break;
		case "status":
			await cmdStatus(projectDir, args);
			break;
		case "pause":
		case "resume":
		case "steer":
		case "bound":
		case "coalesce":
			await cmdControl(projectDir, command, args, flags);
			break;
		case "runs":
			await cmdRuns(projectDir);
			break;
		case "dashboard":
			await cmdDashboard(projectDir, flags);
			break;
		case "secrets":
			cmdSecrets(args);
			break;
		default:
			printHelp();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	void main().catch((err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	});
}
