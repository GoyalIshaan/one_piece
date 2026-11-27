import { describe, expect, it } from "vitest";
import type { DriverHealth, QuotaDriverStatus } from "@one-piece/core";
import type { SpawnedChildOutcome, TriageEvaluation } from "@one-piece/engine";
import {
	toScorecardFaultState,
	type DockerRunResult,
	type GenerationTransition,
	type MleMedalAssessment,
	type Scorecard,
	type ScorecardFaultState,
	type SweBenchScoreOutcome,
} from "../src/index.ts";

describe("Compile-time negative proofs (@ts-expect-error) for 12 newly encoded state machines", () => {
	it("rejects illegal DriverHealth, QuotaDriverStatus, SpawnedChildOutcome, and TriageEvaluation states at compile time", () => {
		// 1. DriverHealth: unhealthy driver MUST carry diagnostic `detail`
		const okHealth: DriverHealth = { ok: true, driverId: "codex", kind: "codex-app-server" };
		const badHealth: DriverHealth = { ok: false, driverId: "codex", kind: "codex-app-server", detail: "not logged in" };
		// @ts-expect-error — unhealthy DriverHealth cannot omit diagnostic detail
		const illegalUnhealthy: DriverHealth = { ok: false, driverId: "codex", kind: "codex-app-server" };

		// 2. QuotaDriverStatus: ONLY `cooldown` may carry `cooldownUntil`
		const healthyQ: QuotaDriverStatus = { driverId: "codex", kind: "codex-app-server", state: "healthy", running: 0, waiting: 0 };
		const cooldownQ: QuotaDriverStatus = { driverId: "codex", kind: "codex-app-server", state: "cooldown", cooldownUntil: 1234, running: 0, waiting: 0 };
		// @ts-expect-error — healthy driver status cannot leak stale cooldownUntil
		const illegalHealthyCooldown: QuotaDriverStatus = { driverId: "codex", kind: "codex-app-server", state: "healthy", cooldownUntil: 1234, running: 0, waiting: 0 };
		// @ts-expect-error — cooldown driver status MUST carry cooldownUntil
		const illegalCooldownMissing: QuotaDriverStatus = { driverId: "codex", kind: "codex-app-server", state: "cooldown", running: 0, waiting: 0 };

		// 3. SpawnedChildOutcome: failed/rate_limited children cannot claim a valid commitSha/score
		const okChild: SpawnedChildOutcome = { agentId: "a1", handle: "w1", role: "worker", status: "completed", commitSha: "abc", score: 1.0, summary: "ok" };
		// @ts-expect-error — failed child outcome cannot carry commitSha
		const illegalFailedCommit: SpawnedChildOutcome = { agentId: "a1", handle: "w1", role: "worker", status: "failed", commitSha: "abc", summary: "boom" };
		// @ts-expect-error — arbitrary typo status string is rejected
		const illegalChildStatus: SpawnedChildOutcome = { agentId: "a1", handle: "w1", role: "worker", status: "done", summary: "typo" };

		// 4. TriageEvaluation: promoted posts MUST be global with promotionReason; non-promoted MUST be subtree without promotionReason
		const promotedTriage: TriageEvaluation = {
			postId: "p1",
			isNovel: 0.9,
			contradictsIncumbent: 0.2,
			broadcastProb: 0.85,
			crossoverProb: 0.7,
			confidence: 0.8,
			promoted: true,
			visibility: "global",
			promotionReason: "novel",
		};
		const localTriage: TriageEvaluation = {
			postId: "p2",
			isNovel: 0.2,
			contradictsIncumbent: 0.1,
			broadcastProb: 0.2,
			crossoverProb: 0.1,
			confidence: 0.8,
			promoted: false,
			visibility: "subtree",
		};
		// @ts-expect-error — promoted triage cannot omit promotionReason or stay subtree
		const illegalPromoted: TriageEvaluation = { postId: "p3", isNovel: 0.9, contradictsIncumbent: 0.1, broadcastProb: 0.9, crossoverProb: 0.1, confidence: 0.8, promoted: true, visibility: "subtree" };
		// @ts-expect-error — non-promoted triage cannot leak promotionReason
		const illegalNonPromoted: TriageEvaluation = { postId: "p4", isNovel: 0.1, contradictsIncumbent: 0.1, broadcastProb: 0.1, crossoverProb: 0.1, confidence: 0.8, promoted: false, visibility: "subtree", promotionReason: "leaked" };

		expect([okHealth, badHealth, illegalUnhealthy, healthyQ, cooldownQ, illegalHealthyCooldown, illegalCooldownMissing, okChild, illegalFailedCommit, illegalChildStatus, promotedTriage, localTriage, illegalPromoted, illegalNonPromoted].length).toBe(14);
	});

	it("rejects illegal DockerRunResult, ScorecardFaultState, Scorecard v2, GenerationTransition, MleMedalAssessment & SweBenchScoreOutcome states at compile time", () => {
		// 5. DockerRunResult: timed_out cannot exit 0; exited cannot set timedOut: true
		const okDocker: DockerRunResult = { outcome: "exited", exitCode: 0, timedOut: false, stdout: "", stderr: "", wallClockMs: 10, containerName: "c1" };
		const toDocker: DockerRunResult = { outcome: "timed_out", exitCode: 124, timedOut: true, stdout: "", stderr: "", wallClockMs: 10, containerName: "c2" };
		// @ts-expect-error — timed_out container cannot claim exitCode 0
		const illegalDockerToZero: DockerRunResult = { outcome: "timed_out", exitCode: 0, timedOut: true, stdout: "", stderr: "", wallClockMs: 10, containerName: "c3" };
		// @ts-expect-error — exited container cannot claim timedOut: true
		const illegalDockerExitedTo: DockerRunResult = { outcome: "exited", exitCode: 1, timedOut: true, stdout: "", stderr: "", wallClockMs: 10, containerName: "c4" };

		// 6. ScorecardFaultState: impossible to desync hasHarnessFault from harnessFaults emptiness
		const cleanFaults: ScorecardFaultState = toScorecardFaultState([]);
		const nonEmptyFaults: ScorecardFaultState = toScorecardFaultState([{ code: "RUNNER_CRASH", message: "boom" }]);
		expect(cleanFaults.hasHarnessFault).toBe(false);
		expect(nonEmptyFaults.hasHarnessFault).toBe(true);
		// @ts-expect-error — hasHarnessFault=true requires non-empty harnessFaults tuple
		const illegalEmptyFaultTrue: ScorecardFaultState = { hasHarnessFault: true, harnessFaults: [] };
		// @ts-expect-error — hasHarnessFault=false forbids non-empty harnessFaults
		const illegalNonEmptyFaultFalse: ScorecardFaultState = { hasHarnessFault: false, harnessFaults: [{ code: "RUNNER_CRASH", message: "x" }] };

		// 7. Scorecard v2 guarantees anytime + mechanisms are present
		type V2Card = Extract<Scorecard, { schemaVersion: 2 }>;
		const assertV2HasFields = (c: V2Card) => c.anytime.aulcTokens + c.mechanisms.board.postsTotal;
		expect(typeof assertV2HasFields).toBe("function");

		// 8. GenerationTransition: unpaired transitions must have pairs=0 and verdict="UNDERPOWERED"
		const baseTrans = {
			fromGenId: "g1",
			fromLabel: "G1",
			toGenId: "g2",
			toLabel: "G2",
			passRateGain: 0,
			scoreGain: { mean: 0, ciLow: 0, ciHigh: 0, n: 0 },
			aulcGain: { mean: 0, ciLow: 0, ciHigh: 0, n: 0 },
			tokenDeltaMean: 0,
			hypervolumeDelta: 0,
			mcnemarPValue: 1,
			fdrQValue: 1,
		};
		const validUnpaired: GenerationTransition = { ...baseTrans, pairingMode: "unpaired", pairs: 0, verdict: "UNDERPOWERED" };
		// @ts-expect-error — unpaired transition cannot claim IMPROVED verdict
		const illegalUnpairedImproved: GenerationTransition = { ...baseTrans, pairingMode: "unpaired", pairs: 0, verdict: "IMPROVED" };
		// @ts-expect-error — unpaired transition cannot have non-zero pairs
		const illegalUnpairedNonZero: GenerationTransition = { ...baseTrans, pairingMode: "unpaired", pairs: 3, verdict: "UNDERPOWERED" };

		// 9. MleMedalAssessment & SweBenchScoreOutcome exact ceiling/floor proofs
		const goldMle: MleMedalAssessment = { medal: "gold", normalizedScore: 1 };
		const invalidMle: MleMedalAssessment = { medal: "invalid", normalizedScore: 0 };
		// @ts-expect-error — gold medal MUST have normalizedScore: 1
		const illegalGoldScore: MleMedalAssessment = { medal: "gold", normalizedScore: 0.4 };
		// @ts-expect-error — invalid submission MUST have normalizedScore: 0
		const illegalInvalidScore: MleMedalAssessment = { medal: "invalid", normalizedScore: 0.9 };

		const resolvedSwe: SweBenchScoreOutcome = { resolved: true, score: 1, f2pPassed: 2, p2pPassed: 5 };
		// @ts-expect-error — resolved SWE-bench instance MUST have score: 1
		const illegalResolvedScore: SweBenchScoreOutcome = { resolved: true, score: 0.5, f2pPassed: 1, p2pPassed: 5 };

		expect([okDocker, toDocker, illegalDockerToZero, illegalDockerExitedTo, illegalEmptyFaultTrue, illegalNonEmptyFaultFalse, validUnpaired, illegalUnpairedImproved, illegalUnpairedNonZero, goldMle, invalidMle, illegalGoldScore, illegalInvalidScore, resolvedSwe, illegalResolvedScore].length).toBe(15);
	});
});
