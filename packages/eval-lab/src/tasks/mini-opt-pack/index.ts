import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalTask, GradeReport, PreparedTask } from "../../contracts.ts";
import { sha256Dir } from "../../sandbox.ts";

/**
 * Verified feasible 26-circle unit-square starting incumbent (from `notes/circle-packing-26-calibration.json`,
 * SciPy SLSQP perturbed-grid seed 2 with strict interior radii shrink, sum_radii = 2.621898867255).
 * Embedded locally so `@one-piece/eval-lab` never depends on git-ignored `notes/`.
 */
const INCUMBENT_CIRCLES: readonly [number, number, number][] = [
	[0.22008023785575304, 0.09023468869966808, 0.09023468849906498],
	[0.09312251341759128, 0.22252830054700623, 0.09312251331733665],
	[0.11016505883004987, 0.42510023511889306, 0.11016505873021822],
	[0.1110926751425052, 0.6463560245834035, 0.11109267504414516],
	[0.12138972466553859, 0.8786102753361602, 0.12138972456439936],
	[0.4070761628289893, 0.09687925037181375, 0.09687925027173734],
	[0.29896367485363295, 0.2883161214600396, 0.12297612396397598],
	[0.2938154899389142, 0.5340628964962634, 0.10337730787083244],
	[0.3061168953953649, 0.7441638118822043, 0.10708342276084154],
	[0.3114774341864036, 0.9255840281968377, 0.0744159717030937],
	[0.5884449906101723, 0.08488569937384641, 0.08488569927390067],
	[0.5216036326627292, 0.25896977535301063, 0.10158958746981449],
	[0.4497684532061249, 0.4301306795779847, 0.08403462449605123],
	[0.49216306652306707, 0.6239859795427374, 0.11440221805688057],
	[0.5090183465594167, 0.8689044464676774, 0.13109555343262402],
	[0.7305412396604598, 0.059466270947822523, 0.05946627084634451],
	[0.715354256139463, 0.21523066041729544, 0.09703673050570145],
	[0.6712369900427563, 0.44609875874914423, 0.13800882231431452],
	[0.7245747910439031, 0.7134868419888902, 0.13464720268450303],
	[0.7089433730981741, 0.9237769413996801, 0.07622305850066051],
	[0.8913224445281014, 0.10867755547216855, 0.10867755537236422],
	[0.8896151635145516, 0.3277332944123344, 0.1103848363855324],
	[0.8944331496409541, 0.5436312287731901, 0.10556685025929878],
	[0.9296030205009953, 0.7160445391743581, 0.07039697939898704],
	[0.8911324661833144, 0.8911324661844332, 0.10886753371608271],
	[0.06587860791695177, 0.06587860791571774, 0.06587860781629115],
];

const INCUMBENT_SUM = INCUMBENT_CIRCLES.reduce((s, c) => s + c[2], 0);
const REFERENCE_TARGET_SUM = 2.635977;

interface PackingCheck {
	valid: boolean;
	radiusSum: number;
	worstWallSlack: number;
	worstPairSlack: number;
	basinSignature: string;
	reason: string;
}

/**
 * Independent strict double-precision geometric verifier (zero overlap slack tolerance).
 * Computes a permutation- & rotation-invariant basin descriptor from quantized sorted radii.
 */
