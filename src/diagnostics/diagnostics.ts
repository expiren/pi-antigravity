import { AsyncLocalStorage } from "node:async_hooks";
import { redactSecrets } from "../utils/security.js";

export type DiagnosticsSnapshot = {
  status?: number;
  endpoint?: string;
  error?: string;
  projectId?: string;
  resolvedRuntimeModel?: string;
  requestedModel?: string;
  availableModels?: string;
  matchedModelDebug?: string;
  latencyMs?: number;
  maskedEmail?: string;
  tokenExpiry?: string;
  toolSchemaWarnings?: string;
  healthSelection?: HealthSelection;
};

export type HealthSelection = {
  selectedAccount: string;
  runtimeModel: string;
  rotationCount: number;
  skipReasons: Record<string, number>;
  basis: "unknown" | "recent_success";
  lastFailureClass?: string;
};

export function setHealthSelection(selection: HealthSelection): void {
  currentBag().healthSelection = { ...selection, skipReasons: { ...selection.skipReasons } };
}

const storage = new AsyncLocalStorage<DiagnosticsSnapshot>();

/** Last completed request snapshot for `/antigravity.doctor`. */
let lastSnapshot: DiagnosticsSnapshot = {};

function currentBag(): DiagnosticsSnapshot {
  return storage.getStore() ?? lastSnapshot;
}

/**
 * Run work with an isolated diagnostics bag.
 * Parallel account reads pass `commit: false` so a sibling account cannot clobber `/antigravity.doctor`.
 */
export async function runWithDiagnostics<T>(
  fn: () => Promise<T>,
  opts?: { commit?: boolean },
): Promise<T> {
  const bag: DiagnosticsSnapshot = {};
  return storage.run(bag, async () => {
    try {
      return await fn();
    } finally {
      if (opts?.commit !== false) lastSnapshot = { ...bag };
    }
  });
}

export function getLastDiagnostics(): Readonly<DiagnosticsSnapshot> {
  return lastSnapshot;
}

/** Read endpoint from the active request bag (or last snapshot outside a request). */
export function getCurrentEndpoint(): string | undefined {
  return currentBag().endpoint;
}

export function getCurrentMatchedModelDebug(): string | undefined {
  return currentBag().matchedModelDebug;
}

export function getCurrentAvailableModels(): string | undefined {
  return currentBag().availableModels;
}

export function setLastStatus(status: number | undefined): void {
  currentBag().status = status;
}
export function setLastEndpoint(endpoint: string | undefined): void {
  currentBag().endpoint = endpoint;
}
export function setLastError(error: string | undefined): void {
  currentBag().error = error === undefined ? undefined : redactSecrets(error).slice(0, 800);
}
export function setLastProjectId(projectId: string | undefined): void {
  currentBag().projectId = projectId;
}
export function setLastResolvedRuntimeModel(
  model: string | undefined,
  requestedModel?: string,
): void {
  currentBag().resolvedRuntimeModel = model;
  currentBag().requestedModel = requestedModel;
}
export function setLastAvailableModels(models: string | undefined): void {
  currentBag().availableModels = models;
}
export function setLastMatchedModelDebug(debug: string | undefined): void {
  currentBag().matchedModelDebug =
    debug === undefined ? undefined : redactSecrets(debug).slice(0, 1200);
}
export function setLastLatencyMs(ms: number | undefined): void {
  currentBag().latencyMs = ms;
}
export function setLastMaskedEmail(email: string | undefined): void {
  currentBag().maskedEmail = email;
}
export function setLastTokenExpiry(expiry: string | undefined): void {
  currentBag().tokenExpiry = expiry;
}
/** Store sanitized tool-schema omissions for the next doctor report. */
export function setLastToolSchemaWarnings(warnings: string[] | undefined): void {
  currentBag().toolSchemaWarnings =
    warnings === undefined ? undefined : redactSecrets(warnings.join(" | ")).slice(0, 1200);
}

/** Test helper: reset last snapshot between cases. */
export function resetDiagnosticsForTests(): void {
  lastSnapshot = {};
}
