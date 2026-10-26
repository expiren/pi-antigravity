import assert from "node:assert/strict";
import { getLastDiagnostics } from "../src/diagnostics/diagnostics.js";
import { HealthStoreError } from "../src/health/store.js";
import type { CredentialSource } from "../src/types/types.js";
import {
  fixture,
  account,
  OPUS,
  QUOTA,
  request,
  success,
  terminalError,
} from "./health-fixtures.js";
import { manualDeadlines } from "./manual-deadlines.js";

const encode = (text: string) =>
  new TextEncoder().encode(
    `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text }] } }] } })}\n\n`,
  );
function deadlines() {
  process.env.ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS = "31";
  process.env.ANTIGRAVITY_STREAM_FIRST_CONTENT_TIMEOUT_MS = "53";
  process.env.ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS = "71";
}

await fixture(async (f) => {
  deadlines();
  await manualDeadlines(async (fire) => {
    const result = await request(
      f,
      (_token, attempt) => (attempt === 1 ? new Promise<Response>(() => {}) : success()),
      {},
      () => fire(31),
    );
    assert.deepEqual(result.attempted, ["fake-access-0", "fake-access-1"]);
    const failures = Object.values(f.store.snapshot().records).filter(
      (r) => r.status === "temporary_unavailable",
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0].cooldownUntil, f.now + 30_000);
  });
});
console.log("PASS durable header deadline records a short penalty and rotates exactly once");

await fixture(async (f) => {
  deadlines();
  let cancelled = 0;
  await manualDeadlines(async (fire) => {
    const result = await request(
      f,
      (_token, attempt) =>
        attempt === 1
          ? new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(encode(""));
                },
                cancel() {
                  cancelled++;
                },
              }),
            )
          : success(),
      {},
      () => fire(53),
    );
    assert.equal(result.attempted.length, 2);
    assert.equal(result.events.filter((e) => e.type === "text_start").length, 1);
    assert.equal(result.events.filter((e) => e.type === "text_delta").length, 1);
    assert.equal(cancelled, 1);
    assert.equal(
      Object.values(f.store.snapshot().records).filter((r) => r.status === "temporary_unavailable")
        .length,
      1,
    );
  });
});
console.log("PASS empty text emits nothing and its durable first-content penalty recovers once");

await fixture(async (f) => {
  deadlines();
  let cancelled = 0;
  await manualDeadlines(async (fire) => {
    const result = await request(
      f,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encode("partial"));
            },
            cancel() {
              cancelled++;
            },
          }),
        ),
      {},
      async (firstDelta) => {
        await firstDelta;
        await fire(71);
      },
    );
    assert.equal(result.attempted.length, 1);
    assert.equal(result.events.filter((e) => e.type === "text_delta").length, 1);
    assert.match(terminalError(result.events), /stalled|timeout|content/i);
    assert.equal(cancelled, 1);
  });
});
console.log("PASS post-output durable stall records health but never replays partial output");

await fixture(async (f) => {
  f.accounts([account(0), account(1), account(2)]);
  deadlines();
  process.env.ANTIGRAVITY_STREAM_MAX_ACCOUNT_CHANGES = "1";
  await manualDeadlines(async (fire) => {
    const result = await request(
      f,
      (_token, attempt) =>
        attempt === 1
          ? new Response(QUOTA, { status: 429 })
          : new Response(new ReadableStream<Uint8Array>()),
      {},
      () => fire(53),
    );
    assert.equal(result.attempted.length, 2);
    assert.match(terminalError(result.events), /budget|exhausted/);
    assert.equal(
      Object.values(f.store.snapshot().records).filter((r) => r.cooldownUntil > f.now).length,
      2,
    );
  });
});
console.log("PASS hard quota and empty stream share one account-change budget");

await fixture(async (f) => {
  const primary = "gemini-3.8-flash";
  const fallback = "gemini-3.7-flash-low";
  process.env.ANTIGRAVITY_RUNTIME_MODEL = primary;
  f.cool([account(0)], fallback);
  f.cool([account(1)], primary);
  const models: string[] = [];
  const result = await request(f, (_token, attempt, init) => {
    const body = JSON.parse(String(init.body));
    models.push(body.model);
    return attempt === 1 ? new Response("Unknown model", { status: 404 }) : success();
  });
  assert.deepEqual(result.attempted, ["fake-access-0", "fake-access-1"]);
  assert.deepEqual(models, [primary, fallback]);
  const records = Object.values(f.store.snapshot().records);
  assert.equal(records.filter((r) => r.status === "hard_quota").length, 2);
  assert(records.some((r) => r.model === fallback && r.lastSuccessAt === f.now));
  assert.equal(getLastDiagnostics().healthSelection?.rotationCount, 1);
});
console.log(
  "PASS runtime fallback reselects using actual model scope and stable rotation identity",
);

