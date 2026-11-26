import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TASKS_DIR } from "../src/index.ts";

it("scores a tour against the generated city coordinates even if the workspace copy changes", () => {
	const dir = mkdtempSync(join(tmpdir(), "tour-grader-"));
	const task = join(TASKS_DIR, "tsp-tour");
	const ws = join(dir, "workspace"), hidden = join(dir, "hidden");
	try {
		execFileSync("python3", [join(task, "prepare.py"), ws, hidden, "742"]);
		const cities = readFileSync(join(ws, "cities.txt"), "utf8").trim().split("\n").slice(1).map(line => line.split(" ").map(Number));
		writeFileSync(join(ws, "tour.txt"), cities.map((_, i) => i).join("\n"));
		const expected = cities.reduce((sum, [x,y], i) => {
			const [nx,ny] = cities[(i + 1) % cities.length];
			return sum + Math.hypot(nx-x, ny-y);
		}, 0);
		writeFileSync(join(ws, "cities.txt"), "1\n0 0\n");
		const grade = () => JSON.parse(execFileSync("python3", [join(task, "grader/grade.py"), ws, hidden], { encoding: "utf8" }));
		expect(grade().raw).toBeCloseTo(expected, 6);
		writeFileSync(join(ws, "tour.txt"), "0");
		expect(grade().passed).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
