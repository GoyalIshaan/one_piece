import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalTask, GradeReport, PreparedTask } from "../../contracts.ts";
import { sha256Dir } from "../../sandbox.ts";

function detInt(seed: number, salt: string, min: number, max: number): number {
	const hex = createHash("sha256").update(`${seed}:${salt}`).digest("hex").slice(0, 8);
	return min + (Number.parseInt(hex, 16) % (max - min + 1));
}

function detHex(seed: number, salt: string, len = 8): string {
	return createHash("sha256").update(`${seed}:${salt}`).digest("hex").slice(0, len);
}

interface TraceSpan {
	trace_id: string;
	span_id: string;
	parent_span_id: string | null;
	caller_service: string | null;
	downstream_service: string | null;
	local_ts_ms: number;
	duration_ms: number;
	status: "OK" | "ERR_TIMEOUT" | "ERR_POOL_EXHAUSTED" | "ERR_CORRUPT_HEADER" | "ERR_DOWNSTREAM";
	note: string;
}

interface ServiceShard {
	seat: number;
	totalSeats: number;
	service: string;
	deploy_commit: string;
	clock_skew_ms: number;
	current_config: Record<string, string | number>;
	local_alerts: string[];
	policy_fragment: {
		applies_to_error_code?: string;
		parameter: string;
		safe_value: number;
		rationale: string;
	} | null;
	spans: TraceSpan[];
}

interface IncidentInstance {
	n: number;
	services: string[];
	shards: ServiceShard[];
	expected: {
		rootCauseService: string;
		faultyCommit: string;
		causalChain: string[];
		rejectedRedHerrings: string[];
		remediationConfig: {
			service: string;
			parameter: string;
			targetValue: number;
		};
	};
}

const SERVICE_POOL = [
	"api-gateway",
	"auth-edge",
	"order-router",
	"pricing-core",
	"inventory-db",
	"billing-ledger",
	"risk-scorer",
	"notify-worker",
];

