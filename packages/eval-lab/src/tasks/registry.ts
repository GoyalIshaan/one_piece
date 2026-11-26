import type { EvalTask } from "../contracts.ts";
import { adversarialSpecForgeTask } from "./adversarial-spec-forge/index.ts";
import { causalIncidentMeshTask } from "./causal-incident-mesh/index.ts";
import { horizonRepoMigrationTask } from "./horizon-repo-migration/index.ts";
import { miniCoopInterpTask } from "./mini-coop-interp/index.ts";
import { miniOptPackTask } from "./mini-opt-pack/index.ts";
import { siloJoinMicroTask } from "./silo-join-micro/index.ts";
import { vliwKernelOptTask } from "./vliw-kernel-opt/index.ts";

export const EVAL_TASKS: readonly EvalTask[] = [
	miniCoopInterpTask,
	siloJoinMicroTask,
	miniOptPackTask,
	causalIncidentMeshTask,
	adversarialSpecForgeTask,
	vliwKernelOptTask,
	horizonRepoMigrationTask,
];

export function getEvalTask(id: string): EvalTask {
	const task = EVAL_TASKS.find((t) => t.id === id);
	if (!task) {
		throw new Error(`Unknown eval-lab task "${id}". Available: ${EVAL_TASKS.map((t) => t.id).join(", ")}`);
	}
	return task;
}
