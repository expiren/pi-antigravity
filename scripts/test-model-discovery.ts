import { antigravityHeaders, mergeAvailableModelsResults } from "../src/client/index.js";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_PERSIST_KEY,
  ANTIGRAVITY_ROUTING,
  applyAntigravityCatalog,
  buildAntigravityCatalog,
  buildAntigravityImageModels,
  clearModelEnumCache,
  costForModelId,
  getAntigravityRequestModelId,
  getCurrentAntigravityCatalog,
  getModelEnum,
  hydrateAntigravityCatalog,
  isDisabledModel,
  isExcludedModel,
  refreshAntigravityModels,
  registerModelEnum,
  listProviderModels,
  resetAntigravityCatalogForTests,
  snapshotDynamicModelEnums,
  type AntigravityCatalog,
} from "../src/models/index.js";
import { ANTIGRAVITY_IMAGE_API, isAntigravityImageModelId } from "../src/models/image-catalog.js";
import type { ModelInfoRaw } from "../src/types/types.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function publishedPersistModels(
  published: unknown,
): Array<{ id?: string; type?: string; api?: string }> | undefined {
  if (!published || typeof published !== "object") return undefined;
  const persist = "persist" in published ? published.persist : undefined;
  if (!persist || typeof persist !== "object" || !("models" in persist)) return undefined;
  return Array.isArray(persist.models) ? persist.models : undefined;
}

const fallback: AntigravityCatalog = { models: ANTIGRAVITY_MODELS, routing: ANTIGRAVITY_ROUTING };
const info = (displayName: string, extra?: Partial<ModelInfoRaw>): ModelInfoRaw => ({
  displayName,
  supportsThinking: true,
  supportsImages: true,
  ...extra,
});

const catalog = buildAntigravityCatalog(
  {
    "gemini-3.9-flash-low": info("Gemini 3.9 Flash (Low)"),
    "gemini-3.9-flash-medium": info("Gemini 3.9 Flash (Medium)"),
    "gemini-3.9-flash-high": info("Gemini 3.9 Flash (High)"),
    chat_hidden: info("Hidden chat"),
    "gemini-3.1-flash-image": info("Gemini 3.1 Flash Image"),
  },
  fallback,
);
const gemini39 = catalog.models.find((model) => model.id === "gemini-3.9-flash");
assert(Boolean(gemini39), "discovers new model families");
assert(
  gemini39?.inputLimits?.images?.resize?.maxWidth === 2000,
  "synthesized model inherits inputLimits from template",
);
const fallbackGemini = fallback.models.find((model) => model.id === "gemini-3.8-flash");
assert(
  fallbackGemini?.inputLimits?.images?.resize?.maxBytes === 4718592,
  "static catalog provides image input limits",
);
assert(!catalog.models.some((model) => model.id === "chat_hidden"), "filters hidden models");
assert(!catalog.models.some((model) => model.id === "gemini-3-pro-image"), "filters image models");
const imageModels = buildAntigravityImageModels({
  "gemini-3-pro-image": info("Gemini 3 Pro Image"),
  "gemini-3-pro-image-preview": info("Gemini 3 Pro Image Preview"),
  "gemini-3.9-flash-low": info("Gemini 3.9 Flash (Low)"),
});
assert(
  imageModels.some((model) => model.id === "gemini-3.1-flash-image" && model.type === "image"),
  "keeps the image seed",
);
assert(
  imageModels.some((model) => model.id === "gemini-3-pro-image" && model.type === "image"),
  "discovery adds advertised image ids from rawModels",
);
assert(
  imageModels.some((model) => model.id === "gemini-3-pro-image-preview" && model.api === ANTIGRAVITY_IMAGE_API),
  "discovery adds advertised image ids",
);
assert(!imageModels.some((model) => model.id === "gemini-3.9-flash-low"), "image catalog ignores chat ids");
const listed = listProviderModels(catalog);
assert(listed.some((model) => model.id === "gemini-3.9-flash"), "provider list keeps chat models");
assert(
  listed.some((model) => model.id === "gemini-3.1-flash-image" && model.type === "image"),
  "provider list appends image models when the chat catalog omitted them",
);
assert(
  catalog.routing["gemini-3.9-flash"]?.routing?.medium === "gemini-3.9-flash-medium",
  "routes discovered thinking variants",
);

