import { isHardQuotaWall } from "../runtime/retry.js";
import type { HealthFailure } from "./types.js";

const MAX_HINT_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_DATE = 8_640_000_000_000_000;
const GUARD_MS = 1000;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedDuration(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 && value <= MAX_HINT_MS
    ? Math.ceil(value)
    : undefined;
}

/** Strict Google protobuf Duration; no guessed numeric units. */
export function parseRetryDelay(value: unknown): number | undefined {
  if (typeof value === "string") {
    const match = /^(\d+)(?:\.(\d{1,9}))?s$/i.exec(value.trim());
    if (!match) return undefined;
    return boundedDuration(Number(match[1]) * 1000 + Number(`0.${match[2] || "0"}`) * 1000);
  }
  const parts = object(value);
  if (
    !parts ||
    (parts.seconds === undefined && parts.nanos === undefined) ||
    !/^\d+$/.test(String(parts.seconds ?? 0))
  )
    return undefined;
  const seconds = Number(parts.seconds ?? 0);
  const nanos = parts.nanos ?? 0;
  if (!Number.isSafeInteger(seconds) || !Number.isInteger(nanos) || Number(nanos) < 0) {
    return undefined;
  }
  if (Number(nanos) >= 1_000_000_000) return undefined;
  return boundedDuration(seconds * 1000 + Number(nanos) / 1_000_000);
}

/** Only explicit reset/wait prefixes authorize human-readable duration parsing. */
export function parseResetDuration(text: string): number | undefined {
  const prefix = /\b(?:resets?\s+in|please\s+wait)\s+/i.exec(text);
  if (!prefix) return undefined;
  const tail = text.slice(prefix.index + prefix[0].length);
  const unit =
    /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/iy;
  let at = 0;
  let total = 0;
  let count = 0;
  const seen = new Set<string>();
  while (at < tail.length) {
    const separator = /^(?:\s*(?:,\s*|and\s+)?)/i.exec(tail.slice(at))![0];
    at += separator.length;
    unit.lastIndex = at;
    const match = unit.exec(tail);
    if (!match) break;
    const kind = match[2][0].toLowerCase();
    if (seen.has(kind)) return undefined;
    seen.add(kind);
    const multiplier =
      kind === "d" ? 86_400_000 : kind === "h" ? 3_600_000 : kind === "m" ? 60_000 : 1000;
    total += Number(match[1]) * multiplier;
    at = unit.lastIndex;
    count++;
  }
  // A malformed continuation must not turn "1h -2m" or "1h 999..." into a hint.
  const remainder = tail.slice(at);
  if (!count || /^[\s,]*(?:[-+\d]|\.\d|and\b)/i.test(remainder)) return undefined;
  return boundedDuration(total);
}

function absoluteHint(value: unknown, now: number): number | undefined {
  if (typeof value !== "string") return undefined;
  // Avoid Date.parse's permissive interpretation of small numbers as calendar dates.
  const text = value.trim();
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(text) &&
    !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/i.test(
      text,
    )
  ) {
    return undefined;
  }
  const parsed = Date.parse(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/i.exec(text);
  if (iso) {
    const [, year, month, day, hour, minute, second] = iso.map(Number);
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
      hour > 23 ||
      minute > 59 ||
      second > 59
    )
      return undefined;
  } else if (
    Number.isFinite(parsed) &&
    new Date(parsed).toUTCString().toLowerCase() !== text.toLowerCase()
  )
    return undefined;
  const delta = boundedDuration(parsed - now);
  return delta === undefined ? undefined : now + delta;
}

export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const delay = boundedDuration(Number(trimmed) * 1000);
    return delay === undefined ? undefined : now + delay;
  }
  return absoluteHint(trimmed, now);
}

function messageReset(text: string, now: number): number | undefined {
  const duration = parseResetDuration(text);
  if (duration !== undefined) return now + duration;
  const match = /\b(?:resets?\s+at|reset\s+time\s*[:=])\s*([^\n]+)$/i.exec(text);
  return match ? absoluteHint(match[1].trim(), now) : undefined;
}

