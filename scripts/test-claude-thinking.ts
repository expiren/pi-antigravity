import assert from "node:assert/strict";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerAntigravityCommands } from "../src/commands/antigravity.js";
import { getLastDiagnostics } from "../src/diagnostics/diagnostics.js";
import type { HealthRecord } from "../src/health/types.js";
import { getThinkingConfig } from "../src/models/models.js";
import { buildRequest } from "../src/stream/stream.js";
import {
  account,
  fixture,
  OPUS,
  QUOTA,
  request,
  success,
  terminalError,
} from "./health-fixtures.js";

const model: Model<Api> = {
  id: "claude-opus-4-6",
  name: "Opus",
  provider: "antigravity",
  api: "antigravity-api",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  reasoning: true,
  input: ["text"],
  contextWindow: 250_000,
  maxTokens: 64_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context: Context = {
  messages: [{ role: "user", content: "deterministic request", timestamp: 0 }],
};
let passed = 0;
function check(name: string, run: () => void) {
  run();
  console.log(`PASS ${++passed}. ${name}`);
}

function assertNoHealthPenalty(
  before: Record<string, HealthRecord>,
  after: Record<string, HealthRecord>,
) {
  for (const [key, record] of Object.entries(before)) assert.deepEqual(after[key], record);
  const added = Object.entries(after).filter(([key]) => !(key in before));
  assert.equal(added.length, 1);
  assert.equal(added[0][1].status, "unknown");
  assert.equal(added[0][1].reason, "unknown");
  assert.equal(added[0][1].cooldownUntil, 0);
}

for (const id of ["claude-opus-4-6", "claude-sonnet-4-6"]) {
  const runtime = id.includes("opus") ? OPUS : id;
  const current = { ...model, id };
  for (const reasoning of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    for (const maxTokens of [512, 1024]) {
      check(`${id} ${reasoning}: reject output cap ${maxTokens} locally`, () => {
        assert.throws(
          () => buildRequest(current, context, "test-project", { reasoning, maxTokens }, runtime),
          /Claude.*maxTokens.*1024.*1025/,
        );
      });
    }
    check(`${id} ${reasoning}: preserve explicit cap above budget`, () => {
      const config = buildRequest(
        current,
        context,
        "test-project",
        { reasoning, maxTokens: 1025 },
        runtime,
      ).request.generationConfig!;
      assert.equal(config.maxOutputTokens, 1025);
      assert.deepEqual(config.thinkingConfig, { includeThoughts: true, thinkingBudget: 1024 });
    });
    check(`${id} ${reasoning}: uncapped output fits thinking`, () => {
      const config = buildRequest(current, context, "test-project", { reasoning }, runtime).request
        .generationConfig!;
      assert.equal(config.maxOutputTokens, id === "claude-opus-4-6" ? 8192 : 64000);
      assert.equal(config.thinkingConfig?.thinkingBudget, 1024);
      assert.ok(config.maxOutputTokens! > 1024);
    });
  }
  for (const maxTokens of [2048, 4096, 8192, 16384]) {
    check(`${id}: preserve explicit output cap ${maxTokens}`, () => {
      const config = buildRequest(
        current,
        context,
        "test-project",
        { reasoning: "high", maxTokens },
        runtime,
      ).request.generationConfig!;
      assert.equal(config.maxOutputTokens, maxTokens);
    });
  }
  check(`${id}: retain existing host reasoning-off wire format`, () => {
    const config = buildRequest(current, context, "test-project", { maxTokens: 512 }, runtime)
      .request.generationConfig!;
    assert.equal(config.maxOutputTokens, 512);
    assert.deepEqual(config.thinkingConfig, { includeThoughts: false, thinkingBudget: 0 });
    assert.deepEqual(getThinkingConfig(runtime, "off"), config.thinkingConfig);
  });
  check(`${id}: omitted cap respects a lower model ceiling`, () => {
    const config = buildRequest(
      { ...current, maxTokens: 4096 },
      context,
      "test-project",
      { reasoning: "high" },
      runtime,
    ).request.generationConfig!;
    assert.equal(config.maxOutputTokens, 4096);
    assert.equal(config.thinkingConfig?.thinkingBudget, 1024);
  });
  check(`${id}: respect lower host model ceiling`, () => {
    const config = buildRequest(
      { ...current, maxTokens: 4096 },
      context,
      "test-project",
      { reasoning: "high", maxTokens: 8192 },
      runtime,
    ).request.generationConfig!;
    assert.equal(config.maxOutputTokens, 4096);
    assert.equal(config.thinkingConfig?.thinkingBudget, 1024);
  });
  check(`${id}: reject model default that cannot fit thinking`, () => {
    assert.throws(
      () =>
        buildRequest(
          { ...current, maxTokens: 1024 },
          context,
          "test-project",
          { reasoning: "high" },
          runtime,
        ),
      /Claude.*maxTokens.*1024.*1025/,
    );
  });
  check(`${id}: clamp oversized host limit to supported runtime maximum`, () => {
    assert.equal(
      buildRequest(
        { ...current, maxTokens: 100000 },
        context,
        "test-project",
        { reasoning: "high", maxTokens: 100000 },
        runtime,
      ).request.generationConfig?.maxOutputTokens,
      64000,
    );
  });
}

for (const runtime of ["gemini-3.7-flash-high", "gpt-oss-120b-medium"]) {
  check(`${runtime}: non-Claude token and thinking behavior is unchanged`, () => {
    const config = buildRequest(
      { ...model, id: runtime, maxTokens: 4096 },
      context,
      "test-project",
      { reasoning: "high", maxTokens: 8192 },
      runtime,
    ).request.generationConfig!;
    assert.equal(config.maxOutputTokens, 8192);
    assert.deepEqual(config.thinkingConfig, getThinkingConfig(runtime, "high"));
  });
}

for (const maxTokens of [0, -1, 1.5, NaN]) {
  check(`reject invalid Claude output limit ${maxTokens} even with reasoning off`, () => {
    assert.throws(
      () => buildRequest(model, context, "test-project", { maxTokens }, OPUS),
      /Claude maxTokens/,
    );
  });
}

check("runtime override to Claude still validates thinking against the explicit host cap", () => {
  assert.throws(
    () =>
      buildRequest(
        { ...model, id: "gemini-3.7-flash" },
        context,
        "test-project",
        { reasoning: "high", maxTokens: 1024 },
        OPUS,
      ),
    /Claude.*maxTokens.*1024.*1025/,
  );
});

await fixture(async (f) => {
  f.cool([account(1)]);
  const records = f.store.snapshot().records;
  const result = await request(
    f,
    (_token, _attempt, init) => {
      const config = JSON.parse(String(init.body)).request.generationConfig;
      assert.equal(config.maxOutputTokens, 8192);
      return success();
    },
    { reasoning: "high" },
  );
  assert.equal(result.events.at(-1)?.type, "done");
  assert.deepEqual(result.attempted, ["fake-access-0"]);
  for (const [key, record] of Object.entries(records)) {
    assert.deepEqual(f.store.snapshot().records[key], record);
  }
  assert.equal(getLastDiagnostics().healthSelection?.rotationCount, 0);
  assert.deepEqual(f.store.snapshot().reservations, {});
});
console.log(
  `PASS ${++passed}. uncapped Opus stream sends 8192 without changing existing cooldowns`,
);

await fixture(async (f) => {
  f.cool([account(1)]);
  const accounts = f.bytes("antigravity-accounts.json");
  const auth = f.bytes("auth.json");
  const records = f.store.snapshot().records;
  const result = await request(
    f,
    () => {
      throw new Error("Invalid local configuration must not reach the network");
    },
    { reasoning: "high", maxTokens: 1024 },
  );
  assert.equal(result.attempted.length, 0);
  assert.match(terminalError(result.events), /Claude.*maxTokens.*1024.*1025/);
  assert.equal(getLastDiagnostics().healthSelection?.rotationCount, 0);
  assertNoHealthPenalty(records, f.store.snapshot().records);
  assert.deepEqual(f.store.snapshot().reservations, {});
  assert.deepEqual(f.bytes("antigravity-accounts.json"), accounts);
  assert.deepEqual(f.bytes("auth.json"), auth);
});
console.log(
  `PASS ${++passed}. local configuration error releases reservation without health penalty`,
);

for (const message of [
  "max_tokens must be greater than thinking.budget_tokens",
  '{"type":"error","error":{"type":"invalid_request_error","message":"messages.27.content.0.thinking.signature: Field required"}}',
]) await fixture(async (f) => {
  f.cool([account(1)]);
  const records = f.store.snapshot().records;
  const accounts = f.bytes("antigravity-accounts.json");
  const auth = f.bytes("auth.json");
  const result = await request(
    f,
    () => new Response(message, { status: 400 }),
    { reasoning: "high", maxTokens: 2048 },
  );
  assert.deepEqual(result.attempted, ["fake-access-0"]);
  assert.match(terminalError(result.events), /thinking\.signature: Field required|max_tokens.*thinking.budget_tokens/);
  assert.equal(getLastDiagnostics().status, 400);
  assert.equal(getLastDiagnostics().healthSelection?.rotationCount, 0);
  assert.equal(getLastDiagnostics().healthSelection?.lastFailureClass, undefined);
  assertNoHealthPenalty(records, f.store.snapshot().records);
  assert.deepEqual(f.store.snapshot().reservations, {});
  assert.deepEqual(f.bytes("antigravity-accounts.json"), accounts);
  assert.deepEqual(f.bytes("auth.json"), auth);
});
console.log(`PASS ${++passed}. backend HTTP 400 never rotates or changes existing quota health`);

await fixture(async (f) => {
  const result = await request(f, (_token, attempt) =>
    attempt === 1 ? new Response(QUOTA, { status: 429 }) : success(),
  );
  assert.equal(result.events.at(-1)?.type, "done");
  assert.equal(getLastDiagnostics().status, 200);
  assert.equal(getLastDiagnostics().healthSelection?.lastFailureClass, "hard_quota");
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  registerAntigravityCommands({
    registerCommand(name, command) {
      commands.set(name, command);
    },
  } as ExtensionAPI);
  const originalLog = console.log;
  let report = "";
  try {
    console.log = (...args: unknown[]) => {
      report += args.join(" ");
    };
    await commands.get("antigravity")!.handler("doctor", {
      hasUI: false,
      model,
    } as ExtensionCommandContext);
  } finally {
    console.log = originalLog;
  }
  assert.match(report, /lastRecoveryFailureClass=hard_quota/);
  assert.deepEqual(f.store.snapshot().reservations, {});
  const next = await request(f, success);
  assert.equal(next.events.at(-1)?.type, "done");
  assert.equal(getLastDiagnostics().healthSelection?.lastFailureClass, undefined);
});
console.log(
  `PASS ${++passed}. doctor distinguishes a previous recovery failure from final success`,
);
console.log(`Claude thinking: ${passed}/${passed} deterministic checks passed.`);
