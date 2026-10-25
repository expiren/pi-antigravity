import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "bun:test";

if (process.platform === "win32") {
  const root = fs.mkdtempSync(join(tmpdir(), "pi-antigravity-gate-open-"));
  const path = join(root, "health.json");
  const gate = `${path}.lock-recovery`;
  const configured = process.env.ANTIGRAVITY_HEALTH_LOCK_WAIT_MS;
  const originalOpenSync = fs.openSync;
  let failure: "once" | "always" | "access" | "deadline" = "once";
  let attempts = 0;
  let deadlineClock = 0;
  mock.module("node:fs", () => ({
    ...fs,
    openSync(file: fs.PathLike, flags: string | number, mode?: fs.Mode) {
      if (String(file) === gate && flags === "wx") {
        attempts++;
        if (failure === "deadline" && attempts === 1) {
          queueMicrotask(() => {
            deadlineClock += 200;
          });
        }
        if (failure === "always" || failure === "access" || attempts === 1) {
          throw Object.assign(new Error("synthetic exclusive-gate failure"), {
            code: failure === "access" ? "EACCES" : "EPERM",
          });
        }
      }
      return originalOpenSync(file, flags, mode);
    },
  }));
  try {
    const { HealthStore, HealthStoreError } = await import("../src/health/store.js");
    const store = new HealthStore(path);
    let callbacks = 0;
    assert.equal(await store.updateWhenAvailable(() => ++callbacks), 1);
    assert.equal(attempts, 2);
    assert.equal(callbacks, 1);
    assert.equal(fs.existsSync(gate), false);

    failure = "always";
    attempts = 0;
    process.env.ANTIGRAVITY_HEALTH_LOCK_WAIT_MS = "0";
    await assert.rejects(
      store.updateWhenAvailable(() => ++callbacks),
      (error: unknown) => error instanceof HealthStoreError && error.code === "busy",
    );
    assert.equal(attempts, 1);
    assert.equal(callbacks, 1);

    failure = "deadline";
    attempts = 0;
    process.env.ANTIGRAVITY_HEALTH_LOCK_WAIT_MS = "100";
    const originalNow = performance.now;
    deadlineClock = originalNow.call(performance);
    performance.now = () => deadlineClock;
    try {
      await assert.rejects(
        store.updateWhenAvailable(() => ++callbacks),
        (error: unknown) => error instanceof HealthStoreError && error.code === "busy",
      );
    } finally {
      performance.now = originalNow;
    }
    assert.equal(attempts, 1);
    assert.equal(callbacks, 1);

    failure = "access";
    attempts = 0;
    await assert.rejects(
      store.updateWhenAvailable(() => ++callbacks),
      (error: unknown) => error instanceof HealthStoreError && error.code === "io",
    );
    assert.equal(attempts, 1);
    assert.equal(store.snapshot().sequence, 1);
    console.log(
      "Windows exclusive-gate EPERM retries safely; persistent and unrelated errors fail closed.",
    );
  } finally {
    mock.restore();
    if (configured === undefined) delete process.env.ANTIGRAVITY_HEALTH_LOCK_WAIT_MS;
    else process.env.ANTIGRAVITY_HEALTH_LOCK_WAIT_MS = configured;
    fs.rmSync(root, { recursive: true, force: true });
  }
} else {
  console.log("Windows exclusive-gate EPERM regression n/a.");
}
