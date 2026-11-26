import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AuthOperationOptions,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	createModels,
	type FauxResponseFactory,
	fauxProvider,
	getCurrentTools,
	InMemoryCredentialStore,
	type Model,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai";
import { PermitActor, type Role } from "@one-piece/core";
import { lock } from "proper-lockfile";

export interface PickedModel {
	provider: string;
	id: string;
}

export interface CallRecord {
	provider: string;
	model: string;
	toolMenu?: { names: string[]; declarationSha: string };
	input: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
	cacheWrite1hTokens?: number;
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

export interface ModelChoice {
	key: string;
	provider: string;
	id: string;
	tier: "strong" | "fast" | "cheap" | "reasoning" | "coding";
	note: string;
	inputPerM?: number;
	outputPerM?: number;
}

export interface ModelRouter {
	prepare?(): Promise<void>;
	menu(): ModelChoice[];
	pick(role: Role, options?: { avoidProviders?: string[] }): PickedModel;
	resolve(picked: PickedModel): Model<Api>;
	streamFn(onCall: (record: CallRecord) => void): StreamFn;
	providers(): string[];
	quota(): QuotaInfo[];
}

export interface ProviderConfig {
	/** pi-ai provider id: "openai", "openrouter", "xai", "anthropic", "openai-codex", or "sim". */
	id: string;
	/** Model id per role; "default" covers roles not listed. */
	models: Partial<Record<Role | "default", string>>;
	maxConcurrent?: number;
	requestsPerMinute?: number;
	/** Relative preference when several providers can serve a role. */
	weight?: number;
	/** Extra models managers may assign to children from this provider. */
	offer?: Array<{ id: string; tier: ModelChoice["tier"]; note: string }>;
}

export interface RouterOptions {
	providers: ProviderConfig[];
	/** Where OAuth tokens and stored keys live (chmod 600). */
	credentialsPath?: string;
	/** Optional directory shared by all routers in a project for provider pacing. */
	requestWindowDir?: string;
	/** Scripted behaviour for the "sim" provider (tests and dry runs). */
	simPolicy?: FauxResponseFactory;
	/** Provider factories, injectable so the router does not import every provider. */
	providerFactories?: Record<string, () => Provider<any>>;
}

function writeJsonAtomically(path: string, value: unknown): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Persistent credential store in a user-only JSON file. */
export class FileCredentialStore implements CredentialStore {
	private readonly path: string;

	constructor(path: string) {
		this.path = resolve(path);
	}

	private readAll(): Map<string, Credential> {
		try {
			const data = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Credential>;
			return new Map(Object.entries(data));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return new Map();
		}
	}

	private save(credentials: Map<string, Credential>): void {
		writeJsonAtomically(this.path, Object.fromEntries(credentials));
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return this.readAll().get(providerId);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return [...this.readAll()].map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.withLock(options, async () => {
			const credentials = this.readAll();
			const current = credentials.get(providerId);
			const next = await fn(current);
			if (next !== undefined) {
				credentials.set(providerId, next);
				this.save(credentials);
			}
			return next ?? current;
		});
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		await this.withLock(options, async () => {
			const credentials = this.readAll();
			if (credentials.delete(providerId)) this.save(credentials);
		});
	}

	private async withLock<T>(options: AuthOperationOptions | undefined, work: () => Promise<T>): Promise<T> {
		options?.signal?.throwIfAborted();
		mkdirSync(dirname(this.path), { recursive: true });
		// Hold across refresh and save. The retry window must outlast the stale lock threshold so a crashed writer can recover.
		const release = await lock(this.path, {
			realpath: false,
			stale: 60_000,
			retries: { retries: 140, minTimeout: 50, maxTimeout: 500 },
		});
		try {
			options?.signal?.throwIfAborted();
			return await work();
		} finally {
			await release();
		}
	}
}

const REQUEST_WINDOW_MS = 60_000;

function reserveStart(starts: number[], rpm: number, now: number): number {
	while (starts.length && now - starts[0]! >= REQUEST_WINDOW_MS) starts.shift();
	if (starts.length >= rpm) return Math.max(1, starts[0]! + REQUEST_WINDOW_MS - now);
	starts.push(now);
	return 0;
}

/** Rate admission is shared across independent CLI processes using the same project. */
export class SharedRequestWindow {
	private readonly path: string;
	private readonly now: () => number;

	constructor(path: string, now: () => number = Date.now) {
		this.path = resolve(path);
		this.now = now;
	}

