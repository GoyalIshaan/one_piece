import type { DriverConfig, WorkerDriver } from "@one-piece/core";
import type { CallRecord, ModelRouter } from "@one-piece/router";
import { AgyAcpDriver } from "./agy.ts";
import { CodexAppServerDriver, CodexExecDriver } from "./codex.ts";
import { GeminiCliDriver } from "./gemini.ts";
import { GrokAcpDriver, GrokCliDriver } from "./grok.ts";
import { PiInProcessDriver } from "./pi.ts";

export { AgyAcpDriver } from "./agy.ts";
export { buildCliEnv, classifyQuotaError, probeCliBinary } from "./classify.ts";
export { prepareCleanCodexHome, prepareCleanGrokHome } from "./cli-home.ts";
export { buildStructuredAnchorMessages, estimateMessageTokens, extractFailedApproaches, maybeCompactSession, microCompactMessages } from "./compaction.ts";
export { CodexAppServerDriver, CodexExecDriver } from "./codex.ts";
export { GeminiCliDriver } from "./gemini.ts";
export { GrokAcpDriver, GrokCliDriver } from "./grok.ts";
export { synthesizeHandoffFile, type HandoffInput } from "./handoff.ts";
export { PiInProcessDriver } from "./pi.ts";
export { DriverQuotaRouter, type QuotaRouterOptions } from "./quota-router.ts";

export function createDriver(
	config: DriverConfig,
	deps: { piRouter?: ModelRouter; onPiCall?: (agentId: string, record: CallRecord) => void } = {},
): WorkerDriver {
	switch (config.kind) {
		case "codex-app-server":
			return new CodexAppServerDriver(config);
		case "codex-exec":
			return new CodexExecDriver(config);
		case "grok-acp":
			return new GrokAcpDriver(config);
		case "grok-cli":
			return new GrokCliDriver(config);
		case "agy-acp":
			return new AgyAcpDriver(config);
		case "gemini-cli":
		case "gemini-acp":
			return new GeminiCliDriver(config);
		case "pi-in-process":
			if (!deps.piRouter) throw new Error(`Driver "${config.id}" (pi-in-process) requires a ModelRouter`);
			return new PiInProcessDriver(config, deps.piRouter, deps.onPiCall);
	}
}
