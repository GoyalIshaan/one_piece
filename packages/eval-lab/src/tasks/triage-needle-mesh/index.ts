import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalTask, GradeReport, PreparedTask, PublicCheckResult, SeatSpec } from "../../contracts.ts";
import { sha256Dir } from "../../sandbox.ts";

function detHex(seed: number, salt: string, len = 8): string {
	return createHash("sha256").update(`triage-needle:${seed}:${salt}`).digest("hex").slice(0, len);
}

function detInt(seed: number, salt: string, min: number, max: number): number {
	const v = Number.parseInt(detHex(seed, salt, 8), 16);
	return min + (v % (max - min + 1));
}

type TelemetryRecord =
	| {
		readonly record_id: string;
		readonly kind: "cross_shard_edge_out" | "cross_shard_edge_in";
		readonly severity: "CRITICAL" | "HIGH" | "MEDIUM";
		readonly edge_id: string;
		readonly from_seat: number;
		readonly to_seat: number;
		readonly partial_key: string;
		readonly weight: number;
		readonly checksum_hex: string;
		readonly note: string;
	}
	| {
		readonly record_id: string;
		readonly kind: "local_anomaly";
		readonly severity: "CRITICAL" | "HIGH" | "MEDIUM";
		readonly edge_id?: never;
		readonly from_seat?: never;
		readonly to_seat?: never;
		readonly partial_key?: never;
		readonly weight?: never;
		readonly checksum_hex: string;
		readonly note: string;
	};

interface VerifiedEdgeTruth {
	edge_id: string;
	from_seat: number;
	to_seat: number;
	link_token: string;
	combined_weight: number;
}

interface GroundTruth {
	n: number;
	verified_ring_edges: VerifiedEdgeTruth[];
	global_ring_signature: string;
	global_total_weight: number;
	distractor_ids_by_seat: Record<string, string[]>;
}

function expectedChecksum(edgeId: string, seat: number, partialKey: string, weight: number): string {
	return createHash("sha256")
		.update(`chk:${edgeId}:${seat}:${partialKey}:${weight}`)
		.digest("hex")
		.slice(0, 6);
}

function computeLinkToken(edgeId: string, keyA: string, keyB: string): string {
	return createHash("sha256").update(`${edgeId}:${keyA}:${keyB}`).digest("hex").slice(0, 8);
}

