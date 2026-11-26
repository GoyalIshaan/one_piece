import type { SkillPack } from "../../src/skill-registry.ts";

export const inferenceOptimisationPack: SkillPack = {
	name: "sybil-inference-optimisation",
	skills: [{
		name: "inference-optimisation",
		description: "Use to estimate performance ceilings and hill-climb LLM decode, speculation, prefill, KV capacity, startup, or TTFT with controlled benchmarks.",
		entrypoint: new URL("./SKILL.md", import.meta.url),
		references: {
			ceilings: new URL("./references/ceilings.md", import.meta.url),
			methodology: new URL("./references/methodology.md", import.meta.url),
			levers: new URL("./references/levers.md", import.meta.url),
			gotchas: new URL("./references/gotchas.md", import.meta.url),
			qualification: new URL("./references/qualification.md", import.meta.url),
		},
	}],
};
