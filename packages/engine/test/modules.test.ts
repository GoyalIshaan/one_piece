import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Assumption, type BoardPost, type Finding, MemoryStore, type Question } from "@one-piece/core";
import { boardModule } from "@one-piece/module-board";
import { questionsModule } from "@one-piece/module-questions";
import { secretsModule } from "@one-piece/module-secrets";
import { workspaceModule } from "@one-piece/module-workspace";
import { Router } from "@one-piece/router";
import { schedulerModule } from "@one-piece/scheduler";
import { describe, expect, it } from "vitest";
import { createHarness, simPolicy } from "../src/index.ts";

describe("engine with every module plugged in", () => {
	it("runs leaves in sandboxed workspaces with boards, questions and an evidence-rich report", async () => {
		const store = new MemoryStore();
		const runDir = mkdtempSync(join(tmpdir(), "op-mod-"));
		const seed = mkdtempSync(join(tmpdir(), "op-seed-"));
		writeFileSync(join(seed, "README.md"), "seed project\n");
		const router = new Router({ providers: [{ id: "sim", models: { default: "sim-a" }, maxConcurrent: 8, requestsPerMinute: 100000 }], simPolicy });
		const all = { questions: "active", board: "active", workspace: "active", scheduler: "active", secrets: "deferred" } as const;
		const harness = createHarness({
			store,
			router,
			modules: [
				questionsModule({ pollMs: 50 }),
				boardModule(),
				workspaceModule(),
				schedulerModule([{ name: "cpu", unit: "cpu_seconds", capacity: 2, kind: "local" }]),
				secretsModule({ secrets: [{ name: "demo.key", env: "DEMO_KEY" }], lookup: () => "sk-demo-secret-value-123" }),
			],
			config: { runDir, seedWorkspace: seed, maxConcurrentAgents: 4, profile: all },
		});
		const run = await harness.start({ title: "Module test", text: "Find the value." }, { tokens: 400_000 });
		await harness.done;

		const leaves = harness.tree.all().filter((n) => n.role === "leaf");
		expect(leaves.length).toBe(3);
		for (const leaf of leaves) {
			const ws = harness.workspaceOf(leaf.id)!;
			expect(readFileSync(join(ws, "result.md"), "utf8")).toContain("value = 42");
			expect(existsSync(join(ws, "README.md"))).toBe(true); // seed copied
		}
		const findings = store.list<Finding>("findings", { runId: run.id });
		expect(findings.filter((f) => f.status === "accepted").length).toBeGreaterThanOrEqual(3);
		expect(store.list<Question>("questions", { runId: run.id }).length).toBe(3);
		expect(store.list<Assumption>("assumptions", { runId: run.id }).length).toBeGreaterThanOrEqual(3);
		const posts = store.list<BoardPost>("posts", { runId: run.id });
		expect(posts.some((p) => p.kind === "peer_review")).toBe(true);
		expect(posts.some((p) => p.kind === "checkpoint")).toBe(true);
		const report = readFileSync(join(runDir, "report.md"), "utf8");
		expect(report).toContain("Assumptions taken");
		expect(report).toContain("input size small");
		expect(store.events(run.id, { types: ["workspace.command"] }).length).toBe(3);
	});
});
