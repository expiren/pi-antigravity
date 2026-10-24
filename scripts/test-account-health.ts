import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { updateRememberedAccount, syncCurrentAuth, activateAccount } from "../src/auth/accounts.js";
import { classifyHealthFailure } from "../src/health/classification.js";
import { healthScope, recordKey } from "../src/health/scope.js";
import { healthSummary } from "../src/health/report.js";
import { RESERVATION_MS } from "../src/health/selection.js";
import { HealthStore } from "../src/health/store.js";
import { PersistentCredentialSource } from "../src/runtime/persistent-credential-source.js";
import { getLastDiagnostics } from "../src/diagnostics/diagnostics.js";
import {
  account,
  fixture,
  OPUS,
  GEMINI,
  QUOTA,
  request,
  success,
  terminalError,
  type Fixture,
} from "./health-fixtures.js";

let passed = 0;
async function test(name: string, run: (f: Fixture) => Promise<void> | void) {
  await fixture(run);
  console.log(`PASS ${++passed}. ${name}`);
}
const failure = { runtimeModel: OPUS, projectId: "test-project", status: 429, body: QUOTA };

await test("hard Opus quota is durable before the next normal request", async (f) => {
  const result = await request(f, (_token, attempt) =>
    attempt === 1 ? new Response(QUOTA, { status: 429 }) : success(),
  );
  assert.deepEqual(result.attempted, ["fake-access-0", "fake-access-1"]);
  const next = await request(f, success);
  assert.deepEqual(next.attempted, ["fake-access-1"]);
  assert.equal(next.events.at(-1)?.type, "done");
});

await test("a new credential source reads persisted cooldown after restart", async (f) => {
  f.cool([account(0)]);
  const restarted = new HealthStore(f.store.path);
  const a = await new PersistentCredentialSource(OPUS, restarted, () => f.now).current();
  assert.equal(a.token, "fake-access-1");
  assert.equal(
    Object.values(restarted.snapshot().records).filter((r) => r.status === "hard_quota").length,
    1,
  );
});

await test("token and refresh-token replacement retain the same excluded identity", async (f) => {
  f.cool([account(0)]);
  updateRememberedAccount(account(0), {
    ...account(0),
    access: "replacement",
    refresh: "replacement-refresh",
  });
  assert.equal((await f.source().current()).token, "fake-access-1");
});

await test("Opus cooldown does not suppress Gemini", async (f) => {
  f.accounts([account(0)]);
  f.cool([account(0)]);
  assert.equal((await f.source(GEMINI).current()).token, "fake-access-0");
});

await test("project-wide restrictions require matching structured project evidence", async (f) => {
  f.accounts([account(0), account(1), account(2, "unrelated-project")]);
  const s = f.source();
  await s.current();
  await s.failed({
    ...failure,
    body: JSON.stringify({
      error: {
        message: QUOTA,
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{ subject: "projects/test-project" }],
          },
        ],
      },
    }),
  });
  assert.equal((await f.source().current()).token, "fake-access-2");
  assert.equal(healthSummary(OPUS, { store: f.store, now: f.now }).known_cooldown, 2);
});

await test("302 persisted cooldowns cause zero provider attempts and expose earliest reset", async (f) => {
  f.accounts(Array.from({ length: 302 }, (_, i) => account(i)));
  f.cool(f.pool);
  const r = await request(f, () => {
    throw new Error("must not contact provider");
  });
  assert.equal(r.attempted.length, 0);
  assert.match(terminalError(r.events), /next_reset=\d{4}-/);
  assert.match(terminalError(r.events), /claude-opus-4-6-thinking/);
});

await test("one unknown account is selected without probing 100 cooling accounts", async (f) => {
  f.accounts(Array.from({ length: 101 }, (_, i) => account(i)));
  f.cool(f.pool.slice(0, 100));
  const r = await request(f, success);
  assert.deepEqual(r.attempted, ["fake-access-100"]);
});

