import type { SkillPack } from "../src/skill-registry.ts";

export const coreSkillPack: SkillPack = {
	name: "core",
	skills: [
		{
			name: "benchmark-mac",
			description: "Use before measuring a candidate on the Mac for fair comparisons and a single hardware lease.",
			entrypoint: new URL("./benchmark-mac/SKILL.md", import.meta.url),
		},
		{
			name: "resume-experiment",
			description: "Use after a scheduled job fails or is cancelled to recover from verified outputs and checkpoints.",
			entrypoint: new URL("./resume-experiment/SKILL.md", import.meta.url),
			references: { "beam-remote": new URL("./resume-experiment/beam-remote.md", import.meta.url) },
		},
		{
			name: "handoff-evidence",
			description: "Use when transferring exact artifacts to a peer or a reviewer, including masked scoring.",
			entrypoint: new URL("./handoff-evidence/SKILL.md", import.meta.url),
		},
	],
};
