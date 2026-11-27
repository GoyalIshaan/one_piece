import type { ArtifactStore, BoardPost, Finding, HarnessEvent, Store, ToolDefinition } from "@one-piece/core";

export interface TraceNavEvent {
	readonly seq: number;
	readonly ts: number;
	readonly type: string;
	readonly agentId?: string;
	readonly data: Record<string, unknown>;
}

export interface TraceNavAgent {
	readonly id: string;
	readonly role: string;
	readonly handle?: string;
	readonly driverId?: string;
	readonly status?: string;
}

export interface TraceNavPost {
	readonly id: string;
	readonly authorAgentId: string;
	readonly title?: string;
	readonly body: string;
	readonly visibility?: string;
	readonly parentIds?: readonly string[];
	readonly createdAt?: number;
}

export interface TraceNavFinding {
	readonly id: string;
	readonly authorAgentId: string;
	readonly status: string;
	readonly claim: string;
	readonly summary: string;
	readonly evidence: readonly string[];
	readonly score?: number;
	readonly checks?: readonly { checker: string; status: string; message: string; score?: number }[];
}

export interface TraceNavScoreHint {
	readonly judgeName: string;
	readonly label: string;
	readonly prob: number;
	readonly agentId: string | null;
	readonly seqStart: number;
	readonly seqEnd: number;
}

export interface TraceNavBackend {
	readonly runId: string;
	readonly goalTitle?: string;
	readonly goalText?: string;
	listEvents(): readonly TraceNavEvent[];
	listAgents(): readonly TraceNavAgent[];
	listPosts(): readonly TraceNavPost[];
	listFindings(): readonly TraceNavFinding[];
	listScoreHints?(): readonly TraceNavScoreHint[];
	readArtifact?(idOrSha: string, offset?: number, limitBytes?: number): string | undefined;
}

const MAX_WINDOW_EVENTS = 40;
const MAX_WINDOW_BYTES = 8_192;

const ANCHOR_EVENT_TYPES = new Set([
	"board.promoted",
	"peer.conflict_detected",
	"peer.conflict_resolved",
	"refinery.conflict_resolved",
	"refinery.semantic_regression",
	"peer.trunk_repaired",
	"finding.reported",
	"finding.verification",
	"finding.verdict",
	"agent.stalled",
	"agent.escalated",
	"agent.handoff",
	"quota.retry",
	"quota.cooldown",
	"quota.drained",
	"adaptive.morphed",
	"phase.changed",
	"run.nominated",
]);

export function isAnchorTraceEvent(ev: TraceNavEvent): boolean {
	if (ANCHOR_EVENT_TYPES.has(ev.type)) return true;
	if (
		(ev.type === "driver.tool_result" || ev.type === "mcp.tool_result" || ev.type === "tool.result") &&
		ev.data.isError === true
	) {
		return true;
	}
	if (ev.type === "workspace.command" && typeof ev.data.exitCode === "number" && ev.data.exitCode !== 0) {
		return true;
	}
	if (ev.type === "agent.turn" && (ev.data.status === "failed" || ev.data.status === "rate_limited")) {
		return true;
	}
	return false;
}

export function formatCompactTraceEvent(ev: TraceNavEvent, maxChars = 240): string {
	const who = ev.agentId ? ` ${ev.agentId}` : "";
	const raw = JSON.stringify(ev.data);
	const body = raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
	return `[seq ${ev.seq}]${who} ${ev.type}: ${body}`;
}

function formatBoundedEventList(events: readonly TraceNavEvent[], maxEvents = MAX_WINDOW_EVENTS, maxBytes = MAX_WINDOW_BYTES): string {
	const lines: string[] = [];
	let bytes = 0;
	const sliced = events.slice(0, maxEvents);
	for (const ev of sliced) {
		const line = formatCompactTraceEvent(ev, 240);
		if (bytes + line.length + 1 > maxBytes && lines.length > 0) {
			lines.push(`... [truncated at ${maxBytes} bytes; narrow seq_start/seq_end or filter by agent_id]`);
			break;
		}
		lines.push(line);
		bytes += line.length + 1;
	}
	if (events.length > maxEvents) {
		lines.push(`... [${events.length - maxEvents} additional events omitted; narrow range to inspect]`);
	}
	return lines.join("\n") || "(no matching events)";
}

