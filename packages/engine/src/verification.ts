import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EventBus, Finding, FindingSubmission, FindingVerifier, VerificationReceipt } from "@one-piece/core";

const IGNORED_DIRS = new Set([".git", "__pycache__", ".one_piece", ".swarm", ".gemini", ".grok", "node_modules"]);

/**
 * Freeze a workspace snapshot BEFORE async verification/review so an author cannot mutate
 * files underneath a reviewer. Returns a deterministic SHA-256 tree hash.
 */
export function captureFrozenSnapshot(workspace: string, destination: string): string {
	const hash = createHash("sha256");
	let bytes = 0;
	let entries = 0;

	function visit(relDir: string): void {
		mkdirSync(join(destination, relDir), { recursive: true });
		for (const name of readdirSync(join(workspace, relDir)).sort()) {
			if (IGNORED_DIRS.has(name)) continue;
			const rel = join(relDir, name);
			const src = join(workspace, rel);
			const stat = lstatSync(src);
			entries += 1;
			bytes += stat.isFile() ? stat.size : 0;
			if (entries > 4096 || bytes > 64 * 1024 * 1024) {
				throw new Error("Submission exceeds snapshot limit (4096 entries / 64 MiB)");
			}
			hash.update(JSON.stringify([rel, stat.isDirectory() ? "dir" : "file"]));
			if (stat.isDirectory()) {
				visit(rel);
			} else if (stat.isFile()) {
				const dst = join(destination, rel);
				copyFileSync(src, dst);
				hash.update(createHash("sha256").update(readFileSync(dst)).digest());
			}
		}
	}

	try {
		if (!lstatSync(workspace).isDirectory()) throw new Error("Workspace is not a directory");
		visit("");
		return hash.digest("hex");
	} catch (error) {
		rmSync(destination, { recursive: true, force: true });
		throw error;
	}
}

export async function runExecutableCheck(opts: {
	bus: EventBus;
	finding: Finding;
	submission: FindingSubmission;
	verifier: FindingVerifier;
	actorId: string;
	challenge?: string;
	signal: AbortSignal;
}): Promise<VerificationReceipt> {
	const { bus, finding, submission, verifier, actorId, challenge, signal } = opts;
	const start = performance.now();
	const stamp = {
		checker: verifier.name,
		version: verifier.version,
		kind: challenge === undefined ? ("suite" as const) : ("counterexample" as const),
	};
	let receipt: VerificationReceipt;
	try {
		signal.throwIfAborted();
		if (!submission.snapshotDir || !submission.artifactSha256) {
			throw new Error("Submission lacks a frozen snapshot directory or SHA-256 digest");
		}
		const scope = submission.scope ?? verifier.defaultScope;
		const out = await verifier.check({
			workspace: submission.snapshotDir,
			artifactSha256: submission.artifactSha256,
			scope,
			challenge,
			signal,
		});
		receipt = { ...stamp, ...out };
	} catch (error) {
		receipt = { ...stamp, status: "error", message: error instanceof Error ? error.message : String(error) };
	}
	receipt.durationMs = Math.round(performance.now() - start);
	receipt.message = bus.redactor.redactText(receipt.message);
	submission.checks.push(receipt);
	bus.emit(
		finding.runId,
		"finding.verification",
		{
			findingId: finding.id,
			revision: submission.revision,
			scope: submission.scope ?? verifier.defaultScope,
			status: receipt.status,
			message: receipt.message,
		},
		actorId,
	);
	return receipt;
}
