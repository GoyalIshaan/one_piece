import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { VerificationModule, VerificationModuleSpec } from "./services.ts";

export async function loadVerificationModule(baseDir: string, spec: VerificationModuleSpec): Promise<VerificationModule> {
	if (typeof spec.module !== "string" || !spec.module.trim()) {
		throw new Error("Verification configuration requires a module path");
	}
	const path = resolve(baseDir, spec.module);
	const entry = await import(pathToFileURL(path).href);
	if (typeof entry.default !== "function") {
		throw new Error(`Verification module ${path} must default-export a factory`);
	}
	const module: VerificationModule = await entry.default(spec.options ?? {});
	const verifier = module?.findingVerifier;
	if (
		!module?.manifest?.name ||
		!verifier?.name ||
		!verifier.version ||
		typeof verifier.check !== "function" ||
		!Array.isArray(verifier.scopes) ||
		!verifier.scopes.includes(verifier.defaultScope)
	) {
		throw new Error(`Verification module ${path} must provide a verifier with a valid default scope`);
	}
	return module;
}
