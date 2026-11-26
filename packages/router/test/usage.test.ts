import { createHash } from "node:crypto";
import { createAssistantMessageEventStream, fauxAssistantMessage, getCurrentTools, normalizeContext, type Tool } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { PROVIDER_FACTORIES, Router, type CallRecord } from "../src/index.ts";

it("retains provider usage detail once per model call, including explicit zero", async () => {
	const router = new Router({ providers: [{ id: "sim", models: { default: "fixture" } }] });
	const model = router.resolve({ provider: "sim", id: "fixture" });
	const records: CallRecord[] = [];
	const stream = router.streamFn(record => records.push(record));
	for (const reasoning of [4, 0, undefined]) {
		const response = fauxAssistantMessage("fixture");
		response.usage = { ...response.usage, input: 5, output: 8, cacheRead: 0, cacheReadReported: false,
			cacheWrite: 6, cacheWrite1h: 2, reasoning, totalTokens: 19 };
		const events = createAssistantMessageEventStream();
		events.push({ type: "done", reason: "stop", message: response });
		vi.spyOn(router.models, "streamSimple").mockReturnValueOnce(events);
		await (await stream(model, normalizeContext({ messages: [] }))).result();
	}
	expect(records.map(r => r.reasoningTokens)).toEqual([4, 0, undefined]);
	for (const record of records) {
		expect(record).toMatchObject({ input: 5, output: 8, totalTokens: 19, cacheWriteTokens: 6, cacheWrite1hTokens: 2 });
		expect(record.cacheReadTokens).toBeUndefined();
	}
});

it("records the ordered tool declarations after applying transcript changes", async () => {
	const tools: Tool[] = ["verify", "nominate"].map(name => ({ name, description: `Use ${name}`, parameters: { type: "object", properties: {} } }));
	const actorMenus: Tool[][] = [];
	const router = new Router({ providers: [{ id: "sim", models: { default: "fixture" } }], simPolicy(context) {
		actorMenus.push(getCurrentTools(context.messages));
		return fauxAssistantMessage("fixture");
	} });
	const model = router.resolve({ provider: "sim", id: "fixture" });
	const records: CallRecord[] = [];
	const stream = router.streamFn(record => records.push(record));
	await (await stream(model, normalizeContext({ messages: [], tools }))).result();
	await (await stream(model, normalizeContext({ tools, messages: [{ role: "system", content: "", timestamp: 1,
		toolsRemoved: tools.map(({ name }) => ({ name })), toolsAdded: tools.toReversed() }] }))).result();
	const changed = tools.map(tool => tool.name === "verify" ? { ...tool, parameters: { type: "object", required: ["artifact"] } } : tool);
	await (await stream(model, normalizeContext({ messages: [], tools: changed }))).result();
	expect(actorMenus.map(menu => menu.map(({ name }) => name))).toEqual([["verify", "nominate"], ["nominate", "verify"], ["verify", "nominate"]]);
	expect(records.map(record => record.toolMenu)).toEqual(actorMenus.map(menu => ({ names: menu.map(({ name }) => name),
		declarationSha: createHash("sha256").update(JSON.stringify(menu)).digest("hex") })));
	expect(records[0]!.toolMenu!.declarationSha).not.toEqual(records[2]!.toolMenu!.declarationSha);
});

it("withdraws a queued model call while the active stream still owns the only slot", async () => {
	const router = new Router({ providers: [{ id: "sim", models: { default: "fixture" }, maxConcurrent: 1 }] });
	const model = router.resolve({ provider: "sim", id: "fixture" });
	const events = createAssistantMessageEventStream();
	const upstream = vi.spyOn(router.models, "streamSimple").mockReturnValue(events);
	const stream = router.streamFn(() => {});
	const context = normalizeContext({ messages: [] });
	const active = await stream(model, context);
	const controller = new AbortController();
	const pending = stream(model, context, { signal: controller.signal });
	expect(router.quota()[0]).toMatchObject({ running: 1, queued: 1 });
	controller.abort(new Error("withdrawn"));
	await expect(pending).rejects.toThrow("withdrawn");
	expect(upstream).toHaveBeenCalledTimes(1);
	expect(router.quota()[0]).toMatchObject({ running: 1, queued: 0, calls: 1 });
	events.push({ type: "done", reason: "stop", message: fauxAssistantMessage("fixture") });
	await active.result();
	await vi.waitFor(() => expect(router.quota()[0]?.running).toBe(0));
});

it("checks distinct providers together and keeps a working provider when another fails", async () => {
	const router = new Router({
		providers: ["openai", "openrouter"].map(id => ({ id, models: { default: "fixture" } })),
		providerFactories: PROVIDER_FACTORIES,
	});
	const slow = Promise.withResolvers<{ auth: {} }>();
	const auth = vi.spyOn(router.models, "getAuth")
		.mockImplementationOnce(() => slow.promise)
		.mockRejectedValueOnce(new Error("credential unavailable"));
	const preparing = router.prepare();
	expect(auth.mock.calls.map(([provider]) => provider)).toEqual(["openai", "openrouter"]);
	slow.resolve({ auth: {} });
	await preparing;
	expect(router.pick("leaf").provider).toBe("openai");
});
