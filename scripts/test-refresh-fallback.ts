import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	OAuthRefreshError,
	_setOAuthFetch,
	_setOAuthRetrySleep,
} from "../src/auth/oauth.ts";
import { PersistentCredentialSource } from "../src/runtime/persistent-credential-source.ts";
import { HealthStore } from "../src/health/store.ts";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const sleepLog: number[] = [];
_setOAuthRetrySleep(async (ms) => {
	sleepLog.push(ms);
});

function setupTempAgentDir(accounts: Record<string, unknown>): {
	dir: string;
	healthPath: string;
} {
	const dir = mkdtempSync(join(tmpdir(), "ag-cred-test-"));
	writeFileSync(
		join(dir, "pi-antigravity.json"),
		JSON.stringify({
			version: 1,
			activeAccountId: Object.keys(accounts)[0],
			accounts,
		}),
	);
	writeFileSync(join(dir, "auth.json"), JSON.stringify({}));
	const healthPath = join(dir, "antigravity-account-health.json");
	return { dir, healthPath };
}

function expiredAccount(id: string, refresh: string) {
	return {
		accountId: id,
		refresh,
		access: "expired-access",
		expires: 0,
		addedAt: Date.now(),
		lastUsedAt: Date.now(),
		email: `${id}@test.local`,
	};
}

let fetchCallCount = 0;
type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function installFetchHandler(handler: FetchHandler) {
	fetchCallCount = 0;
	_setOAuthFetch(async (input, init) => {
		fetchCallCount++;
		return handler(input, init);
	});
}

function restoreFetch() {
	_setOAuthFetch((...args) => globalThis.fetch(...args));
}

async function testTransientFallbackToNextAccount(): Promise<void> {
	sleepLog.length = 0;
	const { dir, healthPath } = setupTempAgentDir({
		"acct-a": expiredAccount("acct-a", "refresh-a|proj-a"),
		"acct-b": expiredAccount("acct-b", "refresh-b|proj-b"),
	});
	const savedDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;

	installFetchHandler(async (_input, init) => {
		const body = typeof init?.body === "string" ? init.body : "";
		if (body.includes("refresh-a")) {
			return new Response(
				JSON.stringify({ error: "internal_failure" }),
				{ status: 500 },
			);
		}
		if (body.includes("refresh-b")) {
			return new Response(
				JSON.stringify({
					access_token: "good-token-b",
					expires_in: 3600,
				}),
				{ status: 200 },
			);
		}
		return new Response("unexpected", { status: 400 });
	});

	try {
		const store = new HealthStore(healthPath);
		const source = new PersistentCredentialSource("gemini-test", store);
		const creds = await source.current();
		assert(creds.token === "good-token-b", `expected good-token-b, got ${creds.token}`);

		const state = store.snapshot();
		const records = Object.values(state.records);
		const cooldownRecord = records.find((r) => r.status === "temporary_unavailable");
		assert(cooldownRecord, "should have recorded transient cooldown for acct-a");
		assert(
			cooldownRecord.reason === "provider_unavailable",
			`reason: ${cooldownRecord.reason}`,
		);

		console.log("✓ transient refresh failure falls back to next account");
	} finally {
		restoreFetch();
		process.env.PI_CODING_AGENT_DIR = savedDir;
	}
}

async function testPermanentAuthErrorSkipsAccount(): Promise<void> {
	sleepLog.length = 0;
	const { dir, healthPath } = setupTempAgentDir({
		"acct-a": expiredAccount("acct-a", "refresh-a|proj-a"),
		"acct-b": expiredAccount("acct-b", "refresh-b|proj-b"),
	});
	const savedDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;

	installFetchHandler(async (_input, init) => {
		const body = typeof init?.body === "string" ? init.body : "";
		if (body.includes("refresh-a")) {
			return new Response(
				JSON.stringify({ error: "invalid_grant", error_description: "Token revoked" }),
				{ status: 400 },
			);
		}
		if (body.includes("refresh-b")) {
			return new Response(
				JSON.stringify({
					access_token: "good-token-b-perm",
					expires_in: 3600,
				}),
				{ status: 200 },
			);
		}
		return new Response("unexpected", { status: 400 });
	});

	try {
		const store = new HealthStore(healthPath);
		const source = new PersistentCredentialSource("gemini-test", store);
		const creds = await source.current();
		assert(creds.token === "good-token-b-perm", `expected good-token-b-perm, got ${creds.token}`);

		const state = store.snapshot();
		const records = Object.values(state.records);
		const authRecord = records.find((r) => r.status === "auth_error");
		assert(authRecord, "should have recorded auth_error for acct-a");
		assert(
			authRecord.reason === "authentication_required",
			`reason: ${authRecord.reason}`,
		);

		console.log("✓ permanent invalid_grant skips account, records auth_error");
	} finally {
		restoreFetch();
		process.env.PI_CODING_AGENT_DIR = savedDir;
	}
}

async function testCircuitBreakerAfter3TransientFailures(): Promise<void> {
	sleepLog.length = 0;
	const { dir, healthPath } = setupTempAgentDir({
		"acct-a": expiredAccount("acct-a", "refresh-a|proj-a"),
		"acct-b": expiredAccount("acct-b", "refresh-b|proj-b"),
		"acct-c": expiredAccount("acct-c", "refresh-c|proj-c"),
		"acct-d": expiredAccount("acct-d", "refresh-d|proj-d"),
	});
	const savedDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const savedFallbacks = process.env.ANTIGRAVITY_OAUTH_MAX_REFRESH_FALLBACKS;
	process.env.ANTIGRAVITY_OAUTH_MAX_REFRESH_FALLBACKS = "3";

	installFetchHandler(async () => {
		return new Response(
			JSON.stringify({ error: "internal_failure" }),
			{ status: 500 },
		);
	});

	try {
		const store = new HealthStore(healthPath);
		const source = new PersistentCredentialSource("gemini-test", store);
		let caught: OAuthRefreshError | undefined;
		try {
			await source.current();
		} catch (err) {
			assert(err instanceof OAuthRefreshError, `expected OAuthRefreshError, got ${err}`);
			caught = err;
		}
		assert(caught, "should have thrown after circuit breaker");
		assert(caught.retryable === true, "circuit breaker error should be retryable");
		assert(caught.oauthError === "internal_failure", `oauthError: ${caught.oauthError}`);

		const state = store.snapshot();
		const cooldownRecords = Object.values(state.records).filter(
			(r) => r.status === "temporary_unavailable",
		);
		assert(
			cooldownRecords.length === 3,
			`expected 3 cooldown records (circuit breaker at 3), got ${cooldownRecords.length}`,
		);

		console.log("✓ circuit breaker trips after 3 consecutive transient refresh failures");
	} finally {
		restoreFetch();
		process.env.PI_CODING_AGENT_DIR = savedDir;
		if (savedFallbacks === undefined) delete process.env.ANTIGRAVITY_OAUTH_MAX_REFRESH_FALLBACKS;
		else process.env.ANTIGRAVITY_OAUTH_MAX_REFRESH_FALLBACKS = savedFallbacks;
	}
}

async function main(): Promise<void> {
	await testTransientFallbackToNextAccount();
	await testPermanentAuthErrorSkipsAccount();
	await testCircuitBreakerAfter3TransientFailures();
	console.log("All credential-source refresh-fallback tests passed!");
}

main().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
