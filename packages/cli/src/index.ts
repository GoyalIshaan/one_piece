#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { DEFAULT_PROFILES, type HarnessModule, type Run } from "@one-piece/core";
import { startDashboard } from "@one-piece/dashboard";
import { createHarness, simPolicy } from "@one-piece/engine";
import { boardModule } from "@one-piece/module-board";
import { questionsModule } from "@one-piece/module-questions";
import { KEYCHAIN_SERVICE, keychainLookup, secretsModule } from "@one-piece/module-secrets";
import { workspaceModule } from "@one-piece/module-workspace";
import { FileCredentialStore, PROVIDER_FACTORIES, Router } from "@one-piece/router";
import { schedulerModule } from "@one-piece/scheduler";
import { SqliteStore } from "@one-piece/store";
import { homeDir, loadConfig, PROVIDER_DEFAULTS } from "./config.ts";

const HELP = `one-piece: a harness for recursive agent swarms

Usage:
  one-piece run "<goal>" [options]     Plan, search, verify and report on a goal
  one-piece dashboard [--port 4747]    Open the telemetry dashboard for this project
  one-piece runs                       List this project's runs
  one-piece eval [--suite smoke|full]  Run the eval suite (hidden graders, health checks, report)
                 [--task id] [--provider id] [--budget-scale 0.5] [--mode solo]
  one-piece models <provider>          List a provider's models
  one-piece login <provider>           Sign in (openai = Sign in with ChatGPT, openrouter, ...)
  one-piece secrets set <name>         Store a secret in the macOS Keychain
  one-piece secrets list               Show configured secret capabilities

Run options:
  --title <text>            Short name for the run
  --rubric <text>           What good looks like for the whole goal
  --provider <id>           Repeatable: openai, openrouter, xai, anthropic, openai-codex, sim
  --kind <kind>             code | literature | ml | kernels (picks the default modules)
  --workspace <dir>         Project folder copied into each leaf's workspace
  --budget-tokens <n>       Token budget for the whole run
  --budget-usd <n>          Dollar budget for the whole run
  --concurrency <n>         Agents running at once
  --dashboard               Serve the dashboard while the run is going
  --port <n>                Dashboard port (default 4747)
  --project <dir>           Project folder (default: the current folder)

Everything (store, workspaces, reports) lives in ./.one_piece, so each project is isolated.
Credentials live in ~/.one_piece/auth.json (chmod 600) and the Keychain.`;

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			title: { type: "string" },
			rubric: { type: "string" },
			provider: { type: "string", multiple: true },
			kind: { type: "string" },
			workspace: { type: "string" },
			"budget-tokens": { type: "string" },
			"budget-usd": { type: "string" },
			concurrency: { type: "string" },
			dashboard: { type: "boolean" },
			port: { type: "string" },
			project: { type: "string" },
			suite: { type: "string" },
			task: { type: "string", multiple: true },
			"budget-scale": { type: "string" },
			mode: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	const [command, ...rest] = positionals;
	// `npm run one-piece` executes from the repo root; INIT_CWD is the folder the user ran it in.
	const baseDir = process.env.INIT_CWD ?? process.cwd();
	const projectDir = resolve(baseDir, values.project ?? ".");
	if (!command || values.help) {
		console.log(HELP);
		return;
	}
	const config = loadConfig(projectDir, values.provider);
	const dbPath = join(config.dataDir, "one_piece.db");

	switch (command) {
		case "run": {
			const goalText = rest.join(" ").trim();
			if (!goalText) throw new Error('Give a goal: one-piece run "your goal"');
			mkdirSync(config.dataDir, { recursive: true });
			const store = new SqliteStore(dbPath);
			const router = new Router({
				providers: config.providers,
				credentialsPath: join(homeDir(), "auth.json"),
				providerFactories: PROVIDER_FACTORIES,
				simPolicy,
			});
			const kind = (values.kind ?? config.kind) as keyof typeof DEFAULT_PROFILES;
			const modules: HarnessModule[] = [
				questionsModule({ deadlineMs: config.questionDeadlineMinutes * 60_000 }),
				boardModule(),
				workspaceModule(),
				schedulerModule(config.pools),
				secretsModule({ secrets: config.secrets }),
			];
			const runDir = join(config.dataDir, "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}`);
			const harness = createHarness({
				store,
				router,
				modules,
				config: {
					runDir,
					seedWorkspace: values.workspace ? resolve(baseDir, values.workspace) : undefined,
					maxConcurrentAgents: Number(values.concurrency ?? config.maxConcurrentAgents),
					profile: { ...(DEFAULT_PROFILES[kind] ?? DEFAULT_PROFILES.code), ...(config.secrets.length ? {} : { secrets: "off" }) },
					caps: config.caps,
					questionDeadlineMs: config.questionDeadlineMinutes * 60_000,
				},
			});
			const budget: Record<string, number> = {};
			const tokens = values["budget-tokens"] ?? config.budget.tokens;
			const usd = values["budget-usd"] ?? config.budget.usd;
			if (tokens !== undefined) budget.tokens = Number(tokens);
			if (usd !== undefined) budget.usd = Number(usd);
			for (const [k, v] of Object.entries(config.budget)) if (!(k in budget) && v !== undefined) budget[k] = v;
			let dashboard: ReturnType<typeof startDashboard> | undefined;
			if (values.dashboard) {
				dashboard = startDashboard({ dbPath, port: Number(values.port ?? 4747) });
				console.log(`Dashboard: ${dashboard.url}`);
			}
			const run: Run = await harness.start(
				{ title: values.title ?? goalText.slice(0, 80), text: goalText, rubric: values.rubric },
				budget,
				{ workspace: values.workspace ? resolve(baseDir, values.workspace) : undefined, config: { kind, providers: config.providers.map((p) => p.id) } },
			);
			console.log(`Run ${run.id} started (${config.providers.map((p) => p.id).join(", ")}; budget ${JSON.stringify(budget)}).`);
			console.log(`Run folder: ${runDir}`);
			harness.bus.on((e) => {
				if (["node.spawned", "finding.verdict", "epoch.started", "question.escalated_to_user", "run.finished", "agent.error"].includes(e.type)) {
					const node = e.nodeId ? harness.tree.get(e.nodeId) : undefined;
					console.log(`[${new Date(e.ts).toLocaleTimeString()}] ${e.type} ${node ? `${node.role} "${node.goal.title}"` : ""} ${JSON.stringify(e.data).slice(0, 160)}`);
				}
			});
			const stop = () => {
				console.log("\nStopping the run; everything so far is saved.");
				harness.finishRun("stopped", "stopped by the user");
			};
			process.once("SIGINT", stop);
			await harness.done;
			process.removeListener("SIGINT", stop);
			console.log(`\nDone. Report: ${join(runDir, "report.md")}`);
			for (const module of modules) await module.dispose?.();
			if (dashboard) console.log(`The dashboard keeps serving at ${dashboard.url} (Ctrl+C to quit).`);
			else store.close();
			return;
		}
		case "eval": {
			const { runEval } = await import("@one-piece/evals");
			const providers = values.provider?.length ? config.providers : loadConfig(projectDir, ["openai", "openrouter"]).providers;
			const router = new Router({ providers, credentialsPath: join(homeDir(), "auth.json"), providerFactories: PROVIDER_FACTORIES, simPolicy });
			await router.prepare();
			console.log(`Providers usable: ${[...new Set(router.menu().map((m) => m.provider))].join(", ")}; menu: ${router.menu().map((m) => m.key).join(", ")}`);
			const { results, reportPath } = await runEval({
				suite: values.suite ?? "smoke",
				taskIds: values.task,
				dataDir: config.dataDir,
				router,
				modules: () => [questionsModule({ deadlineMs: 3 * 60_000 }), boardModule(), workspaceModule(), schedulerModule(config.pools)],
				profile: { questions: "active", board: "active", workspace: "active", scheduler: "active" },
				maxConcurrentAgents: Number(values.concurrency ?? config.maxConcurrentAgents),
				budgetScale: values["budget-scale"] ? Number(values["budget-scale"]) : undefined,
				mode: values.mode === "solo" ? "solo" : "swarm",
				log: (line) => console.log(line),
			});
			const broken = results.filter((r) => r.health.status === "fail").length;
			const healthy = results.filter((r) => r.health.status === "ok").length;
			console.log(`\nMean score ${(results.reduce((a, r) => a + r.score, 0) / results.length).toFixed(3)}. ${healthy}/${results.length} healthy, ${results.length - healthy - broken} with warnings, ${broken} failed.`);
			console.log(`Report: ${reportPath}`);
			process.exitCode = broken ? 1 : 0;
			return;
		}
		case "dashboard": {
			const dashboard = startDashboard({ dbPath, port: Number(values.port ?? 4747) });
			console.log(`one_piece dashboard: ${dashboard.url}  (store: ${dbPath})`);
			return;
		}
		case "runs": {
			const store = new SqliteStore(dbPath);
			for (const run of store.list<Run>("runs").sort((a, b) => b.createdAt - a.createdAt)) {
				console.log(`${run.id}  ${run.status.padEnd(8)} epoch ${run.epoch}  ${new Date(run.createdAt).toLocaleString()}  ${run.goal.title}`);
			}
			store.close();
			return;
		}
		case "models": {
			const id = rest[0];
			if (!id || !PROVIDER_FACTORIES[id]) throw new Error(`Usage: one-piece models <${Object.keys(PROVIDER_FACTORIES).join("|")}>`);
			const router = new Router({ providers: [PROVIDER_DEFAULTS[id]], providerFactories: PROVIDER_FACTORIES });
			for (const m of router.models.getModels(id)) console.log(`${m.id.padEnd(48)} ctx ${String(m.contextWindow).padStart(8)}  ${m.reasoning ? "reasoning" : ""}`);
			return;
		}
		case "login": {
			const id = rest[0];
			const factory = id ? PROVIDER_FACTORIES[id] : undefined;
			if (!factory) throw new Error(`Usage: one-piece login <${Object.keys(PROVIDER_FACTORIES).join("|")}>`);
			const provider = factory();
			const oauth = provider.auth.oauth;
			if (!oauth) throw new Error(`${id} has no sign-in flow; set its API key environment variable instead`);
			const store = new FileCredentialStore(join(homeDir(), "auth.json"));
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			try {
				const credential = await oauth.login(
					{
						signal: new AbortController().signal,
						prompt: async (p: any) => {
							if (p.type === "select") {
								p.options.forEach((o: any, i: number) => console.log(`  ${i + 1}. ${o.label}`));
								const choice = Number(await rl.question(`${p.message} (1-${p.options.length}): `)) - 1;
								return p.options[choice]?.id ?? p.options[0].id;
							}
							return rl.question(`${p.message}: `);
						},
						notify: (event: any) => {
							if (event.type === "auth_url") console.log(`\nOpen this URL in your browser:\n${event.url}\n${event.instructions ?? ""}`);
							else if (event.type === "device_code") console.log(`\nOpen ${event.verificationUri} and enter ${event.userCode}`);
							else if (event.message) console.log(event.message);
						},
					},
					{ getDeviceId: randomUUID },
				);
				await store.modify(provider.id, async () => credential);
				console.log(`Signed in to ${id}. Credentials saved to ${join(homeDir(), "auth.json")} (user-only).`);
			} finally {
				rl.close();
			}
			return;
		}
		case "secrets": {
			const [sub, name] = rest;
			if (sub === "set" && name) {
				if (process.platform !== "darwin") throw new Error(`Set ONE_PIECE_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")} in your environment instead`);
				// The Keychain prompts for the value itself, so it never passes through this program's arguments.
				execFileSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"], { stdio: "inherit" });
				console.log(`Stored ${name} in the Keychain (service "${KEYCHAIN_SERVICE}").`);
				return;
			}
			if (sub === "list") {
				if (!config.secrets.length) console.log('No secrets configured. Add {"secrets": [{"name": "gpu.modal", "env": "MODAL_TOKEN"}]} to one-piece.config.json.');
				for (const s of config.secrets) console.log(`${s.name.padEnd(24)} -> $${s.env.padEnd(24)} ${keychainLookup(s.name) ? "stored" : "missing"}`);
				return;
			}
			throw new Error("Usage: one-piece secrets set <name> | one-piece secrets list");
		}
		default:
			console.log(HELP);
	}
}

main().catch((error) => {
	console.error(`one-piece: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
