import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EvalTask, GradeReport, PreparedTask, PublicCheckResult } from "../../contracts.ts";
import {
	assertDockerDaemon,
	dockerPlatformForArch,
	ensureDockerImage,
	ensureFirstAvailableDockerImage,
	ensureScrubbedDockerRepoCache,
	extractFullGitPatch,
	resolveHostDockerArch,
	runDockerContainer,
} from "../../docker-runner.ts";
import { sha256Dir, sha256Text } from "../../sandbox.ts";

export interface SweBenchInstance {
	readonly instance_id: string;
	readonly repo: string;
	readonly base_commit: string;
	readonly problem_statement: string;
	readonly hints_text?: string;
	readonly test_patch: string;
	readonly patch?: string;
	readonly FAIL_TO_PASS: readonly string[];
	readonly PASS_TO_PASS: readonly string[];
	readonly version?: string;
	readonly difficulty?: string;
	/** Optional explicit official Docker image name; defaults to official SWE-bench Eval image naming. */
	readonly docker_image?: string;
	/** Optional custom test runner command template (default uses repo-accurate pytest / Django runtests.py / SymPy bin/test). */
	readonly test_cmd?: string;
}

/**
 * Curated stratified hard multi-file slice from official SWE-bench Verified
 * (selected for high multi-module reasoning depth & non-saturated solo pass rates).
 * Full instance payloads (problem_statement, test_patch, FAIL_TO_PASS, PASS_TO_PASS) are loaded
 * from `--opt dataset=/path/to/swe-bench-verified.jsonl` (HuggingFace `princeton-nlp/SWE-bench_Verified`).
 */
export const SWE_BENCH_HARD_MULTIFILE_SLICE: readonly {
	readonly instance_id: string;
	readonly repo: string;
	readonly difficulty: "15m-1h" | "1h-4h" | ">4h";
}[] = [
	{ instance_id: "django__django-11179", repo: "django/django", difficulty: "15m-1h" },
	{ instance_id: "django__django-12708", repo: "django/django", difficulty: "1h-4h" },
	{ instance_id: "django__django-13658", repo: "django/django", difficulty: "15m-1h" },
	{ instance_id: "django__django-14787", repo: "django/django", difficulty: "1h-4h" },
	{ instance_id: "django__django-15814", repo: "django/django", difficulty: "1h-4h" },
	{ instance_id: "sympy__sympy-13031", repo: "sympy/sympy", difficulty: "15m-1h" },
	{ instance_id: "sympy__sympy-18189", repo: "sympy/sympy", difficulty: "1h-4h" },
	{ instance_id: "sympy__sympy-21379", repo: "sympy/sympy", difficulty: "1h-4h" },
	{ instance_id: "scikit-learn__scikit-learn-13142", repo: "scikit-learn/scikit-learn", difficulty: "1h-4h" },
	{ instance_id: "astropy__astropy-14365", repo: "astropy/astropy", difficulty: "1h-4h" },
	{ instance_id: "matplotlib__matplotlib-23476", repo: "matplotlib/matplotlib", difficulty: "1h-4h" },
	{ instance_id: "pydata__xarray-4094", repo: "pydata/xarray", difficulty: "1h-4h" },
];

const SWE_EXCLUDE_PATTERNS = [
	"ISSUE.md",
	".eval-exec",
	".eval-tmp/",
	".swarm/",
	".one_piece/",
	".gemini/",
	".grok/",
	".onepiece-eval.patch",
	".onepiece-snapshot.json",
];

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Derive official SWE-bench Verified Docker Hub image tag for an instance ID.
 * Official Epoch AI / SWE-bench convention: `swebench/sweb.eval.<arch>.<repo_owner>_1776_<repo_name>-<issue>:latest`
 */
export function officialSweBenchImage(instanceId: string, arch: "x86_64" | "arm64" = "x86_64"): string {
	const normalized = instanceId.replace("__", "_1776_").toLowerCase();
	return `swebench/sweb.eval.${arch}.${normalized}:latest`;
}

/**
 * Extract all unique file paths touched by a unified git `test_patch`
 * (`diff --git a/<path> b/<path>` or `+++ b/<path>`).
 */