	async reserve(rpm: number, signal?: AbortSignal): Promise<number> {
		signal?.throwIfAborted();
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const release = await lock(this.path, { realpath: false, stale: 10_000, retries: { retries: 100, minTimeout: 10, maxTimeout: 150, randomize: true } });
		try {
			signal?.throwIfAborted();
			let starts: number[] = [];
			try {
				starts = JSON.parse(readFileSync(this.path, "utf8")) as number[];
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const wait = reserveStart(starts, rpm, this.now());
			if (!wait) writeJsonAtomically(this.path, starts);
			return wait;
		} finally {
			await release();
		}
	}
}

function providerPermits(max: number, rpm: number, shared?: SharedRequestWindow): PermitActor {
	if (!Number.isSafeInteger(rpm) || rpm < 1) throw new Error("Provider requests per minute must be a positive integer");
	const starts: number[] = [];
	return new PermitActor(max, async signal => {
		for (;;) {
			signal?.throwIfAborted();
			const wait = shared ? await shared.reserve(rpm, signal) : reserveStart(starts, rpm, Date.now());
			if (!wait) return;
			await delay(wait, undefined, { signal });
		}
	});
}

/**
 * The model router: one layer every agent's model calls pass through. It picks provider and
 * model per role, keeps reviewers on a different provider from the work they review, enforces
 * per-provider concurrency and rate limits, and reports usage for budgets and telemetry.
 */
export class Router implements ModelRouter {
	readonly models: MutableModels;
	private readonly configs: ProviderConfig[];
	private readonly quotas = new Map<string, PermitActor>();
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
			const ids = [...new Set(this.configs.filter((c) => c.id === "sim").flatMap((c) => [...Object.values(c.models), ...(c.offer ?? []).map((o) => o.id)]))] as string[];
			this.sim = fauxProvider({ provider: "sim", models: ids.map((id) => ({ id, reasoning: false, contextWindow: 200_000 })) });
			this.models.setProvider(this.sim.provider);
			this.simPolicy = options.simPolicy;
		}
		for (const config of this.configs) {
			const shared = config.id !== "sim" && options.requestWindowDir
				? new SharedRequestWindow(resolve(options.requestWindowDir, `${encodeURIComponent(config.id)}.json`))
				: undefined;
			this.quotas.set(config.id, providerPermits(config.maxConcurrent ?? 4, config.requestsPerMinute ?? 60, shared));
		}
	}

	providers(): string[] {
		return this.configs.map((c) => c.id);
	}

	/** Providers with working credentials. Undefined until prepare() ran: then everything counts as usable. */
	private usable?: Set<string>;

	async prepare(): Promise<void> {
		const credentials = await Promise.all([...new Set(this.providers())].map(async id => {
			if (id === "sim") return id;
			try {
				return await this.models.getAuth(id) ? id : undefined;
			} catch {
				// A broken credential only excludes its own provider.
				return undefined;
			}
		}));
		const usable = new Set(credentials.filter(id => id !== undefined));
		if (!usable.size) throw new Error(`No provider has credentials. Sign in with "one-piece login <provider>" or set its API key.`);
		this.usable = usable;
	}

	private isUsable(provider: string): boolean {
		return !this.usable || this.usable.has(provider);
	}

	menu(): ModelChoice[] {
		const out: ModelChoice[] = [];
		const seen = new Set<string>();
		const add = (provider: string, id: string, tier: ModelChoice["tier"], note: string) => {
			const key = `${provider}:${id}`;
			if (seen.has(key) || !this.isUsable(provider)) return;
			const model = this.models.getModel(provider, id);
			if (!model && provider !== "sim") return;
			seen.add(key);
			out.push({ key, provider, id, tier, note, inputPerM: model?.cost?.input, outputPerM: model?.cost?.output });
		};
		for (const config of this.configs) {
			const strong = config.models.root ?? config.models.default;
			const worker = config.models.leaf ?? config.models.default;
			if (strong) add(config.id, strong, "strong", "default model for planners and reviewers");
			if (worker) add(config.id, worker, "fast", "default model for workers");
			for (const offer of config.offer ?? []) add(config.id, offer.id, offer.tier, offer.note);
		}
		return out;
	}

	pick(role: Role, options: { avoidProviders?: string[] } = {}): PickedModel {
		const serving = this.configs.filter((c) => (c.models[role] ?? c.models.default) && this.isUsable(c.id));
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
			const queuedAt = Date.now();
			const release = await quota.acquire(options?.signal);
			const began = Date.now();
			const waitedMs = began - queuedAt;
			let stream;
			let toolMenu: CallRecord["toolMenu"];
			try {
				const declarations = getCurrentTools(context.messages);
				toolMenu = { names: declarations.map(({ name }) => name),
					declarationSha: createHash("sha256").update(JSON.stringify(declarations)).digest("hex") };
				if (this.sim && model.provider === "sim" && this.simPolicy) this.sim.appendResponses([this.simPolicy]);
				stream = this.models.streamSimple(model, context, options);
			} catch (error) {
				release();
				throw error;
			}
			void stream
				.result()
				.then((message: AssistantMessage) => {
					onCall({
						provider: model.provider,
						model: model.id,
						toolMenu,
						input: message.usage.input,
						cacheReadTokens: message.usage.cacheReadReported === false ? undefined : message.usage.cacheRead,
						cacheWriteTokens: message.usage.cacheWriteReported === false ? undefined : message.usage.cacheWrite,
						cacheWrite1hTokens: message.usage.cacheWrite1h,
						reasoningTokens: message.usage.reasoning,
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
					onCall({ provider: model.provider, model: model.id, toolMenu, input: 0, output: 0, totalTokens: 0, usd: 0, waitedMs, durationMs: Date.now() - began, error: String(error) });
				})
				.finally(release);
			return stream;
		};
	}

	quota(): QuotaInfo[] {
		return [...this.quotas].map(([provider, q]) => ({ provider, running: q.running, queued: q.waiting, calls: q.calls }));
	}
}
export { PROVIDER_FACTORIES } from "./providers.ts";
