import type { CompactionEvent, WorkerCompactionPolicy } from "@one-piece/core";

export interface GenericMessage {
	role: string;
	content: unknown;
	toolName?: string;
	isError?: boolean;
	timestamp?: number;
	[key: string]: unknown;
}

/** Fast deterministic token estimate (char/4 + per-message framing overhead). */
export function estimateMessageTokens(messages: readonly GenericMessage[], systemPrompt = ""): number {
	let chars = systemPrompt.length;
	for (const msg of messages) {
		chars += 24;
		if (typeof msg.content === "string") {
			chars += msg.content.length;
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block && typeof block === "object") {
					const b = block as Record<string, unknown>;
					if (typeof b.text === "string") chars += b.text.length;
					else if (typeof b.thinking === "string") chars += b.thinking.length;
					else chars += JSON.stringify(b).length;
				}
			}
		} else if (msg.content !== undefined) {
			chars += JSON.stringify(msg.content).length;
		}
	}
	return Math.ceil(chars / 4);
}

function extractBlockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type?: string; text?: string } => Boolean(b && typeof b === "object"))
		.map((b) => (typeof b.text === "string" ? b.text : ""))
		.filter(Boolean)
		.join("\n");
}

/** Extract concise error/failure records from conversation history so compaction never drops negative results. */
export function extractFailedApproaches(messages: readonly GenericMessage[], limit = 8): string[] {
	const failures: string[] = [];
	for (const msg of messages) {
		if (msg.role === "toolResult" && msg.isError) {
			const text = extractBlockText(msg.content).replace(/\s+/g, " ").trim();
			if (text) {
				const tool = typeof msg.toolName === "string" ? `${msg.toolName}: ` : "";
				failures.push(`${tool}${text.slice(0, 180)}`);
			}
		}
	}
	return failures.slice(-limit);
}

/**
 * Tier 1A — Cache-Safe Micro-Compaction:
 * Replaces old large tool-result outputs (older than `keepRecentTurns` messages and > `minPruneBytes`)
 * with compact pointers to losslessly stored SHA-256 artifacts.
 * ONLY called once context crosses the watermark (never per turn), preserving KV cache between watermarks.
 */
export function microCompactMessages<T extends GenericMessage>(
	messages: readonly T[],
	opts: {
		keepRecentTurns?: number;
		minPruneBytes?: number;
		spillArtifact?: (label: string, content: string) => { id: string; sha256: string };
	} = {},
): { messages: T[]; prunedCount: number } {
	const keepRecent = Math.max(2, opts.keepRecentTurns ?? 6);
	const minBytes = Math.max(256, opts.minPruneBytes ?? 1024);
	const cutoff = Math.max(0, messages.length - keepRecent);
	let prunedCount = 0;

	const next = messages.map((msg, idx) => {
		if (idx >= cutoff || msg.role !== "toolResult") return msg;
		const fullText = extractBlockText(msg.content);
		const bytes = Buffer.byteLength(fullText, "utf8");
		if (bytes < minBytes) return msg;
		// Skip already-pruned stubs
		if (fullText.startsWith("[pruned tool output")) return msg;

		prunedCount += 1;
		const label = `pruned-${String(msg.toolName ?? "tool")}-${idx}`;
		const ref = opts.spillArtifact?.(label, fullText);
		const firstLine = fullText.split("\n")[0]?.replace(/\s+/g, " ").trim().slice(0, 140) ?? "";
		const errSummary = msg.isError && firstLine ? ` (${firstLine})` : "";
		const stub = ref
			? `[pruned tool output${errSummary} (${bytes} bytes) -> artifact_id=${ref.id} sha=${ref.sha256.slice(0, 12)}; call read_artifact to inspect]`
			: `[pruned tool output${errSummary} (${bytes} bytes); first line: ${firstLine}]`;

		return {
			...msg,
			content: [{ type: "text", text: stub }],
		};
	});

	return { messages: next, prunedCount };
}

/**
 * Tier 1B — Structured Anchor Compaction:
 * Collapses older turns into a single structured anchor message preserving goal, verified facts,
 * failed approaches (negative memory), and recent tail turns verbatim.
 */