await fixture(async (f) => {
  const result = await request(f, () => new Response("Malformed request", { status: 400 }));
  assert.equal(result.attempted.length, 1);
  assert.equal(
    Object.values(f.store.snapshot().records).filter((r) => r.cooldownUntil > f.now).length,
    0,
  );
  assert(Object.values(f.store.snapshot().records).every((r) => r.model === OPUS));
});
console.log("PASS invalid requests stop without poisoning account quota");

await fixture(async (f) => {
  delete process.env.ANTIGRAVITY_BASE_URL;
  const result = await request(f, (_token, attempt) =>
    attempt === 1
      ? new Response("Quota reached. Please wait 66h15m52s", { status: 429 })
      : success(),
  );
  assert.deepEqual(result.attempted, ["fake-access-0", "fake-access-1"]);
  const failed = Object.values(f.store.snapshot().records).find((r) => r.status === "hard_quota");
  assert(failed);
  assert.equal(failed.cooldownUntil, f.now + (66 * 3600 + 15 * 60 + 52) * 1000 + 1000);
});
console.log("PASS Please-wait hard quota stops endpoint drift before persisting and rotating");

await fixture(async (f) => {
  delete process.env.ANTIGRAVITY_BASE_URL;
  const result = await request(
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
  assert.equal(result.attempted.length, 1);
});
console.log("PASS evidenced global 429 stops endpoint drift and account rotation");

await fixture(async (f) => {
  let cleanupCalls = 0;
  const source: CredentialSource = {
    current: async () => ({ token: "fake-access-0", projectId: "project-test" }),
    rotate: async () => {
      throw new Error("Cleanup must not trigger another provider attempt.");
    },
    succeeded: async () => {
      cleanupCalls++;
      throw new HealthStoreError("busy", "ANTIGRAVITY_HEALTH_BUSY: temporary success contention");
    },
    release: async () => {
      cleanupCalls++;
      throw new HealthStoreError("busy", "ANTIGRAVITY_HEALTH_BUSY: temporary cleanup contention");
    },
  };
  const result = await request(f, () => success(), { credentialSource: source });
  assert.equal(result.events.at(-1)?.type, "done");
  assert.deepEqual(result.attempted, ["fake-access-0"]);
  assert.equal(cleanupCalls, 2);
  assert.match(getLastDiagnostics().error ?? "", /ANTIGRAVITY_HEALTH_BUSY/);
});
console.log("PASS optional post-output busy cleanup preserves the completed response");

await fixture(async (f) => {
  const source: CredentialSource = {
    current: async () => ({ token: "fake-access-0", projectId: "project-test" }),
    rotate: async () => {
      throw new Error("Unsafe health cleanup must not trigger account rotation.");
    },
    succeeded: async () => {
      throw new HealthStoreError("unsafe", "Private health file ACL is unsafe.");
    },
  };
  const result = await request(f, () => success(), { credentialSource: source });
  assert.deepEqual(result.attempted, ["fake-access-0"]);
  assert.match(terminalError(result.events), /health file ACL is unsafe/);
});
console.log("PASS unsafe post-output health errors remain actionable");

await fixture(async (f) => {
  let rotations = 0;
  const source: CredentialSource = {
    current: async () => ({ token: "fake-access-0", projectId: "project-test" }),
    rotate: async () => {
      rotations++;
      throw new Error("Missing quota persistence must not rotate.");
    },
    failed: async () => {
      throw new HealthStoreError("busy", "ANTIGRAVITY_HEALTH_BUSY: quota write not committed");
    },
  };
  const result = await request(f, () => new Response("quota", { status: 429 }), {
    credentialSource: source,
  });
  assert.deepEqual(result.attempted, ["fake-access-0"]);
  assert.equal(rotations, 0);
  assert.match(terminalError(result.events), /ANTIGRAVITY_HEALTH_BUSY/);
});
console.log("PASS quota-write contention fails closed without extra provider traffic");
console.log("Health stream: 11/11 deterministic integration scenarios passed.");
