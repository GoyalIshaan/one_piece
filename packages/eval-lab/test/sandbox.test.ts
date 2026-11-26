import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectHarnessFaults, runSandboxedEvalCommand, sha256Dir } from "../src/sandbox.ts";

describe("eval-lab offline sandbox & integrity", () => {
	it("hashes directories deterministically and ignores .git and __pycache__", () => {
		const a = mkdtempSync(join(tmpdir(), "eval-hash-a-"));
		const b = mkdtempSync(join(tmpdir(), "eval-hash-b-"));
		try {
			mkdirSync(join(a, "sub"), { recursive: true });
			mkdirSync(join(b, "sub"), { recursive: true });
			writeFileSync(join(a, "sub", "x.py"), "print(1)\n");
			writeFileSync(join(b, "sub", "x.py"), "print(1)\n");
			mkdirSync(join(a, "__pycache__"));
			writeFileSync(join(a, "__pycache__", "x.cpython-312.pyc"), "junk");
			expect(sha256Dir(a)).toBe(sha256Dir(b));
			writeFileSync(join(b, "sub", "x.py"), "print(2)\n");
			expect(sha256Dir(a)).not.toBe(sha256Dir(b));
		} finally {
			rmSync(a, { recursive: true, force: true });
			rmSync(b, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform !== "darwin")(
		"enforces network-off and hidden/sibling-shard read denial under macOS Seatbelt",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "eval-sb-"));
			try {
				const work = join(root, "work");
				const hidden = join(root, "hidden");
				const shard0 = join(root, "shard-0");
				const shard1 = join(root, "shard-1");
				for (const d of [work, hidden, shard0, shard1]) mkdirSync(d, { recursive: true });
				writeFileSync(join(hidden, "secret.txt"), "TOP_SECRET");
				writeFileSync(join(shard0, "shard.json"), '{"seat":0}');
				writeFileSync(join(shard1, "shard.json"), '{"seat":1}');

				// 1. Outbound network denied
				const net = await runSandboxedEvalCommand({
					cwd: work,
					profile: "eval-offline",
					deniedDirs: [hidden],
					command: `python3 -c "import socket; socket.create_connection(('1.1.1.1', 80), timeout=1)"`,
					timeoutMs: 5000,
				});
				expect(net.sandboxed).toBe(true);
				expect(net.exitCode).not.toBe(0);

				// 2. Hidden directory denied in eval-offline
				const hiddenRead = await runSandboxedEvalCommand({
					cwd: work,
					profile: "eval-offline",
					deniedDirs: [hidden],
					command: `cat "${join(hidden, "secret.txt")}"`,
					timeoutMs: 5000,
				});
				expect(hiddenRead.exitCode).not.toBe(0);
				expect(hiddenRead.stdout).not.toContain("TOP_SECRET");

				// 3. eval-isolated-shards allows own shard + workspace write, denies sibling shard
				const ownRead = await runSandboxedEvalCommand({
					cwd: work,
					profile: "eval-isolated-shards",
					readableDirs: [shard0],
					deniedDirs: [hidden, shard1],
					command: `cat "${join(shard0, "shard.json")}" > out.txt`,
					timeoutMs: 5000,
				});
				expect(ownRead.exitCode).toBe(0);
				expect(readFileSync(join(work, "out.txt"), "utf8")).toContain('"seat":0');
				expect(ownRead.cpuSeconds).toBeGreaterThanOrEqual(0);

				const siblingRead = await runSandboxedEvalCommand({
					cwd: work,
					profile: "eval-isolated-shards",
					readableDirs: [shard0],
					deniedDirs: [hidden, shard1],
					command: `cat "${join(shard1, "shard.json")}"`,
					timeoutMs: 5000,
				});
				expect(siblingRead.exitCode).not.toBe(0);
				expect(siblingRead.stdout).not.toContain('"seat":1');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("detects token ledger mismatch, silent patch no-op, duplicate job charge, and orphan agents", () => {
		const faults = detectHarnessFaults(
			[
				{ seq: 1, ts: 100, runId: "r1", type: "run.started", data: {} },
				{ seq: 2, ts: 110, runId: "r1", type: "agent.status", agentId: "w0", data: { status: "running" } },
				{ seq: 3, ts: 120, runId: "r1", type: "model.call", agentId: "w0", data: { totalTokens: 500 } },
				{
					seq: 4,
					ts: 130,
					runId: "r1",
					type: "tool.result",
					agentId: "w0",
					data: { tool: "bash", isError: false, text: "apply_patch: command not found" },
				},
				{ seq: 5, ts: 140, runId: "r1", type: "job.finished", agentId: "w0", data: { jobId: "j1", charged: true } },
				{ seq: 6, ts: 150, runId: "r1", type: "job.finished", agentId: "w0", data: { jobId: "j1", charged: true } },
			],
			{
				runId: "r1",
				status: "failed",
				autoNominated: false,
				candidateSnapshots: [],
				harnessFaults: [],
			},
			999, // ledger mismatch vs 500
		);
		const codes = new Set(faults.map((f) => f.code));
		expect(codes.has("MISSING_TERMINAL_EVENT")).toBe(true);
		expect(codes.has("TOKEN_LEDGER_MISMATCH")).toBe(true);
		expect(codes.has("SILENT_PATCH_NOOP")).toBe(true);
		expect(codes.has("DUPLICATE_JOB_CHARGE")).toBe(true);
		expect(codes.has("ORPHAN_ACTIVE_AGENT")).toBe(true);
	});
});
