import { createHash } from "node:crypto";
import { constants, fstatSync, lstatSync, openSync, closeSync, readSync, realpathSync } from "node:fs";
import { lstat, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { basename, isAbsolute, relative, resolve, sep, join } from "node:path";
import { isSandboxReadBlocked, newId } from "@one-piece/core";

function relativeFile(root: string, path: string): string {
	const full = resolve(root, path);
	const local = relative(root, full);
	if (!local || isAbsolute(path) || isAbsolute(local) || local === ".." || local.startsWith(".." + sep) || path.split(sep).includes(".."))
		throw new Error("Input path must be relative to its workspace directory");
	return full;
}

function verifyPath(path: string, canonical: string): void {
	if (canonical !== path || isSandboxReadBlocked(canonical)) throw new Error("Input must be a regular file inside the source workspace");
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function digestInputSync(root: string, path: string): string {
	const full = relativeFile(root, path);
	try {
		verifyPath(full, realpathSync(full));
	} catch (error) {
		if (missing(error)) return "missing";
		throw error;
	}
	const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = fstatSync(fd, { bigint: true });
		const named = lstatSync(full, { bigint: true });
		if (!before.isFile() || named.ino !== before.ino || named.dev !== before.dev) throw new Error("Input must be a regular file inside the source workspace");
		const buffer = Buffer.allocUnsafe(384 * 1024);
		const hash = createHash("sha256");
		for (let bytes = readSync(fd, buffer); bytes > 0; bytes = readSync(fd, buffer)) hash.update(buffer.subarray(0, bytes));
		const after = fstatSync(fd, { bigint: true });
		const current = lstatSync(full, { bigint: true });
		verifyPath(full, realpathSync(full));
		if (after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.ino !== current.ino || after.dev !== current.dev)
			throw new Error("Input changed while being hashed");
		return hash.digest("hex");
	} finally { closeSync(fd); }
}

export async function digestInput(root: string, path: string, signal?: AbortSignal): Promise<string> {
	const full = relativeFile(root, path);
	try {
		verifyPath(full, await realpath(full));
	} catch (error) {
		if (missing(error)) return "missing";
		throw error;
	}
	const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await file.stat({ bigint: true });
		const named = await lstat(full, { bigint: true });
		if (!before.isFile() || before.ino !== named.ino || before.dev !== named.dev) throw new Error("Input must be a regular file inside the source workspace");
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(384 * 1024);
		for (;;) {
			signal?.throwIfAborted();
			const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			hash.update(buffer.subarray(0, bytesRead));
		}
		const after = await file.stat({ bigint: true });
		const current = await lstat(full, { bigint: true });
		verifyPath(full, await realpath(full));
		if (after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.ino !== current.ino || after.dev !== current.dev)
			throw new Error("Input changed while being hashed");
		return hash.digest("hex");
	} finally { await file.close(); }
}

/** Publish a copied artifact only after matching the sender's cited digest. */
export async function stageInput(sourceRoot: string, path: string, targetRoot: string, expected: string, signal?: AbortSignal) {
	if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error("Supply the expected SHA-256 from the source receipt");
	const source = relativeFile(sourceRoot, path);
	verifyPath(source, await realpath(source));
	signal?.throwIfAborted();
	const scratch = await mkdtemp(join(targetRoot, ".input-staging-"));
	try {
		const name = basename(source);
		const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const opened = await file.stat({ bigint: true });
			const named = await lstat(source, { bigint: true });
			verifyPath(source, await realpath(source));
			if (!opened.isFile() || named.ino !== opened.ino || named.dev !== opened.dev)
				throw new Error("Input must be a regular file inside the source workspace");
			await pipeline(file.createReadStream({ autoClose: false }), createWriteStream(join(scratch, name), { flags: "wx", mode: 0o600 }), { signal });
		} finally { await file.close(); }
		const sha256 = await digestInput(scratch, name, signal);
		if (sha256 !== expected.toLowerCase()) throw new Error(`Input digest mismatch for ${path}`);
		const bytes = (await lstat(join(scratch, name))).size;
		signal?.throwIfAborted();
		const folder = newId("job-input");
		await rename(scratch, join(targetRoot, folder));
		return { path: join(folder, name), sha256, bytes };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
