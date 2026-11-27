import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EvalTask, GradeReport, PreparedTask, PublicCheckResult } from "../../contracts.ts";
import { assertDockerDaemon, ensureDockerImage, runDockerContainer } from "../../docker-runner.ts";
import { sha256Dir, sha256Text } from "../../sandbox.ts";

export type MleMetricKind = "accuracy" | "roc_auc" | "log_loss" | "rmse" | "rmsle";
export type MleMedalTier = "gold" | "silver" | "bronze" | "above_median" | "valid_submission" | "invalid";

export interface MleCompetitionSpec {
	readonly slug: string;
	readonly title: string;
	readonly metric: MleMetricKind;
	readonly higherIsBetter: boolean;
	/** Official MLE-bench leaderboard thresholds (raw competition metric). */
	readonly thresholds: {
		readonly median: number;
		readonly bronze: number;
		readonly silver: number;
		readonly gold: number;
	};
	readonly targetColumn?: string;
	/** Absent for row-order aligned competitions with no unique ID column (e.g. detecting-insults). */
	readonly idColumn?: string;
}

/**
 * Curated 8-competition MLE-bench Lite slice spanning tabular classification, regression,
 * multiclass probability calibration, and NLP — ideal for unbounded scientific discovery & evolution.
 */
export const MLE_BENCH_LITE_SLICE: readonly MleCompetitionSpec[] = [
	{
		slug: "spaceship-titanic",
		title: "Spaceship Titanic (Tabular Binary Classification)",
		metric: "accuracy",
		higherIsBetter: true,
		thresholds: { median: 0.7933, bronze: 0.8069, silver: 0.8104, gold: 0.8153 },
		idColumn: "PassengerId",
		targetColumn: "Transported",
	},
	{
		slug: "spooky-author-identification",
		title: "Spooky Author Identification (NLP Multi-Class Log-Loss)",
		metric: "log_loss",
		higherIsBetter: false,
		thresholds: { median: 0.3712, bronze: 0.3052, silver: 0.2896, gold: 0.2689 },
		idColumn: "id",
	},
	{
		slug: "nomad2018-predict-transparent-conductors",
		title: "NOMAD2018 Transparent Conductors (Materials Science RMSLE)",
		metric: "rmsle",
		higherIsBetter: false,
		thresholds: { median: 0.0681, bronze: 0.0566, silver: 0.0543, gold: 0.0512 },
		idColumn: "id",
	},
	{
		slug: "leaf-classification",
		title: "Leaf Classification (99-Class Botanical Log-Loss)",
		metric: "log_loss",
		higherIsBetter: false,
		thresholds: { median: 0.0672, bronze: 0.0315, silver: 0.0241, gold: 0.0158 },
		idColumn: "id",
	},
	{
		slug: "random-acts-of-pizza",
		title: "Random Acts of Pizza (NLP + Metadata ROC-AUC)",
		metric: "roc_auc",
		higherIsBetter: true,
		thresholds: { median: 0.6512, bronze: 0.6914, silver: 0.7082, gold: 0.7289 },
		idColumn: "request_id",
		targetColumn: "requester_received_pizza",
	},
	{
		slug: "detecting-insults-in-social-commentary",
		title: "Detecting Insults in Social Commentary (NLP ROC-AUC)",
		metric: "roc_auc",
		higherIsBetter: true,
		thresholds: { median: 0.7851, bronze: 0.8245, silver: 0.8364, gold: 0.8492 },
		targetColumn: "Insult",
	},
	{
		slug: "tabular-playground-series-dec-2021",
		title: "Tabular Playground Dec 2021 (Large-Scale Multiclass Accuracy)",
		metric: "accuracy",
		higherIsBetter: true,
		thresholds: { median: 0.9562, bronze: 0.9617, silver: 0.9621, gold: 0.9626 },
		idColumn: "Id",
		targetColumn: "Cover_Type",
	},
	{
		slug: "new-york-city-taxi-fare-prediction",
		title: "NYC Taxi Fare Prediction (Geospatial Regression RMSE)",
		metric: "rmse",
		higherIsBetter: false,
		thresholds: { median: 3.412, bronze: 3.048, silver: 2.952, gold: 2.845 },
		idColumn: "key",
		targetColumn: "fare_amount",
	},
];

