import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { AnalyzeFileSchema, executeAnalyzeFile } from "../files/index.js";
import { PersistentCredentialSource } from "../runtime/persistent-credential-source.js";
import { loadAntigravitySettings, updateAntigravitySettings } from "../settings.js";
import {
  DEFAULT_IMAGE_MODEL,
  imageModelCandidates,
  requestAntigravityImage,
  resolveImageSavePath,
  saveGeneratedImages,
  IMAGE_ASPECT_RATIOS,
  IMAGE_SIZE_TIERS,
  type GeneratedImage,
} from "../image/index.js";
import {
  executeUrlContext,
  executeWebSearch,
  UrlContextSchema,
  WebSearchSchema,
} from "../search/index.js";

const NO_CREDENTIALS = "No Antigravity credentials. Run /login antigravity first.";

export type AntigravityToolName = "web_search" | "url_context" | "generate_image" | "analyze_file";

export type AntigravityToolMeta = {
  name: AntigravityToolName;
  label: string;
  summary: string;
};

export type AntigravityToolState = AntigravityToolMeta & {
  enabled: boolean;
};

export const ANTIGRAVITY_TOOLS: readonly AntigravityToolMeta[] = [
  {
    name: "web_search",
    label: "Web Search",
    summary: "Google 联网搜索与实时信息检索",
  },
  {
    name: "url_context",
    label: "URL Context",
    summary: "网页、文档与 YouTube 视频内容解析",
  },
  {
    name: "generate_image",
    label: "Generate Image",
    summary: "Gemini 图像生成（保存至 .pi/generated-images/）",
  },
  {
    name: "analyze_file",
    label: "Analyze File",
    summary: "本地 PDF、音频与视频多模态分析",
  },
];

const KNOWN_TOOL_NAMES = new Set<string>(ANTIGRAVITY_TOOLS.map((t) => t.name));

export type ToolActivationController = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;

const registeredToolDefinitions = new Map<AntigravityToolName, { defaultActive?: boolean }>();

function isAntigravityToolName(value: unknown): value is AntigravityToolName {
  return typeof value === "string" && KNOWN_TOOL_NAMES.has(value);
}

export function loadDisabledTools(): Set<AntigravityToolName> {
  const list = loadAntigravitySettings().disabledTools;
  return new Set(Array.isArray(list) ? list.filter(isAntigravityToolName) : []);
}

function saveDisabledTools(disabled: Iterable<AntigravityToolName>): void {
  updateAntigravitySettings({
    disabledTools: [...new Set(disabled)].filter(isAntigravityToolName),
  });
}

export function isAntigravityToolEnabled(name: AntigravityToolName): boolean {
  return !loadDisabledTools().has(name);
}

export function getAntigravityToolStates(): AntigravityToolState[] {
  const disabled = loadDisabledTools();
  return ANTIGRAVITY_TOOLS.map((tool) => ({
    ...tool,
    enabled: !disabled.has(tool.name),
  }));
}

function syncDefinitionDefaultActive(disabled: Set<AntigravityToolName>): void {
  for (const tool of ANTIGRAVITY_TOOLS) {
    const def = registeredToolDefinitions.get(tool.name);
    if (def) {
      def.defaultActive = !disabled.has(tool.name);
    }
  }
}

function applyToolStatesToSession(
  pi: ToolActivationController | undefined,
  disabled: Set<AntigravityToolName>,
  explicitToggle?: { names: AntigravityToolName[]; enabled: boolean },
): void {
  syncDefinitionDefaultActive(disabled);
  if (!pi || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
    return;
  }
  try {
    const current = pi.getActiveTools();
    const next = new Set(current);
    for (const name of disabled) {
      next.delete(name);
    }
    if (explicitToggle?.enabled) {
      for (const name of explicitToggle.names) {
        if (!disabled.has(name)) next.add(name);
      }
    }
    const nextList = [...next];
    if (nextList.length !== current.length || nextList.some((name, idx) => name !== current[idx])) {
      pi.setActiveTools(nextList);
    }
  } catch {
    // Host may not have bound the session tool registry yet during early load.
  }
}

export function syncAntigravityToolsWithSession(pi?: ToolActivationController): void {
  const disabled = loadDisabledTools();
  applyToolStatesToSession(pi, disabled);
}

export function setAntigravityToolEnabled(
  name: AntigravityToolName,
  enabled: boolean,
  pi?: ToolActivationController,
): boolean {
  const disabled = loadDisabledTools();
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  saveDisabledTools(disabled);
  applyToolStatesToSession(pi, disabled, { names: [name], enabled });
  return enabled;
}

export function toggleAntigravityTool(
  name: AntigravityToolName,
  pi?: ToolActivationController,
): boolean {
  const nextEnabled = !isAntigravityToolEnabled(name);
  return setAntigravityToolEnabled(name, nextEnabled, pi);
}

