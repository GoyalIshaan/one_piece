import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SharedRequestWindow } from "../src/index.ts";

it("admits starts against the same sliding window across independent routers", async () => {
	const dir = mkdtempSync(join(tmpdir(), "op-shared-rate-"));
	try {
		const path = join(dir, "provider.json");
		let now = 1000;
		const first = new SharedRequestWindow(path, () => now);
		const second = new SharedRequestWindow(path, () => now);
		const competing = await Promise.all([first.reserve(1), second.reserve(1)]);
		expect(competing.sort((a, b) => a - b)).toEqual([0, 60_000]);
		now = 60_999;
		expect(await second.reserve(1)).toBe(1);
		now = 61_000;
		expect(await first.reserve(1)).toBe(0);
		await expect(second.reserve(1, AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