export const DEFAULT_MLEBENCH_IMAGE = "mlebench-env:latest";

export type MleMedalAssessment =
	| { readonly medal: "invalid"; readonly normalizedScore: 0 }
	| { readonly medal: "gold"; readonly normalizedScore: 1 }
	| { readonly medal: "valid_submission" | "above_median" | "bronze" | "silver"; readonly normalizedScore: number };

export type SubmissionValidationResult =
	| { readonly valid: true; readonly rowCount: number; readonly reason: string }
	| { readonly valid: false; readonly rowCount: number; readonly reason: string };

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * RFC-4180 single-line CSV field splitter (handles quoted fields containing commas and escaped `""`).
 */
export function parseCsvLine(line: string): string[] {
	const fields: string[] = [];
	let cur = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (inQuotes) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					cur += '"';
					i += 1;
				} else {
					inQuotes = false;
				}
			} else {
				cur += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			fields.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	fields.push(cur);
	return fields;
}

/**
 * Map a raw MLE-bench metric value onto official Kaggle medal tier + continuous normalized [0, 1] score:
 * - invalid:          0 (compile-time exact)
 * - valid_submission: 0.20..0.50
 * - above_median:     0.50..0.70
 * - bronze:           0.70..0.85
 * - silver:           0.85..1.00
 * - gold:             1 (compile-time exact)
 */
export function evaluateMleMedalScore(
	rawMetric: number,
	spec: Pick<MleCompetitionSpec, "higherIsBetter" | "thresholds">,
): MleMedalAssessment {
	if (!Number.isFinite(rawMetric)) return { medal: "invalid", normalizedScore: 0 };
	const { median, bronze, silver, gold } = spec.thresholds;
	const hi = spec.higherIsBetter;
	const ge = (a: number, b: number) => (hi ? a >= b : a <= b);
	const interp = (val: number, low: number, high: number, outLow: number, outHigh: number): number => {
		const denom = high - low;
		if (Math.abs(denom) < 1e-12) return outHigh;
		const frac = Math.max(0, Math.min(1, (val - low) / denom));
		return Math.round((outLow + frac * (outHigh - outLow)) * 10_000) / 10_000;
	};

	if (ge(rawMetric, gold)) return { medal: "gold", normalizedScore: 1.0 };
	if (ge(rawMetric, silver)) return { medal: "silver", normalizedScore: interp(rawMetric, silver, gold, 0.85, 1.0) };
	if (ge(rawMetric, bronze)) return { medal: "bronze", normalizedScore: interp(rawMetric, bronze, silver, 0.7, 0.85) };
	if (ge(rawMetric, median)) return { medal: "above_median", normalizedScore: interp(rawMetric, median, bronze, 0.5, 0.7) };

	// Valid submission below median: give partial credit in [0.20, 0.50) based on distance to median
	const worstRef = hi ? Math.min(0, median - Math.abs(gold - median) * 3) : median + Math.abs(median - gold) * 3;
	return { medal: "valid_submission", normalizedScore: interp(rawMetric, worstRef, median, 0.2, 0.5) };
}

/**
 * Validate a CSV submission against `sample_submission.csv` (exact headers, row count, ID alignment
 * when the competition has an ID column, and zero empty/NaN/Inf predictions).
 */