export function parseTestPatchFiles(testPatch: string): string[] {
	const files = new Set<string>();
	for (const rawLine of testPatch.split(/\r?\n/)) {
		const diffMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(rawLine);
		if (diffMatch?.[2] && diffMatch[2] !== "/dev/null") {
			files.add(diffMatch[2].trim());
			continue;
		}
		const plusMatch = /^\+\+\+ b\/(.+)$/.exec(rawLine);
		if (plusMatch?.[1] && plusMatch[1] !== "/dev/null") {
			files.add(plusMatch[1].trim());
		}
	}
	return [...files];
}

function parseTestList(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
		} catch {
			return raw.split(",").map((s) => s.trim()).filter(Boolean);
		}
	}
	return [];
}

/**
 * Load a SWE-bench Verified instance from a local JSONL or JSON dataset file.
 * Supports explicit `--opt instanceId=<id>` or deterministic seed-indexed selection across the hard slice / dataset.
 */
export function loadSweBenchInstance(options: Record<string, string>, seed: number): SweBenchInstance {
	const datasetPath = options.dataset ?? process.env.SWE_BENCH_VERIFIED_JSONL;
	if (!datasetPath || !existsSync(resolve(datasetPath))) {
		throw new Error(
			"SWE-bench Verified requires a local dataset JSONL/JSON file via `--opt dataset=/path/to/swe_bench_verified.jsonl` " +
				"(or env `SWE_BENCH_VERIFIED_JSONL`). Download official dataset from HuggingFace `princeton-nlp/SWE-bench_Verified`.",
		);
	}
	const rawText = readFileSync(resolve(datasetPath), "utf8").trim();
	const rows: Array<Record<string, unknown>> = rawText.startsWith("[")
		? (JSON.parse(rawText) as Array<Record<string, unknown>>)
		: rawText.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

	const sliceIds = new Set(SWE_BENCH_HARD_MULTIFILE_SLICE.map((s) => s.instance_id));
	const explicitId = options.instanceId;
	let chosen: Record<string, unknown> | undefined;
	if (explicitId) {
		chosen = rows.find((r) => String(r.instance_id) === explicitId);
		if (!chosen) throw new Error(`SWE-bench instance "${explicitId}" not found in ${datasetPath}`);
	} else {
		const pool = options.slice === "all" ? rows : rows.filter((r) => sliceIds.has(String(r.instance_id)));
		const activePool = pool.length ? pool : rows;
		chosen = activePool[Math.abs(seed - 1) % activePool.length];
	}
	if (!chosen) throw new Error(`No SWE-bench instances found in ${datasetPath}`);

	return {
		instance_id: String(chosen.instance_id),
		repo: String(chosen.repo),
		base_commit: String(chosen.base_commit),
		problem_statement: String(chosen.problem_statement ?? ""),
		hints_text: typeof chosen.hints_text === "string" ? chosen.hints_text : undefined,
		test_patch: String(chosen.test_patch ?? ""),
		patch: typeof chosen.patch === "string" ? chosen.patch : undefined,
		FAIL_TO_PASS: parseTestList(chosen.FAIL_TO_PASS),
		PASS_TO_PASS: parseTestList(chosen.PASS_TO_PASS),
		version: typeof chosen.version === "string" ? chosen.version : undefined,
		difficulty: typeof chosen.difficulty === "string" ? chosen.difficulty : undefined,
		docker_image: typeof chosen.docker_image === "string" ? chosen.docker_image : undefined,
		test_cmd: typeof chosen.test_cmd === "string" ? chosen.test_cmd : undefined,
	};
}

/**
 * Extract unified git diff (committed + staged + unstaged + untracked new files against base snapshot commit)
 * from either a frozen sparse snapshot (`.onepiece-eval.patch`) or a git artifact workspace.
 */
export function extractModelPatch(artifactDir: string): string {
	const abs = resolve(artifactDir);
	const frozenPatch = join(abs, ".onepiece-eval.patch");
	if (existsSync(frozenPatch)) {
		return readFileSync(frozenPatch, "utf8");
	}
	return extractFullGitPatch(abs);
}

