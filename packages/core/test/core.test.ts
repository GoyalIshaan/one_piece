import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	commandPolicy,
	EventBus,
	FileArtifactStore,
	GitWorktreeManager,
	MemoryStore,
	Redactor,
	runCommand,
} from "../src/index.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function walkTsFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkTsFiles(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

describe("core v2 invariants", () => {
	it("enforces ZERO @earendil-works/pi-* imports in Layer B packages", () => {
		const layerBDirs = [
			"packages/core/src",
			"packages/store/src",
			"packages/mcp-bus/src",
			"packages/scheduler/src",
			"packages/module-board/src",
			"packages/module-secrets/src",
			"packages/module-workspace/src",
			"packages/engine/src",
		];
		const violations: string[] = [];
		for (const rel of layerBDirs) {
			for (const file of walkTsFiles(join(REPO_ROOT, rel))) {
				const src = readFileSync(file, "utf8");
				if (src.includes("@earendil-works/pi-")) violations.push(file);
			}
		}
		expect(violations).toEqual([]);
	});

	it("redacts secrets and deduplicates idempotency keys on EventBus", () => {
		const store = new MemoryStore();
		const redactor = new Redactor();
		redactor.addSecret("super-secret-token-xyz");
		const bus = new EventBus(store, redactor);

		const e1 = bus.emit("run-1", "test.event", { msg: "key=super-secret-token-xyz" }, "agt-1", { idempotencyKey: "k1" });
		const e2 = bus.emit("run-1", "test.event", { msg: "duplicate" }, "agt-1", { idempotencyKey: "k1" });
		expect(e1.seq).toBe(e2.seq);
		expect(e1.data.msg).toBe("key=[redacted]");
		expect(store.events("run-1")).toHaveLength(1);
	});

	it("stores content-addressed artifacts with UTF-8 boundary-safe paging", () => {
		const dir = mkdtempSync(join(tmpdir(), "op-art-"));
		try {
			const bus = new EventBus(new MemoryStore(), new Redactor());
			const store = new FileArtifactStore("run-1", dir, bus);
			const content = "hello 🚀 world ".repeat(100);
			const rec = store.put("test-log", content, { createdBy: "agt-1" });
			const same = store.put("test-log-dup", content);
			expect(same.id).toBe(rec.id);

			let offset = 0;
			let rebuilt = "";
			for (;;) {
				const page = store.read(rec.id, offset, 37);
				rebuilt += page.content;
				offset = page.nextOffset;
				if (page.eof) break;
			}
			expect(rebuilt).toBe(content);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("manages isolated git worktrees, WIP commits, and clean trunk merges", () => {
		const dir = mkdtempSync(join(tmpdir(), "op-wt-"));
		try {
			const seed = join(dir, "seed");
			const runDir = join(dir, "run");
			mkdirSync(seed, { recursive: true });
			writeFileSync(join(seed, "a.txt"), "base\n", "utf8");

			const mgr = new GitWorktreeManager(seed, runDir, "run-wt");
			const wt = mgr.create("agt-1");
			writeFileSync(join(wt.path, "b.txt"), "hello\n", "utf8");
			const sha = mgr.commitWip(wt.path, "add b.txt");
			expect(sha).toBeTruthy();

			const merged = mgr.mergeIntoTrunk(wt.branch);
			expect(merged.ok).toBe(true);
			expect(readFileSync(join(mgr.trunkPath, "b.txt"), "utf8")).toBe("hello\n");
			mgr.remove(wt.path);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("enforces sandbox command policy and offline network blocking", async () => {
		expect(commandPolicy("sudo rm -rf /")).toBeTruthy();
		expect(commandPolicy("git push --force origin main")).toBeTruthy();

		const dir = mkdtempSync(join(tmpdir(), "op-sb-"));
		try {
			const ok = await runCommand({ command: "echo hi", cwd: dir, profile: "job", networkOff: true, timeoutMs: 5_000 });
			expect(ok.exitCode).toBe(0);
			expect(ok.stdout.trim()).toBe("hi");
			if (process.platform === "darwin") {
				const net = await runCommand({
					command: "node -e \"fetch('https://example.com').then(()=>process.exit(0)).catch(()=>process.exit(42))\"",
					cwd: dir,
					profile: "job",
					networkOff: true,
					timeoutMs: 5_000,
				});
				expect(net.exitCode).not.toBe(0);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
