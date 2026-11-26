import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalTask, GradeReport, PreparedTask } from "../../contracts.ts";
import { sha256Dir } from "../../sandbox.ts";

function deterministicInt(seed: number, salt: string, min: number, max: number): number {
	const hex = createHash("sha256").update(`${seed}:${salt}`).digest("hex").slice(0, 8);
	const v = Number.parseInt(hex, 16);
	return min + (v % (max - min + 1));
}

interface PrefixInstance {
	mode: "prefix";
	n: number;
	shards: number[][];
	shardSums: number[];
	offsets: number[];
	expectedPrefixes: number[][];
}

interface SiteSensor {
	siteId: string;
	sensorId: string;
	rawValues: number[];
	localScale: number;
	localOffset: number;
}

interface TwoLevelInstance {
	mode: "two-level-join";
	n: number;
	sites: Array<{
		siteId: string;
		sensors: SiteSensor[];
	}>;
	facilityOverrides: Array<{
		overrideId: string;
		siteId: string;
		sensorId: string;
		newOffset: number;
		reason: string;
	}>;
	expected: {
		siteTotals: Record<string, number>;
		globalTotal: number;
		appliedOverrides: string[];
	};
}

type SiloJoinInstance = PrefixInstance | TwoLevelInstance;

function generatePrefix(seed: number, n: number): PrefixInstance {
	const shardLen = 12;
	const shards: number[][] = [];
	const shardSums: number[] = [];
	for (let i = 0; i < n; i++) {
		const arr: number[] = [];
		let sum = 0;
		for (let j = 0; j < shardLen; j++) {
			const val = deterministicInt(seed, `shard-${i}-${j}`, 1, 50);
			arr.push(val);
			sum += val;
		}
		shards.push(arr);
		shardSums.push(sum);
	}
	const offsets: number[] = [];
	let running = 0;
	for (let i = 0; i < n; i++) {
		offsets.push(running);
		running += shardSums[i]!;
	}
	const expectedPrefixes = shards.map((arr, seat) => {
		let acc = offsets[seat]!;
		return arr.map((v) => {
			acc += v;
			return acc;
		});
	});
	return { mode: "prefix", n, shards, shardSums, offsets, expectedPrefixes };
}

function generateTwoLevelJoin(seed: number, n: number): TwoLevelInstance {
	const siteCount = 4;
	const sensorsPerSite = 4;
	const sites: TwoLevelInstance["sites"] = [];
	for (let s = 0; s < siteCount; s++) {
		const siteId = `site-${s + 1}`;
		const sensors: SiteSensor[] = [];
		for (let k = 0; k < sensorsPerSite; k++) {
			const sensorId = `S${s + 1}-${k + 1}`;
			const rawValues = Array.from({ length: 8 }, (_, idx) =>
				deterministicInt(seed, `${sensorId}-v${idx}`, 10, 90),
			);
			const localScale = deterministicInt(seed, `${sensorId}-scale`, 1, 3);
			const localOffset = deterministicInt(seed, `${sensorId}-off`, -5, 5);
			sensors.push({ siteId, sensorId, rawValues, localScale, localOffset });
		}
		sites.push({ siteId, sensors });
	}
	// Plant 2 facility-level overrides that supersede local offsets.
	const ov1Site = deterministicInt(seed, "ov1-site", 0, siteCount - 1);
	const ov2Site = (ov1Site + 1) % siteCount;
	const ov1Sensor = sites[ov1Site]!.sensors[deterministicInt(seed, "ov1-k", 0, sensorsPerSite - 1)]!;
	const ov2Sensor = sites[ov2Site]!.sensors[deterministicInt(seed, "ov2-k", 0, sensorsPerSite - 1)]!;
	const facilityOverrides = [
		{
			overrideId: `OV-${seed}-A`,
			siteId: ov1Sensor.siteId,
			sensorId: ov1Sensor.sensorId,
			newOffset: ov1Sensor.localOffset + 17,
			reason: "Recalibrated facility baseline supersedes site log note.",
		},
		{
			overrideId: `OV-${seed}-B`,
			siteId: ov2Sensor.siteId,
			sensorId: ov2Sensor.sensorId,
			newOffset: ov2Sensor.localOffset - 13,
			reason: "Post-audit facility correction supersedes site log note.",
		},
	];

	const overrideBySensor = new Map(facilityOverrides.map((o) => [o.sensorId, o]));
	const siteTotals: Record<string, number> = {};
	let globalTotal = 0;
	for (const site of sites) {
		let total = 0;
		for (const sensor of site.sensors) {
			const effOffset = overrideBySensor.get(sensor.sensorId)?.newOffset ?? sensor.localOffset;
			for (const v of sensor.rawValues) total += v * sensor.localScale + effOffset;
		}
		siteTotals[site.siteId] = total;
		globalTotal += total;
	}

	return {
		mode: "two-level-join",
		n,
		sites,
		facilityOverrides,
		expected: {
			siteTotals,
			globalTotal,
			appliedOverrides: facilityOverrides.map((o) => o.overrideId).sort(),
		},
	};
}

