import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	EventBus,
	MemoryStore,
	Redactor,
	type WorkerDriver,
	type WorkerSession,
} from "@one-piece/core";
import {
	createDecisionClientFromEnv,
	DriverQuotaRouter,
	JevDecisionClient,
	loadEnvKey,
	PhysicsConcurrencyGovernor,
} from "../src/index.ts";

function fakeDriver(id: string): WorkerDriver {
	return {
		id,
		kind: "pi-in-process",
		capabilities: { supportsSteer: true, supportsResume: true, supportsOutputSchema: true, supportsMcpHttp: false },
		async healthCheck() {
			return { ok: true, driverId: id, kind: "pi-in-process" };
		},
		async spawn(): Promise<WorkerSession> {
			return {
				driverId: id,
				async runTurn() {
					return { status: "completed", finalText: "ok", usage: { totalTokens: 10 } };
				},
				async close() {},
			};
		},
	};
}

describe("System-1 JevDecisionClient & PhysicsConcurrencyGovernor (v3)", () => {
	it("serializes exact TypeSafe Jev POST /v1/systemone wire format, retries 429, and supports long-context header", async () => {
		const received: Array<{ auth?: string; longCtx?: string; body: any }> = [];
		let attempts = 0;

		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			let raw = "";
			req.on("data", (chunk) => {
				raw += String(chunk);
			});
			req.on("end", () => {
				attempts += 1;
				const parsed = JSON.parse(raw);
				received.push({
					auth: req.headers.authorization,
					longCtx: req.headers["typesafe-danger-zone-long-context"] as string | undefined,
					body: parsed,
				});
				if (attempts === 1) {
					res.writeHead(429, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "rate limited" }));
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						model: "jev-1.14.0",
						answers: {
							topo: {
								type: "choice",
								choice: "evolution",
								confidence: 0.91,
								probabilities: { evolution: 0.91, "elastic-phase": 0.09 },
							},
							fg: {
								type: "noul",
								noul: 0.12,
							},
							novelty: {
								type: "score",
								score: 1.85,
								confidence: 0.84,
								legend: { "0": "duplicate", "1": "incremental", "2": "breakthrough" },
								probabilities: { "0": 0.02, "1": 0.11, "2": 0.87 },
							},
						},
						usage: { input_tokens: 240, output_tokens: 0 },
					}),
				);
			});
		});

		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;

		try {
			const client = new JevDecisionClient({
				apiKey: "ts_test_secret_key",
				baseUrl: `http://127.0.0.1:${port}/v1/systemone`,
				longContextTokenThreshold: 10, // force long-context header in test
				maxRetries: 2,
			});

			const resp = await client.decide({
				state: "Compact tightly coupled repository with explicit SPEC.md and unit tests.",
				questions: {
					topo: {
						type: "choice",
						instructions: "Pick optimal topology",
						criteria: { evolution: "Parallel search", "elastic-phase": "Phased integration" },
					},
					fg: {
						type: "noul",
						instructions: "Does this repo need a Wave-1 Field Guide?",
					},
					novelty: {
						type: "score",
						instructions: "Rate novelty",
						criteria: ["duplicate", "incremental", "breakthrough"],
					},
				},
			});

			expect(attempts).toBe(2);
			expect(received[1]?.auth).toBe("Bearer ts_test_secret_key");
			expect(received[1]?.longCtx).toBe("true");
			expect(received[1]?.body.model).toBe("jev-latest");
			expect(received[1]?.body.state).toContain("Compact tightly coupled");
			expect(received[1]?.body.questions.topo.criteria).toEqual({
				evolution: "Parallel search",
				"elastic-phase": "Phased integration",
			});

			expect(resp.model).toBe("jev-1.14.0");
			expect(resp.inputTokens).toBe(240);
			expect(resp.outputTokens).toBe(0);
			expect(resp.answers.topo).toMatchObject({ type: "choice", choice: "evolution", confidence: 0.91 });
			// Derived noul confidence: |2*0.12 - 1| = 0.76
			expect(resp.answers.fg).toMatchObject({ type: "noul", noul: 0.12 });
			expect(resp.answers.fg?.confidence).toBeCloseTo(0.76, 5);
			expect(resp.answers.novelty).toMatchObject({ type: "score", score: 1.85, confidence: 0.84 });
		} finally {
			server.close();
		}
	});

	it("loads TYPESAFE_API_KEY from git-ignored .env via loadEnvKey & createDecisionClientFromEnv", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev-env-"));
		const prev = process.env.TYPESAFE_API_KEY;
		delete process.env.TYPESAFE_API_KEY;
		try {
			writeFileSync(join(dir, ".env"), '# local key\nTYPESAFE_API_KEY="ts_from_dotenv"\n');
			expect(loadEnvKey("TYPESAFE_API_KEY", dir)).toBe("ts_from_dotenv");
			const client = createDecisionClientFromEnv({ provider: "auto", cwd: dir });
			expect(client?.provider).toBe("typesafe-jev");
			expect(createDecisionClientFromEnv({ provider: "none", cwd: dir })).toBeUndefined();
		} finally {
			if (prev !== undefined) process.env.TYPESAFE_API_KEY = prev;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("scales concurrency via AIMD + host physics probes in PhysicsConcurrencyGovernor & DriverQuotaRouter", async () => {
		const GIB = 1024 * 1024 * 1024;
		let freeMemBytes = 16 * GIB;
		let freeDiskBytes = 20 * GIB;
		let cpuLoadRatio = 0.4;

		const gov = new PhysicsConcurrencyGovernor({
			mode: "physics",
			scaleUpAfterSuccesses: 2,
			probeCacheMs: 0,
			probe: () => ({ freeMemBytes, cpuLoadRatio, cpuCount: 8, freeDiskBytes, sampledAt: Date.now() }),
		});
		gov.registerDriver("d1", { id: "d1", kind: "codex-app-server", maxConcurrent: 2 });
		// Physics mode starts above fixed default 2 (at 4 for CLI)
		expect(gov.currentWindow("d1")).toBe(4);
		expect(gov.effectiveLimit("d1", 0)).toBe(4);

		// Additive increase: 2 consecutive successes -> window 4 -> 5
		expect(gov.onSuccess("d1")).toBeUndefined();
		const up = gov.onSuccess("d1");
		expect(up?.prevWindow).toBe(4);
		expect(up?.nextWindow).toBe(5);

		// Multiplicative decrease on rate limit: 5 -> 2
		const down = gov.onRateLimit("d1", "transient_rpm");
		expect(down?.prevWindow).toBe(5);
		expect(down?.nextWindow).toBe(2);

		// RAM/disk pressure caps effectiveLimit safely without deadlocking below 1
		freeMemBytes = 1 * GIB; // below 2 GiB reserve floor
		expect(gov.effectiveLimit("d1", 0)).toBe(1);
		freeMemBytes = 16 * GIB;
		freeDiskBytes = 0.5 * GIB; // low disk headroom
		expect(gov.effectiveLimit("d1", 0)).toBe(1);

		// End-to-end integration inside DriverQuotaRouter emits governor.scaled events
		freeDiskBytes = 20 * GIB;
		const store = new MemoryStore();
		const bus = new EventBus(store, new Redactor());
		const router = new DriverQuotaRouter({
			drivers: [
				{ driver: fakeDriver("api-a"), config: { id: "api-a", kind: "pi-in-process", maxConcurrent: 2 } },
				{ driver: fakeDriver("api-b"), config: { id: "api-b", kind: "pi-in-process", maxConcurrent: 2 } },
			],
			roles: { worker: ["api-a", "api-b"] },
			bus,
			runId: "run-gov",
			concurrencyMode: "physics",
			physics: {
				scaleUpAfterSuccesses: 2,
				probeCacheMs: 0,
				probe: () => ({ freeMemBytes, cpuLoadRatio, cpuCount: 8, freeDiskBytes, sampledAt: Date.now() }),
			},
		});

		// Acquire 4 parallel permits immediately on api-a + api-b (> fixed cap 2!)
		const slots = await Promise.all(Array.from({ length: 6 }, () => router.acquireForRole("worker")));
		expect(slots.length).toBe(6);
		for (const s of slots) s.release();

		router.reportSuccess("api-a");
		router.reportSuccess("api-a");
		router.reportQuotaError("api-a", { kind: "transient_rpm", raw: "HTTP 429" });

		const scaleEvents = store.events("run-gov", { types: ["governor.scaled"] });
		expect(scaleEvents.length).toBeGreaterThanOrEqual(2);
		expect(scaleEvents.some((e) => e.data.reason === "aimd_additive_increase")).toBe(true);
		expect(scaleEvents.some((e) => e.data.reason === "transient_rpm")).toBe(true);
	});
});
