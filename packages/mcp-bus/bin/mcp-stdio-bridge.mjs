#!/usr/bin/env node
// Minimal zero-dependency stdio <-> Streamable HTTP MCP bridge.
// Used as a fallback if a CLI binary prefers stdio MCP servers over Streamable HTTP.

import { createInterface } from "node:readline";

const url = process.env.ONE_PIECE_MCP_URL;
const token = process.env.ONE_PIECE_MCP_TOKEN;

if (!url || !token) {
	process.stderr.write("mcp-stdio-bridge requires ONE_PIECE_MCP_URL and ONE_PIECE_MCP_TOKEN\n");
	process.exit(2);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	void (async () => {
		try {
			const res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: trimmed,
			});
			if (res.status === 202 || res.status === 204) return;
			const body = await res.text();
			if (body.trim()) process.stdout.write(`${body.trim()}\n`);
		} catch (error) {
			try {
				const parsed = JSON.parse(trimmed);
				if (parsed && parsed.id !== undefined) {
					process.stdout.write(
						`${JSON.stringify({
							jsonrpc: "2.0",
							id: parsed.id,
							error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
						})}\n`,
					);
				}
			} catch {
				// Ignore malformed input.
			}
		}
	})();
});