/**
 * Parse pytest (`-rA` / `-v`), Django `runtests.py` (including multi-line docstrings),
 * and SymPy `bin/test -C --verbose` output into a per-test pass/fail status map.
 */
export function parseSweBenchTestOutput(
	stdout: string,
	stderr: string,
	expectedTests: readonly string[],
): Map<string, "PASSED" | "FAILED" | "ERROR" | "SKIPPED"> {
	const statusMap = new Map<string, "PASSED" | "FAILED" | "ERROR" | "SKIPPED">();
	const combined = `${stdout}\n${stderr}`;
	const lines = combined.split(/\r?\n/);

	const normalizeDjangoStatus = (raw: string): "PASSED" | "FAILED" | "ERROR" | "SKIPPED" => {
		const st = raw.toLowerCase();
		if (st === "ok" || st === "expected failure") return "PASSED";
		if (st === "fail") return "FAILED";
		if (st === "error") return "ERROR";
		return "SKIPPED";
	};

	let pendingDjangoTest: string | undefined;
	let pendingDjangoAge = 0;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) {
			pendingDjangoTest = undefined;
			pendingDjangoAge = 0;
			continue;
		}

		// 1. pytest short summary lines: "PASSED tests/foo.py::test_bar[a b]" or "FAILED tests/foo.py::test_bar - AssertionError..."
		const m1 = /^(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\s+(.+)$/.exec(line);
		if (m1) {
			const rawStatus = m1[1]!;
			const status: "PASSED" | "FAILED" | "ERROR" | "SKIPPED" =
				rawStatus === "PASSED" || rawStatus === "XFAIL" || rawStatus === "XPASS"
					? "PASSED"
					: rawStatus === "FAILED"
						? "FAILED"
						: rawStatus === "ERROR"
							? "ERROR"
							: "SKIPPED";
			// Strip trailing " - <reason>" produced by pytest -rA on FAILED/ERROR/SKIPPED lines
			const rawId = m1[2]!;
			const testId = rawId.includes(" - ") ? rawId.slice(0, rawId.indexOf(" - ")).trim() : rawId.trim();
			if (testId) statusMap.set(testId, status);
			pendingDjangoTest = undefined;
			continue;
		}

		// 2. pytest verbose progress lines: "tests/foo.py::test_bar[a b] PASSED [ 50%]"
		const m2 = /^(\S+::.+?)\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)(?:\s+\[\s*\d+%\])?$/.exec(line);
		if (m2) {
			const rawStatus = m2[2]!;
			const status: "PASSED" | "FAILED" | "ERROR" | "SKIPPED" =
				rawStatus === "PASSED" || rawStatus === "XFAIL" || rawStatus === "XPASS"
					? "PASSED"
					: rawStatus === "FAILED"
						? "FAILED"
						: rawStatus === "ERROR"
							? "ERROR"
							: "SKIPPED";
			statusMap.set(m2[1]!.trim(), status);
			pendingDjangoTest = undefined;
			continue;
		}

		// 3. Django / unittest single-line verbose output: "test_foo (module.TestClass) ... ok"
		const m3 = /^(\S+\s+\([^)]+\))\s+\.\.\.\s+(ok|FAIL|ERROR|skipped|expected failure)/i.exec(line);
		if (m3) {
			statusMap.set(m3[1]!, normalizeDjangoStatus(m3[2]!));
			pendingDjangoTest = undefined;
			continue;
		}

		// 4. Django / unittest multi-line docstring output:
		//    Line N:   "test_foo (module.TestClass)"
		//    Line N+1: "Some test docstring ... ok"
		const m3Header = /^(\S+\s+\([^)]+\))$/.exec(line);
		if (m3Header) {
			pendingDjangoTest = m3Header[1]!;
			pendingDjangoAge = 0;
			continue;
		}
		if (pendingDjangoTest) {
			pendingDjangoAge += 1;
			const m3Tail = /\.\.\.\s+(ok|FAIL|ERROR|skipped|expected failure)\b/i.exec(line);
			if (m3Tail) {
				statusMap.set(pendingDjangoTest, normalizeDjangoStatus(m3Tail[1]!));
				pendingDjangoTest = undefined;
				continue;
			}
			if (pendingDjangoAge > 3) {
				pendingDjangoTest = undefined;
			}
		}

		// 5. SymPy `bin/test -C --verbose` lines: "test_issue_13031 ok" / "test_foo F" / "test_bar E" / "test_baz s"
		const m4 = /^(test_[A-Za-z0-9_]+)\s+(ok|F|E|s|X|f|w)(?:\s+\[.*\])?$/.exec(line);
		if (m4) {
			const code = m4[2]!;
			const status: "PASSED" | "FAILED" | "ERROR" | "SKIPPED" =
				code === "ok" || code === "f" || code === "X"
					? "PASSED"
					: code === "F"
						? "FAILED"
						: code === "E"
							? "ERROR"
							: "SKIPPED";
			statusMap.set(m4[1]!, status);
		}
	}

	// Fuzzy suffix matching for canonical expected test IDs that include module prefixes or parameterized variants
	for (const target of expectedTests) {
		if (statusMap.has(target)) continue;
		for (const [key, val] of statusMap.entries()) {
			if (key.endsWith(target) || target.endsWith(key)) {
				statusMap.set(target, val);
				break;
			}
		}
	}

	return statusMap;
}

