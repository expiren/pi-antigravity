import { apiKeyFor, type StoredAccount } from "../auth/accounts.js";
import { resolveProjectId } from "../client/client.js";
import { healthScope, recordKey } from "./scope.js";
import type { HealthRecord, HealthScope, HealthState } from "./types.js";

export const RESERVATION_MS = 30 * 60_000;
export const RECENT_SUCCESS_MS = 24 * 60 * 60_000;

export function scopeFor(account: StoredAccount, model: string): HealthScope {
  return healthScope(
    account.accountId,
    resolveProjectId({ token: "", credentialProjectId: apiKeyFor(account).projectId }),
    model,
  );
}

export function blockingRecord(
  state: HealthState,
  scope: HealthScope,
  now: number,
): HealthRecord | undefined {
  return Object.values(state.records)
    .filter(
      (record) =>
        record.model === scope.model &&
        record.projectId === scope.projectId &&
        (record.accountId === scope.accountId || record.projectWide === true) &&
        record.cooldownUntil > now,
    )
    .sort((a, b) => b.cooldownUntil - a.cooldownUntil)[0];
}

export function recentlySuccessful(record: HealthRecord | undefined, now: number): boolean {
  return (
    record?.status === "unknown" &&
    record.lastSuccessAt !== undefined &&
    record.lastSuccessAt >= record.observedAt &&
    record.lastSuccessAt > now - RECENT_SUCCESS_MS &&
    record.lastSuccessAt <= now
  );
}

export class HealthPoolError extends Error {
  constructor(
    readonly model: string,
    readonly skipReasons: Record<string, number>,
    readonly nextReset?: number,
  ) {
    super(
      `No eligible Antigravity credential for ${model}; ` +
        `skipReasons=${JSON.stringify(skipReasons)}; ` +
        `next_reset=${nextReset === undefined ? "unknown" : new Date(nextReset).toISOString()}. ` +
        "Unknown quota is not available quota. Retry after reset or review /antigravity health.",
    );
    this.name = "HealthPoolError";
  }
}

export type SelectionRequest = {
  state: HealthState;
  accounts: readonly StoredAccount[];
  model: string;
  excluded: ReadonlySet<string>;
  excludedTokens: ReadonlySet<string>;
  reservationId: string;
  now: number;
  activeAccountId?: string;
  preferredAccountId?: string;
};

/** One locked transaction both orders candidates and reserves the selected stable identity. */
export function selectAccount(request: SelectionRequest):
  | {
      account: StoredAccount;
      scope: HealthScope;
      skipReasons: Record<string, number>;
      basis: "unknown" | "recent_success";
    }
  | HealthPoolError {
  const { state, accounts, model, excluded, reservationId, now } = request;
  const skipReasons: Record<string, number> = { cooldown: 0, excluded: 0, reserved: 0 };
  const resets: number[] = [];
  const candidates = accounts
    .map((account) => ({ account, scope: scopeFor(account, model) }))
    .filter(({ account, scope }) => {
      if (excluded.has(scope.accountId) || request.excludedTokens.has(account.access)) {
        skipReasons.excluded++;
        return false;
      }
      const blocker = blockingRecord(state, scope, now);
      if (blocker) {
        skipReasons.cooldown++;
        resets.push(blocker.cooldownUntil);
        return false;
      }
      if (
        Object.values(state.reservations).some(
          (lease) =>
            lease.id !== reservationId && lease.accountId === scope.accountId && lease.until > now,
        )
      ) {
        skipReasons.reserved++;
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (request.preferredAccountId) {
        const preferred =
          Number(b.account.accountId === request.preferredAccountId) -
          Number(a.account.accountId === request.preferredAccountId);
        if (preferred) return preferred;
      }
      const order =
        (state.records[recordKey(a.scope)]?.attemptOrder ?? 0) -
        (state.records[recordKey(b.scope)]?.attemptOrder ?? 0);
      return (
        order ||
        Number(b.account.accountId === request.activeAccountId) -
          Number(a.account.accountId === request.activeAccountId) ||
        a.scope.accountId.localeCompare(b.scope.accountId)
      );
    });
  const chosen = candidates[0];
  if (!chosen)
    return new HealthPoolError(model, skipReasons, resets.length ? Math.min(...resets) : undefined);
  const key = recordKey(chosen.scope);
  const previous = state.records[key];
  const basis = recentlySuccessful(previous, now) ? "recent_success" : "unknown";
  state.records[key] = {
    ...previous,
    ...chosen.scope,
    status: "unknown",
    reason: "unknown",
    observedAt: previous?.cooldownUntil ? now : (previous?.observedAt ?? now),
    cooldownUntil: 0,
    lastAttemptAt: now,
    attemptOrder: ++state.sequence,
  };
  state.reservations[reservationId] = {
    id: reservationId,
    ...chosen.scope,
    until: now + RESERVATION_MS,
    ownerPid: process.pid,
  };
  return { ...chosen, skipReasons, basis };
}
