import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { AnalyzeFileSchema, executeAnalyzeFile } from "../files/index.js";
import {
  DEFAULT_IMAGE_MODEL,
  imageModelCandidates,
  requestAntigravityImage,
  resolveImageSavePath,
  saveGeneratedImages,
  IMAGE_ASPECT_RATIOS,
  type GeneratedImage,
} from "../image/index.js";
import {
  executeUrlContext,
  executeWebSearch,
  UrlContextSchema,
  WebSearchSchema,
} from "../search/index.js";

const NO_CREDENTIALS = "No Antigravity credentials. Run /login antigravity first.";

type PreferredImage = { images: GeneratedImage[]; text: string[]; model: string };

/**
 * Preference order for the tool only. `generateAntigravityImages` is the Pi 1.0
 * provider operation and never substitutes models; the file path, the aspect
 * ratio, and the fallback loop live here.
 */
async function generateWithPreference(options: {
  apiKey: string;
  prompt: string;
  aspectRatio?: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<PreferredImage> {
  let lastError = "Antigravity image generation failed.";
  for (const id of imageModelCandidates(options.model)) {
    const attempted = await requestAntigravityImage({
      apiKey: options.apiKey,
      model: id,
      prompt: options.prompt,
      aspectRatio: options.aspectRatio,
      signal: options.signal,
    });
    if (attempted.ok) {
      return { images: attempted.images, text: attempted.text, model: attempted.model };
    }
    if (attempted.aborted) throw new Error("Request was aborted");
    lastError = attempted.message;
  }
  throw new Error(`Antigravity image generation failed: ${lastError}`);
}

export function registerAntigravityTools(pi: ExtensionAPI): void {
  pi.registerTool({
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

  pi.registerTool({
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
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
      if (!apiKey) throw new Error(NO_CREDENTIALS);
      if (params.path) resolveImageSavePath(ctx.cwd, params.path);
      onUpdate?.({ content: [{ type: "text", text: "Generating image…" }], details: {} });
      const result = await generateWithPreference({
        apiKey,
        prompt: params.prompt,
        aspectRatio: params.aspectRatio,
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

  pi.registerTool({
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

  pi.registerTool({
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
}