export type SweBenchScoreOutcome =
	| { readonly resolved: true; readonly score: 1; readonly f2pPassed: number; readonly p2pPassed: number }
	| { readonly resolved: false; readonly score: number; readonly f2pPassed: number; readonly p2pPassed: number };

export function scoreSweBenchResults(
	statusMap: ReadonlyMap<string, "PASSED" | "FAILED" | "ERROR" | "SKIPPED">,
	failToPass: readonly string[],
	passToPass: readonly string[],
): SweBenchScoreOutcome {
	const f2pPassed = failToPass.filter((t) => statusMap.get(t) === "PASSED").length;
	const p2pPassed = passToPass.filter((t) => statusMap.get(t) === "PASSED").length;
	const f2pFrac = failToPass.length > 0 ? f2pPassed / failToPass.length : 1;
	const p2pFrac = passToPass.length > 0 ? p2pPassed / passToPass.length : 1;
	const resolved = f2pPassed === failToPass.length && p2pPassed === passToPass.length && failToPass.length > 0;
	if (resolved) {
		return { resolved: true, score: 1, f2pPassed, p2pPassed };
	}
	const score = Math.round((0.7 * f2pFrac + 0.3 * p2pFrac) * 10_000) / 10_000;
	return { resolved: false, score, f2pPassed, p2pPassed };
}

/**
 * Build the official repo-specific test command matching `swebench/harness/constants.py`:
 * - Django: `./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 <test_modules>`
 * - SymPy:  `PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose <test_files>`
 * - Pytest: `pytest --no-header -rA --tb=short -p no:cacheprovider <test_files>`
 */
export function buildSweBenchTestCommand(inst: Pick<SweBenchInstance, "repo" | "test_patch" | "FAIL_TO_PASS" | "PASS_TO_PASS" | "test_cmd">): string {
	if (inst.test_cmd) return inst.test_cmd;
	const patchFiles = parseTestPatchFiles(inst.test_patch);
	const allTests = [...inst.FAIL_TO_PASS, ...inst.PASS_TO_PASS];

	if (inst.repo === "django/django") {
		const modules = new Set<string>();
		// Official SWE-bench rule: derive Django test labels directly from modified `tests/.../*.py` files in test_patch
		for (const file of patchFiles) {
			if (!file.startsWith("tests/") || !file.endsWith(".py")) continue;
			const rel = file.slice("tests/".length, -".py".length);
			const mod = rel.replace(/\/__init__$/, "").replace(/\//g, ".");
			if (mod) modules.add(mod);
		}
		// Fallback: derive modules from test identifier strings if test_patch had no `tests/*.py` entries
		if (modules.size === 0) {
			for (const t of allTests) {
				const paren = /\(([^)]+)\)/.exec(t);
				if (paren?.[1]) {
					const parts = paren[1].split(".");
					modules.add(parts.slice(0, Math.max(1, parts.length - 1)).join("."));
				} else if (t.includes(".")) {
					const parts = t.split(".");
					modules.add(parts.slice(0, Math.max(1, parts.length - 2)).join("."));
				}
			}
		}
		const targets = [...modules].map(shellQuote).join(" ");
		return `./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 ${targets}`.trim();
	}

	if (inst.repo === "sympy/sympy") {
		const pyPatchFiles = patchFiles.filter((f) => f.endsWith(".py"));
		const targets = pyPatchFiles.length > 0 ? pyPatchFiles : [...new Set(allTests)];
		return `PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose ${targets.map(shellQuote).join(" ")}`.trim();
	}

	const pyPatchFiles = patchFiles.filter((f) => f.endsWith(".py"));
	const targets =
		pyPatchFiles.length > 0
			? pyPatchFiles
			: [...new Set(allTests.map((t) => t.split("::")[0]!).filter(Boolean))];
	return `pytest --no-header -rA --tb=short -p no:cacheprovider ${targets.map(shellQuote).join(" ")}`.trim();
}

