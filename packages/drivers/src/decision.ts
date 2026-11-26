import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	DecisionAnswer,
	DecisionModelClient,
	DecisionQuestion,
	DecisionRequest,
	DecisionResponse,
} from "@one-piece/core";

export interface JevClientOptions {
	apiKey: string;
	/** Model ID (default "jev-latest"). */
	model?: string;
	/** Endpoint URL (default "https://api.typesafe.ai/v1/systemone"). */
	baseUrl?: string;
	/** Per-request timeout in ms (default 15_000). */
	timeoutMs?: number;
	/** Max retries on transient HTTP 429/5xx errors (default 2). */
	maxRetries?: number;
	/** Automatically send `TypeSafe-Danger-Zone-Long-Context: true` above this estimated token threshold (default 48_000). */
	longContextTokenThreshold?: number;
	/** Optional custom fetch implementation (useful for unit testing). */
	fetchImpl?: typeof fetch;
}

const DEFAULT_JEV_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_JEV_MODEL = "jev-latest";

function clamp01(val: number): number {
	if (!Number.isFinite(val)) return 0;
	return Math.max(0, Math.min(1, val));
}

function estimateStateTokens(state: string | Record<string, unknown>): number {
	const raw = typeof state === "string" ? state : JSON.stringify(state);
	return Math.ceil(raw.length / 4);
}

function normalizeAnswer(raw: unknown, expected: DecisionQuestion | undefined): DecisionAnswer {
	if (!raw || typeof raw !== "object") {
		throw new Error(`Malformed decision answer: expected object, got ${typeof raw}`);
	}
	const obj = raw as Record<string, unknown>;
	const kind = typeof obj.type === "string" ? obj.type : expected?.type;

	if (kind === "noul") {
		const p = clamp01(Number(obj.noul));
		const conf = typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
			? clamp01(obj.confidence)
			: clamp01(Math.abs(2 * p - 1));
		return { type: "noul", noul: p, confidence: conf };
	}

	if (kind === "choice") {
		const choice = typeof obj.choice === "string" ? obj.choice : "";
		const probsRaw = obj.probabilities && typeof obj.probabilities === "object"
			? (obj.probabilities as Record<string, unknown>)
			: {};
		const probabilities: Record<string, number> = {};
		for (const [k, v] of Object.entries(probsRaw)) {
			probabilities[k] = clamp01(Number(v));
		}
		const fallbackConf = choice && probabilities[choice] !== undefined ? probabilities[choice]! : 0.5;
		const conf = typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
			? clamp01(obj.confidence)
			: clamp01(fallbackConf);
		return { type: "choice", choice, confidence: conf, probabilities };
	}

	if (kind === "score") {
		const score = typeof obj.score === "number" && Number.isFinite(obj.score) ? obj.score : 0;
		const conf = typeof obj.confidence === "number" && Number.isFinite(obj.confidence) ? clamp01(obj.confidence) : 0.5;
		const legend: Record<string, string> = {};
		if (obj.legend && typeof obj.legend === "object") {
			for (const [k, v] of Object.entries(obj.legend as Record<string, unknown>)) {
				legend[k] = String(v);
			}
		} else if (expected?.type === "score") {
			expected.criteria.forEach((desc, idx) => {
				legend[String(idx)] = desc;
			});
		}
		const probabilities: Record<string, number> = {};
		if (obj.probabilities && typeof obj.probabilities === "object") {
			for (const [k, v] of Object.entries(obj.probabilities as Record<string, unknown>)) {
				probabilities[k] = clamp01(Number(v));
			}
		}
		return { type: "score", score, confidence: conf, legend, probabilities };
	}

	throw new Error(`Unsupported decision answer type "${String(kind)}"`);
}

function serializeJevQuestion(q: DecisionQuestion): Record<string, unknown> {
	if (q.type === "noul") {
		return { type: "noul", instructions: q.instructions };
	}
	if (q.type === "choice") {
		return { type: "choice", instructions: q.instructions, criteria: q.criteria };
	}
	return { type: "score", instructions: q.instructions, criteria: [...q.criteria] };
}

