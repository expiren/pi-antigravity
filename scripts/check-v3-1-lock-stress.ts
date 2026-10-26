/// <reference types="node" />
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

// Run manually: bun scripts/check-v3-1-lock-stress.ts [rounds=3] [processes=2|4|8|16]
// stdout is exactly one JSON summary; child diagnostics stay captured.
assert.equal(process.platform, "win32", "This harness measures real Windows processes.");
const rounds = Number(process.argv[2] ?? 3);
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 100, "rounds must be 1..100");
const counts = process.argv[3] === undefined ? [2, 4, 8, 16] : [Number(process.argv[3])];
assert(
  counts.every((count) => [2, 4, 8, 16].includes(count)),
  "processes must be 2, 4, 8 or 16",
);
assert.equal(parse(tmpdir()).root.toLowerCase(), "c:\\", "Use an OS-private C: TEMP.");
const directory = mkdtempSync(join(tmpdir(), "pi-antigravity-v3-1-lock-"));
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerPath = join(root, "scripts", "check-v3-1-lock-worker.ts");
const deadlineMs = 120_000;
type Message = {
  event: string;
  id?: string;
  ok?: boolean;
  code?: string;
  error?: string;
  value?: string;
  markerKey?: string;
  lockWaitMs?: number;
  transactionMs?: number | null;
  totalMs?: number;
  components?: Record<string, number>;
};
type Sample = Message & { worker: string; operation: string };
const samples: Sample[] = [];
const runs: object[] = [];
const children = new Set<ReturnType<typeof spawn>>();
let commandSequence = 0;
let networkAttempts = 0;
let violation: string | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error("Lock stress harness must not use the network.");
};

// Protect the entire fixture directory before writing any simulated state.
// The path is passed via the environment, never interpolated into PowerShell.
const protectDirectory = `
$ErrorActionPreference = 'Stop'
$p = $env:V31_STRESS_DIRECTORY
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($me)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($me.Value, 'S-1-5-18', 'S-1-5-32-544')) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    [System.Security.Principal.SecurityIdentifier]::new($sid), 'FullControl',
    'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
[System.IO.Directory]::SetAccessControl($p, $acl)
$verified = [System.IO.Directory]::GetAccessControl($p)
if (-not $verified.AreAccessRulesProtected) { throw 'Unprotected fixture directory' }
foreach ($rule in $verified.Access) {
  $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($rule.AccessControlType -ne 'Allow' -or
      @($me.Value, 'S-1-5-18', 'S-1-5-32-544') -notcontains $sid) { throw 'Unsafe ACL' }
}
`;

