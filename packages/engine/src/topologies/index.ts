import type { TopologyPlugin } from "@one-piece/core";
import { adaptiveTopology } from "./adaptive.ts";
import { elasticPhaseTopology } from "./elastic-phase.ts";
import { evolutionTopology } from "./evolution.ts";
import { hierarchyTopology } from "./hierarchy.ts";
import { pullRefineryTopology } from "./pull-refinery.ts";
import { singleTopology } from "./single.ts";
import { substratePeersTopology } from "./substrate-peers.ts";

export {
	adaptiveTopology,
	classifyAdaptiveRegime,
	type AdaptiveClassification,
	type AdaptiveRegime,
	type AdaptiveTopologyOptions,
} from "./adaptive.ts";
export { elasticPhaseTopology, type ElasticPhaseOptions } from "./elastic-phase.ts";
export { evolutionTopology, type EvolutionTopologyOptions } from "./evolution.ts";
export { hierarchyTopology, type HierarchyTopologyOptions } from "./hierarchy.ts";
export { pullRefineryTopology, type PullRefineryOptions } from "./pull-refinery.ts";
export { singleTopology, type SingleTopologyOptions } from "./single.ts";
export { substratePeersTopology, type SubstratePeersOptions, type SubstrateSeatConfig } from "./substrate-peers.ts";

export type TopologyName = "single" | "hierarchy" | "pull-refinery" | "substrate-peers" | "evolution" | "elastic-phase" | "adaptive";

export const TOPOLOGY_NAMES: readonly TopologyName[] = [
	"single",
	"hierarchy",
	"pull-refinery",
	"substrate-peers",
	"evolution",
	"elastic-phase",
	"adaptive",
];

export function createTopology(name: string, options: Record<string, unknown> = {}): TopologyPlugin {
	switch (name) {
		case "single":
			return singleTopology(options);
		case "hierarchy":
			return hierarchyTopology(options);
		case "pull-refinery":
			return pullRefineryTopology(options);
		case "substrate-peers":
			return substratePeersTopology(options);
		case "evolution":
			return evolutionTopology(options);
		case "elastic-phase":
			return elasticPhaseTopology(options);
		case "adaptive":
			return adaptiveTopology(options);
		default:
			throw new Error(`Unknown topology "${name}". Available: ${TOPOLOGY_NAMES.join(", ")}`);
	}
}
