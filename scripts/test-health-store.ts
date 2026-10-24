/// <reference types="node" />
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyHealthFailure,
  parseResetDuration,
  parseRetryAfter,
  parseRetryDelay,
} from "../src/health/classification.js";
import { assertPrivateFile, createPrivateFile } from "../src/health/private-file.js";
import { healthScope, opaqueAccountId, recordKey } from "../src/health/scope.js";
import {
  HEALTH_MAX_BYTES,
  HEALTH_MAX_RECORDS,
  HealthStore,
  HealthStoreError,
  healthStorePath,
} from "../src/health/store.js";
import type { HealthRecord, HealthState } from "../src/health/types.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), "pi-antigravity-health-store-"));
const now = Date.parse("2026-10-23T12:00:00Z");
const tests: { name: string; run: () => void | Promise<void> }[] = [];
function test(name: string, run: () => void | Promise<void>): void {
  tests.push({ name, run });
}
function fixture(name: string): { path: string; store: HealthStore } {
  const path = join(directory, `${name}.json`);
  return { path, store: new HealthStore(path, { now: () => now }) };
}
function record(
  identity = "simulated-account",
  overrides: Partial<HealthRecord> = {},
): HealthRecord {
  return {
    ...healthScope(identity, "project-test", "opus"),
    status: "hard_quota",
    reason: "quota_exhausted",
    observedAt: now,
    cooldownUntil: now + 100_000,
    ...overrides,
  };
}
function put(state: HealthState, item: HealthRecord): void {
  state.records[recordKey(item)] = item;
}
function writePrivate(path: string, text: string): void {
  const fd = createPrivateFile(path);
  try {
    writeFileSync(fd, text, "utf8");
  } finally {
    closeSync(fd);
  }
}
function rejected(run: () => unknown, code: HealthStoreError["code"]): void {
  assert.throws(run, (error: unknown) => error instanceof HealthStoreError && error.code === code);
}
function failure(body: string, status = 429): ReturnType<typeof classifyHealthFailure> {
  return classifyHealthFailure({ status, body, now, projectId: "project-test" });
}
function detail(type: string, extra: Record<string, unknown>): string {
  return JSON.stringify({
    error: {
      code: 429,
      message: "Quota reached",
      details: [{ "@type": `type.googleapis.com/google.rpc.${type}`, ...extra }],
    },
  });
}
function worker(
  mode: string,
  path: string,
  id: string,
): {
  line: (expected: string) => Promise<void>;
  done: Promise<number | null>;
  release: (value: string) => void;
  stop: () => void;
} {
  const child = spawn(
    process.execPath,
    [join(root, "scripts", "test-health-worker.ts"), mode, path, id],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
  );
  const done = once(child, "exit", { signal: AbortSignal.timeout(45_000) }).then(
    ([code]) => code as number | null,
  );
  let text = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const listeners = new Set<() => void>();
  child.stdout.on("data", (chunk: Buffer) => {
    text += chunk.toString();
    for (const listener of listeners) listener();
  });
  return {
    line: async (expected) => {
      if (text.split(/\r?\n/).includes(expected)) return;
      await new Promise<void>((resolve, reject) => {
        const signal = AbortSignal.timeout(45_000);
        const cleanup = (): void => {
          listeners.delete(onData);
          signal.removeEventListener("abort", onTimeout);
          child.removeListener("exit", onExit);
        };
        const onData = (): void => {
          if (text.split(/\r?\n/).includes(expected)) {
            cleanup();
            resolve();
          }
        };
        const onTimeout = (): void => {
          cleanup();
          reject(new Error(`Worker signal timed out: ${expected}`));
        };
        const onExit = (): void => {
          cleanup();
          reject(new Error(`Worker exited before ${expected}: ${text} ${stderr}`));
        };
        listeners.add(onData);
        signal.addEventListener("abort", onTimeout, { once: true });
        child.once("exit", onExit);
        onData();
      });
    },
    done,
    release: (value) => {
      child.stdin.write(value);
    },
    stop: () => {
      child.kill();
    },
  };
}

