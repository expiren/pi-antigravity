import { randomUUID } from "node:crypto";
import fs, { closeSync, unlinkSync, writeFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HealthStoreError } from "./errors.js";
import {
  assertPrivateFile,
  createPrivateFile,
  ensureHealthDirectory,
  isMissing,
  readPrivateFile,
  rejectSymlinkParents,
} from "./private-file.js";
import { recordKey } from "./scope.js";
import { HEALTH_REASONS, type HealthRecord, type HealthState } from "./types.js";

export { HealthStoreError } from "./errors.js";

export const HEALTH_MAX_BYTES = 8 * 1024 * 1024;
export const HEALTH_MAX_RECORDS = 10_000;
export const HEALTH_MAX_RESERVATIONS = 4096;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const STALE_MS = 90 * 24 * 60 * 60 * 1000;
const LOCK_MS = 30_000;
const pendingTransactions = new Map<string, Promise<void>>();
const metricsEnabled = process.env.ANTIGRAVITY_HEALTH_METRICS === "1";
/** Opt-in timings for simulated stress tests; no paths or state values are recorded. */
export const healthStoreMetrics = {
  transactions: 0,
  acquisitionMs: 0,
  holdMs: 0,
  stateReadValidationMs: 0,
  callbackMs: 0,
  stateMutationValidationMs: 0,
  serializationMs: 0,
  jsonWriteMs: 0,
  fsyncMs: 0,
};

export function healthLockWaitMs(): number {
  const configured = process.env.ANTIGRAVITY_HEALTH_LOCK_WAIT_MS;
  const waitMs = configured === undefined ? 60_000 : Number(configured);
  if (
    (configured !== undefined && !/^(0|[1-9]\d*)$/.test(configured)) ||
    !Number.isSafeInteger(waitMs) ||
    waitMs < 0 ||
    waitMs > 60_000
  ) {
    throw new HealthStoreError(
      "invalid",
      "ANTIGRAVITY_HEALTH_LOCK_WAIT_MS must be an integer from 0 to 60000.",
    );
  }
  return waitMs;
}

function invalid(): never {
  throw new HealthStoreError(
    "invalid",
    "Health state is corrupt or unsupported. Inspect or restore its private backup before retrying.",
  );
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_TIMESTAMP;
}

function counter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function scope(value: Record<string, unknown>): void {
  if (
    typeof value.accountId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.accountId) ||
    typeof value.projectId !== "string" ||
    !/^[A-Za-z0-9._:/-]{0,256}$/.test(value.projectId) ||
    typeof value.model !== "string" ||
    !/^[a-z0-9._:/-]{1,256}$/.test(value.model)
  ) {
    invalid();
  }
}

const STATUS_REASONS: Record<string, readonly string[]> = {
  hard_quota: ["quota_exhausted"],
  transient_429: ["rate_limited"],
  auth_error: ["authentication_required", "authorization_denied"],
  temporary_unavailable: ["request_timeout", "endpoint_unavailable", "provider_unavailable"],
  unknown: ["unknown"],
};

