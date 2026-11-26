import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { type FindingVerifier, type VerificationModule, runCommand } from "@one-piece/core";

import legacyModule from "../verification-legacy/index.ts";

const functions = ["lis_length", "count_inversions", "top_k_frequent"] as const;
const fixtures = {
	lis_length: ["none", "mapping", "varying_length", "metaclass"],
	count_inversions: ["varying_length", "reverse_iterator", "metaclass"],
	top_k_frequent: ["iterator", "unhashable_word", "none_slice", "index_slice"],
};
type FunctionName = typeof functions[number];
type Example = { function: FunctionName; args: unknown[] } | { function: FunctionName; fixture: string };
type Outcomes = Array<[Example, unknown]>;
type Check = Awaited<ReturnType<FindingVerifier["check"]>>;

function exampleFor(input: string, scope: string): Example {
	const example = JSON.parse(input);
	const name = example?.function as FunctionName;
	if (!functions.includes(name)) throw new Error("Choose lis_length, count_inversions or top_k_frequent");
	if (scope !== "integrated" && scope !== name) throw new Error(`${name} is outside the scope ${scope}`);
	if (fixtures[name].includes(example.fixture)) return { function: name, fixture: example.fixture };
	const args: unknown = example.args;
	if (!Array.isArray(args) || !Array.isArray(args[0]) || args[0].length > 128) throw new Error("Expected an args array whose first element is a list of at most 128 values");
	const values: unknown[] = args[0];
	const valid = name === "top_k_frequent"
		? args.length === 2 && (args[1] === null || Number.isSafeInteger(args[1])) && values.every((value) => typeof value === "string")
		: args.length === 1 && values.every((value) =>
			typeof value === "number" && Number.isFinite(value) || value === "NaN" || value === "Infinity" || value === "-Infinity"
		);
	if (!valid) throw new Error("Inputs do not match the function's supported challenge format");
	return { function: name, args };
}

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export default function createVerificationModule(options: Record<string, unknown>): VerificationModule {
	if (typeof options.entryPoint !== "string" || !options.entryPoint.endsWith(".py")) {
		throw new Error("The algorithm verifier requires a Python entryPoint");
	}
	const entryPoint = normalize(options.entryPoint);
	if (isAbsolute(entryPoint) || entryPoint === ".." || entryPoint.startsWith(`..${sep}`)) {
		throw new Error("The entryPoint must be inside the submitted workspace");
	}
	const reference = readFileSync(new URL("../grader/reference_slow.py", import.meta.url));
	const probe = readFileSync(new URL("./probe.py", import.meta.url), "utf8");
	const version = createHash("sha256").update(reference).update(probe)
		.update(readFileSync(new URL(import.meta.url))).update(entryPoint).digest("hex").slice(0, 12);
	const cache = new Map<string, Check>();
	let legacyChecker: FindingVerifier | undefined;
	const seedOutcomes = new Map<string, Outcomes>();

	async function run(workspace: string | undefined, mode: string, scope: string, example: Example | null, signal: AbortSignal): Promise<unknown> {
		signal.throwIfAborted();
		const scratch = mkdtempSync(join(tmpdir(), "op-perf-verify-"));
		try {
			if (workspace) cpSync(workspace, scratch, { recursive: true });
			const settings = { entryPoint, example, reference: workspace ? undefined : reference.toString("utf8") };
			const command = ["python3", "-I", "-B", "-c", probe, mode, scope, Buffer.from(JSON.stringify(settings)).toString("base64")].map(shellQuote).join(" ");
			const result = await runCommand({ command, cwd: scratch, profile: "job", isolatedWrites: true, signal, timeoutMs: 15_000, maxOutput: 256_000 });
			signal.throwIfAborted();
			if (result.exitCode !== 0 || result.timedOut) {
				throw new Error(result.timedOut ? "Timed out after 15 seconds" : `Python probe exited ${result.exitCode}: ${result.stderr.slice(-400).trim()}`);
			}
			return JSON.parse(result.stdout);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}

	async function check(workspace: string, scope: string, example: Example | null, signal: AbortSignal): Promise<Check> {
		const entry = join(workspace, entryPoint);
		if (!existsSync(entry) || !lstatSync(entry).isFile()) {
			return { status: "failed", message: `The required public entry point ${entryPoint} is missing.` };
		}
		if (!example && readFileSync(entry).equals(reference)) {
			return { status: "failed", message: `The submitted public entry point ${entryPoint} is byte-for-byte the original. Integrate the changes into ${entryPoint} before reporting an implementation.` };
		}
		const inputs = JSON.stringify([scope, example]);
		const [seed, candidateCheck] = await Promise.allSettled([
			seedOutcomes.get(inputs) ?? run(undefined, "check", scope, example, signal),
			run(workspace, "check", scope, example, signal),
		]);
		signal.throwIfAborted();
		if (seed.status === "rejected") throw seed.reason;
		const expected = seed.value as Outcomes;
		seedOutcomes.set(inputs, expected);
		if (candidateCheck.status === "rejected") {
			return { status: "failed", message: `Submitted ${entryPoint} could not complete the check. ${candidateCheck.reason}`, counterexample: example ? JSON.stringify(example) : undefined };
		}
		const actual = candidateCheck.value as Outcomes;
		if (!Array.isArray(actual) || expected.length !== actual.length) {
			return { status: "failed", message: "The candidate did not complete all differential cases." };
		}
		const mismatches = expected.flatMap(([input, want], index) => {
			const row = actual[index];
			const [observedInput, got] = Array.isArray(row) ? row : [];
			return JSON.stringify([input, want]) === JSON.stringify([observedInput, got]) ? [] : [{ input, want, got }];
		});
		if (mismatches.length) {
			const { input, want, got } = mismatches[0]!;
			return {
				status: "failed", counterexample: JSON.stringify(input),
				message: `${mismatches.length}/${expected.length} differential cases failed. ${JSON.stringify(input)}: reference ${JSON.stringify(want)}, candidate ${JSON.stringify(got)}.`,
			};
		}
		const matched = `Matched the original on ${expected.length} ${expected.length === 1 ? "case" : "differential cases"}.`;
		if (example) return { status: "passed", message: `${matched} Replayed ${JSON.stringify(example)}.`, counterexample: JSON.stringify(example) };
		if (scope !== "integrated") return { status: "passed", message: matched };
		// Keep the two benchmark processes sequential so they do not compete with one another.
		const base = await run(undefined, "benchmark", scope, null, signal) as Record<FunctionName, number>;
		const candidate = await run(workspace, "benchmark", scope, null, signal) as Record<FunctionName, number>;
		const ratios = functions.map((name) => base[name] / candidate[name]);
		if (!ratios.every((ratio) => ratio > 0 && Number.isFinite(ratio))) return { status: "error", message: "Benchmark returned invalid timings." };
		const mean = Math.exp(ratios.reduce((total, ratio) => total + Math.log(ratio), 0) / ratios.length);
		const timing = functions.map((name, index) => `${name} ${ratios[index]!.toFixed(2)}×`).join(", ");
		const summary = `${matched} Median of three runs per function: ${timing}. Geometric mean ${mean.toFixed(2)}×.`;
		return mean >= 1.05
			? { status: "passed", message: summary }
			: { status: "failed", message: `${summary} The integrated claim requires a measured speedup of at least 1.05×.` };
	}

	return {
		manifest: {
			name: "perf-verification", version, summary: `Compare submitted ${entryPoint} against the original before benchmarking`,
			roles: ["leaf"], tools: [], contextCostTokens: 120,
		},
		prompt: () => `For report_finding, the default integrated scope checks all three exported functions then measures speed. Use verification_scope equal to a function name to claim correctness for a single export. Integrate the implementation into ${entryPoint} and report early. If a check fails, fix the file and resubmit the same finding ID to replay it.`,
		findingVerifier: {
			name: "perf-algos", version, defaultScope: "integrated", scopes: ["integrated", ...functions],
			challengeHelp: 'Supply JSON like {"function":"lis_length","args":[[0,"NaN",1]]} or {"function":"top_k_frequent","fixture":"unhashable_word"}. The original supplies the expected result.',
			previousVersion(requested) {
				legacyChecker ??= legacyModule(options).findingVerifier;
				return legacyChecker.version === requested ? legacyChecker : undefined;
			},
			async check({ workspace, artifactSha256, scope, challenge, signal }) {
				let example: Example | null = null;
				if (challenge !== undefined) {
					try { example = exampleFor(challenge, scope); }
					catch (error) { return { status: "invalid", message: String(error) }; }
				}
				const key = JSON.stringify([version, artifactSha256, scope, example]);
				// Cache completed receipts only; a cancelled author must not cancel another author's check.
				const existing = cache.get(key);
				if (existing) return existing;
				const result = await check(workspace, scope, example, signal);
				if (!signal.aborted && result.status !== "error") cache.set(key, result);
				return result;
			},
		},
	};
}