function worker(path: string, identity: string, mode = "normal") {
  const child = spawn(process.execPath, [workerPath, path, identity, mode], {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: directory,
      ANTIGRAVITY_NO_PREWARM: "1",
      ANTIGRAVITY_PROJECT_ID: "stress-project",
      NOAGY_PROJECT_ID: "stress-project",
      ANTIGRAVITY_HEALTH_METRICS: "1",
    },
  });
  children.add(child);
  const messages: Message[] = [];
  const listeners = new Set<() => void>();
  let text = "";
  let stderr = "";
  let ended = false;
  let spawnError: Error | undefined;
  const done = new Promise<number | null>((resolve) => {
    const timer = setTimeout(
      () => {
        child.kill();
        resolve(null);
      },
      deadlineMs * (rounds + 4),
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      spawnError = error;
      ended = true;
      for (const listener of listeners) listener();
      resolve(null);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      ended = true;
      children.delete(child);
      for (const listener of listeners) listener();
      resolve(code);
    });
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  child.stdin!.on("error", (error) => {
    spawnError = error;
    for (const listener of listeners) listener();
  });
  child.stdout!.on("data", (chunk: Buffer) => {
    text += chunk.toString();
    let newline: number;
    while ((newline = text.indexOf("\n")) !== -1) {
      const line = text.slice(0, newline);
      text = text.slice(newline + 1);
      try {
        messages.push(JSON.parse(line) as Message);
      } catch {
        spawnError = new Error(`Invalid worker output: ${line}`);
      }
    }
    for (const listener of listeners) listener();
  });
  function event(name: string, id?: string): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${identity}: timed out waiting for ${name}/${id ?? ""}: ${stderr}`));
      }, deadlineMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        listeners.delete(check);
      };
      const check = (): void => {
        const index = messages.findIndex((m) => m.event === name && m.id === id);
        if (index !== -1) {
          cleanup();
          resolve(messages.splice(index, 1)[0]);
        } else if (ended || spawnError) {
          cleanup();
          reject(spawnError ?? new Error(`${identity}: exited before ${name}: ${stderr}`));
        }
      };
      listeners.add(check);
      check();
    });
  }
  function command(operation: string, extra: object = {}) {
    const id = `${++commandSequence}`;
    // Subscribe to both exact events before sending the action.
    const started = event("started", id);
    const result = Promise.all([started, event("result", id)]).then(([, message]) => {
      samples.push({ ...message, worker: identity, operation });
      return message;
    });
    child.stdin!.write(`${JSON.stringify({ id, operation, ...extra })}\n`);
    return { started, result };
  }
  return {
    child,
    identity,
    event,
    command,
    done,
    send: (data: string) => child.stdin!.write(data),
  };
}

function successful(messages: Message[]): void {
  for (const message of messages) assert(message.ok, JSON.stringify(message));
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null,
    maxMs: sorted.at(-1) ?? null,
  };
}
function metrics(items: Sample[]) {
  const components: Record<string, number> = {};
  for (const item of items) {
    for (const [name, value] of Object.entries(item.components ?? {})) {
      components[name] = (components[name] ?? 0) + value;
    }
  }
  return {
    attempts: items.length,
    successes: items.filter((item) => item.ok).length,
    successRate: items.length ? items.filter((item) => item.ok).length / items.length : null,
    lockWait: distribution(items.map((item) => item.lockWaitMs!)),
    transaction: distribution(
      items.flatMap((item) => (typeof item.transactionMs === "number" ? [item.transactionMs] : [])),
    ),
    total: distribution(items.map((item) => item.totalMs!)),
    components,
  };
}

try {
  execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", protectDirectory],
    {
      timeout: 15_000,
      windowsHide: true,
      stdio: "pipe",
      env: { ...process.env, V31_STRESS_DIRECTORY: directory },
    },
  );
  // Source imports are deliberately deferred until the private sandbox is ready.
  process.env.PI_CODING_AGENT_DIR = directory;
  const { HealthStore } = await import("../src/health/store.js");
  const { createPrivateFile } = await import("../src/health/private-file.js");
  for (const concurrency of counts) {
    const path = join(directory, `workers-${concurrency}.json`);
    const store = new HealthStore(path, { now: () => Date.UTC(2026, 9, 24, 12) });
    const workers = Array.from({ length: concurrency }, (_, index) =>
      worker(path, `${concurrency}-${index}`),
    );
    const ready = await Promise.all(workers.map((item) => item.event("ready")));
    let expectedSequence = 0;
    const cooldowns = new Set<string>();
    for (let round = 0; round < rounds; round++) {
      const reservations = workers.map((item) => `lease-${item.identity}-${round}`);
      successful(
        await Promise.all(
          workers.map(
            (item, index) =>
              item.command("select", {
                reservationId: reservations[index],
              }).result,
          ),
        ),
      );
      let snapshot = store.snapshot();
      const leases = Object.values(snapshot.reservations);
      assert.equal(leases.length, concurrency);
      assert.equal(new Set(leases.map((lease) => lease.accountId)).size, concurrency);
      for (const lease of leases) assert(!cooldowns.has(lease.accountId));
      const failedAccount = snapshot.reservations[reservations[0]].accountId;
      successful(
        await Promise.all(
          workers.map(
            (item, index) =>
              item.command(index === 0 ? "failure" : "success", {
                reservationId: reservations[index],
              }).result,
          ),
        ),
      );
      cooldowns.add(failedAccount);
      snapshot = new HealthStore(path).snapshot(); // Fresh read, not controller cache.
      assert.equal(Object.keys(snapshot.reservations).length, 0);
      for (const lease of leases.filter((lease) => lease.id !== reservations[0])) {
        assert(
          Object.values(snapshot.records).some(
            (record) =>
              record.accountId === lease.accountId &&
              record.lastSuccessAt === Date.UTC(2026, 9, 24, 12),
          ),
          "A successful request did not persist its success.",
        );
      }
      for (const accountId of cooldowns) {
        assert(
          Object.values(snapshot.records).some(
            (record) =>
              record.accountId === accountId &&
              record.status === "hard_quota" &&
              record.cooldownUntil === Date.UTC(2026, 9, 25, 12),
          ),
          "A concurrent success/release lost an earlier cooldown.",
        );
      }
      successful(await Promise.all(workers.map((item) => item.command("increment").result)));
      snapshot = store.snapshot();
      for (const message of ready) {
        assert.equal(snapshot.records[message.markerKey!]?.attemptOrder, round + 1);
      }
      assert(snapshot.sequence >= expectedSequence + concurrency * 3);
      expectedSequence = snapshot.sequence;
    }
    const releaseId = `release-${concurrency}`;
    successful([
      await workers[0].command("select", {
        reservationId: releaseId,
      }).result,
    ]);
    assert(store.snapshot().reservations[releaseId]);
    successful([await workers[0].command("release", { reservationId: releaseId }).result]);
    assert.equal(Object.keys(store.snapshot().reservations).length, 0);
    // Keep a real owner locked behind a pipe barrier, then cancel a staged
    // waiter before acquisition. Never kill inside acquisition's recovery gate.
    const owner = worker(path, `owner-${concurrency}`, "hold");
    const ownerReady = await owner.event("ready");
    const locked = owner.event("locked");
    owner.send("G");
    await locked;
    const beforeCrash = readFileSync(path);
    const liveBlocked = await workers[0].command("probe").result;
    assert.equal(liveBlocked.ok, false);
    assert.equal(liveBlocked.code, "busy");
    assert.deepEqual(readFileSync(path), beforeCrash, "A waiter stole a live owner's lock.");
    const cancelled = worker(path, `cancelled-${concurrency}`);
    await cancelled.event("ready");
    const pending = cancelled.command("stage");
    // Rejection is expected because cancellation exits before a result event.
    const cancelledResult = pending.result.catch(() => undefined);
    await pending.started;
    cancelled.child.kill();
    await cancelled.done;
    await cancelledResult;
    assert.deepEqual(readFileSync(path), beforeCrash, "Cancelled waiter mutated durable state.");
    const aborting = worker(path, `abort-${concurrency}`);
    await aborting.event("ready");
    const waiting = aborting.command("increment");
    await waiting.started;
    const aborted = aborting.event("aborted", `abort-${concurrency}`);
    aborting.send(`${JSON.stringify({ id: `abort-${concurrency}`, operation: "abort" })}\n`);
    await aborted;
    const abortedResult = await waiting.result;
    assert.equal(abortedResult.ok, false);
    assert.match(abortedResult.error ?? "", /aborted/i);
    assert.deepEqual(readFileSync(path), beforeCrash, "Aborted waiter mutated durable state.");
    aborting.send("stop\n");
    assert.equal(await aborting.done, 0);
    const crash = owner.done;
    owner.send("X");
    assert.equal(await crash, 17);
    assert(existsSync(`${path}.lock`), "Crash did not leave a real dead-owner lock.");
    successful([await workers[0].command("increment").result]);
    assert(!existsSync(`${path}.lock`), "Dead-owner recovery did not release its lock.");
    assert.equal(
      store.snapshot().records[ownerReady.markerKey!],
      undefined,
      "A crashed transaction committed its uncommitted mutation.",
    );
    assert.deepEqual(
      store.snapshot().records[ready[0].markerKey!].attemptOrder,
      rounds + 1,
      "Dead-owner recovery lost committed increments.",
    );
    // An ambiguous orphan recovery gate must fail closed, without state writes.
    // No transaction remains active when the harness removes its own injected gate.
    const gate = `${path}.lock-recovery`;
    closeSync(createPrivateFile(gate));
    const beforeGate = readFileSync(path);
    const blocked = await workers[0].command("probe").result;
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "busy");
    assert.deepEqual(readFileSync(path), beforeGate);
    rmSync(gate);
    successful([await workers[0].command("increment").result]);
    for (const item of workers) item.send("stop\n");
    assert.deepEqual(
      await Promise.all(workers.map((item) => item.done)),
      workers.map(() => 0),
    );
    const scoped = samples.filter((sample) => sample.worker.startsWith(`${concurrency}-`));
    runs.push({
      concurrency,
      rounds,
      ...metrics(scoped),
      expectedFailClosedResults: 2,
      workers: workers.map((item) => ({
        identity: item.identity,
        ...metrics(scoped.filter((sample) => sample.worker === item.identity)),
      })),
    });
  }
  assert.equal(networkAttempts, 0);
} catch (error) {
  violation = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  globalThis.fetch = originalFetch;
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    violation ??= `Fixture cleanup failed: ${String(error)}`;
    process.exitCode = 1;
  }
  console.log(
    JSON.stringify({
      version: 1,
      platform: process.platform,
      ok: violation === undefined,
      rounds,
      networkAttempts,
      runs,
      samples,
      violation: violation ?? null,
      limitations: [
        "Process termination is tested at an exact pre-acquisition barrier; pending AbortSignal cancellation is tested separately.",
        "Lock wait is call-to-callback entry; transaction duration includes callback, commit and lock release. Components separate ACL, state validation, serialization, JSON write and fsync.",
        "No latency threshold is asserted; measured p95/max values are machine-dependent.",
      ],
    }),
  );
}
