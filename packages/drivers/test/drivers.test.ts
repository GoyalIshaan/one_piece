import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus, MemoryStore, Redactor } from "@one-piece/core";
import {
	AgyAcpDriver,
	classifyQuotaError,
	CodexAppServerDriver,
	CodexExecDriver,
	DriverQuotaRouter,
	GeminiCliDriver,
	GrokAcpDriver,
	GrokCliDriver,
	maybeCompactSession,
	prepareCleanCodexHome,
	prepareCleanGrokHome,
} from "../src/index.ts";

function makeFakeBinary(dir: string, name: string, jsBody: string): string {
	const path = join(dir, name);
	writeFileSync(path, `#!/usr/bin/env node\n${jsBody}\n`, "utf8");
	chmodSync(path, 0o755);
	return path;
}

describe("drivers & 3-class quota classification", () => {
	it("classifies Class 1 transient, Class 2 window exhausted, and Class 3 hard auth errors", () => {
		expect(classifyQuotaError("HTTP 429 Too Many Requests: try again in 5s")?.kind).toBe("transient_rpm");
		expect(classifyQuotaError("Error: 5-hour usage limit reached, resets in 45 min")?.kind).toBe("window_exhausted");
		expect(classifyQuotaError("RESOURCE_EXHAUSTED: limit: 0")?.kind).toBe("window_exhausted");
		expect(classifyQuotaError("HTTP 403 Forbidden: This credential is only authorized for use with Claude Code")?.kind).toBe("hard_auth_or_cap");
		expect(classifyQuotaError("Weekly quota cap exhausted")?.kind).toBe("hard_auth_or_cap");
		expect(classifyQuotaError("This client is no longer supported for Gemini Code Assist for individuals")?.kind).toBe("hard_auth_or_cap");
		expect(classifyQuotaError("The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT account. (model_not_found)")?.kind).toBe("hard_auth_or_cap");
		expect(classifyQuotaError("SyntaxError in foo.ts")).toBeUndefined();
	});

	it("drives CodexAppServerDriver (initialize, thread/start, turn/start, turn/steer)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-drv-codex-"));
		try {
			const fakeCodex = makeFakeBinary(
				dir,
				"fake-codex",
				`
				const rl = require("node:readline").createInterface({ input: process.stdin });
				let steered = "";
				rl.on("line", (line) => {
					const msg = JSON.parse(line);
					if (msg.method === "initialize") {
						console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
					} else if (msg.method === "thread/start") {
						console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thr-123" } } }));
					} else if (msg.method === "turn/start") {
						console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "turn-1" } } }));
						console.log(JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { turn: { id: "turn-1" } } }));
						console.log(JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "codex-ok:" + (process.env.OPENAI_API_KEY || "sub") } }));
						console.log(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-1", status: "completed", usage: { input_tokens: 100, output_tokens: 20 } } } }));
					} else if (msg.method === "turn/steer") {
						steered = msg.params.input[0].text;
						console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { steered } }));
					}
				});
				`,
			);
			process.env.OPENAI_API_KEY = "should-be-stripped";
			const drv = new CodexAppServerDriver({ id: "codex", kind: "codex-app-server", binary: fakeCodex, subscriptionMode: true });
			const sess = await drv.spawn({ runId: "r1", agentId: "a1", role: "worker", workspace: dir });
			const res = await sess.runTurn("hello");
			expect(res.status).toBe("completed");
			expect(res.finalText).toBe("codex-ok:sub");
			expect(res.sessionId).toBe("thr-123");
			expect(res.usage?.inputTokens).toBe(100);
			await sess.close();
		} finally {
			delete process.env.OPENAI_API_KEY;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("drives GrokCliDriver with --no-subagents --no-plan --no-memory and .grok/config.toml MCP injection", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-drv-grok-"));
		try {
			const fakeGrok = makeFakeBinary(
				dir,
				"fake-grok",
				`
				const args = process.argv.slice(2);
				const hasDisable = args.includes("--no-subagents") && args.includes("--no-plan") && args.includes("--no-memory");
				console.log(JSON.stringify({ type: "assistant", session_id: "grok-s1", text: "grok:" + hasDisable + ":" + (process.env.XAI_API_KEY || "sub") }));
				console.log(JSON.stringify({ type: "result", session_id: "grok-s1", usage: { input_tokens: 50, output_tokens: 10 } }));
				`,
			);
			process.env.XAI_API_KEY = "strip-me";
			const drv = new GrokCliDriver({ id: "grok", kind: "grok-cli", binary: fakeGrok, subscriptionMode: true });
			const sess = await drv.spawn({
				runId: "r1",
				agentId: "a1",
				role: "worker",
				workspace: dir,
				mcp: { url: "http://127.0.0.1:9999/mcp", token: "tok123", serverName: "swarm" },
			});
			const res = await sess.runTurn("fix bug");
			expect(res.status).toBe("completed");
			expect(res.finalText).toBe("grok:true:sub");
			expect(existsSync(join(dir, ".grok", "config.toml"))).toBe(true);
			expect(readFileSync(join(dir, ".grok", "config.toml"), "utf8")).toContain("http://127.0.0.1:9999/mcp");
			await sess.close();
		} finally {
			delete process.env.XAI_API_KEY;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("drives GeminiCliDriver (headless stream-json & ACP) with .gemini/settings.json injection", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-drv-gemini-"));
		try {
			const fakeGemini = makeFakeBinary(
				dir,
				"fake-gemini",
				`
				console.log(JSON.stringify({ type: "init", session_id: "gem-42", model: "gemini-2.5-pro" }));
				console.log(JSON.stringify({ type: "message", role: "assistant", content: "gemini-ok:" + (process.env.GEMINI_API_KEY || "oauth") }));
				console.log(JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 80, output_tokens: 15 } }));
				`,
			);
			process.env.GEMINI_API_KEY = "strip-me";
			const drv = new GeminiCliDriver({ id: "gemini", kind: "gemini-cli", binary: fakeGemini, subscriptionMode: true });
			const sess = await drv.spawn({
				runId: "r1",
				agentId: "a1",
				role: "worker",
				workspace: dir,
				mcp: { url: "http://127.0.0.1:8888/mcp", token: "gtok", serverName: "swarm" },
			});
			const res = await sess.runTurn("audit repo");
			expect(res.status).toBe("completed");
			expect(res.sessionId).toBe("gem-42");
			expect(res.finalText).toBe("gemini-ok:oauth");
			expect(readFileSync(join(dir, ".gemini", "settings.json"), "utf8")).toContain("http://127.0.0.1:8888/mcp");
			await sess.close();
		} finally {
			delete process.env.GEMINI_API_KEY;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("marks Class 2 COOLDOWN and Class 3 DRAINED (0 retries) on DriverQuotaRouter with cross-provider avoidance", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-drv-q-"));
		try {
			const bus = new EventBus(new MemoryStore(), new Redactor());
			const d1 = new CodexExecDriver({ id: "codex", kind: "codex-exec", binary: "codex" });
			const d2 = new GrokCliDriver({ id: "grok", kind: "grok-cli", binary: "grok" });
			const router = new DriverQuotaRouter({
				drivers: [
					{ driver: d1, config: { id: "codex", kind: "codex-exec" } },
					{ driver: d2, config: { id: "grok", kind: "grok-cli" } },
				],
				roles: { worker: ["codex", "grok"], reviewer: ["codex", "grok"] },
				bus,
				runId: "r1",
			});

			// Cross-provider reviewer avoidance picks grok when avoiding codex
			const rev = await router.acquireForRole("reviewer", { avoidDrivers: ["codex"] });
			expect(rev.driver.id).toBe("grok");
			rev.release();

			// Class 3 drains codex permanently; next acquire must pick grok
			router.reportQuotaError("codex", { kind: "hard_auth_or_cap", reason: "403", raw: "403" });
			const next = await router.acquireForRole("worker");
			expect(next.driver.id).toBe("grok");
			next.release();
			expect(router.status().find((s) => s.driverId === "codex")?.state).toBe("drained");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("drives GrokAcpDriver over ACP stdio with session/new HTTP MCP injection and turn_completed usage", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-drv-grok-acp-"));
		try {
			const fakeGrok = makeFakeBinary(
				dir,
				"fake-grok-acp",
				`
				const rl = require("node:readline").createInterface({ input: process.stdin });
				let sawMcpUrl = "";
				rl.on("line", (line) => {
					const msg = JSON.parse(line);
					if (msg.method === "initialize") {
						console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }));
					} else if (msg.method === "session/new") {
						sawMcpUrl = msg.params.mcpServers?.[0]?.url || "";
						console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "grok-acp-1", models: { currentModelId: "grok-4.7" } } }));
					} else if (msg.method === "session/prompt") {
						console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "grok-acp-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "grok-acp:" + sawMcpUrl + ":" + (process.env.GROK_SUBAGENTS || "") + ":" + (process.env.XAI_API_KEY || "sub") } } } }));
						console.log(JSON.stringify({ jsonrpc: "2.0", method: "_x.ai/session_notification", params: { sessionId: "grok-acp-1", update: { sessionUpdate: "turn_completed", usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedReadTokens: 60 } } } }));
						console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", _meta: { modelId: "grok-4.7" } } }));
					}
				});
				`,
			);
			process.env.XAI_API_KEY = "strip-me";
			const drv = new GrokAcpDriver({ id: "grok", kind: "grok-acp", binary: fakeGrok, subscriptionMode: true });
			const sess = await drv.spawn({
				runId: "r1",
				agentId: "a1",
				role: "worker",
				workspace: dir,
				mcp: { url: "http://127.0.0.1:7777/mcp", token: "tok", serverName: "swarm", toolNames: ["board_publish"] },
			});
			const res = await sess.runTurn("do work");
			expect(res.status).toBe("completed");
			expect(res.sessionId).toBe("grok-acp-1");
			expect(res.model).toBe("grok-4.7");
			expect(res.finalText).toBe("grok-acp:http://127.0.0.1:7777/mcp:0:sub");
			expect(res.usage?.inputTokens).toBe(120);
			expect(res.usage?.cachedTokens).toBe(60);
			await sess.close();
		} finally {
			delete process.env.XAI_API_KEY;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("drives AgyAcpDriver over ACP stdio with session/new HTTP MCP injection and model selection", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-drv-agy-acp-"));
		try {
			const fakeAgy = makeFakeBinary(
				dir,
				"fake-agy",
				`
				const rl = require("node:readline").createInterface({ input: process.stdin });
				let sawMcpUrl = "";
				let selectedModel = "";
				rl.on("line", (line) => {
					const msg = JSON.parse(line);
					if (msg.method === "initialize") {
						console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }));
					} else if (msg.method === "session/new") {
						sawMcpUrl = msg.params.mcpServers?.[0]?.url || "";
						console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "agy-s1" } }));
					} else if (msg.method === "session/set_model") {
						selectedModel = msg.params.modelId;
						console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
					} else if (msg.method === "session/prompt") {
						console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "agy:" + selectedModel + ":" + sawMcpUrl } } } }));
						console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 210, outputTokens: 40, cachedReadTokens: 50, thoughtTokens: 15, totalTokens: 250 } } }));
					}
				});
				`,
			);
			const drv = new AgyAcpDriver({ id: "agy", kind: "agy-acp", binary: fakeAgy, model: "gemini-3.8-flash-medium" });
			const sess = await drv.spawn({
				runId: "r1",
				agentId: "a1",
				role: "worker",
				workspace: dir,
				mcp: { url: "http://127.0.0.1:6666/mcp", token: "tok", serverName: "swarm" },
			});
			const res = await sess.runTurn("check");
			expect(res.status).toBe("completed");
			expect(res.sessionId).toBe("agy-s1");
			expect(res.model).toBe("gemini-3.8-flash-medium");
			expect(res.finalText).toBe("agy:gemini-3.8-flash-medium:http://127.0.0.1:6666/mcp");
			expect(res.usage?.inputTokens).toBe(210);
			expect(res.usage?.reasoningTokens).toBe(15);
			expect(res.usage?.totalTokens).toBe(250);
			await sess.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prepares isolated clean CODEX_HOME and GROK_HOME with auth symlinks and disabled ambient bloat", () => {
		const dir = mkdtempSync(join(tmpdir(), "op-cli-homes-"));
		try {
			const fakeCodexSrc = join(dir, "src-codex");
			const fakeGrokSrc = join(dir, "src-grok");
			const cleanCodex = join(dir, "clean-codex");
			const cleanGrok = join(dir, "clean-grok");
			mkdirSync(fakeCodexSrc, { recursive: true });
			mkdirSync(fakeGrokSrc, { recursive: true });
			writeFileSync(join(fakeCodexSrc, "auth.json"), '{"token":"codex-ok"}', "utf8");
			writeFileSync(join(fakeCodexSrc, "config.toml"), 'model = "gpt-6.2-sol"\n[mcp_servers.robinhood]\nurl = "https://bad"\n', "utf8");
			writeFileSync(join(fakeGrokSrc, "auth.json"), '{"token":"grok-ok"}', "utf8");

			const cDir = prepareCleanCodexHome({ baseDir: cleanCodex, sourceCodexDir: fakeCodexSrc });
			const cCfg = readFileSync(join(cDir, "config.toml"), "utf8");
			expect(cCfg).toContain('model = "gpt-6.2-sol"');
			expect(cCfg).toContain("enabled = false");
			expect(cCfg).not.toContain("robinhood");
			expect(readFileSync(join(cDir, "auth.json"), "utf8")).toContain("codex-ok");

			const gDir = prepareCleanGrokHome({ baseDir: cleanGrok, sourceGrokDir: fakeGrokSrc });
			const gCfg = readFileSync(join(gDir, "config.toml"), "utf8");
			expect(gCfg).toContain("[compat.claude]");
			expect(gCfg).toContain("[compat.cursor]");
			expect(gCfg).toContain("skills = false");
			expect(readFileSync(join(gDir, "auth.json"), "utf8")).toContain("grok-ok");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("applies watermark micro-compaction with artifact spillover, structured anchor preserving failed approaches, and signals Tier 2 handoff", () => {
		const spilled: Array<{ label: string; content: string }> = [];
		const messages: any[] = [
			{ role: "user", content: [{ type: "text", text: "Solve subtle parser bug" }] },
			{ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "AssertionError: empty string token failed\n" + "x".repeat(4000) }] },
			{ role: "assistant", content: [{ type: "text", text: "Tried regex split, failed on empty tokens" }] },
			...Array.from({ length: 8 }, (_, i) => ({
				role: i % 2 === 0 ? "toolResult" : "assistant",
				toolName: "bash",
				content: [{ type: "text", text: `turn ${i}: ` + "y".repeat(2500) }],
			})),
		];

		// Below watermark -> zero mutation (preserves KV cache!)
		const noop = maybeCompactSession({
			messages,
			systemPrompt: "static",
			contextWindow: 100_000,
			compactionCount: 0,
		});
		expect(noop.compacted).toBeUndefined();
		expect(noop.needsHandoff).toBe(false);

		// First watermark -> micro-compacts old large tool outputs into artifacts
		const first = maybeCompactSession({
			messages,
			systemPrompt: "static",
			contextWindow: 8_000,
			compactionCount: 0,
			policy: {
				watermarkFraction: 0.7,
				keepRecentTurns: 4,
				minPruneBytes: 512,
				maxCompactionsBeforeHandoff: 2,
				spillArtifact: (label, content) => {
					spilled.push({ label, content });
					return { id: `art-${spilled.length}`, sha256: "abcdef1234567890" };
				},
			},
		});
		expect(first.compacted?.strategy).toBe("micro");
		expect(first.compactionCount).toBe(1);
		expect(first.needsHandoff).toBe(false);
		expect(spilled.length).toBeGreaterThan(0);

		// Second watermark -> escalates to structured anchor preserving failed approaches, pinned checklist, and signals Tier 2 handoff
		const second = maybeCompactSession({
			messages: first.messages,
			systemPrompt: "static",
			contextWindow: 3_000,
			compactionCount: first.compactionCount,
			policy: {
				watermarkFraction: 0.7,
				keepRecentTurns: 4,
				maxCompactionsBeforeHandoff: 2,
				pinnedChecklist: ["Pass all parser edge tests", "Keep changes inside src/parser.ts"],
			},
		});
		expect(second.compacted?.strategy).toBe("anchor");
		expect(second.compactionCount).toBe(2);
		expect(second.needsHandoff).toBe(true);
		const anchorText = (second.messages[0] as any).content[0].text;
		expect(anchorText).toContain("Failed Approaches");
		expect(anchorText).toContain("AssertionError");
		expect(anchorText).toContain("Pinned Acceptance Checklist (DO NOT DROP)");
		expect(anchorText).toContain("Pass all parser edge tests");
		expect(anchorText).toContain("Keep changes inside src/parser.ts");
		// Never split leaving an orphaned toolResult at recent[0] (would cause HTTP 400 on LLM APIs)
		expect((second.messages[1] as any).role).not.toBe("toolResult");
	});

	it("routes by minTier/maxTier cleanly and falls back gracefully on single-tier pools", async () => {
		const mkFake = (id: string) => ({
			id,
			kind: "codex-exec" as const,
			capabilities: { supportsSteer: false, supportsResume: false, supportsOutputSchema: false, supportsMcpHttp: false },
			async healthCheck() {
				return { ok: true, driverId: id, kind: "codex-exec" as const };
			},
			async spawn() {
				return { driverId: id, async runTurn() { return { status: "completed" as const, finalText: "ok" }; }, async close() {} };
			},
		});

		const router = new DriverQuotaRouter({
			drivers: [
				{ driver: mkFake("fast"), config: { id: "fast", kind: "codex-exec", tier: "sidekick" } },
				{ driver: mkFake("std"), config: { id: "std", kind: "codex-exec", tier: "standard" } },
				{ driver: mkFake("big"), config: { id: "big", kind: "codex-exec", tier: "frontier" } },
			],
			roles: { default: ["fast", "std", "big"] },
		});

		expect(router.getDriverTier("fast")).toBe("sidekick");
		expect(router.getDriverTier("big")).toBe("frontier");

		const selSidekick = await router.acquireForRole("explorer", { maxTier: "sidekick" });
		expect(selSidekick.driver.id).toBe("fast");
		selSidekick.release();

		const selFrontier = await router.acquireForRole("worker", { minTier: "frontier" });
		expect(selFrontier.driver.id).toBe("big");
		selFrontier.release();

		// Single-tier pool gracefully falls back when frontier is requested
		const singleRouter = new DriverQuotaRouter({
			drivers: [{ driver: mkFake("only"), config: { id: "only", kind: "codex-exec", tier: "sidekick" } }],
			roles: { default: ["only"] },
		});
		const fallback = await singleRouter.acquireForRole("worker", { minTier: "frontier" });
		expect(fallback.driver.id).toBe("only");
		fallback.release();
	});

	it("never hold-and-wait deadlocks when spawning N concurrent workers equal to aggregate multi-driver capacity", async () => {
		const mkFake = (id: string) => ({
			id,
			kind: "codex-exec" as const,
			capabilities: { supportsSteer: false, supportsResume: false, supportsOutputSchema: false, supportsMcpHttp: false },
			healthCheck: async () => ({ ok: true, driverId: id, kind: "codex-exec" as const }),
			spawn: async () => ({ driverId: id, runTurn: async () => ({ status: "completed" as const, finalText: "" }), close: async () => {} }),
		});

		const router = new DriverQuotaRouter({
			drivers: [
				{ driver: mkFake("codex"), config: { id: "codex", kind: "codex-exec", maxConcurrent: 2 } },
				{ driver: mkFake("gemini"), config: { id: "gemini", kind: "codex-exec", maxConcurrent: 2 } },
			],
			roles: { default: ["codex", "gemini"] },
		});

		// Repeatedly acquire 4 simultaneous permits across 2x2 capacity (would previously deadlock whenever rotation picked 3+ on one driver!)
		for (let round = 0; round < 50; round++) {
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(new Error("deadlock")), 500);
			try {
				const sels = await Promise.all(
					Array.from({ length: 4 }, () => router.acquireForRole("worker", { signal: ac.signal })),
				);
				const counts = sels.reduce<Record<string, number>>((acc, s) => {
					acc[s.driver.id] = (acc[s.driver.id] ?? 0) + 1;
					return acc;
				}, {});
				expect(counts.codex).toBe(2);
				expect(counts.gemini).toBe(2);
				for (const s of sels) s.release();
			} finally {
				clearTimeout(timer);
			}
		}

		// Also verify 2-worker waves ALWAYS split 1+1 across 2 equal-weight providers (least-loaded diversity, RSI-7)
		for (let round = 0; round < 20; round++) {
			const [a, b] = await Promise.all([router.acquireForRole("worker"), router.acquireForRole("worker")]);
			expect(new Set([a.driver.id, b.driver.id]).size).toBe(2);
			a.release();
			b.release();
		}
	});

	it("preserves accumulated token usage when a Codex app-server turn is interrupted (RSI-7)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-codex-abort-usage-"));
		try {
			const fakeCodex = makeFakeBinary(
				dir,
				"fake-codex-abort",
				`
				const rl = require("node:readline").createInterface({ input: process.stdin });
				rl.on("line", (line) => {
					const msg = JSON.parse(line);
					if (msg.method === "initialize") {
						console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
					} else if (msg.method === "thread/start") {
						console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "th-abort", model: "gpt-6.2-sol" } } }));
					} else if (msg.method === "turn/start") {
						console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
						console.log(JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { turn: { id: "t-1" } } }));
						console.log(JSON.stringify({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { inputTokens: 12000, cachedInputTokens: 4000, outputTokens: 850, reasoningOutputTokens: 200, totalTokens: 12850 } } } }));
						// Deliberately stall until interrupted by timeoutMs/signal!
					} else if (msg.method === "turn/interrupt") {
						console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
					}
				});
				`,
			);
			const drv = new CodexAppServerDriver({ id: "codex-abort", kind: "codex-app-server", binary: fakeCodex });
			const sess = await drv.spawn({ runId: "r1", agentId: "a1", role: "worker", workspace: dir });
			const res = await sess.runTurn("long task", { timeoutMs: 250 });
			expect(res.status).toBe("interrupted");
			expect(res.usage?.totalTokens).toBe(12850);
			expect(res.usage?.inputTokens).toBe(12000);
			expect(res.usage?.outputTokens).toBe(850);
			expect(res.usage?.cachedTokens).toBe(4000);
			await sess.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
