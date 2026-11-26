import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventBus, Role, SkillDefinition, SkillRegistry, SkillTier, ToolDefinition } from "@one-piece/core";

const BUILTIN_SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

interface ParsedFrontmatter {
	name?: string;
	description?: string;
	roles?: Role[];
	tier?: SkillTier;
	body: string;
}

function parseSkillMarkdown(raw: string, fallbackName: string): ParsedFrontmatter {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (!match) {
		return { name: fallbackName, description: `Skill ${fallbackName}`, tier: "on-demand", body: raw.trim() };
	}
	const yaml = match[1]!;
	const body = match[2]!.trim();
	const out: ParsedFrontmatter = { name: fallbackName, tier: "on-demand", body };
	let inRolesBlock = false;
	const blockRoles: Role[] = [];

	for (const rawLine of yaml.split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (inRolesBlock) {
			const itemMatch = /^-\s+(.+)$/.exec(trimmed);
			if (itemMatch) {
				const roleVal = itemMatch[1]!.trim().replace(/^["']|["']$/g, "");
				if (roleVal) blockRoles.push(roleVal as Role);
				continue;
			}
			inRolesBlock = false;
		}
		const m = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed);
		if (!m) continue;
		const key = m[1]!;
		const val = m[2]!.trim().replace(/^["']|["']$/g, "");
		if (key === "name" && val) out.name = val;
		else if (key === "description" && val) out.description = val;
		else if (key === "tier" && (val === "static" || val === "on-demand")) out.tier = val;
		else if (key === "roles") {
			if (!val) {
				inRolesBlock = true;
			} else {
				const cleaned = val.replace(/^\[|\]$/g, "");
				const roles = cleaned.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean) as Role[];
				if (roles.length) out.roles = roles;
			}
		}
	}
	if (blockRoles.length && !out.roles?.length) out.roles = blockRoles;
	return out;
}

function scanSkillsDir(dir: string, source: SkillDefinition["source"], into: Map<string, SkillDefinition>): void {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir).sort()) {
		const skillDir = join(dir, entry);
		let st;
		try {
			st = statSync(skillDir);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		const mdPath = join(skillDir, "SKILL.md");
		if (!existsSync(mdPath)) continue;
		const parsed = parseSkillMarkdown(readFileSync(mdPath, "utf8"), entry);
		const name = parsed.name ?? entry;
		into.set(name, {
			name,
			description: parsed.description ?? `Curated skill ${name}`,
			roles: parsed.roles,
			tier: parsed.tier ?? "on-demand",
			body: parsed.body,
			dir: skillDir,
			source,
		});
	}
}

/**
 * 3-Tier Curated Skill Registry:
 * - Tier 1 (`static`): deterministic role skills compiled into static `systemPrompt` (KV-cache shared).
 * - Tier 2 (`on-demand`): sorted 1-line catalog + cache-safe `load_skill(name)` tool (tail append).
 * - Tier 3 (scripts/references): kept on disk inside `skill.dir`, read/executed only if loaded.
 */
export class FileSkillRegistry implements SkillRegistry {
	private readonly skills = new Map<string, SkillDefinition>();

	constructor(opts: { projectDir?: string; extraDirs?: string[]; includeBuiltin?: boolean } = {}) {
		if (opts.includeBuiltin !== false) {
			scanSkillsDir(BUILTIN_SKILLS_DIR, "builtin", this.skills);
		}
		if (opts.projectDir) {
			scanSkillsDir(join(opts.projectDir, "skills"), "repo", this.skills);
			scanSkillsDir(join(opts.projectDir, ".swarm", "skills"), "repo", this.skills);
			scanSkillsDir(join(opts.projectDir, ".one_piece", "skills"), "user", this.skills);
		}
		for (const dir of opts.extraDirs ?? []) {
			scanSkillsDir(dir, "user", this.skills);
		}
	}

	list(role?: Role): SkillDefinition[] {
		return [...this.skills.values()]
			.filter((s) => !role || !s.roles?.length || s.roles.includes(role))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	get(name: string): SkillDefinition | undefined {
		return this.skills.get(name);
	}

	staticPromptFor(role: Role, explicitNames: readonly string[] = []): string {
		const selected = new Map<string, SkillDefinition>();
		for (const s of this.list(role)) {
			if (s.tier === "static") selected.set(s.name, s);
		}
		for (const name of explicitNames) {
			const skill = this.skills.get(name);
			if (skill) selected.set(skill.name, skill);
		}
		if (!selected.size) return "";
		const sorted = [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
		return sorted.map((s) => `## Skill: ${s.name}\n${s.body}`).join("\n\n");
	}

	renderOnDemandCatalog(role: Role, excludeNames: readonly string[] = []): string {
		const excluded = new Set(excludeNames);
		const onDemand = this.list(role).filter((s) => s.tier === "on-demand" && !excluded.has(s.name));
		if (!onDemand.length) return "";
		const lines = onDemand.map((s) => `- ${s.name}: ${s.description}`);
		return `Available on-demand skills (call load_skill(name) only if relevant):\n${lines.join("\n")}`;
	}
}

/** Cache-safe Tier-2 MCP/in-process tool: returns full SKILL.md body as a normal tool result. */
export function loadSkillTool(registry: SkillRegistry, bus: EventBus): ToolDefinition {
	return {
		name: "load_skill",
		description: "Load the full instructions of an on-demand curated skill by exact name.",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "Exact skill name from the on-demand skill catalog" },
			},
			required: ["name"],
		},
		execute(args, ctx) {
			const name = String(args.name ?? "").trim();
			const skill = registry.get(name);
			if (!skill || (skill.roles?.length && !skill.roles.includes(ctx.role))) {
				const known = registry.list(ctx.role).map((s) => s.name);
				return {
					text: `Skill "${name}" is not available for role "${ctx.role}". Available skills: ${known.join(", ") || "(none)"}`,
					isError: true,
				};
			}
			bus.emit(
				ctx.runId,
				"skill.loaded",
				{ skill: skill.name, source: skill.source, bytes: Buffer.byteLength(skill.body, "utf8") },
				ctx.agentId,
			);
			return {
				text: `# Skill: ${skill.name}\n(directory: ${skill.dir})\n\n${skill.body}`,
				data: { name: skill.name, dir: skill.dir },
			};
		},
	};
}
