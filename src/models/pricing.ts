import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

/**
 * Display-only price estimates (USD per million tokens). Antigravity is not metered per token.
 *
 * Resolution order for a public model ID:
 *   1. An explicitly supplied lookup into the owning session's live model registry.
 *   2. Pi's built-in catalog (`getBuiltinModels`, follows the host's pi-ai version).
 *   3. The static table below, for models Pi has not yet included.
 */
type ModelCost = NonNullable<Extract<ProviderModelConfig, { reasoning: boolean }>["cost"]>;
export type PricingResolver = (publicId: string) => ModelCost | undefined;
type PricingProvider = "google" | "anthropic";
export type PricingSources = {
  find?: (provider: string, modelId: string) => { cost?: unknown } | undefined;
  getModels?: (provider: PricingProvider) => unknown;
};

// ---- Static floor -----------------------------------------------------------------------
// Gemini has no cache-write charge (storage is billed per hour instead).
export const gemini4ArgonCost: ModelCost = {
  input: 2.0,
  output: 10.0,
  cacheRead: 0.1,
  cacheWrite: 0,
};
export const gemini38FlashCost: ModelCost = {
  input: 0.75,
  output: 3.75,
  cacheRead: 0.075,
  cacheWrite: 0,
};
export const gemini35FlashCost: ModelCost = {
  input: 1.5,
  output: 9.0,
  cacheRead: 0.15,
  cacheWrite: 0,
};
export const geminiFlashLiteCost: ModelCost = {
  input: 0.3,
  output: 2.5,
  cacheRead: 0.03,
  cacheWrite: 0,
};
export const geminiProCost: ModelCost = {
  input: 2.0,
  output: 12.0,
  cacheRead: 0.2,
  cacheWrite: 0,
  tiers: [{ inputTokensAbove: 200000, input: 4.0, output: 18.0, cacheRead: 0.4, cacheWrite: 0 }],
};
export const claudeSonnetCost: ModelCost = {
  input: 3.0,
  output: 15.0,
  cacheRead: 0.3,
  cacheWrite: 3.75,
};
export const claudeOpusCost: ModelCost = {
  input: 5.0,
  output: 25.0,
  cacheRead: 0.5,
  cacheWrite: 6.25,
};
export const gptOssCost: ModelCost = { input: 0.6, output: 2.4, cacheRead: 0.15, cacheWrite: 0.6 };

/** First match wins, so specific IDs go first. */
const STATIC_COST_RULES: Array<[RegExp, ModelCost]> = [
  [/^gemini-4-argon/i, gemini4ArgonCost],
  [/^gemini-.*flash-lite/i, geminiFlashLiteCost],
  [/^gemini-3\.5-flash/i, gemini35FlashCost],
  [/^gemini-3(?:\.[6-9])?-flash/i, gemini38FlashCost],
  [/^gemini-3\.\d+-pro/i, geminiProCost],
  [/^claude-opus/i, claudeOpusCost],
  [/^claude-sonnet/i, claudeSonnetCost],
  [/^gpt-oss/i, gptOssCost],
];

// ---- Upstream lookup --------------------------------------------------------------------
/** Antigravity public ID → [upstream provider, candidate upstream IDs]. */
function upstreamCandidates(publicId: string): [PricingProvider, string[]] | undefined {
  if (/^gemini-/i.test(publicId)) return ["google", [publicId, `${publicId}-preview`]];
  if (/^claude-/i.test(publicId)) return ["anthropic", [publicId]];
  return undefined;
}

function isUsableCost(value: unknown): value is ModelCost {
  if (!value || typeof value !== "object") return false;
  const cost = value as Partial<ModelCost>;
  return (
    typeof cost.input === "number" &&
    typeof cost.output === "number" &&
    (cost.input > 0 || cost.output > 0)
  );
}

function normalizeCost(cost: ModelCost): ModelCost {
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead ?? 0,
    cacheWrite: cost.cacheWrite ?? 0,
    ...(cost.tiers && cost.tiers.length > 0 ? { tiers: cost.tiers } : {}),
  };
}

function builtinCost(
  provider: PricingProvider,
  ids: string[],
  getModels: NonNullable<PricingSources["getModels"]>,
): unknown {
  try {
    const models: unknown = getModels(provider);
    if (!Array.isArray(models)) return undefined;
    for (const id of ids) {
      const hit = (models as Array<{ id?: string; cost?: unknown }>).find(
        (model) => model?.id === id,
      );
      if (hit && isUsableCost(hit.cost)) return hit.cost;
    }
  } catch {
    // A failed catalog lookup must not prevent a static price estimate.
  }
  return undefined;
}

/** No registry singleton or cached prices: each call reads the supplied sources anew. */
export function createPricingResolver({
  find,
  getModels = getBuiltinModels,
}: PricingSources = {}): PricingResolver {
  return (publicId) => {
    const candidates = upstreamCandidates(publicId);
    if (candidates) {
      const [provider, ids] = candidates;
      for (const id of ids) {
        try {
          const cost = find?.(provider, id)?.cost;
          if (isUsableCost(cost)) return normalizeCost(cost);
        } catch {
          // Registry unavailable mid-reload; try the next source.
        }
      }
      const builtin = builtinCost(provider, ids, getModels);
      if (isUsableCost(builtin)) return normalizeCost(builtin);
    }
    return STATIC_COST_RULES.find(([pattern]) => pattern.test(publicId))?.[1];
  };
}

/** Registry-free default for standalone discovery and SDK calls. */
export const costForModelId = createPricingResolver();

/** Re-resolve a chat model's price; leaves models with no known price untouched. */
export function repriceModel<T extends ProviderModelConfig>(
  model: T,
  resolveCost: PricingResolver = costForModelId,
): T {
  if (model.type === "image" || model.type === "classifier") return model;
  const cost = resolveCost(model.id);
  return cost ? { ...model, cost } : model;
}
