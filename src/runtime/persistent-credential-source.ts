import { randomUUID } from "node:crypto";
import { getAccountApiKey, loadAccountStore, syncCurrentAuth } from "../auth/accounts.js";
import { setHealthSelection, type HealthSelection } from "../diagnostics/diagnostics.js";
import { classifyHealthFailure } from "../health/classification.js";
import { healthScope, recordKey } from "../health/scope.js";
import { HealthPoolError, selectAccount } from "../health/selection.js";
import { HealthStore, healthStorePath } from "../health/store.js";
import type { HealthScope } from "../health/types.js";
import type { AntigravityApiKey, CredentialFailure, CredentialSource } from "../types/types.js";

/** Per-request state, never shared by concurrent streams using the default source. */
export class PersistentCredentialSource implements CredentialSource {
  private readonly reservationId = randomUUID();
  private readonly triedIds = new Set<string>();
  private scope?: HealthScope;
  private accountId?: string;
  private creds?: AntigravityApiKey;
  private selection?: HealthSelection;

  constructor(
    private model: string,
    private readonly store = new HealthStore(healthStorePath()),
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async select(
    excludedTokens: ReadonlySet<string>,
    preferredAccountId?: string,
  ): Promise<AntigravityApiKey> {
    let accounts = loadAccountStore(true);
    if (!Object.keys(accounts.accounts).length) {
      // Import the legacy auth-only case once; health updates never activate an account.
      syncCurrentAuth();
      accounts = loadAccountStore(true);
    }
    const chosen = this.store.update((state) =>
      selectAccount({
        state,
        accounts: Object.values(accounts.accounts),
        activeAccountId: accounts.activeAccountId,
        model: this.model,
        excluded: new Set(
          [...this.triedIds].filter((id) => id !== this.scope?.accountId || !preferredAccountId),
        ),
        excludedTokens,
        reservationId: this.reservationId,
        now: this.now(),
        preferredAccountId,
      }),
    );
    if (chosen instanceof HealthPoolError) {
      setHealthSelection({
        selectedAccount: "none",
        runtimeModel: this.model,
        rotationCount: this.selection?.rotationCount ?? 0,
        skipReasons: chosen.skipReasons,
        basis: "unknown",
        lastFailureClass: this.selection?.lastFailureClass,
      });
      throw chosen;
    }
    const changedIdentity =
      this.scope !== undefined && this.scope.accountId !== chosen.scope.accountId;
    this.scope = chosen.scope;
    this.accountId = chosen.account.accountId;
    this.triedIds.add(chosen.scope.accountId);
    this.selection = {
      selectedAccount: chosen.scope.accountId,
      runtimeModel: chosen.scope.model,
      rotationCount: (this.selection?.rotationCount ?? 0) + Number(changedIdentity),
      skipReasons: chosen.skipReasons,
      basis: chosen.basis,
      lastFailureClass: this.selection?.lastFailureClass,
    };
    setHealthSelection(this.selection);
    this.creds = await getAccountApiKey(chosen.account.accountId);
    return this.creds;
  }

  async current(): Promise<AntigravityApiKey> {
    return this.creds ?? this.select(new Set());
  }

  identity(): string | undefined {
    return this.scope?.accountId;
  }

  async rotate(excluded: ReadonlySet<string>): Promise<AntigravityApiKey> {
    return this.select(excluded);
  }

  async prepare(model: string, projectId: string): Promise<AntigravityApiKey> {
    if (!this.creds || !this.scope || !this.accountId) return this.current();
    const nextScope = healthScope(this.accountId, projectId, model);
    if (recordKey(nextScope) === recordKey(this.scope)) return this.creds;
    this.model = model;
    return this.select(new Set(), this.accountId);
  }

  async failed(observation: CredentialFailure): Promise<boolean> {
    if (!this.scope || !this.accountId) return false;
    const failure = classifyHealthFailure({ ...observation, now: this.now() });
    if (this.selection) {
      this.selection.lastFailureClass = failure.status;
      setHealthSelection(this.selection);
    }
    if (failure.global) return false;
    const scope = healthScope(this.accountId, observation.projectId, observation.runtimeModel);
    this.store.update((state) => {
      const key = recordKey(scope);
      const previous = state.records[key];
      const keepPrevious = previous && previous.cooldownUntil > failure.cooldownUntil;
      state.records[key] = {
        ...previous,
        ...scope,
        status: keepPrevious ? previous.status : failure.status,
        reason: keepPrevious ? previous.reason : failure.reason,
        cooldownUntil: keepPrevious ? previous.cooldownUntil : failure.cooldownUntil,
        retryAfterUntil: keepPrevious ? previous.retryAfterUntil : failure.retryAfterUntil,
        responseStatus: failure.responseStatus,
        projectWide: keepPrevious ? previous.projectWide : failure.projectWide,
        observedAt: this.now(),
      };
      delete state.reservations[this.reservationId];
    });
    return failure.status !== "auth_error";
  }

  async succeeded(): Promise<void> {
    if (!this.scope) return;
    const scope = this.scope;
    this.store.update((state) => {
      const key = recordKey(scope);
      const previous = state.records[key];
      // Success cannot clear a cooldown observed by a newer sibling request.
      const cooling = previous && previous.cooldownUntil > this.now();
      state.records[key] = {
        ...previous,
        ...scope,
        status: cooling ? previous.status : "unknown",
        reason: cooling ? previous.reason : "unknown",
        cooldownUntil: cooling ? previous.cooldownUntil : 0,
        observedAt: cooling ? previous.observedAt : this.now(),
        lastSuccessAt: this.now(),
      };
      delete state.reservations[this.reservationId];
    });
  }

  async release(): Promise<void> {
    if (!this.scope) return;
    if (!this.store.snapshot().reservations[this.reservationId]) return;
    this.store.update((state) => {
      delete state.reservations[this.reservationId];
    });
  }
}
