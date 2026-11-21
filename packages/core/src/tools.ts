import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Schema, Static } from "@earendil-works/pi-schema";

export interface ToolSpec<S extends Schema<any>> {
	name: string;
	description: string;
	parameters: S;
	sequential?: boolean;
	execute(params: Static<S>, signal?: AbortSignal): Promise<string | { text: string; details?: unknown }>;
}

/** Small wrapper over Pi's AgentTool: return a string (or text + details), throw on failure. */
export function defineTool<S extends Schema<any>>(spec: ToolSpec<S>): AgentTool<any> {
	return {
		name: spec.name,
		label: spec.name,
		description: spec.description,
		parameters: spec.parameters as object,
		...(spec.sequential ? { executionMode: "sequential" as const } : {}),
		async execute(_id: string, params: any, signal?: AbortSignal): Promise<AgentToolResult<any>> {
			const out = await spec.execute(params as Static<S>, signal);
			const text = typeof out === "string" ? out : out.text;
			const details = typeof out === "string" ? {} : (out.details ?? {});
			return { content: [{ type: "text", text }], details };
		},
	};
}
