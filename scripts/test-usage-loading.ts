import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import { rememberAccount } from "../src/auth/accounts.js";
import { registerAntigravityCommands } from "../src/commands/antigravity.js";
import { fetchAvailableModelsCatalog } from "../src/client/client.js";
import { discoverAntigravityModels } from "../src/models/discovery.js";
import { fetchAccountModelsUsage, fetchAccountUsage } from "../src/usage/index.js";
import type { AccountUsage } from "../src/types/types.js";
import { AntigravityDashboardComponent, runAccountsDashboard } from "../src/ui/dashboard.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done, fail) => {
		// Failure guard only; progress is driven by subscribed events, never by time.
		const timeout = setTimeout(() => fail(new Error("Timed out waiting for test event")), 30_000);
		resolve = (value) => {
			clearTimeout(timeout);
			done(value);
		};
	});
	return { promise, resolve };
}

const originalFetch = globalThis.fetch;
const originalDir = process.env.PI_CODING_AGENT_DIR;
const originalBaseUrl = process.env.ANTIGRAVITY_BASE_URL;
const originalTimeout = AbortSignal.timeout;
const directory = mkdtempSync(join(tmpdir(), "pi-antigravity-loading-"));
process.env.PI_CODING_AGENT_DIR = directory;
delete process.env.ANTIGRAVITY_BASE_URL;
const apiKey = JSON.stringify({ token: "loading-test", projectId: "test-project" });
const modelResponse = (id: string) =>
	Response.json({
		models: { [id]: { displayName: id, quotaInfo: { remainingFraction: 0.75 } } },
	});

