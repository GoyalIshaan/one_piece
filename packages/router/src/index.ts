import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	createModels,
	type FauxResponseFactory,
	fauxProvider,
	InMemoryCredentialStore,
	type Model,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai";
import type { CallRecord, ModelRouter, PickedModel, QuotaInfo, Role } from "@one-piece/core";

export type { CallRecord };

export interface ProviderConfig {
	/** pi-ai provider id: "openai", "openrouter", "xai", "anthropic", "openai-codex", or "sim". */
	id: string;
	/** Model id per role; "default" covers roles not listed. */
	models: Partial<Record<Role | "default", string>>;
	maxConcurrent?: number;
	requestsPerMinute?: number;
	/** Relative preference when several providers can serve a role. */
	weight?: number;
}

export interface RouterOptions {
	providers: ProviderConfig[];
	/** Where OAuth tokens and stored keys live (chmod 600). */
	credentialsPath?: string;
	/** Scripted behaviour for the "sim" provider (tests and dry runs). */
	simPolicy?: FauxResponseFactory;
	/** Provider factories, injectable so the router does not import every provider. */
	providerFactories?: Record<string, () => Provider<any>>;
}


/** Persistent credential store in a user-only JSON file. */
export class FileCredentialStore implements CredentialStore {
	private readonly memory = new InMemoryCredentialStore();
	private readonly path: string;
	private loaded: Promise<void>;

	constructor(path: string) {
		this.path = path;
		this.loaded = this.load();
	}

	private async load(): Promise<void> {
		if (!existsSync(this.path)) return;
		const data = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Credential>;
		for (const [id, credential] of Object.entries(data)) await this.memory.modify(id, async () => credential);
	}

	private async save(): Promise<void> {
		const out: Record<string, Credential> = {};
		for (const info of await this.memory.list()) {
			const credential = await this.memory.read(info.providerId);
			if (credential) out[info.providerId] = credential;
		}
		mkdirSync(dirname(this.path), { recursive: true });
		if (existsSync(this.path)) chmodSync(this.path, 0o600);
		writeFileSync(this.path, JSON.stringify(out, null, 2), { mode: 0o600 });
	}

	async read(providerId: string): Promise<Credential | undefined> {
		await this.loaded;
		return this.memory.read(providerId);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		await this.loaded;
		return this.memory.list();
	}

	async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
		await this.loaded;
		const result = await this.memory.modify(providerId, fn);
		await this.save();
		return result;
	}

	async delete(providerId: string): Promise<void> {
		await this.loaded;
		await this.memory.delete(providerId);
		await this.save();
	}
}

/** Counting semaphore with a requests-per-minute window. */
class Quota {
	running = 0;
	queued = 0;
	calls = 0;
	private readonly waiters: Array<() => void> = [];
	private readonly starts: number[] = [];
	private readonly max: number;
	private readonly rpm: number;

	constructor(max: number, rpm: number) {
		this.max = max;
		this.rpm = rpm;
	}

	async acquire(signal?: AbortSignal): Promise<number> {
		const began = Date.now();
		this.queued += 1;
		try {
			for (;;) {
				signal?.throwIfAborted();
				const now = Date.now();
				while (this.starts.length && now - this.starts[0] > 60_000) this.starts.shift();
				if (this.running < this.max && this.starts.length < this.rpm) break;
				const waitMs = this.running >= this.max ? 0 : 60_000 - (now - this.starts[0]) + 5;
				await new Promise<void>((resolve) => {
					if (waitMs > 0) setTimeout(resolve, waitMs);
					else this.waiters.push(resolve);
				});
			}
		} finally {
			this.queued -= 1;
		}
		this.running += 1;
		this.calls += 1;
		this.starts.push(Date.now());
		return Date.now() - began;
	}

	release(): void {
		this.running = Math.max(0, this.running - 1);
		this.waiters.shift()?.();
	}
}

/**
 * The model router: one layer every agent's model calls pass through. It picks provider and
 * model per role, keeps reviewers on a different provider from the work they review, enforces
 * per-provider concurrency and rate limits, and reports usage for budgets and telemetry.
 */
