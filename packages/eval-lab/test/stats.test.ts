import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMockAdapter } from "../src/adapters/mock.ts";
import { runCampaign } from "../src/runner.ts";
import { bootstrapCI, evaluatePromotionBar, mcnemarExact } from "../src/stats.ts";
import { miniCoopInterpTask } from "../src/tasks/mini-coop-interp/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("statistical engine & 4-rung paired campaign runner", () => {
	it("computes exact two-sided McNemar p-values and deterministic seeded bootstrap CIs", () => {
		// 6 candidate-only wins, 0 baseline-only wins => 2 * (0.5)^6 = 0.03125
		expect(mcnemarExact(6, 0)).toBeCloseTo(0.03125, 5);
		expect(mcnemarExact(5, 5)).toBe(1);
		expect(mcnemarExact(0, 0)).toBe(1);

		const ci1 = bootstrapCI([0.2, 0.3, 0.25, 0.35, 0.4], { seed: 42 });
		const ci2 = bootstrapCI([0.2, 0.3, 0.25, 0.35, 0.4], { seed: 42 });
		expect(ci1).toEqual(ci2);
		expect(ci1.mean).toBeCloseTo(0.3, 5);
		expect(ci1.ciLow).toBeGreaterThan(0.2);
		expect(ci1.ciHigh).toBeLessThanOrEqual(0.4);
	});

	it("enforces pre-registered promotion bars strictly", () => {
		const strong = {
			pairs: 6,
			baselinePassRate: 0.3333,
			candidatePassRate: 1.0,
			passRateGain: 0.6667,
			winsOnlyCandidate: 4,
			winsOnlyBaseline: 0,
			bothPassed: 2,
			neitherPassed: 0,
			mcnemarPValue: 0.125,
			scoreGain: { mean: 0.35, ciLow: 0.15, ciHigh: 0.55, n: 6 },
			tokenDeltaMean: 0,
			wallClockRatio: 0.8,
			baselineFaults: 0,
			candidateFaults: 0,
		};
		expect(
			evaluatePromotionBar(strong, { minSeeds: 5, minPassRateGain: 0.1, maxIntegrityFaults: 0, requireCiAboveZero: true }).verdict,
		).toBe("PROMOTE");
		expect(
			evaluatePromotionBar({ ...strong, pairs: 3 }, { minSeeds: 5, minPassRateGain: 0.1, maxIntegrityFaults: 0 }).verdict,
		).toBe("NO_DECISION");
		expect(
			evaluatePromotionBar({ ...strong, candidateFaults: 1 }, { minSeeds: 5, minPassRateGain: 0.1, maxIntegrityFaults: 0 }).verdict,
		).toBe("REJECT");
	});

	it("runs an interleaved paired solo vs silent_bon vs swarm campaign and computes Coordination Lift", async () => {
		const root = mkdtempSync(join(tmpdir(), "eval-campaign-"));
		try {
			// Prepare a reference directory for seed=2 (16-bit) & seed=3 (32-bit) dynamically per run
			// using an adapter wrapper that builds the matching reference when swarm wins.
			const outDir = join(root, "campaign");
			const baseAdapter = createMockAdapter({
				mode: "starter",
				shouldSolve: (spec) => spec.controlRung === "swarm",
			});

			// Wrap baseAdapter so referenceDir matches each seed's exact bit-width!
			const seedAwareAdapter = {
				name: "mock:swarm-beats-solo-and-bon",
				async run(spec: Parameters<typeof baseAdapter.run>[0]) {
					const refDir = join(spec.runDir, "_ref_oracle");
					const hiddenDir = spec.hiddenDenyPaths[0]!;
					cpSync(spec.workspaceDir, refDir, { recursive: true });
					await miniCoopInterpTask.buildReferenceArtifact!({
						prepared: {
							taskId: spec.taskId,
							seed: spec.seed,
							n: spec.swarmSize,
							options: spec.taskOptions ?? {},
							workspaceDir: spec.workspaceDir,
							hiddenDir,
							goal: spec.goal,
							fixtureSha256: "",
							graderSha256: "",
							sandboxProfile: spec.sandboxProfile,
						},
						outDir: refDir,
					});
					const inner = createMockAdapter({
						mode: "starter",
						referenceDir: refDir,
						shouldSolve: (s) => s.controlRung === "swarm",
					});
					return inner.run(spec);
				},
			};

			const result = await runCampaign({
				task: miniCoopInterpTask,
				adapter: seedAwareAdapter,
				arms: [
					{ id: "solo-n1", controlRung: "solo", topology: "single", swarmSize: 1 },
					{ id: "silent-n2", controlRung: "silent_bon", topology: "silent_bon", swarmSize: 2 },
					{ id: "swarm-n2", controlRung: "swarm", topology: "pull-refinery", swarmSize: 2 },
				],
				seeds: [1, 2, 3, 4, 5],
				budget: { tokens: 60_000 },
				outDir,
				repoRoot: REPO_ROOT,
				promotionBar: { minSeeds: 5, minPassRateGain: 0.2, maxIntegrityFaults: 0, requireCiAboveZero: true },
			});

			expect(result.scorecards).toHaveLength(15); // 5 seeds * 3 arms
			expect(existsSync(join(outDir, "protocol.json"))).toBe(true);
			expect(existsSync(result.reportPath)).toBe(true);

			// Verify arm order interleaved across even vs odd seeds
			const seed1Solo = result.scorecards.find((s) => s.reproducibility.seed === 1 && s.reproducibility.controlRung === "solo")!;
			const seed2Solo = result.scorecards.find((s) => s.reproducibility.seed === 2 && s.reproducibility.controlRung === "solo")!;
			expect(seed1Solo.reproducibility.armOrderIndex).toBe(2); // reversed on odd seed
			expect(seed2Solo.reproducibility.armOrderIndex).toBe(0); // forward on even seed

			const summary = JSON.parse(readFileSync(result.summaryPath, "utf8")) as {
				coordinationLift: { communicationLift: { passRateGain: number; pairs: number } };
				promotion: { verdict: string };
			};
			expect(summary.coordinationLift.communicationLift.pairs).toBe(5);
			expect(summary.coordinationLift.communicationLift.passRateGain).toBe(1);
			expect(summary.promotion.verdict).toBe("PROMOTE");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
