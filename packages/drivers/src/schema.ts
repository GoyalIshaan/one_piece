import type { JsonSchema } from "@one-piece/core";

/**
 * Recursively normalize a JSON Schema for strict structured-output providers (OpenAI / Codex / Grok):
 * - Every `object` node with `properties` gets `additionalProperties: false` (unless explicitly set)
 *   and `required` listing every key in `properties`.
 * - Recursively traverses `properties`, `items`, `anyOf`, `oneOf`, `allOf`, `$defs`, and `definitions`.
 */
export function normalizeStrictJsonSchema(node: unknown): JsonSchema {
	if (!node || typeof node !== "object" || Array.isArray(node)) {
		return node as JsonSchema;
	}
	const obj = node as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if ((k === "properties" || k === "$defs" || k === "definitions") && v && typeof v === "object" && !Array.isArray(v)) {
			const mapped: Record<string, unknown> = {};
			for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
				mapped[pk] = normalizeStrictJsonSchema(pv);
			}
			out[k] = mapped;
		} else if (k === "items") {
			out.items = Array.isArray(v) ? v.map(normalizeStrictJsonSchema) : normalizeStrictJsonSchema(v);
		} else if ((k === "anyOf" || k === "oneOf" || k === "allOf") && Array.isArray(v)) {
			out[k] = v.map(normalizeStrictJsonSchema);
		} else {
			out[k] = v;
		}
	}
	if (out.type === "object" && out.properties && typeof out.properties === "object") {
		if (out.additionalProperties === undefined) out.additionalProperties = false;
		out.required = Object.keys(out.properties as Record<string, unknown>);
	}
	return out as JsonSchema;
}
