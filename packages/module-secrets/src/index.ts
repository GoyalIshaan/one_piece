import { execFileSync } from "node:child_process";
import { obj, str } from "@earendil-works/pi-schema";
import { defineTool, type HarnessApi, type HarnessModule, type NodeContext, type SecretBroker } from "@one-piece/core";

// Secrets are capabilities with names. Values live in the macOS Keychain (service "one-piece")
// or in ONE_PIECE_SECRET_<NAME> environment variables, are injected into one tool process at a
// time, are registered with the redactor, and never enter a model's context.

export const KEYCHAIN_SERVICE = "one-piece";

export interface SecretSpec {
	/** Capability name agents use, e.g. "gpu.modal". */
	name: string;
	/** Environment variable the value is injected as, e.g. "MODAL_TOKEN". */
	env: string;
}

export interface SecretsOptions {
	secrets: SecretSpec[];
	/** Capabilities the root starts with; defaults to every configured secret. */
	rootGrants?: string[];
	/** Override value lookup (tests). */
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
		return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"], { stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
	} catch {
		return undefined;
	}
}

class Broker implements SecretBroker {
	private readonly grants = new Map<string, Set<string>>();
	private readonly cache = new Map<string, string>();
	private readonly harness: HarnessApi;
	private readonly options: SecretsOptions;

	constructor(harness: HarnessApi, options: SecretsOptions) {
		this.harness = harness;
		this.options = options;
	}

	available(): string[] {
		return this.options.secrets.map((s) => s.name);
	}

	grantsOf(nodeId: string): string[] {
		const node = this.harness.tree.get(nodeId);
		if (!node) return [];
		// Reviewers act with the grants of the node they review.
		const owner = node.targetNodeId && !this.grants.has(nodeId) ? node.targetNodeId : nodeId;
		const explicit = this.grants.get(owner);
		if (explicit) return [...explicit];
		const ownerNode = this.harness.tree.get(owner);
		if (!ownerNode?.parentId) return this.options.rootGrants ?? this.available();
		return this.grantsOf(ownerNode.parentId);
	}

	grant(nodeId: string, capabilities: string[]): void {
		const node = this.harness.tree.require(nodeId);
		const parentGrants = new Set(node.parentId ? this.grantsOf(node.parentId) : (this.options.rootGrants ?? this.available()));
		const refused = capabilities.filter((c) => !parentGrants.has(c));
		if (refused.length) throw new Error(`Cannot grant ${refused.join(", ")}: the parent does not hold them`);
		this.grants.set(nodeId, new Set(capabilities));
		this.harness.bus.emit(node.runId, "secrets.granted", { capabilities }, nodeId);
	}

	envFor(nodeId: string, capabilities: string[]): Record<string, string> {
		const held = new Set(this.grantsOf(nodeId));
		const out: Record<string, string> = {};
		const node = this.harness.tree.require(nodeId);
		for (const name of capabilities) {
			if (!held.has(name)) throw new Error(`Capability ${name} is not granted to you; ask your parent (ask, kind resource)`);
			const spec = this.options.secrets.find((s) => s.name === name);
			if (!spec) throw new Error(`Unknown capability ${name}`);
			let value = this.cache.get(name);
			if (value === undefined) {
				value = (this.options.lookup ?? keychainLookup)(name);
				if (!value) throw new Error(`Capability ${name} has no stored value; the user must add it (one-piece secrets set ${name})`);
				this.cache.set(name, value);
				this.harness.bus.redactor.addSecret(value);
			}
			out[spec.env] = value;
			this.harness.bus.emit(node.runId, "secrets.used", { capability: name }, nodeId);
		}
		return out;
	}
}

export function secretsModule(options: SecretsOptions): HarnessModule {
	let harness: HarnessApi;
	return {
		manifest: {
			name: "secrets",
			version: "0.1.0",
			summary: "Named capabilities (API keys) injected into commands; values never shown",
			roles: ["root", "internal", "leaf"],
			tools: ["list_capabilities", "grant_capability"],
			contextCostTokens: 250,
		},
		setup(h) {
			harness = h;
			h.services.register("secrets", new Broker(h, options));
		},
		prompt() {
			return "Secrets: refer to keys only by capability name (pass capabilities to bash or submit_job). You never see values. Missing one? ask your parent with kind resource.";
		},
		tools(ctx: NodeContext) {
			const { node } = ctx;
			const broker = harness.services.require("secrets");
			const tools = [
				defineTool({
					name: "list_capabilities",
					description: "List the secret capabilities you hold (names only).",
					parameters: obj({}),
					async execute() {
						const held = broker.grantsOf(node.id);
						return held.length ? held.join("\n") : "You hold no capabilities.";
					},
				}),
			];
			if (node.role === "root" || node.role === "internal") {
				tools.push(
					defineTool({
						name: "grant_capability",
						description: "Give one of your children a capability you hold (children never get more than their parent).",
						parameters: obj({ child_id: str(), capability: str() }),
						async execute(params) {
							const child = harness.tree.get(params.child_id);
							if (!child || child.parentId !== node.id) throw new Error("Not your child");
							broker.grant(child.id, [...new Set([...broker.grantsOf(child.id), params.capability])]);
							return "Granted.";
						},
					}),
				);
			}
			return tools;
		},
	};
}
