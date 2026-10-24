import { createHash } from "node:crypto";
import type { HealthScope } from "./types.js";

/** Call only at the raw account-store boundary; hashed IDs are otherwise opaque. */
export function opaqueAccountId(existingStableAccountId: string): string {
  const normalized = existingStableAccountId.trim().toLowerCase();
  if (!normalized || normalized.length > 4096) throw new Error("Invalid health account identity.");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function healthScope(accountId: string, projectId: string, model: string): HealthScope {
  return {
    accountId: opaqueAccountId(accountId),
    projectId: projectId.trim(),
    model: model.trim().toLowerCase(),
  };
}

export function recordKey(scope: HealthScope): string {
  return JSON.stringify([scope.accountId, scope.projectId, scope.model]);
}
