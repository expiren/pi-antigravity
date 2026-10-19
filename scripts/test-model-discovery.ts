import { antigravityHeaders, mergeAvailableModelsResults } from "../src/client/index.js";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_PERSIST_KEY,
  ANTIGRAVITY_ROUTING,
  applyAntigravityCatalog,
  buildAntigravityCatalog,
  buildAntigravityImageModels,
  clearModelEnumCache,
  getAntigravityRequestModelId,
  getModelEnum,
  hydrateAntigravityCatalog,
  refreshAntigravityModels,
  registerModelEnum,
  listProviderModels,
  resetAntigravityCatalogForTests,
  snapshotDynamicModelEnums,
  type AntigravityCatalog,
} from "../src/models/index.js";
import { ANTIGRAVITY_IMAGE_API } from "../src/models/image-catalog.js";
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
    "gemini-3-pro-image": info("Gemini 3 Pro Image"),
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
  imageModels.some((model) => model.id === "gemini-3-pro-image" && model.type === "image"),
  "keeps the image seed",
);
assert(
  imageModels.some((model) => model.id === "gemini-3-pro-image-preview" && model.api === ANTIGRAVITY_IMAGE_API),
  "discovery adds advertised image ids",
);
assert(!imageModels.some((model) => model.id === "gemini-3.9-flash-low"), "image catalog ignores chat ids");
const listed = listProviderModels(catalog);
assert(listed.some((model) => model.id === "gemini-3.9-flash"), "provider list keeps chat models");
assert(
  listed.some((model) => model.id === "gemini-3-pro-image" && model.type === "image"),
  "provider list appends image models when the chat catalog omitted them",
);
assert(
  catalog.routing["gemini-3.9-flash"]?.routing?.medium === "gemini-3.9-flash-medium",
  "routes discovered thinking variants",
);

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
  const storedImage = storedModels?.find((model) => model.id === "gemini-3-pro-image");
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

console.log("model discovery: persisted offline catalog, dynamic enums, and TTL passed");