export function setAllAntigravityToolsEnabled(
  enabled: boolean,
  pi?: ToolActivationController,
): void {
  const allNames = ANTIGRAVITY_TOOLS.map((t) => t.name);
  const disabled = new Set<AntigravityToolName>(enabled ? [] : allNames);
  saveDisabledTools(disabled);
  applyToolStatesToSession(pi, disabled, { names: allNames, enabled });
}

type PreferredImage = { images: GeneratedImage[]; text: string[]; model: string };

/**
 * Preference order for the tool only, with account rotation on quota errors.
 * Uses PersistentCredentialSource so image generation rotates through the full
 * account pool on 429 / quota exhaustion, matching the chat streaming path.
 *
 * Each model candidate is attempted up to MAX_RETRIES_PER_ATTEMPT times for
 * transient (non-quota) failures before moving to the next candidate or account.
 */
async function generateWithPreference(options: {
  credentialSource: PersistentCredentialSource;
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
  images?: Array<{ data: string; mimeType: string }>;
  model?: string;
  signal?: AbortSignal;
}): Promise<PreferredImage> {
  const candidates = imageModelCandidates(options.model);
  const triedTokens = new Set<string>();
  const maxRotations = 10;
  const maxRetriesPerAttempt = 3;
  const retryDelayMs = 2000;
  let rotations = 0;
  let lastError = "Antigravity image generation failed.";

  let creds = await options.credentialSource.current();
  triedTokens.add(creds.token);

  while (true) {
    for (const id of candidates) {
      if (options.signal?.aborted) throw new Error("Request was aborted");

      // Retry each candidate up to maxRetriesPerAttempt times for transient errors.
      for (let retry = 0; retry < maxRetriesPerAttempt; retry++) {
        if (retry > 0 && options.signal?.aborted) throw new Error("Request was aborted");
        const apiKey = JSON.stringify({ token: creds.token, projectId: creds.projectId });
        const attempted = await requestAntigravityImage({
          apiKey,
          model: id,
          prompt: options.prompt,
          aspectRatio: options.aspectRatio,
          imageSize: options.imageSize,
          images: options.images,
          signal: options.signal,
        });
        if (attempted.ok) {
          await options.credentialSource.succeeded();
          return { images: attempted.images, text: attempted.text, model: attempted.model };
        }
        if (attempted.aborted) throw new Error("Request was aborted");
        lastError = attempted.message;

        // Quota errors break out of the retry loop to rotate accounts instead.
        const isQuota = /quota|resource.+exhausted|rate.?limit|429/i.test(lastError);
        if (isQuota) break;

        // Non-quota transient error: wait before retrying the same model+account.
        if (retry < maxRetriesPerAttempt - 1) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (retry + 1)));
        }
      }
    }

    const isQuotaError = /quota|resource.+exhausted|rate.?limit|429/i.test(lastError);
    if (!isQuotaError || rotations >= maxRotations) break;

    const canRetry = await options.credentialSource.failed({
      runtimeModel: candidates[0] ?? "gemini-2.0-flash-exp",
      projectId: creds.projectId ?? "",
      status: 429,
      body: lastError,
    });
    if (!canRetry) break;

    const next = await options.credentialSource.rotate(triedTokens);
    if (triedTokens.has(next.token)) break;

    rotations++;
    triedTokens.add(next.token);
    creds = next;
  }

  await options.credentialSource.release();
  throw new Error(`Antigravity image generation failed: ${lastError}`);
}

function registerManagedTool<TParams extends ReturnType<typeof Type.Object>, TDetails = unknown>(
  pi: ExtensionAPI,
  name: AntigravityToolName,
  definition: ToolDefinition<TParams, TDetails>,
): void {
  const managed: ToolDefinition<TParams, TDetails> = {
    ...definition,
    defaultActive: isAntigravityToolEnabled(name),
  };
  registeredToolDefinitions.set(name, managed);
  pi.registerTool(managed);
}