function validate(value: unknown, enforceLimits = true): HealthState {
  const state = object(value);
  keys(state, ["version", "updatedAt", "sequence", "records", "reservations"]);
  if (state.version !== 1 || !timestamp(state.updatedAt) || !counter(state.sequence)) invalid();
  const records = object(state.records);
  const reservations = object(state.reservations);
  if (
    enforceLimits &&
    (Object.keys(records).length > HEALTH_MAX_RECORDS ||
      Object.keys(reservations).length > HEALTH_MAX_RESERVATIONS)
  ) {
    throw new HealthStoreError(
      "capacity",
      "Health state has too many active records; retain live cooldowns and inspect stale data locally.",
    );
  }
  for (const [key, raw] of Object.entries(records)) {
    const record = object(raw);
    keys(record, [
      "accountId",
      "projectId",
      "model",
      "status",
      "reason",
      "observedAt",
      "cooldownUntil",
      "retryAfterUntil",
      "responseStatus",
      "lastAttemptAt",
      "lastSuccessAt",
      "attemptOrder",
      "projectWide",
    ]);
    scope(record);
    if (key !== recordKey(record as unknown as HealthRecord)) invalid();
    if (
      typeof record.status !== "string" ||
      typeof record.reason !== "string" ||
      !HEALTH_REASONS.includes(record.reason as (typeof HEALTH_REASONS)[number]) ||
      !Object.hasOwn(STATUS_REASONS, record.status) ||
      !STATUS_REASONS[record.status].includes(record.reason) ||
      !timestamp(record.observedAt) ||
      !timestamp(record.cooldownUntil)
    ) {
      invalid();
    }
    for (const field of ["retryAfterUntil", "lastAttemptAt", "lastSuccessAt"]) {
      if (record[field] !== undefined && !timestamp(record[field])) invalid();
    }
    if (record.attemptOrder !== undefined && !counter(record.attemptOrder)) invalid();
    if (record.projectWide !== undefined && typeof record.projectWide !== "boolean") invalid();
    if (
      record.responseStatus !== undefined &&
      (!Number.isInteger(record.responseStatus) ||
        Number(record.responseStatus) < 100 ||
        Number(record.responseStatus) > 599)
    ) {
      invalid();
    }
  }
  for (const [key, raw] of Object.entries(reservations)) {
    const reservation = object(raw);
    keys(reservation, ["id", "accountId", "projectId", "model", "until", "ownerPid"]);
    scope(reservation);
    if (
      typeof reservation.id !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(reservation.id) ||
      key !== reservation.id ||
      !timestamp(reservation.until) ||
      !Number.isInteger(reservation.ownerPid) ||
      Number(reservation.ownerPid) <= 0 ||
      Number(reservation.ownerPid) > 2_147_483_647
    ) {
      invalid();
    }
  }
  return state as unknown as HealthState;
}

function prune(state: HealthState, now: number): void {
  for (const [key, reservation] of Object.entries(state.reservations)) {
    if (reservation.until <= now) delete state.reservations[key];
  }
  for (const [key, record] of Object.entries(state.records)) {
    if (
      record.cooldownUntil <= now &&
      (record.retryAfterUntil ?? 0) <= now &&
      Math.max(record.observedAt, record.lastAttemptAt ?? 0, record.lastSuccessAt ?? 0) <
        now - STALE_MS
    ) {
      delete state.records[key];
    }
  }
}

interface LockOwner {
  version: 1;
  pid: number;
  id: string;
  createdAt: number;
  expiresAt: number;
}

function readOwner(path: string): LockOwner {
  let value: Record<string, unknown>;
  try {
    value = object(JSON.parse(readPrivateFile(path, 1024)));
  } catch (error) {
    if (isMissing(error)) throw error;
    // Windows ACL verification runs in a subprocess; the previous owner can
    // unlink its lock during that check. Under the acquisition gate, a
    // missing lock is safe to treat as released, never as a stale owner.
    try {
      fs.lstatSync(path);
    } catch (after) {
      if (isMissing(after)) throw after;
    }
    throw new HealthStoreError(
      "unsafe",
      "Health lock owner is unreadable. Stop all users of this store before removing orphan lock files.",
    );
  }
  if (
    value.version !== 1 ||
    !Number.isInteger(value.pid) ||
    Number(value.pid) <= 0 ||
    Number(value.pid) > 2_147_483_647 ||
    typeof value.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.expiresAt) ||
    Number(value.expiresAt) < Number(value.createdAt)
  ) {
    throw new HealthStoreError(
      "unsafe",
      "Health lock ownership is invalid. Stop all users of this store before removing orphan lock files.",
    );
  }
  return value as unknown as LockOwner;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    // Access denied and unknown OS failures do not prove that an owner died.
    return true;
  }
}

function busy(): never {
  throw new HealthStoreError(
    "busy",
    "Health state is busy in another process; retry this request after that process finishes.",
  );
}

function safeError(error: unknown, stage?: string): HealthStoreError {
  if (error instanceof HealthStoreError) return error;
  const os = error as NodeJS.ErrnoException;
  const detail =
    typeof os?.code === "string" && /^[A-Z0-9_]+$/.test(os.code) ? ` (OS ${os.code})` : "";
  return new HealthStoreError(
    "io",
    `Health state could not be safely read or written${stage ? ` during ${stage}` : ""}${detail}. Check private-file access and free disk space.`,
  );
}

export function healthStorePath(): string {
  return resolve(
    process.env.PI_CODING_AGENT_DIR || getAgentDir(),
    "antigravity-account-health.json",
  );
}

export class HealthStore {
  readonly path: string;
  private readonly now: () => number;

