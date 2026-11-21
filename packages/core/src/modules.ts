import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { EventBus } from "./events.ts";
import type { ServiceRegistry } from "./services.ts";
import type { Store } from "./store.ts";
import type { SwarmTree } from "./tree.ts";
import type { Finding, ModuleState, Role, Run, SwarmNode } from "./types.ts";

/** What a module declares about itself. The root reads these to build a run's harness profile. */
export interface ModuleManifest {
	name: string;
	version: string;
	/** One line shown in the deferred-tool index. */
	summary: string;
	roles: Role[];
	tools: string[];
	/** Rough tokens its tool schemas and prompt section add to an agent's context when active. */
	contextCostTokens: number;
	pools?: string[];
	grants?: string[];
	dependsOn?: string[];
}

/** The slice of the harness a module may use. Modules never import each other. */
export interface HarnessApi {
	readonly bus: EventBus;
	readonly tree: SwarmTree;
	readonly store: Store;
	readonly services: ServiceRegistry;
	run(): Run;
	/** Hand a message to a node's agent: steered in if it is running, queued otherwise. */
	deliver(nodeId: string, text: string): void;
	/** The node's private working directory, if it has one. */
	workspaceOf(nodeId: string): string | undefined;
	/** Resolves when the given node reaches a terminal status. */
	whenSettled(nodeId: string): Promise<void>;
	/** Resolves at the end of the node's next agent turn. */
	nextTurn(nodeId: string): Promise<void>;
	/**
	 * Park a node while it waits (children, a job, an answer): it gives up its agent slot and
	 * spends nothing until the promise settles.
	 */
	park<T>(nodeId: string, waitFor: Promise<T>): Promise<T>;
	/** Aborted when the node is stopped (cut, merged, archived). */
	signalOf(nodeId: string): AbortSignal;
}

export interface NodeContext {
	readonly node: SwarmNode;
	readonly harness: HarnessApi;
}

export interface HarnessModule {
	readonly manifest: ModuleManifest;
	setup?(harness: HarnessApi): void | Promise<void>;
	/** Tools the module gives an agent of this node's role. */
	tools?(ctx: NodeContext): AgentTool<any>[];
	/** A short prompt section added while the module is active for the node. */
	prompt?(ctx: NodeContext): string | undefined;
	/** Return a reason to refuse a report (for example a missing peer review). */
	beforeReport?(ctx: NodeContext, finding: Finding): string | undefined;
	dispose?(): void | Promise<void>;
}

export type HarnessProfile = Record<string, ModuleState>;

/** Starting module profiles for the four search kinds. The root may change them per run. */
export const DEFAULT_PROFILES: Record<string, HarnessProfile> = {
	code: {
		questions: "active",
		board: "active",
		workspace: "active",
		scheduler: "active",
		secrets: "deferred",
	},
	literature: {
		questions: "active",
		board: "active",
		workspace: "active",
		scheduler: "deferred",
		secrets: "deferred",
	},
	ml: {
		questions: "active",
		board: "active",
		workspace: "active",
		scheduler: "active",
		secrets: "active",
	},
	kernels: {
		questions: "active",
		board: "active",
		workspace: "active",
		scheduler: "active",
		secrets: "active",
	},
};

export function moduleState(node: SwarmNode, name: string): ModuleState {
	return node.modules[name] ?? "off";
}
