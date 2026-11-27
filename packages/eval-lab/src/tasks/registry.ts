import type { EvalTask } from "../contracts.ts";
import { adversarialSpecForgeTask } from "./adversarial-spec-forge/index.ts";
import { causalIncidentMeshTask } from "./causal-incident-mesh/index.ts";
import { horizonRepoMigrationTask } from "./horizon-repo-migration/index.ts";
import { miniCoopInterpTask } from "./mini-coop-interp/index.ts";
import { miniOptPackTask } from "./mini-opt-pack/index.ts";
import { mleBenchLiteTask } from "./mle-bench-lite/index.ts";
import { siloJoinMicroTask } from "./silo-join-micro/index.ts";
import { sweBenchVerifiedTask } from "./swe-bench-verified/index.ts";
import { triageNeedleMeshTask } from "./triage-needle-mesh/index.ts";
import { vliwKernelOptTask } from "./vliw-kernel-opt/index.ts";

/** Zero-Docker self-contained benchmarks calibrated automatically on every `npm run verify:harness`. */
export const EVAL_TASKS: readonly EvalTask[] = [
	miniCoopInterpTask,
	siloJoinMicroTask,
	miniOptPackTask,
	causalIncidentMeshTask,
	triageNeedleMeshTask,
	adversarialSpecForgeTask,
	vliwKernelOptTask,
	horizonRepoMigrationTask,
];

/** Strict Docker-only industry-standard external benchmarks (require running Docker daemon + upstream dataset/images). */
export const EXTERNAL_EVAL_TASKS: readonly EvalTask[] = [
	sweBenchVerifiedTask,
	mleBenchLiteTask,
];

export const ALL_EVAL_TASKS: readonly EvalTask[] = [...EVAL_TASKS, ...EXTERNAL_EVAL_TASKS];

export function getEvalTask(id: string): EvalTask {
	const task = ALL_EVAL_TASKS.find((t) => t.id === id);
	if (!task) {
		throw new Error(`Unknown eval-lab task "${id}". Available: ${ALL_EVAL_TASKS.map((t) => t.id).join(", ")}`);
	}
	return task;
}
