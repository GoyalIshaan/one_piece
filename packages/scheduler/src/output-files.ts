import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import type { JobOutputFile } from "@one-piece/core";

const MAX_OUTPUT_FILES = 8;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export const OUTPUT_FILES_DESCRIPTION = "Paths relative to the job directory whose bytes should be fingerprinted after execution. Up to eight regular files of 2 MiB each. Jobs declaring these files execute fresh.";

export function outputVersion(cwd: string, path: string): string | undefined {
	try {
		const stat = lstatSync(resolve(cwd, path), { bigint: true });
		return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

export function validateOutputFiles(paths: readonly string[]): void {
	if (paths.length > MAX_OUTPUT_FILES) throw new Error(`At most ${MAX_OUTPUT_FILES} output files may be declared`);
	const normalized = new Set<string>();
	for (const path of paths) {
		const local = normalize(path);
		if (isAbsolute(path) || local === "." || path.endsWith(sep) || path.split(sep).includes("..") || path.includes("\0")) {
			throw new Error("Output files must be relative paths inside the job directory");
		}
		if (normalized.has(local)) throw new Error("Output files must be unique");
		normalized.add(local);
	}
}

export function fingerprintOutputFile(cwd: string, path: string, capture?: (buffer: Buffer) => void): JobOutputFile {
	const file = resolve(cwd, path);
	let fd: number | undefined;
	try {
		// Reject aliases, including symlinked parent directories, before opening.
		if (realpathSync(file) !== file) return { path, status: "unavailable" };
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const before = fstatSync(fd, { bigint: true });
		const named = lstatSync(file, { bigint: true });
		if (!before.isFile() || before.nlink !== 1n || before.dev !== named.dev || before.ino !== named.ino || realpathSync(file) !== file) {
			return { path, status: "unavailable" };
		}
		if (before.size > MAX_OUTPUT_BYTES) return { path, status: "too_large" };
		const bytes = Number(before.size);
		const buffer = Buffer.allocUnsafe(bytes);
		let read = 0;
		while (read < bytes) {
			const count = readSync(fd, buffer, read, bytes - read, null);
			if (!count) return { path, status: "changed" };
			read += count;
		}
		const after = fstatSync(fd, { bigint: true });
		const current = lstatSync(file, { bigint: true });
		if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
			|| after.dev !== current.dev || after.ino !== current.ino || realpathSync(file) !== file) {
			return { path, status: "changed" };
		}
		const sha256 = createHash("sha256").update(buffer).digest("hex");
		capture?.(buffer);
		return { path, bytes, sha256 };
	} catch (error) {
		return { path, status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable" };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
