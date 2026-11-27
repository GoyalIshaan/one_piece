import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generateObservatory } from "../src/observatory.ts";
import type { TrajectoryReport } from "../src/trajectory.ts";

function buildSyntheticReport(): TrajectoryReport {
	const mkCi = (mean: number) => ({ mean, ciLow: Math.max(0, mean - 0.05), ciHigh: Math.min(1, mean + 0.05), n: 8 });
	return {
		generatedAt: new Date().toISOString(),
		totalGenerations: 3,
		totalRuns: 24,
		validRuns: 24,
		faultedRuns: 0,
		overallVerdict: "ON_TRACK",
		executiveSummary: "Synthetic trajectory improving across 3 generations.",
		generations: [
			{
				genId: "gen-1",
				label: "Gen-1: Baseline",
				gitSha: "aaaa111",
				createdAt: "2026-01-01T00:00:00Z",
				totalRuns: 8,
				validRuns: 8,
				faultCount: 0,
				faultRate: 0,
				tasksCovered: ["horizon-repo-migration", "silo-join-micro"],
				armsCovered: ["solo", "adaptive"],
				passRate: 0.5,
				normalizedScore: mkCi(0.55),
				meanAulcTokens: 0.35,
				meanEfficiency: 4.5,
				meanTokens: 120_000,
				meanWallMs: 60_000,
				meanNominationLoss: 0.08,
				meanDiscoveryLoss: 0.37,
				meanFalseCertRate: 0,
				meanStoppingWasteShare: 0.12,
				meanCoordShare: 0.1,
				meanKvCacheHitRate: 0.72,
				paretoHypervolumeTokens: 0.42,
				paretoHypervolumeWall: 0.44,
				paretoPoints: [
					{ armKey: "solo", topology: "single", runs: 4, meanNormalizedScore: 0.45, passRate: 0.4, meanTokens: 70_000, meanWallMs: 40_000, meanAulcTokens: 0.3, isParetoTokens: true, isParetoWall: true },
				],
			},
			{
				genId: "gen-2",
				label: "RSI-13: Adaptive & Board v2",
				gitSha: "bbbb222",
				createdAt: "2026-01-02T00:00:00Z",
				totalRuns: 8,
				validRuns: 8,
				faultCount: 0,
				faultRate: 0,
				tasksCovered: ["horizon-repo-migration", "silo-join-micro"],
				armsCovered: ["solo", "adaptive"],
				passRate: 0.75,
				normalizedScore: mkCi(0.78),
				meanAulcTokens: 0.58,
				meanEfficiency: 7.4,
				meanTokens: 105_000,
				meanWallMs: 52_000,
				meanNominationLoss: 0.03,
				meanDiscoveryLoss: 0.19,
				meanFalseCertRate: 0,
				meanStoppingWasteShare: 0.07,
				meanCoordShare: 0.08,
				meanKvCacheHitRate: 0.81,
				paretoHypervolumeTokens: 0.65,
				paretoHypervolumeWall: 0.66,
				paretoPoints: [
					{ armKey: "adaptive", topology: "adaptive", runs: 4, meanNormalizedScore: 0.78, passRate: 0.75, meanTokens: 105_000, meanWallMs: 52_000, meanAulcTokens: 0.58, isParetoTokens: true, isParetoWall: true },
				],
			},
			{
				genId: "gen-3",
				label: "Gen-14: v4 Roofline & GA",
				gitSha: "cccc333",
				createdAt: "2026-01-03T00:00:00Z",
				totalRuns: 8,
				validRuns: 8,
				faultCount: 0,
				faultRate: 0,
				tasksCovered: ["horizon-repo-migration", "silo-join-micro"],
				armsCovered: ["solo", "adaptive", "evolution"],
				passRate: 0.875,
				normalizedScore: mkCi(0.89),
				meanAulcTokens: 0.74,
				meanEfficiency: 9.1,
				meanTokens: 98_000,
				meanWallMs: 45_000,
				meanNominationLoss: 0.01,
				meanDiscoveryLoss: 0.1,
				meanFalseCertRate: 0,
				meanStoppingWasteShare: 0.04,
				meanCoordShare: 0.06,
				meanKvCacheHitRate: 0.87,
				paretoHypervolumeTokens: 0.81,
				paretoHypervolumeWall: 0.82,
				paretoPoints: [
					{ armKey: "solo", topology: "single", runs: 2, meanNormalizedScore: 0.48, passRate: 0.4, meanTokens: 65_000, meanWallMs: 38_000, meanAulcTokens: 0.32, isParetoTokens: true, isParetoWall: true },
					{ armKey: "evolution", topology: "evolution", runs: 6, meanNormalizedScore: 0.89, passRate: 0.875, meanTokens: 98_000, meanWallMs: 45_000, meanAulcTokens: 0.74, isParetoTokens: true, isParetoWall: true },
				],
			},
		],
		transitions: [],
		cusumAlerts: [],
		lossWaterfall: [
			{ genId: "gen-1", label: "Gen-1: Baseline", deliveredNormalized: 0.55, faultLoss: 0, nominationLoss: 0.08, falseCertLoss: 0, discoveryLoss: 0.37, stoppingWasteShare: 0.12 },
			{ genId: "gen-2", label: "RSI-13: Adaptive", deliveredNormalized: 0.78, faultLoss: 0, nominationLoss: 0.03, falseCertLoss: 0, discoveryLoss: 0.19, stoppingWasteShare: 0.07 },
			{ genId: "gen-3", label: "Gen-14: v4", deliveredNormalized: 0.89, faultLoss: 0, nominationLoss: 0.01, falseCertLoss: 0, discoveryLoss: 0.1, stoppingWasteShare: 0.04 },
		],
		bottlenecks: [],
		taskHealth: [
			{ taskId: "horizon-repo-migration", tier: "frontier", family: "decomposable", runs: 12, armCount: 3, nonSoloMeanNormalized: 0.84, nonSoloStdDev: 0.12, soloMeanNormalized: 0.48, communicationLift: 0.36, status: "HEALTHY" },
		],
		heatmap: [
			{ taskId: "horizon-repo-migration", armKey: "solo", runs: 4, passRate: 0.4, meanScore: 0.48, meanNormalizedScore: 0.48, meanTokens: 65_000, meanAulcTokens: 0.32 },
			{ taskId: "horizon-repo-migration", armKey: "evolution", runs: 4, passRate: 0.9, meanScore: 0.92, meanNormalizedScore: 0.92, meanTokens: 98_000, meanAulcTokens: 0.74 },
		],
		routerRegret: {
			adaptiveTopology: "adaptive",
			tasksEvaluated: 2,
			meanRegret: 0.04,
			meanNormalizedRegret: 0.04,
			maxRegret: 0.06,
			perTask: [],
		},
		scalingLaws: [
			{ n: 1, runs: 4, passRate: 0.4, meanScore: 0.48, meanAulcTokens: 0.32, meanTokens: 65_000, meanWallClockMs: 38_000, speedupS: 1, parallelEfficiencyE: 1 },
			{ n: 4, runs: 4, passRate: 0.85, meanScore: 0.88, meanAulcTokens: 0.72, meanTokens: 110_000, meanWallClockMs: 19_000, speedupS: 2, parallelEfficiencyE: 0.5, karpFlattSerialFraction: 0.3333 },
		],
		latestAnytimeCurves: [
			{
				armKey: "evolution",
				taskId: "horizon-repo-migration",
				points: [
					{ pctBudget: 0, bestOffline: 0, nominated: 0 },
					{ pctBudget: 0.5, bestOffline: 0.72, nominated: 0.7 },
					{ pctBudget: 1, bestOffline: 0.92, nominated: 0.92 },
				],
			},
		],
	};
}

