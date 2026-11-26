import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@one-piece/core";

/** Recursively sort JSON object keys so tool schemas serialize byte-identically for KV cache stability. */
export function canonicalizeSchema<T>(value: T): T {
	if (Array.isArray(value)) return value.map((v) => canonicalizeSchema(v)) as unknown as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			out[key] = canonicalizeSchema((value as Record<string, unknown>)[key]);
		}
		return out as T;
	}
	return value;
}

/**
 * Writes extended/overflow tool JSON schemas into `<workspace>/.swarm/tools/`
 * so agents can discover schemas lazily without bloating the token-0 API `tools[]` array.
 */
export function materializeToolSchemas(
	workspace: string,
	extendedTools: readonly ToolDefinition[],
): { dir: string; indexPath: string; indexMarkdown: string } {
	const dir = join(workspace, ".swarm", "tools");
	mkdirSync(dir, { recursive: true });
	const sorted = [...extendedTools].sort((a, b) => a.name.localeCompare(b.name));
	const lines = [
		"# Extended Swarm Tools (Progressive Discovery)",
		"",
		"Inspect `.swarm/tools/<name>.json` for full parameter schemas, then invoke via `call_tool(name, arguments)`.",
		"",
	];

	for (const tool of sorted) {
		const schemaDoc = {
			name: tool.name,
			description: tool.description,
			inputSchema: canonicalizeSchema(tool.inputSchema),
		};
		writeFileSync(join(dir, `${tool.name}.json`), `${JSON.stringify(schemaDoc, null, 2)}\n`, "utf8");
		lines.push(`- \`${tool.name}\`: ${tool.description} (schema: \`.swarm/tools/${tool.name}.json\`)`);
	}

	const indexMarkdown = `${lines.join("\n")}\n`;
	const indexPath = join(dir, "INDEX.md");
	writeFileSync(indexPath, indexMarkdown, "utf8");
	return { dir, indexPath, indexMarkdown };
}

/**
 * Returns a single frozen `call_tool` dispatcher whose schema never mutates mid-session,
 * keeping token-0 KV caches intact while allowing arbitrary extended tool invocation.
 */
export function createFrozenDispatcherTool(extendedTools: readonly ToolDefinition[]): ToolDefinition {
	const map = new Map<string, ToolDefinition>();
	for (const tool of extendedTools) map.set(tool.name, tool);
	const availableNames = [...map.keys()].sort();

	return {
		name: "call_tool",
		description: `Invoke an extended swarm tool discovered in .swarm/tools/INDEX.md (${availableNames.length} available).`,
		inputSchema: canonicalizeSchema({
			type: "object",
			properties: {
				name: { type: "string", description: "Exact extended tool name from .swarm/tools/INDEX.md" },
				arguments: { type: "object", description: "Tool arguments matching .swarm/tools/<name>.json" },
			},
			required: ["name"],
		}),
		async execute(args, ctx) {
			const name = String(args.name ?? "").trim();
			const target = map.get(name);
			if (!target) {
				return {
					text: `Unknown extended tool "${name}". Available: ${availableNames.join(", ")}. Read .swarm/tools/INDEX.md for schemas.`,
					isError: true,
				};
			}
			const toolArgs = args.arguments && typeof args.arguments === "object"
				? (args.arguments as Record<string, unknown>)
				: {};
			return target.execute(toolArgs, ctx);
		},
	};
}