test("scope hashes normalized raw identities exactly once and keeps project/model isolation", () => {
  const scope = healthScope("  MOCK@invalid.example  ", "project-A", " OPUS ");
  assert.equal(scope.accountId, opaqueAccountId("mock@invalid.example"));
  assert.match(scope.accountId, /^[a-f0-9]{64}$/);
  assert.equal(scope.projectId, "project-A");
  assert.equal(scope.model, "opus");
  assert.notEqual(scope.accountId, opaqueAccountId(scope.accountId));
  assert.notEqual(recordKey(scope), recordKey({ ...scope, projectId: "project-B" }));
  assert.notEqual(recordKey(scope), recordKey({ ...scope, model: "gemini" }));
  assert.notEqual(
    recordKey({ ...scope, projectId: 'a","b', model: "c" }),
    recordKey({ ...scope, projectId: "a", model: 'b","c' }),
  );
});
test("66-hour compact reset, mixed-case units, and explicit wait formats", () => {
  const delay = (66 * 3600 + 15 * 60 + 52) * 1000;
  assert.equal(parseResetDuration("Resets in 66h15m52s"), delay);
  assert.equal(
    parseResetDuration("Please wait 2 DAYS, 3 Hours and 4 minutes 5 Seconds."),
    183_845_000,
  );
  assert.equal(failure("Quota reached. Please wait 66h15m52s").cooldownUntil, now + delay + 1000);
});
test("strict protobuf RetryInfo durations support fractions and nanos", () => {
  assert.equal(parseRetryDelay("123.123456789s"), 123_124);
  assert.equal(parseRetryDelay({ seconds: "123", nanos: 123_000_000 }), 123_123);
  assert.equal(parseRetryDelay({ nanos: 1 }), 1);
  assert.equal(failure(detail("RetryInfo", { retryDelay: "123s" })).cooldownUntil, now + 124_000);
});
test("malformed, negative, duplicate, overflowing and unprefixed durations are rejected", () => {
  for (const text of [
    "66h15m52s",
    "Resets in -5s",
    "Please wait 1h -2m",
    "Resets in 1h 2h",
    "Please wait 999999999999999999999999d",
    "Resets in infinity",
    "Please wait 1h 123",
  ])
    assert.equal(parseResetDuration(text), undefined, text);
  for (const value of [
    "-1s",
    "1e20s",
    "Infinitys",
    {},
    { seconds: -1 },
    { seconds: 1, nanos: -1 },
    { nanos: 1e9 },
  ]) {
    assert.equal(parseRetryDelay(value), undefined);
  }
});
test("Retry-After delta/date and explicit absolute reset time include guard", () => {
  assert.equal(parseRetryAfter("12", now), now + 12_000);
  assert.equal(parseRetryAfter("Fri, 23 Oct 2026 12:01:00 GMT", now), now + 60_000);
  assert.equal(parseRetryAfter("-12", now), undefined);
  assert.equal(parseRetryAfter("99999999999999999", now), undefined);
  assert.equal(parseRetryAfter("2027-02-30T12:00:00Z", now), undefined);
  assert.equal(parseRetryAfter("2026-10-23T24:00:00Z", now), undefined);
  assert.equal(parseRetryAfter("12", now), now + 12_000);
  assert.equal(
    failure("Quota reached. Resets at 2026-10-23T13:00:00Z").cooldownUntil,
    now + 3_601_000,
  );
  assert.equal(
    failure(detail("ErrorInfo", { metadata: { quotaResetTime: "2026-10-23T13:00:00Z" } }))
      .cooldownUntil,
    now + 3_601_000,
  );
});
test("latest authoritative hint wins without truncating multi-day cooldowns", () => {
  const result = classifyHealthFailure({
    status: 429,
    now,
    headers: new Headers({ "Retry-After": "120" }),
    body: detail("RetryInfo", { retryDelay: { seconds: 240, nanos: 0 } }),
  });
  assert.equal(result.retryAfterUntil, now + 241_000);
  assert.equal(result.cooldownUntil, now + 241_000);
});
test("hard quota uses finite fallback and transient throttles stay transient", () => {
  assert.equal(failure("Quota reached").status, "hard_quota");
  assert.equal(failure("Quota reached").cooldownUntil, now + 900_000);
  for (const text of [
    "Quota reached per minute",
    "Quota exceeded per second",
    "rate limit",
    "RESOURCE_EXHAUSTED",
  ]) {
    assert.equal(failure(text).status, "transient_429");
    assert.equal(failure(text).cooldownUntil, now + 60_000);
  }
  assert.equal(failure("Quota reached; arbitrary duration 66h").cooldownUntil, now + 900_000);
});
test("auth errors remain actionable and ignore quota hints", () => {
  for (const status of [401, 403]) {
    const result = failure("Quota reached. Resets in 66h", status);
    assert.equal(result.status, "auth_error");
    assert.equal(result.cooldownUntil, now + 300_000);
    assert.equal(result.global, false);
    assert.equal(result.projectWide, false);
  }
});
test("timeout is short; 404 and 5xx are global; generic 429 is not global", () => {
  const result = classifyHealthFailure({ now, timeout: true, body: "Resets in 66h" });
  assert.equal(result.status, "temporary_unavailable");
  assert.equal(result.cooldownUntil, now + 30_000);
  for (const status of [404, 500, 503]) assert.equal(failure("", status).global, true);
  assert.equal(classifyHealthFailure({ now, status: 503, timeout: true }).global, true);
  assert.equal(failure("RESOURCE_EXHAUSTED").global, false);
  assert.equal(failure(detail("ErrorInfo", { reason: "MODEL_UNAVAILABLE" })).global, true);
});
test("only authoritative project subject enables sharing", () => {
  for (const subject of ["projects/project-test", "project:project-test"]) {
    assert.equal(failure(detail("QuotaFailure", { violations: [{ subject }] })).projectWide, true);
  }
  for (const subject of [
    "users/123",
    "the project exceeded quota",
    "projects/project-test/users/123",
    "projects/unrelated-project",
    "project:123",
  ]) {
    assert.equal(failure(detail("QuotaFailure", { violations: [{ subject }] })).projectWide, false);
  }
  assert.equal(failure("Quota reached for project-test").projectWide, false);
  assert.equal(
    classifyHealthFailure({
      now,
      status: 429,
      body: detail("QuotaFailure", { violations: [{ subject: "projects/project-test" }] }),
    }).projectWide,
    false,
  );
});
test("classification emits closed codes rather than provider response contents", () => {
  const result = failure("Quota reached. secret-provider-diagnostic");
  assert.equal(result.reason, "quota_exhausted");
  assert.equal(JSON.stringify(result).includes("secret-provider-diagnostic"), false);
});
test("path honors PI_CODING_AGENT_DIR and missing snapshots never create files", () => {
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    assert.equal(healthStorePath(), join(directory, "antigravity-account-health.json"));
  } finally {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
  }
  const { path, store } = fixture("missing");
  assert.equal(store.snapshot().sequence, 0);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(`${path}.lock`), false);
});
test("restart and fresh snapshots preserve scoped metadata without raw identities", () => {
  const { path, store } = fixture("restart");
  const item = record("mock@invalid.example");
  store.update((state) => {
    put(state, item);
  });
  const restarted = new HealthStore(path, { now: () => now });
  assert.deepEqual(restarted.snapshot().records[recordKey(item)], item);
  const before = readFileSync(path, "utf8");
  assert.equal(before.includes("mock@invalid.example"), false);
  assert.deepEqual(store.snapshot(), restarted.snapshot());
  assert.equal(readFileSync(path, "utf8"), before);
  restarted.update((state) => {
    put(state, record("second-account"));
  });
  assert.equal(Object.keys(store.snapshot().records).length, 2);
});
test("clock injection and dynamic default clock update metadata", () => {
  const { path } = fixture("clock");
  let clock = now;
  const store = new HealthStore(path, { now: () => clock });
  store.update(() => undefined);
  clock++;
  store.update(() => undefined);
  assert.equal(store.snapshot().updatedAt, clock);
  const original = Date.now;
  try {
    const dynamic = new HealthStore(path);
    Date.now = () => now + 42;
    dynamic.update(() => undefined);
    assert.equal(dynamic.snapshot().updatedAt, now + 42);
  } finally {
    Date.now = original;
  }
});
test("callback and invalid mutation failures preserve previous bytes and release the lock", () => {
  const { path, store } = fixture("abort");
  store.update((state) => {
    put(state, record());
  });
  const before = readFileSync(path, "utf8");
  rejected(
    () =>
      store.update(() => {
        throw new Error("confidential-provider-content");
      }),
    "transaction",
  );
  assert.equal(readFileSync(path, "utf8"), before);
  rejected(
    () =>
      store.update((state) => {
        put(state, record("bad", { reason: "raw-provider-response" }));
      }),
    "invalid",
  );
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(existsSync(`${path}.lock`), false);
  assert.equal(existsSync(`${path}.lock-recovery`), false);
  store.update((state) => {
    put(state, record("after-error"));
  });
  assert.equal(Object.keys(store.snapshot().records).length, 2);
});
test("asynchronous callbacks are rejected without committing", () => {
  const { path, store } = fixture("async");
  rejected(() => store.update(() => Promise.resolve()), "transaction");
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(`${path}.lock`), false);
});
test("atomic rename failure preserves the previous file and cleans private temporaries", () => {
  const { path, store } = fixture("rename-failure");
  store.update((state) => {
    put(state, record());
  });
  const before = readFileSync(path, "utf8");
  const original = fs.renameSync;
  let intercepted = false;
  try {
    fs.renameSync = () => {
      intercepted = true;
      throw Object.assign(new Error("simulated IO failure"), { code: "EACCES" });
    };
    rejected(
      () =>
        store.update((state) => {
          put(state, record("not-committed"));
        }),
      "io",
    );
  } finally {
    fs.renameSync = original;
  }
  assert.equal(intercepted, true);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(existsSync(`${path}.lock`), false);
  assert.equal(
    readdirSync(directory).some((name) => name.endsWith(".tmp")),
    false,
  );
});
test("lock setup IO failure releases its own lock and leaves the previous state intact", () => {
  const { path, store } = fixture("lock-io-failure");
  store.update((state) => {
    put(state, record());
  });
  const before = readFileSync(path, "utf8");
  const original = fs.fsyncSync;
  try {
    fs.fsyncSync = () => {
      throw Object.assign(new Error("simulated fsync failure"), { code: "EIO" });
    };
    rejected(() => store.update(() => undefined), "io");
  } finally {
    fs.fsyncSync = original;
  }
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(existsSync(`${path}.lock`), false);
  assert.equal(existsSync(`${path}.lock-recovery`), false);
});
test("corrupt JSON, future schema and invalid timestamps fail closed", () => {
  for (const [name, text] of [
    ["json", "{"],
    [
      "version",
      JSON.stringify({ version: 2, updatedAt: now, sequence: 0, records: {}, reservations: {} }),
    ],
    [
      "negative",
      JSON.stringify({ version: 1, updatedAt: -1, sequence: 0, records: {}, reservations: {} }),
    ],
    [
      "overflow",
      JSON.stringify({ version: 1, updatedAt: 1e100, sequence: 0, records: {}, reservations: {} }),
    ],
    [
      "fractional",
      JSON.stringify({ version: 1, updatedAt: 1.1, sequence: 0, records: {}, reservations: {} }),
    ],
  ]) {
    const { path, store } = fixture(name);
    writePrivate(path, text);
    rejected(() => store.snapshot(), "invalid");
    rejected(() => store.update(() => undefined), "invalid");
    assert.equal(readFileSync(path, "utf8"), text);
  }
});
test("invalid record and reservation fields cannot persist", () => {
  const { store } = fixture("invalid-fields");
  for (const overrides of [
    { observedAt: -1 },
    { cooldownUntil: Infinity },
    { retryAfterUntil: NaN },
    { lastSuccessAt: -1 },
    { lastAttemptAt: 1.5 },
    { attemptOrder: -1 },
    { responseStatus: 999 },
    { accountId: "mock@invalid.example" },
  ])
    rejected(
      () =>
        store.update((state) => {
          put(state, record("invalid", overrides));
        }),
      "invalid",
    );
  rejected(
    () =>
      store.update((state) => {
        const item = record();
        state.reservations["bad"] = { ...item, id: "bad", until: now + 1, ownerPid: -1 };
      }),
    "invalid",
  );
  rejected(
    () =>
      store.update((state) => {
        (state as unknown as Record<string, unknown>).accessToken = "not-real";
      }),
    "invalid",
  );
});
test("oversized files are rejected before parsing", () => {
  const { path, store } = fixture("oversize");
  const fd = createPrivateFile(path);
  try {
    ftruncateSync(fd, HEALTH_MAX_BYTES + 1);
  } finally {
    closeSync(fd);
  }
  rejected(() => store.snapshot(), "capacity");
});
test("active cooldowns survive capacity rejection and no records are silently dropped", () => {
  const { path, store } = fixture("capacity");
  store.update((state) => {
    put(state, record());
  });
  const before = readFileSync(path, "utf8");
  rejected(
    () =>
      store.update((state) => {
        for (let index = 0; index < HEALTH_MAX_RECORDS; index++)
          put(state, record(`capacity-${index}`));
      }),
    "capacity",
  );
  assert.equal(readFileSync(path, "utf8"), before);
});
test("pruning removes only long-stale expired records and expired reservations", () => {
  const { store } = fixture("prune");
  const old = now - 100 * 86_400_000;
  const expired = record("expired", { observedAt: old, cooldownUntil: old });
  const live = record("live", { observedAt: old, cooldownUntil: now + 1 });
  const retry = record("retry", { observedAt: old, cooldownUntil: old, retryAfterUntil: now + 1 });
  const recent = record("recent", { observedAt: old, cooldownUntil: old, lastSuccessAt: now });
  store.update((state) => {
    for (const item of [expired, live, retry, recent]) put(state, item);
    const scope = healthScope("reservation", "project-test", "opus");
    state.reservations.expired = { ...scope, id: "expired", until: now, ownerPid: process.pid };
    state.reservations.live = { ...scope, id: "live", until: now + 1, ownerPid: process.pid };
  });
  const state = store.snapshot();
  assert.equal(state.records[recordKey(expired)], undefined);
  for (const item of [live, retry, recent]) assert.ok(state.records[recordKey(item)]);
  assert.equal(state.reservations.expired, undefined);
  assert.ok(state.reservations.live);
});
test("private file permissions are verified and unsafe access fails closed", () => {
  const { path, store } = fixture("permissions");
  store.update((state) => {
    put(state, record());
  });
  assertPrivateFile(path);
  if (process.platform === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$p=$env:HEALTH_TEST_PATH; $a=[System.IO.File]::GetAccessControl($p); $s=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'); $r=[System.Security.AccessControl.FileSystemAccessRule]::new($s,[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow); $a.AddAccessRule($r); [System.IO.File]::SetAccessControl($p,$a)",
      ],
      { env: { ...process.env, HEALTH_TEST_PATH: path }, stdio: "pipe" },
    );
  } else {
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    chmodSync(path, 0o644);
  }
  rejected(() => store.snapshot(), "unsafe");
  rejected(() => store.update(() => undefined), "unsafe");
});
test("a symbolic-link destination fails closed", () => {
  const { path: target, store } = fixture("symlink-target");
  store.update(() => undefined);
  const { path, store: linked } = fixture("symlink");
  try {
    symlinkSync(target, path, "file");
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      const unsafe = fixture("directory-destination");
      symlinkSync(dirname(target), unsafe.path, "junction");
      rejected(() => unsafe.store.snapshot(), "unsafe");
      return;
    }
    throw error;
  }
  rejected(() => linked.snapshot(), "unsafe");
  rejected(() => linked.update(() => undefined), "unsafe");
});
test("live owner is denied even after lock expiry", () => {
  const { path, store } = fixture("live-lock");
  writePrivate(
    `${path}.lock`,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      id: "00000000-0000-4000-8000-000000000000",
      createdAt: now - 100_000,
      expiresAt: now - 50_000,
    }),
  );
  rejected(() => store.update(() => undefined), "busy");
  assert.equal(existsSync(`${path}.lock`), true);
});
test("orphan recovery gate fails closed with actionable guidance", () => {
  const { path, store } = fixture("gate");
  writePrivate(`${path}.lock-recovery`, "");
  rejected(() => store.update(() => undefined), "busy");
  assert.equal(existsSync(path), false);
});
test("ambiguous partial lock is never treated as healthy or stolen", () => {
  const { path, store } = fixture("partial-lock");
  writePrivate(`${path}.lock`, "");
  rejected(() => store.update(() => undefined), "unsafe");
  assert.equal(existsSync(path), false);
});
test("concurrent writers observe explicit busy then preserve both committed updates", async () => {
  const { path, store } = fixture("parallel");
  const holder = worker("hold", path, "parallel-a");
  try {
    await holder.line("LOCKED");
    const contender = worker("write", path, "parallel-b");
    await contender.line("ERROR:busy");
    assert.equal(await contender.done, 0);
    holder.release("G");
    await holder.line("COMMITTED");
    assert.equal(await holder.done, 0);
    const retry = worker("write", path, "parallel-b");
    await retry.line("COMMITTED");
    assert.equal(await retry.done, 0);
    assert.equal(Object.keys(store.snapshot().records).length, 2);
    assert.equal(store.snapshot().sequence, 2);
  } finally {
    holder.stop();
  }
});
test("dead-owner lock is recovered after a real transaction-process crash", async () => {
  const { path, store } = fixture("crash");
  store.update((state) => {
    put(state, record("before-crash"));
  });
  const before = readFileSync(path, "utf8");
  const holder = worker("hold", path, "never-committed");
  await holder.line("LOCKED");
  holder.release("X");
  assert.equal(await holder.done, 17);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(existsSync(`${path}.lock`), true);
  store.update((state) => {
    put(state, record("after-crash"));
  });
  assert.equal(Object.keys(store.snapshot().records).length, 2);
  assert.equal(existsSync(`${path}.lock`), false);
});
test("expired dead-owner lock also recovers without dropping committed state", async () => {
  const { path, store } = fixture("expired-crash");
  const holder = worker("hold", path, "aborted");
  await holder.line("LOCKED");
  holder.release("X");
  assert.equal(await holder.done, 17);
  const advanced = new HealthStore(path, { now: () => now + 1_000_000_000 });
  advanced.update((state) => {
    put(state, record("recovered"));
  });
  assert.equal(Object.keys(store.snapshot().records).length, 1);
});
test("no transaction leaves a temporary file or normal acquisition gate", () => {
  assert.equal(
    readdirSync(directory).some((name) => name.endsWith(".tmp")),
    false,
  );
  const { store } = fixture("final");
  store.update(() => undefined);
});

let passed = 0;
try {
  for (const item of tests) {
    await item.run();
    passed++;
    console.log(`PASS ${item.name}`);
  }
  console.log(`Health store: ${passed}/${tests.length} tests passed.`);
} catch (error) {
  console.error(`FAIL ${tests[passed]?.name}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