  constructor(path: string, options?: { now?: () => number }) {
    this.path = resolve(path);
    this.now = options?.now || (() => Date.now());
  }

  snapshot(): HealthState {
    try {
      rejectSymlinkParents(this.path);
      let text: string;
      try {
        text = readPrivateFile(this.path, HEALTH_MAX_BYTES);
      } catch (error) {
        if (!isMissing(error)) throw error;
        return { version: 1, updatedAt: 0, sequence: 0, records: {}, reservations: {} };
      }
      try {
        return validate(JSON.parse(text));
      } catch (error) {
        if (error instanceof HealthStoreError) throw error;
        return invalid();
      }
    } catch (error) {
      throw safeError(error);
    }
  }

  update<T>(fn: (state: HealthState) => T): T {
    let release: (() => void) | undefined;
    let temporary: string | undefined;
    const started = metricsEnabled ? performance.now() : 0;
    let acquiredAt = 0;
    try {
      const now = this.now();
      if (!timestamp(now) || now > MAX_TIMESTAMP - LOCK_MS) invalid();
      ensureHealthDirectory(this.path);
      release = this.acquire(now);
      if (metricsEnabled) {
        acquiredAt = performance.now();
        healthStoreMetrics.transactions++;
        healthStoreMetrics.acquisitionMs += acquiredAt - started;
      }
      const state = this.snapshot();
      let checkpoint = metricsEnabled ? performance.now() : 0;
      if (metricsEnabled) healthStoreMetrics.stateReadValidationMs += checkpoint - acquiredAt;
      const sequence = state.sequence;
      let result: T;
      try {
        result = fn(state);
        if (result && typeof (result as { then?: unknown }).then === "function") {
          throw new Error();
        }
        if (metricsEnabled) {
          const next = performance.now();
          healthStoreMetrics.callbackMs += next - checkpoint;
          checkpoint = next;
        }
      } catch {
        throw new HealthStoreError(
          "transaction",
          "Health transaction failed. Mutations must be synchronous; the previous state is unchanged.",
        );
      }
      validate(state, false);
      if (state.sequence < sequence || sequence === Number.MAX_SAFE_INTEGER) invalid();
      state.sequence = Math.max(state.sequence, sequence + 1);
      state.updatedAt = now;
      prune(state, now);
      validate(state);
      if (metricsEnabled) {
        const next = performance.now();
        healthStoreMetrics.stateMutationValidationMs += next - checkpoint;
        checkpoint = next;
      }
      const text = `${JSON.stringify(state)}\n`;
      const bytes = Buffer.byteLength(text, "utf8");
      if (metricsEnabled) {
        healthStoreMetrics.serializationMs += performance.now() - checkpoint;
      }
      if (bytes > HEALTH_MAX_BYTES) {
        throw new HealthStoreError(
          "capacity",
          "Health state is full; live cooldowns were retained and no update was committed.",
        );
      }
      temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      const fd = createPrivateFile(temporary);
      try {
        const writeStarted = metricsEnabled ? performance.now() : 0;
        writeFileSync(fd, text, "utf8");
        const fsyncStarted = metricsEnabled ? performance.now() : 0;
        fs.fsyncSync(fd);
        if (metricsEnabled) {
          healthStoreMetrics.jsonWriteMs += fsyncStarted - writeStarted;
          healthStoreMetrics.fsyncMs += performance.now() - fsyncStarted;
        }
      } finally {
        closeSync(fd);
      }
      // Recheck the destination before replacing it; never follow a destination link.
      try {
        assertPrivateFile(this.path);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      fs.renameSync(temporary, this.path);
      temporary = undefined;
      return result;
    } catch (error) {
      throw safeError(error);
    } finally {
      if (temporary) {
        try {
          unlinkSync(temporary);
        } catch {
          // A failed pre-commit write can leave only a private, uniquely named temporary file.
        }
      }
      if (release) {
        try {
          release();
        } finally {
          if (metricsEnabled) healthStoreMetrics.holdMs += performance.now() - acquiredAt;
        }
      }
    }
  }

  async updateWhenAvailable<T>(
    fn: (state: HealthState) => T,
    signal?: AbortSignal,
    latestStart?: number,
  ): Promise<T> {
    const waitMs = healthLockWaitMs();
    const started = performance.now();
    const deadline = Math.min(started + waitMs, latestStart ?? Infinity);
    const allowedMs = Math.max(0, Math.round(deadline - started));
    const key = process.platform === "win32" ? this.path.toLowerCase() : this.path;
    const previous = pendingTransactions.get(key);
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const current = (previous ?? Promise.resolve()).then(() => completed);
    pendingTransactions.set(key, current);
    let waitingForPrevious = !!previous;
    let onAbort: (() => void) | undefined;
    const abortError = () => new Error("Request was aborted");
    const exhausted = () =>
      new HealthStoreError(
        "busy",
        `ANTIGRAVITY_HEALTH_BUSY: Health state remained busy for ${allowedMs} ms; check the lock owner and gate-directory ACL before retrying.`,
      );
    try {
      if (signal?.aborted) throw abortError();
      if (latestStart !== undefined && performance.now() >= latestStart && waitMs !== 0)
        throw exhausted();
      if (previous) {
        const timeout = new AbortController();
        try {
          const aborted = signal
            ? new Promise<never>((_, reject) => {
                onAbort = () => reject(abortError());
                signal.addEventListener("abort", onAbort, { once: true });
              })
            : undefined;
          const outcome = await Promise.race([
            previous.then(() => "ready" as const),
            delay(Math.max(0, deadline - performance.now()), "timeout" as const, {
              signal: timeout.signal,
            }),
            ...(aborted ? [aborted] : []),
          ]);
          if (outcome === "ready") waitingForPrevious = false;
          if (outcome === "timeout" || performance.now() >= deadline) throw exhausted();
        } finally {
          timeout.abort();
        }
      }
      let firstAttempt = true;
      for (;;) {
        if (signal?.aborted) throw abortError();
        if ((!firstAttempt || waitMs !== 0) && performance.now() >= deadline) throw exhausted();
        firstAttempt = false;
        try {
          return this.update(fn);
        } catch (error) {
          const remaining = deadline - performance.now();
          if (!(error instanceof HealthStoreError) || error.code !== "busy") throw error;
          if (remaining <= 0) throw exhausted();
          await delay(Math.min(25 + Math.random() * 50, remaining), undefined, { signal });
        }
      }
    } finally {
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      finish();
      if (waitingForPrevious) {
        void current.then(() => {
          if (pendingTransactions.get(key) === current) pendingTransactions.delete(key);
        });
      } else if (pendingTransactions.get(key) === current) {
        pendingTransactions.delete(key);
      }
    }
  }

  private acquire(now: number): () => void {
    const lock = `${this.path}.lock`;
    const gate = `${this.path}.lock-recovery`;
    let gateFd: number;
    try {
      gateFd = createPrivateFile(gate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows can report EPERM while another process removes this exclusive gate.
      if (code === "EEXIST" || (process.platform === "win32" && code === "EPERM")) {
        throw new HealthStoreError(
          "busy",
          "Health lock acquisition or recovery is busy. If it persists, check the gate-directory ACL and stop all store users before removing an orphan .lock-recovery file.",
        );
      }
      throw safeError(error, "lock acquisition gate creation");
    }
    const owner: LockOwner = {
      version: 1,
      pid: process.pid,
      id: randomUUID(),
      createdAt: now,
      expiresAt: now + LOCK_MS,
    };
    let created = false;
    try {
      // Every acquisition/recovery uses this gate. Without it, two stale-lock
      // observers can unlink a newly acquired lock between an identity check and unlink.
      try {
        const previous = readOwner(lock);
        if (alive(previous.pid)) busy(); // Expiry never authorizes stealing from a live owner.
        unlinkSync(lock);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const fd = createPrivateFile(lock);
      created = true;
      try {
        writeFileSync(fd, JSON.stringify(owner), "utf8");
        fs.fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (created) unlinkSync(lock);
      throw error;
    } finally {
      closeSync(gateFd);
      // Never automatically reclaim the recovery gate: a crashed reaper is
      // ambiguous without filesystem compare-and-swap. Fail closed with guidance.
      unlinkSync(gate);
    }
    return () => {
      try {
        const current = readOwner(lock);
        if (current.id !== owner.id || current.pid !== process.pid) {
          throw new HealthStoreError(
            "unsafe",
            "Health lock ownership changed; stop competing writers.",
          );
        }
        unlinkSync(lock);
      } catch (error) {
        throw safeError(error);
      }
    };
  }
}