export function verifyPacking(circles: unknown, expectedCount = 26): PackingCheck {
	if (!Array.isArray(circles) || circles.length !== expectedCount) {
		return {
			valid: false,
			radiusSum: 0,
			worstWallSlack: -1,
			worstPairSlack: -1,
			basinSignature: "invalid",
			reason: `Expected ${expectedCount} circles, got ${Array.isArray(circles) ? circles.length : typeof circles}.`,
		};
	}
	const pts: Array<[number, number, number]> = [];
	let worstWallSlack = Number.POSITIVE_INFINITY;
	let radiusSum = 0;

	for (let i = 0; i < circles.length; i++) {
		const row = circles[i];
		if (!Array.isArray(row) || row.length !== 3) {
			return { valid: false, radiusSum: 0, worstWallSlack: -1, worstPairSlack: -1, basinSignature: "invalid", reason: `Circle ${i} is not [x, y, r]` };
		}
		const x = Number(row[0]);
		const y = Number(row[1]);
		const r = Number(row[2]);
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r) || r < 0) {
			return { valid: false, radiusSum: 0, worstWallSlack: -1, worstPairSlack: -1, basinSignature: "invalid", reason: `Circle ${i} has non-finite or negative radius` };
		}
		const wallSlack = Math.min(x - r, 1 - x - r, y - r, 1 - y - r);
		if (wallSlack < worstWallSlack) worstWallSlack = wallSlack;
		pts.push([x, y, r]);
		radiusSum += r;
	}

	let worstPairSlack = Number.POSITIVE_INFINITY;
	for (let i = 0; i < pts.length; i++) {
		const [xi, yi, ri] = pts[i]!;
		for (let j = i + 1; j < pts.length; j++) {
			const [xj, yj, rj] = pts[j]!;
			const dist = Math.hypot(xi - xj, yi - yj);
			const slack = dist - (ri + rj);
			if (slack < worstPairSlack) worstPairSlack = slack;
		}
	}

	const valid = worstWallSlack >= 0 && worstPairSlack >= 0;
	// Permutation & symmetry-invariant quantized sorted radii signature for basin tracking.
	const sortedQ = pts
		.map(([, , r]) => Math.round(r * 200))
		.sort((a, b) => a - b)
		.join(",");
	const basinSignature = createHash("sha256").update(sortedQ).digest("hex").slice(0, 12);

	return {
		valid,
		radiusSum,
		worstWallSlack,
		worstPairSlack,
		basinSignature,
		reason: valid
			? `Feasible (sum=${radiusSum.toFixed(6)}, minWallSlack=${worstWallSlack.toExponential(2)}, minPairSlack=${worstPairSlack.toExponential(2)})`
			: `Infeasible (worstWallSlack=${worstWallSlack.toExponential(2)}, worstPairSlack=${worstPairSlack.toExponential(2)})`,
	};
}

/**
 * Verified strictly feasible 26-circle reference witness (sum_radii = 2.627099458,
 * minWallSlack = 1.00e-8, minPairSlack = 2.00e-8) beating the 2.621899 incumbent by +0.005201.
 * Used exclusively by the zero-cost calibration gate (never exposed to agents).
 */
const REFERENCE_CIRCLES: readonly [number, number, number][] = [
	[0.21970899189885382, 0.09019731891770089, 0.09019730891769337],
	[0.09271808136544651, 0.22184591291943698, 0.0927180713654433],
	[0.10826506568680246, 0.42222684184615594, 0.10826505568679876],
	[0.11166988792604374, 0.6421354387818002, 0.11166987792603893],
	[0.12323988729998853, 0.8767601127000165, 0.12323987729998206],
	[0.406557119827068, 0.09676624352364681, 0.09676623352364314],
	[0.29860716713670765, 0.28925333907771583, 0.12392464851061695],
	[0.29438521119854655, 0.526000128657267, 0.10483021666121929],
	[0.309512385048998, 0.7388324897107577, 0.10853903315126018],
	[0.3173024767692272, 0.9236036938677255, 0.07639629613227436],
	[0.5875957901774846, 0.08467570655009148, 0.08467569655007998],
	[0.5210118379163906, 0.2576898922571037, 0.10070856313558685],
	[0.45171389389963823, 0.42619187303270784, 0.08148670376901046],
	[0.4916360444056801, 0.6151299573997725, 0.11162303213505075],
	[0.5223396348370409, 0.862427130587499, 0.13757285941249753],
	[0.7295418981525787, 0.05948783420353764, 0.05948782420354136],
	[0.7139134936489898, 0.2150435052082323, 0.09685093476395441],
	[0.6676673235269132, 0.44230367603750764, 0.13506690460937354],
	[0.7053849292991098, 0.6890518082158835, 0.11454729477466111],
	[0.7587265970462443, 0.8984560034599822, 0.1015439865400183],
	[0.8907645105391624, 0.10923548946084229, 0.10923547946083673],
	[0.8879871559905612, 0.3304663900264773, 0.11201283400942859],
	[0.8878764259191131, 0.5546027807648091, 0.11212356408088581],
	[0.9033121196489053, 0.7628429374615471, 0.09668787035109368],
	[0.9287929893246282, 0.9287929893246281, 0.07120700067537637],
	[0.06572230040303825, 0.06572230040303217, 0.06572229040303425],
];

function deterministicRelaxedReference(): Array<[number, number, number]> {
	return REFERENCE_CIRCLES.map(([x, y, r]) => [x, y, r]);
}

