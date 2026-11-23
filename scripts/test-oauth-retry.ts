/**
 * Deterministic unit tests for OAuth refresh retry logic in src/auth/oauth.ts:
 * 1. Transient internal_failure retries and succeeds on 3rd attempt.
 * 2. HTTP 400 internal_failure is still retried (transient by error code).
 * 3. All 4 attempts fail with internal_failure → throws retryable OAuthRefreshError.
 * 4. Permanent invalid_grant throws immediately with 0 retries.
 * 5. Abort/timeout cancels retry sleep immediately.
 */
import {
  OAuthRefreshError,
  refreshAntigravityToken,
  _setOAuthRetrySleep,
  _setOAuthFetch,
} from "../src/auth/oauth.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const sleepLog: number[] = [];

// Instant sleep that records requested delays.
_setOAuthRetrySleep(async (ms) => {
  sleepLog.push(ms);
});

const fakeCredentials = {
  access: "old-access",
  refresh: "test-refresh|test-project",
  expires: 0,
};

function mockFetch(responses: Array<{ status: number; body: string }>): {
  calls: number;
  restore: () => void;
} {
  let callCount = 0;
  const state = { calls: 0, restore: () => {} };
  _setOAuthFetch(async (_input, _init) => {
    const idx = callCount++;
    state.calls = callCount;
    const resp = responses[idx] ?? responses[responses.length - 1]!;
    return new Response(resp.body, {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  state.restore = () =>
    _setOAuthFetch((...args) => globalThis.fetch(...args));
  return state;
}

async function testTransientRetriesAndSucceeds(): Promise<void> {
  sleepLog.length = 0;
  const state = mockFetch([
    { status: 500, body: JSON.stringify({ error: "internal_failure" }) },
    { status: 500, body: JSON.stringify({ error: "internal_failure" }) },
    {
      status: 200,
      body: JSON.stringify({
        access_token: "new-access",
        expires_in: 3600,
      }),
    },
  ]);
  try {
    const result = await refreshAntigravityToken(fakeCredentials);
    assert(result.access === "new-access", "should return new access token");
    assert(state.calls === 3, `expected 3 fetch calls, got ${state.calls}`);
    assert(sleepLog.length === 2, `expected 2 backoff sleeps, got ${sleepLog.length}`);
    // First sleep: 500ms + up to 25% jitter → 500-625
    assert(sleepLog[0]! >= 500 && sleepLog[0]! <= 625, `backoff 0: ${sleepLog[0]}`);
    // Second sleep: 1000ms + up to 25% jitter → 1000-1250
    assert(sleepLog[1]! >= 1000 && sleepLog[1]! <= 1250, `backoff 1: ${sleepLog[1]}`);
    console.log("✓ transient internal_failure retries and succeeds on 3rd attempt");
  } finally {
    state.restore();
  }
}

async function testHttp400TransientStillRetries(): Promise<void> {
  sleepLog.length = 0;
  const state = mockFetch([
    { status: 400, body: JSON.stringify({ error: "internal_failure" }) },
    {
      status: 200,
      body: JSON.stringify({
        access_token: "new-access-400",
        expires_in: 3600,
      }),
    },
  ]);
  try {
    const result = await refreshAntigravityToken(fakeCredentials);
    assert(result.access === "new-access-400", "should return new access token after 400 retry");
    assert(state.calls === 2, `expected 2 fetch calls, got ${state.calls}`);
    assert(sleepLog.length === 1, `expected 1 backoff sleep, got ${sleepLog.length}`);
    console.log("✓ HTTP 400 internal_failure is retried by error code");
  } finally {
    state.restore();
  }
}

async function testAllAttemptsFailThrowsRetryable(): Promise<void> {
  sleepLog.length = 0;
  const state = mockFetch([
    { status: 500, body: JSON.stringify({ error: "internal_failure" }) },
    { status: 500, body: JSON.stringify({ error: "internal_failure" }) },
    { status: 500, body: JSON.stringify({ error: "internal_failure" }) },
    { status: 500, body: JSON.stringify({ error: "internal_failure" }) },
  ]);
  try {
    let caught: OAuthRefreshError | undefined;
    try {
      await refreshAntigravityToken(fakeCredentials);
    } catch (err) {
      assert(err instanceof OAuthRefreshError, "should throw OAuthRefreshError");
      caught = err;
    }
    assert(caught, "should have thrown");
    assert(caught.retryable === true, "error should be retryable");
    assert(caught.oauthError === "internal_failure", `oauthError: ${caught.oauthError}`);
    assert(
      caught.message === "Antigravity token refresh failed: internal_failure",
      `message: ${caught.message}`,
    );
    assert(state.calls === 4, `expected 4 fetch calls (1 initial + 3 retries), got ${state.calls}`);
    assert(sleepLog.length === 3, `expected 3 backoff sleeps, got ${sleepLog.length}`);
    console.log("✓ 4 consecutive internal_failure throws retryable OAuthRefreshError");
  } finally {
    state.restore();
  }
}

async function testPermanentInvalidGrantNoRetry(): Promise<void> {
  sleepLog.length = 0;
  const state = mockFetch([
    {
      status: 400,
      body: JSON.stringify({
        error: "invalid_grant",
        error_description: "Token has been revoked.",
      }),
    },
  ]);
  try {
    let caught: OAuthRefreshError | undefined;
    try {
      await refreshAntigravityToken(fakeCredentials);
    } catch (err) {
      assert(err instanceof OAuthRefreshError, "should throw OAuthRefreshError");
      caught = err;
    }
    assert(caught, "should have thrown");
    assert(caught.retryable === false, "invalid_grant should not be retryable");
    assert(caught.oauthError === "invalid_grant", `oauthError: ${caught.oauthError}`);
    assert(caught.status === 400, `status: ${caught.status}`);
    assert(state.calls === 1, `expected 1 fetch call (no retries), got ${state.calls}`);
    assert(sleepLog.length === 0, `expected 0 sleeps, got ${sleepLog.length}`);
    assert(
      caught.message.includes("Antigravity token refresh failed:"),
      `message format: ${caught.message}`,
    );
    assert(
      caught.message.includes("invalid_grant"),
      `message contains error code: ${caught.message}`,
    );
    console.log("✓ permanent invalid_grant throws immediately with 0 retries");
  } finally {
    state.restore();
  }
}

async function testAbortCancelsRetrySleep(): Promise<void> {
  sleepLog.length = 0;
  // Restore real sleep to test abort behavior.
  const realSleepLog: number[] = [];
  _setOAuthRetrySleep(async (ms, signal) => {
    realSleepLog.push(ms);
    if (signal?.aborted) throw new Error("Request was aborted");
    throw new Error("Request was aborted");
  });
  const state = mockFetch([
    { status: 500, body: JSON.stringify({ error: "internal_failure" }) },
    { status: 500, body: JSON.stringify({ error: "internal_failure" }) },
  ]);
  try {
    const controller = new AbortController();
    // Abort before the sleep has a chance to complete
    _setOAuthFetch(async (_input, _init) => {
      controller.abort();
      return new Response(JSON.stringify({ error: "internal_failure" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });
    let caught = false;
    try {
      await refreshAntigravityToken(fakeCredentials, controller.signal);
    } catch (err) {
      caught = true;
      assert(
        err instanceof Error && err.message.includes("aborted"),
        `expected abort error, got: ${err}`,
      );
    }
    assert(caught, "should have thrown on abort");
    console.log("✓ abort cancels retry sleep immediately");
  } finally {
    state.restore();
    // Restore instant sleep for other tests
    _setOAuthRetrySleep(async (ms) => {
      sleepLog.push(ms);
    });
  }
}

async function testAbortDuringFetchNotWrapped(): Promise<void> {
  sleepLog.length = 0;
  const controller = new AbortController();
  _setOAuthFetch(async () => {
    controller.abort();
    throw new DOMException("The operation was aborted.", "AbortError");
  });
  try {
    let caught: unknown;
    try {
      await refreshAntigravityToken(fakeCredentials, controller.signal);
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof Error, "should have thrown");
    assert(
      !(caught instanceof OAuthRefreshError),
      `should NOT be OAuthRefreshError, got: ${caught.constructor.name}`,
    );
    assert(
      caught.message === "Request was aborted",
      `expected 'Request was aborted', got: ${caught.message}`,
    );
    assert(sleepLog.length === 0, `expected 0 retries, got ${sleepLog.length}`);
    console.log("✓ abort during fetch rejects immediately without OAuthRefreshError");
  } finally {
    _setOAuthFetch((...args) => globalThis.fetch(...args));
  }
}

async function main(): Promise<void> {
  await testTransientRetriesAndSucceeds();
  await testHttp400TransientStillRetries();
  await testAllAttemptsFailThrowsRetryable();
  await testPermanentInvalidGrantNoRetry();
  await testAbortCancelsRetrySleep();
  await testAbortDuringFetchNotWrapped();
  console.log("All OAuth retry tests passed successfully!");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
