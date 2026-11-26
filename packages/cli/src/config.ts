import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DriverConfig, VerificationModuleSpec } from "@one-piece/core";
import type { TopologyName } from "@one-piece/engine";
import type { SecretSpec } from "@one-piece/module-secrets";
import type { ProviderConfig } from "@one-piece/router";
import type { PoolConfig } from "@one-piece/scheduler";

export interface OnePieceV2Config {
	topology: TopologyName;
	drivers: DriverConfig[];
	roles: Record<string, string[]>;
	/** Optional pi-ai API providers (used when a `pi-in-process` driver is configured). */
	providers: ProviderConfig[];
	budget: { tokens?: number; usd?: number; wallSeconds?: number; reservePct?: number; cpu_seconds?: number; gpu_minutes?: number };
	pools: PoolConfig[];
	secrets: SecretSpec[];
	verification?: VerificationModuleSpec;
	enableBlindReview?: boolean;
	networkOffWorkers?: boolean;
	dataDir: string;
}

export const DRIVER_PRESETS: Record<string, DriverConfig> = {
	codex: { id: "codex", kind: "codex-app-server", maxConcurrent: 2, subscriptionMode: true },
	"codex-exec": { id: "codex-exec", kind: "codex-exec", maxConcurrent: 2, subscriptionMode: true },
	grok: { id: "grok", kind: "grok-acp", maxConcurrent: 2, subscriptionMode: true },
	"grok-cli": { id: "grok-cli", kind: "grok-cli", maxConcurrent: 2, subscriptionMode: true },
	agy: { id: "agy", kind: "agy-acp", maxConcurrent: 2, subscriptionMode: true },
	gemini: { id: "gemini", kind: "agy-acp", maxConcurrent: 2, subscriptionMode: true },
	"gemini-legacy": { id: "gemini-legacy", kind: "gemini-cli", maxConcurrent: 2, subscriptionMode: true },
	sim: { id: "sim", kind: "pi-in-process", provider: "sim", maxConcurrent: 8, subscriptionMode: false },
	openrouter: { id: "openrouter", kind: "pi-in-process", provider: "openrouter", maxConcurrent: 4, subscriptionMode: false },
	openai: { id: "openai", kind: "pi-in-process", provider: "openai", maxConcurrent: 4, subscriptionMode: false },
};

export const PROVIDER_DEFAULTS: Record<string, ProviderConfig> = {
	openai: { id: "openai", models: { default: "gpt-6.2-sol", leaf: "gpt-6-luna" }, maxConcurrent: 4, requestsPerMinute: 40 },
	"openai-codex": { id: "openai-codex", models: { default: "gpt-6.2-sol", leaf: "gpt-6-luna" }, maxConcurrent: 3, requestsPerMinute: 30 },
	openrouter: { id: "openrouter", models: { default: "deepseek/deepseek-v4-pro", leaf: "deepseek/deepseek-v4.1-flash" }, maxConcurrent: 8, requestsPerMinute: 120 },
	xai: { id: "xai", models: { default: "grok-4.7" }, maxConcurrent: 3, requestsPerMinute: 30 },
	anthropic: { id: "anthropic", models: { default: "claude-sonnet-5-5" }, maxConcurrent: 2, requestsPerMinute: 20 },
	sim: { id: "sim", models: { default: "sim-1" }, maxConcurrent: 16, requestsPerMinute: 100_000 },
};

export const DEFAULT_POOLS: PoolConfig[] = [
	{ name: "cpu", unit: "cpu_seconds", capacity: 2, kind: "local", description: "local sandboxed CPU, network off" },
];

export function homeDir(): string {
	return join(homedir(), ".one_piece");
}

export function loadConfig(
	projectDir: string,
	overrides: { topology?: string; drivers?: string[]; providers?: string[]; model?: string } = {},
): OnePieceV2Config {
	const path = join(projectDir, "one-piece.config.json");
	const file = existsSync(path)
		? (JSON.parse(readFileSync(path, "utf8")) as Partial<OnePieceV2Config> & {
			drivers?: Array<DriverConfig | string> | Record<string, Omit<DriverConfig, "id">>;
			providers?: Array<ProviderConfig | string>;
		})
		: {};

	const requestedDrivers: Array<DriverConfig | string> = overrides.drivers?.length
		? overrides.drivers
		: overrides.providers?.length
			? overrides.providers
			: Array.isArray(file.drivers)
				? file.drivers
				: file.drivers && typeof file.drivers === "object"
					? Object.entries(file.drivers as Record<string, Omit<DriverConfig, "id">>).map(([id, cfg]) => ({ id, ...cfg }))
					: ["codex", "grok", "gemini"];

	const drivers: DriverConfig[] = requestedDrivers.map((entry) => {
		const base = typeof entry === "string"
			? (() => {
				const preset = DRIVER_PRESETS[entry];
				if (!preset) {
					throw new Error(`Unknown driver "${entry}". Known presets: ${Object.keys(DRIVER_PRESETS).join(", ")}`);
				}
				return structuredClone(preset);
			})()
			: structuredClone(entry);
		if (overrides.model) base.model = overrides.model;
		return base;
	});

	const piProvidersNeeded = new Set<string>(
		drivers.filter((d) => d.kind === "pi-in-process").map((d) => d.provider ?? d.id),
	);
	const rawProviders = file.providers ?? [...piProvidersNeeded];
	const providers: ProviderConfig[] = rawProviders.map((p) => {
		if (typeof p !== "string") return { ...(PROVIDER_DEFAULTS[p.id] ?? {}), ...p, models: { ...(PROVIDER_DEFAULTS[p.id]?.models ?? {}), ...p.models } };
		const preset = PROVIDER_DEFAULTS[p];
		if (!preset) throw new Error(`Unknown provider "${p}". Known: ${Object.keys(PROVIDER_DEFAULTS).join(", ")}`);
		return structuredClone(preset);
	});

	const allDriverIds = drivers.map((d) => d.id);
	const defaultRoles: Record<string, string[]> = {
		default: allDriverIds,
		planner: file.roles?.planner ?? allDriverIds,
		worker: file.roles?.worker ?? allDriverIds,
		integrator: file.roles?.integrator ?? allDriverIds,
		reviewer: file.roles?.reviewer ?? [...allDriverIds].reverse(),
	};

	return {
		topology: (overrides.topology ?? file.topology ?? "hierarchy") as TopologyName,
		drivers,
		roles: { ...defaultRoles, ...(file.roles ?? {}) },
		providers,
		budget: file.budget ?? { tokens: 2_000_000, usd: 5, wallSeconds: 1800, reservePct: 0.12 },
		pools: file.pools ?? DEFAULT_POOLS,
		secrets: file.secrets ?? [],
		verification: file.verification,
		enableBlindReview: file.enableBlindReview ?? false,
		networkOffWorkers: file.networkOffWorkers ?? false,
		dataDir: resolve(projectDir, file.dataDir ?? ".one_piece"),
	};
}
