import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderConfig } from "@one-piece/router";
import type { PoolConfig } from "@one-piece/scheduler";
import type { SecretSpec } from "@one-piece/module-secrets";

// one-piece.config.json in the project folder. Everything is optional; flags override it.

export interface OnePieceConfig {
	providers: ProviderConfig[];
	/** Search kind picks the default module profile: code, literature, ml, kernels. */
	kind: "code" | "literature" | "ml" | "kernels";
	budget: { tokens?: number; usd?: number; cpu_seconds?: number; gpu_minutes?: number };
	pools: PoolConfig[];
	secrets: SecretSpec[];
	maxConcurrentAgents: number;
	caps: { maxChildren: number; maxDepth: number };
	questionDeadlineMinutes: number;
	/** Where runs and the store live. Default: .one_piece in the project folder (project isolation). */
	dataDir: string;
}

/** Defaults per provider. Override any of them in one-piece.config.json; list models with `one-piece models <provider>`. */
export const PROVIDER_DEFAULTS: Record<string, ProviderConfig> = {
	openai: {
		id: "openai",
		models: { default: "gpt-6.2-sol", leaf: "gpt-6-luna", hidden_reviewer: "gpt-6-luna" },
		maxConcurrent: 4,
		requestsPerMinute: 40,
	},
	"openai-codex": { id: "openai-codex", models: { default: "gpt-6.2-sol", leaf: "gpt-6-luna" }, maxConcurrent: 3, requestsPerMinute: 30 },
	openrouter: {
		id: "openrouter",
		models: { default: "anthropic/claude-sonnet-5.5", leaf: "deepseek/deepseek-v3.2", hidden_reviewer: "deepseek/deepseek-v3.2" },
		maxConcurrent: 6,
		requestsPerMinute: 60,
	},
	xai: { id: "xai", models: { default: "grok-4.7" }, maxConcurrent: 3, requestsPerMinute: 30 },
	anthropic: { id: "anthropic", models: { default: "claude-sonnet-5-5" }, maxConcurrent: 2, requestsPerMinute: 20 },
	sim: { id: "sim", models: { default: "sim-1" }, maxConcurrent: 16, requestsPerMinute: 100_000 },
};

export const DEFAULT_POOLS: PoolConfig[] = [{ name: "cpu", unit: "cpu_seconds", capacity: 2, kind: "local", description: "local sandboxed CPU, network off" }];

export function homeDir(): string {
	return join(homedir(), ".one_piece");
}

export function loadConfig(projectDir: string, providerFlag?: string[]): OnePieceConfig {
	const path = join(projectDir, "one-piece.config.json");
	const file = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Partial<OnePieceConfig> & { providers?: Array<ProviderConfig | string> }) : {};
	const requested = providerFlag?.length ? providerFlag : (file.providers ?? ["openai"]);
	const providers = requested.map((p) => {
		if (typeof p !== "string") return { ...(PROVIDER_DEFAULTS[p.id] ?? {}), ...p, models: { ...(PROVIDER_DEFAULTS[p.id]?.models ?? {}), ...p.models } };
		const preset = PROVIDER_DEFAULTS[p];
		if (!preset) throw new Error(`Unknown provider "${p}". Known: ${Object.keys(PROVIDER_DEFAULTS).join(", ")}`);
		return preset;
	});
	return {
		providers,
		kind: file.kind ?? "code",
		budget: file.budget ?? { tokens: 2_000_000, usd: 5 },
		pools: file.pools ?? DEFAULT_POOLS,
		secrets: file.secrets ?? [],
		maxConcurrentAgents: file.maxConcurrentAgents ?? 6,
		caps: file.caps ?? { maxChildren: 8, maxDepth: 6 },
		questionDeadlineMinutes: file.questionDeadlineMinutes ?? 15,
		dataDir: resolve(projectDir, file.dataDir ?? ".one_piece"),
	};
}
