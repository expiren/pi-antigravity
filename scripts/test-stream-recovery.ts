import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import type { Api, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { streamAntigravity, _setRotationSleep } from "../src/stream/stream.js";
import type { CredentialSource } from "../src/runtime/index.js";
import { OAuthRefreshError } from "../src/auth/oauth.js";
import { getEventListeners } from "node:events";
import type { Api, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { streamAntigravity, _setRotationSleep } from "../src/stream/stream.js";
import type { CredentialSource } from "../src/runtime/index.js";

// A manually advanced clock: deadlines fire only after the exact timer is armed.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
const timers = new Map<object, { ms: number; callback: () => void }>();
const armed = new Map<number, () => void>();
globalThis.setTimeout = ((callback: () => void, ms: number) => {
  const handle = { unref() {} };
  timers.set(handle, { ms, callback });
  armed.get(ms)?.();
  armed.delete(ms);
  return handle;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((handle: object) => {
  timers.delete(handle);
}) as unknown as typeof clearTimeout;

async function fire(ms: number) {
  if (![...timers.values()].some((timer) => timer.ms === ms)) {
    await new Promise<void>((resolve) => armed.set(ms, resolve));
  }
  const entry = [...timers].find(([, timer]) => timer.ms === ms);
  assert(entry, `deadline ${ms} must be armed`);
  timers.delete(entry[0]);
  entry[1].callback();
}

const encode = (parts: unknown[]) =>
  new TextEncoder().encode(
    `data: ${JSON.stringify({ response: { candidates: [{ content: { parts }, finishReason: "STOP" }] } })}\n\n`,
  );
const model = {
  id: "claude-opus-4-6",
  name: "Opus",
  provider: "antigravity",
  api: "antigravity-api",
} as Model<Api>;

async function scenario(
  name: string,
  responses: Array<(init: RequestInit) => Promise<Response> | Response>,
  drive?: (
    events: AssistantMessageEvent[],
    firstDelta: Promise<void>,
    caller: AbortController,
  ) => Promise<void>,
  options: { budget?: number; repeated?: boolean; noSource?: boolean } = {},
) {
  process.env.ANTIGRAVITY_NO_PREWARM = "1";
  process.env.ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS = "31";
  process.env.ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS = "71";
  process.env.ANTIGRAVITY_STREAM_FIRST_CONTENT_TIMEOUT_MS = "53";
  process.env.ANTIGRAVITY_STREAM_MAX_ACCOUNT_CHANGES = String(options.budget ?? 3);
  const attempted: string[] = [];
  let requestStarted!: () => void;
  const requested = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  let rotations = 0;
  const source: CredentialSource = {
    async current() {
      return { token: "A", projectId: "test" };
    },
    async rotate(excluded) {
      rotations++;
      assert.deepEqual([...excluded], attempted, "all attempted accounts excluded");
      const token = options.repeated ? "A" : String.fromCharCode(65 + rotations);
      return rotations < responses.length || options.repeated
        ? { token, projectId: "test" }
        : undefined;
    },
  };
  globalThis.fetch = (async (_input: unknown, init: RequestInit) => {
    assert(!init.signal?.aborted);
    const token = (init.headers as Record<string, string>).Authorization.replace("Bearer ", "");
    attempted.push(token);
    requestStarted();
    const response = responses[attempted.length - 1];
    assert(response, "unexpected replay");
    return response(init);
  }) as typeof fetch;
  const events: AssistantMessageEvent[] = [];
  const caller = new AbortController();
  let delta!: () => void;
  const firstDelta = new Promise<void>((resolve) => {
    delta = resolve;
  });
  const stream = streamAntigravity(
    model,
    { messages: [{ role: "user", content: "test", timestamp: 0 }] },
    {
      signal: caller.signal,
      ...(options.noSource
        ? { apiKey: JSON.stringify({ token: "A", projectId: "test" }) }
        : { credentialSource: source }),
    },
  );
  const consume = (async () => {
    for await (const event of stream) {
      events.push(event);
      if (
        event.type === "text_delta" ||
        event.type === "toolcall_end" ||
        event.type === "thinking_delta"
      )
        delta();
    }
  })();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await requested;
        await drive?.(events, firstDelta, caller);
        await consume;
      })(),
      new Promise<never>((_resolve, reject) => {
        deadline = realSetTimeout(
          () =>
            reject(
              new Error(
                `${name}: missing expected event; timers=${JSON.stringify([...timers.values()].map((timer) => timer.ms))}; attempts=${attempted}; rotations=${rotations}; events=${events.map((e) => e.type)}`,
              ),
            ),
          5000,
        );
      }),
    ]);
  } finally {
    if (deadline) realClearTimeout(deadline);
  }
  assert.equal(events.filter((event) => event.type === "done" || event.type === "error").length, 1);
  assert.equal(timers.size, 0, `${name}: timers leaked`);
  assert.equal(armed.size, 0);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0, "caller listener leaked");
  assert.equal(new Set(attempted).size, attempted.length, "no repeated account");
  console.log(`PASS ${name}`);
  return { events, attempted, rotations };
}

