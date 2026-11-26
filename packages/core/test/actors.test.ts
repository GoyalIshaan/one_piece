import { expect, it } from "vitest";
import { EventBus, MemoryStore, PermitActor, Redactor } from "../src/index.ts";

it("delivers nested events in durable sequence with independent payloads", () => {
	const store = new MemoryStore();
	const bus = new EventBus(store, new Redactor());
	const seen: string[] = [];
	bus.on(event => {
		if (event.type === "parent") bus.emit("run", "child", { value: "child" }).data.value = "caller edit";
		event.data.value = "listener edit";
	});
	bus.on(event => seen.push(event.seq + "/" + event.data.value));
	bus.emit("run", "parent", { value: "parent" });
	expect(seen).toEqual(["1/parent", "2/child"]);
	store.events("run")[0]!.data.value = "reader edit";
	expect(store.events("run").map(event => event.data.value)).toEqual(["parent", "child"]);
});

it("ignores late pacing replies after cancellation and releases capacity on pacing failure", async () => {
	const attempts: PromiseWithResolvers<void>[] = [];
	const permits = new PermitActor(1, async () => {
		const attempt = Promise.withResolvers<void>();
		attempts.push(attempt);
		await attempt.promise;
	});
	const controller = new AbortController();
	const first = permits.acquire(controller.signal);
	const second = permits.acquire();
	const third = permits.acquire();
	await Promise.resolve();
	controller.abort(new Error("cut"));
	await expect(first).rejects.toThrow("cut");
	attempts[0]!.resolve();
	attempts[1]!.reject(new Error("rate file unavailable"));
	await expect(second).rejects.toThrow("rate file unavailable");
	attempts[2]!.resolve();
	const release = await third;
	expect([permits.running, permits.waiting, permits.calls]).toEqual([1, 0, 1]);
	release();
	release();
	expect(permits.free).toBe(1);
});

it("admits a burst in FIFO order while never exceeding capacity", async () => {
	const permits = new PermitActor(4);
	const admitted: number[] = [];
	await Promise.all(Array.from({ length: 128 }, async (_, id) => {
		const release = await permits.acquire();
		admitted.push(id);
		expect(permits.running).toBeLessThanOrEqual(4);
		await Promise.resolve();
		release();
	}));
	expect(admitted).toEqual(Array.from({ length: 128 }, (_, id) => id));
	expect([permits.free, permits.waiting, permits.calls]).toEqual([4, 0, 128]);
});