export const siloJoinMicroTask: EvalTask = {
	id: "silo-join-micro",
	title: "SILO Prefix & Two-Level Evidence Join (Asymmetric Routing Canary)",
	family: "info-routing",
	tier: "proxy",
	supportedN: [2, 4, 8],
	defaultOptions: { mode: "prefix" },
	higherIsBetter: true,

	async prepare({ seed, n, options, workDir, hiddenDir }): Promise<PreparedTask> {
		const mode = options.mode === "two-level-join" ? "two-level-join" : "prefix";
		mkdirSync(workDir, { recursive: true });
		mkdirSync(hiddenDir, { recursive: true });

		if (mode === "prefix") {
			const inst = generatePrefix(seed, n);
			const privateShards: string[] = [];
			for (let i = 0; i < n; i++) {
				const shardDir = join(workDir, "..", "private-shards", `seat-${i}`);
				mkdirSync(shardDir, { recursive: true });
				writeFileSync(
					join(shardDir, "shard.json"),
					JSON.stringify({ seat: i, totalSeats: n, values: inst.shards[i] }, null, 2) + "\n",
				);
				privateShards.push(shardDir);
			}
			mkdirSync(join(workDir, "submissions"), { recursive: true });
			writeFileSync(
				join(workDir, "TASK.md"),
				[
					`# Distributed Prefix Sum (${n} Seats)`,
					"",
					`There are ${n} seats (0..${n - 1}). Each seat has a private shard \`shard.json\` containing 12 integers.`,
					"Pool only the necessary shard subtotals across peers so every seat `i` writes its global prefix sum array to `submissions/seat_<i>.json` as `{\"seat\": i, \"prefix\": [...]}`.",
				].join("\n") + "\n",
			);
			writeFileSync(join(hiddenDir, "instance.json"), JSON.stringify(inst, null, 2));

			const seatPrompts = privateShards.map((shardDir, seatIdx) => {
				const shardFile = join(shardDir, "shard.json");
				return [
					`Seat assignment: You are Seat ${seatIdx} of ${n} (seats 0..${n - 1}).`,
					`Your private shard file is at: ${shardFile}`,
					"Other seats' private shards are kernel-denied by the sandbox — coordinate with peers strictly via the shared message board!",
					"Workflow:",
					`1. Read ONLY your own shard at ${shardFile} and compute the sum of its \`values\` array.`,
					`2. Immediately call \`board_publish(topic="shard-subtotal", summary="seat ${seatIdx} subtotal=<SUM>", body="...", labels={"seat": "${seatIdx}"})\`.`,
					`3. Call \`board_wait(topic="shard-subtotal", min_posts=${n}, timeout_seconds=25)\` (call it again if it times out before all ${n} seats appear) until all ${n} seats have published their subtotals.`,
					`4. Compute your offset = sum of subtotals for seats 0..${seatIdx - 1} (0 if seat 0), then compute your global prefix array and write ONLY \`submissions/seat_${seatIdx}.json\` as \`{"seat": ${seatIdx}, "prefix": [...]}\`.`,
					`5. Verify your JSON file format (12 integers in \`prefix\`) and finish cleanly — the swarm will automatically assemble all ${n} seats onto trunk and run the full ${n}-seat verifier (no need to call \`report_finding\` on a partial 1/${n} workspace).`,
				].join("\n");
			});
			const soloSeatPrompts = privateShards.map((shardDir, seatIdx) => {
				const shardFile = join(shardDir, "shard.json");
				return [
					`Seat assignment: You are Seat ${seatIdx} of ${n} (seats 0..${n - 1}).`,
					`Your private shard file is at: ${shardFile}`,
					"Other seats' private shards and hidden grading directories are kernel-denied by the sandbox.",
					`Write your deliverable in your workspace (e.g. submissions/seat_${seatIdx}.json) using only information you can legally access.`,
				].join("\n");
			});

			return {
				taskId: "silo-join-micro",
				seed,
				n,
				options: { mode },
				workspaceDir: workDir,
				hiddenDir,
				privateShards,
				seatPrompts,
				soloSeatPrompts,
				goal: `Compute the exact global prefix sum across ${n} privately sharded seats and deliver submissions/seat_0.json .. submissions/seat_${n - 1}.json.`,
				rubric: "Every seat's prefix array must include the exact sum of all preceding shards 0..seat-1.",
				fixtureSha256: sha256Dir(workDir),
				graderSha256: sha256Dir(hiddenDir),
				sandboxProfile: "eval-isolated-shards",
			};
		}

		const inst = generateTwoLevelJoin(seed, n);
		for (const site of inst.sites) {
			const siteDir = join(workDir, "sites", site.siteId);
			mkdirSync(siteDir, { recursive: true });
			writeFileSync(join(siteDir, "sensors.json"), JSON.stringify(site, null, 2) + "\n");
		}
		writeFileSync(
			join(workDir, "facility_overrides.json"),
			JSON.stringify({ overrides: inst.facilityOverrides }, null, 2) + "\n",
		);
		writeFileSync(
			join(workDir, "TASK.md"),
			[
				"# Two-Level Site & Facility Audit Join",
				"",
				"Each site folder under `sites/site-*/sensors.json` lists sensors with `rawValues`, `localScale`, and `localOffset`.",
				"Compute `sum(v * localScale + effectiveOffset)` per site and globally. **Important:** `facility_overrides.json` contains authoritative facility-level overrides that supersede `localOffset` for matching sensors.",
				"Deliver `answers.json` with `{\"siteTotals\": {\"site-1\": ...}, \"globalTotal\": ..., \"appliedOverrides\": [\"OV-...\"]}`.",
			].join("\n") + "\n",
		);
		writeFileSync(join(hiddenDir, "instance.json"), JSON.stringify(inst, null, 2));

		return {
			taskId: "silo-join-micro",
			seed,
			n,
			options: { mode },
			workspaceDir: workDir,
			hiddenDir,
			goal: "Reconcile all 4 site sensor logs with facility_overrides.json and deliver exact siteTotals, globalTotal, and appliedOverrides in answers.json.",
			rubric: "Exact integer totals and complete sorted list of applied override IDs.",
			fixtureSha256: sha256Dir(workDir),
			graderSha256: sha256Dir(hiddenDir),
			sandboxProfile: "eval-offline",
		};
	},

	async publicCheck({ artifactDir, n, options }): Promise<{ passed: boolean; score: number; details: string }> {
		const mode = options.mode === "two-level-join" ? "two-level-join" : "prefix";
		if (mode === "prefix") {
			let validFiles = 0;
			for (let i = 0; i < n; i++) {
				const p = join(artifactDir, "submissions", `seat_${i}.json`);
				if (!existsSync(p)) continue;
				try {
					const parsed = JSON.parse(readFileSync(p, "utf8")) as { prefix?: unknown };
					if (Array.isArray(parsed.prefix) && parsed.prefix.length === 12 && parsed.prefix.every((x) => typeof x === "number")) {
						validFiles++;
					}
				} catch {
					// malformed
				}
			}
			const score = n > 0 ? validFiles / n : 0;
			return { passed: validFiles === n, score, details: `public schema check: ${validFiles}/${n} valid seat files` };
		}
		const ansPath = join(artifactDir, "answers.json");
		if (!existsSync(ansPath)) return { passed: false, score: 0, details: "missing answers.json" };
		try {
			const parsed = JSON.parse(readFileSync(ansPath, "utf8")) as {
				siteTotals?: Record<string, unknown>;
				globalTotal?: unknown;
				appliedOverrides?: unknown;
			};
			const ok =
				typeof parsed.siteTotals === "object" &&
				parsed.siteTotals !== null &&
				typeof parsed.globalTotal === "number" &&
				Array.isArray(parsed.appliedOverrides);
			return { passed: ok, score: ok ? 1 : 0, details: ok ? "answers.json schema valid" : "answers.json missing required fields" };
		} catch {
			return { passed: false, score: 0, details: "answers.json invalid JSON" };
		}
	},

	async grade({ artifactDir, hiddenDir }): Promise<GradeReport> {
		const inst = JSON.parse(readFileSync(join(hiddenDir, "instance.json"), "utf8")) as SiloJoinInstance;

		if (inst.mode === "prefix") {
			let correctSeats = 0;
			let firstDroppedOffsetSeat = -1;
			let firstOffsetDelta = 0;
			const missingSeats: number[] = [];

			for (let i = 0; i < inst.n; i++) {
				const path = join(artifactDir, "submissions", `seat_${i}.json`);
				if (!existsSync(path)) {
					missingSeats.push(i);
					continue;
				}
				try {
					const parsed = JSON.parse(readFileSync(path, "utf8")) as { prefix?: number[] };
					const expected = inst.expectedPrefixes[i]!;
					const actual = parsed.prefix;
					const exact =
						Array.isArray(actual) &&
						actual.length === expected.length &&
						actual.every((v, idx) => v === expected[idx]);
					if (exact) {
						correctSeats++;
					} else if (firstDroppedOffsetSeat < 0 && Array.isArray(actual) && actual.length > 0) {
						firstDroppedOffsetSeat = i;
						firstOffsetDelta = actual[0]! - expected[0]!;
					}
				} catch {
					missingSeats.push(i);
				}
			}

			const perAgentAccuracy = Math.round((correctSeats / inst.n) * 1e4) / 1e4;
			const passed = correctSeats === inst.n;
			return {
				passed,
				score: perAgentAccuracy,
				customMetrics: {
					mode: "prefix",
					perAgentAccuracy,
					allAgentsStrictPass: passed,
					missingSeats: missingSeats.length,
					firstDroppedOffsetSeat,
					firstDroppedOffsetDelta: firstOffsetDelta,
				},
				details: passed
					? `All ${inst.n}/${inst.n} seats submitted exact global prefix sums.`
					: `${correctSeats}/${inst.n} seats correct (missing=${missingSeats.length}, firstBadSeat=${firstDroppedOffsetSeat}, delta=${firstOffsetDelta}).`,
			};
		}

		const ansPath = join(artifactDir, "answers.json");
		if (!existsSync(ansPath)) {
			return {
				passed: false,
				score: 0,
				customMetrics: { mode: "two-level-join", missingFile: true },
				details: "Missing answers.json",
			};
		}
		try {
			const ans = JSON.parse(readFileSync(ansPath, "utf8")) as {
				siteTotals?: Record<string, number>;
				globalTotal?: number;
				appliedOverrides?: string[];
			};
			const siteKeys = Object.keys(inst.expected.siteTotals);
			const correctSites = siteKeys.filter((k) => ans.siteTotals?.[k] === inst.expected.siteTotals[k]).length;
			const globalOk = ans.globalTotal === inst.expected.globalTotal;
			const actualOv = Array.isArray(ans.appliedOverrides) ? [...ans.appliedOverrides].sort() : [];
			const ovOk =
				actualOv.length === inst.expected.appliedOverrides.length &&
				actualOv.every((id, idx) => id === inst.expected.appliedOverrides[idx]);
			const checksTotal = siteKeys.length + 2;
			const checksPassed = correctSites + Number(globalOk) + Number(ovOk);
			const score = Math.round((checksPassed / checksTotal) * 1e4) / 1e4;
			const passed = checksPassed === checksTotal;
			return {
				passed,
				score,
				customMetrics: {
					mode: "two-level-join",
					correctSites,
					totalSites: siteKeys.length,
					globalTotalCorrect: globalOk,
					overridesCorrect: ovOk,
				},
				details: `sites=${correctSites}/${siteKeys.length}, global=${globalOk}, overrides=${ovOk}`,
			};
		} catch (error) {
			return {
				passed: false,
				score: 0,
				customMetrics: { mode: "two-level-join", parseError: true },
				details: `Failed to parse answers.json: ${String(error)}`,
			};
		}
	},

	async buildReferenceArtifact({ prepared, outDir }): Promise<void> {
		const inst = JSON.parse(readFileSync(join(prepared.hiddenDir, "instance.json"), "utf8")) as SiloJoinInstance;
		if (inst.mode === "prefix") {
			mkdirSync(join(outDir, "submissions"), { recursive: true });
			for (let i = 0; i < inst.n; i++) {
				writeFileSync(
					join(outDir, "submissions", `seat_${i}.json`),
					JSON.stringify({ seat: i, prefix: inst.expectedPrefixes[i] }, null, 2) + "\n",
				);
			}
			return;
		}
		writeFileSync(join(outDir, "answers.json"), JSON.stringify(inst.expected, null, 2) + "\n");
	},
};
