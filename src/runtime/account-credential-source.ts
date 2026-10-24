import type { AntigravityApiKey } from "../types/types.js";
import { failoverToNextAccount, getActiveApiKey } from "../auth/accounts.js";
import { parseApiKey } from "../client/index.js";
import type { CredentialSource } from "./credentials.js";
import { PersistentCredentialSource } from "./persistent-credential-source.js";

export class AccountCredentialSource implements CredentialSource {
  constructor(
    private readonly apiKeyGetter?: () => Promise<string | undefined> | string | undefined,
  ) {}

  forRequest(runtimeModel: string): CredentialSource {
    if (this.apiKeyGetter) {
      // Legacy custom getters have no stable identity contract.
      return { current: () => this.current(), rotate: (excluded) => this.rotate(excluded) };
    }
    return new PersistentCredentialSource(runtimeModel);
  }

  async current(): Promise<AntigravityApiKey> {
    if (this.apiKeyGetter) {
      const raw = await this.apiKeyGetter();
      if (raw) return parseApiKey(raw);
    }
    return getActiveApiKey();
  }

  async rotate(excluded: ReadonlySet<string>): Promise<AntigravityApiKey | undefined> {
    return failoverToNextAccount(excluded);
  }
}