await test("transient Retry-After is persisted and expires against an injected clock", async (f) => {
  const s = f.source();
  await s.current();
  await s.failed({
    ...failure,
    body: "Rate limit per minute",
    headers: new Headers({ "Retry-After": "120" }),
  });
  const record = Object.values(f.store.snapshot().records)[0];
  assert.equal(record.status, "transient_429");
  assert.equal(record.cooldownUntil, f.now + 121_000);
  f.now += 121_001;
  f.accounts([account(0)]);
  assert.equal((await f.source().current()).token, "fake-access-0");
});

await test("timeout and empty-stream penalties are short rather than hard quotas", async (f) => {
  const s = f.source();
  await s.current();
  await s.failed({ runtimeModel: OPUS, projectId: "test-project", timeout: true });
  const record = Object.values(f.store.snapshot().records)[0];
  assert.equal(record.status, "temporary_unavailable");
  assert(record.cooldownUntil <= f.now + 60_000);
});

await test("401 and 403 are actionable auth failures without identity cycling", async (f) => {
  const r = await request(f, () => new Response("Authorization required", { status: 401 }));
  assert.equal(r.attempted.length, 1);
  assert.equal(Object.values(f.store.snapshot().records)[0].status, "auth_error");
  assert.equal(classifyHealthFailure({ status: 403, now: f.now }).status, "auth_error");
});

await test("invalid reset hints produce a finite conservative fallback", (f) => {
  for (const body of [
    "Quota reached",
    "Quota reached. Resets in -66h",
    "Quota reached. Resets in NaNh",
  ]) {
    const c = classifyHealthFailure({ status: 429, body, now: f.now });
    assert(c.cooldownUntil > f.now && c.cooldownUntil <= f.now + 16 * 60_000);
  }
});

await test("expired cooldown is unknown and recheck-eligible, never recently successful", async (f) => {
  f.accounts([account(0)]);
  f.cool(f.pool);
  f.now = Object.values(f.store.snapshot().records)[0].cooldownUntil + 1;
  await f.source().current();
  const h = healthSummary(OPUS, { store: f.store, now: f.now });
  assert.equal(h.unknown, 1);
  assert.equal(h.recently_successful, 0);
});

await test("consecutive requests use persistent fair ordering", async (f) => {
  f.accounts([account(0), account(1), account(2)]);
  const tokens: string[] = [];
  for (let i = 0; i < 3; i++) {
    const s = f.source();
    tokens.push((await s.current()).token);
    await s.succeeded();
  }
  assert.equal(new Set(tokens).size, 3);
});

await test("request exclusions survive access-token rotation", async (f) => {
  const s = f.source();
  const a = await s.current();
  await s.failed({ ...failure, body: "Rate limit", headers: new Headers({ "Retry-After": "0" }) });
  updateRememberedAccount(account(0), { ...account(0), access: "replacement-token" });
  f.now += 2000;
  const next = await s.rotate(new Set([a.token]));
  assert.equal(next.token, "fake-access-1");
});

await test("hard quota is on disk before selecting the retry credential or a restart", async (f) => {
  const r = await request(f, (_token, attempt) => {
    if (attempt === 1) return new Response(QUOTA, { status: 429 });
    const disk = new HealthStore(f.store.path).snapshot();
    assert.equal(Object.values(disk.records).filter((r) => r.status === "hard_quota").length, 1);
    return success();
  });
  assert.equal(r.attempted.length, 2);
});

await test("success updates only its own account/project/model record", async (f) => {
  f.cool([account(0)]);
  const before =
    f.store.snapshot().records[recordKey(healthScope("linked-0", "test-project", OPUS))];
  const s = f.source(GEMINI);
  await s.current();
  await s.succeeded();
  assert.deepEqual(
    f.store.snapshot().records[recordKey(healthScope("linked-0", "test-project", OPUS))],
    before,
  );
});

