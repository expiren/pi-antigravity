import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  antigravityHeaders,
  endpointCandidates,
  extractProjectId,
  fetchAvailableModelsCatalog,
  parseApiKey,
  resolveProjectId,
} from "../client/client.js";
import {
  setLastEndpoint,
  setLastError,
  setLastProjectId,
  setLastStatus,
} from "../diagnostics/diagnostics.js";
import { isRecord } from "../utils/util.js";
import { safeError } from "../utils/security.js";
import { antigravityFetch } from "../utils/http.js";
import type {
  AccountUsage,
  ApiErrorBody,
  AvailableModelsRaw,
  LoadCodeAssistRaw,
  ModelQuotaRow,
  QuotaBucket,
  QuotaGroup,
  QuotaSummaryRaw,
  TierInfo,
  TierRaw,
} from "../types/types.js";

function clampFraction(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function remainingPercent(remaining?: number): number | undefined {
  if (remaining === undefined) return undefined;
  return Math.round(remaining * 1000) / 10;
}

function progressBar(remaining?: number, width = 20): string {
  if (remaining === undefined) return `[${"?".repeat(width)}]`;
  const filled = Math.max(0, Math.min(width, Math.round(remaining * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function formatReset(resetTime?: string): string {
  if (!resetTime) return "n/a";
  const ts = Date.parse(resetTime);
  if (!Number.isFinite(ts)) return resetTime;
  const delta = ts - Date.now();
  if (delta <= 0) return "now";
  const totalMin = Math.round(delta / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function jsonHeaders(token: string): Record<string, string> {
  return {
    ...antigravityHeaders(token),
    Accept: "application/json",
  };
}

const AUXILIARY_TIMEOUT_MS = 5_000;

class NonRetryableRpcError extends Error {}

async function postJson(
  path: string,
  token: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ endpoint: string; status: number; data: unknown }> {
  // One budget for the entire fallback chain, including response body reads.
  const timeout = AbortSignal.timeout(AUXILIARY_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let lastErrorText = "";
  for (const endpoint of endpointCandidates()) {
    try {
      const res = await antigravityFetch(`${endpoint}${path}`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify(body),
        signal: requestSignal,
      });
      setLastEndpoint(endpoint);
      setLastStatus(res.status);
      const text = await res.text();
      let data: unknown;
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = { raw: text } satisfies ApiErrorBody;
      }
      if (!res.ok) {
        const errorBody = isRecord(data) ? (data as ApiErrorBody) : undefined;
        lastErrorText =
          typeof errorBody?.error?.message === "string" ? errorBody.error.message : text;
        if (
          ![403, 404, 429, 500, 502, 503, 504].includes(res.status) ||
          /SUBSCRIPTION_REQUIRED|#3501|(?:lack|missing).*license/i.test(lastErrorText)
        ) {
          throw new NonRetryableRpcError(
            `${path} failed (${String(res.status)}): ${lastErrorText.slice(0, 300)}`,
          );
        }
        continue;
      }
      return { endpoint, status: res.status, data };
    } catch (error) {
      lastErrorText = safeError(error);
      setLastError(lastErrorText);
      if (requestSignal.aborted || error instanceof NonRetryableRpcError) throw error;
    }
  }
  throw new Error(`${path} failed: ${lastErrorText || "no endpoint available"}`);
}

function parseQuotaSummary(data: unknown): { groups: QuotaGroup[]; description?: string } {
  const summary = (isRecord(data) ? data : {}) as QuotaSummaryRaw;
  const groups: QuotaGroup[] = [];
  for (const group of summary.groups || []) {
    const buckets: QuotaBucket[] = [];
    for (const bucket of group.buckets || []) {
      const remaining = clampFraction(bucket.remainingFraction);
      if (remaining === undefined && !bucket.bucketId) continue;
      buckets.push({
        bucketId: String(bucket.bucketId || bucket.displayName || "unknown"),
        displayName: String(bucket.displayName || bucket.bucketId || "Limit"),
        window: bucket.window ? String(bucket.window) : undefined,
        resetTime: bucket.resetTime ? String(bucket.resetTime) : undefined,
        description: bucket.description ? String(bucket.description) : undefined,
        remainingFraction: remaining ?? 0,
      });
    }
    if (!buckets.length && !group.displayName) continue;
    groups.push({
      displayName: String(group.displayName || "Quota group"),
      description: group.description ? String(group.description) : undefined,
      buckets,
    });
  }
  return {
    groups,
    description: summary.description ? String(summary.description) : undefined,
  };
}

function parseModels(data: unknown): {
  models: ModelQuotaRow[];
  defaultAgentModelId?: string;
} {
  const raw = (isRecord(data) ? data : {}) as AvailableModelsRaw;
  const modelsObj = raw.models && isRecord(raw.models) ? raw.models : {};
  const models: ModelQuotaRow[] = [];
  for (const [modelId, info] of Object.entries(modelsObj)) {
    if (!info || !isRecord(info)) continue;
    if (info.isInternal || String(modelId).startsWith("chat_")) continue;
    const qi = isRecord(info.quotaInfo) ? info.quotaInfo : {};
    models.push({
      modelId,
      displayName:
        typeof info.displayName === "string"
          ? info.displayName
          : typeof info.label === "string"
            ? info.label
            : typeof info.modelName === "string"
              ? info.modelName
              : undefined,
      remainingFraction: clampFraction(qi.remainingFraction),
      resetTime: qi.resetTime ? String(qi.resetTime) : undefined,
      modelProvider:
        typeof info.modelProvider === "string"
          ? info.modelProvider
          : typeof info.apiProvider === "string"
            ? info.apiProvider
            : undefined,
      supportsThinking: !!info.supportsThinking,
      supportsImages: !!info.supportsImages,
      recommended: !!info.recommended,
    });
  }
  models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return {
    models,
    defaultAgentModelId:
      raw.defaultAgentModelId || raw.defaultAgentModel
        ? String(raw.defaultAgentModelId || raw.defaultAgentModel)
        : undefined,
  };
}

function parseTier(value: unknown): TierInfo | undefined {
  if (!isRecord(value)) return undefined;
  const tier = value as TierRaw;
  if (!tier.id && !tier.name) return undefined;
  return {
    id: tier.id ? String(tier.id) : undefined,
    name: tier.name ? String(tier.name) : undefined,
    description: tier.description ? String(tier.description) : undefined,
  };
}

async function loadCodeAssistSafe(token: string, signal?: AbortSignal) {
  try {
    return await postJson(
      "/v1internal:loadCodeAssist",
      token,
      {
        metadata: {
          ideType: "ANTIGRAVITY",
          platform: "PLATFORM_UNSPECIFIED",
          pluginType: "GEMINI",
        },
      },
      signal,
    );
  } catch {
    return null;
  }
}

/**
 * The user-quota-summary RPC is gated behind a paid subscription: free-tier
 * accounts get 403 SUBSCRIPTION_REQUIRED (#3501). It is best-effort diagnostics
 * only — never let it block the rest of the account data (models, tier, project).
 */
async function fetchQuotaSummarySafe(
  token: string,
  signal?: AbortSignal,
): Promise<
  | { ok: true; result: { endpoint: string; status: number; data: unknown } }
  | {
      ok: false;
      error: string;
    }
> {
  try {
    return {
      ok: true,
      result: await postJson("/v1internal:retrieveUserQuotaSummary", token, {}, signal),
    };
  } catch (error) {
    const msg = safeError(error);
    setLastError(msg);
    return { ok: false, error: msg };
  }
}

export type UsageFetchOptions = {
  signal?: AbortSignal;
  onUpdate?: (usage: AccountUsage) => void;
};

/** Model listing needs only fetchAvailableModels, which already contains quotaInfo. */
export async function fetchAccountModelsUsage(
  apiKeyRaw?: string,
  options?: UsageFetchOptions,
): Promise<AccountUsage> {
  const creds = parseApiKey(apiKeyRaw);
  const projectId = resolveProjectId({ token: creds.token, credentialProjectId: creds.projectId });
  const toUsage = (
    available: Awaited<ReturnType<typeof fetchAvailableModelsCatalog>>,
  ): AccountUsage => ({
    projectId,
    endpoint: available.endpoint,
    groups: [],
    ...parseModels(available.data),
    fetchedAt: Date.now(),
  });
  const available = await fetchAvailableModelsCatalog(
    creds.token,
    projectId,
    options?.signal,
    (result) => options?.onUpdate?.(toUsage(result)),
  );
  setLastProjectId(projectId);
  return toUsage(available);
}

export async function fetchAccountUsage(
  apiKeyRaw?: string,
  options?: UsageFetchOptions,
): Promise<AccountUsage> {
  const creds = parseApiKey(apiKeyRaw);
  // Render models as soon as any endpoint succeeds; auxiliary data must never
  // gate the first usable account row. Final resolution still includes all data.
  const [assistResult, summaryRes, modelUsage] = await Promise.all([
    loadCodeAssistSafe(creds.token, options?.signal),
    fetchQuotaSummarySafe(creds.token, options?.signal),
    fetchAccountModelsUsage(apiKeyRaw, options),
  ]);

  // Derive project ID from the loadCodeAssist response or stored project ID.
  const discoveredProject = assistResult ? extractProjectId(assistResult.data) : undefined;
  const projectId = resolveProjectId({
    token: creds.token,
    warmedProject: discoveredProject ?? null,
    credentialProjectId: creds.projectId,
  });
  setLastProjectId(projectId);

  const summary = summaryRes.ok ? summaryRes.result : null;
  const quotaSummaryError = summaryRes.ok ? undefined : summaryRes.error;
  const { groups, description } = summary
    ? parseQuotaSummary(summary.data)
    : { groups: [], description: undefined };
  const { models, defaultAgentModelId } = modelUsage;

  const assistData = (isRecord(assistResult?.data) ? assistResult.data : {}) as LoadCodeAssistRaw;
  const productTier = parseTier(assistData.currentTier);
  const paidTier = parseTier(assistData.paidTier);

  // Google returns currentTier=free-tier even for Google AI Pro accounts.
  // The real subscription lives in paidTier (e.g. g1-pro-tier / Google AI Pro).
  const planLabel = paidTier?.name
    ? `${paidTier.name}${paidTier.id ? ` (${paidTier.id})` : ""}`
    : productTier?.name
      ? `${productTier.name}${productTier.id ? ` (${productTier.id})` : ""}`
      : undefined;

  return {
    projectId,
    endpoint: summary?.endpoint ?? modelUsage.endpoint ?? assistResult?.endpoint,
    productTier,
    paidTier,
    planLabel,
    groups,
    groupDescription: description,
    quotaSummaryError,
    models,
    defaultAgentModelId,
    fetchedAt: Date.now(),
  };
}

function quotaErrorNote(msg: string): string {
  if (/SUBSCRIPTION_REQUIRED|#3501|(?:lack|missing).*license/i.test(msg)) {
    return "Aggregate quota summary needs a paid subscription (free-tier can't use that endpoint). Per-model usage is still available via /antigravity models.";
  }
  return `Aggregate quota summary unavailable: ${msg.slice(0, 160)}`;
}

export type WindowQuota = {
  remainingFraction: number;
  resetTime?: string;
};

export type ModelQuotaPair = {
  shortWindow?: WindowQuota;
  weeklyWindow?: WindowQuota;
};

export type DashboardModelQuotas = {
  gemini: ModelQuotaPair;
  claude: ModelQuotaPair;
};

export type DashboardAccountRow = {
  index: number;
  accountId: string;
  email?: string;
  shortLabel: string;
  active: boolean;
  loading?: boolean;
  usage?: AccountUsage;
  error?: string;
};

export type DashboardColorizer = {
  activeMarker: (text: string) => string;
  accountName: (text: string, active?: boolean) => string;
  modelName: (text: string) => string;
  bar: (fraction: number | undefined, barText: string) => string;
  percent: (fraction: number | undefined, text: string) => string;
  countdown: (text: string, isAlert?: boolean) => string;
  dim: (text: string) => string;
  cursor: (text: string) => string;
};

export const plainDashboardColorizer: DashboardColorizer = {
  activeMarker: (text) => text,
  accountName: (text) => text,
  modelName: (text) => text,
  bar: (_fraction, text) => text,
  percent: (_fraction, text) => text,
  countdown: (text) => text,
  dim: (text) => text,
  cursor: (text) => text,
};

export type ThemeLike = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export function createThemeColorizer(theme: ThemeLike): DashboardColorizer {
  return {
    activeMarker: (text) => theme.bold(theme.fg("accent", text)),
    accountName: (text, active) =>
      active ? theme.bold(theme.fg("accent", text)) : theme.fg("text", text),
    modelName: (text) => theme.fg("muted", text),
    bar: (fraction, barText) => {
      if (fraction === undefined) return theme.fg("dim", barText);
      if (fraction >= 0.5) return theme.fg("success", barText);
      if (fraction >= 0.2) return theme.fg("warning", barText);
      return theme.fg("error", barText);
    },
    percent: (fraction, text) => {
      if (fraction === undefined) return theme.fg("dim", text);
      if (fraction >= 0.5) return theme.fg("text", text);
      if (fraction >= 0.2) return theme.fg("warning", text);
      return theme.fg("error", text);
    },
    countdown: (text, isAlert) => (isAlert ? theme.fg("warning", text) : theme.fg("dim", text)),
    dim: (text) => theme.fg("dim", text),
    cursor: (text) => theme.fg("accent", text),
  };
}

type ParsedAccountLabel = {
  accountId: string;
  username: string;
  domain: string;
  tld: string;
  host: string;
};

function parseAccountLabel(account: { email?: string; accountId: string }): ParsedAccountLabel {
  if (account.email && account.email.includes("@")) {
    const parts = account.email.split("@");
    const host = parts.slice(1).join("@");
    const hostLabels = host.split(".").filter(Boolean);
    return {
      accountId: account.accountId,
      username: parts[0] || account.accountId,
      domain: hostLabels[0] || "",
      tld: hostLabels.length > 1 ? hostLabels[hostLabels.length - 1] : "",
      host,
    };
  }
  return {
    accountId: account.accountId,
    username: account.accountId.length > 8 ? account.accountId.slice(0, 8) : account.accountId,
    domain: "",
    tld: "",
    host: "",
  };
}

function collidingIds(labels: Map<string, string>): string[][] {
  const groups = new Map<string, string[]>();
  for (const [id, label] of labels) {
    const group = groups.get(label);
    if (group) group.push(id);
    else groups.set(label, [id]);
  }
  return [...groups.values()].filter((ids) => ids.length > 1);
}

function applyIfUnique(
  labels: Map<string, string>,
  ids: string[],
  next: (id: string) => string | undefined,
): void {
  const proposed = ids.map((id) => next(id));
  if (proposed.some((label) => !label)) return;
  const nextLabels = proposed.filter((label): label is string => Boolean(label));
  if (new Set(nextLabels).size !== ids.length) return;
  const idSet = new Set(ids);
  const outside = new Set(
    [...labels.entries()].filter(([id]) => !idSet.has(id)).map(([, label]) => label),
  );
  if (nextLabels.some((label) => outside.has(label))) return;
  ids.forEach((id, index) => labels.set(id, nextLabels[index]));
}

export function deriveUniqueShortLabels(
  accounts: Array<{ email?: string; accountId: string }>,
): Map<string, string> {
  const parsed = new Map(
    accounts.map((account) => [account.accountId, parseAccountLabel(account)]),
  );
  const labels = new Map<string, string>();
  for (const item of parsed.values()) labels.set(item.accountId, item.username);

  const strategies: Array<(item: ParsedAccountLabel) => string | undefined> = [
    (item) => (item.domain ? `${item.username} (${item.domain})` : undefined),
    (item) => (item.tld && item.tld !== item.domain ? `${item.username} (${item.tld})` : undefined),
    (item) => (item.host ? `${item.username} (${item.host})` : undefined),
  ];
  for (const strategy of strategies) {
    for (const ids of collidingIds(labels)) {
      applyIfUnique(labels, ids, (id) => {
        const item = parsed.get(id);
        return item ? strategy(item) : undefined;
      });
    }
  }
  for (const ids of collidingIds(labels)) {
    ids.forEach((id, index) => {
      const base = parsed.get(id)?.username || id;
      labels.set(id, `${base} #${index + 1}`);
    });
  }
  return labels;
}

/**
 * Format reset countdown:
 * - When remaining is 100% (or no resetTime): returns 3 spaces "   "
 * - Short window (5h): >=1h -> " Xh" (e.g. " 2h"), <1h -> "XXm" (e.g. "45m", " 8m"), <=0 -> " 0m"
 * - Weekly window: >=24h -> " Xd" (e.g. " 4d"), <24h -> " Xh" (e.g. "18h"), <1h -> "XXm"
 * Always returns exactly 3 visible characters.
 */
export function formatQuotaCountdown(
  windowType: "5h" | "week",
  resetTime?: string,
  remainingFraction?: number,
  now = Date.now(),
): string {
  if (
    remainingFraction !== undefined &&
    Math.round(Math.max(0, Math.min(1, remainingFraction)) * 100) >= 100
  ) {
    return "   ";
  }
  if (!resetTime) {
    return "   ";
  }
  const ts = Date.parse(resetTime);
  if (!Number.isFinite(ts)) {
    return "   ";
  }
  const diffMs = ts - now;
  if (diffMs <= 0) {
    return " 0m";
  }
  const totalMin = Math.round(diffMs / 60000);
  const totalHours = Math.floor(totalMin / 60);
  const days = Math.floor(totalHours / 24);

  if (windowType === "week") {
    if (days >= 1) {
      return `${days}d`.padStart(3);
    }
    if (totalHours >= 1) {
      return `${totalHours}h`.padStart(3);
    }
    return `${Math.max(1, totalMin)}m`.padStart(3);
  }

  // 5h window
  if (totalHours >= 1) {
    return `${totalHours}h`.padStart(3);
  }
  return `${Math.max(1, totalMin)}m`.padStart(3);
}

export function formatQuotaBar(remainingFraction?: number, width = 8): string {
  if (remainingFraction === undefined) {
    return "▱".repeat(width);
  }
  const clamped = Math.max(0, Math.min(1, remainingFraction));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return "▰".repeat(filled) + "▱".repeat(empty);
}

export function formatQuotaPercent(remainingFraction?: number): string {
  if (remainingFraction === undefined) return "  ?%";
  const pct = Math.round(Math.max(0, Math.min(1, remainingFraction)) * 100);
  return `${pct}%`.padStart(4);
}

function classifyQuotaGroup(name: string): "gemini" | "claude" | "generic" | "other" {
  const normalized = name.toLowerCase().trim();
  if (/claude|gpt|anthropic/.test(normalized)) return "claude";
  if (/gemini|google/.test(normalized)) return "gemini";
  if (!normalized || /^(quota group|limit|unknown)$/.test(normalized)) return "generic";
  return "other";
}

function classifyQuotaWindow(bucket: QuotaBucket, now: number): "week" | "5h" | undefined {
  const name =
    `${bucket.displayName || ""} ${bucket.window || ""} ${bucket.bucketId || ""}`.toLowerCase();
  if (/\bweek(?:ly)?\b|\b7d\b|7-day/.test(name)) return "week";
  if (/\b5h\b|5-hour|5 hour|\bsliding\b|\bslide\b/.test(name)) return "5h";
  if (!bucket.resetTime) return undefined;
  const diff = Date.parse(bucket.resetTime) - now;
  if (!Number.isFinite(diff)) return undefined;
  return diff > 24 * 3600 * 1000 ? "week" : "5h";
}

export function extractDashboardModelQuotas(
  usage?: AccountUsage,
  now = Date.now(),
): DashboardModelQuotas {
  const result: DashboardModelQuotas = {
    gemini: {},
    claude: {},
  };
  if (!usage) return result;

  let geminiGroup: QuotaGroup | undefined;
  let claudeGroup: QuotaGroup | undefined;
  const genericGroups: QuotaGroup[] = [];

  for (const group of usage.groups || []) {
    const kind = classifyQuotaGroup(group.displayName || "");
    if (kind === "claude") claudeGroup = group;
    else if (kind === "gemini") geminiGroup = group;
    else if (kind === "generic") genericGroups.push(group);
  }

  // Positional fallback only for unnamed groups. A named non-Claude group must not
  // be drawn on the Claude row.
  if (!geminiGroup && genericGroups.length > 0) geminiGroup = genericGroups.shift();
  if (!claudeGroup && genericGroups.length > 0) claudeGroup = genericGroups.shift();

  function resolveBuckets(group?: QuotaGroup): ModelQuotaPair {
    if (!group || !group.buckets || group.buckets.length === 0) return {};
    const pair: ModelQuotaPair = {};
    for (const bucket of group.buckets) {
      const quota: WindowQuota = {
        remainingFraction: bucket.remainingFraction ?? 0,
        resetTime: bucket.resetTime,
      };
      const kind = classifyQuotaWindow(bucket, now);
      if (kind === "week") pair.weeklyWindow = quota;
      else if (kind === "5h") pair.shortWindow = quota;
      else if (!pair.shortWindow) pair.shortWindow = quota;
      else if (!pair.weeklyWindow) pair.weeklyWindow = quota;
    }
    return pair;
  }

  result.gemini = resolveBuckets(geminiGroup);
  result.claude = resolveBuckets(claudeGroup);

  // Fallback to per-model quotaInfo if groups were empty (e.g. subscription-required free-tier)
  if (!result.gemini.shortWindow && usage.models && usage.models.length > 0) {
    const geminiModel = usage.models.find(
      (m) => /gemini/i.test(m.modelId) && m.remainingFraction !== undefined,
    );
    if (geminiModel && geminiModel.remainingFraction !== undefined) {
      result.gemini.shortWindow = {
        remainingFraction: geminiModel.remainingFraction,
        resetTime: geminiModel.resetTime,
      };
    }
  }
  if (!result.claude.shortWindow && usage.models && usage.models.length > 0) {
    const claudeModel = usage.models.find(
      (m) => /claude/i.test(m.modelId) && m.remainingFraction !== undefined,
    );
    if (claudeModel && claudeModel.remainingFraction !== undefined) {
      result.claude.shortWindow = {
        remainingFraction: claudeModel.remainingFraction,
        resetTime: claudeModel.resetTime,
      };
    }
  }

  return result;
}

export function renderQuotaCell(
  windowType: "5h" | "week",
  quota?: WindowQuota,
  colorizer: DashboardColorizer = plainDashboardColorizer,
  now = Date.now(),
): string {
  if (!quota) {
    const bar = colorizer.bar(undefined, "▱".repeat(8));
    const pct = colorizer.percent(undefined, "   -");
    const cd = colorizer.countdown("   ");
    return `${bar} ${pct} ${cd}`;
  }
  const frac = quota.remainingFraction;
  const bar = colorizer.bar(frac, formatQuotaBar(frac, 8));
  const pct = colorizer.percent(frac, formatQuotaPercent(frac));
  const isAlert = (windowType === "week" && frac < 0.25) || (windowType === "5h" && frac < 0.2);
  const cd = colorizer.countdown(
    formatQuotaCountdown(windowType, quota.resetTime, frac, now),
    isAlert,
  );
  return `${bar} ${pct} ${cd}`;
}

function fitAccountLabel(label: string, width = 13): string {
  if (label.length <= width) return label;
  const suffixMatch = / \([^)]+\)$/.exec(label);
  const suffix = suffixMatch?.[0];
  if (suffix && suffixMatch && suffix.length <= width - 2) {
    const headWidth = width - suffix.length - 1;
    return `${label.slice(0, suffixMatch.index).slice(0, headWidth)}…${suffix}`;
  }
  return `${label.slice(0, Math.max(0, width - 1))}…`;
}

export function renderAccountDashboardLines(
  row: DashboardAccountRow,
  options?: {
    isSelected?: boolean;
    colorizer?: DashboardColorizer;
    now?: number;
  },
): [string, string] {
  const colorizer = options?.colorizer || plainDashboardColorizer;
  const now = options?.now || Date.now();

  const cursorStr = options?.isSelected ? "> " : "  ";
  const styledCursor = colorizer.cursor(cursorStr);
  const cursorEmpty = "  ";

  // Account column: 13 chars width + 2 spacing spaces to prevent collision with model name.
  // Keep a parenthetical disambiguator when the local part is too long.
  const nameLabel = fitAccountLabel(row.shortLabel, 13);
  const styledName = colorizer.accountName(nameLabel.padEnd(13), row.active);
  const accountSpacing = "  ";

  const line1Prefix = `${styledCursor}${styledName}${accountSpacing}`;
  const line2Prefix = `${cursorEmpty}${" ".repeat(13)}${accountSpacing}`;

  const geminiLabel = colorizer.modelName("Gemini  ");
  const claudeLabel = colorizer.modelName("Claude  ");

  const activeBadge = row.active ? `  ${colorizer.activeMarker("● active")}` : "";

  if (row.loading) {
    const loadingText = colorizer.dim("[   fetching quota...    ]");
    return [
      `${line1Prefix}${geminiLabel}${loadingText}${activeBadge}`,
      `${line2Prefix}${claudeLabel}${loadingText}`,
    ];
  }

  if (row.error) {
    const errText = colorizer.countdown(`[ ${oneLine(row.error, 36)} ]`, true);
    return [
      `${line1Prefix}${geminiLabel}${errText}${activeBadge}`,
      `${line2Prefix}${claudeLabel}${colorizer.dim("[                      ]")}`,
    ];
  }

  const quotas = extractDashboardModelQuotas(row.usage, now);
  const g5h = renderQuotaCell("5h", quotas.gemini.shortWindow, colorizer, now);
  const gWk = renderQuotaCell("week", quotas.gemini.weeklyWindow, colorizer, now);
  const c5h = renderQuotaCell("5h", quotas.claude.shortWindow, colorizer, now);
  const cWk = renderQuotaCell("week", quotas.claude.weeklyWindow, colorizer, now);

  const line1 = `${line1Prefix}${geminiLabel}${g5h}   ${gWk}${activeBadge}`;
  const line2 = `${line2Prefix}${claudeLabel}${c5h}   ${cWk}`;
  return [line1, line2];
}

export function formatAccountsDashboard(
  rows: DashboardAccountRow[],
  options?: {
    selectedIndex?: number;
    colorizer?: DashboardColorizer;
    now?: number;
  },
): string {
  const lines: string[] = [];
  const colorizer = options?.colorizer || plainDashboardColorizer;
  const now = options?.now || Date.now();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const isSelected = options?.selectedIndex !== undefined && options.selectedIndex === i;
    const [l1, l2] = renderAccountDashboardLines(row, {
      isSelected,
      colorizer,
      now,
    });
    if (lines.length > 0) lines.push("");
    lines.push(l1);
    lines.push(l2);
  }
  return lines.join("\n");
}

export type AccountUsageView = {
  index: number;
  accountId: string;
  label: string;
  active: boolean;
  usage?: AccountUsage;
  error?: string;
};

export function compactQuotaLabel(usage: AccountUsage): string {
  const parts: string[] = [];
  if (usage.planLabel) parts.push(usage.planLabel);
  for (const group of usage.groups) {
    for (const bucket of group.buckets) {
      const rem = remainingPercent(bucket.remainingFraction);
      parts.push(`${bucket.displayName} ${rem ?? "?"}%`);
    }
  }
  if (parts.length === 0) return usage.quotaSummaryError ? "quota n/a" : "no quota groups";
  const shown = parts.slice(0, 4);
  return parts.length > 4 ? `${shown.join(" · ")} · …` : shown.join(" · ");
}

function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function accountSwitchLabel(row: AccountUsageView): string {
  const detail = row.error
    ? oneLine(row.error)
    : row.usage
      ? compactQuotaLabel(row.usage)
      : "no usage";
  return `${row.active ? "* " : "  "}${row.index}. ${row.label} · ${detail}`;
}

function indentBlock(text: string, pad = "    "): string {
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

export function formatAccountsUsage(rows: AccountUsageView[]): string {
  const lines = ["Antigravity accounts"];
  for (const row of rows) {
    if (lines.length > 1) lines.push("");
    lines.push(`${row.active ? "*" : " "} ${row.index}. ${row.label}`);
    if (row.error) {
      lines.push(`    ${oneLine(row.error, 200)}`);
      continue;
    }
    if (!row.usage) {
      lines.push("    No usage.");
      continue;
    }
    lines.push(indentBlock(formatUsageSummary(row.usage)));
  }
  return lines.join("\n");
}

export function formatUsageSummary(usage: AccountUsage): string {
  const lines: string[] = [];

  if (usage.planLabel) lines.push(usage.planLabel);

  if (!usage.groups.length) {
    if (usage.quotaSummaryError) {
      lines.push(quotaErrorNote(usage.quotaSummaryError));
    } else {
      lines.push("No quota groups returned.");
    }
    return lines.join("\n");
  }

  for (const group of usage.groups) {
    if (lines.length) lines.push("");
    lines.push(group.displayName);
    for (const bucket of group.buckets) {
      const rem = remainingPercent(bucket.remainingFraction);
      lines.push(
        `  ${progressBar(bucket.remainingFraction)} ${bucket.displayName}: ${rem ?? "?"}% left · resets ${formatReset(bucket.resetTime)}`,
      );
    }
  }

  return lines.join("\n").trimEnd();
}

export function formatModelsList(usage: AccountUsage, opts?: { all?: boolean }): string {
  const lines: string[] = [];
  lines.push("Antigravity available models");
  lines.push(`project=${usage.projectId}`);
  if (usage.defaultAgentModelId) lines.push(`defaultAgentModel=${usage.defaultAgentModelId}`);
  lines.push("");

  const rows = opts?.all
    ? usage.models
    : usage.models.filter((m) => !/tab_|chat_/i.test(m.modelId));

  if (!rows.length) {
    lines.push("No models returned.");
    return lines.join("\n");
  }

  const maxId = Math.max(...rows.map((m) => m.modelId.length), 8);
  for (const m of rows) {
    const rem = remainingPercent(m.remainingFraction);
    const flags = [
      m.recommended ? "recommended" : "",
      m.supportsThinking ? "thinking" : "",
      m.supportsImages ? "images" : "",
    ]
      .filter(Boolean)
      .join(",");
    const name = m.displayName && m.displayName !== m.modelId ? `  ${m.displayName}` : "";
    lines.push(
      `${m.modelId.padEnd(maxId)}  rem ${rem === undefined ? "  ?" : String(rem).padStart(5)}%  reset ${formatReset(m.resetTime).padEnd(8)}${flags ? `  [${flags}]` : ""}${name}`,
    );
  }
  lines.push("");
  lines.push("Note: remaining % is pool-shared (not a private per-model budget).");
  return lines.join("\n");
}

export async function resolveApiKeyFromContext(
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  try {
    return await ctx.modelRegistry.getApiKeyForProvider("antigravity");
  } catch {
    return undefined;
  }
}
