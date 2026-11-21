import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandPolicy, EventBus, MemoryStore, Redactor, runCommand, SwarmTree } from "../src/index.ts";

function tree() {
	const bus = new EventBus(new MemoryStore(), new Redactor());
	return new SwarmTree(bus);
}

describe("budgets", () => {
	it("inherits, rolls up, refunds and reclaims", () => {
		const t = tree();
		const root = t.create({ runId: "r", epoch: 1, role: "root", goal: { title: "g", text: "g" }, budget: { tokens: 1000 } });
		const share = t.carve(root.id, 0.4, 1);
		expect(share.tokens).toBe(400);
		const child = t.create({ runId: "r", epoch: 1, role: "leaf", parentId: root.id, goal: { title: "c", text: "c" }, budget: share });
		expect(t.available(root.id, "tokens")).toBe(600);
		t.charge(child.id, { tokens: 100 });
		expect(t.subtreeSpent(root.id).tokens).toBe(100);
		expect(t.fractionSpent(child.id)).toBeCloseTo(0.25);
		const taken = t.reclaim(child.id, 0.5);
		expect(taken.tokens).toBe(150);
		expect(t.available(root.id, "tokens")).toBe(750);
		t.setStatus(child.id, "done");
		// The leftover (250 - 100 = 150) flows back to the parent.
		expect(t.available(root.id, "tokens")).toBe(900);
	});

	it("deducts child overages and late review usage from the parent allocation", () => {
		const t = tree();
		const root = t.create({ runId: "r", epoch: 1, role: "root", goal: { title: "g", text: "g" }, budget: { tokens: 1000 } });
		const child = t.create({ runId: "r", epoch: 1, role: "leaf", parentId: root.id, goal: { title: "c", text: "c" }, budget: { tokens: 400 } });
		t.charge(child.id, { tokens: 390 });
		t.chargeOversight(child.id, { tokens: 110 });
		t.setStatus(child.id, "done");
		expect(t.available(root.id, "tokens")).toBe(500);
		t.chargeOversight(child.id, { tokens: 20 });
		expect(t.available(root.id, "tokens")).toBe(480);
		expect(t.carve(root.id, 0.5, 1, { tokens: 300 }).tokens).toBe(150);
	});

	it("enforces soft caps on children and depth", () => {
		const t = tree();
		const root = t.create({ runId: "r", epoch: 1, role: "root", goal: { title: "g", text: "g" }, budget: {}, caps: { maxChildren: 2, maxDepth: 1 } });
		expect(t.canSpawn(root.id, 3).ok).toBe(false);
		expect(t.canSpawn(root.id, 2).ok).toBe(true);
		const child = t.create({ runId: "r", epoch: 1, role: "internal", parentId: root.id, goal: { title: "c", text: "c" }, budget: {} });
		expect(t.canSpawn(child.id, 1).ok).toBe(false); // depth cap
	});
});

describe("redaction", () => {
	it("removes registered secrets and common key shapes", () => {
		const r = new Redactor();
		r.addSecret("my-very-private-value");
		const out = r.redact({ text: "key my-very-private-value and sk-abcdefghijklmnopqrstu", apiKey: "x", nested: ["Bearer abcdefghijklmnopqrstuvwxyz"] });
		expect(JSON.stringify(out)).not.toContain("my-very-private-value");
		expect(JSON.stringify(out)).not.toContain("sk-abcdefghijklmnopqrstu");
		expect(out.apiKey).toBe("[redacted]");
		expect(out.nested[0]).toBe("Bearer [redacted]");
	});
});

describe("sandbox", () => {
	it("refuses privileged and destructive commands", () => {
		expect(commandPolicy("sudo rm -rf /")).toBeDefined();
		expect(commandPolicy("rm -rf ~")).toBeDefined();
		expect(commandPolicy("git push --force origin main")).toBeDefined();
		expect(commandPolicy("rm -rf build && python run.py")).toBeUndefined();
	});

	it.runIf(process.platform === "darwin")("confines writes to the workspace", async () => {
		const ws = mkdtempSync(join(tmpdir(), "op-sbx-"));
		writeFileSync(join(ws, "in.txt"), "inside");
		const outside = join(homedir(), `.op-sandbox-probe-${Date.now()}`);
		const ok = await runCommand({ command: "cat in.txt && echo hi > out.txt && cat out.txt", cwd: ws, profile: "worker" });
		expect(ok.exitCode).toBe(0);
		expect(ok.stdout).toContain("hi");
		const denied = await runCommand({ command: `echo bad > ${outside}`, cwd: ws, profile: "worker" });
		expect(denied.exitCode).not.toBe(0);
	});

	it.runIf(process.platform === "darwin")("blocks the network for jobs", async () => {
		const ws = mkdtempSync(join(tmpdir(), "op-sbx-"));
		const res = await runCommand({ command: "curl -s -m 5 https://example.com > /dev/null && echo reached || echo blocked", cwd: ws, profile: "job" });
		expect(res.stdout).toContain("blocked");
	});
});

describe("budget splits", () => {
	it("keeps cents when splitting dollars", () => {
		const t = tree();
		const root = t.create({ runId: "r", epoch: 1, role: "root", goal: { title: "g", text: "g" }, budget: { tokens: 1000, usd: 1 } });
		const share = t.carve(root.id, 0.3, 1);
		expect(share.usd).toBe(0.3);
		expect(share.tokens).toBe(300);
	});
});