// ── Banana model regex ──
assert(isAntigravityImageModelId("gemini-nano-banana-2.1"), "banana model matches image regex");
assert(isAntigravityImageModelId("gemini-nano-banana-2.1-preview"), "banana preview matches image regex");
assert(!isAntigravityImageModelId("gemini-3.9-flash-low"), "chat model does not match image regex");

// ── buildAntigravityImageModels with imageGenerationModelIds ──
const withApiIds = buildAntigravityImageModels(
  {},
  ["gemini-nano-banana-2.1", "gemini-3.1-flash-image"],
);
assert(
  withApiIds.some((model) => model.id === "gemini-nano-banana-2.1" && model.type === "image"),
  "imageGenerationModelIds registers banana models",
);
assert(
  withApiIds.some((model) => model.id === "gemini-3.1-flash-image"),
  "imageGenerationModelIds does not duplicate seed models",
);
const withBadIds = buildAntigravityImageModels({}, [""]);
assert(!withBadIds.some((model) => model.id === ""), "empty string rejected from imageGenerationModelIds");

// Provider-owned persistence restores routing and dynamic enums before offline/network checks.
const dynamicCatalog = buildAntigravityCatalog(
  { "gemini-9.9-flash-low": info("Gemini 9.9 Flash (Low)") },
  fallback,
);
applyAntigravityCatalog(dynamicCatalog);
clearModelEnumCache();
registerModelEnum("gemini-9.9-flash-low", "MODEL_DYNAMIC_999");
const stored = {
  [ANTIGRAVITY_PERSIST_KEY]: {
    catalog: dynamicCatalog,
    checkedAt: Date.now(),
    modelEnums: snapshotDynamicModelEnums(),
  },
};
resetAntigravityCatalogForTests();
clearModelEnumCache();

const originalFetch = globalThis.fetch;
let networkCalled = false;
globalThis.fetch = async () => {
  networkCalled = true;
  throw new Error("offline restart must not fetch");
};
try {
  const offline = await refreshAntigravityModels({
    credential: undefined,
    stored,
    allowNetwork: false,
    force: false,
    signal: new AbortController().signal,
    publish: async () => true,
  });
  assert(
    offline.some((model) => model.id === "gemini-9.9-flash"),
    "dynamic-only models survive an offline restart",
  );
  assert(
    getAntigravityRequestModelId("gemini-9.9-flash", "low") === "gemini-9.9-flash-low",
    "offline restart restores dynamic routing",
  );
  assert(getModelEnum("gemini-9.9-flash-low") === "MODEL_DYNAMIC_999", "restores dynamic enums");
  assert(
    getModelEnum("gemini-9.9-flash") === "MODEL_DYNAMIC_999",
    "base runtime overrides resolve a routed dynamic enum",
  );
  assert(!networkCalled, "offline refresh does not touch the network");
} finally {
  globalThis.fetch = originalFetch;
}

// Fresh persisted state is hydrated before the TTL check.
globalThis.fetch = async () => {
  networkCalled = true;
  throw new Error("fresh catalog should skip network");
};
try {
  await refreshAntigravityModels({
    credential: { type: "api_key", key: JSON.stringify({ token: "fake", projectId: "fake" }) },
    stored,
    allowNetwork: true,
    force: false,
    signal: new AbortController().signal,
    publish: async () => true,
  });
  assert(!networkCalled, "fresh persisted state skips discovery");
} finally {
  globalThis.fetch = originalFetch;
}