export function registerAntigravityTools(pi: ExtensionAPI): void {
  registerManagedTool(pi, "analyze_file", {
    name: "analyze_file",
    label: "Analyze File",
    description:
      "Analyze a local PDF, audio, or video with Gemini via Antigravity when local reading is difficult. Specify exactly what to extract or produce and the desired format; returns only text, including code or structured data. Sends the file to Google without mounting it.",
    promptSnippet:
      "Analyze local PDFs, audio, and video with Gemini; return task-specific text or code",
    promptGuidelines: [
      "Use analyze_file for local PDFs, audio, or video that are difficult to read locally. Keep instruction scoped to the information or output you need. For public URLs or YouTube, use url_context.",
      "Timestamps, verbatim transcription, speaker labels, and reconstructed layouts may be approximate. This tool does not extract original binary assets.",
    ],
    parameters: AnalyzeFileSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
      if (!apiKey) throw new Error(NO_CREDENTIALS);
      return executeAnalyzeFile({
        apiKey,
        cwd: ctx.cwd,
        path: params.path,
        instruction: params.instruction,
        signal,
        onUpdate,
      });
    },
  });

  registerManagedTool(pi, "generate_image", {
    name: "generate_image",
    label: "Generate image",
    description:
      "Generate an image via Antigravity using the signed-in Google account. Saves under .pi/generated-images/ unless path is set.",
    promptSnippet: "Generate images via Antigravity OAuth (Gemini image models)",
    promptGuidelines: [
      "Use generate_image when the user asks to create, draw, or generate an image.",
      "generate_image saves the file and accepts aspectRatio. models.generateImages can call the same Antigravity image models when codemode is on, including with reference images, but that path neither saves files nor sets a ratio.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Image description." }),
      aspectRatio: Type.Optional(StringEnum(IMAGE_ASPECT_RATIOS)),
      imageSize: Type.Optional(
        StringEnum(IMAGE_SIZE_TIERS, {
          description:
            "Output resolution tier ('1K', '2K', '4K'). Use '4K' for ultra-high resolution.",
        }),
      ),
      referenceImages: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Local file paths to reference images (PNG, JPEG, WEBP) for image editing or conditioning.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: `Image model id. Default: ${DEFAULT_IMAGE_MODEL}.`,
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: "Project-relative file or directory to save the image.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Use PersistentCredentialSource for account rotation, same as chat streaming.
      // Fall back to the host-provided single key only if parseApiKey works.
      const hostKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
      if (!hostKey) throw new Error(NO_CREDENTIALS);
      // Resolve the runtime model for the credential source from the first image candidate.
      const runtimeModel = imageModelCandidates(params.model)[0] ?? "gemini-2.0-flash-exp";
      const credentialSource = new PersistentCredentialSource(runtimeModel);
      if (params.path) resolveImageSavePath(ctx.cwd, params.path);
      const images: Array<{ data: string; mimeType: string }> = [];
      if (params.referenceImages?.length) {
        const fs = await import("node:fs");
        const nodePath = await import("node:path");
        const MIME: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".webp": "image/webp",
        };
        for (const ref of params.referenceImages) {
          const abs = nodePath.resolve(ctx.cwd, ref);
          const ext = nodePath.extname(abs).toLowerCase();
          const mimeType = MIME[ext];
          if (!mimeType) throw new Error(`Unsupported reference image format: ${ext}`);
          const data = fs.readFileSync(abs).toString("base64");
          images.push({ data, mimeType });
        }
      }
      onUpdate?.({ content: [{ type: "text", text: "Generating image…" }], details: {} });
      const result = await generateWithPreference({
        credentialSource,
        prompt: params.prompt,
        aspectRatio: params.aspectRatio,
        imageSize: params.imageSize,
        images: images.length ? images : undefined,
        model: params.model,
        signal,
      });
      const savedPaths = await saveGeneratedImages(ctx.cwd, result.images, params.path);
      const notes = result.text.join(" ").trim();
      return {
        content: [
          {
            type: "text" as const,
            text: `Saved image to ${savedPaths.join(", ")}${notes ? `. ${notes}` : ""}`,
          },
          ...result.images.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ],
        details: { model: result.model, savedPaths },
      };
    },
  });

  registerManagedTool(pi, "web_search", {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Google Search via Antigravity for current information, news, and answers. Optionally include URLs to analyze alongside search results.",
    promptSnippet: "Search the web via Google Search (Antigravity)",
    promptGuidelines: [
      "Use web_search to find current information, recent events, news, documentation, or answers on the web.",
    ],
    parameters: WebSearchSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
      if (!apiKey) throw new Error(NO_CREDENTIALS);
      return executeWebSearch({
        apiKey,
        query: params.query,
        urls: params.urls,
        signal,
        onUpdate,
      });
    },
  });

  registerManagedTool(pi, "url_context", {
    name: "url_context",
    label: "URL Context",
    description:
      "Directly analyze, extract, and summarize content from up to 20 public URLs (articles, documentation, web pages, and YouTube videos) via Antigravity.",
    promptSnippet: "Extract and summarize web pages or YouTube videos via Antigravity",
    promptGuidelines: [
      "Use url_context to read, analyze, and extract content from specific URLs or YouTube videos.",
    ],
    parameters: UrlContextSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
      if (!apiKey) throw new Error(NO_CREDENTIALS);
      return executeUrlContext({
        apiKey,
        urls: params.urls,
        query: params.query,
        signal,
        onUpdate,
      });
    },
  });

  if (typeof pi.on === "function") {
    pi.on("session_start", () => {
      syncAntigravityToolsWithSession(pi);
    });
  }
}
