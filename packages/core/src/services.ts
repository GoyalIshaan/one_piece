import type { FinishedJob, Job, JobSpec, Role, VerificationReceipt } from "./types.ts";

export interface PoolInfo {
	name: string;
	unit: string;
	capacity: number;
	running: number;
	queued: number;
	spentUnits: number;
	capUnits?: number;
	description?: string;
}

export interface ResourceScheduler {
	submit(agentId: string, spec: JobSpec): Job;
	withdraw(agentId: string, jobId: string, reason: string, reusedJobId?: string): FinishedJob;
	resume(agentId: string, jobId: string, changes?: { command?: string; gate?: string }): Job;
	wait(jobId: string, signal?: AbortSignal): Promise<FinishedJob>;
	get(jobId: string): Job | undefined;
	restoreQueued?(job: Extract<Job, { status: "queued" }>): boolean;
	materializeOutputs?(jobId: string, paths: readonly string[], workspace: string): string;
	cancelOwner(agentId: string): void;
	pools(): PoolInfo[];
	close?(): Promise<void>;
}

export interface SecretBroker {
	grantsOf(agentId: string): string[];
	grant(agentId: string, capabilities: string[]): void;
	envFor(agentId: string, capabilities: string[]): Record<string, string>;
	available(): string[];
}

/** Installed by the task owner. Agent-supplied checks are structured data, never checker code. */
export interface FindingVerifier {
	name: string;
	version: string;
	defaultScope: string;
	scopes: readonly string[];
	challengeHelp?: string;
	previousVersion?(version: string): FindingVerifier | undefined;
	check(input: {
		workspace: string;
		artifactSha256: string;
		scope: string;
		challenge?: string;
		signal: AbortSignal;
	}): Promise<Omit<VerificationReceipt, "checker" | "version" | "kind" | "durationMs">>;
}

export interface VerificationModuleSpec {
	module: string;
	options?: Record<string, unknown>;
}

/** Minimal module shape compatible with existing task verification plugins (e.g. perf-algos). */
export interface VerificationModule {
	readonly manifest: {
		name: string;
		version: string;
		summary: string;
		roles: Role[];
		tools: string[];
		contextCostTokens: number;
	};
	readonly findingVerifier: FindingVerifier;
	prompt?(): string | undefined;
}

export interface ServiceMap {
	scheduler: ResourceScheduler;
	secrets: SecretBroker;
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
		if (!service) throw new Error(`Service "${name}" is not plugged into this SwarmOS`);
		return service;
	}
}
