import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { costForModelId, repriceModel, type PricingResolver } from "./pricing.js";
import type { ModelInfoRaw } from "../types/types.js";

/** Image API key on this provider. Chat stays on `antigravity-api`. */
export const ANTIGRAVITY_IMAGE_API = "antigravity-images";

const IMAGE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Cold-start image models. Preview ids are registered only when discovery
 * advertises them; they are not part of this seed.
 */
export const ANTIGRAVITY_IMAGE_MODELS: ProviderModelConfig[] = [
  imageModel("gemini-3-pro-image", "Gemini 3 Pro Image"),
  imageModel("gemini-3.1-flash-image", "Gemini 3.1 Flash Image"),
];

export function isAntigravityImageModelId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 80 &&
    /^(gemini-[a-z0-9.+-]*image[a-z0-9.+-]*|imagen-[a-z0-9.+-]+)$/i.test(id)
  );
}

export function imageModel(id: string, name: string): ProviderModelConfig {
  return {
    id,
    name,
    type: "image",
    api: ANTIGRAVITY_IMAGE_API,
    input: ["text", "image"],
    output: ["text", "image"],
    cost: IMAGE_COST,
  };
}

function displayName(info: ModelInfoRaw | undefined, fallback: string): string {
  return typeof info?.displayName === "string" && info.displayName.trim()
    ? info.displayName.trim()
    : fallback;
}

/**
 * Seed models always remain. Discovery can rename them and add advertised image
 * ids, including previews. Chat grouping continues to drop these ids.
 */
export function buildAntigravityImageModels(
  rawModels?: Record<string, ModelInfoRaw>,
): ProviderModelConfig[] {
  const models = new Map<string, ProviderModelConfig>(
    ANTIGRAVITY_IMAGE_MODELS.map((model) => [model.id, model]),
  );
  for (const [id, info] of Object.entries(rawModels ?? {})) {
    if (!isAntigravityImageModelId(id) || info?.isInternal) continue;
    const existing = models.get(id);
    models.set(
      id,
      existing
        ? { ...existing, name: displayName(info, existing.name) }
        : imageModel(id, displayName(info, id)),
    );
  }
  return [...models.values()];
}

/** Chat models plus image models. A refresh must return this, or image models disappear. */
export function listProviderModels(
  catalog: { models: ProviderModelConfig[]; imageModels?: ProviderModelConfig[] },
  resolveCost: PricingResolver = costForModelId,
): ProviderModelConfig[] {
  const images = catalog.imageModels?.filter((model) => model.type === "image");
  return [
    ...catalog.models
      .filter((model) => model.type !== "image")
      .map((model) => repriceModel(model, resolveCost)),
    ...(images && images.length > 0 ? images : ANTIGRAVITY_IMAGE_MODELS),
  ];
}
