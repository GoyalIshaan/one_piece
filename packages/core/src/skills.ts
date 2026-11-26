import type { Role } from "./types.ts";

export type SkillTier = "static" | "on-demand";

export interface SkillDefinition {
	name: string;
	description: string;
	roles?: Role[];
	tier: SkillTier;
	body: string;
	dir: string;
	source: "builtin" | "repo" | "user";
}

export interface SkillRegistry {
	list(role?: Role): SkillDefinition[];
	get(name: string): SkillDefinition | undefined;
	staticPromptFor(role: Role, explicitNames?: readonly string[]): string;
	renderOnDemandCatalog(role: Role, excludeNames?: readonly string[]): string;
}
