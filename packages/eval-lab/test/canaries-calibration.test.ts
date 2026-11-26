import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runTaskCalibration } from "../src/calibration.ts";
import { miniCoopInterpTask } from "../src/tasks/mini-coop-interp/index.ts";
import { miniOptPackTask } from "../src/tasks/mini-opt-pack/index.ts";
import { siloJoinMicroTask } from "../src/tasks/silo-join-micro/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("Phase 1 canary 6-check calibration gate", () => {
	it("calibrates mini-coop-interp (high coupling N=2 and N=4, plus low coupling control)", async () => {
		const highN2 = await runTaskCalibration(miniCoopInterpTask, {
			seed: 7,
			n: 2,
			repoRoot: REPO_ROOT,
			taskOptions: { coupling: "high" },
		});
		expect(highN2.passed, JSON.stringify(highN2.checks, null, 2)).toBe(true);
		expect(highN2.checks.find((c) => c.name === "semantic_interference_caught")?.passed).toBe(true);

		const highN4 = await runTaskCalibration(miniCoopInterpTask, {
			seed: 8,
			n: 4,
			repoRoot: REPO_ROOT,
			taskOptions: { coupling: "high" },
		});
		expect(highN4.passed, JSON.stringify(highN4.checks, null, 2)).toBe(true);

		const lowN4 = await runTaskCalibration(miniCoopInterpTask, {
			seed: 8,
			n: 4,
			repoRoot: REPO_ROOT,
			taskOptions: { coupling: "low" },
		});
		expect(lowN4.passed, JSON.stringify(lowN4.checks, null, 2)).toBe(true);
	});

	it("calibrates silo-join-micro (prefix N=4 with isolated shards + two-level-join)", async () => {
		const prefix = await runTaskCalibration(siloJoinMicroTask, {
			seed: 13,
			n: 4,
			repoRoot: REPO_ROOT,
			taskOptions: { mode: "prefix" },
		});
		expect(prefix.passed, JSON.stringify(prefix.checks, null, 2)).toBe(true);

		const twoLevel = await runTaskCalibration(siloJoinMicroTask, {
			seed: 13,
			n: 4,
			repoRoot: REPO_ROOT,
			taskOptions: { mode: "two-level-join" },
		});
		expect(twoLevel.passed, JSON.stringify(twoLevel.checks, null, 2)).toBe(true);
	});

	it("calibrates mini-opt-pack (strict double-precision 26-circle packing from 2.6219 incumbent)", async () => {
		const pack = await runTaskCalibration(miniOptPackTask, {
			seed: 21,
			n: 4,
			repoRoot: REPO_ROOT,
		});
		expect(pack.passed, JSON.stringify(pack.checks, null, 2)).toBe(true);
	});
});
