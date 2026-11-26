import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus, MemoryStore, Redactor, type ToolDefinition } from "@one-piece/core";
import { boardTools, SwarmBoardService } from "@one-piece/module-board";
import { createFrozenDispatcherTool, materializeToolSchemas, McpBusServer } from "../src/index.ts";

async function rpc(url: string, token: string | undefined, body: unknown) {
	return fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
}

describe("McpBusServer", () => {
	it("authenticates per-worker tokens, enforces role-filtered tool menus, and serves ScaleMAS board tools", async () => {
		const store = new MemoryStore();
		const bus = new EventBus(store, new Redactor());
		const board = new SwarmBoardService(bus);
		const mcp = await McpBusServer.start(bus);

		try {
			const health = await fetch(mcp.url.replace(/\/mcp$/, "/health"));
			expect(health.status).toBe(200);

			// Unauthorized rejected with 401
			const unauth = await rpc(mcp.url, "bad-token", { jsonrpc: "2.0", id: 1, method: "tools/list" });
			expect(unauth.status).toBe(401);

			// Register bounded leaf worker with ONLY board tools (no spawn_task!)
			const leafReg = mcp.registerWorker({
				runId: "r1",
				agentId: "agt-leaf",
				role: "worker",
				tools: boardTools(board),
			});

			const initRes = await rpc(mcp.url, leafReg.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
			expect(initRes.status).toBe(200);
			const initBody = (await initRes.json()) as any;
			expect(initBody.result.serverInfo.name).toBe("one-piece-swarm");

			const listRes = await rpc(mcp.url, leafReg.token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
			const listBody = (await listRes.json()) as any;
			const names = listBody.result.tools.map((t: any) => t.name);
			expect(names).toContain("board_search");
			expect(names).toContain("board_publish");
			expect(names).not.toContain("spawn_task");

			// Direct call to forbidden tool is mechanically rejected
			const denied = await rpc(mcp.url, leafReg.token, {
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "spawn_task", arguments: { title: "rogue" } },
			});
			const deniedBody = (await denied.json()) as any;
			expect(deniedBody.result.isError).toBe(true);

			// Publish & search over MCP
			const pub = await rpc(mcp.url, leafReg.token, {
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: { name: "board_publish", arguments: { topic: "kernel", summary: "Shared memory tiling doubled throughput" } },
			});
			expect(((await pub.json()) as any).result.isError).toBe(false);

			const search = await rpc(mcp.url, leafReg.token, {
				jsonrpc: "2.0",
				id: 5,
				method: "tools/call",
				params: { name: "board_search", arguments: { query: "tiling throughput", k: 5 } },
			});
			const searchBody = (await search.json()) as any;
			expect(searchBody.result.content[0].text).toContain("Shared memory tiling doubled throughput");
		} finally {
			await mcp.close();
		}
	});

	it("sorts tools/list deterministically and supports cache-safe .swarm/tools/ progressive discovery via frozen call_tool", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-mcp-prog-"));
		const store = new MemoryStore();
		const bus = new EventBus(store, new Redactor());
		const mcp = await McpBusServer.start(bus);
		try {
			const extended: ToolDefinition[] = [
				{
					name: "zebra_tool",
					description: "Echoes z",
					inputSchema: { type: "object", properties: { z: { type: "string" }, a: { type: "number" } }, required: ["z"] },
					execute: (args) => ({ text: `z=${String(args.z)}` }),
				},
				{
					name: "alpha_tool",
					description: "Doubles a number",
					inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
					execute: (args) => ({ text: String(Number(args.n) * 2) }),
				},
			];
			const mat = materializeToolSchemas(dir, extended);
			expect(readFileSync(mat.indexPath, "utf8")).toContain("alpha_tool");
			expect(readFileSync(join(mat.dir, "zebra_tool.json"), "utf8")).toContain('"a"');

			const dispatcher = createFrozenDispatcherTool(extended);
			const reg = mcp.registerWorker({
				runId: "r2",
				agentId: "agt-prog",
				role: "worker",
				workspace: dir,
				tools: [
					{ name: "z_hot", description: "hot", inputSchema: { type: "object", properties: {} }, execute: () => ({ text: "ok" }) },
					dispatcher,
					{ name: "a_hot", description: "hot", inputSchema: { type: "object", properties: {} }, execute: () => ({ text: "ok" }) },
				],
			});

			const listRes = await rpc(mcp.url, reg.token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
			const listBody = (await listRes.json()) as any;
			// Strictly alphabetical ordering for KV cache stability
			expect(listBody.result.tools.map((t: any) => t.name)).toEqual(["a_hot", "call_tool", "z_hot"]);

			// Invoke extended tool via frozen dispatcher without mutating tools/list
			const okRes = await rpc(mcp.url, reg.token, {
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "call_tool", arguments: { name: "alpha_tool", arguments: { n: 21 } } },
			});
			const okBody = (await okRes.json()) as any;
			expect(okBody.result.isError).toBe(false);
			expect(okBody.result.content[0].text).toBe("42");

			// Unknown extended tool returns actionable error pointing to INDEX.md
			const badRes = await rpc(mcp.url, reg.token, {
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "call_tool", arguments: { name: "missing_tool" } },
			});
			const badBody = (await badRes.json()) as any;
			expect(badBody.result.isError).toBe(true);
			expect(badBody.result.content[0].text).toContain(".swarm/tools/INDEX.md");
		} finally {
			await mcp.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