export function validateSubmissionCsv(
	submissionText: string,
	sampleText: string,
	opts: { checkIdColumn?: boolean } = {},
): SubmissionValidationResult {
	const subLines = submissionText.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
	const sampLines = sampleText.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
	if (subLines.length < 2) return { valid: false, rowCount: 0, reason: "Submission CSV is empty or missing rows." };
	const subHeader = parseCsvLine(subLines[0]!).map((h) => h.trim());
	const sampHeader = parseCsvLine(sampLines[0]!).map((h) => h.trim());
	if (subHeader.length !== sampHeader.length || subHeader.some((h, idx) => h !== sampHeader[idx])) {
		return { valid: false, rowCount: subLines.length - 1, reason: `Header mismatch: got "${subLines[0]}", expected "${sampLines[0]}".` };
	}
	if (subLines.length !== sampLines.length) {
		return { valid: false, rowCount: subLines.length - 1, reason: `Row count mismatch: got ${subLines.length - 1}, expected ${sampLines.length - 1}.` };
	}
	const expectedCols = sampHeader.length;
	const checkId = opts.checkIdColumn !== false;
	const startPredCol = checkId ? 1 : 0;
	for (let i = 1; i < subLines.length; i++) {
		const subCols = parseCsvLine(subLines[i]!);
		const sampCols = parseCsvLine(sampLines[i]!);
		if (subCols.length !== expectedCols) {
			return { valid: false, rowCount: subLines.length - 1, reason: `Row ${i} has ${subCols.length} columns (expected ${expectedCols}).` };
		}
		if (checkId && subCols[0]!.trim() !== sampCols[0]!.trim()) {
			return { valid: false, rowCount: subLines.length - 1, reason: `ID mismatch at row ${i}: got "${subCols[0]}", expected "${sampCols[0]}".` };
		}
		for (let c = startPredCol; c < subCols.length; c++) {
			const cell = subCols[c]!.trim();
			if (!cell || /^nan$/i.test(cell) || /^inf$/i.test(cell) || /^-inf$/i.test(cell)) {
				return { valid: false, rowCount: subLines.length - 1, reason: `Invalid/NaN prediction at row ${i}, col ${c}: "${cell}".` };
			}
		}
	}
	return { valid: true, rowCount: subLines.length - 1, reason: "Valid submission CSV matching schema and alignment." };
}

/**
 * Self-contained offline MLE-bench Python scorer executed strictly inside the Docker container.
 * Handles all 4 competition table shapes accurately:
 * 1. Single-target ID-aligned classification/regression (spaceship-titanic, random-acts-of-pizza, nyc-taxi, tps-dec-2021)
 * 2. Multi-class probability columns vs single label column in private CSV (spooky-author, leaf-classification)
 * 3. Multi-target continuous regression (nomad2018-predict-transparent-conductors)
 * 4. Row-aligned competitions with NO unique ID column (detecting-insults-in-social-commentary)
 */