let cancelled = 0;
let bodyController: ReadableStreamDefaultController<Uint8Array>;
function silent() {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
      cancel() {
        cancelled++;
      },
    }),
  );
}
const success = () => new Response(encode([{ text: "Recovered" }]));
const errorText = (events: AssistantMessageEvent[]) => {
  const event = events.find((event) => event.type === "error");
  assert(event?.type === "error");
  return event.error.errorMessage ?? "";
};
try {
  // Inject instant rotation sleep that records requested delays.
  const sleepLog: number[] = [];
  _setRotationSleep(async (ms) => { sleepLog.push(ms); });
  let result = await scenario("silent HTTP 200", [silent], async () => {
    await fire(53);
  });
  assert.match(errorText(result.events), /no meaningful model content/);
  assert.equal(cancelled, 1);

  let headerSignal: AbortSignal | undefined;
  result = await scenario(
    "no headers (fetch ignores abort)",
    [
      (init) => {
        headerSignal = init.signal!;
        return new Promise<Response>(() => {});
      },
    ],
    async () => {
      await fire(31);
    },
  );
  assert(headerSignal?.aborted);
  assert.match(errorText(result.events), /no response headers/);

  result = await scenario(
    "header timeout A then B success",
    [
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
      success,
    ],
    async () => {
      await fire(31);
    },
  );
  assert.deepEqual(result.attempted, ["A", "B"]);

  result = await scenario("heartbeats and controls do not reset deadline", [silent], async () => {
    // Registration proves headers have arrived; replace the timer's firing with control bytes first.
    if (![...timers.values()].some((timer) => timer.ms === 53)) {
      await new Promise<void>((resolve) => armed.set(53, resolve));
    }
    bodyController.enqueue(
      new TextEncoder().encode(
        ': heartbeat\n\nevent: ping\n\ndata: {"response":{"usageMetadata":{"promptTokenCount":1}}}\n\n',
      ),
    );
    await fire(53);
  });
  assert.match(errorText(result.events), /no meaningful/);

  result = await scenario("timeout A then B success", [silent, success], async () => {
    await fire(53);
  });
  assert.deepEqual(result.attempted, ["A", "B"]);
  assert.equal(
    result.events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.delta : ""))
      .join(""),
    "Recovered",
  );
  assert.equal(result.events.filter((e) => e.type === "done").length, 1);

  for (const stalls of [false, true]) {
    let emptyConsumed!: () => void;
    const consumed = new Promise<void>((resolve) => {
      emptyConsumed = resolve;
    });
    result = await scenario(
      stalls ? "empty text then silence recovers" : "empty text then close recovers",
      [
        () => {
          let pulls = 0;
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  if (pulls++ === 0) {
                    controller.enqueue(encode([{ text: "" }, { text: "", thought: true }]));
                    if (!stalls) controller.close();
                  } else if (pulls === 2) {
                    controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
                  } else {
                    // Past the guard's one-chunk prefetch: empty parts have been parsed.
                    emptyConsumed();
                  }
                },
              },
              { highWaterMark: 0 },
            ),
          );
        },
        () =>
          new Response(
            encode([
              { text: "Recovered" },
              {
                text: "",
                thought: true,
                functionCall: { name: "read", args: { path: "a" }, id: "call1" },
                thoughtSignature: "YWJj",
              },
            ]),
          ),
      ],
      stalls
        ? async (events) => {
            await consumed;
            assert.deepEqual(events, [], "empty text must not emit content-start or deltas");
            await fire(53);
          }
        : undefined,
    );
    assert.deepEqual(result.attempted, ["A", "B"]);
    assert.equal(result.rotations, 1);
    assert.deepEqual(
      result.events.map((event) => event.type),
      [
        "start",
        "text_start",
        "text_delta",
        "text_end",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_end",
        "done",
      ],
    );
    const text = result.events.find((event) => event.type === "text_delta");
    assert(text?.type === "text_delta");
    assert.equal(text.delta, "Recovered");
    const tool = result.events.find((event) => event.type === "toolcall_end");
    assert(tool?.type === "toolcall_end");
    assert.deepEqual(tool.toolCall.arguments, { path: "a" });
    assert.equal(tool.toolCall.thoughtSignature, "YWJj");
  }

  for (const message of ["Individual quota reached. Resets in 3h.", "Rate limit per minute"]) {
    result = await scenario(`429 ${message}`, [
      () => new Response(message, { status: 429 }),
      success,
    ]);
    assert.deepEqual(result.attempted, ["A", "B"]);
  }

  result = await scenario("eligible accounts exhausted", [() => new Response(null)]);
  assert.match(errorText(result.events), /no eligible untried account/);
  result = await scenario("single key never rotates", [() => new Response(null)], undefined, {
    noSource: true,
  });
  assert.equal(result.rotations, 0);

  result = await scenario(
    "explicit cancellation",
    [silent, success],
    async (_events, _delta, caller) => {
      if (![...timers.values()].some((timer) => timer.ms === 53)) {
        await new Promise<void>((resolve) => armed.set(53, resolve));
      }
      caller.abort(new Error("user cancelled"));
    },
  );
  assert.equal(result.rotations, 0);
  assert.equal(result.events.at(-1)?.type, "error");
  assert.match(errorText(result.events), /user cancelled/);

  result = await scenario(
    "cancellation before headers",
    [
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
      success,
    ],
    async (_events, _delta, caller) => {
      caller.abort(new Error("user cancelled headers"));
    },
  );
  assert.equal(result.rotations, 0);
  assert.match(errorText(result.events), /user cancelled headers/);

  for (const parts of [
    [{ text: "partial" }],
    [{ text: "reasoning", thought: true, thoughtSignature: "YWJj" }],
    [
      {
        functionCall: { name: "read", args: {}, id: "call1" },
        thoughtSignature: "YWJj",
      },
    ],
  ]) {
    result = await scenario(
      "partial output failure never replays",
      [
        () => {
          const response = silent();
          bodyController.enqueue(encode(parts));
          return response;
        },
        success,
      ],
      async (_events, delta) => {
        await delta;
        bodyController.error(new Error("connection lost"));
      },
    );
    assert.equal(result.attempted.length, 1);
    assert.equal(result.rotations, 0);
    assert(result.events.filter((event) => event.type === "toolcall_end").length <= 1);
  }

  result = await scenario(
    "unified budget across empty and 429",
    [
      () => new Response(null),
      () => new Response("quota exceeded", { status: 429 }),
      () => new Response(null),
      success,
    ],
    undefined,
    { budget: 2 },
  );
  assert.equal(result.attempted.length, 3);
  assert.match(errorText(result.events), /budget reached \(2\/2/);
  result = await scenario(
    "default three account changes",
    Array.from({ length: 6 }, () => () => new Response("quota exceeded", { status: 429 })),
  );
  assert.equal(result.attempted.length, 4);
  assert.match(errorText(result.events), /3\/3/);
  result = await scenario("zero budget", [() => new Response(null), success], undefined, {
    budget: 0,
  });
  assert.equal(result.rotations, 0);
  assert.match(errorText(result.events), /0\/0/);
  result = await scenario(
    "source returning tried account is rejected",
    [() => new Response(null)],
    undefined,
    { repeated: true },
  );
  assert.equal(result.attempted.length, 1);
  assert.match(errorText(result.events), /no eligible untried account/);

  result = await scenario(
    "successful tool response after timeout emits once",
    [
      silent,
      () =>
        new Response(
          encode([
            { thought: true, text: "reason", thoughtSignature: "YWJj" },
            {
              functionCall: { name: "read", args: { path: "a" }, id: "call1" },
              thoughtSignature: "YWJj",
            },
          ]),
        ),
    ],
    async () => {
      await fire(53);
    },
  );
  assert.equal(result.events.filter((event) => event.type === "toolcall_end").length, 1);
  assert.equal(result.events.filter((event) => event.type === "done").length, 1);
  const tool = result.events.find((event) => event.type === "toolcall_end");
  assert(tool?.type === "toolcall_end");
  assert.equal(tool.toolCall.thoughtSignature, "YWJj");

  result = await scenario(
    "post-output stall never replays",
    [
      () => {
        const response = silent();
        bodyController.enqueue(encode([{ text: "partial" }]));
        return response;
      },
      success,
    ],
    async (_events, delta) => {
      await delta;
      assert(
        ![...timers.values()].some((timer) => timer.ms === 53),
        "first-content timer disarmed",
      );
      await fire(71);
    },
  );
  assert.equal(result.rotations, 0);
  assert.match(errorText(result.events), /stream stalled/);

  // ── Transient 429 backoff and circuit breaker ────────────────────────
  // Bare RESOURCE_EXHAUSTED is transient (not isHardQuotaWall).
  const transient429 = () => new Response("RESOURCE_EXHAUSTED", { status: 429 });

  sleepLog.length = 0;
  process.env.ANTIGRAVITY_STREAM_MAX_TRANSIENT_ROTATIONS = "3";
  process.env.ANTIGRAVITY_STREAM_TRANSIENT_BACKOFF_BASE_MS = "100";
  process.env.ANTIGRAVITY_STREAM_TRANSIENT_BACKOFF_CAP_MS = "1000";
  result = await scenario(
    "transient 429 circuit breaker trips after max rotations",
    Array(10).fill(transient429),
    undefined,
    { budget: 10 },
  );
  assert.equal(result.attempted.length, 3); // 1 initial + 2 rotations, breaker trips on 3rd fail
  assert.equal(result.rotations, 2);
  assert.match(errorText(result.events), /circuit breaker tripped/);
  assert.match(errorText(result.events), /3 consecutive transient 429s/);
  // Verify exponential backoff: 100, 200 (before jitter); breaker trips before 3rd sleep.
  assert.equal(sleepLog.length, 2);
  assert(sleepLog[0]! >= 100 && sleepLog[0]! <= 125, `backoff 0: ${sleepLog[0]}`);
  assert(sleepLog[1]! >= 200 && sleepLog[1]! <= 250, `backoff 1: ${sleepLog[1]}`);
  console.log("PASS transient 429 circuit breaker trips after max rotations");

  sleepLog.length = 0;
  result = await scenario(
    "hard quota 429 rotates without backoff",
    [
      () => new Response("Individual quota reached. Resets in 1h.", { status: 429 }),
      () => new Response("Individual quota reached. Resets in 1h.", { status: 429 }),
      success,
    ],
    undefined,
    { budget: 3 },
  );
  assert.equal(result.attempted.length, 3);
  assert.equal(result.rotations, 2);
  assert.equal(sleepLog.length, 0, "hard quota should not sleep");
  console.log("PASS hard quota 429 rotates without backoff");

  sleepLog.length = 0;
  result = await scenario(
    "mixed hard+transient 429 resets consecutive counter",
    [
      transient429,  // transient: consecutive=1, backoff
      transient429,  // transient: consecutive=2, backoff
      () => new Response("Individual quota reached. Resets in 1h.", { status: 429 }), // hard: consecutive=0
      transient429,  // transient: consecutive=1, backoff
      success,
    ],
    undefined,
    { budget: 10 },
  );
  assert.equal(result.attempted.length, 5);
  assert.equal(result.rotations, 4);
  // 2 transient sleeps + 0 hard + 1 transient sleep = 3 sleeps
  assert.equal(sleepLog.length, 3, `expected 3 sleeps, got ${sleepLog.length}`);
  // After hard quota reset, the third transient starts at base again.
  assert(sleepLog[2]! >= 100 && sleepLog[2]! <= 125, `after reset backoff: ${sleepLog[2]}`);
  console.log("PASS mixed hard+transient 429 resets consecutive counter");

  sleepLog.length = 0;
  process.env.ANTIGRAVITY_STREAM_TRANSIENT_BACKOFF_CAP_MS = "150";
  result = await scenario(
    "transient 429 backoff caps at configured maximum",
    [transient429, transient429, success],
    undefined,
    { budget: 10 },
  );
  assert.equal(sleepLog.length, 2);
  // Second backoff: min(100*2^1=200, cap=150) → 150 (before jitter).
  assert(sleepLog[1]! >= 150 && sleepLog[1]! <= 187, `capped backoff: ${sleepLog[1]}`);
  console.log("PASS transient 429 backoff caps at configured maximum");

  // ── OAuth refresh failure propagation ────────────────────────────────
  {
    process.env.ANTIGRAVITY_NO_PREWARM = "1";
    let callNum = 0;
    const oauthFailSource: CredentialSource = {
      async current() {
        callNum++;
        if (callNum === 1) {
          throw new OAuthRefreshError(
            "Antigravity token refresh failed: internal_failure",
            500,
            "internal_failure",
            true,
          );
        }
        return { token: "recovered-token", projectId: "test" };
      },
      async rotate() {
        return undefined;
      },
    };
    const recoveryStream = streamAntigravity(
      model,
      { messages: [{ role: "user", content: "test", timestamp: 0 }] },
      { credentialSource: oauthFailSource, signal: new AbortController().signal },
    );
    const recoveryEvents: AssistantMessageEvent[] = [];
    for await (const event of recoveryStream) {
      recoveryEvents.push(event);
    }
    const errorEvent = recoveryEvents.find((e) => e.type === "error");
    assert(errorEvent, "stream should emit error when current() throws OAuthRefreshError");
    assert(errorEvent.type === "error");
    assert.match(
      errorEvent.error.errorMessage || "",
      /internal_failure/,
      "error message should contain the OAuth error",
    );
    console.log("PASS OAuth refresh failure from current() propagates as stream error");
  }

  // Cleanup env overrides for subsequent tests.
  delete process.env.ANTIGRAVITY_STREAM_MAX_TRANSIENT_ROTATIONS;
  delete process.env.ANTIGRAVITY_STREAM_TRANSIENT_BACKOFF_BASE_MS;
  delete process.env.ANTIGRAVITY_STREAM_TRANSIENT_BACKOFF_CAP_MS;

  console.log("All silent-stream recovery tests passed");
} finally {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  process.env = savedEnv;
}
