import type { HarnessModule, ModelRouter, Redactor, Store } from "@one-piece/core";
import { Harness, type HarnessConfig } from "./harness.ts";
import { installOversight } from "./oversight.ts";
import { installReporting } from "./report.ts";
import { commonTools, managerTools } from "./tree-tools.ts";
import { trustTools } from "./trust.ts";

export { DEFAULT_CONFIG, Harness, type HarnessConfig } from "./harness.ts";
export { runFraction } from "./oversight.ts";
export { briefFor, systemPrompt } from "./prompts.ts";
export { reportAppendix } from "./report.ts";
export { Semaphore } from "./semaphore.ts";
export { simPolicy } from "./simulation.ts";

/** Build a harness with the core behaviour installed: tree tools, trust layer, oversight, reporting. */
export function createHarness(options: {
	store: Store;
	router: ModelRouter;
	modules?: HarnessModule[];
	config: Partial<HarnessConfig> & { runDir: string };
	redactor?: Redactor;
}): Harness {
	const harness = new Harness(options);
	harness.addTools(commonTools);
	harness.addTools(managerTools);
	harness.addTools(trustTools);
	installOversight(harness);
	installReporting(harness);
	return harness;
}
