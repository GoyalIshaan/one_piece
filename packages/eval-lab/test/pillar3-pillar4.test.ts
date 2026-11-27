import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitWorktreeManager, sandboxCommand } from "@one-piece/core";
import { captureFrozenSnapshot } from "@one-piece/engine";
import {
	ALL_EVAL_TASKS,
	analyzeTrajectory,
	buildDockerRunArgs,
	buildSweBenchTestCommand,
	DOCKER_MLE_SCORER_PY,
	EvalLedger,
	evaluateMleMedalScore,
	extractModelPatch,
	extractScorecard,
	generateObservatory,
	getEvalTask,
	loadSweBenchInstance,
	MLE_BENCH_LITE_SLICE,
	officialSweBenchImage,
	parseSweBenchTestOutput,
	parseTestPatchFiles,
	scoreSweBenchResults,
	scrubGitRepoHistory,
	sha256Dir,
	SWE_BENCH_HARD_MULTIFILE_SLICE,
	validateSubmissionCsv,
	type EvalTask,
	type HarnessRunReceipt,
	type HarnessRunSpec,
	type PreparedTask,
	type Scorecard,
} from "../src/index.ts";

function makeSyntheticCard(opts: {
	runId: string;
	taskId: string;
	family?: Scorecard["family"];
	topology: string;
	controlRung?: Scorecard["reproducibility"]["controlRung"];
	n: number;
	seed: number;
	score: number;
	passed: boolean;
	tokens: number;
	wallMs: number;
	gitSha: string;
	nomLoss?: number;
	hasFault?: boolean;
}): Scorecard {
	const bestOffline = Math.min(1, opts.score + (opts.nomLoss ?? 0));
	return {
		schemaVersion: 1,
		runId: opts.runId,
		taskId: opts.taskId,
		family: opts.family ?? "coupled-swe",
		status: opts.hasFault ? "failed" : "done",
		deliveredPass: opts.passed,
		deliveredScore: opts.score,
		bestOfflinePass: bestOffline >= 0.99,
		bestOfflineScore: bestOffline,
		autoNominated: true,
		...(opts.hasFault
			? { hasHarnessFault: true as const, harnessFaults: [{ code: "RUNNER_CRASH" as const, message: "boom" }] as const }
			: { hasHarnessFault: false as const, harnessFaults: [] as const }),
		losses: {
			discoveryLoss: Math.max(0, 1 - bestOffline),
			nominationLoss: opts.nomLoss ?? 0,
			falseCertificationRate: 0,
			postOptimumTokens: Math.round(opts.tokens * 0.1),
			stoppingWasteShare: 0.1,
		},
		tokens: {
			total: opts.tokens,
			input: Math.round(opts.tokens * 0.8),
			output: Math.round(opts.tokens * 0.2),
			cacheRead: 0,
			cacheWrite: 0,
			cacheHitRate: 0.65,
			reasoning: 0,
			peakInputPerCall: Math.round(opts.tokens * 0.4),
			estimatedUsd: opts.tokens * 0.000003,
			byRole: { worker: opts.tokens, coordinator: 0, reviewer: 0, refinery: 0 },
			byCategory: { work: opts.tokens, coordination: 0, verification: 0, other: 0 },
			coordinationTokenShare: 0.1,
		},
		time: {
			wallClockMs: opts.wallMs,
			llmWaitMs: opts.wallMs,
			quotaWaitMs: 0,
			toolExecMs: 0,
			graderComputeMs: 0,
			cpuSeconds: 0,
			gpuSeconds: 0,
			timeToFirstValidMs: opts.passed ? Math.round(opts.wallMs * 0.4) : null,
			timeToNominationMs: opts.wallMs,
		},
		dynamics: {
			swarmSize: opts.n,
			agentCount: opts.n,
			avgParallelism: opts.n,
			peakParallelism: opts.n,
			modelCalls: opts.n * 2,
			modelErrors: 0,
			toolCalls: 10,
			toolErrors: 0,
			toolErrorRate: 0,
			toolCallsByName: {},
			messageCount: 2,
			messageBytes: 400,
			compactions: 0,
			artifactReads: 0,
			stallDetections: 0,
			failoverCount: 0,
		},
		anytimeFrontier: [
			{
				atTokens: Math.round(opts.tokens * 0.4),
				atWallMs: Math.round(opts.wallMs * 0.4),
				bestOfflineScore: bestOffline,
				nominatedScore: opts.score,
				bestOfflinePassed: bestOffline >= 0.99,
				nominatedPassed: opts.passed,
			},
		],
		anytime: {
			aulcTokens: Math.round(opts.score * 0.6 * 1000) / 1000,
			aulcBestOfflineTokens: Math.round(bestOffline * 0.6 * 1000) / 1000,
			anytimeNominationLag: Math.round((bestOffline - opts.score) * 0.6 * 1000) / 1000,
			aulcWall: Math.round(opts.score * 0.6 * 1000) / 1000,
			scorePer100kTokens: Math.round((opts.score / Math.max(0.1, opts.tokens / 100_000)) * 1000) / 1000,
		},
		reproducibility: {
			harnessAdapter: "v2",
			topology: opts.topology,
			controlRung: opts.controlRung ?? (opts.n === 1 ? "solo" : "swarm"),
			budgetMode: "tokens",
			budget: { tokens: 200_000, wallClockMs: 240_000 },
			seed: opts.seed,
			armOrderIndex: 0,
			fixtureSha256: "fix",
			graderSha256: "grd",
			harnessGitSha: opts.gitSha,
			dirtyDiffSha: "clean",
			driverIds: ["codex"],
			modelIds: ["gpt"],
		},
		customMetrics: {},
		gradeDetails: "ok",
	};
}

