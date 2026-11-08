import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AssistantImages,
  ImageApi,
  ImageModel,
  ImagesContext,
  ImagesOptions,
} from "@earendil-works/pi-ai";
import { streamGenerateContent, type StreamGenerateChunk } from "../client/stream-generate.js";
import {
  ANTIGRAVITY_IMAGE_API,
  ANTIGRAVITY_IMAGE_MODELS,
  isAntigravityImageModelId,
} from "../models/image-catalog.js";
import { antigravityRequestEnvelope, sanitizeText } from "../utils/util.js";

export const DEFAULT_IMAGE_MODEL = "gemini-3-pro-image";
export const IMAGE_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

export const IMAGE_SIZE_TIERS = ["1K", "2K", "4K"] as const;
export type ImageSizeTier = (typeof IMAGE_SIZE_TIERS)[number];

/**
 * Tool-only preference order, seeded from the image catalog so the two lists
 * cannot drift. The provider operation must not substitute models.
 */
export const IMAGE_MODEL_CANDIDATES: readonly string[] = [
  DEFAULT_IMAGE_MODEL,
  ...ANTIGRAVITY_IMAGE_MODELS.map((model) => model.id).filter((id) => id !== DEFAULT_IMAGE_MODEL),
  // Advertised as a preview only; discovery may not have registered it yet.
  "gemini-3-pro-image-preview",
];
const IMAGE_SYSTEM_INSTRUCTION =
  "You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request.";
const DEFAULT_IMAGE_DIR = join(".pi", "generated-images");
const MAX_PROMPT_CHARS = 8000;

export type GeneratedImage = { data: string; mimeType: string };

export type ImageRequestPart =
  { text: string } | { inlineData: { mimeType: string; data: string } };

export type ImageGenerateRequest = {
  project: string;
  model: string;
  request: {
    contents: Array<{ role: "user"; parts: ImageRequestPart[] }>;
    systemInstruction: { role: "user"; parts: Array<{ text: string }> };
    generationConfig: {
      imageConfig: { aspectRatio: string; imageSize?: string };
      candidateCount: number;
    };
  };
  requestType: "agent";
  userAgent: "antigravity";
  requestId: string;
};

function imageExtension(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("gif")) return "gif";
  return "png";
}

export function assertSafeImageModel(modelId: string): string {
  const id = modelId.trim();
  if (!isAntigravityImageModelId(id)) {
    throw new Error(`Unsupported image model: ${id}`);
  }
  return id;
}

export function assertSafeAspectRatio(ratio: string): ImageAspectRatio {
  const value = ratio.trim();
  for (const allowed of IMAGE_ASPECT_RATIOS) {
    if (allowed === value) return allowed;
  }
  throw new Error(
    `Unsupported aspect ratio: ${value}. Use one of ${IMAGE_ASPECT_RATIOS.join(", ")}.`,
  );
}

export function resolveImageSavePath(
  cwd: string,
  requested?: string,
  mimeType = "image/png",
  index?: number,
): string {
  const ext = imageExtension(mimeType);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = index === undefined ? "" : `-${index + 1}`;
  const defaultName = `image-${stamp}${suffix}.${ext}`;
  const root = resolve(cwd);
  const target = requested?.trim()
    ? resolve(root, requested.trim())
    : resolve(root, DEFAULT_IMAGE_DIR, defaultName);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Image save path must be inside the working directory.");
  }
  if (!extname(target)) return join(target, defaultName);
  if (index === undefined) return target;
  const currentExt = extname(target);
  return `${target.slice(0, -currentExt.length)}${suffix}${currentExt}`;
}

export function imageModelCandidates(preferred?: string): string[] {
  const id = assertSafeImageModel(preferred?.trim() || DEFAULT_IMAGE_MODEL);
  return [id, ...IMAGE_MODEL_CANDIDATES.filter((candidate) => candidate !== id)];
}