// A successful discovery stores all extension-private state in models-store.json.
let published: unknown;
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      models: {
        "gemini-4-argon-low": info("Gemini 4 Argon (Low)", { model: "MODEL_ARGON_LOW" }),
        "gemini-4-argon-medium": info("Gemini 4 Argon (Medium)", { model: "MODEL_ARGON_MEDIUM" }),
        "gemini-4-argon-high": info("Gemini 4 Argon (High)", { model: "MODEL_ARGON_HIGH" }),
        "gemini-10.0-flash-low": {
          displayName: "Gemini 10.0 Flash (Low)",
          model: "MODEL_DYNAMIC_1000",
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
try {
  await refreshAntigravityModels({
    credential: { type: "api_key", key: JSON.stringify({ token: "fake", projectId: "fake" }) },
    stored: undefined,
    allowNetwork: true,
    force: true,
    signal: new AbortController().signal,
    publish: async (value: unknown) => {
      published = value;
      return true;
    },
  });
  const persisted = (published as { persist?: Record<string, unknown> } | undefined)?.persist?.[
    ANTIGRAVITY_PERSIST_KEY
  ] as { catalog?: AntigravityCatalog; modelEnums?: Record<string, string> } | undefined;
  assert(persisted?.catalog?.routing, "persists routing with the model list");
  const argon = persisted.catalog.models.find((model) => model.id === "gemini-4-argon");
  assert(argon?.name === "Gemini 4 Argon (Antigravity)", "discovers Argon without a static seed");
  assert(argon && "thinkingLevelMap" in argon, "Argon exposes thinking controls");
  const argonCost = costForModelId("gemini-4-argon");
  assert(
    argonCost &&
      argon.cost.input === argonCost.input &&
      argon.cost.output === argonCost.output &&
      argon.cost.cacheRead === argonCost.cacheRead,
    "Argon uses its resolved pricing instead of the first Flash template",
  );
  const price = (id: string) => ANTIGRAVITY_MODELS.find((model) => model.id === id)?.cost;
  assert(price("gemini-3.8-flash")?.input === 0.75, "Gemini 3.8 Flash price");
  // gemini-3.5-flash removed from ANTIGRAVITY_MODELS (retired); verify via costForModelId
  assert(price("gemini-3.5-flash") === undefined, "Retired gemini-3.5-flash not in static seeds");
  assert(price("claude-opus-4-6")?.input === 5, "Claude Opus 4.6 price");
  assert(price("claude-sonnet-4-6")?.output === 15, "Claude Sonnet 4.6 price");
  assert(price("gemini-4-hydrogen")?.input === 1.5, "Gemini 4 Hydrogen price input");
  assert(price("gemini-4-hydrogen")?.output === 7.5, "Gemini 4 Hydrogen price output");
  assert(price("gemini-4-hydrogen")?.cacheRead === 0.15, "Gemini 4 Hydrogen price cacheRead");
  for (const level of ["low", "medium", "high"] as const) {
    const runtimeId = `gemini-4-argon-${level}`;
    assert(argon.thinkingLevelMap?.[level] === level, `Argon advertises ${level}`);
    assert(getAntigravityRequestModelId("gemini-4-argon", level) === runtimeId, `routes Argon ${level}`);
    assert(persisted.modelEnums?.[runtimeId] === `MODEL_ARGON_${level.toUpperCase()}`, `persists Argon ${level} enum`);
  }
  assert(
    persisted?.modelEnums?.["gemini-10.0-flash-low"] === "MODEL_DYNAMIC_1000",
    "persists discovered enum values",
  );
  const storedModels = publishedPersistModels(published);
  assert(storedModels?.some((model) => model.id === "gemini-4-argon"), "publishes Argon to Pi");
  const storedImage = storedModels?.find((model) => model.id === "gemini-3.1-flash-image");
  assert(storedImage?.type === "image" && storedImage.api === ANTIGRAVITY_IMAGE_API, "persists image models as image");
  assert(
    storedModels?.some((model) => model.id === "gemini-10.0-flash" && model.type !== "image"),
    "persists discovered chat models without retagging them",
  );
} finally {
  globalThis.fetch = originalFetch;
  resetAntigravityCatalogForTests();
  clearModelEnumCache();
}

assert(hydrateAntigravityCatalog(undefined) === 0, "ignores absent stored data");
assert(hydrateAntigravityCatalog({ [ANTIGRAVITY_PERSIST_KEY]: {} }) === 0, "ignores malformed state");
mergeAvailableModelsResults([
  {
    endpoint: "https://cloudcode-pa.googleapis.com",
    status: 200,
    data: { models: { "catalog-dynamic": { model: "MODEL_CATALOG_DYNAMIC" } } },
  },
]);
assert(getModelEnum("catalog-dynamic") === "MODEL_CATALOG_DYNAMIC", "registers discovery enums");
assert(
  !("Accept" in antigravityHeaders("test-token")),
  "discovery must not inject an Accept header",
);

// ── Disabled model filtering ──

// isDisabledModel: info.disabled === true excluded even without -disabled suffix
assert(isDisabledModel("gemini-4-hydrogen", { disabled: true }), "disabled flag rejects model");
assert(!isDisabledModel("gemini-4-hydrogen-sonar"), "non-disabled ID without info passes");
assert(!isDisabledModel("gemini-4-hydrogen-sonar", {}), "non-disabled ID with empty info passes");

// isDisabledModel: -disabled IDs excluded even without disabled flag in info
assert(isDisabledModel("gemini-4-argon-disabled"), "disabled suffix rejects without info");
assert(isDisabledModel("gemini-4-argon-disabled", {}), "disabled suffix rejects with empty info");
assert(isDisabledModel("gemini-4-carbon-disabled", { disabled: false }), "disabled suffix overrides false flag");

// buildAntigravityCatalog excludes disabled models from groups
const disabledCatalog = buildAntigravityCatalog(
  {
    "gemini-4-argon-disabled": info("Gemini 4 Argon (Disabled)", { disabled: true }),
    "gemini-4-carbon-disabled": info("Gemini 4 Carbon (Disabled)"),
    "gemini-4-hydrogen-disabled": info("Gemini 4 Hydrogen (Disabled)", { disabled: true }),
    "gemini-4-neon-disabled": info("Gemini 4 Neon (Disabled)", { disabled: true }),
    "gemini-4-hydrogen-sonar": { supportsThinking: true, supportsImages: true },
    "gemini-3.9-flash-low": info("Gemini 3.9 Flash (Low)"),
  },
  fallback,
);
assert(
  !disabledCatalog.models.some((m) => /-disabled/i.test(m.id)),
  "no -disabled models in catalog",
);
assert(
  disabledCatalog.models.some((m) => m.id === "gemini-4-hydrogen-sonar"),
  "gemini-4-hydrogen-sonar is included as selectable",
);
const sonar = disabledCatalog.models.find((m) => m.id === "gemini-4-hydrogen-sonar");
assert(
  sonar?.name === "Gemini 4 Hydrogen Sonar (Antigravity)",
  "gemini-4-hydrogen-sonar gets clean display name",
);
assert(
  disabledCatalog.models.some((m) => m.id === "gemini-3.9-flash"),
  "non-disabled models still grouped normally",
);

// info.disabled: true excluded even on IDs without -disabled suffix
const flagOnlyCatalog = buildAntigravityCatalog(
  {
    "gemini-4-hydrogen": info("Gemini 4 Hydrogen", { disabled: true }),
    "gemini-3.9-flash-low": info("Gemini 3.9 Flash (Low)"),
  },
  fallback,
);
assert(
  !flagOnlyCatalog.models.some((m) => m.id === "gemini-4-hydrogen"),
  "disabled flag without suffix still excluded",
);

// Stale cached catalog with -disabled entries gets cleaned during hydration
resetAntigravityCatalogForTests();
const staleCatalog: AntigravityCatalog = buildAntigravityCatalog(
  {
    "gemini-3.9-flash-low": info("Gemini 3.9 Flash (Low)"),
  },
  fallback,
);
// Inject a stale -disabled model that slipped into an older persisted catalog
staleCatalog.models.push({
  id: "gemini-4-argon-disabled",
  name: "Gemini 4 Argon Disabled (Antigravity)",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
});
staleCatalog.routing["gemini-4-argon-disabled"] = { defaultRequestId: "gemini-4-argon-disabled" };
hydrateAntigravityCatalog({
  [ANTIGRAVITY_PERSIST_KEY]: {
    catalog: staleCatalog,
    checkedAt: Date.now(),
    modelEnums: {},
  },
});
const afterHydrate = getCurrentAntigravityCatalog();
assert(
  !afterHydrate.models.some((m) => /-disabled/i.test(m.id)),
  "hydration strips stale -disabled models from persisted catalog",
);
assert(
  afterHydrate.models.some((m) => m.id === "gemini-3.9-flash"),
  "hydration preserves non-disabled models from persisted catalog",
);
resetAntigravityCatalogForTests();

// ── Tier-gated (excluded) model filtering ──

assert(isExcludedModel("gemini-2.5-pro"), "gemini-2.5-pro is excluded on starter pools");
assert(!isExcludedModel("gemini-3.8-flash"), "active models are not excluded");
assert(!isExcludedModel("gemini-4-hydrogen-sonar"), "preview models are not excluded");

// env override bypasses the exclusion
process.env.PI_ANTIGRAVITY_ALLOW_BLOCKED_MODELS = "1";
assert(!isExcludedModel("gemini-2.5-pro"), "env override unblocks gemini-2.5-pro");
delete process.env.PI_ANTIGRAVITY_ALLOW_BLOCKED_MODELS;
assert(isExcludedModel("gemini-2.5-pro"), "exclusion restored after env removal");

// buildAntigravityCatalog drops excluded models from discovered groups
const excludedCatalog = buildAntigravityCatalog(
  {
    "gemini-2.5-pro-low": info("Gemini 2.5 Pro (Low)"),
    "gemini-3.9-flash-low": info("Gemini 3.9 Flash (Low)"),
  },
  fallback,
);
assert(
  !excludedCatalog.models.some((m) => m.id === "gemini-2.5-pro"),
  "gemini-2.5-pro excluded from catalog build",
);
assert(
  excludedCatalog.models.some((m) => m.id === "gemini-3.9-flash"),
  "non-excluded models still in catalog",
);

// ── Undiscovered fallback models are NOT re-injected ──

// When discovery returns real models, static seeds that were NOT discovered
// should not appear in the catalog (previous behavior injected them).
const discoveryOnly = buildAntigravityCatalog(
  {
    "gemini-99.0-flash-low": info("Gemini 99.0 Flash (Low)"),
  },
  fallback,
);
assert(
  discoveryOnly.models.some((m) => m.id === "gemini-99.0-flash"),
  "discovered model is in catalog",
);
// Static seeds like gemini-3.8-flash should NOT appear because they were not discovered
assert(
  !discoveryOnly.models.some((m) => m.id === "gemini-3.8-flash"),
  "undiscovered static seed gemini-3.8-flash not re-injected",
);
assert(
  !discoveryOnly.models.some((m) => m.id === "claude-opus-4-6"),
  "undiscovered static seed claude-opus-4-6 not re-injected",
);

// Retired model IDs are not in ANTIGRAVITY_MODELS or ANTIGRAVITY_ROUTING
for (const retired of ["gemini-3.1-pro", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.7-flash"]) {
  assert(
    !ANTIGRAVITY_MODELS.some((m) => m.id === retired),
    `${retired} not in ANTIGRAVITY_MODELS`,
  );
  assert(
    !ANTIGRAVITY_ROUTING[retired],
    `${retired} not in ANTIGRAVITY_ROUTING`,
  );
}

// ── Gemini 4 Hydrogen: tiered-variant key-order invariant ──

// Discovery lists -tiered-<level> BEFORE the non-tiered primary.  The non-tiered
// primary must overwrite the slot so routing hits the primary runtime ID.
const hydrogenCatalog = buildAntigravityCatalog(
  {
    "gemini-4-hydrogen-tiered-xhigh": info("Gemini 4 Hydrogen (XHigh)"),
    "gemini-4-hydrogen-xhigh": info("Gemini 4 Hydrogen (XHigh)"),
    "gemini-4-hydrogen-tiered-high": info("Gemini 4 Hydrogen (High)"),
    "gemini-4-hydrogen-high": info("Gemini 4 Hydrogen (High)"),
    "gemini-4-hydrogen-medium": info("Gemini 4 Hydrogen (Medium)"),
    "gemini-4-hydrogen-low": info("Gemini 4 Hydrogen (Low)"),
    "gemini-4-hydrogen-sonar": info("Gemini 4 Hydrogen Sonar"),
  },
  fallback,
);
applyAntigravityCatalog(hydrogenCatalog);

const h4 = hydrogenCatalog.models.find((m) => m.id === "gemini-4-hydrogen");
assert(h4, "hydrogen groups into gemini-4-hydrogen");
assert(h4.maxTokens === 262144, "hydrogen inherits 262144 maxTokens from static seed");

// Non-tiered primary must own the slot (overwrites -tiered- variant).
assert(
  getAntigravityRequestModelId("gemini-4-hydrogen", "xhigh") === "gemini-4-hydrogen-xhigh",
  "non-tiered xhigh overwrites tiered-xhigh",
);
assert(
  getAntigravityRequestModelId("gemini-4-hydrogen", "high") === "gemini-4-hydrogen-high",
  "non-tiered high overwrites tiered-high",
);
assert(
  getAntigravityRequestModelId("gemini-4-hydrogen", "low") === "gemini-4-hydrogen-low",
  "hydrogen routes low",
);

// Sonar is a separate selectable model (no displayName family match).
const h4Sonar = hydrogenCatalog.models.find((m) => m.id === "gemini-4-hydrogen-sonar");
assert(h4Sonar, "sonar is an independent selectable model");

resetAntigravityCatalogForTests();

console.log("model discovery: persisted offline catalog, dynamic enums, and TTL passed");
