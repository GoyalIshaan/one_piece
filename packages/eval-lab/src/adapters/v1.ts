import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CandidateSnapshot, HarnessAdapter, HarnessRunReceipt, HarnessRunSpec } from "../contracts.ts";
import { sha256Dir } from "../sandbox.ts";

export interface V1BridgeConfig {
	/** Factory returning a configured v1 ModelRouter and modules (injected by caller to avoid static coupling). */
	createRuntime: (spec: HarnessRunSpec) => Promise<{
		run: () => Promise<{
			runId: string;
			status: "done" | "stopped" | "failed";
			nominatedArtifactDir?: string;
			candidates: CandidateSnapshot[];
		}>;
	}>;
}

/**
 * Thin, zero-static-import bridge for running v1 `one_piece` baselines through Layer E.
 * Because `@one-piece/eval-lab` does not statically import `@one-piece/engine`, the v2 refactor
 * can freely evolve or replace v1 packages without breaking `@one-piece/eval-lab`.
 */
export function createV1BridgeAdapter(config: V1BridgeConfig): HarnessAdapter {
	return {
		name: "v1-bridge",
		async run(spec: HarnessRunSpec): Promise<HarnessRunReceipt> {
			const runtime = await config.createRuntime(spec);
			const began = Date.now();
			const outcome = await runtime.run();
			let nominatedDir = outcome.nominatedArtifactDir;
			let autoNominated = false;

			if (!nominatedDir && spec.autoNominate) {
				const bestAccepted = outcome.candidates.findLast((c) => c.acceptedByVerifier && existsSync(c.dir));
				const fallback = bestAccepted ?? outcome.candidates.findLast((c) => existsSync(c.dir));
				if (fallback) {
					nominatedDir = fallback.dir;
					autoNominated = true;
				}
			}

			const validNomDir = nominatedDir && existsSync(nominatedDir) ? nominatedDir : undefined;
			const nomination = validNomDir
				? {
					nominatedArtifactDir: validNomDir,
					nominatedSha256: sha256Dir(validNomDir),
					nominatedAtWallMs: Date.now() - began,
					autoNominated,
				}
				: { autoNominated: false as const };

			return {
				runId: outcome.runId,
				status: outcome.status,
				...nomination,
				candidateSnapshots: outcome.candidates,
				harnessFaults: [],
			};
		},
	};
}

/** Convenience helper to locate frozen v1 finding submission directories on disk. */
export function v1SubmissionDir(runDir: string, findingId: string, revision: number): string {
	return join(runDir, "submissions", findingId, String(revision));
}
