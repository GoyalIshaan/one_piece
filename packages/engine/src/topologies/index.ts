import type { TopologyPlugin } from "@one-piece/core";
import { evolutionTopology } from "./evolution.ts";
import { hierarchyTopology } from "./hierarchy.ts";
import { pullRefineryTopology } from "./pull-refinery.ts";
import { singleTopology } from "./single.ts";
import { substratePeersTopology } from "./substrate-peers.ts";

export { evolutionTopology, type EvolutionTopologyOptions } from "./evolution.ts";
export { hierarchyTopology, type HierarchyTopologyOptions } from "./hierarchy.ts";
export { pullRefineryTopology, type PullRefineryOptions } from "./pull-refinery.ts";
export { singleTopology, type SingleTopologyOptions } from "./single.ts";
export { substratePeersTopology, type SubstratePeersOptions } from "./substrate-peers.ts";

export type TopologyName = "single" | "hierarchy" | "pull-refinery" | "substrate-peers" | "evolution";

export const TOPOLOGY_NAMES: readonly TopologyName[] = [
	"single",
	"hierarchy",
	"pull-refinery",
	"substrate-peers",
	"evolution",
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
		default:
			throw new Error(`Unknown topology "${name}". Available: ${TOPOLOGY_NAMES.join(", ")}`);
	}
}
