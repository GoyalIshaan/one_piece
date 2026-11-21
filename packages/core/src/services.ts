import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Job, JobSpec, Role } from "./types.ts";

// Interfaces for the swappable services. Implementations live in their own packages and are
// registered at start-up; anything that needs one asks the registry, never the package.

export interface PoolInfo {
	name: string;
	unit: string;
	capacity: number;
	running: number;
	queued: number;
	spentUnits: number;
	capUnits?: number;
}

export interface ResourceScheduler {
	submit(nodeId: string, spec: JobSpec): Job;
	wait(jobId: string, signal?: AbortSignal): Promise<Job>;
	get(jobId: string): Job | undefined;
	/** Cancel every queued or running job owned by the node's subtree. */
	cancelSubtree(nodeId: string): void;
	pools(): PoolInfo[];
}

export interface SecretBroker {
	/** Capability names this node may use (always a subset of its parent's). */
	grantsOf(nodeId: string): string[];
	grant(nodeId: string, capabilities: string[]): void;
	/** Environment variables for one tool process. Values never reach a model. */
	envFor(nodeId: string, capabilities: string[]): Record<string, string>;
	available(): string[];
}

export interface PickedModel {
	provider: string;
	id: string;
}

export interface CallRecord {
	provider: string;
	model: string;
	input: number;
	output: number;
	totalTokens: number;
	usd: number;
	waitedMs: number;
	durationMs: number;
	stopReason?: string;
	error?: string;
}

export interface QuotaInfo {
	provider: string;
	running: number;
	queued: number;
	calls: number;
}

export interface ModelRouter {
	/** Choose a model for a role, optionally avoiding providers (cross-provider review). */
	pick(role: Role, options?: { avoidProviders?: string[] }): PickedModel;
	resolve(picked: PickedModel): Model<Api>;
	/** A Pi stream function for one agent; every call is reported through onCall. */
	streamFn(onCall: (record: CallRecord) => void): StreamFn;
	providers(): string[];
	quota(): QuotaInfo[];
}

export interface ServiceMap {
	scheduler: ResourceScheduler;
	secrets: SecretBroker;
	router: ModelRouter;
}

export class ServiceRegistry {
	private readonly services = new Map<string, unknown>();

	register<K extends keyof ServiceMap>(name: K, service: ServiceMap[K]): void {
		this.services.set(name, service);
	}

	get<K extends keyof ServiceMap>(name: K): ServiceMap[K] | undefined {
		return this.services.get(name) as ServiceMap[K] | undefined;
	}

	require<K extends keyof ServiceMap>(name: K): ServiceMap[K] {
		const service = this.get(name);
		if (!service) throw new Error(`Service "${name}" is not plugged into this harness`);
		return service;
	}
}
