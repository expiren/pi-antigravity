import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import type { StoredAccount } from "../src/auth/accounts.js";
import { AccountCredentialSource } from "../src/runtime/account-credential-source.js";
import { PersistentCredentialSource } from "../src/runtime/persistent-credential-source.js";
import { classifyHealthFailure } from "../src/health/classification.js";
import { HealthStore } from "../src/health/store.js";
import { healthScope, recordKey } from "../src/health/scope.js";
import { streamAntigravity } from "../src/stream/stream.js";
import type { AntigravityStreamOptions } from "../src/types/types.js";

export const OPUS = "claude-opus-4-6-thinking";
export const GEMINI = "gemini-3.7-flash";
export const QUOTA = "Quota reached. Resets in 66h15m52s";

export function account(index: number, projectId = "test-project"): StoredAccount {
  return {
    accountId: `linked-${index}`,
    access: `fake-access-${index}`,
    refresh: `fake-refresh-${index}`,
    expires: 8_000_000_000_000_000,
    projectId,
    addedAt: index + 1,
    lastUsedAt: 0,
  };
}

export async function fixture(run: (f: Fixture) => Promise<void> | void): Promise<void> {
  const environment = { ...process.env };
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  const root = mkdtempSync(join(tmpdir(), "pi-antigravity-health-"));
  const f = new Fixture(root);
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    process.env.ANTIGRAVITY_NO_PREWARM = "1";
    process.env.ANTIGRAVITY_RUNTIME_MODEL = OPUS;
    process.env.ANTIGRAVITY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
    delete process.env.ANTIGRAVITY_PROJECT_ID;
    delete process.env.NOAGY_PROJECT_ID;
    Date.now = () => f.now;
    globalThis.fetch = async () => {
      throw new Error(
        "Unexpected network access: deterministic health tests cannot use providers.",
      );
    };
    f.accounts([account(0), account(1)]);
    await run(f);
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    rmSync(root, { recursive: true, force: true });
  }
}

export class Fixture {
  now = Date.UTC(2026, 9, 23, 12);
  readonly store: HealthStore;
  pool: StoredAccount[] = [];
  constructor(readonly root: string) {
    this.store = new HealthStore(join(root, "antigravity-account-health.json"), {
      now: () => this.now,
    });
  }
  accounts(pool: StoredAccount[]): void {
    this.pool = pool;
    writeFileSync(
      join(this.root, "antigravity-accounts.json"),
      JSON.stringify({
        version: 1,
        activeAccountId: pool[0]?.accountId,
        accounts: Object.fromEntries(pool.map((a) => [a.accountId, a])),
      }) + "\n",
    );
    writeFileSync(join(this.root, "auth.json"), '{"other":{"type":"api","key":"fake-keep"}}\n');
  }
  source(model = OPUS): PersistentCredentialSource {
    return new PersistentCredentialSource(model, this.store, () => this.now);
  }
  cool(accounts: readonly StoredAccount[], model = OPUS, body = QUOTA): void {
    this.store.update((state) => {
      for (const a of accounts) {
        const scope = healthScope(a.accountId, a.projectId ?? "", model);
        const failure = classifyHealthFailure({ status: 429, body, now: this.now });
        state.records[recordKey(scope)] = {
          ...scope,
          status: failure.status,
          reason: failure.reason,
          observedAt: this.now,
          cooldownUntil: failure.cooldownUntil,
          retryAfterUntil: failure.retryAfterUntil,
          responseStatus: 429,
        };
      }
    });
  }
  bytes(name: string): Buffer {
    return readFileSync(join(this.root, name));
  }
}

export const success = () =>
  new Response(
    `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] } })}\n\ndata: [DONE]\n\n`,
  );

export async function request(
  f: Fixture,
  respond: (token: string, attempt: number, init: RequestInit) => Response | Promise<Response>,
  options: AntigravityStreamOptions = {},
  drive?: (firstDelta: Promise<void>) => Promise<void>,
): Promise<{ events: AssistantMessageEvent[]; attempted: string[] }> {
  const original = globalThis.fetch;
  const attempted: string[] = [];
  const model = {
    id: "claude-opus-4-6",
    name: "Opus",
    provider: "antigravity",
    api: "antigravity-api",
  } satisfies Partial<Model<Api>>;
  const fullModel: Model<Api> = {
    ...model,
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    reasoning: true,
    input: ["text"],
    contextWindow: 250_000,
    maxTokens: 64_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  globalThis.fetch = async (_input, init) => {
    assert(init);
    const token = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    attempted.push(token);
    return respond(token, attempted.length, init);
  };
  const events: AssistantMessageEvent[] = [];
  let notifyDelta = () => {};
  const firstDelta = new Promise<void>((resolve) => {
    notifyDelta = resolve;
  });
  try {
    const pending = (async () => {
      for await (const event of streamAntigravity(
        fullModel,
        { messages: [{ role: "user", content: "health test", timestamp: f.now }] },
        { credentialSource: new AccountCredentialSource(), ...options },
      )) {
        events.push(event);
        if (
          event.type === "text_delta" ||
          event.type === "thinking_delta" ||
          event.type === "toolcall_delta"
        )
          notifyDelta();
      }
    })();
    if (drive) await drive(firstDelta);
    await pending;
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(events.filter((e) => e.type === "done" || e.type === "error").length, 1);
  return { events, attempted };
}

export function terminalError(events: AssistantMessageEvent[]): string {
  const last = events.at(-1);
  assert(last?.type === "error");
  return last.error.errorMessage ?? "";
}
