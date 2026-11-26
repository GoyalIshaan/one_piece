import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus, MemoryStore, Redactor } from "@one-piece/core";
import { Scheduler } from "../src/index.ts";

describe("Scheduler v2", () => {
	it("runs sandboxed jobs, fingerprints required outputs, caches identical inputs, and enforces preflight gates", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-sched-"));
		try {
			const store = new MemoryStore();
			const bus = new EventBus(store, new Redactor());
			const scheduler = new Scheduler(
				{
					runId: "r1",
					bus,
					store,
					isRunActive: () => true,
					workspaceOf: () => dir,
				},
				[{ name: "cpu", unit: "cpu_seconds", capacity: 2, kind: "local" }],
			);

			try {
				// 1. Required output fingerprinting
				const j1 = scheduler.submit("agt-1", {
					pool: "cpu",
					command: "echo verified > out.txt",
					outputFiles: ["out.txt"],
					requireOutputs: true,
				});
				const r1 = await scheduler.wait(j1.id);
				expect(r1.status).toBe("succeeded");
				expect(r1.receipt?.outputFiles?.[0]?.sha256).toBeTruthy();

				// 2. Missing required output fails even with exit 0
				const j2 = scheduler.submit("agt-1", {
					pool: "cpu",
					command: "echo ok",
					outputFiles: ["never-created.txt"],
					requireOutputs: true,
				});
				const r2 = await scheduler.wait(j2.id);
				expect(r2.status).toBe("failed");

				// 3. Content-addressed caching
				writeFileSync(join(dir, "in.txt"), "v1\n", "utf8");
				const j3 = scheduler.submit("agt-1", { pool: "cpu", command: "cat in.txt", inputs: ["in.txt"], cache: true });
				const r3 = await scheduler.wait(j3.id);
				expect(r3.status).toBe("succeeded");
				const j4 = scheduler.submit("agt-1", { pool: "cpu", command: "cat in.txt", inputs: ["in.txt"], cache: true });
				const r4 = await scheduler.wait(j4.id);
				expect(r4.status).toBe("cached");

				// 4. Preflight gate failure blocks execution
				const j5 = scheduler.submit("agt-1", { pool: "cpu", command: "echo should-not-run", gate: "exit 1" });
				const r5 = await scheduler.wait(j5.id);
				expect(r5.status).toBe("failed");
				expect(r5.failureStage).toBe("gate");
			} finally {
				await scheduler.dispose();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