export const DOCKER_MLE_SCORER_PY = `
import json, sys
import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, log_loss, mean_squared_error, roc_auc_score

metric = sys.argv[1]
sub_path = sys.argv[2]
priv_path = sys.argv[3]
id_col_arg = sys.argv[4] if len(sys.argv) > 4 else ""
target_col_arg = sys.argv[5] if len(sys.argv) > 5 else ""

sub = pd.read_csv(sub_path)
priv = pd.read_csv(priv_path)

def norm_label(series):
    vals = series.astype(str).str.strip().str.lower()
    mapping = {"true": "1", "false": "0", "1.0": "1", "0.0": "0"}
    return vals.map(lambda v: mapping.get(v, v))

id_col = id_col_arg.strip() if id_col_arg.strip() else None
if id_col and id_col in sub.columns and id_col in priv.columns:
    merged = priv.merge(sub, on=id_col, suffixes=("_true", "_pred"))
    if len(merged) != len(priv):
        print(json.dumps({"ok": False, "error": f"Aligned rows {len(merged)} != private rows {len(priv)}"}))
        sys.exit(0)
    pred_cols = [c for c in sub.columns if c != id_col]
else:
    if len(sub) != len(priv):
        print(json.dumps({"ok": False, "error": f"Row count {len(sub)} != private rows {len(priv)}"}))
        sys.exit(0)
    # Row-aligned competition (e.g., detecting-insults-in-social-commentary with no unique ID column)
    merged = pd.concat(
        [priv.reset_index(drop=True).add_suffix("_true"), sub.reset_index(drop=True).add_suffix("_pred")],
        axis=1,
    )
    if target_col_arg.strip() and target_col_arg.strip() in sub.columns:
        pred_cols = [target_col_arg.strip()]
    else:
        pred_cols = [sub.columns[0]] if len(sub.columns) == 1 else list(sub.columns)

def get_pred_col(col):
    if f"{col}_pred" in merged.columns:
        return merged[f"{col}_pred"]
    if col in merged.columns:
        return merged[col]
    raise KeyError(f"Missing prediction column {col}")

def get_true_col(col):
    if f"{col}_true" in merged.columns:
        return merged[f"{col}_true"]
    if col in merged.columns:
        return merged[col]
    raise KeyError(f"Missing ground-truth column {col}")

if len(pred_cols) == 1:
    col = pred_cols[0]
    true_name = target_col_arg.strip() if (target_col_arg.strip() and (f"{target_col_arg.strip()}_true" in merged.columns or target_col_arg.strip() in merged.columns)) else col
    y_true = get_true_col(true_name)
    y_pred = get_pred_col(col)
    if metric == "accuracy":
        val = float(accuracy_score(norm_label(y_true), norm_label(y_pred)))
    elif metric == "roc_auc":
        val = float(roc_auc_score(y_true.astype(float), y_pred.astype(float)))
    elif metric == "rmse":
        val = float(np.sqrt(mean_squared_error(y_true.astype(float), y_pred.astype(float))))
    elif metric == "rmsle":
        val = float(np.sqrt(mean_squared_error(np.log1p(np.maximum(0, y_true.astype(float))), np.log1p(np.maximum(0, y_pred.astype(float))))))
    elif metric == "log_loss":
        val = float(log_loss(y_true.astype(float), np.clip(y_pred.astype(float), 1e-15, 1 - 1e-15)))
    else:
        raise ValueError(f"Unsupported metric: {metric}")
else:
    if metric == "rmsle":
        scores = []
        for col in pred_cols:
            yt = np.log1p(np.maximum(0, get_true_col(col).astype(float)))
            yp = np.log1p(np.maximum(0, get_pred_col(col).astype(float)))
            scores.append(float(np.sqrt(mean_squared_error(yt, yp))))
        val = float(np.mean(scores))
    elif metric == "log_loss":
        probs = np.column_stack([get_pred_col(c).to_numpy(dtype=float) for c in pred_cols])
        probs = np.clip(probs, 1e-15, 1.0 - 1e-15)
        row_sums = probs.sum(axis=1, keepdims=True)
        row_sums = np.where(row_sums > 0, row_sums, 1.0)
        probs = probs / row_sums
        if all((f"{c}_true" in merged.columns) for c in pred_cols):
            y_true = np.column_stack([merged[f"{c}_true"].to_numpy(dtype=float) for c in pred_cols])
            val = float(log_loss(y_true, probs))
        else:
            # Ground-truth CSV holds a single class label column (e.g. 'author' or 'species')
            priv_label_cols = [c for c in priv.columns if c != id_col]
            if not priv_label_cols:
                raise ValueError("Could not locate private class label column")
            label_col = priv_label_cols[0]
            y_true = get_true_col(label_col).astype(str)
            val = float(log_loss(y_true, probs, labels=pred_cols))
    else:
        raise ValueError(f"Unsupported multi-column metric: {metric}")

print(json.dumps({"ok": True, "rawMetric": val}))
`.trim();