/**
 * Zero-dependency TypeSafe Jev System-1 calibrated decision client (`POST /v1/systemone`).
 * Evaluates closed-set `noul`, `choice`, and `score` questions in a single forward pass with 0 output tokens.
 */
export class JevDecisionClient implements DecisionModelClient {
	readonly provider = "typesafe-jev";
	readonly model: string;
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly maxRetries: number;
	private readonly longContextTokenThreshold: number;
	private readonly fetchImpl: typeof fetch;

	constructor(opts: JevClientOptions) {
		if (!opts.apiKey?.trim()) {
			throw new Error("JevDecisionClient requires a non-empty apiKey");
		}
		this.apiKey = opts.apiKey.trim();
		this.model = opts.model?.trim() || DEFAULT_JEV_MODEL;
		this.baseUrl = opts.baseUrl?.trim() || DEFAULT_JEV_URL;
		this.timeoutMs = Math.max(500, opts.timeoutMs ?? 15_000);
		this.maxRetries = Math.max(0, opts.maxRetries ?? 2);
		this.longContextTokenThreshold = opts.longContextTokenThreshold ?? 48_000;
		this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
	}

	async decide(req: DecisionRequest): Promise<DecisionResponse> {
		const questionKeys = Object.keys(req.questions);
		if (!questionKeys.length) {
			throw new Error("DecisionRequest must include at least one question");
		}

		const estTokens = estimateStateTokens(req.state);
		const useLongContext = Boolean(req.longContext) || estTokens > this.longContextTokenThreshold;
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
			"Content-Type": "application/json",
		};
		if (useLongContext) {
			headers["TypeSafe-Danger-Zone-Long-Context"] = "true";
		}

		const serializedQuestions: Record<string, Record<string, unknown>> = {};
		for (const key of questionKeys) {
			serializedQuestions[key] = serializeJevQuestion(req.questions[key]!);
		}
		const payload = JSON.stringify({
			model: this.model,
			state: req.state,
			questions: serializedQuestions,
		});

		const began = Date.now();
		let lastError: Error | undefined;

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			if (req.signal?.aborted) {
				throw new Error("Jev decision request aborted");
			}
			const ac = new AbortController();
			const onParentAbort = () => ac.abort();
			req.signal?.addEventListener("abort", onParentAbort, { once: true });
			const timer = setTimeout(() => ac.abort(), this.timeoutMs);
			timer.unref?.();

			try {
				const res = await this.fetchImpl(this.baseUrl, {
					method: "POST",
					headers,
					body: payload,
					signal: ac.signal,
				});

				if (!res.ok) {
					const errBody = await res.text().catch(() => "");
					const retryable = res.status === 429 || res.status >= 500;
					lastError = new Error(`Jev HTTP ${res.status}: ${errBody.slice(0, 300)}`);
					if (retryable && attempt < this.maxRetries) {
						const delayMs = Math.min(2_000, 250 * 2 ** attempt);
						await new Promise((r) => setTimeout(r, delayMs));
						continue;
					}
					throw lastError;
				}

				const body = (await res.json()) as {
					model?: string;
					answers?: Record<string, unknown>;
					usage?: { input_tokens?: number; output_tokens?: number; total_input_tokens?: number; total_output_tokens?: number };
				};
				if (!body?.answers || typeof body.answers !== "object") {
					throw new Error("Jev response missing `answers` map");
				}

				const answers: Record<string, DecisionAnswer> = {};
				for (const key of questionKeys) {
					if (body.answers[key] === undefined) {
						throw new Error(`Jev response missing answer for question "${key}"`);
					}
					answers[key] = normalizeAnswer(body.answers[key], req.questions[key]);
				}

				const inputTokens = Number(body.usage?.input_tokens ?? body.usage?.total_input_tokens ?? estTokens);
				const outputTokens = Number(body.usage?.output_tokens ?? body.usage?.total_output_tokens ?? 0);

				return {
					answers,
					inputTokens: Number.isFinite(inputTokens) ? inputTokens : estTokens,
					outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
					latencyMs: Math.max(0, Date.now() - began),
					provider: this.provider,
					model: typeof body.model === "string" && body.model ? body.model : this.model,
				};
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				const abortedByCaller = Boolean(req.signal?.aborted);
				if (abortedByCaller || attempt >= this.maxRetries) {
					throw lastError;
				}
				const delayMs = Math.min(2_000, 250 * 2 ** attempt);
				await new Promise((r) => setTimeout(r, delayMs));
			} finally {
				clearTimeout(timer);
				req.signal?.removeEventListener("abort", onParentAbort);
			}
		}

		throw lastError ?? new Error("Jev decision request failed");
	}
}