export class Router implements ModelRouter {
	readonly models: MutableModels;
	private readonly configs: ProviderConfig[];
	private readonly quotas = new Map<string, Quota>();
	private readonly sim?: ReturnType<typeof fauxProvider>;
	private readonly simPolicy?: FauxResponseFactory;
	private rotation = 0;

	constructor(options: RouterOptions) {
		this.configs = options.providers;
		const credentials = options.credentialsPath ? new FileCredentialStore(options.credentialsPath) : new InMemoryCredentialStore();
		this.models = createModels({ credentials });
		for (const config of this.configs) {
			if (config.id === "sim") continue;
			const factory = options.providerFactories?.[config.id];
			if (!factory) throw new Error(`No provider factory registered for "${config.id}"`);
			this.models.setProvider(factory());
		}
		if (this.configs.some((c) => c.id === "sim")) {
			const ids = [...new Set(this.configs.filter((c) => c.id === "sim").flatMap((c) => Object.values(c.models)))] as string[];
			this.sim = fauxProvider({ provider: "sim", models: ids.map((id) => ({ id, reasoning: false, contextWindow: 200_000 })) });
			this.models.setProvider(this.sim.provider);
			this.simPolicy = options.simPolicy;
		}
		for (const config of this.configs) {
			this.quotas.set(config.id, new Quota(config.maxConcurrent ?? 4, config.requestsPerMinute ?? 60));
		}
	}

	providers(): string[] {
		return this.configs.map((c) => c.id);
	}

	pick(role: Role, options: { avoidProviders?: string[] } = {}): PickedModel {
		const serving = this.configs.filter((c) => c.models[role] ?? c.models.default);
		if (!serving.length) throw new Error(`No provider is configured for role ${role}`);
		const preferred = serving.filter((c) => !options.avoidProviders?.includes(c.id));
		const pool = preferred.length ? preferred : serving;
		// Weighted round robin across eligible providers so the swarm spreads its load.
		const weights = pool.map((c) => Math.max(0.01, c.weight ?? 1));
		const total = weights.reduce((a, b) => a + b, 0);
		this.rotation = (this.rotation + 0.618_033_988_75) % 1;
		let point = this.rotation * total;
		let chosen = pool[0];
		for (let i = 0; i < pool.length; i++) {
			point -= weights[i];
			if (point <= 0) {
				chosen = pool[i];
				break;
			}
		}
		return { provider: chosen.id, id: (chosen.models[role] ?? chosen.models.default)! };
	}

	resolve(picked: PickedModel): Model<Api> {
		const model = this.models.getModel(picked.provider, picked.id);
		if (!model) throw new Error(`Model ${picked.provider}/${picked.id} is not in the catalog; run "one-piece models ${picked.provider}"`);
		return model;
	}

	/** A Pi stream function bound to one agent, reporting every call through `onCall`. */
	streamFn(onCall: (record: CallRecord) => void): StreamFn {
		return async (model, context, options) => {
			const quota = this.quotas.get(model.provider)!;
			const waitedMs = await quota.acquire(options?.signal);
			const began = Date.now();
			if (this.sim && model.provider === "sim" && this.simPolicy) this.sim.appendResponses([this.simPolicy]);
			let stream;
			try {
				stream = this.models.streamSimple(model, context, options);
			} catch (error) {
				quota.release();
				throw error;
			}
			void stream
				.result()
				.then((message: AssistantMessage) => {
					onCall({
						provider: model.provider,
						model: model.id,
						input: message.usage.input,
						output: message.usage.output,
						totalTokens: message.usage.totalTokens,
						usd: message.usage.cost.total,
						waitedMs,
						durationMs: Date.now() - began,
						stopReason: message.stopReason,
						error: message.errorMessage,
					});
				})
				.catch((error: unknown) => {
					onCall({ provider: model.provider, model: model.id, input: 0, output: 0, totalTokens: 0, usd: 0, waitedMs, durationMs: Date.now() - began, error: String(error) });
				})
				.finally(() => quota.release());
			return stream;
		};
	}

	quota(): QuotaInfo[] {
		return [...this.quotas].map(([provider, q]) => ({ provider, running: q.running, queued: q.queued, calls: q.calls }));
	}
}
export { PROVIDER_FACTORIES } from "./providers.ts";
