import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileCredentialStore } from "../src/index.ts";

describe("file credential store", () => {
	it("serializes updates from independent stores and observes the rotated credential", async () => {
		const dir = mkdtempSync(join(tmpdir(), "op-credential-"));
		const path = join(dir, "auth.json");
		try {
			const a = new FileCredentialStore(path);
			const b = new FileCredentialStore(path);
			const initial = { type: "oauth", refresh: "old", access: "old", expires: 1 } as const;
			const refreshed = { ...initial, refresh: "rotated", access: "new", expires: 2 };
			await a.modify("test", async () => initial);
			let releaseFirst!: () => void;
			const writable = new Promise<void>((resolve) => { releaseFirst = resolve; });
			let firstEntered!: () => void;
			const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
			const first = a.modify("test", async (current) => {
				expect(current).toEqual(initial);
				firstEntered();
				await writable;
				return refreshed;
			});
			await entered;
			const second = b.modify("test", async (current) => {
				expect(current).toEqual(refreshed);
				return undefined;
			});
			releaseFirst();
			expect(await Promise.all([first, second])).toEqual([refreshed, refreshed]);
			expect(await b.read("test")).toEqual(refreshed);
			expect(statSync(path).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
