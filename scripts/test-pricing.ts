import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	ExtensionHandler,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import antigravityExtension from "../src/index.js";
import {
	ANTIGRAVITY_IMAGE_MODELS,
	ANTIGRAVITY_MODELS,
	createPricingResolver,
	listProviderModels,
	repriceModel,
} from "../src/models/index.js";

// Never read the installed host catalog: each source is independently controlled.
const staticCost = createPricingResolver({ getModels: () => [] });
assert.equal(staticCost("gemini-3.8-flash")?.input, 0.75);
assert.equal(staticCost("gemini-3.5-flash")?.input, 1.5);
assert.equal(staticCost("claude-opus-4-6")?.input, 5);
assert.equal(staticCost("claude-sonnet-4-6")?.output, 15);
assert.equal(staticCost("gemini-3.1-pro")?.input, 2);
assert.equal(staticCost("gemini-4-argon")?.input, 2);
assert.equal(staticCost("gpt-oss-120b")?.input, 0.6);
assert.equal(staticCost("something-unknown"), undefined);

const builtin = { input: 4, output: 40, cacheRead: 0.4, cacheWrite: 0 };
const live = {
	input: 9,
	output: 99,
	cacheRead: 1,
	tiers: [{ inputTokensAbove: 200000, input: 18, output: 198 }],
};
const lookups: string[] = [];
const resolveCost = createPricingResolver({
	find(provider, id) {
		lookups.push(`${provider}/${id}`);
		return provider === "google" && id === "gemini-4-argon" ? { cost: live } : undefined;
	},
	getModels: () => [{ id: "gemini-4-argon", cost: builtin }],
});
assert.deepEqual(resolveCost("gemini-4-argon"), { ...live, cacheWrite: 0 });
assert.deepEqual(lookups, ["google/gemini-4-argon"]);
assert.equal(resolveCost("claude-opus-4-6")?.input, 5, "both sources miss: use static");

const builtinOnly = createPricingResolver({
	find: () => undefined,
	getModels: () => [{ id: "gemini-4-argon", cost: builtin }],
});
assert.deepEqual(builtinOnly("gemini-4-argon"), builtin, "built-in beats static");

const preview = createPricingResolver({
	getModels(provider) {
		assert.equal(provider, "google");
		return [{ id: "gemini-3.1-pro-preview", cost: builtin }];
	},
});
assert.deepEqual(preview("gemini-3.1-pro"), builtin, "preview alias lookup");
const livePreview = createPricingResolver({
	find: (_provider, id) => (id.endsWith("-preview") ? { cost: live } : undefined),
	getModels: () => [{ id: "gemini-3.1-pro", cost: builtin }],
});
assert.equal(livePreview("gemini-3.1-pro")?.input, 9, "live preview beats built-in exact ID");

const throwingRegistry = createPricingResolver({
	find() {
		throw new Error("reloading");
	},
	getModels: () => [{ id: "gemini-4-argon", cost: builtin }],
});
assert.deepEqual(throwingRegistry("gemini-4-argon"), builtin);
for (const getModels of [
	() => undefined,
	() => ({}),
	() => {
		throw new Error("catalog unavailable");
	},
]) {
	assert.equal(createPricingResolver({ getModels })("gemini-4-argon")?.input, 2);
}
const unpriced = createPricingResolver({
	find: () => ({ cost: { input: 0, output: 0 } }),
	getModels: () => [{ id: "gemini-4-argon", cost: {} }],
});
assert.equal(unpriced("gemini-4-argon")?.input, 2, "empty prices fall through");

// Independent session lookups may change or detach without affecting each other.
let sessionACost: typeof builtin | undefined = builtin;
const sessionA = createPricingResolver({
	find: () => (sessionACost ? { cost: sessionACost } : undefined),
	getModels: () => [],
});
const sessionB = createPricingResolver({ find: () => ({ cost: live }), getModels: () => [] });
assert.equal(sessionA("gemini-4-argon")?.input, 4);
assert.equal(sessionB("gemini-4-argon")?.input, 9);
sessionACost = { ...builtin, input: 7 };
assert.equal(sessionA("gemini-4-argon")?.input, 7, "lookups are not cached");
sessionACost = undefined;
assert.equal(sessionA("gemini-4-argon")?.input, 2);
assert.equal(sessionB("gemini-4-argon")?.input, 9, "another session remains attached");

