import { loadAccountStore } from "../auth/accounts.js";
import { blockingRecord, recentlySuccessful, scopeFor } from "./selection.js";
import { recordKey } from "./scope.js";
import { HealthStore, healthStorePath } from "./store.js";
import type { StoredAccount } from "../auth/accounts.js";

export function healthSummary(
  model: string,
  options: {
    accounts?: readonly StoredAccount[];
    store?: HealthStore;
    now?: number;
  } = {},
) {
  const accounts = options.accounts ?? Object.values(loadAccountStore(true).accounts);
  const state = (options.store ?? new HealthStore(healthStorePath())).snapshot();
  const now = options.now ?? Date.now();
  const summary = {
    model,
    linked: accounts.length,
    known_cooldown: 0,
    unknown: 0,
    recently_successful: 0,
    auth_error: 0,
    in_flight: 0,
    next_reset: undefined as number | undefined,
  };
  for (const account of accounts) {
    const scope = scopeFor(account, model);
    const blocker = blockingRecord(state, scope, now);
    if (blocker) {
      summary.known_cooldown++;
      if (blocker.status === "auth_error") summary.auth_error++;
      summary.next_reset = Math.min(summary.next_reset ?? Infinity, blocker.cooldownUntil);
    } else if (recentlySuccessful(state.records[recordKey(scope)], now)) {
      summary.recently_successful++;
    } else {
      summary.unknown++;
    }
    if (
      Object.values(state.reservations).some(
        (lease) => lease.accountId === scope.accountId && lease.until > now,
      )
    )
      summary.in_flight++;
  }
  return summary;
}

export function formatHealthSummary(summary: ReturnType<typeof healthSummary>): string {
  return Object.entries(summary)
    .map(
      ([key, value]) =>
        `${key}=${key === "next_reset" ? (typeof value === "number" ? new Date(value).toISOString() : "unknown") : value}`,
    )
    .join("\n");
}
