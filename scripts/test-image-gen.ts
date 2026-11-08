import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamGenerateContent } from "../src/client/stream-generate.js";
import {
  assertSafeAspectRatio,
  assertSafeImageModel,
  buildImageGenerateRequest,
  generateAntigravityImages,
  imageModelCandidates,
  IMAGE_SIZE_TIERS,
  inlineImageData,
  requestAntigravityImage,
  resolveImageSavePath,
  saveGeneratedImages,
} from "../src/image/index.js";
import { ANTIGRAVITY_IMAGE_API } from "../src/models/image-catalog.js";

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(`FAILED: ${message}`);
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n`;
}

function responseFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]!));
      i += 1;
    },
  });
  return new Response(body);
}

function imageSse(data: string, mimeType = "image/png"): string {
  return sse({
    response: {
      candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }],
    },
  });
}

async function main() {
  assert(assertSafeImageModel("gemini-3-pro-image") === "gemini-3-pro-image", "allow gemini image model");
  assert(assertSafeImageModel("imagen-3.0-generate-002") === "imagen-3.0-generate-002", "allow imagen");
  try {
    assertSafeImageModel("claude-opus-4-6");
    fail("expected unsafe model to throw");
  } catch (error) {
    assert(error instanceof Error && /Unsupported image model/.test(error.message), "reject chat model");
  }
  try {
    assertSafeImageModel("https://evil.example/x");
    fail("expected url model to throw");
  } catch {
    // expected
  }

  assert(assertSafeAspectRatio("16:9") === "16:9", "allow 16:9");
  try {
    assertSafeAspectRatio("99:1");
    fail("expected bad ratio to throw");
  } catch (error) {
    assert(error instanceof Error && /Unsupported aspect ratio/.test(error.message), "reject ratio");
  }

  const req = buildImageGenerateRequest("a lighthouse", "gemini-3-pro-image", "proj-1", "16:9");
  assert(req.model === "gemini-3-pro-image", "request model");
  assert(req.project === "proj-1", "request project");
  assert(req.request.generationConfig.imageConfig.aspectRatio === "16:9", "aspect ratio");
  assert(req.request.contents[0]?.parts[0]?.text === "a lighthouse", "prompt text is sole part when no images");
  assert(/^agent\//.test(req.requestId), "agent request id");

  const withImage = buildImageGenerateRequest("edit this", "gemini-3-pro-image", "proj-1", "1:1", [
    { data: "data:image/jpeg;base64,/9j/4AAQ", mimeType: "image/png" },
  ]);
  const inlinePart = withImage.request.contents[0]?.parts[0];
  assert(
    inlinePart && "inlineData" in inlinePart && inlinePart.inlineData.mimeType === "image/jpeg",
    "inline image input keeps its own mime type",
  );

  assert(
    imageModelCandidates("gemini-3.1-flash-image")[0] === "gemini-3.1-flash-image",
    "preferred model leads the candidate order",
  );
  assert(
    imageModelCandidates().includes("gemini-3-pro-image-preview"),
    "candidate order keeps the preview fallback",
  );

  const decoded = inlineImageData("data:image/jpeg;base64,/9j/4AAQ", "image/png");
  assert(decoded.mimeType === "image/jpeg" && decoded.data === "/9j/4AAQ", "strip data-url prefix");

  const tmp = await mkdtemp(join(tmpdir(), "pi-antigravity-image-"));
  try {
    const saved = resolveImageSavePath(tmp, "out/cat.png");
    assert(saved === join(tmp, "out/cat.png"), `save path ${saved}`);
    const dirSaved = resolveImageSavePath(tmp, "images", "image/jpeg", 0);
    assert(dirSaved.endsWith("-1.jpg"), `dir save ${dirSaved}`);
    assert(dirSaved.startsWith(join(tmp, "images")), "dir stays in cwd");
    try {
      resolveImageSavePath(tmp, "../escape.png");
      fail("expected path traversal to throw");
    } catch (error) {
      assert(
        error instanceof Error && /inside the working directory/.test(error.message),
        "reject traversal",
      );
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const previousBase = process.env.ANTIGRAVITY_BASE_URL;
  const previousAlias = process.env.NOAGY_BASE_URL;
  delete process.env.ANTIGRAVITY_BASE_URL;
  delete process.env.NOAGY_BASE_URL;
  const apiKey = JSON.stringify({ token: "token", projectId: "proj-1" });
  const originalFetch = globalThis.fetch;
  try {
    // The first endpoint 404s, the second answers with an SSE body split mid-line.
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (!url.includes("daily-cloudcode-pa.sandbox")) return new Response("missing", { status: 404 });
      const body =
        sse({ response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } }) +
        imageSse(png) +
        "data: [DONE]\n";
      return responseFromChunks([body.slice(0, 40), body.slice(40)]);
    };
    const requested = await requestAntigravityImage({
      apiKey,
      model: "gemini-3-pro-image",
      prompt: "a lighthouse",
      aspectRatio: "16:9",
    });
    assert(requested.ok, "image request succeeds after endpoint fallback");
    assert(requested.images.length === 1, "one image");
    assert(requested.images[0]?.mimeType === "image/png", "png mime");
    assert(requested.images[0]?.data === png, "png data");
    assert(requested.text.join("") === "ok", "sse text");
    assert(requested.model === "gemini-3-pro-image", "keeps the named model");

    const saveDir = await mkdtemp(join(tmpdir(), "pi-antigravity-image-save-"));
    try {
      const savedPaths = await saveGeneratedImages(saveDir, requested.images, "out");
      assert(savedPaths.length === 1 && savedPaths[0]?.endsWith(".png"), `saves image ${savedPaths}`);
    } finally {
      await rm(saveDir, { recursive: true, force: true });
    }

    let calls = 0;
    let sawTools = false;
    globalThis.fetch = async (input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      if (body.request?.tools) sawTools = true;
      if (String(input).includes("daily-cloudcode-pa.sandbox")) {
        return new Response(imageSse(png), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    };
    const streamed = await streamGenerateContent({
      apiKey,
      model: "gemini-3-pro-image",
      request: {
        contents: [{ role: "user", parts: [{ text: "lighthouse" }] }],
        tools: [{ google_search: {} }],
      },
    });
    assert(streamed.ok, "transport succeeds after endpoint fallback");
    assert(calls >= 2, "retries the next endpoint");
    assert(sawTools, "forwards caller tools for search adoption");
    assert(streamed.ok && streamed.model === "gemini-3-pro-image", "transport keeps the named model");

    const aborted = await streamGenerateContent({
      apiKey,
      model: "gemini-3-pro-image",
      request: { contents: [{ role: "user", parts: [{ text: "x" }] }] },
      signal: AbortSignal.abort(),
    });
    assert(!aborted.ok && aborted.aborted, "abort is a result, not a throw");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBase === undefined) delete process.env.ANTIGRAVITY_BASE_URL;
    else process.env.ANTIGRAVITY_BASE_URL = previousBase;
    if (previousAlias === undefined) delete process.env.NOAGY_BASE_URL;
    else process.env.NOAGY_BASE_URL = previousAlias;
  }

  const imageModel = {
    id: "gemini-3-pro-image",
    name: "Gemini 3 Pro Image",
    api: ANTIGRAVITY_IMAGE_API,
    provider: "antigravity",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    type: "image" as const,
    input: ["text", "image"] as ("text" | "image")[],
    output: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  try {
    globalThis.fetch = async () => new Response("bad request", { status: 400 });
    const failed = await generateAntigravityImages(
      imageModel,
      { input: [{ type: "text", text: "a lighthouse" }] },
      { apiKey, metadata: { aspectRatio: "16:9" } },
    );
    assert(failed.stopReason === "error", "provider error does not throw");
    assert(failed.model === "gemini-3-pro-image", "failed call keeps the named model");

    globalThis.fetch = async () => new Response(imageSse(png), { status: 200 });
    const generated = await generateAntigravityImages(
      imageModel,
      { input: [{ type: "text", text: "a lighthouse" }] },
      { apiKey, metadata: { aspectRatio: "16:9" } },
    );
    assert(generated.stopReason === "stop", "provider operation returns image output");
    assert(
      generated.output.some((block) => block.type === "image" && block.data === png),
      "provider output carries inline image data",
    );
    assert(generated.api === ANTIGRAVITY_IMAGE_API, "provider output keeps the image api");

    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response("no", { status: 500 });
    };
    const badRatio = await generateAntigravityImages(
      imageModel,
      { input: [{ type: "text", text: "a lighthouse" }] },
      { apiKey, metadata: { aspectRatio: "99:1" } },
    );
    assert(
      badRatio.stopReason === "error" && /aspect ratio/i.test(badRatio.errorMessage ?? ""),
      "rejects ratio",
    );
    assert(!fetched, "invalid ratio does not hit the network");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ── imageSize support ──
  assert(IMAGE_SIZE_TIERS.includes("4K"), "IMAGE_SIZE_TIERS includes 4K");
  assert(IMAGE_SIZE_TIERS.includes("1K"), "IMAGE_SIZE_TIERS includes 1K");
  assert(IMAGE_SIZE_TIERS.length === 3, "exactly three size tiers");

  const req4k = buildImageGenerateRequest("hi-res photo", "gemini-3-pro-image", "proj-1", "16:9", [], "4K");
  assert(
    req4k.request.generationConfig.imageConfig.imageSize === "4K",
    "imageSize 4K is set in generationConfig.imageConfig",
  );
  assert(
    req4k.request.generationConfig.imageConfig.aspectRatio === "16:9",
    "aspectRatio preserved alongside imageSize",
  );

  const reqNoSize = buildImageGenerateRequest("a cat", "gemini-3-pro-image", "proj-1", "1:1");
  assert(
    !("imageSize" in reqNoSize.request.generationConfig.imageConfig),
    "imageSize omitted when not provided",
  );

  // ── Reference images: parts ordering ──
  const refImages = [
    { data: "AAAA", mimeType: "image/png" },
    { data: "BBBB", mimeType: "image/jpeg" },
  ];
  const withRefs = buildImageGenerateRequest("edit", "gemini-3-pro-image", "proj-1", "1:1", refImages, "2K");
  const refParts = withRefs.request.contents[0]!.parts;
  assert(refParts.length === 3, "two ref images + one text = 3 parts");
  assert("inlineData" in refParts[0]! && refParts[0]!.inlineData.mimeType === "image/png", "first ref is PNG");
  assert("inlineData" in refParts[1]! && refParts[1]!.inlineData.data === "BBBB", "second ref data");
  assert("text" in refParts[2]! && refParts[2]!.text === "edit", "text prompt is last part");
  assert(withRefs.request.generationConfig.imageConfig.imageSize === "2K", "imageSize 2K in ref request");

  // ── requestAntigravityImage passes imageSize through ──
  try {
    let capturedBody: string | undefined;
    globalThis.fetch = async (_input, init) => {
      capturedBody = String(init?.body);
      return new Response(imageSse(png) + "data: [DONE]\n", { status: 200 });
    };
    const sizeResult = await requestAntigravityImage({
      apiKey,
      model: "gemini-3-pro-image",
      prompt: "4k test",
      aspectRatio: "1:1",
      imageSize: "4K",
    });
    assert(sizeResult.ok, "requestAntigravityImage with imageSize succeeds");
    assert(capturedBody && capturedBody.includes('"imageSize":"4K"'), "imageSize appears in fetch body");
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(
    "image gen: model/path guards, request shape, SSE parse, transport, and image operation passed",
  );
}

void main();