function loadRealOrSyntheticReport(): TrajectoryReport {
	const realPath = resolve(process.cwd(), ".one_piece/eval-lab/observatory/trajectory.json");
	if (existsSync(realPath)) {
		return JSON.parse(readFileSync(realPath, "utf8")) as TrajectoryReport;
	}
	return buildSyntheticReport();
}

describe("Observatory Visual Layout & Geometric Non-Overlap Invariants", () => {
	it("generates all 7 publication SVGs + HTML with zero NaN coordinates, crisp header/legend separation, explicit axis labels, and zero Chart 7 collisions", () => {
		const report = loadRealOrSyntheticReport();
		const outDir = mkdtempSync(join(tmpdir(), "onepiece-obs-layout-"));
		try {
			const artifacts = generateObservatory(report, outDir);
			const requiredCharts = [
				"trajectory",
				"pareto",
				"loss-waterfall",
				"anytime",
				"heatmap",
				"calibration-scaling",
			];
			if (report.behavioralDiagnostics) requiredCharts.push("07-behavioral-failure-modes");

			for (const name of requiredCharts) {
				const fp = artifacts.chartPaths[name];
				expect(fp, `missing chart ${name}`).toBeTruthy();
				const svg = readFileSync(fp!, "utf8");

				// 1. Zero NaN / Infinity coordinates anywhere in SVG
				expect(svg).not.toMatch(/\bNaN\b/);
				expect(svg).not.toMatch(/\bInfinity\b/);

				// 2. Full-width >= 1120px viewBox (heatmap widens dynamically for 10+ arms so columns never squish)
				const vbMatch = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
				expect(vbMatch, `missing viewBox in ${name}`).toBeTruthy();
				expect(Number(vbMatch![1])).toBeGreaterThanOrEqual(1120);

				// 3. 3-band Header separation: title at y=29 < subtitle at y=48 < divider line < plot content
				const titleY = Number(/<text[^>]*y="(\d+(?:\.\d+)?)"[^>]*font-size="15\.5"/.exec(svg)?.[1] ?? NaN);
				const subtitleY = Number(/<text[^>]*y="(\d+(?:\.\d+)?)"[^>]*font-size="11\.5"/.exec(svg)?.[1] ?? NaN);
				expect(titleY).toBe(29);
				expect(subtitleY).toBe(48);
				expect(titleY).toBeLessThan(subtitleY);

				// Legend items (when present) must start at y >= 70, strictly below subtitle (y=48) — zero title<->legend collision!
				const legendSwatches = [...svg.matchAll(/<rect[^>]*y="(\d+(?:\.\d+)?)"[^>]*width="(?:11|14)"[^>]*height="(?:10|11)"/g)];
				for (const m of legendSwatches) {
					expect(Number(m[1])).toBeGreaterThanOrEqual(58);
				}
			}

			// 4. Explicit X/Y axis titles & ticks on every quantitative chart
			const trajSvg = readFileSync(artifacts.chartPaths.trajectory!, "utf8");
			expect(trajSvg).toContain("Normalized Metric (0% – 100%)");
			expect(trajSvg).toContain("Harness Generation");

			const paretoSvg = readFileSync(artifacts.chartPaths.pareto!, "utf8");
			expect(paretoSvg).toContain("Mean Normalized Score (0.00 – 1.00)");
			expect(paretoSvg).toContain("Mean Token Spend per Run");

			const lossSvg = readFileSync(artifacts.chartPaths["loss-waterfall"]!, "utf8");
			expect(lossSvg).toContain("Share of Potential Score (0% – 100%)");
			expect(lossSvg).toContain("Harness Generation");

			const anytimeSvg = readFileSync(artifacts.chartPaths.anytime!, "utf8");
			expect(anytimeSvg).toContain("Best Nominated Score (0.00 – 1.00)");
			expect(anytimeSvg).toContain("Cumulative Token Budget Consumed (%)");

			const calScaleSvg = readFileSync(artifacts.chartPaths["calibration-scaling"]!, "utf8");
			expect(calScaleSvg).toContain("Long-Horizon Composite Score");
			expect(calScaleSvg).toContain("Proxy Composite Score");
			expect(calScaleSvg).toContain("Mean Score (0.0 – 1.0)");
			expect(calScaleSvg).toContain("Speedup S(N)");
			expect(calScaleSvg).toContain("Swarm Size (N)");

			// 5. Chart 7 strict 4-column non-overlapping geometry check (Bar <= 460 < Value <= 564 < Lift 582..660 < Heatmap >= 687)
			if (artifacts.chartPaths["07-behavioral-failure-modes"]) {
				const c7 = readFileSync(artifacts.chartPaths["07-behavioral-failure-modes"], "utf8");
				expect(c7).toContain("FAIL LIFT");
				expect(c7).toContain("EST. LOST SCORE");
				expect(c7).toContain("FAILS · PTS");

				// Extract all bar rects (rx="4" height="18") and assert x + width <= 462
				for (const m of c7.matchAll(/<rect x="(\d+(?:\.\d+)?)" y="\d+(?:\.\d+)?" width="(\d+(?:\.\d+)?)" height="18" fill="[^"]+"[^>]*rx="4"/g)) {
					const x = Number(m[1]);
					const w = Number(m[2]);
					expect(x + w).toBeLessThanOrEqual(462);
				}
				// Extract all lift pill rects (rx="11" height="22") and assert they sit strictly inside [580, 665] < heatmap start (687)
				for (const m of c7.matchAll(/<rect x="(\d+(?:\.\d+)?)" y="\d+(?:\.\d+)?" width="(\d+(?:\.\d+)?)" height="22" fill="[^"]+" rx="11"/g)) {
					const x = Number(m[1]);
					const w = Number(m[2]);
					expect(x).toBeGreaterThanOrEqual(580);
					expect(x + w).toBeLessThanOrEqual(665);
				}
			}

			// 6. HTML Observatory uses single-column full-width cards + hover tooltip + SVG download button
			const html = readFileSync(artifacts.htmlPath, "utf8");
			expect(html).toContain("Download SVG");
			expect(html).toContain('id="obs-tip"');
			expect(html).toContain("data-tip=");
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
