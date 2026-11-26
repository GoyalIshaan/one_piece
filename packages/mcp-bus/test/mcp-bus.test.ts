import { describe, expect, it } from "vitest";
import { EventBus, MemoryStore, Redactor } from "@one-piece/core";
import { boardTools, SwarmBoardService } from "@one-piece/module-board";
import { McpBusServer } from "../src/index.ts";

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
});
