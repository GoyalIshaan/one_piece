import { describe, expect, it } from "vitest";
import { MemoryStore } from "@one-piece/core";
import { startDashboard } from "../src/index.ts";

describe("dashboard v2", () => {
	it("serves normalized v2 runs, details, and events over local HTTP", async () => {
		const store = new MemoryStore();
		store.put("runs", {
			id: "run-1",
			topology: "hierarchy",
			goal: { title: "Demo goal", text: "Demo" },
			budget: { tokens: 1000 },
			spent: {},
			status: "done",
			config: {},
			createdAt: 1000,
			updatedAt: 2000,
		});
		store.appendEvent({ ts: 1500, runId: "run-1", type: "run.started", data: { topology: "hierarchy" } });

		const handle = await startDashboard(store, { port: 0 });
		try {
			const html = await fetch(`${handle.url}/`);
			expect(html.status).toBe(200);
			expect(await html.text()).toContain("one_piece v2");

			const runs = (await (await fetch(`${handle.url}/api/runs`)).json()) as any;
			expect(runs.runs).toHaveLength(1);
			expect(runs.runs[0].topology).toBe("hierarchy");

			const detail = (await (await fetch(`${handle.url}/api/runs/run-1`)).json()) as any;
			expect(detail.run.id).toBe("run-1");

			const evs = (await (await fetch(`${handle.url}/api/runs/run-1/events`)).json()) as any;
			expect(evs.events).toHaveLength(1);
		} finally {
			await handle.close();
		}
	});
});