function buildSweBenchExecHelperScript(opts: {
	image: string;
	platform: string;
	baseCommit: string;
}): string {
	return [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		"# Offline SWE-bench container test runner: applies your current git diff onto the image's",
		"# pristine /testbed (preserving compiled C/Cython .so extensions & conda testbed env)",
		"# with --network=none and zero extra repo copies.",
		'if [ "$#" -eq 0 ]; then',
		'  echo "Usage: ./.eval-exec <command...>" >&2',
		'  echo "Example: ./.eval-exec pytest tests/test_example.py" >&2',
		"  exit 2",
		"fi",
		'BASE_SHA="$(git rev-list --max-parents=0 HEAD | head -n 1)"',
		'TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/op-swe-exec.XXXXXX")"',
		'TMP_IDX="${TMP_DIR}/index"',
		'PATCH_FILE="${TMP_DIR}/agent.patch"',
		'trap \'rm -rf "${TMP_DIR}"\' EXIT',
		'GIT_INDEX_FILE="${TMP_IDX}" git read-tree HEAD',
		'GIT_INDEX_FILE="${TMP_IDX}" git add -A -- .',
		'GIT_INDEX_FILE="${TMP_IDX}" git diff --cached "${BASE_SHA}" -- . \\',
		'  ":(exclude)ISSUE.md" ":(exclude).eval-exec" ":(exclude).eval-tmp" \\',
		'  ":(exclude).swarm" ":(exclude).one_piece" ":(exclude).gemini" ":(exclude).grok" \\',
		'  ":(exclude).onepiece-eval.patch" ":(exclude).onepiece-snapshot.json" > "${PATCH_FILE}"',
		"docker run --rm --network=none \\",
		`  --platform ${shellQuote(opts.platform)} \\`,
		"  --memory 6g --cpus 4 --pids-limit 512 \\",
		'  -v "${PATCH_FILE}:/tmp/agent.patch:ro" \\',
		`  ${shellQuote(opts.image)} \\`,
		`  /bin/bash -c 'set -euo pipefail; cd /testbed; source /opt/miniconda3/etc/profile.d/conda.sh 2>/dev/null || true; conda activate testbed 2>/dev/null || true; git checkout --force "$1" >/dev/null 2>&1; shift; if [ -s /tmp/agent.patch ]; then git apply /tmp/agent.patch || patch --batch --fuzz=5 -p1 -i /tmp/agent.patch; fi; exec "$@"' _ ${shellQuote(opts.baseCommit)} "$@"`,
		"",
	].join("\n");
}

function appendGitExcludes(repoDir: string, patterns: readonly string[]): void {
	const infoDir = join(repoDir, ".git", "info");
	mkdirSync(infoDir, { recursive: true });
	const excludeFile = join(infoDir, "exclude");
	const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
	const existing = new Set(current.split(/\r?\n/).map((l) => l.trim()));
	const missing = patterns.filter((p) => !existing.has(p));
	if (missing.length) {
		const prefix = current.length && !current.endsWith("\n") ? "\n" : "";
		appendFileSync(excludeFile, `${prefix}${missing.join("\n")}\n`, "utf8");
	}
}

