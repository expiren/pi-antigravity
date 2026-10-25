/// <reference types="node" />
import assert from "node:assert/strict";
import { readSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { healthScope, recordKey } from "../src/health/scope.js";
import { HealthPoolError, selectAccount } from "../src/health/selection.js";
import { healthAclMetrics } from "../src/health/private-file.js";
import { HealthStore, healthStoreMetrics } from "../src/health/store.js";
import type { HealthState } from "../src/health/types.js";

// Only the controller starts this script. No account or credential files are used.
const [path, identity, mode = "normal"] = process.argv.slice(2);
assert(path && identity && process.env.PI_CODING_AGENT_DIR);
globalThis.fetch = async () => {
  throw new Error("Lock stress workers must not use the network.");
};
const now = Date.UTC(2026, 9, 24, 12);
const store = new HealthStore(path, { now: () => now });
const emit = (value: object): void => {
  writeSync(1, `${JSON.stringify(value)}\n`);
};
const marker = healthScope(`simulated-marker-${identity}`, "stress-project", "stress-marker");
const markerKey = recordKey(marker);
const accounts = Array.from({ length: 302 }, (_, index) => ({
  accountId: `simulated-account-${index}`,
  access: `fake-access-${index}`,
  refresh: `fake-refresh-${index}`,
  projectId: "stress-project",
  expires: now + 86_400_000,
  addedAt: index + 1,
  lastUsedAt: 0,
}));
function increment(state: HealthState): void {
  state.records[markerKey] = {
    ...marker,
    status: "unknown",
    reason: "unknown",
    observedAt: now,
    cooldownUntil: 0,
    attemptOrder: (state.records[markerKey]?.attemptOrder ?? 0) + 1,
  };
}

if (mode === "hold") {
  // This process uses raw stdin exclusively: no readline prefetch can consume the
  // release byte while the synchronous transaction owns the lock.
  emit({ event: "ready", markerKey });
  const byte = Buffer.alloc(1);
  assert.equal(readSync(0, byte, 0, 1, null), 1);
  store.update((state) => {
    increment(state);
    emit({ event: "locked" });
    assert.equal(readSync(0, byte, 0, 1, null), 1);
    if (byte[0] === 88) process.exit(17); // Deliberate crash before commit/release.
  });
  emit({ event: "released" });
} else {
  let active = false;
  let controller: AbortController | undefined;
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (line === "stop") {
      assert(!active, "Cannot stop a transaction before its result.");
      input.close();
      process.stdin.destroy();
      return;
    }
    const command = JSON.parse(line) as {
      id: string;
      operation:
        "select" | "failure" | "success" | "release" | "increment" | "probe" | "stage" | "abort";
      reservationId?: string;
    };
    if (command.operation === "abort") {
      assert(active && controller, "Abort requires a pending transaction.");
      controller.abort();
      emit({ event: "aborted", id: command.id });
      return;
    }
    assert(!active, "Controller sent overlapping worker transactions.");
    active = true;
    const activeSignal = new AbortController();
    controller = activeSignal;
    const started = performance.now();
    const before = {
      ...healthStoreMetrics,
      aclCalls: healthAclMetrics.calls,
      aclMs: healthAclMetrics.elapsedMs,
    };
    const components = () =>
      Object.fromEntries([
        ...Object.entries(healthStoreMetrics).map(([name, value]) => [
          name,
          value - before[name as keyof typeof healthStoreMetrics],
        ]),
        ["aclCalls", healthAclMetrics.calls - before.aclCalls],
        ["aclMs", healthAclMetrics.elapsedMs - before.aclMs],
      ]);
    let entered: number | undefined;
    emit({ event: "started", id: command.id });
    // A cancellable pre-acquisition barrier. Terminating here cannot race lock
    // creation/recovery or depend on the OS scheduling a kill before a retry.
    if (command.operation === "stage") return;
    void store
      .updateWhenAvailable((state) => {
        entered = performance.now();
        if (command.operation === "select") {
          const selected = selectAccount({
            state,
            accounts,
            model: "stress-model",
            now,
            reservationId: command.reservationId!,
            excluded: new Set(),
            excludedTokens: new Set(),
          });
          if (selected instanceof HealthPoolError) throw selected;
          return selected.scope.accountId;
        }
        if (command.operation === "failure" || command.operation === "success") {
          const lease = state.reservations[command.reservationId!];
          assert(lease, "Selected reservation was lost.");
          const key = recordKey(lease);
          const previous = state.records[key];
          assert(previous);
          state.records[key] =
            command.operation === "failure"
              ? {
                  ...previous,
                  status: "hard_quota",
                  reason: "quota_exhausted",
                  observedAt: now,
                  cooldownUntil: now + 86_400_000,
                  responseStatus: 429,
                }
              : { ...previous, lastSuccessAt: now };
          delete state.reservations[command.reservationId!];
        } else if (command.operation === "release") {
          assert(state.reservations[command.reservationId!]);
          delete state.reservations[command.reservationId!];
        } else {
          increment(state);
        }
        return markerKey;
      }, activeSignal.signal)
      .then(
        (value) => {
          const ended = performance.now();
          emit({
            event: "result",
            id: command.id,
            ok: true,
            value,
            lockWaitMs: entered! - started,
            transactionMs: ended - entered!,
            totalMs: ended - started,
            components: components(),
          });
        },
        (error: unknown) => {
          emit({
            event: "result",
            id: command.id,
            ok: false,
            code: (error as { code?: string }).code ?? "unexpected",
            error: error instanceof Error ? error.message : String(error),
            lockWaitMs: entered === undefined ? performance.now() - started : entered - started,
            transactionMs: entered === undefined ? null : performance.now() - entered,
            totalMs: performance.now() - started,
            components: components(),
          });
        },
      )
      .finally(() => {
        active = false;
        controller = undefined;
      });
  });
  emit({ event: "ready", markerKey });
}