export function buildStructuredAnchorMessages<T extends GenericMessage>(
	messages: readonly T[],
	opts: { keepRecentTurns?: number; failedApproaches?: string[] } = {},
): { messages: T[]; prunedCount: number; failedApproaches: string[] } {
	const keepRecent = Math.max(4, opts.keepRecentTurns ?? 6);
	if (messages.length <= keepRecent + 1) {
		return { messages: [...messages], prunedCount: 0, failedApproaches: opts.failedApproaches ?? [] };
	}

	// Never split in the middle of an assistant toolCall -> toolResult sequence (APIs reject orphaned toolResults with HTTP 400).
	let splitIdx = messages.length - keepRecent;
	while (splitIdx > 0 && messages[splitIdx]?.role === "toolResult") {
		splitIdx -= 1;
	}
	if (splitIdx <= 1) {
		return { messages: [...messages], prunedCount: 0, failedApproaches: opts.failedApproaches ?? [] };
	}

	const older = messages.slice(0, splitIdx);
	const recent = messages.slice(splitIdx);
	const firstUser = older.find((m) => m.role === "user");
	const goalSnippet = firstUser ? extractBlockText(firstUser.content).slice(0, 600) : "(see workspace)";
	const failed = opts.failedApproaches?.length ? opts.failedApproaches : extractFailedApproaches(older);
	const assistantNotes = older
		.filter((m) => m.role === "assistant")
		.map((m) => extractBlockText(m.content).replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.slice(-4)
		.map((s) => `- ${s.slice(0, 200)}`);

	const anchorText = [
		`[STRUCTURED COMPACTION ANCHOR — ${older.length} earlier messages compressed]`,
		``,
		`## Goal`,
		goalSnippet,
		``,
		`## Recent Verified Progress`,
		assistantNotes.length ? assistantNotes.join("\n") : "- (inspect git diff in workspace)",
		``,
		`## Failed Approaches (DO NOT REPEAT)`,
		failed.length ? failed.map((f) => `- ${f}`).join("\n") : "- (none recorded)",
		``,
		`## Next Step`,
		`Continue from the recent turns below and verify on disk before calling report_finding.`,
	].join("\n");

	const anchorMsg = {
		role: "user",
		content: [{ type: "text", text: anchorText }],
		timestamp: Date.now(),
	} as unknown as T;

	return {
		messages: [anchorMsg, ...recent],
		prunedCount: older.length,
		failedApproaches: failed,
	};
}

export type CompactionOutcome<T extends GenericMessage> =
	| {
		readonly kind: "unchanged";
		readonly messages: T[];
		readonly compacted?: never;
		readonly compactionCount: number;
		readonly needsHandoff: boolean;
		readonly failedApproaches: string[];
	}
	| {
		readonly kind: "compacted";
		readonly messages: T[];
		readonly compacted: CompactionEvent;
		readonly compactionCount: number;
		readonly needsHandoff: boolean;
		readonly failedApproaches: string[];
	};

/**
 * Evaluates watermark compaction policy for an in-process session.
 * Returns updated messages + compaction event ONLY when crossing the watermark.
 */
export function maybeCompactSession<T extends GenericMessage>(input: {
	messages: readonly T[];
	systemPrompt: string;
	contextWindow: number;
	lastReportedInputTokens?: number;
	compactionCount: number;
	policy?: WorkerCompactionPolicy;
}): CompactionOutcome<T> {
	const watermark = input.policy?.watermarkFraction ?? 0.70;
	const maxCompactions = input.policy?.maxCompactionsBeforeHandoff ?? 2;
	const estTokens = Math.max(
		estimateMessageTokens(input.messages, input.systemPrompt),
		input.lastReportedInputTokens ?? 0,
	);
	const threshold = Math.floor(input.contextWindow * watermark);

	if (estTokens < threshold) {
		return {
			kind: "unchanged",
			messages: [...input.messages],
			compactionCount: input.compactionCount,
			needsHandoff: false,
			failedApproaches: [],
		};
	}

	const failedApproaches = extractFailedApproaches(input.messages);

	// Try Tier 1A micro-compaction first (spilling old large tool outputs to artifacts).
	const micro = microCompactMessages(input.messages, {
		keepRecentTurns: input.policy?.keepRecentTurns ?? 6,
		minPruneBytes: input.policy?.minPruneBytes ?? 1024,
		spillArtifact: input.policy?.spillArtifact,
	});
	const afterMicroTokens = estimateMessageTokens(micro.messages, input.systemPrompt);

	if (micro.prunedCount > 0 && afterMicroTokens < Math.floor(input.contextWindow * Math.max(0.55, watermark - 0.05))) {
		const nextCount = input.compactionCount + 1;
		const event: CompactionEvent = {
			strategy: "micro",
			beforeTokens: estTokens,
			afterTokens: afterMicroTokens,
			prunedCount: micro.prunedCount,
			compactionCount: nextCount,
		};
		input.policy?.onCompacted?.(event);
		return {
			kind: "compacted",
			messages: micro.messages,
			compacted: event,
			compactionCount: nextCount,
			needsHandoff: nextCount >= maxCompactions,
			failedApproaches,
		};
	}

	// Escalate to Tier 1B structured anchor compaction.
	const anchor = buildStructuredAnchorMessages(micro.messages, {
		keepRecentTurns: input.policy?.keepRecentTurns ?? 6,
		failedApproaches,
	});
	if (anchor.prunedCount === 0 && micro.prunedCount === 0) {
		return {
			kind: "unchanged",
			messages: micro.messages,
			compactionCount: input.compactionCount,
			needsHandoff: input.compactionCount >= maxCompactions,
			failedApproaches,
		};
	}

	const afterAnchorTokens = estimateMessageTokens(anchor.messages, input.systemPrompt);
	const nextCount = input.compactionCount + 1;
	const event: CompactionEvent = {
		strategy: "anchor",
		beforeTokens: estTokens,
		afterTokens: afterAnchorTokens,
		prunedCount: micro.prunedCount + anchor.prunedCount,
		compactionCount: nextCount,
	};
	input.policy?.onCompacted?.(event);
	return {
		kind: "compacted",
		messages: anchor.messages,
		compacted: event,
		compactionCount: nextCount,
		needsHandoff: nextCount >= maxCompactions,
		failedApproaches: anchor.failedApproaches,
	};
}