function generateIncident(seed: number, n: number): IncidentInstance {
	const count = Math.max(2, Math.min(8, n));
	const services = SERVICE_POOL.slice(0, count);

	// Build a deterministic permutation so the root-cause service, blast-radius chain,
	// policy-holding seat, and red-herring seats vary every seed.
	const order = services.map((s, idx) => ({ s, idx, key: detInt(seed, `ord-${idx}`, 0, 1_000_000) }));
	order.sort((a, b) => a.key - b.key);

	const chainLen = Math.min(count, Math.max(2, Math.min(4, count - (count >= 4 ? 1 : 0))));
	// causalChain: [originRoot, hop1, ..., blastLeaf]
	const chainEntries = order.slice(0, chainLen);
	const rootEntry = chainEntries[0]!;
	const causalChain = chainEntries.map((e) => e.s);

	// Pick red-herring services: one downstream symptom + one unrelated service (when available)
	const redHerrings = new Set<string>();
	redHerrings.add(chainEntries[chainEntries.length - 1]!.s); // downstream symptom looks loud in its own logs!
	if (order.length > chainLen) {
		redHerrings.add(order[chainLen]!.s); // unrelated noisy cache-miss alert
	}

	// Pick a DIFFERENT seat from rootEntry to hold the authoritative remediation policy fragment!
	const policySeatEntry = chainEntries.length > 1 ? chainEntries[1]! : order[order.length - 1]!;
	const remediationParam = ["max_conn_pool", "retry_budget_pct", "queue_watermark", "batch_flush_ms"][
		detInt(seed, "param", 0, 3)
	]!;
	const currentBadVal = detInt(seed, "badval", 2, 12);
	const safeTargetVal = currentBadVal * 4 + detInt(seed, "safe-off", 10, 40);

	const baseTrueTs = 1_730_000_000_000 + detInt(seed, "ts", 0, 50_000);
	const faultyCommit = `c${detHex(seed, "fault-commit", 7)}`;
	const traceId = `tr-${detHex(seed, "trace", 8)}`;
	const noiseTraceId = `tr-${detHex(seed, "noise", 8)}`;

	const shards: ServiceShard[] = services.map((service, seat) => {
		const isRoot = service === rootEntry.s;
		const chainPos = causalChain.indexOf(service);
		// Intentionally inject large clock skews so naive local_ts_ms comparison picks the WRONG origin!
		const clockSkewMs = isRoot
			? detInt(seed, `skew-${seat}`, 4500, 9000) // Root clock runs AHEAD so raw local_ts looks LATER!
			: detInt(seed, `skew-${seat}`, -4000, -500);
		const deployCommit = isRoot ? faultyCommit : `c${detHex(seed, `ok-commit-${seat}`, 7)}`;

		const spans: TraceSpan[] = [];
		const localAlerts: string[] = [];

		if (chainPos >= 0) {
			// Request entered at blastLeaf (last in chain) and propagated upstream -> rootEntry (first in chain),
			// OR rootEntry failed first at t0 and cascaded down causalChain[0] -> causalChain[1] -> ... -> blastLeaf!
			// Model cascading failure chronologically: root triggers ERR_POOL_EXHAUSTED at t0,
			// which causes hop 1 to fail at t0 + 35ms, hop 2 at t0 + 70ms, ..., blastLeaf at t0 + 35*chainPos ms.
			const trueTs = baseTrueTs + chainPos * 35;
			const localTs = trueTs + clockSkewMs;
			const upstream = chainPos > 0 ? causalChain[chainPos - 1]! : null;
			const downstream = chainPos + 1 < causalChain.length ? causalChain[chainPos + 1]! : null;
			const spanId = `sp-${chainPos}`;
			const parentSpanId = chainPos > 0 ? `sp-${chainPos - 1}` : null;

			spans.push({
				trace_id: traceId,
				span_id: spanId,
				parent_span_id: parentSpanId,
				caller_service: upstream,
				downstream_service: downstream,
				local_ts_ms: localTs,
				duration_ms: isRoot ? 18 : 25 + chainPos * 12,
				status: isRoot ? "ERR_POOL_EXHAUSTED" : chainPos === causalChain.length - 1 ? "ERR_TIMEOUT" : "ERR_DOWNSTREAM",
				note: isRoot
					? `Origin fault: ${remediationParam}=${currentBadVal} exhausted under burst; propagated downstream to ${downstream ?? "none"}.`
					: `Cascaded failure triggered by upstream ${upstream} (parent_span=${parentSpanId}); local_ts reflects clock_skew_ms=${clockSkewMs}.`,
			});

			if (chainPos === causalChain.length - 1) {
				localAlerts.push(
					`HIGH_SEV_ALERT: 504 timeout spike on ${service} (raw local_ts=${localTs} looks earliest before clock_skew_ms=${clockSkewMs} correction — verify parent_span_id before blaming ${service}!).`,
				);
			}
		}

		// Add unrelated red-herring alert on non-chain red-herring seat
		if (redHerrings.has(service) && chainPos < 0) {
			const noiseTrueTs = baseTrueTs - 200;
			localAlerts.push(
				`WARN_ALERT: Transient L1 cache miss storm on ${service} (trace=${noiseTraceId}, all spans recovered status=OK; no downstream errors).`,
			);
			spans.push({
				trace_id: noiseTraceId,
				span_id: `sp-noise-${seat}`,
				parent_span_id: null,
				caller_service: null,
				downstream_service: null,
				local_ts_ms: noiseTrueTs + clockSkewMs,
				duration_ms: 9,
				status: "OK",
				note: "Self-healed cache warmup; zero impact on incident trace.",
			});
		}

		const policyFragment =
			service === policySeatEntry.s
				? {
					applies_to_error_code: "ERR_POOL_EXHAUSTED",
					parameter: remediationParam,
					safe_value: safeTargetVal,
					rationale: `Runbook policy: any service emitting ERR_POOL_EXHAUSTED must set ${remediationParam}=${safeTargetVal}.`,
				}
				: null;

		return {
			seat,
			totalSeats: count,
			service,
			deploy_commit: deployCommit,
			clock_skew_ms: clockSkewMs,
			current_config: isRoot ? { [remediationParam]: currentBadVal } : { worker_threads: 8 + seat },
			local_alerts: localAlerts,
			policy_fragment: policyFragment,
			spans,
		};
	});

	return {
		n: count,
		services,
		shards,
		expected: {
			rootCauseService: rootEntry.s,
			faultyCommit,
			causalChain,
			rejectedRedHerrings: [...redHerrings].sort(),
			remediationConfig: {
				service: rootEntry.s,
				parameter: remediationParam,
				targetValue: safeTargetVal,
			},
		},
	};
}

