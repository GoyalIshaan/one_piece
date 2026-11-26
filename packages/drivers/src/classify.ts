import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DriverHealth, DriverKind, QuotaErrorClass } from "@one-piece/core";

const execFileAsync = promisify(execFile);

/**
 * 3-Class Quota & Auth Error Classifier (applied to both structured JSON events and raw stderr/stdout):
 * - Class 1 (`transient_rpm`): short RPM / 529 overload -> exponential backoff on same worker
 * - Class 2 (`window_exhausted`): 5h rolling cap / daily RPD / RESOURCE_EXHAUSTED -> COOLDOWN + worktree failover
 * - Class 3 (`hard_auth_or_cap`): 401/403 / revoked auth / weekly cap -> DRAINED circuit breaker (0 retries)
 */
export function classifyQuotaError(rawText: string): QuotaErrorClass | undefined {
	const text = rawText.trim();
	if (!text) return undefined;

	// Class 3: Hard auth / forbidden / deprecated client / unsupported model / weekly cap (NEVER auto-retry!)
	if (
		/\b(401|403|426)\b/.test(text) ||
		/unauthorized|forbidden|invalid[_ ]?api[_ ]?key|authentication failed|credential.*only authorized|account.*suspended|weekly.*(limit|cap|quota)|not logged in|please log in|re-?authenticate|client is no longer supported|upgrade required|model_not_found|model_not_in_accessible_catalog|not supported when using codex/i.test(text)
	) {
		return { kind: "hard_auth_or_cap", reason: text.slice(0, 240), raw: text };
	}

	// Class 2: Rolling 5h window / daily RPD / quota exhausted -> failover immediately
	if (
		/resource_exhausted|quota exceeded|usage limit|5[- ]?hour|daily limit|limit:\s*0|billing.*limit|out of (credits|quota)|rate limit.*reset/i.test(text)
	) {
		const resetAtMs = parseResetTimestamp(text);
		return { kind: "window_exhausted", resetAtMs, raw: text };
	}

	// Class 1: Transient RPM / 429 / 529 overload -> short jittered backoff
	if (
		/\b(429|502|503|529)\b/.test(text) ||
		/rate[_ ]?limit|too many requests|overloaded|at capacity|temporarily unavailable|try again in \d/i.test(text)
	) {
		const retryMatch = /try again in (\d+)\s*(ms|s|sec|seconds|m|min)/i.exec(text);
		let retryAfterMs: number | undefined;
		if (retryMatch) {
			const val = Number(retryMatch[1]);
			const unit = retryMatch[2]!.toLowerCase();
			retryAfterMs = unit.startsWith("ms") ? val : unit.startsWith("m") ? val * 60_000 : val * 1_000;
		}
		return { kind: "transient_rpm", retryAfterMs, raw: text };
	}

	return undefined;
}

function parseResetTimestamp(text: string): number | undefined {
	const mins = /resets?\s+in\s+(\d+)\s*(m|min|minute)/i.exec(text);
	if (mins) return Date.now() + Number(mins[1]) * 60_000;
	const hours = /resets?\s+in\s+(\d+)\s*(h|hr|hour)/i.exec(text);
	if (hours) return Date.now() + Number(hours[1]) * 3_600_000;
	return undefined;
}

/** Build a clean env for CLI subprocesses, stripping API keys when subscriptionMode is enabled. */
export function buildCliEnv(stripKeys: readonly string[], extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...extra };
	for (const key of stripKeys) delete env[key];
	return env;
}

export async function probeCliBinary(
	driverId: string,
	kind: DriverKind,
	binary: string,
	versionArgs: string[] = ["--version"],
): Promise<DriverHealth> {
	try {
		const { stdout: whichOut } = await execFileAsync("/usr/bin/which", [binary], { timeout: 3_000 });
		const binaryPath = whichOut.trim();
		const { stdout, stderr } = await execFileAsync(binary, versionArgs, { timeout: 5_000 });
		const version = (stdout || stderr).trim().split(/\r?\n/)[0]?.trim();
		return { ok: true, driverId, kind, binaryPath, version };
	} catch (error) {
		return {
			ok: false,
			driverId,
			kind,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}