export function inlineImageData(
  data: string,
  mimeType = "image/png",
): { mimeType: string; data: string } {
  const match = data.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return { mimeType, data: data.trim() };
  return { mimeType: match[1] || mimeType, data: match[2].trim() };
}

function imageRequestBody(
  prompt: string,
  aspectRatio: string,
  images: Array<{ data: string; mimeType: string }>,
  imageSize?: string,
): ImageGenerateRequest["request"] {
  const parts: ImageRequestPart[] = [];
  for (const image of images) {
    parts.push({ inlineData: inlineImageData(image.data, image.mimeType) });
  }
  parts.push({ text: sanitizeText(prompt) });
  return {
    contents: [{ role: "user", parts }],
    systemInstruction: {
      role: "user",
      parts: [{ text: IMAGE_SYSTEM_INSTRUCTION }],
    },
    generationConfig: {
      imageConfig: {
        aspectRatio,
        ...(imageSize ? { imageSize } : {}),
      },
      candidateCount: 1,
    },
  };
}

export function buildImageGenerateRequest(
  prompt: string,
  model: string,
  projectId: string,
  aspectRatio: string,
  images: Array<{ data: string; mimeType: string }> = [],
  imageSize?: string,
): ImageGenerateRequest {
  const envelope = antigravityRequestEnvelope(model, false);
  return {
    project: projectId,
    model,
    request: imageRequestBody(prompt, aspectRatio, images, imageSize),
    requestType: "agent",
    userAgent: "antigravity",
    requestId: envelope.requestId,
  };
}

function collectImagesFromParts(
  parts: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> | undefined,
  images: GeneratedImage[],
  text: string[],
): void {
  for (const part of parts || []) {
    if (part.text) text.push(part.text);
    if (part.inlineData?.data) {
      images.push({
        data: part.inlineData.data,
        mimeType: part.inlineData.mimeType || "image/png",
      });
    }
  }
}

async function writeImage(filePath: string, image: GeneratedImage): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(image.data, "base64"));
  return filePath;
}

export async function saveGeneratedImages(
  cwd: string,
  images: GeneratedImage[],
  requestedPath?: string,
): Promise<string[]> {
  const saved: string[] = [];
  const many = images.length > 1;
  for (const [index, image] of images.entries()) {
    saved.push(
      await writeImage(
        resolveImageSavePath(cwd, requestedPath, image.mimeType, many ? index : undefined),
        image,
      ),
    );
  }
  return saved;
}

export type ImageRequestResult =
  | { ok: true; images: GeneratedImage[]; text: string[]; model: string }
  | { ok: false; aborted: boolean; message: string };

function imagesFromChunks(chunks: StreamGenerateChunk[]): {
  images: GeneratedImage[];
  text: string[];
} {
  const images: GeneratedImage[] = [];
  const text: string[] = [];
  for (const chunk of chunks) {
    for (const candidate of chunk.candidates ?? []) {
      const content = candidate.content;
      if (!content || typeof content !== "object") continue;
      const parts = (content as { parts?: unknown }).parts;
      if (!Array.isArray(parts)) continue;
      collectImagesFromParts(
        parts as Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }>,
        images,
        text,
      );
    }
  }
  return { images, text };
}

function aspectRatioFromMetadata(
  metadata: Record<string, unknown> | undefined,
  explicit?: string,
): { ok: true; ratio: ImageAspectRatio } | { ok: false; message: string } {
  const raw = explicit ?? metadata?.aspectRatio;
  if (raw === undefined || raw === "") return { ok: true, ratio: "1:1" };
  if (typeof raw !== "string") return { ok: false, message: "aspectRatio must be a string." };
  try {
    return { ok: true, ratio: assertSafeAspectRatio(raw) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unsupported aspect ratio.",
    };
  }
}

/**
 * One named model. Does not throw and does not try another model.
 * Callers that want a preference order, including `generate_image`, own that loop.
 */