/**
 * Strict Docker-Only Port of SWE-bench Verified (`swe-bench-verified`).
 * - Official upstream Linux container execution (`--network=none`, exact `FAIL_TO_PASS` + `PASS_TO_PASS`).
 * - Shared scrubbed base-repo cache + `git clone --local --shared` (zero redundant Docker extractions across arms/seeds).
 * - Anti-cheat git history scrubbing so zero future commits or gold/test patches exist in agent workspaces.
 * - Includes offline `./.eval-exec` helper so agents can run real pytest / Django / SymPy tests inside the exact container env.
 */
export const sweBenchVerifiedTask: EvalTask = {
	id: "swe-bench-verified",
	title: "SWE-bench Verified (Strict Docker Official Container Port)",
	family: "coupled-swe",
	tier: "long-horizon",
	supportedN: [1, 2, 4, 8],
	defaultOptions: { arch: "auto", slice: "hard-multifile" },
	higherIsBetter: true,
	requiresDocker: true,

	async prepare({ seed, n, options, workDir, hiddenDir }): Promise<PreparedTask> {
		assertDockerDaemon();
		const inst = loadSweBenchInstance(options, seed);
		const pullIfMissing = options.pull !== "false";

		let image: string;
		let platform: "linux/arm64" | "linux/amd64";
		let resolvedArch: "arm64" | "x86_64";

		if (inst.docker_image) {
			resolvedArch = options.arch === "arm64" ? "arm64" : options.arch === "x86_64" ? "x86_64" : resolveHostDockerArch();
			platform = dockerPlatformForArch(resolvedArch);
			image = inst.docker_image;
			ensureDockerImage(image, { pullIfMissing, platform });
		} else if (options.arch === "arm64" || options.arch === "x86_64") {
			resolvedArch = options.arch;
			platform = dockerPlatformForArch(resolvedArch);
			image = officialSweBenchImage(inst.instance_id, resolvedArch);
			ensureDockerImage(image, { pullIfMissing, platform });
		} else {
			// Auto arch: prefer native host arch (arm64 on Apple Silicon), falling back cleanly to x86_64
			const hostArch = resolveHostDockerArch();
			const order: readonly ("arm64" | "x86_64")[] = hostArch === "arm64" ? ["arm64", "x86_64"] : ["x86_64"];
			const chosen = ensureFirstAvailableDockerImage(
				order.map((a) => ({
					arch: a,
					platform: dockerPlatformForArch(a),
					image: officialSweBenchImage(inst.instance_id, a),
				})),
				{ pullIfMissing },
			);
			image = chosen.image;
			platform = chosen.platform;
			resolvedArch = chosen.arch;
		}

		// Populate shared scrubbed base repo ONCE per (instance_id, base_commit, arch), then fast local clone
		const cacheRoot = resolve(options.cacheDir ?? join(tmpdir(), "onepiece-swebench-cache"));
		const cachedBase = ensureScrubbedDockerRepoCache({
			image,
			containerSrcPath: "/testbed",
			baseCommit: inst.base_commit,
			cacheDir: join(cacheRoot, `${inst.instance_id}-${inst.base_commit.slice(0, 12)}-${resolvedArch}`),
			platform,
		});

		mkdirSync(hiddenDir, { recursive: true });
		if (existsSync(workDir) && readdirSync(workDir).length === 0) {
			rmSync(workDir, { recursive: true, force: true });
		}
		if (existsSync(workDir)) {
			execFileSync("git", ["init", "-q"], { cwd: workDir, stdio: "ignore" });
			execFileSync("git", ["fetch", "--quiet", cachedBase, "HEAD"], { cwd: workDir, stdio: "ignore" });
			execFileSync("git", ["reset", "--hard", "-q", "FETCH_HEAD"], { cwd: workDir, stdio: "ignore" });
		} else {
			execFileSync("git", ["clone", "--quiet", "--local", "--shared", cachedBase, workDir], { stdio: "ignore" });
		}
		execFileSync("git", ["config", "user.email", "eval-base@onepiece.dev"], { cwd: workDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "EvalBase"], { cwd: workDir, stdio: "ignore" });
		appendGitExcludes(workDir, SWE_EXCLUDE_PATTERNS);

		// Write offline container test runner so agents can execute real tests inside the exact conda testbed image
		const execHelperPath = join(workDir, ".eval-exec");
		writeFileSync(execHelperPath, buildSweBenchExecHelperScript({ image, platform, baseCommit: inst.base_commit }), {
			encoding: "utf8",
			mode: 0o755,
		});
		try {
			chmodSync(execHelperPath, 0o755);
		} catch {
			// Ignore chmod errors.
		}

		const exampleTestCmd =
			inst.repo === "django/django"
				? "./.eval-exec ./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 <app.tests>"
				: inst.repo === "sympy/sympy"
					? "./.eval-exec bin/test -C --verbose <path/to/test_file.py>"
					: "./.eval-exec pytest -rA <path/to/test_file.py>";

		const issueMd =
			[
				`# SWE-bench Verified: ${inst.instance_id}`,
				"",
				`- **Repository:** \`${inst.repo}\``,
				`- **Base Commit:** \`${inst.base_commit.slice(0, 12)}\``,
				`- **Test Environment:** Run commands inside the official offline container (\`${image}\`) using \`./.eval-exec <cmd...>\`.`,
				`  - Example: \`${exampleTestCmd}\``,
				"",
				"## Problem Statement",
				"",
				inst.problem_statement.trim(),
				"",
				"## Deliverable Requirements",
				"- Implement the fix directly in this repository and commit your changes (or leave clean edits in the worktree).",
				"- Use `./.eval-exec ...` to reproduce the bug and verify existing & new tests inside the official Linux environment.",
				"- Do not modify or delete unrelated existing tests.",
				"- Your final git diff will be graded offline inside the official SWE-bench Linux container.",
			].join("\n") + "\n";
		writeFileSync(join(workDir, "ISSUE.md"), issueMd, "utf8");

		writeFileSync(
			join(hiddenDir, "instance.json"),
			JSON.stringify({ ...inst, docker_image: image, platform, arch: resolvedArch }, null, 2) + "\n",
		);

		const baseTreeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
			cwd: workDir,
			encoding: "utf8",
			timeout: 5_000,
		}).trim();

		return {
			taskId: "swe-bench-verified",
			seed,
			n,
			options: { ...options, instanceId: inst.instance_id, arch: resolvedArch },
			workspaceDir: workDir,
			hiddenDir,
			goal: `Resolve GitHub issue ${inst.instance_id} in ${inst.repo} per ISSUE.md. Verify your fix with ./.eval-exec and commit a clean, minimal fix.`,
			rubric: "Official SWE-bench Verified resolution: 100% of hidden FAIL_TO_PASS and PASS_TO_PASS tests must pass inside the official Linux Docker container.",
			fixtureSha256: sha256Text(`${baseTreeSha}:${issueMd}`),
			graderSha256: sha256Dir(hiddenDir),
			allowDockerSocket: true,
			sandboxProfile: "eval-offline",
		};
	},

	async publicCheck({ artifactDir }): Promise<PublicCheckResult> {
		try {
			const patch = extractModelPatch(artifactDir);
			if (!patch.trim()) {
				return { passed: false, score: 0, details: "Empty git diff (no source modifications yet)." };
			}
			const changedFiles = [...patch.matchAll(/^\+\+\+\s+b\/(.+)$/gm)].map((m) => m[1]!);
			const lineCount = patch.split("\n").length;
			return {
				passed: true,
				score: 0.25,
				details: `Non-empty patch (${lineCount} lines, ${changedFiles.length} file(s) modified).`,
			};
		} catch (error) {
			return { passed: false, score: 0, details: `Patch extraction failed: ${String(error).slice(0, 220)}` };
		}
	},

	async grade({ artifactDir, hiddenDir }): Promise<GradeReport> {
		assertDockerDaemon();
		const inst = JSON.parse(readFileSync(join(hiddenDir, "instance.json"), "utf8")) as SweBenchInstance & {
			docker_image: string;
			platform?: string;
		};
		const patch = extractModelPatch(artifactDir);
		if (!patch.trim()) {
			return {
				passed: false,
				score: 0,
				customMetrics: { instanceId: inst.instance_id, repo: inst.repo, resolved: false, emptyPatch: true },
				details: `No edits produced for ${inst.instance_id}.`,
			};
		}

		const evalDir = join(hiddenDir, "eval-stage");
		mkdirSync(evalDir, { recursive: true });
		writeFileSync(join(evalDir, "model.patch"), patch, "utf8");
		writeFileSync(join(evalDir, "test.patch"), inst.test_patch, "utf8");

		const testFiles = parseTestPatchFiles(inst.test_patch);
		const resetTestFilesCmd = testFiles.length
			? `git checkout --force ${shellQuote(inst.base_commit)} -- ${testFiles.map(shellQuote).join(" ")} 2>/dev/null || true`
			: "true";
		const testCmd = buildSweBenchTestCommand(inst);
		const script = [
			"set -euo pipefail",
			"cd /testbed",
			"source /opt/miniconda3/etc/profile.d/conda.sh 2>/dev/null || true",
			"conda activate testbed 2>/dev/null || true",
			`git checkout --force ${shellQuote(inst.base_commit)}`,
			"git apply --verbose /eval-stage/model.patch || patch --batch --fuzz=5 -p1 -i /eval-stage/model.patch",
			// Official SWE-bench protocol: reset test files touched by hidden test_patch before applying test_patch
			// so agent test additions never conflict with or weaken the official evaluation tests.
			resetTestFilesCmd,
			"git apply --verbose /eval-stage/test.patch",
			"set +e",
			testCmd,
			"EXIT_CODE=$?",
			'echo "__ONEPIECE_TEST_EXIT=${EXIT_CODE}"',
			"exit 0",
		].join("\n");

		const res = await runDockerContainer({
			image: inst.docker_image,
			platform: inst.platform,
			command: ["/bin/bash", "-c", script],
			mounts: [{ hostPath: evalDir, containerPath: "/eval-stage", readOnly: true }],
			networkDisabled: true,
			memoryLimit: "8g",
			cpus: "4",
			timeoutMs: 12 * 60_000,
		});

		if (res.timedOut || res.exitCode !== 0) {
			return {
				passed: false,
				score: 0,
				customMetrics: {
					instanceId: inst.instance_id,
					repo: inst.repo,
					resolved: false,
					dockerExitCode: res.exitCode,
					timedOut: res.timedOut,
				},
				details: `Docker grading failed (exit=${res.exitCode}, timedOut=${res.timedOut}): ${res.stderr.slice(-300)}`,
			};
		}

		const expected = [...inst.FAIL_TO_PASS, ...inst.PASS_TO_PASS];
		const statusMap = parseSweBenchTestOutput(res.stdout, res.stderr, expected);
		const scored = scoreSweBenchResults(statusMap, inst.FAIL_TO_PASS, inst.PASS_TO_PASS);
		return {
			passed: scored.resolved,
			score: scored.score,
			customMetrics: {
				instanceId: inst.instance_id,
				repo: inst.repo,
				resolved: scored.resolved,
				failToPassPassed: scored.f2pPassed,
				failToPassTotal: inst.FAIL_TO_PASS.length,
				passToPassPassed: scored.p2pPassed,
				passToPassTotal: inst.PASS_TO_PASS.length,
				patchLines: patch.split("\n").length,
				dockerImage: inst.docker_image,
			},
			details: `${inst.instance_id}: resolved=${scored.resolved} F2P=${scored.f2pPassed}/${inst.FAIL_TO_PASS.length} P2P=${scored.p2pPassed}/${inst.PASS_TO_PASS.length}`,
		};
	},

	async buildReferenceArtifact({ prepared, outDir }): Promise<void> {
		const inst = JSON.parse(readFileSync(join(prepared.hiddenDir, "instance.json"), "utf8")) as SweBenchInstance;
		if (!inst.patch) throw new Error(`Instance ${inst.instance_id} has no gold patch.`);
		const patchFile = join(prepared.hiddenDir, "gold.patch");
		writeFileSync(patchFile, inst.patch, "utf8");
		execFileSync("git", ["apply", patchFile], { cwd: outDir });
		execFileSync("git", ["add", "-A"], { cwd: outDir });
		execFileSync("git", ["commit", "-q", "-m", "gold reference"], { cwd: outDir });
	},
};
