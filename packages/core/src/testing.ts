import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "./events.ts";
import type { HarnessApi } from "./modules.ts";
import { Redactor } from "./redact.ts";
import { ServiceRegistry } from "./services.ts";
import { MemoryStore } from "./store.ts";
import { SwarmTree } from "./tree.ts";
import type { BudgetVector, Run } from "./types.ts";

/** A minimal harness for testing a module on its own, without agents or models. */
export function testHarness(options: { budget?: BudgetVector } = {}) {
	const store = new MemoryStore();
	const bus = new EventBus(store, new Redactor());
	const tree = new SwarmTree(bus);
	const services = new ServiceRegistry();
	const dir = mkdtempSync(join(tmpdir(), "op-test-"));
	const run: Run = { id: "run-test", goal: { title: "t", text: "t" }, status: "running", budget: options.budget ?? {}, epoch: 1, rootNodeId: "", config: {}, createdAt: Date.now(), updatedAt: Date.now() };
	const delivered: Array<{ nodeId: string; text: string }> = [];
	const turnWaiters = new Map<string, Array<() => void>>();
	const harness: HarnessApi & { delivered: typeof delivered; endTurn(nodeId: string): void } = {
		bus,
		tree,
		store,
		services,
		delivered,
		run: () => run,
		deliver: (nodeId, text) => delivered.push({ nodeId, text }),
		workspaceOf: (nodeId) => join(dir, "workspaces", tree.get(nodeId)?.targetNodeId ?? nodeId),
		whenSettled: () => new Promise(() => {}),
		nextTurn: (nodeId) => new Promise((resolve) => turnWaiters.set(nodeId, [...(turnWaiters.get(nodeId) ?? []), resolve])),
		endTurn: (nodeId) => {
			for (const wake of turnWaiters.get(nodeId) ?? []) wake();
			turnWaiters.delete(nodeId);
		},
		park: (_nodeId, waitFor) => waitFor,
		signalOf: () => new AbortController().signal,
	};
	const root = tree.create({ runId: run.id, epoch: 1, role: "root", goal: run.goal, budget: run.budget });
	run.rootNodeId = root.id;
	return { harness, root, store, tree, bus, services, dir };
}