export async function requestAntigravityImage(options: {
  apiKey: string;
  model: string;
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
  images?: Array<{ data: string; mimeType: string }>;
  signal?: AbortSignal;
}): Promise<ImageRequestResult> {
  const prompt = options.prompt.trim();
  if (!prompt) return { ok: false, aborted: false, message: "Image prompt is required." };
  if (prompt.length > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      aborted: false,
      message: `Image prompt is too long (max ${MAX_PROMPT_CHARS} characters).`,
    };
  }
  let model: string;
  try {
    model = assertSafeImageModel(options.model);
  } catch (error) {
    return {
      ok: false,
      aborted: false,
      message: error instanceof Error ? error.message : "Unsupported image model.",
    };
  }
  const ratio = aspectRatioFromMetadata(undefined, options.aspectRatio);
  if (!ratio.ok) return { ok: false, aborted: false, message: ratio.message };

  const streamed = await streamGenerateContent({
    apiKey: options.apiKey,
    model,
    request: imageRequestBody(prompt, ratio.ratio, options.images ?? [], options.imageSize),
    signal: options.signal,
  });
  if (!streamed.ok) {
    return { ok: false, aborted: streamed.aborted, message: streamed.message };
  }
  const parsed = imagesFromChunks(streamed.chunks);
  if (!parsed.images.length) {
    return {
      ok: false,
      aborted: false,
      message: parsed.text.join(" ").trim() || "No image data returned.",
    };
  }
  return { ok: true, images: parsed.images, text: parsed.text, model: streamed.model };
}

function imageResult(
  model: ImageModel<ImageApi>,
  partial: Pick<AssistantImages, "output" | "stopReason" | "errorMessage">,
): AssistantImages {
  return {
    api: model.api || ANTIGRAVITY_IMAGE_API,
    provider: model.provider || "antigravity",
    model: model.id,
    output: partial.output,
    stopReason: partial.stopReason,
    errorMessage: partial.errorMessage,
    timestamp: Date.now(),
  };
}

function inputBlocks(context: ImagesContext): {
  prompt: string;
  images: Array<{ data: string; mimeType: string }>;
} {
  const texts: string[] = [];
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const block of context.input) {
    if (block.type === "text" && block.text.trim()) texts.push(block.text);
    if (block.type === "image" && block.data.trim()) {
      images.push({ data: block.data, mimeType: block.mimeType || "image/png" });
    }
  }
  return { prompt: texts.join("\n").trim(), images };
}

/** Pi image operation. Never throws. Uses the model the caller named. */
export async function generateAntigravityImages(
  model: ImageModel<ImageApi>,
  context: ImagesContext,
  options?: ImagesOptions,
): Promise<AssistantImages> {
  try {
    if (options?.signal?.aborted) {
      return imageResult(model, {
        output: [],
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      });
    }
    const ratio = aspectRatioFromMetadata(options?.metadata);
    if (!ratio.ok) {
      return imageResult(model, { output: [], stopReason: "error", errorMessage: ratio.message });
    }
    const input = inputBlocks(context);
    const requested = await requestAntigravityImage({
      apiKey: options?.apiKey ?? "",
      model: model.id,
      prompt: input.prompt,
      aspectRatio: ratio.ratio,
      images: input.images,
      signal: options?.signal,
    });
    if (!requested.ok) {
      return imageResult(model, {
        output: [],
        stopReason: requested.aborted ? "aborted" : "error",
        errorMessage: requested.message,
      });
    }
    return imageResult(model, {
      output: [
        ...requested.text.map((text) => ({ type: "text" as const, text })),
        ...requested.images.map((image) => ({
          type: "image" as const,
          data: image.data,
          mimeType: image.mimeType,
        })),
      ],
      stopReason: "stop",
    });
  } catch (error) {
    return imageResult(model, {
      output: [],
      stopReason: options?.signal?.aborted ? "aborted" : "error",
      errorMessage: error instanceof Error ? error.message : "Image generation failed.",
    });
  }
}
