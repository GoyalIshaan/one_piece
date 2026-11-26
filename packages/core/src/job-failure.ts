import type { Job } from "./types.ts";

/** Compact stderr/stdout evidence for a failed job. Lease chatter is already in the receipt. */
export function diagnosticExcerpt(text: string): string {
	const lines = text.replace(/https?:\/\/[^\s"'<>]+\?[^\s"'<>]+/gi, url => url.split("?")[0] + "?[redacted]")
		.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^(Waiting for|Acquired) .+ lease$/.test(line));
	const errors = lines.filter(line => /error|fail|unknown|unsupported|denied|not found|cannot|exception|invalid|timed out/i.test(line));
	const selected = errors.length ? [...new Set([errors[0]!, ...errors.slice(-4)])] : lines.slice(-4);
	return selected.map(line => line.slice(0, 260)).join("\n").slice(0, 1000);
}

export function jobFailure(job: Job) {
	if (job.status !== "failed") return undefined;
	const stage = job.failureStage ?? (job.stderr?.startsWith("Harness interrupted") ? "interrupted" :
		job.startedAt !== undefined ? "execution" : job.stderr?.startsWith("Gate failed") ? "gate" : "admission");
	// Older receipts could let missing output validation hide a command failure.
	const missingMaskedFailure = job.exitCode !== undefined && job.exitCode !== 0
		&& job.failureDetail?.startsWith("Required job outputs unavailable:");
	const detail = !missingMaskedFailure && job.failureDetail ? job.failureDetail
		: diagnosticExcerpt([job.stderr, job.stdout].filter(Boolean).join("\n")) || job.failureDetail || "";
	const files = job.receipt?.outputFiles?.filter(file => file.sha256 !== undefined).map(file => file.path);
	const stdoutTail = job.stdout?.trim().slice(-480) || undefined;
	return { stage, exitCode: job.exitCode, detail, files, stdoutTail };
}
