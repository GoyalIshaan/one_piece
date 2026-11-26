import { execFileSync } from "node:child_process";
import type { EventBus, SecretBroker } from "@one-piece/core";

export const KEYCHAIN_SERVICE = "one-piece";

export interface SecretSpec {
	/** Capability name agents use, e.g. "gpu.modal". */
	name: string;
	/** Environment variable the value is injected as, e.g. "MODAL_TOKEN". */
	env: string;
}

export interface SecretsOptions {
	secrets: SecretSpec[];
	defaultGrants?: string[];
	lookup?: (name: string) => string | undefined;
}

function envName(name: string): string {
	return `ONE_PIECE_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function keychainLookup(name: string): string | undefined {
	const fromEnv = process.env[envName(name)];
	if (fromEnv) return fromEnv;
	if (process.platform !== "darwin") return undefined;
	try {
		return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"], {
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim();
	} catch {
		return undefined;
	}
}

/**
 * Capability-based secret broker. Values live in macOS Keychain or ONE_PIECE_SECRET_* env vars,
 * are injected into one subprocess at a time, registered with the redactor, and never shown to models.
 */
export class LocalSecretBroker implements SecretBroker {
	private readonly grants = new Map<string, Set<string>>();
	private readonly cache = new Map<string, string>();
	private readonly bus: EventBus;
	private readonly runId: string;
	private readonly options: SecretsOptions;

	constructor(runId: string, bus: EventBus, options: SecretsOptions) {
		this.runId = runId;
		this.bus = bus;
		this.options = options;
	}

	available(): string[] {
		return this.options.secrets.map((s) => s.name);
	}

	grantsOf(agentId: string): string[] {
		const explicit = this.grants.get(agentId);
		if (explicit) return [...explicit];
		return this.options.defaultGrants ?? this.available();
	}

	grant(agentId: string, capabilities: string[]): void {
		const known = new Set(this.available());
		const unknown = capabilities.filter((c) => !known.has(c));
		if (unknown.length) throw new Error(`Unknown capabilities: ${unknown.join(", ")}`);
		this.grants.set(agentId, new Set(capabilities));
		this.bus.emit(this.runId, "secrets.granted", { capabilities }, agentId);
	}

	envFor(agentId: string, capabilities: string[]): Record<string, string> {
		const held = new Set(this.grantsOf(agentId));
		const out: Record<string, string> = {};
		for (const name of capabilities) {
			if (!held.has(name)) throw new Error(`Capability "${name}" is not granted to ${agentId}`);
			const spec = this.options.secrets.find((s) => s.name === name);
			if (!spec) throw new Error(`Unknown capability "${name}"`);
			let value = this.cache.get(name);
			if (value === undefined) {
				value = (this.options.lookup ?? keychainLookup)(name);
				if (!value) throw new Error(`Capability "${name}" has no stored value (set with one-piece secrets set ${name})`);
				this.cache.set(name, value);
				this.bus.redactor.addSecret(value);
			}
			out[spec.env] = value;
			this.bus.emit(this.runId, "secrets.used", { capability: name }, agentId);
		}
		return out;
	}
}