/**
 * Build an anchored transcript brief for `TrustLayer`'s `transcript-audit` review lens:
 * surfaces total event span, Head (first 5 events: plan/constraints), Anchor events
 * (errors, verifications, conflicts, board promotions, findings), and Tail (last 10 events)
 * instead of blindly taking `.slice(-30)`.
 */
export function buildAnchoredTranscriptBrief(
	events: readonly TraceNavEvent[],
	opts: { authorAgentId?: string; maxBytes?: number } = {},
): string {
	const relevant = opts.authorAgentId
		? events.filter((e) => e.agentId === opts.authorAgentId)
		: [...events];
	if (!relevant.length) return "(no tool or turn events recorded for author)";

	const minSeq = relevant[0]!.seq;
	const maxSeq = relevant.at(-1)!.seq;
	const head = relevant.slice(0, 5);
	const tail = relevant.slice(-10);
	const anchors = relevant.filter((e) => isAnchorTraceEvent(e));

	const selected = new Map<number, { ev: TraceNavEvent; tag: string }>();
	for (const ev of head) selected.set(ev.seq, { ev, tag: "HEAD" });
	for (const ev of anchors.slice(0, 20)) {
		if (!selected.has(ev.seq)) selected.set(ev.seq, { ev, tag: "ANCHOR" });
	}
	for (const ev of tail) {
		if (!selected.has(ev.seq)) selected.set(ev.seq, { ev, tag: "TAIL" });
	}

	const ordered = [...selected.values()].sort((a, b) => a.ev.seq - b.ev.seq);
	const header = `Transcript span: ${relevant.length} event(s) (seq ${minSeq}..${maxSeq}; anchors=${anchors.length}, showing ${ordered.length} key events). Use trace_expand_window / trace_search_events / trace_get_peer_context to inspect gaps.`;
	const lines = [header];
	const limit = opts.maxBytes ?? 4_800;
	let bytes = header.length + 1;

	for (const { ev, tag } of ordered) {
		const line = `- (${tag}) ${formatCompactTraceEvent(ev, 210)}`;
		if (bytes + line.length + 1 > limit) {
			lines.push(`- ... [brief capped at ${limit}B; call trace_expand_window or trace_search_events for full history]`);
			break;
		}
		lines.push(line);
		bytes += line.length + 1;
	}
	return lines.join("\n");
}

/**
 * Wrap a live `Store` + optional `ArtifactStore` (inside `SwarmOS` / `TrustLayer`) as a `TraceNavBackend`.
 */