const flash = ANTIGRAVITY_MODELS.find((model) => model.id === "gemini-3.8-flash")!;
const selected = { ...flash, id: "gemini-4-argon" };
assert.equal(repriceModel(selected, builtinOnly).cost?.input, 4);
assert.equal(selected.cost?.input, 0.75, "selected model is not mutated");
const unknown = { ...flash, id: "mystery-model" };
assert.equal(repriceModel(unknown, staticCost), unknown);
const image = ANTIGRAVITY_IMAGE_MODELS[0]!;
assert.equal(repriceModel(image, resolveCost), image);
const listed = listProviderModels({ models: [selected], imageModels: [image] }, resolveCost);
assert.equal(listed[0]?.cost?.input, 9, "listing uses its supplied resolver");
assert.equal(listed[1], image, "images are left untouched");

// Exercise the real extension lifecycle, not just two independent resolver functions.
const previousDir = process.env.PI_CODING_AGENT_DIR;
const previousPrewarm = process.env.ANTIGRAVITY_NO_PREWARM;
const isolatedDir = mkdtempSync(join(tmpdir(), "pi-antigravity-pricing-"));
process.env.PI_CODING_AGENT_DIR = isolatedDir;
process.env.ANTIGRAVITY_NO_PREWARM = "1";
function extensionSession(input: number) {
	const handlers = new Map<string, ExtensionHandler<ExtensionEvent, unknown>[]>();
	let provider: ProviderConfig | undefined;
	const pi = {
		registerProvider(_id: string, config: ProviderConfig) {
			provider = config;
		},
		registerTool() { },
		registerCommand() { },
		on(event: string, handler: ExtensionHandler<ExtensionEvent, unknown>) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	antigravityExtension(pi);
	const ctx = {
		cwd: process.cwd(),
		modelRegistry: {
			find: () => ({ cost: { ...builtin, input } }),
			refresh() {
				assert.fail("cosmetic pricing must not refresh the provider");
			},
		},
	} as unknown as ExtensionContext;
	return {
		async event(type: "session_start" | "session_shutdown") {
			const event: ExtensionEvent =
				type === "session_start" ? { type, reason: "startup" } : { type, reason: "quit" };
			for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
		},
		async streamedPrice() {
			assert(provider?.streamSimple);
			const model = { ...flash, provider: "antigravity", api: "antigravity-api" } as Model<Api>;
			const options = {
				apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
				credentialSource: {
					current: async () => ({ token: "test-token", projectId: "test-project" }),
					rotate: async () => undefined,
				},
			};
			const result = await provider
				.streamSimple(
					model,
					normalizeContext({ messages: [{ role: "user", content: "test", timestamp: 0 }] }),
					options,
				)
				.result();
			assert.notEqual(result.stopReason, "error", result.errorMessage ?? "stream error");
			return result.usage.cost.input;
		},
		async listedPrice() {
			assert(provider?.refreshModels);
			const models = await provider.refreshModels({
				allowNetwork: false,
				signal: new AbortController().signal,
				publish: async () => true,
			});
			return models.find((model) => model.id === "gemini-3.8-flash")?.cost?.input;
		},
	};
}
const extensionA = extensionSession(7);
const extensionB = extensionSession(9);
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () =>
	new Response(
		`data: ${JSON.stringify({
			response: {
				candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
				usageMetadata: { promptTokenCount: 1000000, candidatesTokenCount: 1 },
			},
		})}\n\n`,
	)) as typeof fetch;
try {
	await extensionA.event("session_start");
	await extensionB.event("session_start");
	assert.equal(await extensionA.listedPrice(), 7);
	assert.equal(await extensionB.listedPrice(), 9);
	assert.equal(await extensionA.streamedPrice(), 7);
	assert.equal(await extensionB.streamedPrice(), 9);
	await extensionA.event("session_shutdown");
	assert.equal(await extensionB.listedPrice(), 9, "shutdown is scoped to its extension instance");
	assert.equal(await extensionB.streamedPrice(), 9);
} finally {
	globalThis.fetch = originalFetch;
	await extensionA.event("session_shutdown");
	await extensionB.event("session_shutdown");
	if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousDir;
	if (previousPrewarm === undefined) delete process.env.ANTIGRAVITY_NO_PREWARM;
	else process.env.ANTIGRAVITY_NO_PREWARM = previousPrewarm;
	rmSync(isolatedDir, { recursive: true, force: true });
}

console.log("pricing: isolated sources, aliases, listing and extension lifecycle passed");
