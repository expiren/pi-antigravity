import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agent = mkdtempSync(join(tmpdir(), "pi-antigravity-v3-load-"));
const previousDirectory = process.env.PI_CODING_AGENT_DIR;
const originalFetch = globalThis.fetch;
const originalLog = console.log;
process.env.PI_CODING_AGENT_DIR = agent;
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error("Staged compatibility test must not use providers.");
};
const commands = new Map();
const providers = [];
const hooks = new Map();
const messages = [];
try {
  const accounts = Object.fromEntries(
    Array.from({ length: 302 }, (_, i) => [
      `simulated-${i}`,
      {
        accountId: `simulated-${i}`,
        access: `fake-access-${i}`,
        refresh: `fake-refresh-${i}`,
        expires: 8_000_000_000_000_000,
        projectId: "test-project",
        addedAt: i + 1,
        lastUsedAt: 0,
      },
    ]),
  );
  const accountPath = join(agent, "antigravity-accounts.json");
  writeFileSync(
    accountPath,
    JSON.stringify({ version: 1, activeAccountId: "simulated-0", accounts }),
  );
  const before = readFileSync(accountPath);
  const entry = process.argv[2] || join(root, "src", "index.ts");
  const extension = await import(pathToFileURL(entry).href);
  const registration = extension.default({
    registerProvider(id) {
      providers.push(id);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool() {},
    on(name, handler) {
      hooks.set(name, handler);
    },
    unregisterProvider() {},
  });
  assert(providers.includes("antigravity"));
  assert(commands.has("antigravity") && commands.has("antigravity.usage"));
  assert(hooks.has("context") && hooks.has("session_start"));
  console.log = (...args) => {
    messages.push(args.join(" "));
  };
  const context = { hasUI: false, model: { id: "claude-opus-4-6" } };
  await commands.get("antigravity").handler("health claude-opus-4-6-thinking", context);
  await commands.get("antigravity").handler("doctor", context);
  const { setLastResolvedRuntimeModel } = await import(
    pathToFileURL(join(dirname(entry), "diagnostics", "diagnostics.ts")).href
  );
  const { getAntigravityRequestModelId } = await import(
    pathToFileURL(join(dirname(entry), "models", "models.ts")).href
  );
  setLastResolvedRuntimeModel("claude-opus-4-6-thinking", "claude-opus-4-6");
  const switched = { hasUI: false, model: { id: "gemini-3.7-flash" } };
  await commands.get("antigravity").handler("doctor", switched);
  await commands.get("antigravity").handler("health", switched);
  console.log = originalLog;
  assert.equal(messages.length, 4);
  for (const message of messages) {
    assert.match(message, /linked=302/);
    assert.match(message, /unknown=302/);
    assert.match(message, /known_cooldown=0/);
    assert(!message.includes("fake-access") && !message.includes("fake-refresh"));
    assert(!message.includes("simulated-"));
  }
  assert.match(messages[1], /selectedAccount=none/);
  assert.match(messages[1], /rotationCount=0/);
  assert.match(messages[1], /skipReasons=\{\}/);
  const switchedModel = getAntigravityRequestModelId(switched.model.id, undefined);
  assert(messages[2].includes(`model=${switchedModel}\n`));
  assert(messages[3].includes(`model=${switchedModel}\n`));
  assert.equal(networkAttempts, 0);
  assert.deepEqual(readFileSync(accountPath), before);
  assert.equal(existsSync(join(agent, "auth.json")), false);
  assert.equal(existsSync(join(agent, "antigravity-account-health.json")), false);
  await registration?.deactivate?.();
  console.log(
    "PASS staged extension registration and actual doctor/health handlers: 302 unknown, zero requests, no writes",
  );
} finally {
  console.log = originalLog;
  globalThis.fetch = originalFetch;
  if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDirectory;
  rmSync(agent, { recursive: true, force: true });
}