await test("parallel reservations avoid duplicate accounts and expire after abandoned requests", async (f) => {
  const [a, b] = await Promise.all([f.source().current(), f.source().current()]);
  assert.notEqual(a.token, b.token);
  assert.equal(Object.keys(f.store.snapshot().reservations).length, 2);
  f.now += RESERVATION_MS + 1;
  assert((await f.source().current()).token);
  assert.equal(Object.keys(f.store.snapshot().reservations).length, 1);
});

await test("corrupt health state fails closed before any provider attempt", async (f) => {
  f.cool([account(0)]);
  writeFileSync(f.store.path, "{partially-written");
  const r = await request(f, success);
  assert.equal(r.attempted.length, 0);
  assert.match(terminalError(r.events), /corrupt|unsupported/);
});

await test("doctor health counts are scoped, accurate, private and read-only", async (f) => {
  f.accounts([account(0), account(1), account(2), account(3)]);
  f.cool([account(0)]);
  const s = f.source();
  await s.current();
  await s.failed({ ...failure, status: 401 });
  const good = f.source();
  await good.current();
  await good.succeeded();
  const before = f.bytes("antigravity-account-health.json");
  const h = healthSummary(OPUS, { store: f.store, now: f.now });
  assert.deepEqual(
    [h.linked, h.known_cooldown, h.unknown, h.recently_successful, h.auth_error],
    [4, 2, 1, 1, 1],
  );
  assert(!JSON.stringify(h).includes("fake-access"));
  assert(!JSON.stringify(h).includes("linked-"));
  assert.deepEqual(f.bytes("antigravity-account-health.json"), before);
});

await test("caller cancellation with durable source has one terminal event and releases leases", async (f) => {
  const caller = new AbortController();
  caller.abort();
  const r = await request(f, success, { signal: caller.signal });
  assert.equal(r.attempted.length, 0);
  assert.equal(r.events.at(-1)?.type, "error");
  assert.equal(Object.keys(f.store.snapshot().reservations).length, 0);
});

await test("an evidenced global model outage is not blamed on each account", async (f) => {
  f.accounts(Array.from({ length: 302 }, (_, i) => account(i)));
  const r = await request(
    f,
    () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Model unavailable",
            details: [
              { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "MODEL_UNAVAILABLE" },
            ],
          },
        }),
        { status: 429 },
      ),
  );
  assert.equal(r.attempted.length, 1);
  assert.equal(
    Object.values(f.store.snapshot().records).filter((r) => r.cooldownUntil > f.now).length,
    0,
  );
  assert.equal(getLastDiagnostics().healthSelection?.lastFailureClass, "temporary_unavailable");
});

await test("health-only changes leave all account and auth bytes identical", async (f) => {
  const beforeAccounts = f.bytes("antigravity-accounts.json");
  const beforeAuth = f.bytes("auth.json");
  await request(f, (_token, attempt) =>
    attempt === 1 ? new Response(QUOTA, { status: 429 }) : success(),
  );
  assert.deepEqual(f.bytes("antigravity-accounts.json"), beforeAccounts);
  assert.deepEqual(f.bytes("auth.json"), beforeAuth);
});

// Explicit user switches and auth sync may update credentials, but cannot erase cooldowns.
await fixture(async (f) => {
  f.cool([account(0)]);
  await activateAccount("linked-0");
  syncCurrentAuth();
  const r = await request(f, success, {
    apiKey: JSON.stringify({ token: "fake-access-0", projectId: "test-project" }),
  });
  assert.deepEqual(r.attempted, ["fake-access-1"]);
  assert.equal(
    Object.values(f.store.snapshot().records).filter((r) => r.status === "hard_quota").length,
    1,
  );
  assert(!f.bytes("antigravity-account-health.json").includes("fake-access"));
  assert(!f.bytes("antigravity-account-health.json").includes("fake-refresh"));
});
console.log("PASS manual switch, auth sync and host-provided apiKey cannot bypass cooldown");
console.log(
  `Account health: ${passed} mandatory scenarios plus manual-switch compatibility passed.`,
);