export function createStoreTraceNavBackend(opts: {
	runId: string;
	store: Store;
	artifacts?: ArtifactStore;
}): TraceNavBackend {
	const run = opts.store.get("runs", opts.runId);
	return {
		runId: opts.runId,
		goalTitle: run?.goal.title,
		goalText: run?.goal.text,
		listEvents(): readonly TraceNavEvent[] {
			return opts.store.events(opts.runId).map((ev: HarnessEvent) => ({
				seq: ev.seq,
				ts: ev.ts,
				type: ev.type,
				agentId: ev.nodeId,
				data: ev.data,
			}));
		},
		listAgents(): readonly TraceNavAgent[] {
			return opts.store.list("agents", { runId: opts.runId }).map((a) => ({
				id: a.id,
				role: a.role,
				handle: a.handle,
				driverId: a.driverId,
				status: a.status,
			}));
		},
		listPosts(): readonly TraceNavPost[] {
			return opts.store.list("posts", { runId: opts.runId }).map((p: BoardPost) => {
				const cited = new Set<string>();
				if (p.parentPostId) cited.add(p.parentPostId);
				for (const ref of p.references ?? []) {
					if (ref.postId) cited.add(ref.postId);
				}
				return {
					id: p.id,
					authorAgentId: p.authorAgentId,
					title: p.topic || p.summary,
					body: p.body || p.summary,
					visibility: p.visibility,
					parentIds: cited.size ? [...cited] : undefined,
					createdAt: p.createdAt,
				};
			});
		},
		listFindings(): readonly TraceNavFinding[] {
			return opts.store.list("findings", { runId: opts.runId }).map((f: Finding) => {
				const latest = f.submissions.at(-1);
				return {
					id: f.id,
					authorAgentId: f.authorAgentId,
					status: f.status,
					claim: f.claim,
					summary: f.summary,
					evidence: f.evidence,
					score: f.score,
					checks: latest?.checks.map((c) => ({
						checker: c.checker,
						status: c.status,
						message: c.message,
						score: c.score,
					})),
				};
			});
		},
		readArtifact(idOrSha: string, offset = 0, limitBytes = 4096): string | undefined {
			if (!opts.artifacts) return undefined;
			try {
				return opts.artifacts.read(idOrSha, offset, Math.min(limitBytes, 8192)).content;
			} catch {
				return undefined;
			}
		},
	};
}

/**
 * Create the 5 read-only, strictly bounded trace-navigation tools shared by:
 * 1. Online `TrustLayer` `transcript-audit` reviewers, and
 * 2. Offline Tier-2 escalated Agent-as-Judge (`eval-lab diagnose --escalate`).
 */