export const causalIncidentMeshTask: EvalTask = {
	id: "causal-incident-mesh",
	title: "Causal Incident Mesh (Asymmetric Multi-Shard RCA & Red-Herring Resolution)",
	family: "info-routing",
	tier: "proxy",
	supportedN: [2, 4, 8],
	defaultOptions: {},
	higherIsBetter: true,

	async prepare({ seed, n, options, workDir, hiddenDir }): Promise<PreparedTask> {
		const inst = generateIncident(seed, n);
		mkdirSync(workDir, { recursive: true });
		mkdirSync(hiddenDir, { recursive: true });
		mkdirSync(join(workDir, "submissions"), { recursive: true });

		const privateShards: string[] = [];
		for (let i = 0; i < inst.n; i++) {
			const shardDir = join(workDir, "..", "private-shards", `seat-${i}`);
			mkdirSync(shardDir, { recursive: true });
			writeFileSync(join(shardDir, "shard.json"), JSON.stringify(inst.shards[i], null, 2) + "\n");
			privateShards.push(shardDir);
		}

		writeFileSync(
			join(workDir, "TASK.md"),
			[
				`# Distributed Incident Forensics Mesh (${inst.n} Isolated Microservices)`,
				"",
				`An outage occurred across ${inst.n} microservices. Each seat can ONLY read its own private \`shard.json\` (enforced by OS Seatbelt sandbox).`,
				"No single shard contains the full causal chain, clock-skew-adjusted timeline, AND remediation policy.",
				"",
				"## Required Deliverable",
				`Every seat \`i\` must coordinate via the shared board to reach exact consensus and write \`submissions/seat_<i>.json\` matching:`,
				"```json",
				"{",
				'  "seat": 0,',
				'  "rootCauseService": "<origin service emitting root error with parent_span_id=null>",',
				'  "faultyCommit": "<deploy_commit of rootCauseService>",',
				'  "causalChain": ["<origin>", "<hop-1>", "..."],',
				'  "rejectedRedHerrings": ["<sorted list of services that had local_alerts but were NOT the root cause>"],',
				'  "remediationConfig": { "service": "<rootCauseService>", "parameter": "<param>", "targetValue": 42 }',
				"}",
				"```",
				"",
				"## Critical Forensics Rules",
				"- Compute true event timestamp as `true_ts_ms = local_ts_ms - clock_skew_ms`. Do NOT trust raw `local_ts_ms`!",
				"- Follow `parent_span_id` and `caller_service` / `downstream_service` links on the failing incident trace to construct `causalChain` from root origin (`parent_span_id: null`) to final blast-radius leaf.",
				"- Any non-root service with non-empty `local_alerts` is a red herring (downstream symptom or unrelated noise) and MUST appear in `rejectedRedHerrings` (sorted alphabetically).",
				"- Find the seat holding `policy_fragment` matching the root error code to populate `remediationConfig`.",
			].join("\n") + "\n",
		);
		writeFileSync(join(hiddenDir, "instance.json"), JSON.stringify(inst, null, 2));

		const seatPrompts = privateShards.map((shardDir, seatIdx) => {
			const shardFile = join(shardDir, "shard.json");
			return [
				`Seat assignment: You are Seat ${seatIdx} of ${inst.n} (owning private microservice shard at ${shardFile}).`,
				"Other seats' shards are kernel-denied by Seatbelt — coordinate strictly via Board v2 (`board_publish`, `board_wait`, `board_search`).",
				"Workflow:",
				`1. Read ONLY ${shardFile}. Compute \`true_ts_ms = local_ts_ms - clock_skew_ms\` for every span.`,
				`2. Immediately call \`board_publish(topic="shard-telemetry", summary="seat ${seatIdx} <service> ...", body=<JSON with service, deploy_commit, clock_skew_ms, spans, local_alerts, policy_fragment>, labels={"seat": "${seatIdx}"})\`.`,
				`3. Call \`board_wait(topic="shard-telemetry", min_posts=${inst.n}, timeout_seconds=25)\` (repeat if needed until all ${inst.n} seats publish).`,
				`4. Reconstruct the exact incident JSON from all ${inst.n} seats and write ONLY \`submissions/seat_${seatIdx}.json\`.`,
				`5. Verify your JSON schema matches TASK.md and exit cleanly (trunk assembly merges all ${inst.n} seats automatically).`,
			].join("\n");
		});
		const soloSeatPrompts = privateShards.map((shardDir, seatIdx) => {
			const shardFile = join(shardDir, "shard.json");
			return [
				`Seat assignment: You are Seat ${seatIdx} of ${inst.n}. Your private shard is at ${shardFile}.`,
				`Other seats' shards and hidden directories are kernel-denied. Write \`submissions/seat_${seatIdx}.json\` using only accessible data.`,
			].join("\n");
		});

		const seats = privateShards.map((shardDir, seatIdx) => ({
			index: seatIdx,
			handle: `seat-${seatIdx}`,
			privateDir: shardDir,
			outputPath: join("submissions", `seat_${seatIdx}.json`),
			prompt: seatPrompts[seatIdx]!,
			soloPrompt: soloSeatPrompts[seatIdx]!,
		}));

		return {
			taskId: "causal-incident-mesh",
			seed,
			n: inst.n,
			options,
			workspaceDir: workDir,
			hiddenDir,
			seats,
			privateShards,
			seatPrompts,
			soloSeatPrompts,
			goal: `Correlate telemetry across ${inst.n} isolated service shards via the board, reject red herrings, and deliver exact incident RCA reports in submissions/seat_0.json .. submissions/seat_${inst.n - 1}.json.`,
			rubric: "Exact rootCauseService, faultyCommit, ordered causalChain, sorted rejectedRedHerrings, and remediationConfig across all seats.",
			fixtureSha256: sha256Dir(workDir),
			graderSha256: sha256Dir(hiddenDir),
			sandboxProfile: "eval-isolated-shards",
		};
	},

	async publicCheck({ artifactDir, n }): Promise<{ passed: boolean; score: number; details: string }> {
		let valid = 0;
		for (let i = 0; i < n; i++) {
			const p = join(artifactDir, "submissions", `seat_${i}.json`);
			if (!existsSync(p)) continue;
			try {
				const d = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
				const rem = d.remediationConfig as Record<string, unknown> | undefined;
				const ok =
					typeof d.rootCauseService === "string" &&
					d.rootCauseService.length > 0 &&
					typeof d.faultyCommit === "string" &&
					Array.isArray(d.causalChain) &&
					d.causalChain.length >= 2 &&
					Array.isArray(d.rejectedRedHerrings) &&
					Boolean(rem && typeof rem.service === "string" && typeof rem.parameter === "string" && typeof rem.targetValue === "number");
				if (ok) valid++;
			} catch {
				// malformed
			}
		}
		const score = n > 0 ? valid / n : 0;
		return { passed: valid === n, score, details: `public schema check: ${valid}/${n} valid incident reports` };
	},

	async grade({ artifactDir, hiddenDir }): Promise<GradeReport> {
		const inst = JSON.parse(readFileSync(join(hiddenDir, "instance.json"), "utf8")) as IncidentInstance;
		const exp = inst.expected;

		let exactSeats = 0;
		let rootHits = 0;
		let commitHits = 0;
		let chainHits = 0;
		let redHerringHits = 0;
		let remediationHits = 0;
		let presentSeats = 0;
		const seatScores: number[] = [];

		for (let i = 0; i < inst.n; i++) {
			const p = join(artifactDir, "submissions", `seat_${i}.json`);
			if (!existsSync(p)) {
				seatScores.push(0);
				continue;
			}
			try {
				const d = JSON.parse(readFileSync(p, "utf8")) as {
					rootCauseService?: string;
					faultyCommit?: string;
					causalChain?: string[];
					rejectedRedHerrings?: string[];
					remediationConfig?: { service?: string; parameter?: string; targetValue?: number };
				};
				presentSeats++;
				const rootOk = d.rootCauseService === exp.rootCauseService;
				const commitOk = d.faultyCommit === exp.faultyCommit;
				const chainOk =
					Array.isArray(d.causalChain) &&
					d.causalChain.length === exp.causalChain.length &&
					d.causalChain.every((s, idx) => s === exp.causalChain[idx]);
				const actualRh = Array.isArray(d.rejectedRedHerrings) ? [...new Set(d.rejectedRedHerrings)].sort() : [];
				const rhOk =
					actualRh.length === exp.rejectedRedHerrings.length &&
					actualRh.every((s, idx) => s === exp.rejectedRedHerrings[idx]);
				const remOk =
					d.remediationConfig?.service === exp.remediationConfig.service &&
					d.remediationConfig?.parameter === exp.remediationConfig.parameter &&
					d.remediationConfig?.targetValue === exp.remediationConfig.targetValue;

				if (rootOk) rootHits++;
				if (commitOk) commitHits++;
				if (chainOk) chainHits++;
				if (rhOk) redHerringHits++;
				if (remOk) remediationHits++;
				const seatScore = (Number(rootOk) + Number(commitOk) + Number(chainOk) + Number(rhOk) + Number(remOk)) / 5;
				seatScores.push(seatScore);
				if (seatScore === 1) exactSeats++;
			} catch {
				seatScores.push(0);
			}
		}

		const meanSeatScore = Math.round((seatScores.reduce((a, b) => a + b, 0) / inst.n) * 1e4) / 1e4;
		const passed = exactSeats === inst.n;
		return {
			passed,
			score: meanSeatScore,
			customMetrics: {
				presentSeats,
				exactSeats,
				consensusRate: Math.round((exactSeats / inst.n) * 1e4) / 1e4,
				rootCauseRate: Math.round((rootHits / inst.n) * 1e4) / 1e4,
				faultyCommitRate: Math.round((commitHits / inst.n) * 1e4) / 1e4,
				causalChainRate: Math.round((chainHits / inst.n) * 1e4) / 1e4,
				redHerringRejectionRate: Math.round((redHerringHits / inst.n) * 1e4) / 1e4,
				remediationRate: Math.round((remediationHits / inst.n) * 1e4) / 1e4,
			},
			details: passed
				? `All ${inst.n}/${inst.n} seats reached exact causal RCA consensus (root=${exp.rootCauseService}, chain=${exp.causalChain.join("->")}).`
				: `${exactSeats}/${inst.n} seats exact (score=${meanSeatScore}; root=${rootHits}, commit=${commitHits}, chain=${chainHits}, redHerrings=${redHerringHits}, rem=${remediationHits}).`,
		};
	},

	async buildReferenceArtifact({ prepared, outDir }): Promise<void> {
		const inst = JSON.parse(readFileSync(join(prepared.hiddenDir, "instance.json"), "utf8")) as IncidentInstance;
		mkdirSync(join(outDir, "submissions"), { recursive: true });
		for (let i = 0; i < inst.n; i++) {
			writeFileSync(
				join(outDir, "submissions", `seat_${i}.json`),
				JSON.stringify({ seat: i, ...inst.expected }, null, 2) + "\n",
			);
		}
	},
};