try {
	// A registry refresh and the model tab share three probes, not six. A slow
	// sandbox cannot delay the first model row, but its unique models still arrive.
	const sandbox = deferred<void>();
	const firstUpdate = deferred<AccountUsage>();
	const urls: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		urls.push(url);
		expect(url.endsWith(":fetchAvailableModels")).toBe(true);
		if (url.includes("sandbox")) {
			await sandbox.promise;
			return modelResponse("sandbox-only");
		}
		return modelResponse("gemini-3.9-flash");
	};
	let finished = false;
	const usagePromise = fetchAccountModelsUsage(apiKey, {
		onUpdate: (usage) => firstUpdate.resolve(usage),
	}).then((usage) => {
		finished = true;
		return usage;
	});
	const registryPromise = discoverAntigravityModels(apiKey);
	const early = await firstUpdate.promise;
	expect(early.models[0].remainingFraction).toBe(0.75);
	expect(finished).toBe(false);
	expect(urls.length).toBe(3);
	let replayed: AccountUsage | undefined;
	const lateSubscriber = fetchAccountModelsUsage(apiKey, {
		onUpdate: (update) => {
			replayed = update;
		},
	});
	expect(replayed?.models[0].modelId).toBe("gemini-3.9-flash");
	sandbox.resolve();
	const [usage] = await Promise.all([usagePromise, registryPromise, lateSubscriber]);
	expect(usage.models.map((m) => m.modelId)).toContain("sandbox-only");
	expect(urls.length).toBe(3);

	// Cancelling one subscriber must not cancel the registry's shared request.
	const gate = deferred<void>();
	const sharedProbesStarted = deferred<void>();
	let sharedProbes = 0;
	let underlyingAborts = 0;
	globalThis.fetch = async (_input, init) => {
		init?.signal?.addEventListener(
			"abort",
			() => {
				underlyingAborts++;
			},
			{ once: true },
		);
		if (++sharedProbes === 3) sharedProbesStarted.resolve();
		await gate.promise;
		return modelResponse("shared-model");
	};
	const abort = new AbortController();
	const cancelled = fetchAvailableModelsCatalog("cancel-test", "p", abort.signal).then(
		() => false,
		() => true,
	);
	const survivor = fetchAvailableModelsCatalog("cancel-test", "p");
	await sharedProbesStarted.promise;
	abort.abort();
	expect(await cancelled).toBe(true);
	expect(underlyingAborts).toBe(0);
	gate.resolve();
	expect((await survivor).data.models).toHaveProperty("shared-model");

	// When the last subscriber leaves, probes are cancelled and a later lookup
	// starts afresh rather than inheriting the aborted in-flight entry.
	let abortedProbes = 0;
	let pendingProbes = 0;
	const abandonedProbesStarted = deferred<void>();
	globalThis.fetch = async (_input, init) =>
		new Promise((_resolve, reject) => {
			const signal = init!.signal!;
			const stop = () => {
				abortedProbes++;
				reject(signal.reason);
			};
			if (signal.aborted) stop();
			else signal.addEventListener("abort", stop, { once: true });
			if (++pendingProbes === 3) abandonedProbesStarted.resolve();
		});
	const last = new AbortController();
	const abandoned = fetchAvailableModelsCatalog("last-test", "p", last.signal).then(
		() => false,
		() => true,
	);
	await abandonedProbesStarted.promise;
	last.abort();
	expect(await abandoned).toBe(true);
	expect(abortedProbes).toBe(3);
	globalThis.fetch = async () => modelResponse("fresh-model");
	expect((await fetchAvailableModelsCatalog("last-test", "p")).data.models).toHaveProperty(
		"fresh-model",
	);

	// Account rows publish models before auxiliary RPCs finish. A paid-only 403
	// is terminal and must not be retried against all three endpoints.
	const assist = deferred<void>();
	const modelReady = deferred<AccountUsage>();
	let summaries = 0;
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.endsWith(":retrieveUserQuotaSummary")) {
			summaries++;
			return Response.json({ error: { message: "SUBSCRIPTION_REQUIRED #3501" } }, { status: 403 });
		}
		if (url.endsWith(":loadCodeAssist")) {
			await assist.promise;
			return Response.json({ paidTier: { id: "pro", name: "Pro" } });
		}
		return modelResponse("early-model");
	};
	let accountFinished = false;
	const accountPromise = fetchAccountUsage(apiKey, {
		onUpdate: (update) => modelReady.resolve(update),
	}).then((result) => {
		accountFinished = true;
		return result;
	});
	expect((await modelReady.promise).models[0].modelId).toBe("early-model");
	expect(accountFinished).toBe(false);
	assist.resolve();
	const account = await accountPromise;
	expect(account.planLabel).toContain("Pro");
	expect(account.quotaSummaryError).toContain("SUBSCRIPTION_REQUIRED");
	expect(summaries).toBe(1);

	// Advance auxiliary budgets only after both requests have subscribed to abort.
	const budgets: number[] = [];
	const auxiliaryTimeouts: AbortController[] = [];
	AbortSignal.timeout = (ms) => {
		budgets.push(ms);
		const controller = new AbortController();
		if (ms === 5_000) auxiliaryTimeouts.push(controller);
		return controller.signal;
	};
	let auxiliaryCalls = 0;
	const auxiliariesStarted = deferred<void>();
	globalThis.fetch = async (input, init) => {
		if (String(input).endsWith(":fetchAvailableModels")) return modelResponse("timeout-model");
		auxiliaryCalls++;
		expect(init?.signal).toBeDefined();
		return new Promise((_resolve, reject) => {
			const signal = init!.signal!;
			if (signal.aborted) reject(signal.reason);
			else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			if (auxiliaryCalls === 2) auxiliariesStarted.resolve();
		});
	};
	const timedPromise = fetchAccountUsage(apiKey);
	await auxiliariesStarted.promise;
	for (const timeout of auxiliaryTimeouts) {
		timeout.abort(new DOMException("The operation timed out", "TimeoutError"));
	}
	const timed = await timedPromise;
	expect(timed.models[0].modelId).toBe("timeout-model");
	expect(timed.quotaSummaryError).toBeDefined();
	expect(auxiliaryCalls).toBe(2);
	expect(budgets.filter((ms) => ms === 5_000).length).toBe(2);
	AbortSignal.timeout = originalTimeout;

	// Integration: tools/doctor do no credential refresh or quota RPCs. Models
	// load only the active account; switching to accounts lazily loads the rest.
	const remember = (name: string, expires: number) =>
		rememberAccount({
			email: `${name}@example.com`,
			access: name,
			refresh: `${name}-refresh`,
			expires,
			projectId: "test-project",
		});
	remember("other", Date.now() - 1);
	remember("active", Date.now() - 1);
	const calls: string[] = [];
	const slowSandbox = deferred<void>();
	const dashboardOpened = deferred<void>();
	const observers = new Set<() => void>();
	const changed = () => {
		for (const observer of [...observers]) observer();
	};
	const nextState = (ready: () => boolean) => {
		const event = deferred<void>();
		const observer = () => {
			if (!ready()) return;
			observers.delete(observer);
			event.resolve();
		};
		observers.add(observer);
		observer();
		return event.promise;
	};
	globalThis.fetch = async (input) => {
		const url = String(input);
		calls.push(url);
		changed();
		if (url.endsWith(":fetchAvailableModels")) {
			if (url.includes("sandbox")) await slowSandbox.promise;
			return modelResponse("gemini-3.9-flash");
		}
		if (url.endsWith(":loadCodeAssist")) return Response.json({});
		if (url.endsWith(":retrieveUserQuotaSummary")) return Response.json({ groups: [] });
		throw new Error(`Unexpected network request: ${url}`);
	};
	let component!: AntigravityDashboardComponent;
	let done!: (result: { action: "close" }) => void;
	const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	let registryRefreshes = 0;
	let doctorUpdates = 0;
	let status: { text: string; tone: string } | undefined;
	const ctx = {
		hasUI: true,
		mode: "tui",
		modelRegistry: {
			refresh: async () => {
				registryRefreshes++;
				await discoverAntigravityModels(
					JSON.stringify({ token: "active", projectId: "test-project" }),
				);
				return { errors: new Map() };
			},
		},
		ui: {
			custom: (factory: (...args: any[]) => AntigravityDashboardComponent) =>
				new Promise((resolve) => {
					done = resolve;
					component = factory(
						{ requestRender: changed },
						plainTheme,
						{ matches: (data: string, action: string) => data === "\r" && action === "tui.select.confirm" },
						resolve,
					);
					const updateDoctor = component.updateDoctor.bind(component);
					component.updateDoctor = (...args) => {
						updateDoctor(...args);
						doctorUpdates++;
						changed();
					};
					const setStatus = component.setStatus.bind(component);
					component.setStatus = (text, tone = "info") => {
						setStatus(text, tone);
						status = { text, tone };
						changed();
					};
					dashboardOpened.resolve();
				}),
		},
	} as unknown as Parameters<typeof runAccountsDashboard>[0];
	const dashboard = runAccountsDashboard(ctx, { initialTab: "tools" });
	await dashboardOpened.promise;
	expect(calls.length).toBe(0);
	component.setTab("doctor");
	expect(calls.length).toBe(0);
	// Leave the inactive account expired: opening Models must not refresh it.
	remember("active", Date.now() + 600_000);
	const modelsVisible = nextState(() =>
		component.render(120).join("\n").includes("gemini-3.9-flash"),
	);
	component.setTab("models");
	await modelsVisible;
	expect(calls.length).toBe(3);
	expect(registryRefreshes).toBe(1);
	expect(calls.every((url) => url.endsWith(":fetchAvailableModels"))).toBe(true);
	expect(component.render(120).join("\n")).toContain("gemini-3.9-flash");
	// Repeated refresh keys join the same model job.
	component.handleInput("r");
	component.handleInput("r");
	expect(calls.length).toBe(3);
	remember("other", Date.now() + 600_000);
	remember("active", Date.now() + 600_000);
	const accountsStarted = nextState(
		() =>
			calls.filter((url) => url.endsWith(":fetchAvailableModels")).length === 6 &&
			calls.filter((url) => url.endsWith(":retrieveUserQuotaSummary")).length === 2,
	);
	component.setTab("accounts");
	await accountsStarted;
	expect(calls.filter((url) => url.endsWith(":fetchAvailableModels")).length).toBe(6);
	expect(calls.filter((url) => url.endsWith(":retrieveUserQuotaSummary")).length).toBe(2);
	const dashboardSettled = nextState(() => doctorUpdates === 2);
	slowSandbox.resolve();
	await dashboardSettled;

	// Stale rows can outlive their persisted accounts. Both actions must catch
	// that rejection and publish a warning rather than abandon a rejected promise.
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		process.env.PI_CODING_AGENT_DIR = join(directory, "missing-account-store");
		component.handleInput("j");
		const switchWarning = nextState(
			() =>
				status?.tone === "warning" &&
				status.text === "Account switch failed: Antigravity account not found: 1",
		);
		component.handleInput("\r");
		await switchWarning;
		expect(component.render(120).join("\n")).toContain(
			"Account switch failed: Antigravity account not found: 1",
		);
		const removeWarning = nextState(
			() =>
				status?.tone === "warning" &&
				status.text === "Account removal failed: Antigravity account not found: 1",
		);
		component.handleInput("d");
		component.handleInput("y");
		await removeWarning;
		expect(component.render(120).join("\n")).toContain(
			"Account removal failed: Antigravity account not found: 1",
		);
		expect(unhandled).toEqual([]);
	} finally {
		process.env.PI_CODING_AGENT_DIR = directory;
		process.off("unhandledRejection", onUnhandled);
	}
	done({ action: "close" });
	await dashboard;

	// Non-TUI models command also uses only model RPCs, sharing its registry refresh.
	calls.length = 0;
	let command!: (args: string, context: typeof ctx) => Promise<void>;
	registerAntigravityCommands({
		registerCommand: (name: string, definition: { handler: typeof command }) => {
			if (name === "antigravity") command = definition.handler;
		},
	} as unknown as Parameters<typeof registerAntigravityCommands>[0]);
	const output: string[] = [];
	await command("models", {
		...ctx,
		mode: "rpc",
		modelRegistry: {
			getApiKeyForProvider: async () => apiKey,
			refresh: async () => {
				await discoverAntigravityModels(apiKey);
				return { errors: new Map() };
			},
		},
		ui: {
			notify: (message: string) => {
				output.push(message);
			},
		},
	} as unknown as typeof ctx);
	expect(calls.length).toBe(3);
	expect(calls.every((url) => url.endsWith(":fetchAvailableModels"))).toBe(true);
	expect(output.join("\n")).toContain("gemini-3.9-flash");

	console.log(
		"usage loading: progressive models, shared probes, cancellation, bounded auxiliaries and lazy tabs passed",
	);
} finally {
	globalThis.fetch = originalFetch;
	AbortSignal.timeout = originalTimeout;
	if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalDir;
	if (originalBaseUrl === undefined) delete process.env.ANTIGRAVITY_BASE_URL;
	else process.env.ANTIGRAVITY_BASE_URL = originalBaseUrl;
	rmSync(directory, { recursive: true, force: true });
}
