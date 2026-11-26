import type { HarnessAdapter, HarnessRunReceipt, HarnessRunSpec } from "../contracts.ts";

/**
 * Contract for plugging `one_piece` v2 Layer B (`SwarmOS` + native `TopologyPlugin` +
 * Multi-CLI `WorkerDriver`) into Layer E once the v2 core engine refactor lands.
 *
 * Matches the architecture in `notes/V2_ARCHITECTURE_AND_RESEARCH.md`:
 * - SQLite WAL event log at `spec.dbPath`
 * - Isolated git worktrees + offline Seatbelt sandbox (`spec.sandboxProfile`)
 * - Mechanical auto-nomination at `reserve_pct` when `spec.autoNominate === true`
 */
export interface V2SwarmRuntime {
	readonly driverIds: readonly string[];
	executeTopology(input: {
		topology: string;
		spec: HarnessRunSpec;
		signal?: AbortSignal;
	}): Promise<HarnessRunReceipt>;
}

export function createV2SwarmAdapter(runtime: V2SwarmRuntime): HarnessAdapter {
	return {
		name: `v2-swarm(${runtime.driverIds.join("+")})`,
		async run(spec: HarnessRunSpec, signal?: AbortSignal): Promise<HarnessRunReceipt> {
			const topology = spec.controlRung === "solo" ? "single" : (spec.topology ?? "pull-refinery");
			return runtime.executeTopology({ topology, spec, signal });
		},
	};
}
