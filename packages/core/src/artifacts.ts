import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EventBus } from "./events.ts";
import { newId } from "./ids.ts";
import type { ArtifactReadPage, ArtifactStore } from "./topology.ts";
import type { ArtifactRecord } from "./types.ts";

const DEFAULT_PREVIEW_BYTES = 2_400;
const DEFAULT_PAGE_BYTES = 4_096;

/** Trim a Buffer to the last valid UTF-8 character boundary within maxBytes. */
function sliceUtf8Boundary(buf: Buffer, maxBytes: number): { text: string; bytesConsumed: number } {
	if (buf.length <= maxBytes) return { text: buf.toString("utf8"), bytesConsumed: buf.length };
	let end = maxBytes;
	// Walk back past UTF-8 continuation bytes (10xxxxxx).
	while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
	if (end === 0) end = maxBytes;
	return { text: buf.subarray(0, end).toString("utf8"), bytesConsumed: end };
}

/**
 * Runtime-agnostic content-addressed artifact store.
 * Stores oversized tool outputs, diffs, and logs by SHA-256 with UTF-8 boundary-safe paging.
 */
export class FileArtifactStore implements ArtifactStore {
	private readonly dir: string;
	private readonly runId: string;
	private readonly bus: EventBus;
	private readonly bySha = new Map<string, ArtifactRecord>();
	private readonly byId = new Map<string, ArtifactRecord>();

	constructor(runId: string, runDir: string, bus: EventBus) {
		this.runId = runId;
		this.dir = resolve(runDir, "artifacts");
		this.bus = bus;
		mkdirSync(this.dir, { recursive: true });
		for (const existing of bus.store.list("artifacts", { runId })) {
			this.byId.set(existing.id, existing);
			this.bySha.set(existing.sha256, existing);
		}
	}

	put(label: string, content: string | Buffer, opts: { mimeType?: string; createdBy?: string } = {}): ArtifactRecord {
		const raw = typeof content === "string"
			? Buffer.from(this.bus.redactor.redactText(content), "utf8")
			: content;
		const sha256 = createHash("sha256").update(raw).digest("hex");
		const existing = this.bySha.get(sha256);
		if (existing && existsSync(existing.path)) return existing;

		const path = join(this.dir, `${sha256}.blob`);
		if (!existsSync(path)) writeFileSync(path, raw);
		const record: ArtifactRecord = {
			id: newId("art"),
			runId: this.runId,
			sha256,
			label,
			mimeType: opts.mimeType ?? "text/plain",
			bytes: raw.length,
			path,
			createdBy: opts.createdBy,
			createdAt: Date.now(),
		};
		this.byId.set(record.id, record);
		this.bySha.set(sha256, record);
		this.bus.store.put("artifacts", record);
		this.bus.emit(this.runId, "artifact.stored", {
			artifactId: record.id,
			sha256,
			bytes: raw.length,
			label,
		}, opts.createdBy);
		return record;
	}

	get(idOrSha: string): ArtifactRecord | undefined {
		const direct = this.byId.get(idOrSha) ?? this.bySha.get(idOrSha);
		if (direct) return direct;
		// Allow short SHA prefix lookup (≥8 hex chars).
		if (/^[a-f0-9]{8,64}$/i.test(idOrSha)) {
			for (const [sha, record] of this.bySha) {
				if (sha.startsWith(idOrSha.toLowerCase())) return record;
			}
		}
		return undefined;
	}

	preview(record: ArtifactRecord, maxBytes = DEFAULT_PREVIEW_BYTES): string {
		const page = this.read(record.id, 0, maxBytes);
		if (page.eof) return page.content;
		return `${page.content}\n...[truncated ${record.bytes - page.nextOffset} bytes; call read_artifact("${record.id}", offset=${page.nextOffset}) to continue]`;
	}

	read(idOrSha: string, offset = 0, limitBytes = DEFAULT_PAGE_BYTES): ArtifactReadPage {
		const record = this.get(idOrSha);
		if (!record || !existsSync(record.path)) {
			throw new Error(`Artifact "${idOrSha}" not found`);
		}
		const totalBytes = statSync(record.path).size;
		const start = Math.max(0, Math.min(totalBytes, Math.floor(offset)));
		const length = Math.max(1, Math.min(64_000, Math.floor(limitBytes)));
		const toRead = Math.min(totalBytes - start, length + 4);
		if (toRead <= 0) {
			return { artifactId: record.id, sha256: record.sha256, offset: start, nextOffset: totalBytes, totalBytes, eof: true, content: "" };
		}
		const buf = Buffer.allocUnsafe(toRead);
		const fd = openSync(record.path, "r");
		try {
			const n = readSync(fd, buf, 0, toRead, start);
			const slice = buf.subarray(0, n);
			const { text, bytesConsumed } = sliceUtf8Boundary(slice, Math.min(length, n));
			const nextOffset = start + bytesConsumed;
			return {
				artifactId: record.id,
				sha256: record.sha256,
				offset: start,
				nextOffset,
				totalBytes,
				eof: nextOffset >= totalBytes,
				content: text,
			};
		} finally {
			closeSync(fd);
		}
	}
}