function selectCompetition(options: Record<string, string>, seed: number): MleCompetitionSpec {
	const slug = options.competition;
	if (slug) {
		const found = MLE_BENCH_LITE_SLICE.find((c) => c.slug === slug);
		if (!found) {
			throw new Error(`Unknown MLE-bench competition "${slug}". Available: ${MLE_BENCH_LITE_SLICE.map((c) => c.slug).join(", ")}`);
		}
		return found;
	}
	return MLE_BENCH_LITE_SLICE[Math.abs(seed - 1) % MLE_BENCH_LITE_SLICE.length]!;
}

function findSampleSubmissionName(publicDir: string): string | undefined {
	const preferred = ["sample_submission.csv", "sampleSubmission.csv", "sample_submission_null.csv"];
	for (const name of preferred) {
		if (existsSync(join(publicDir, name))) return name;
	}
	try {
		const files = readdirSync(publicDir).sort();
		return files.find((f) => /sample.*sub.*\.csv$/i.test(f));
	} catch {
		return undefined;
	}
}

function findPrivateLabelsName(privateDir: string): string | undefined {
	const preferred = ["test.csv", "answers.csv", "solution.csv", "private_test.csv", "submission.csv"];
	for (const name of preferred) {
		if (existsSync(join(privateDir, name))) return name;
	}
	try {
		const files = readdirSync(privateDir).sort();
		return files.find((f) => f.endsWith(".csv"));
	} catch {
		return undefined;
	}
}

function buildMleBenchExecHelperScript(opts: { image: string; publicSrc: string }): string {
	return [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		"# Offline MLE-bench container runner: mounts your current worktree at /workspace (:rw)",
		"# and the canonical public dataset directly at /workspace/data (:ro) with ZERO data copies.",
		'if [ "$#" -eq 0 ]; then',
		'  echo "Usage: ./.eval-exec <command...>" >&2',
		'  echo "Example: ./.eval-exec python3 train.py" >&2',
		"  exit 2",
		"fi",
		"exec docker run --rm --network=none \\",
		"  --memory 8g --cpus 4 --pids-limit 512 \\",
		'  -v "$PWD:/workspace" \\',
		`  -v ${shellQuote(opts.publicSrc)}:/workspace/data:ro \\`,
		"  -w /workspace \\",
		`  ${shellQuote(opts.image)} \\`,
		'  "$@"',
		"",
	].join("\n");
}

/**
 * Strict Docker-Only Port of OpenAI MLE-bench Lite (`mle-bench-lite`).
 * - Zero-copy read-only symlink to `prepared/public` (never copies gigabytes of CSVs into git or worktrees!).
 * - Kernel-seals BOTH `hiddenDir` AND canonical `prepared/private` via `extraDeniedReadPaths`.
 * - Provides offline `./.eval-exec` helper mounting worktree + `:ro` data directly inside `mlebench-env`.
 * - Grades continuous metric progress against official Kaggle Median / Bronze / Silver / Gold medal thresholds.
 */
