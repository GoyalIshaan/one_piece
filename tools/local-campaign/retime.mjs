import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { grade, TASKS_DIR } from "@one-piece/evals";
import verificationModule from "../../packages/evals/tasks/perf-algos/verification/index.ts";

const [input, output, comparison = "final-arms"] = process.argv.slice(2);
if (!input || !output) throw Error("Provide campaign directory and output JSON");
if (!["final-arms", "candidate-revisions", "verification"].includes(comparison)) throw Error("Unknown comparison");
const folder = resolve(input);
const arms = ["baseline", "hillclimb"];
const cases = Object.fromEntries(arms.map(arm => [
	arm, JSON.parse(readFileSync(join(folder, "perf-algos-" + arm + ".json"), "utf8"))
]));
if (cases.baseline.result.gradingInputs.hiddenSha256 !== cases.hillclimb.result.gradingInputs.hiddenSha256) {
	throw Error("Hidden performance graders differ across arms");
}
if (comparison === "verification") {
	const verifier = verificationModule({entryPoint: "algos.py"}).findingVerifier;
	const checks = [];
	for (const arm of arms) {
		for (const snapshot of cases[arm].revisions) {
			const grade = await verifier.check({workspace: snapshot.snapshot, artifactSha256: snapshot.sha256,
				scope: "integrated", signal: AbortSignal.timeout(60000)});
			checks.push({arm, revision: snapshot.revision, artifact: snapshot.sha256, grade});
		}
	}
	writeFileSync(output, JSON.stringify({checker: verifier.name, version: verifier.version,
		scope: "integrated", cases: checks}, null, 2) + "\n");
	process.exit(0);
}
const rounds = [];
const variants = comparison === "final-arms"
	? arms.map(arm => ({ arm, revision: "final" }))
	: ["first", "final"].map(revision => ({ arm: "hillclimb", revision }));
for (let pair = 0; pair < 8; pair++) {
	const order = pair % 2 ? [...variants].reverse() : variants;
	for (const {arm, revision} of order) {
		const row = cases[arm];
		const snapshot = revision === "final" ? row.revisions.at(-1) : row.revisions[0];
		if (!snapshot) {
			rounds.push({pair, arm, revision, nomination: null, grade: {score: 0, passed: false, details: "Missing nomination"}});
			continue;
		}
		for (const [path, expected] of snapshot.files) {
			const actual = createHash("sha256").update(readFileSync(join(snapshot.snapshot, path))).digest("hex");
			if (actual !== expected) throw Error("Frozen submission changed: " + path);
		}
		const hidden = join(dirname(row.report), "private-inputs", "perf-algos");
		const result = grade(join(TASKS_DIR, "perf-algos"), hidden, snapshot.snapshot);
		rounds.push({pair, arm, revision, nomination: snapshot.sha256, grade: result});
	}
}
writeFileSync(output, JSON.stringify({comparison, pairs: 8, hiddenSha256: cases.baseline.result.gradingInputs.hiddenSha256, rounds}, null, 2) + "\n");