export const miniOptPackTask: EvalTask = {
	id: "mini-opt-pack",
	title: "Circle Packing n=26 (Continuous Exact-Oracle Canary)",
	family: "scalar-optimization",
	tier: "proxy",
	supportedN: [1, 2, 4, 8],
	defaultOptions: {},
	higherIsBetter: true,

	async prepare({ seed, n, options, workDir, hiddenDir }): Promise<PreparedTask> {
		mkdirSync(workDir, { recursive: true });
		mkdirSync(hiddenDir, { recursive: true });
		writeFileSync(
			join(workDir, "circles.json"),
			JSON.stringify(
				{
					count: 26,
					square_side: 1,
					columns: ["x", "y", "radius"],
					circles: INCUMBENT_CIRCLES,
					sum_radii: INCUMBENT_SUM,
				},
				null,
				2,
			) + "\n",
		);
		writeFileSync(
			join(workDir, "TASK.md"),
			[
				"# Circle Packing Optimization (n = 26, Unit Square)",
				"",
				`Place 26 non-overlapping circles inside [0, 1] x [0, 1] maximizing sum(radius).`,
				`The starting incumbent in \`circles.json\` is already strictly feasible with sum = **${INCUMBENT_SUM.toFixed(9)}**.`,
				"Deliver an improved strictly feasible `circles.json` (zero wall or pairwise overlap tolerance).",
			].join("\n") + "\n",
		);
		writeFileSync(join(hiddenDir, "incumbent.json"), JSON.stringify({ incumbentSum: INCUMBENT_SUM, targetSum: REFERENCE_TARGET_SUM }));

		return {
			taskId: "mini-opt-pack",
			seed,
			n,
			options,
			workspaceDir: workDir,
			hiddenDir,
			goal: `Beat the strictly feasible 26-circle packing incumbent (${INCUMBENT_SUM.toFixed(6)}) in circles.json while preserving zero overlap and wall bounds.`,
			rubric: "Only strictly feasible packings (zero overlap/wall slack tolerance) earn credit. Higher sum of radii is better.",
			fixtureSha256: sha256Dir(workDir),
			graderSha256: sha256Dir(hiddenDir),
			incumbentScore: INCUMBENT_SUM,
			theoreticalCeiling: 2.636,
			sandboxProfile: "eval-offline",
		};
	},

	async publicCheck({ artifactDir }): Promise<{ passed: boolean; score: number; details: string }> {
		const path = join(artifactDir, "circles.json");
		if (!existsSync(path)) return { passed: false, score: 0, details: "Missing circles.json" };
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as { circles?: unknown };
			const check = verifyPacking(parsed.circles, 26);
			return { passed: check.valid, score: check.valid ? check.radiusSum : 0, details: check.reason };
		} catch (error) {
			return { passed: false, score: 0, details: `Invalid circles.json: ${String(error)}` };
		}
	},

	async grade({ artifactDir }): Promise<GradeReport> {
		const path = join(artifactDir, "circles.json");
		if (!existsSync(path)) {
			return {
				passed: false,
				score: 0,
				customMetrics: { missingFile: true, radiusSum: 0, gainOverIncumbent: -INCUMBENT_SUM },
				details: "Missing circles.json",
			};
		}
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as { circles?: unknown };
			const check = verifyPacking(parsed.circles, 26);
			const gain = check.valid ? check.radiusSum - INCUMBENT_SUM : 0;
			const passed = check.valid && gain > 1e-6;
			return {
				passed,
				score: check.valid ? check.radiusSum : 0,
				customMetrics: {
					feasible: check.valid,
					radiusSum: Math.round(check.radiusSum * 1e9) / 1e9,
					gainOverIncumbent: Math.round(gain * 1e9) / 1e9,
					normalizedTo2636: check.valid ? Math.round((check.radiusSum / REFERENCE_TARGET_SUM) * 1e6) / 1e6 : 0,
					basinSignature: check.basinSignature,
				},
				details: check.reason,
			};
		} catch (error) {
			return {
				passed: false,
				score: 0,
				customMetrics: { parseError: true },
				details: `Invalid circles.json: ${String(error)}`,
			};
		}
	},

	async buildReferenceArtifact({ outDir }): Promise<void> {
		const improved = deterministicRelaxedReference();
		const sum = improved.reduce((s, c) => s + c[2], 0);
		writeFileSync(
			join(outDir, "circles.json"),
			JSON.stringify(
				{
					count: 26,
					square_side: 1,
					columns: ["x", "y", "radius"],
					circles: improved,
					sum_radii: sum,
				},
				null,
				2,
			) + "\n",
		);
	},
};