export const mleBenchLiteTask: EvalTask = {
	id: "mle-bench-lite",
	title: "MLE-bench Lite (Strict Docker Official ML Discovery Port)",
	family: "scalar-optimization",
	tier: "long-horizon",
	supportedN: [1, 2, 4, 8],
	defaultOptions: { image: DEFAULT_MLEBENCH_IMAGE, passBar: "above_median" },
	higherIsBetter: true,
	requiresDocker: true,

	async prepare({ seed, n, options, workDir, hiddenDir }): Promise<PreparedTask> {
		assertDockerDaemon();
		const spec = selectCompetition(options, seed);
		const dataRoot = options.dataRoot ?? process.env.MLE_BENCH_DATA_DIR;
		if (!dataRoot || !existsSync(resolve(dataRoot, spec.slug, "prepared"))) {
			throw new Error(
				`MLE-bench Lite requires prepared competition data at \`<dataRoot>/${spec.slug}/prepared/{public,private}\`. ` +
					`Pass \`--opt dataRoot=/path/to/mlebench-data\` (or set \`MLE_BENCH_DATA_DIR\`) after running \`mlebench prepare -c ${spec.slug}\`.`,
			);
		}
		const image = options.image ?? DEFAULT_MLEBENCH_IMAGE;
		ensureDockerImage(image, { pullIfMissing: options.pull === "true" });

		const compRoot = resolve(dataRoot, spec.slug, "prepared");
		const publicSrc = join(compRoot, "public");
		const privateSrc = join(compRoot, "private");
		if (!existsSync(publicSrc) || !existsSync(privateSrc)) {
			throw new Error(`Missing public/ or private/ directory under ${compRoot}`);
		}
		const sampleSubmissionFile = findSampleSubmissionName(publicSrc) ?? "sample_submission.csv";
		const privateLabelsFile = findPrivateLabelsName(privateSrc);
		if (!privateLabelsFile) {
			throw new Error(`No ground-truth CSV found inside ${privateSrc}`);
		}

		mkdirSync(join(workDir, "submission"), { recursive: true });
		mkdirSync(hiddenDir, { recursive: true });

		// Zero-copy read-only symlink to public competition data (never copies multi-GB CSVs into workDir or git!)
		const dataLink = join(workDir, "data");
		if (!existsSync(dataLink)) {
			symlinkSync(publicSrc, dataLink);
		}

		writeFileSync(
			join(workDir, ".gitignore"),
			[
				"# Read-only symlinked dataset & harness helpers (never committed to git or duplicated across worktrees)",
				"data",
				"data/",
				".eval-exec",
				".eval-tmp/",
				".swarm/",
				".one_piece/",
				".gemini/",
				".grok/",
				".onepiece-eval.patch",
				".onepiece-snapshot.json",
				"__pycache__/",
				"*.pyc",
				"*.parquet",
				"*.pkl",
				"*.joblib",
				"*.pt",
				"*.pth",
				"*.bin",
				"catboost_info/",
				"lightning_logs/",
				"# Keep submission/submission.csv tracked!",
				"!submission/",
				"!submission/submission.csv",
			].join("\n") + "\n",
			"utf8",
		);
		writeFileSync(join(workDir, "submission", ".gitkeep"), "", "utf8");

		const specMd =
			[
				`# MLE-bench Lite: ${spec.title}`,
				"",
				`- **Competition:** \`${spec.slug}\``,
				`- **Official Evaluation Metric:** \`${spec.metric}\` (${spec.higherIsBetter ? "higher is better" : "lower is better"})`,
				`- **Data Directory:** \`./data/\` (read-only public training & test sets + \`${sampleSubmissionFile}\`)`,
				`- **ML Container Runtime:** Run Python training inside the official offline container (\`${image}\`) using \`./.eval-exec python3 <script.py>\` (mounts \`$PWD\` at \`/workspace\` and \`./data\` read-only at \`/workspace/data\`).`,
				`- **Required Deliverable:** \`./submission/submission.csv\` matching \`data/${sampleSubmissionFile}\` schema, row count, and alignment with zero NaN/Inf values.`,
				"",
				"## Scientific Research Guidelines",
				"1. Perform exploratory data analysis and build a clean leak-free cross-validation split.",
				"2. Iterate systematically on feature engineering, model families, hyperparameter tuning, and ensembling using `./.eval-exec python3 ...`.",
				"3. Save your best reproducible training script and final predictions to `submission/submission.csv` and commit.",
			].join("\n") + "\n";
		writeFileSync(join(workDir, "SPEC.md"), specMd, "utf8");

		// Initialize a lightweight git repo right in workDir (excluding data/) so GitWorktreeManager
		// creates instant linked worktrees with `data` symlink mirrored and 0 bytes of data in `.git`!
		if (!existsSync(join(workDir, ".git"))) {
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workDir, stdio: "ignore" });
			execFileSync("git", ["config", "user.name", "EvalBase"], { cwd: workDir, stdio: "ignore" });
			execFileSync("git", ["config", "user.email", "eval-base@onepiece.dev"], { cwd: workDir, stdio: "ignore" });
			execFileSync("git", ["add", ".gitignore", "SPEC.md", "submission/.gitkeep"], { cwd: workDir, stdio: "ignore" });
			execFileSync("git", ["commit", "-q", "-m", `MLE-bench base (${spec.slug})`], { cwd: workDir, stdio: "ignore" });
		}

		// Write offline container execution helper AFTER initial commit (gitignored & mirrored to worktrees)
		const execHelperPath = join(workDir, ".eval-exec");
		writeFileSync(execHelperPath, buildMleBenchExecHelperScript({ image, publicSrc }), {
			encoding: "utf8",
			mode: 0o755,
		});
		try {
			chmodSync(execHelperPath, 0o755);
		} catch {
			// Ignore chmod errors.
		}

		// Never copy multi-GB private split: store canonical path in hiddenDir and kernel-deny privateSrc!
		writeFileSync(
			join(hiddenDir, "competition.json"),
			JSON.stringify(
				{
					spec,
					image,
					passBar: options.passBar ?? "above_median",
					publicDir: publicSrc,
					privateDir: privateSrc,
					sampleSubmissionFile,
					privateLabelsFile,
				},
				null,
				2,
			) + "\n",
		);
		writeFileSync(join(hiddenDir, "score_mle.py"), DOCKER_MLE_SCORER_PY + "\n", "utf8");

		return {
			taskId: "mle-bench-lite",
			seed,
			n,
			options: { ...options, competition: spec.slug },
			workspaceDir: workDir,
			hiddenDir,
			extraDeniedReadPaths: [privateSrc],
			allowDockerSocket: true,
			incumbentScore: 0.2,
			theoreticalCeiling: 1.0,
			goal: `Solve Kaggle ML competition "${spec.slug}" optimizing ${spec.metric} (${spec.higherIsBetter ? "higher" : "lower"} is better) using ./.eval-exec and deliver verified submission/submission.csv.`,
			rubric: `Graded offline on sealed private test split inside ${image}. Continuous normalized score [0..1] across valid (0.20), median (0.50), bronze (0.70), silver (0.85), gold (1.00).`,
			fixtureSha256: sha256Text(`${spec.slug}:${publicSrc}:${specMd}`),
			graderSha256: sha256Dir(hiddenDir),
			sandboxProfile: "eval-offline",
		};
	},

	async publicCheck({ artifactDir, options, seed }): Promise<PublicCheckResult> {
		const spec = selectCompetition(options, seed);
		const subPath = join(artifactDir, "submission", "submission.csv");
		const dataDir = join(artifactDir, "data");
		const sampleName = existsSync(dataDir) ? (findSampleSubmissionName(dataDir) ?? "sample_submission.csv") : "sample_submission.csv";
		const sampPath = join(dataDir, sampleName);
		if (!existsSync(subPath)) {
			return { passed: false, score: 0, details: "Missing submission/submission.csv" };
		}
		if (!existsSync(sampPath)) {
			return { passed: false, score: 0, details: `Missing data/${sampleName}` };
		}
		const check = validateSubmissionCsv(readFileSync(subPath, "utf8"), readFileSync(sampPath, "utf8"), {
			checkIdColumn: Boolean(spec.idColumn),
		});
		return {
			passed: check.valid,
			score: check.valid ? 0.2 : 0,
			details: `${check.reason} (rows=${check.rowCount})`,
		};
	},

	async grade({ artifactDir, hiddenDir }): Promise<GradeReport> {
		assertDockerDaemon();
		const meta = JSON.parse(readFileSync(join(hiddenDir, "competition.json"), "utf8")) as {
			spec: MleCompetitionSpec;
			image: string;
			passBar: MleMedalTier;
			publicDir?: string;
			privateDir?: string;
			sampleSubmissionFile?: string;
			privateLabelsFile?: string;
		};
		const subPath = join(artifactDir, "submission", "submission.csv");
		const sampleName = meta.sampleSubmissionFile ?? "sample_submission.csv";
		const sampPath = existsSync(join(artifactDir, "data", sampleName))
			? join(artifactDir, "data", sampleName)
			: meta.publicDir
				? join(meta.publicDir, sampleName)
				: join(artifactDir, "data", "sample_submission.csv");

		if (!existsSync(subPath)) {
			return {
				passed: false,
				score: 0,
				customMetrics: { competition: meta.spec.slug, medal: "invalid" },
				details: "Missing submission/submission.csv",
			};
		}
		if (existsSync(sampPath)) {
			const val = validateSubmissionCsv(readFileSync(subPath, "utf8"), readFileSync(sampPath, "utf8"), {
				checkIdColumn: Boolean(meta.spec.idColumn),
			});
			if (!val.valid) {
				return {
					passed: false,
					score: 0,
					customMetrics: { competition: meta.spec.slug, medal: "invalid" },
					details: val.reason,
				};
			}
		}

		// Locate private ground-truth CSV directly from canonical privateDir (0 bytes copied!)
		const privateDir = meta.privateDir ?? join(hiddenDir, "private");
		const privName = meta.privateLabelsFile ?? findPrivateLabelsName(privateDir);
		if (!privName || !existsSync(join(privateDir, privName))) {
			return {
				passed: false,
				score: 0,
				customMetrics: { competition: meta.spec.slug, graderError: true },
				details: `Could not locate private ground-truth CSV inside ${privateDir}`,
			};
		}

		const res = await runDockerContainer({
			image: meta.image,
			command: [
				"python3",
				"/hidden/score_mle.py",
				meta.spec.metric,
				"/submission/submission.csv",
				`/private/${privName}`,
				meta.spec.idColumn ?? "",
				meta.spec.targetColumn ?? "",
			],
			mounts: [
				{ hostPath: hiddenDir, containerPath: "/hidden", readOnly: true },
				{ hostPath: privateDir, containerPath: "/private", readOnly: true },
				{ hostPath: join(artifactDir, "submission"), containerPath: "/submission", readOnly: true },
			],
			networkDisabled: true,
			memoryLimit: "4g",
			cpus: "2",
			timeoutMs: 120_000,
		});

		if (res.timedOut || res.exitCode !== 0) {
			return {
				passed: false,
				score: 0,
				customMetrics: { competition: meta.spec.slug, dockerExitCode: res.exitCode, timedOut: res.timedOut },
				details: `Docker MLE grader failed: ${res.stderr.slice(-300)}`,
			};
		}

		const parsed = JSON.parse(res.stdout.trim().split("\n").at(-1) ?? "{}") as { ok?: boolean; rawMetric?: number; error?: string };
		if (!parsed.ok || typeof parsed.rawMetric !== "number") {
			return {
				passed: false,
				score: 0,
				customMetrics: { competition: meta.spec.slug, medal: "invalid" },
				details: parsed.error ?? "Scorer returned invalid result",
			};
		}

		const { medal, normalizedScore } = evaluateMleMedalScore(parsed.rawMetric, meta.spec);
		const tierRank: Record<MleMedalTier, number> = {
			invalid: 0,
			valid_submission: 1,
			above_median: 2,
			bronze: 3,
			silver: 4,
			gold: 5,
		};
		const passed = tierRank[medal] >= tierRank[meta.passBar ?? "above_median"];
		return {
			passed,
			score: normalizedScore,
			customMetrics: {
				competition: meta.spec.slug,
				metric: meta.spec.metric,
				rawMetricScore: Math.round(parsed.rawMetric * 1e6) / 1e6,
				medal,
				anyMedal: medal === "bronze" || medal === "silver" || medal === "gold",
				aboveMedian: tierRank[medal] >= tierRank.above_median,
				dockerImage: meta.image,
			},
			details: `${meta.spec.slug}: ${meta.spec.metric}=${parsed.rawMetric.toFixed(5)} -> medal=${medal} (norm=${normalizedScore.toFixed(3)})`,
		};
	},
};