export function classifyHealthFailure(input: {
  status?: number;
  body?: string;
  headers?: Headers;
  timeout?: boolean;
  projectId?: string;
  now: number;
}): HealthFailure {
  const { status, timeout } = input;
  const now =
    Number.isSafeInteger(input.now) &&
    input.now >= 0 &&
    input.now < MAX_DATE - MAX_HINT_MS - GUARD_MS
      ? input.now
      : Date.now();
  const body = (input.body || "").slice(0, 256 * 1024);
  let root: Record<string, unknown> | undefined;
  try {
    const parsed = object(JSON.parse(body));
    root = object(parsed?.error) || parsed;
  } catch {
    // Plain provider messages are valid inputs, but never persisted.
  }
  const details = Array.isArray(root?.details) ? root.details : [];
  const hints: number[] = [];
  const retryAfter = parseRetryAfter(input.headers?.get("retry-after"), now);
  if (retryAfter !== undefined) hints.push(retryAfter);
  let projectWide = false;
  let global = false;
  for (const raw of details) {
    const detail = object(raw);
    if (!detail) continue;
    const type = String(detail["@type"] || "");
    if (type === "type.googleapis.com/google.rpc.RetryInfo") {
      const delay = parseRetryDelay(detail.retryDelay);
      if (delay !== undefined) hints.push(now + delay);
    }
    if (
      type === "type.googleapis.com/google.rpc.QuotaFailure" &&
      Array.isArray(detail.violations)
    ) {
      for (const violation of detail.violations) {
        const subject = object(violation)?.subject;
        if (
          typeof subject === "string" &&
          input.projectId?.trim() &&
          (subject === `projects/${input.projectId.trim()}` ||
            subject === `project:${input.projectId.trim()}`)
        ) {
          projectWide = true;
        }
      }
    }
    if (type === "type.googleapis.com/google.rpc.ErrorInfo") {
      // These explicit reasons describe a provider/endpoint constraint, not an account quota.
      if (
        ["MODEL_UNAVAILABLE", "ENDPOINT_UNAVAILABLE", "SERVICE_UNAVAILABLE"].includes(
          String(detail.reason),
        )
      ) {
        global = true;
      }
      const metadata = object(detail.metadata);
      for (const key of ["quotaResetTime", "resetTime", "quota_reset_time", "reset_time"]) {
        const reset = absoluteHint(metadata?.[key], now);
        if (reset !== undefined) hints.push(reset);
      }
    }
  }
  const message = typeof root?.message === "string" ? root.message : root ? "" : body;
  const reset = messageReset(message, now);
  if (reset !== undefined) hints.push(reset);
  const hard =
    status === 429 &&
    (isHardQuotaWall(message) ||
      (/\bquota\s+reached\b/i.test(message) &&
        !/\b(?:per\s*(?:minute|second|min|sec)|rpm|tpm|qps|rate.?limit)\b/i.test(message)));
  let result: HealthFailure;
  if (status === 401 || status === 403) {
    result = {
      status: "auth_error",
      reason: status === 401 ? "authentication_required" : "authorization_denied",
      cooldownUntil: now + 300_000,
      projectWide: false,
      global: false,
    };
  } else if (status === 404 || (status !== undefined && status >= 500 && status <= 599)) {
    result = {
      status: "temporary_unavailable",
      reason: status === 404 ? "endpoint_unavailable" : "provider_unavailable",
      cooldownUntil: now + 30_000,
      projectWide: false,
      global: true,
    };
  } else if (timeout) {
    result = {
      status: "temporary_unavailable",
      reason: "request_timeout",
      cooldownUntil: now + 30_000,
      projectWide: false,
      global: false,
    };
  } else if (global) {
    result = {
      status: "temporary_unavailable",
      reason: "endpoint_unavailable",
      cooldownUntil: now + 30_000,
      projectWide: false,
      global: true,
    };
  } else {
    result = {
      status: status === 429 ? (hard ? "hard_quota" : "transient_429") : "temporary_unavailable",
      reason: status === 429 ? (hard ? "quota_exhausted" : "rate_limited") : "provider_unavailable",
      cooldownUntil: now + (hard ? 900_000 : 60_000),
      projectWide: status === 429 && projectWide && !global,
      global,
    };
  }
  if (hints.length && result.status !== "auth_error" && !timeout) {
    result.retryAfterUntil = Math.max(...hints) + GUARD_MS;
    result.cooldownUntil = result.retryAfterUntil;
  }
  if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) {
    result.responseStatus = status;
  }
  return result;
}