export type MockDecisionHandler = (
	req: DecisionRequest,
	callIndex: number,
) => Record<string, DecisionAnswer> | Promise<Record<string, DecisionAnswer>>;

/** Deterministic offline System-1 decision client for unit tests and reproducible dry runs. */
export class MockDecisionClient implements DecisionModelClient {
	readonly provider = "mock-decision";
	readonly model = "mock-jev-1";
	readonly calls: DecisionRequest[] = [];
	private readonly handler: MockDecisionHandler;

	constructor(handler: MockDecisionHandler) {
		this.handler = handler;
	}

	async decide(req: DecisionRequest): Promise<DecisionResponse> {
		const idx = this.calls.length;
		this.calls.push(req);
		const began = Date.now();
		const answers = await this.handler(req, idx);
		return {
			answers,
			inputTokens: estimateStateTokens(req.state),
			outputTokens: 0,
			latencyMs: Math.max(1, Date.now() - began),
			provider: this.provider,
			model: this.model,
		};
	}
}

/**
 * Load an API key from `process.env` or a local git-ignored `.env` file without mutating global env.
 */
export function loadEnvKey(keyName: string, cwd = process.cwd()): string | undefined {
	const fromEnv = process.env[keyName]?.trim();
	if (fromEnv) return fromEnv;
	const envPath = join(cwd, ".env");
	if (!existsSync(envPath)) return undefined;
	try {
		const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
		for (const raw of lines) {
			const trimmed = raw.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq <= 0) continue;
			const k = trimmed.slice(0, eq).trim();
			if (k !== keyName) continue;
			let val = trimmed.slice(eq + 1).trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			return val.trim() || undefined;
		}
	} catch {
		// Ignore unreadable .env
	}
	return undefined;
}

export interface DecisionFactoryOptions {
	provider?: "jev" | "auto" | "none";
	model?: string;
	baseUrl?: string;
	apiKey?: string;
	cwd?: string;
}

/**
 * Resolve a live System-1 `DecisionModelClient` from explicit options, env vars, or `.env`.
 * Returns `undefined` cleanly when `provider === "none"` or no key is configured so callers degrade gracefully.
 */
export function createDecisionClientFromEnv(opts: DecisionFactoryOptions = {}): DecisionModelClient | undefined {
	const provider = opts.provider ?? "auto";
	if (provider === "none") return undefined;

	const jevKey =
		opts.apiKey?.trim() ||
		loadEnvKey("TYPESAFE_API_KEY", opts.cwd) ||
		loadEnvKey("JEV_API_KEY", opts.cwd);
	if (jevKey) {
		return new JevDecisionClient({
			apiKey: jevKey,
			model: opts.model,
			baseUrl: opts.baseUrl ?? loadEnvKey("TYPESAFE_BASE_URL", opts.cwd),
		});
	}

	if (provider === "jev") {
		// Explicit request for Jev with no key still degrades cleanly when caller wants fallback,
		// unless they construct JevDecisionClient directly.
		return undefined;
	}
	return undefined;
}