describe("Pillar 4: Generation Ledger, Trajectory Engine, CUSUM, Pareto HV & Visual Observatory", () => {
	it("ingests multi-generation campaigns, tracks strictly increasing Pareto HV, catches CUSUM token bloat, and writes all 6 SVGs + HTML Observatory", () => {
		const root = mkdtempSync(join(tmpdir(), "eval-p4-"));
		try {
			const campaignsRoot = join(root, "campaigns");
			const genSpecs = [
				{ dir: "g1", sha: "1111111", ts: "2026-11-20T00:00:00Z", score: 0.35, tokens: 120_000, pass: false },
				{ dir: "g2", sha: "2222222", ts: "2026-11-21T00:00:00Z", score: 0.55, tokens: 110_000, pass: false },
				{ dir: "g3", sha: "3333333", ts: "2026-11-22T00:00:00Z", score: 0.78, tokens: 100_000, pass: true },
				{ dir: "g4", sha: "4444444", ts: "2026-11-23T00:00:00Z", score: 0.92, tokens: 260_000, pass: true }, // Deliberate token bloat to trigger CUSUM
				{ dir: "g5", sha: "5555555", ts: "2026-11-24T00:00:00Z", score: 0.96, tokens: 320_000, pass: true },
			];

			for (const g of genSpecs) {
				const cDir = join(campaignsRoot, g.dir);
				mkdirSync(cDir, { recursive: true });
				writeFileSync(join(cDir, "protocol.json"), JSON.stringify({ createdAt: g.ts, git: { harnessGitSha: g.sha } }));
				const rows: Scorecard[] = [];
				for (const seed of [1, 2]) {
					rows.push(
						makeSyntheticCard({
							runId: `s${seed}-solo`,
							taskId: "adversarial-spec-forge",
							topology: "single",
							controlRung: "solo",
							n: 1,
							seed,
							score: Math.max(0.2, g.score - 0.35),
							passed: false,
							tokens: Math.round(g.tokens * 0.4),
							wallMs: 60_000,
							gitSha: g.sha,
						}),
					);
					rows.push(
						makeSyntheticCard({
							runId: `s${seed}-adaptive`,
							taskId: "adversarial-spec-forge",
							topology: "adaptive",
							controlRung: "swarm",
							n: 4,
							seed,
							score: g.score,
							passed: g.pass,
							tokens: g.tokens,
							wallMs: 90_000,
							gitSha: g.sha,
						}),
					);
				}
				writeFileSync(join(cDir, "results.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
			}

			const ledger = new EvalLedger(join(root, "ledger.sqlite"));
			try {
				const bf = ledger.backfillDirectory(campaignsRoot);
				expect(bf.generationsCount).toBe(5);
				expect(bf.totalRunsIngested).toBe(20);

				// Idempotent re-backfill must not duplicate rows
				const bf2 = ledger.backfillDirectory(campaignsRoot);
				expect(bf2.generationsCount).toBe(5);
				expect(ledger.listRuns().length).toBe(20);

				const report = analyzeTrajectory(ledger);
				expect(report.totalGenerations).toBe(5);
				expect(report.overallVerdict).toBe("ON_TRACK");
				expect(report.generations[2]!.paretoHypervolumeTokens).toBeGreaterThan(report.generations[0]!.paretoHypervolumeTokens);
				expect(report.transitions.length).toBe(4);
				expect(report.transitions.every((t) => t.pairingMode === "exact_arm")).toBe(true);
				expect(report.cusumAlerts.some((a) => a.metric === "meanTokens")).toBe(true);

				const obsDir = join(root, "observatory");
				const artifacts = generateObservatory(report, obsDir);
				expect(existsSync(artifacts.htmlPath)).toBe(true);
				expect(existsSync(artifacts.jsonPath)).toBe(true);
				expect(existsSync(artifacts.markdownPath)).toBe(true);
				expect(Object.keys(artifacts.chartPaths).length).toBe(6);
				for (const svgPath of Object.values(artifacts.chartPaths)) {
					const svg = readFileSync(svgPath, "utf8");
					expect(svg).toContain("<svg");
					expect(svg).toContain("</svg>");
				}
				const html = readFileSync(artifacts.htmlPath, "utf8");
				expect(html).toContain("Longitudinal Eval Observatory");
				expect(html).toContain("ON_TRACK");
			} finally {
				ledger.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("Pillar 3: Strict Docker SWE-bench Verified & MLE-bench Lite Ports", () => {
	it("registers swe-bench-verified and mle-bench-lite in ALL_EVAL_TASKS with curated slices", () => {
		expect(getEvalTask("swe-bench-verified").id).toBe("swe-bench-verified");
		expect(getEvalTask("mle-bench-lite").id).toBe("mle-bench-lite");
		expect(ALL_EVAL_TASKS.length).toBe(10);
		expect(SWE_BENCH_HARD_MULTIFILE_SLICE.length).toBe(12);
		expect(MLE_BENCH_LITE_SLICE.length).toBe(8);
		expect(officialSweBenchImage("django__django-11179", "x86_64")).toBe(
			"swebench/sweb.eval.x86_64.django_1776_django-11179:latest",
		);
	});

	it("builds strict offline Docker arguments (--rm --network=none --pids-limit + read-only mounts)", () => {
		const args = buildDockerRunArgs(
			{
				image: "swebench/sweb.eval.x86_64.django_1776_django-11179:latest",
				command: ["/bin/bash", "-c", "pytest"],
				mounts: [{ hostPath: "/tmp/stage", containerPath: "/eval-stage", readOnly: true }],
				networkDisabled: true,
				memoryLimit: "8g",
				cpus: "4",
				platform: "linux/amd64",
			},
			"onepiece-test-ctr",
		);
		expect(args).toContain("--rm");
		expect(args).toContain("--network=none");
		expect(args).toContain("--pids-limit");
		expect(args).toContain("--platform");
		expect(args).toContain("linux/amd64");
		expect(args.some((a) => a.endsWith(":/eval-stage:ro"))).toBe(true);
	});

	it("scrubs future commits completely via anti-cheat scrubGitRepoHistory and extracts clean model patches", () => {
		const repo = mkdtempSync(join(tmpdir(), "eval-scrub-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd: repo });
			execFileSync("git", ["config", "user.email", "t@test.dev"], { cwd: repo });
			execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
			writeFileSync(join(repo, "mod.py"), "def add(a, b):\n    return a - b\n");
			execFileSync("git", ["add", "-A"], { cwd: repo });
			execFileSync("git", ["commit", "-q", "-m", "base buggy commit"], { cwd: repo });
			const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

			// Add a future gold commit that an agent MUST NEVER be able to see
			writeFileSync(join(repo, "mod.py"), "def add(a, b):\n    return a + b  # SECRET_FUTURE_GOLD_FIX\n");
			execFileSync("git", ["add", "-A"], { cwd: repo });
			execFileSync("git", ["commit", "-q", "-m", "secret future fix"], { cwd: repo });

			// Scrub back to baseSha
			scrubGitRepoHistory(repo, baseSha);

			const logAll = execFileSync("git", ["log", "--all", "--oneline"], { cwd: repo, encoding: "utf8" });
			expect(logAll.trim().split("\n").length).toBe(1);
			expect(logAll).not.toContain("secret future fix");
			expect(readFileSync(join(repo, "mod.py"), "utf8")).not.toContain("SECRET_FUTURE_GOLD_FIX");

			// Now simulate an agent edit & verify clean patch extraction (ignoring ISSUE.md)
			writeFileSync(join(repo, "ISSUE.md"), "# Issue\n");
			writeFileSync(join(repo, "mod.py"), "def add(a, b):\n    return a + b\n");
			const patch = extractModelPatch(repo);
			expect(patch).toContain("mod.py");
			expect(patch).toContain("+    return a + b");
			expect(patch).not.toContain("ISSUE.md");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("parses SWE-bench pytest & Django unittest outputs and loads JSONL instances cleanly", () => {
		const pytestOut = [
			"PASSED tests/test_core.py::test_bug_fix",
			"tests/test_core.py::test_existing_1 PASSED",
			"FAILED tests/test_core.py::test_bug_fix_2",
			"test_queryset (queries.tests.QueryTests) ... ok",
		].join("\n");
		const map = parseSweBenchTestOutput(pytestOut, "", [
			"tests/test_core.py::test_bug_fix",
			"tests/test_core.py::test_bug_fix_2",
			"tests/test_core.py::test_existing_1",
			"test_queryset (queries.tests.QueryTests)",
		]);
		const partial = scoreSweBenchResults(
			map,
			["tests/test_core.py::test_bug_fix", "tests/test_core.py::test_bug_fix_2"],
			["tests/test_core.py::test_existing_1", "test_queryset (queries.tests.QueryTests)"],
		);
		expect(partial.resolved).toBe(false);
		expect(partial.f2pPassed).toBe(1);
		expect(partial.p2pPassed).toBe(2);
		expect(partial.score).toBeCloseTo(0.65, 2); // 0.7 * 0.5 + 0.3 * 1.0 = 0.65

		const resolved = scoreSweBenchResults(
			map,
			["tests/test_core.py::test_bug_fix"],
			["tests/test_core.py::test_existing_1", "test_queryset (queries.tests.QueryTests)"],
		);
		expect(resolved.resolved).toBe(true);
		expect(resolved.score).toBe(1.0);

		// Dataset JSONL loader test
		const dir = mkdtempSync(join(tmpdir(), "eval-swe-ds-"));
		try {
			const dsPath = join(dir, "verified.jsonl");
			writeFileSync(
				dsPath,
				JSON.stringify({
					instance_id: "django__django-11179",
					repo: "django/django",
					base_commit: "19fc6376ce67d01ca37a91ef2f55ef769f50513a",
					problem_statement: "delete() on instances of models without any dependencies doesn't clear PKs.",
					test_patch: "diff --git a/t.py b/t.py\n",
					FAIL_TO_PASS: '["test_pk_cleared (delete.tests.DeletionTests)"]',
					PASS_TO_PASS: '["test_basic (delete.tests.DeletionTests)"]',
				}) + "\n",
			);
			const loaded = loadSweBenchInstance({ dataset: dsPath }, 1);
			expect(loaded.instance_id).toBe("django__django-11179");
			expect(loaded.FAIL_TO_PASS).toEqual(["test_pk_cleared (delete.tests.DeletionTests)"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("validates MLE-bench CSV submissions and maps raw metrics accurately to Kaggle medal tiers", () => {
		const sample = "PassengerId,Transported\n0013_01,False\n0018_01,False\n";
		const goodSub = "PassengerId,Transported\n0013_01,True\n0018_01,False\n";
		const nanSub = "PassengerId,Transported\n0013_01,NaN\n0018_01,False\n";
		const badIdSub = "PassengerId,Transported\n9999_01,True\n0018_01,False\n";

		expect(validateSubmissionCsv(goodSub, sample).valid).toBe(true);
		expect(validateSubmissionCsv(nanSub, sample).valid).toBe(false);
		expect(validateSubmissionCsv(badIdSub, sample).valid).toBe(false);

		// Higher-is-better (spaceship-titanic accuracy)
		const titanic = MLE_BENCH_LITE_SLICE.find((c) => c.slug === "spaceship-titanic")!;
		expect(evaluateMleMedalScore(0.82, titanic)).toEqual({ medal: "gold", normalizedScore: 1.0 });
		expect(evaluateMleMedalScore(0.811, titanic).medal).toBe("silver");
		expect(evaluateMleMedalScore(0.8075, titanic).medal).toBe("bronze");
		expect(evaluateMleMedalScore(0.799, titanic).medal).toBe("above_median");
		expect(evaluateMleMedalScore(0.75, titanic).medal).toBe("valid_submission");

		// Lower-is-better (spooky-author-identification log_loss)
		const spooky = MLE_BENCH_LITE_SLICE.find((c) => c.slug === "spooky-author-identification")!;
		expect(evaluateMleMedalScore(0.25, spooky)).toEqual({ medal: "gold", normalizedScore: 1.0 });
		expect(evaluateMleMedalScore(0.28, spooky).medal).toBe("silver");
		expect(evaluateMleMedalScore(0.30, spooky).medal).toBe("bronze");
		expect(evaluateMleMedalScore(0.35, spooky).medal).toBe("above_median");
	});

	it("captures untracked new files in extractModelPatch and handles large git repos (>2,500 files) via sparse git-delta snapshots", () => {
		const root = mkdtempSync(join(tmpdir(), "eval-sparse-snap-"));
		try {
			const repo = join(root, "repo");
			mkdirSync(repo, { recursive: true });
			execFileSync("git", ["init", "-q"], { cwd: repo });
			execFileSync("git", ["config", "user.email", "t@test.dev"], { cwd: repo });
			execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });

			// Create 2,200 untouched files (exceeding FULL_SNAPSHOT_MAX_ENTRIES=2048, like Django/SymPy)
			const bulkDir = join(repo, "pkg");
			mkdirSync(bulkDir, { recursive: true });
			for (let i = 0; i < 2200; i++) {
				writeFileSync(join(bulkDir, `m_${i}.py`), `VAL = ${i}\n`);
			}
			execFileSync("git", ["add", "-A"], { cwd: repo });
			execFileSync("git", ["commit", "-q", "-m", "base commit"], { cwd: repo });

			// Modify 1 tracked file AND add 1 untracked new file AND write ignored harness files
			writeFileSync(join(bulkDir, "m_0.py"), "VAL = 999\n");
			writeFileSync(join(bulkDir, "brand_new_helper.py"), "def helper():\n    return 42\n");
			writeFileSync(join(repo, "ISSUE.md"), "# Should be excluded\n");
			writeFileSync(join(repo, ".eval-exec"), "#!/bin/bash\n");

			// Capture frozen snapshot (must NOT throw snapshot limit error!)
			const snapDir = join(root, "snapshot");
			const sha = captureFrozenSnapshot(repo, snapDir);
			expect(sha.length).toBe(64);
			expect(existsSync(join(snapDir, ".onepiece-eval.patch"))).toBe(true);
			expect(existsSync(join(snapDir, ".onepiece-snapshot.json"))).toBe(true);
			expect(existsSync(join(snapDir, "pkg", "m_0.py"))).toBe(true);
			expect(existsSync(join(snapDir, "pkg", "brand_new_helper.py"))).toBe(true);
			// Sparse mode must NOT have duplicated untouched files
			expect(existsSync(join(snapDir, "pkg", "m_2199.py"))).toBe(false);

			// extractModelPatch must work directly on the frozen snapshot (no .git!) AND include untracked files
			const patch = extractModelPatch(snapDir);
			expect(patch).toContain("pkg/m_0.py");
			expect(patch).toContain("+VAL = 999");
			expect(patch).toContain("pkg/brand_new_helper.py");
			expect(patch).toContain("return 42");
			expect(patch).not.toContain("ISSUE.md");
			expect(patch).not.toContain(".eval-exec");

			// Non-git directory without .onepiece-eval.patch must throw (never walk up to parent repo!)
			const nonGit = join(root, "no-git");
			mkdirSync(nonGit, { recursive: true });
			expect(() => extractModelPatch(nonGit)).toThrow(/not a git repository/i);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves read-only data symlinks with zero copy across GitWorktreeManager, captureFrozenSnapshot, and sha256Dir", () => {
		const root = mkdtempSync(join(tmpdir(), "eval-symlink-zero-copy-"));
		try {
			const publicData = join(root, "canonical-public");
			mkdirSync(publicData, { recursive: true });
			writeFileSync(join(publicData, "train.csv"), "id,x,y\n1,2,3\n");
			writeFileSync(join(publicData, "sample_submission.csv"), "id,y\n1,0\n");

			const workDir = join(root, "workspace");
			mkdirSync(join(workDir, "submission"), { recursive: true });
			symlinkSync(publicData, join(workDir, "data"));
			writeFileSync(join(workDir, ".gitignore"), "data\ndata/\n.eval-exec\n");
			writeFileSync(join(workDir, "SPEC.md"), "# Spec\n");
			writeFileSync(join(workDir, "submission", ".gitkeep"), "");
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workDir });
			execFileSync("git", ["config", "user.email", "t@test.dev"], { cwd: workDir });
			execFileSync("git", ["config", "user.name", "Test"], { cwd: workDir });
			execFileSync("git", ["add", ".gitignore", "SPEC.md", "submission/.gitkeep"], { cwd: workDir });
			execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: workDir });
			writeFileSync(join(workDir, ".eval-exec"), "#!/bin/bash\necho ok\n", { mode: 0o755 });

			// Linked worktree must mirror the `data` symlink (zero copy!) and `.eval-exec`
			const runDir = join(root, "run");
			const wtm = new GitWorktreeManager(workDir, runDir, "run-1");
			const wt = wtm.create("worker-1");
			expect(lstatSync(join(wt.path, "data")).isSymbolicLink()).toBe(true);
			expect(readlinkSync(join(wt.path, "data"))).toBe(publicData);
			expect(existsSync(join(wt.path, "data", "train.csv"))).toBe(true);
			expect(existsSync(join(wt.path, ".eval-exec"))).toBe(true);

			// Frozen snapshot must also preserve symlink without copying data
			writeFileSync(join(wt.path, "submission", "submission.csv"), "id,y\n1,3\n");
			const snapDir = join(root, "snap");
			captureFrozenSnapshot(wt.path, snapDir);
			expect(lstatSync(join(snapDir, "data")).isSymbolicLink()).toBe(true);
			expect(readlinkSync(join(snapDir, "data"))).toBe(publicData);
			expect(existsSync(join(snapDir, "submission", "submission.csv"))).toBe(true);

			// sha256Dir hashes symlink target deterministically
			const h1 = sha256Dir(snapDir);
			const h2 = sha256Dir(snapDir);
			expect(h1).toBe(h2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("builds official repo-accurate SWE-bench test commands (Django --settings=test_sqlite, SymPy bin/test, pytest) and parses all 3 formats", () => {
		const djangoPatch = "diff --git a/tests/delete/tests.py b/tests/delete/tests.py\n+++ b/tests/delete/tests.py\n";
		expect(parseTestPatchFiles(djangoPatch)).toEqual(["tests/delete/tests.py"]);
		const djangoCmd = buildSweBenchTestCommand({
			repo: "django/django",
			test_patch: djangoPatch,
			FAIL_TO_PASS: ["test_pk_cleared (delete.tests.DeletionTests)"],
			PASS_TO_PASS: [],
		});
		expect(djangoCmd).toContain("./tests/runtests.py");
		expect(djangoCmd).toContain("--settings=test_sqlite");
		expect(djangoCmd).toContain("'delete.tests'");

		const sympyPatch = "diff --git a/sympy/matrices/tests/test_commonmatrix.py b/sympy/matrices/tests/test_commonmatrix.py\n";
		const sympyCmd = buildSweBenchTestCommand({
			repo: "sympy/sympy",
			test_patch: sympyPatch,
			FAIL_TO_PASS: ["test_row_join"],
			PASS_TO_PASS: ["test_col_join"],
		});
		expect(sympyCmd).toContain("bin/test -C --verbose");
		expect(sympyCmd).toContain("'sympy/matrices/tests/test_commonmatrix.py'");

		const pytestPatch = "diff --git a/sklearn/mixture/tests/test_gaussian_mixture.py b/sklearn/mixture/tests/test_gaussian_mixture.py\n";
		const pytestCmd = buildSweBenchTestCommand({
			repo: "scikit-learn/scikit-learn",
			test_patch: pytestPatch,
			FAIL_TO_PASS: ["sklearn/mixture/tests/test_gaussian_mixture.py::test_fit_predict[full 1]"],
			PASS_TO_PASS: [],
		});
		expect(pytestCmd).toContain("pytest --no-header -rA");
		expect(pytestCmd).toContain("'sklearn/mixture/tests/test_gaussian_mixture.py'");

		// Multi-line Django docstring + SymPy bin/test + parameterized pytest with spaces
		const mixedOut = [
			"test_pk_cleared (delete.tests.DeletionTests)",
			"Ensure PK is reset to None after delete() ... ok",
			"test_row_join ok",
			"test_col_join F",
			"PASSED tests/test_core.py::test_param[a b]",
			"FAILED tests/test_core.py::test_param[c d] - AssertionError: boom",
		].join("\n");
		const parsed = parseSweBenchTestOutput(mixedOut, "", [
			"test_pk_cleared (delete.tests.DeletionTests)",
			"test_row_join",
			"test_col_join",
			"tests/test_core.py::test_param[a b]",
			"tests/test_core.py::test_param[c d]",
		]);
		expect(parsed.get("test_pk_cleared (delete.tests.DeletionTests)")).toBe("PASSED");
		expect(parsed.get("test_row_join")).toBe("PASSED");
		expect(parsed.get("test_col_join")).toBe("FAILED");
		expect(parsed.get("tests/test_core.py::test_param[a b]")).toBe("PASSED");
		expect(parsed.get("tests/test_core.py::test_param[c d]")).toBe("FAILED");
	});

	it("scores all 4 MLE-bench competition table shapes accurately (bool accuracy, multi-class log_loss, multi-target rmsle, row-aligned roc_auc)", () => {
		// Check whether python3 + pandas + sklearn are available on host; skip only if missing
		const probe = spawnSync("python3", ["-c", "import numpy, pandas, sklearn"], { encoding: "utf8" });
		if (probe.status !== 0) return;

		const root = mkdtempSync(join(tmpdir(), "eval-mle-scorer-"));
		try {
			const scorerPath = join(root, "score_mle.py");
			writeFileSync(scorerPath, DOCKER_MLE_SCORER_PY + "\n", "utf8");

			const runScorer = (metric: string, subCsv: string, privCsv: string, idCol = "", targetCol = ""): number => {
				const sub = join(root, "sub.csv");
				const priv = join(root, "priv.csv");
				writeFileSync(sub, subCsv, "utf8");
				writeFileSync(priv, privCsv, "utf8");
				const r = spawnSync("python3", [scorerPath, metric, sub, priv, idCol, targetCol], { encoding: "utf8" });
				expect(r.status, r.stderr).toBe(0);
				const out = JSON.parse(r.stdout.trim()) as { ok: boolean; rawMetric: number };
				expect(out.ok).toBe(true);
				return out.rawMetric;
			};

			// 1. spaceship-titanic: case-insensitive / boolean normalization accuracy
			const acc = runScorer(
				"accuracy",
				"PassengerId,Transported\n01,true\n02,FALSE\n",
				"PassengerId,Transported\n01,True\n02,False\n",
				"PassengerId",
				"Transported",
			);
			expect(acc).toBeCloseTo(1.0, 5);

			// 2. spooky-author-identification: multi-class probability columns vs single 'author' label column
			const ll = runScorer(
				"log_loss",
				"id,EAP,HPL,MWS\nid1,0.9,0.05,0.05\nid2,0.05,0.9,0.05\nid3,0.05,0.05,0.9\n",
				"id,author\nid1,EAP\nid2,HPL\nid3,MWS\n",
				"id",
				"",
			);
			expect(ll).toBeLessThan(0.15);

			// 3. nomad2018: multi-target continuous RMSLE
			const rmsle = runScorer(
				"rmsle",
				"id,formation_energy_ev_natom,bandgap_energy_ev\n1,0.1,1.5\n2,0.2,2.0\n",
				"id,formation_energy_ev_natom,bandgap_energy_ev\n1,0.1,1.5\n2,0.2,2.0\n",
				"id",
				"",
			);
			expect(rmsle).toBeCloseTo(0.0, 6);

			// 4. detecting-insults-in-social-commentary: row-aligned ROC-AUC with NO ID column
			const auc = runScorer(
				"roc_auc",
				'Insult,Date,Comment\n0.95,2012,"bad"\n0.05,2012,"good"\n0.85,2012,"mean"\n0.10,2012,"nice"\n',
				'Insult,Date,Comment\n1,2012,"bad"\n0,2012,"good"\n1,2012,"mean"\n0,2012,"nice"\n',
				"",
				"Insult",
			);
			expect(auc).toBeCloseTo(1.0, 5);

			// Also verify RFC-4180 CSV validation with quoted commas and checkIdColumn: false
			const subInsult = 'Insult,Date,Comment\n0.9,2012,"hello, world"\n0.1,2012,"fine"\n';
			const sampInsult = 'Insult,Date,Comment\n0,2012,"hello, world"\n0,2012,"fine"\n';
			expect(validateSubmissionCsv(subInsult, sampInsult, { checkIdColumn: false }).valid).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("deduplicates identical artifact SHA-256 grading calls inside extractScorecard and scopes Docker socket in Seatbelt", async () => {
		const root = mkdtempSync(join(tmpdir(), "eval-dedupe-grade-"));
		try {
			const artDir = join(root, "art");
			mkdirSync(artDir, { recursive: true });
			writeFileSync(join(artDir, "out.txt"), "ok\n");

			let gradeCalls = 0;
			const fakeTask: EvalTask = {
				id: "fake-docker",
				title: "Fake Docker",
				family: "coupled-swe",
				supportedN: [1],
				requiresDocker: true,
				async prepare() {
					throw new Error("unused");
				},
				async grade() {
					gradeCalls += 1;
					return { passed: true, score: 1, customMetrics: {}, details: "ok" };
				},
			};
			const prepared: PreparedTask = {
				taskId: "fake-docker",
				seed: 1,
				n: 1,
				options: {},
				workspaceDir: artDir,
				hiddenDir: root,
				goal: "g",
				fixtureSha256: "f",
				graderSha256: "g",
				sandboxProfile: "eval-offline",
			};
			const spec: HarnessRunSpec = {
				runId: "r1",
				runDir: root,
				dbPath: join(root, "missing.db"),
				taskId: "fake-docker",
				seed: 1,
				goal: "g",
				workspaceDir: artDir,
				hiddenDenyPaths: [root],
				controlRung: "solo",
				swarmSize: 1,
				budget: { tokens: 1000 },
				budgetMode: "tokens",
				autoNominate: true,
				sandboxProfile: "eval-offline",
			};
			const receipt: HarnessRunReceipt = {
				runId: "r1",
				status: "done",
				nominatedArtifactDir: artDir,
				nominatedSha256: "deadbeef",
				autoNominated: true,
				candidateSnapshots: [
					{ id: "c1", agentId: "a1", dir: artDir, sha256: "deadbeef", atTokens: 100, atWallMs: 10, acceptedByVerifier: true },
					{ id: "c2", agentId: "a1", dir: artDir, sha256: "deadbeef", atTokens: 200, atWallMs: 20, acceptedByVerifier: true },
				],
				harnessFaults: [],
			};
			await extractScorecard({
				task: fakeTask,
				prepared,
				spec,
				receipt,
				adapterName: "mock",
				armOrderIndex: 0,
				repoRoot: root,
			});
			// Nominated + 2 snapshots all share sha256="deadbeef" -> MUST call task.grade() ONCE!
			expect(gradeCalls).toBe(1);

			// Verify Seatbelt allowDockerSocket keeps (deny network*) while permitting local docker.sock unix socket
			if (process.platform === "darwin") {
				const cmd = sandboxCommand(["/bin/echo", "hi"], {
					cwd: artDir,
					profile: "worker",
					networkOff: true,
					allowDockerSocket: true,
					deniedReadPaths: [join(root, "private-secret")],
				});
				const profile = cmd[2] ?? "";
				expect(profile).toContain("(deny network*)");
				expect(profile).toContain("docker.sock");
				expect(profile).toContain("private-secret");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