export function createTraceNavTools(backend: TraceNavBackend): ToolDefinition[] {
	return [
		{
			name: "trace_list_anchors",
			description:
				"Return a compact table of contents for the run: goal, agents/roles, findings, board posts, error/conflict/verdict anchor seqs, and any existing trace_scores hints.",
			inputSchema: {
				type: "object",
				properties: {
					max_anchors: { type: "number", minimum: 1, maximum: 60 },
				},
			},
			execute(args) {
				const maxAnchors = Math.min(60, Math.max(1, Number(args.max_anchors ?? 30)));
				const events = backend.listEvents();
				const agents = backend.listAgents();
				const posts = backend.listPosts();
				const findings = backend.listFindings();
				const anchors = events.filter(isAnchorTraceEvent).slice(0, maxAnchors);
				const hints = backend.listScoreHints?.() ?? [];

				const lines: string[] = [
					`Run: ${backend.runId} (events=${events.length}, seq ${events[0]?.seq ?? 0}..${events.at(-1)?.seq ?? 0})`,
					...(backend.goalTitle ? [`Goal: ${backend.goalTitle}`] : []),
					...(backend.goalText ? [`Goal Text: ${backend.goalText.slice(0, 400)}`] : []),
					"",
					`Agents (${agents.length}): ${agents.map((a) => `${a.id}(${a.role}${a.driverId ? `/${a.driverId}` : ""})`).join(", ") || "none"}`,
					`Board Posts (${posts.length}): ${posts.slice(0, 12).map((p) => `${p.id}[${p.visibility ?? "global"} by ${p.authorAgentId}: ${(p.title ?? p.body).slice(0, 60)}]`).join("; ") || "none"}`,
					`Findings (${findings.length}): ${findings.map((f) => `${f.id}[${f.status} score=${f.score ?? "n/a"} by ${f.authorAgentId}: ${f.claim.slice(0, 80)}]`).join("; ") || "none"}`,
				];
				if (hints.length) {
					lines.push(
						"",
						`Existing Trace Score Hints (${hints.length}):`,
						...hints.slice(0, 20).map(
							(h) => `- ${h.judgeName}=${h.label} (p=${h.prob.toFixed(2)}, agent=${h.agentId ?? "all"}, seq ${h.seqStart}..${h.seqEnd})`,
						),
					);
				}
				lines.push(
					"",
					`Key Anchors (${anchors.length}):`,
					...anchors.map((a) => `- ${formatCompactTraceEvent(a, 180)}`),
				);
				return { text: lines.join("\n").slice(0, MAX_WINDOW_BYTES) };
			},
		},
		{
			name: "trace_expand_window",
			description:
				"Expand backward/forward around a seq range [seq_start..seq_end] by `radius` events (optionally filtered to one `agent_id`). Hard-capped at 40 events / 8 KB.",
			inputSchema: {
				type: "object",
				properties: {
					seq_start: { type: "number" },
					seq_end: { type: "number" },
					radius: { type: "number", minimum: 0, maximum: 25 },
					agent_id: { type: "string" },
				},
				required: ["seq_start", "seq_end"],
			},
			execute(args) {
				const seqStart = Math.max(0, Math.floor(Number(args.seq_start ?? 0)));
				const seqEnd = Math.max(seqStart, Math.floor(Number(args.seq_end ?? seqStart)));
				const radius = Math.min(25, Math.max(0, Math.floor(Number(args.radius ?? 8))));
				const agentId = typeof args.agent_id === "string" && args.agent_id.trim() ? args.agent_id.trim() : undefined;

				const all = backend.listEvents();
				const scoped = agentId ? all.filter((e) => e.agentId === agentId) : all;
				if (!scoped.length) return { text: `(no events found${agentId ? ` for agent ${agentId}` : ""})` };

				let startIdx = scoped.findIndex((e) => e.seq >= seqStart);
				if (startIdx < 0) startIdx = Math.max(0, scoped.length - 1);
				let endIdx = scoped.length - 1;
				for (let i = scoped.length - 1; i >= 0; i--) {
					if (scoped[i]!.seq <= seqEnd) {
						endIdx = i;
						break;
					}
				}
				const lo = Math.max(0, startIdx - radius);
				const hi = Math.min(scoped.length - 1, Math.max(startIdx, endIdx) + radius);
				const slice = scoped.slice(lo, hi + 1);
				const header = `Expanded window (requested ${seqStart}..${seqEnd} ±${radius}${agentId ? `, agent=${agentId}` : ""}; returned ${slice.length} event(s), seq ${slice[0]?.seq ?? 0}..${slice.at(-1)?.seq ?? 0}):`;
				return { text: `${header}\n${formatBoundedEventList(slice)}` };
			},
		},
		{
			name: "trace_search_events",
			description:
				"Search across ALL agents, events, and board posts in the full timeline by keyword/regex and/or event type to locate scattered earlier evidence.",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string" },
					event_types: { type: "array", items: { type: "string" } },
					agent_id: { type: "string" },
					limit: { type: "number", minimum: 1, maximum: 40 },
				},
			},
			execute(args) {
				const query = typeof args.query === "string" ? args.query.trim() : "";
				const eventTypes = Array.isArray(args.event_types)
					? new Set(args.event_types.filter((t): t is string => typeof t === "string"))
					: undefined;
				const agentId = typeof args.agent_id === "string" && args.agent_id.trim() ? args.agent_id.trim() : undefined;
				const limit = Math.min(40, Math.max(1, Math.floor(Number(args.limit ?? 25))));

				let regex: RegExp | undefined;
				if (query) {
					try {
						regex = new RegExp(query, "i");
					} catch {
						regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
					}
				}

				const eventHits: TraceNavEvent[] = [];
				for (const ev of backend.listEvents()) {
					if (agentId && ev.agentId !== agentId) continue;
					if (eventTypes && eventTypes.size > 0 && !eventTypes.has(ev.type)) continue;
					if (regex) {
						const hay = `${ev.type} ${ev.agentId ?? ""} ${JSON.stringify(ev.data)}`;
						if (!regex.test(hay)) continue;
					}
					eventHits.push(ev);
					if (eventHits.length >= limit) break;
				}

				const postHits: string[] = [];
				if (regex && (!eventTypes || eventTypes.size === 0 || eventTypes.has("board.posted"))) {
					for (const p of backend.listPosts()) {
						if (agentId && p.authorAgentId !== agentId) continue;
						const hay = `${p.id} ${p.title ?? ""} ${p.body}`;
						if (regex.test(hay)) {
							postHits.push(`[post ${p.id} by ${p.authorAgentId} (${p.visibility ?? "global"})] ${(p.title ?? "").slice(0, 60)}: ${p.body.slice(0, 220)}`);
							if (postHits.length >= 10) break;
						}
					}
				}

				const sections: string[] = [];
				sections.push(`Event matches (${eventHits.length}):\n${formatBoundedEventList(eventHits, limit, 6_000)}`);
				if (postHits.length) {
					sections.push(`Board post matches (${postHits.length}):\n${postHits.join("\n")}`);
				}
				return { text: sections.join("\n\n").slice(0, MAX_WINDOW_BYTES) };
			},
		},
		{
			name: "trace_get_peer_context",
			description:
				"Inspect what sibling agents and the shared board were doing concurrently around a target `around_seq` (+/- `radius` events).",
			inputSchema: {
				type: "object",
				properties: {
					around_seq: { type: "number" },
					radius: { type: "number", minimum: 1, maximum: 30 },
					exclude_agent_id: { type: "string" },
				},
				required: ["around_seq"],
			},
			execute(args) {
				const center = Math.max(0, Math.floor(Number(args.around_seq ?? 0)));
				const radius = Math.min(30, Math.max(1, Math.floor(Number(args.radius ?? 15))));
				const exclude = typeof args.exclude_agent_id === "string" && args.exclude_agent_id.trim() ? args.exclude_agent_id.trim() : undefined;

				const all = backend.listEvents();
				const nearby = all.filter((e) => {
					if (e.seq < center - radius || e.seq > center + radius) return false;
					if (exclude && e.agentId === exclude && !e.type.startsWith("board.")) return false;
					return true;
				});
				const header = `Peer & board activity around seq ${center} (±${radius}${exclude ? `, excluding non-board events from ${exclude}` : ""}):`;
				return { text: `${header}\n${formatBoundedEventList(nearby)}` };
			},
		},
		{
			name: "trace_read_evidence",
			description:
				"Read full bounded content of a specific board post (`kind='post'`), finding submission & checks (`kind='finding'`), or spilled artifact (`kind='artifact'`).",
			inputSchema: {
				type: "object",
				properties: {
					kind: { type: "string", enum: ["post", "finding", "artifact"] },
					id: { type: "string" },
					offset: { type: "number", minimum: 0 },
					limit: { type: "number", minimum: 100, maximum: 8192 },
				},
				required: ["kind", "id"],
			},
			execute(args) {
				const kind = String(args.kind ?? "");
				const id = String(args.id ?? "").trim();
				const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)));
				const limit = Math.min(8192, Math.max(100, Math.floor(Number(args.limit ?? 4096))));

				if (kind === "post") {
					const post = backend.listPosts().find((p) => p.id === id);
					if (!post) return { text: `Board post "${id}" not found.`, isError: true };
					const text = [
						`Post ${post.id} by ${post.authorAgentId} (visibility=${post.visibility ?? "global"}, parents=${(post.parentIds ?? []).join(",") || "none"})`,
						...(post.title ? [`Title: ${post.title}`] : []),
						"",
						post.body,
					].join("\n");
					return { text: text.slice(offset, offset + limit) };
				}
				if (kind === "finding") {
					const f = backend.listFindings().find((x) => x.id === id);
					if (!f) return { text: `Finding "${id}" not found.`, isError: true };
					const text = JSON.stringify(f, null, 2);
					return { text: text.slice(offset, offset + limit) };
				}
				if (kind === "artifact") {
					const content = backend.readArtifact?.(id, offset, limit);
					if (content === undefined) return { text: `Artifact "${id}" not found or unavailable.`, isError: true };
					return { text: content };
				}
				return { text: `Unsupported evidence kind "${kind}".`, isError: true };
			},
		},
	];
}