function computeRingSignature(edges: readonly VerifiedEdgeTruth[]): string {
	const canonical = [...edges]
		.sort((a, b) => a.edge_id.localeCompare(b.edge_id))
		.map((e) => `${e.edge_id}:${e.link_token}`)
		.join("|");
	return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function generateInstance(seed: number, n: number, distractorsPerSeat: number): {
	shards: TelemetryRecord[][];
	truth: GroundTruth;
} {
	const count = Math.max(2, Math.min(8, n));
	const shards: TelemetryRecord[][] = Array.from({ length: count }, () => []);
	const verifiedEdges: VerifiedEdgeTruth[] = [];
	const distractorIdsBySeat: Record<string, string[]> = {};

	// 1. Create the N true cross-shard causal ring edges (each requires seat i AND seat (i+1)%N).
	for (let i = 0; i < count; i++) {
		const nextSeat = (i + 1) % count;
		const edgeId = `edge-${i}-${nextSeat}-${detHex(seed, `eid-${i}`, 4)}`;
		const keyA = detHex(seed, `keyA-${i}`, 8);
		const keyB = detHex(seed, `keyB-${i}`, 8);
		const weightA = detInt(seed, `wA-${i}`, 11, 49);
		const weightB = detInt(seed, `wB-${i}`, 13, 53);

		shards[i]!.push({
			record_id: `rec-s${i}-out-${detHex(seed, `ro-${i}`, 4)}`,
			kind: "cross_shard_edge_out",
			severity: "MEDIUM", // Deliberately quieter label than loud CRITICAL distractors!
			edge_id: edgeId,
			from_seat: i,
			to_seat: nextSeat,
			partial_key: keyA,
			weight: weightA,
			checksum_hex: expectedChecksum(edgeId, i, keyA, weightA),
			note: `Verified outgoing cross-shard witness to seat_${nextSeat}. Share edge_id, partial_key, and weight with seat_${nextSeat}.`,
		});

		shards[nextSeat]!.push({
			record_id: `rec-s${nextSeat}-in-${detHex(seed, `ri-${i}`, 4)}`,
			kind: "cross_shard_edge_in",
			severity: "MEDIUM",
			edge_id: edgeId,
			from_seat: i,
			to_seat: nextSeat,
			partial_key: keyB,
			weight: weightB,
			checksum_hex: expectedChecksum(edgeId, nextSeat, keyB, weightB),
			note: `Verified incoming cross-shard witness from seat_${i}. Pair with seat_${i}'s outgoing partial_key to compute link_token.`,
		});

		verifiedEdges.push({
			edge_id: edgeId,
			from_seat: i,
			to_seat: nextSeat,
			link_token: computeLinkToken(edgeId, keyA, keyB),
			combined_weight: weightA + weightB,
		});
	}

	// 2. Flood every shard with plausible high-severity distractors (invalid checksum or local_anomaly).
	for (let i = 0; i < count; i++) {
		const distractorIds: string[] = [];
		for (let d = 0; d < distractorsPerSeat; d++) {
			const recId = `rec-s${i}-dist-${d}-${detHex(seed, `dist-${i}-${d}`, 4)}`;
			distractorIds.push(recId);
			const fakeEdge = d % 2 === 0;
			if (fakeEdge) {
				// Looks like a CRITICAL cross-shard edge, EXCEPT its checksum_hex fails verification!
				const fakeEdgeId = `edge-fake-${i}-${d}-${detHex(seed, `fe-${i}-${d}`, 4)}`;
				const fakeKey = detHex(seed, `fk-${i}-${d}`, 8);
				const fakeWeight = detInt(seed, `fw-${i}-${d}`, 5, 99);
				shards[i]!.push({
					record_id: recId,
					kind: "cross_shard_edge_out",
					severity: "CRITICAL",
					edge_id: fakeEdgeId,
					from_seat: i,
					to_seat: (i + 1) % count,
					partial_key: fakeKey,
					weight: fakeWeight,
					checksum_hex: "bad000", // Fails sha256("chk:edge_id:seat:partial_key:weight")[:6]
					note: "CRITICAL burst alert (corrupted/spoofed telemetry frame; fails local checksum check).",
				});
			} else {
				shards[i]!.push({
					record_id: recId,
					kind: "local_anomaly",
					severity: "HIGH",
					checksum_hex: detHex(seed, `lc-${i}-${d}`, 6),
					note: "HIGH local GC/cache spike self-healed within shard; no cross-shard causality.",
				});
			}
		}
		distractorIdsBySeat[String(i)] = distractorIds;

		// Deterministic shuffle so needles are buried inside the distractor flood
		shards[i]!.sort((a, b) =>
			detHex(seed, `shuf-${i}-${a.record_id}`, 8).localeCompare(detHex(seed, `shuf-${i}-${b.record_id}`, 8)),
		);
	}

	verifiedEdges.sort((a, b) => a.edge_id.localeCompare(b.edge_id));
	const truth: GroundTruth = {
		n: count,
		verified_ring_edges: verifiedEdges,
		global_ring_signature: computeRingSignature(verifiedEdges),
		global_total_weight: verifiedEdges.reduce((s, e) => s + e.combined_weight, 0),
		distractor_ids_by_seat: distractorIdsBySeat,
	};

	return { shards, truth };
}

/**
 * High-Noise Board v2 Triage & Cross-Shard Ring Consensus Probe (`triage-needle-mesh`).
 * - Each of N private Seatbelt-isolated shards contains 10 loud distractors + 2 true cross-shard needles.
 * - Requires local checksum filtering (so agents don't flood the shared board with 10*N noise records)
 *   AND full N-seat cross-shard synthesis to compute `global_ring_signature` and `global_total_weight`.
 * - Directly stresses `BoardTriageService`, scoped `subtree -> global` promotion, and Communication Lift at N=2,4,8.
 */
export const triageNeedleMeshTask: EvalTask = {
	id: "triage-needle-mesh",
	title: "High-Noise Cross-Shard Triage & Ring Consensus (N=2..8)",
	family: "info-routing",
	tier: "proxy",
	supportedN: [2, 4, 8],
	defaultOptions: { distractorsPerSeat: "10" },
	higherIsBetter: true,

	async prepare({ seed, n, options, workDir, hiddenDir }): Promise<PreparedTask> {
		const count = Math.max(2, Math.min(8, n));
		const distractorsPerSeat = Math.max(4, Math.min(25, Number(options.distractorsPerSeat ?? 10) || 10));
		const { shards, truth } = generateInstance(seed, count, distractorsPerSeat);

		mkdirSync(workDir, { recursive: true });
		mkdirSync(join(workDir, "submissions"), { recursive: true });
		mkdirSync(hiddenDir, { recursive: true });

		const privateRoot = join(workDir, "..", "private-inputs");
		mkdirSync(privateRoot, { recursive: true });

		const seats: SeatSpec[] = [];
		for (let i = 0; i < count; i++) {
			const shardDir = join(privateRoot, `seat_${i}`);
			mkdirSync(shardDir, { recursive: true });
			writeFileSync(
				join(shardDir, "telemetry.json"),
				JSON.stringify({ seat: i, total_seats: count, records: shards[i] }, null, 2) + "\n",
			);
			const outputPath = `submissions/seat_${i}.json`;
			seats.push({
				index: i,
				handle: `seat-${i}`,
				privateDir: shardDir,
				outputPath,
				prompt: [
					`You are seat_${i} (of ${count} privately isolated seats).`,
					`1. Read ONLY your private shard at \`${join(shardDir, "telemetry.json")}\`.`,
					`2. Filter out all local_anomaly and checksum-invalid distractors locally (verify sha256("chk:{edge_id}:{seat}:{partial_key}:{weight}")[:6] == checksum_hex). DO NOT spam distractors to the shared board!`,
					`3. Post ONLY your 2 verified cross-shard edge witnesses (edge_id, from_seat, to_seat, partial_key, weight) to \`#swarm\` via \`board_post\` (and coordinate with \`board_wait\` / \`board_search\`) so peers can pair every edge (link_token = sha256("{edge_id}:{keyA}:{keyB}")[:8], combined_weight = weightA + weightB).`,
					`4. Once all ${count} ring edges are verified across seats, write \`${outputPath}\` matching the exact schema in SPEC.md and commit.`,
				].join("\n"),
				soloPrompt: [
					`You are seat_${i} (of ${count} seats, running in isolation with no peer communication).`,
					`Read your private shard at \`${join(shardDir, "telemetry.json")}\`, verify valid records, reject distractors, and write your best estimate to \`${outputPath}\` per SPEC.md.`,
				].join("\n"),
			});
		}

		writeFileSync(
			join(workDir, "SPEC.md"),
			[
				"# High-Noise Cross-Shard Triage & Ring Consensus",
				"",
				`There are **N = ${count}** privately isolated shards (\`seat_0\` .. \`seat_${count - 1}\`).`,
				`Each shard contains **${distractorsPerSeat} distractors** (local anomalies or corrupted checksum frames marked HIGH/CRITICAL) and **2 true cross-shard witnesses** (1 outgoing to \`(i+1)%N\`, 1 incoming from \`(i-1+N)%N\`).`,
				"",
				"## Local Verification Rule (Filter Before Publishing!)",
				"A `cross_shard_edge_out` or `cross_shard_edge_in` record on `seat` is VALID iff:",
				"`sha256(f\"chk:{edge_id}:{seat}:{partial_key}:{weight}\").hexdigest()[:6] == checksum_hex`",
				"All other records (`local_anomaly` or failed checksum) are DISTRACTORS.",
				"",
				"## Cross-Shard Edge Pairing Rule",
				"For each verified `edge_id` with outgoing `(keyA, weightA)` on `from_seat` and incoming `(keyB, weightB)` on `to_seat`:",
				"- `link_token = sha256(f\"{edge_id}:{keyA}:{keyB}\").hexdigest()[:8]`",
				"- `combined_weight = weightA + weightB`",
				"",
				"## Global Consensus Signature",
				"- Sort all `N` verified edges ascending by `edge_id`.",
				"- `global_ring_signature = sha256(\"|\".join(f\"{e['edge_id']}:{e['link_token']}\" for e in edges)).hexdigest()[:16]`",
				"- `global_total_weight = sum(e['combined_weight'] for e in edges)`",
				"",
				"## Required Deliverable per Seat (`submissions/seat_<i>.json`)",
				"```json",
				"{",
				'  "seat": 0,',
				'  "verified_ring_edges": [',
				'    { "edge_id": "...", "from_seat": 0, "to_seat": 1, "link_token": "8-hex", "combined_weight": 42 }',
				"  ],",
				'  "global_ring_signature": "16-hex",',
				'  "global_total_weight": 123,',
				'  "rejected_distractor_ids": ["rec-s0-dist-0-..."]',
				"}",
				"```",
			].join("\n") + "\n",
		);

		writeFileSync(join(hiddenDir, "ground_truth.json"), JSON.stringify(truth, null, 2) + "\n");

		return {
			taskId: "triage-needle-mesh",
			seed,
			n: count,
			options,
			workspaceDir: workDir,
			hiddenDir,
			seats,
			privateShards: seats.map((s) => s.privateDir),
			seatPrompts: seats.map((s) => s.prompt),
			soloSeatPrompts: seats.map((s) => s.soloPrompt),
			goal: `Filter ${distractorsPerSeat} distractors per shard locally, coordinate the ${count} valid cross-shard ring edges on #swarm via board_post/board_wait/board_search, and write consensus submissions/seat_0.json .. submissions/seat_${count - 1}.json per SPEC.md.`,
			rubric: "Exact N-edge ring signature + global_total_weight consensus across all N seats with zero distractor leaks.",
			fixtureSha256: sha256Dir(workDir),
			graderSha256: sha256Dir(hiddenDir),
			sandboxProfile: "eval-isolated-shards",
		};
	},

	async publicCheck({ artifactDir, n }): Promise<PublicCheckResult> {
		const count = Math.max(2, Math.min(8, n));
		const sigs = new Set<string>();
		const weights = new Set<number>();
		let validSeats = 0;

		for (let i = 0; i < count; i++) {
			const fp = join(artifactDir, "submissions", `seat_${i}.json`);
			if (!existsSync(fp)) continue;
			try {
				const sub = JSON.parse(readFileSync(fp, "utf8")) as {
					seat?: number;
					verified_ring_edges?: Array<{ edge_id?: string; link_token?: string; combined_weight?: number }>;
					global_ring_signature?: string;
					global_total_weight?: number;
					rejected_distractor_ids?: unknown[];
				};
				if (
					sub.seat === i &&
					Array.isArray(sub.verified_ring_edges) &&
					sub.verified_ring_edges.length === count &&
					typeof sub.global_ring_signature === "string" &&
					/^[0-9a-f]{16}$/i.test(sub.global_ring_signature) &&
					typeof sub.global_total_weight === "number" &&
					Array.isArray(sub.rejected_distractor_ids) &&
					sub.rejected_distractor_ids.length > 0
				) {
					validSeats++;
					sigs.add(sub.global_ring_signature.toLowerCase());
					weights.add(sub.global_total_weight);
				}
			} catch {
				// Invalid JSON
			}
		}

		const consensus = validSeats === count && sigs.size === 1 && weights.size === 1;
		const score = Math.round(((validSeats / count) * 0.7 + (consensus ? 0.3 : 0)) * 1000) / 1000;
		return {
			passed: consensus,
			score,
			details: `validSeats=${validSeats}/${count} consensus=${consensus} uniqueSigs=${sigs.size}`,
		};
	},

	async grade({ artifactDir, hiddenDir }): Promise<GradeReport> {
		const truth = JSON.parse(readFileSync(join(hiddenDir, "ground_truth.json"), "utf8")) as GroundTruth;
		const count = truth.n;
		const expectedEdgeMap = new Map(truth.verified_ring_edges.map((e) => [e.edge_id, e]));

		let seatsSubmitted = 0;
		let totalSeatScore = 0;
		let exactConsensusSeats = 0;
		let totalEdgeMatches = 0;
		let totalDistractorRecall = 0;
		let distractorLeakCount = 0;

		for (let i = 0; i < count; i++) {
			const fp = join(artifactDir, "submissions", `seat_${i}.json`);
			if (!existsSync(fp)) continue;
			try {
				const sub = JSON.parse(readFileSync(fp, "utf8")) as {
					seat?: number;
					verified_ring_edges?: Array<{ edge_id?: string; from_seat?: number; to_seat?: number; link_token?: string; combined_weight?: number }>;
					global_ring_signature?: string;
					global_total_weight?: number;
					rejected_distractor_ids?: string[];
				};
				seatsSubmitted++;

				const edges = Array.isArray(sub.verified_ring_edges) ? sub.verified_ring_edges : [];
				let edgeMatches = 0;
				const seenEdges = new Set<string>();
				for (const e of edges) {
					if (!e || typeof e.edge_id !== "string" || seenEdges.has(e.edge_id)) continue;
					seenEdges.add(e.edge_id);
					const exp = expectedEdgeMap.get(e.edge_id);
					if (
						exp &&
						e.from_seat === exp.from_seat &&
						e.to_seat === exp.to_seat &&
						String(e.link_token ?? "").toLowerCase() === exp.link_token &&
						Number(e.combined_weight) === exp.combined_weight
					) {
						edgeMatches++;
					} else if (e.edge_id.includes("fake")) {
						distractorLeakCount++;
					}
				}
				const edgeRecall = edgeMatches / count;
				totalEdgeMatches += edgeRecall;

				const sigOk = String(sub.global_ring_signature ?? "").toLowerCase() === truth.global_ring_signature;
				const weightOk = Number(sub.global_total_weight) === truth.global_total_weight;
				if (sigOk && weightOk && edgeMatches === count) exactConsensusSeats++;

				const expectedDist = new Set(truth.distractor_ids_by_seat[String(i)] ?? []);
				const reportedDist = new Set(Array.isArray(sub.rejected_distractor_ids) ? sub.rejected_distractor_ids : []);
				let distHits = 0;
				for (const d of expectedDist) {
					if (reportedDist.has(d)) distHits++;
				}
				const distRecall = expectedDist.size > 0 ? distHits / expectedDist.size : 1;
				totalDistractorRecall += distRecall;

				const leakPenalty = Math.min(0.25, distractorLeakCount * 0.05);
				const seatScore = Math.max(
					0,
					0.4 * edgeRecall + 0.25 * (sigOk ? 1 : 0) + 0.2 * (weightOk ? 1 : 0) + 0.15 * distRecall - leakPenalty,
				);
				totalSeatScore += seatScore;
			} catch {
				// Invalid JSON
			}
		}

		const score = Math.round((totalSeatScore / count) * 10_000) / 10_000;
		const passed = exactConsensusSeats === count && distractorLeakCount === 0 && score >= 0.999;
		return {
			passed,
			score,
			customMetrics: {
				seatsSubmitted,
				exactConsensusSeats,
				verifiedEdgeRecall: Math.round((totalEdgeMatches / count) * 1000) / 1000,
				distractorRejectionRecall: Math.round((totalDistractorRecall / count) * 1000) / 1000,
				distractorLeakCount,
				ringConsensusExact: exactConsensusSeats === count,
			},
			details: `seats=${seatsSubmitted}/${count} exactConsensus=${exactConsensusSeats}/${count} distractorLeaks=${distractorLeakCount} score=${score}`,
		};
	},

	async buildReferenceArtifact({ prepared, outDir }): Promise<void> {
		const truth = JSON.parse(readFileSync(join(prepared.hiddenDir, "ground_truth.json"), "utf8")) as GroundTruth;
		mkdirSync(join(outDir, "submissions"), { recursive: true });
		for (let i = 0; i < truth.n; i++) {
			writeFileSync(
				join(outDir, "submissions", `seat_${i}.json`),
				JSON.stringify(
					{
						seat: i,
						verified_ring_edges: truth.verified_ring_edges,
						global_ring_signature: truth.global_ring_signature,
						global_total_weight: truth.global_total_weight,
						rejected_distractor_ids: truth.distractor_ids_by_seat[String(i)] ?? [],
					},
					null,
					2,
				) + "\n",
			);
		}
	},
};
