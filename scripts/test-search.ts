import {
  applyCitations,
  executeAntigravitySearchStream,
  executeUrlContext,
  executeWebSearch,
  extractGoogleSearchDetails,
  isGoogleGroundingRedirect,
  isLikelyJunkSearchUrl,
  normalizeSearchUrl,
  resolveGoogleGroundingRedirectUrls,
  resolveSearchModel,
  YOUTUBE_REGEX,
} from "../src/search/index.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function testApplyCitationsAscii() {
  const text = "The capital of France is Paris. It is known for the Eiffel Tower.";
  const groundingMetadata = {
    webSearchQueries: ["capital of france"],
    groundingChunks: [
      { web: { title: "France Info", uri: "https://example.com/france" } },
      { web: { title: "Eiffel Tower", uri: "https://example.com/eiffel" } },
    ],
    groundingSupports: [
      {
        segment: { endIndex: 31 }, // after "Paris."
        groundingChunkIndices: [0],
      },
      {
        segment: { endIndex: 65 }, // after "Tower."
        groundingChunkIndices: [1],
      },
    ],
  };

  const result = applyCitations(text, groundingMetadata);
  assert(result.sources.length === 2, "Should have 2 sources");
  assert(result.sources[0]?.title === "France Info", "Source 1 title matches");
  assert(
    result.text.includes("Paris.[1]"),
    `Expected citation [1] after Paris., got: ${result.text}`,
  );
  assert(
    result.text.includes("Tower.[2]"),
    `Expected citation [2] after Tower., got: ${result.text}`,
  );
  console.log("✓ testApplyCitationsAscii passed");
}

async function testApplyCitationsMultibyteUtf8() {
  // UTF-8 multibyte test (Chinese characters take 3 bytes each in UTF-8)
  // "法国的首都是巴黎。"
  // "法国的首都是巴黎。" in UTF-8 bytes:
  // 法 (3) 国 (3) 的 (3) 首 (3) 都 (3) 是 (3) 巴 (3) 黎 (3) 。 (3) = 27 bytes total.
  const text = "法国的首都是巴黎。这里有埃菲尔铁塔。";
  const encoder = new TextEncoder();
  const firstSentenceBytes = encoder.encode("法国的首都是巴黎。").length;
  const fullBytes = encoder.encode(text).length;

  const groundingMetadata = {
    webSearchQueries: ["法国首都"],
    groundingChunks: [
      { web: { title: "巴黎介绍", uri: "https://example.com/paris" } },
      { web: { title: "埃菲尔铁塔", uri: "https://example.com/eiffel" } },
    ],
    groundingSupports: [
      {
        segment: { endIndex: firstSentenceBytes },
        groundingChunkIndices: [0],
      },
      {
        segment: { endIndex: fullBytes },
        groundingChunkIndices: [1],
      },
    ],
  };

  const result = applyCitations(text, groundingMetadata);
  assert(
    result.text.startsWith("法国的首都是巴黎。[1]"),
    `Byte-safe citation failed on multibyte Chinese text: ${result.text}`,
  );
  assert(
    result.text.endsWith("埃菲尔铁塔。[2]"),
    `Byte-safe citation failed at end of Chinese text: ${result.text}`,
  );
  console.log("✓ testApplyCitationsMultibyteUtf8 passed");
}

async function testNormalizeAndJunkUrls() {
  // Normalize URLs
  const trackedUrl =
    "https://example.com/article?utm_source=twitter&utm_medium=social&ref=sidebar&id=123#heading";
  const normalized = normalizeSearchUrl(trackedUrl);
  assert(
    normalized === "https://example.com/article?id=123",
    `Expected clean url, got: ${normalized}`,
  );

  // Preserve YouTube params
  const ytUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s";
  const normalizedYt = normalizeSearchUrl(ytUrl);
  assert(normalizedYt.includes("v=dQw4w9WgXcQ"), "YouTube query params preserved");

  // Junk URLs
  assert(isLikelyJunkSearchUrl("https://example.com/font.woff2"), "woff2 should be junk");
  assert(isLikelyJunkSearchUrl("https://example.com/backup.sql"), "sql should be junk");
  assert(!isLikelyJunkSearchUrl("https://example.com/news/article-1"), "article is not junk");
  console.log("✓ testNormalizeAndJunkUrls passed");
}

async function testYouTubeRegex() {
  const yt1 = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const yt2 = "https://youtu.be/dQw4w9WgXcQ";
  const nonYt = "https://example.com/video/123";

  assert(YOUTUBE_REGEX.test(yt1), "yt1 should match YouTube regex");
  assert(YOUTUBE_REGEX.test(yt2), "yt2 should match YouTube regex");
  assert(!YOUTUBE_REGEX.test(nonYt), "nonYt should not match YouTube regex");
  console.log("✓ testYouTubeRegex passed");
}

async function testGoogleGroundingDetails() {
  const metadata = {
    webSearchQueries: ["test query"],
    groundingChunks: [
      { web: { title: "Title 1", uri: "https://example.com/1" } },
      { web: { title: "Title 2", uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc" } },
    ],
    groundingSupports: [
      {
        groundingChunkIndices: [1],
        segment: { text: "cited text segment" },
      },
    ],
  };

  const details = extractGoogleSearchDetails(metadata);
  assert(details.searchQueries[0] === "test query", "searchQueries extracted");
  assert(details.searchResults.length === 2, "2 searchResults extracted");
  assert(details.citations.length === 1, "1 citation extracted");
  assert(
    isGoogleGroundingRedirect(details.searchResults[1]?.url),
    "Redirect url detected correctly",
  );

  // Test redirect url resolution mock
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes("grounding-api-redirect/abc")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://canonical.example.com/real-target" },
        });
      }
      return new Response("ok");
    };

    await resolveGoogleGroundingRedirectUrls(details.searchResults, details.citations);
    assert(
      details.searchResults[1]?.url === "https://canonical.example.com/real-target",
      `Expected resolved url, got: ${details.searchResults[1]?.url}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log("✓ testGoogleGroundingDetails passed");
}

async function testSearchModelResolution() {
  assert(resolveSearchModel() === "gemini-3.8-flash-tiered", "Default search model is gemini-3.8-flash-tiered");
  assert(
    resolveSearchModel("gemini-3.8-flash") === "gemini-3.8-flash-tiered",
    "Maps gemini-3.8-flash to tiered",
  );
  assert(
    resolveSearchModel("gemini-3.7-flash") === "gemini-3.8-flash-tiered",
    "Maps legacy gemini-3.7-flash to tiered",
  );
  assert(
    resolveSearchModel("custom-model") === "custom-model",
    "Respects custom model override",
  );
  console.log("✓ testSearchModelResolution passed");
}

async function testExecuteWebSearchAndUrlContextMock() {
  const originalFetch = globalThis.fetch;
  let interceptedBody: any = null;

  try {
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body && typeof init.body === "string") {
        try {
          interceptedBody = JSON.parse(init.body);
        } catch {
          // ignore
        }
      }

      // Return mock SSE stream
      const sseChunks = [
        `data: ${JSON.stringify({
          response: {
            candidates: [
              {
                content: {
                  parts: [{ text: "Antigravity is Google's internal Cloud Code infrastructure." }],
                },
                groundingMetadata: {
                  webSearchQueries: ["antigravity google cloud code"],
                  groundingChunks: [
                    { web: { title: "Cloud Code Docs", uri: "https://cloud.google.com/code" } },
                  ],
                  groundingSupports: [
                    {
                      segment: { endIndex: 61 },
                      groundingChunkIndices: [0],
                    },
                  ],
                },
              },
            ],
          },
        })}\n\n`,
        "data: [DONE]\n\n",
      ];

      const encoder = new TextEncoder();
      let index = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index >= sseChunks.length) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(sseChunks[index]!));
          index++;
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const apiKey = JSON.stringify({ token: "test-token", projectId: "test-project" });

    // 1. Test executeWebSearch
    const searchRes = await executeWebSearch({
      apiKey,
      query: "antigravity google cloud code",
    });

    assert(interceptedBody?.request?.tools?.[0]?.google_search !== undefined, "tools has google_search");
    assert(searchRes.content[0]?.text.includes("## Sources"), "Search summary has ## Sources");
    assert(searchRes.content[0]?.text.includes("[Cloud Code Docs]"), "Search summary has title");
    assert(searchRes.details.sources.length === 1, "details has 1 source");

    // 2. Test executeUrlContext with YouTube
    const urlRes = await executeUrlContext({
      apiKey,
      urls: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://example.com"],
      query: "Summarize this video and page",
    });

    assert(interceptedBody?.request?.tools?.[0]?.url_context !== undefined, "tools has url_context");
    const contents = interceptedBody?.request?.contents?.[0];
    const parts = contents?.parts || [];
    const hasFileData = parts.some(
      (p: any) =>
        p.file_data?.file_uri === "https://www.youtube.com/watch?v=dQw4w9WgXcQ" &&
        p.file_data?.mime_type === "video/mp4",
    );
    assert(hasFileData, "YouTube URL converted to file_data with video/mp4");
    assert(urlRes.content[0]?.text.length > 0, "urlContext returns summary");
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log("✓ testExecuteWebSearchAndUrlContextMock passed");
}

/**
 * The search tools ride the shared transport: a 404 endpoint, then an endpoint
 * that dies mid-stream, must not leak their partial text into the answer.
 */
async function testSearchRidesSharedTransport() {
  const originalFetch = globalThis.fetch;
  const endpoints: string[] = [];
  // The endpoint walk and the preferred model must come from the defaults here.
  const envKeys = [
    "ANTIGRAVITY_BASE_URL",
    "NOAGY_BASE_URL",
    "ANTIGRAVITY_SEARCH_MODEL",
    "NOAGY_SEARCH_MODEL",
  ];
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];

  const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n`;
  const streamOf = (chunks: string[]) => {
    const encoder = new TextEncoder();
    let index = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index >= chunks.length) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(chunks[index]!));
          index += 1;
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  };

  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      endpoints.push(url);
      // 1st endpoint: gone. 2nd: streams a text part, then an API error.
      // 3rd: the healthy answer.
      if (url.includes("daily-cloudcode-pa.googleapis.com")) return new Response("missing", { status: 404 });
      if (url.includes("sandbox.googleapis.com")) {
        return streamOf([
          sse({ response: { candidates: [{ content: { parts: [{ text: "half an answer " }] } }] } }),
          sse({ error: { code: 429, message: "quota exhausted" } }),
        ]);
      }
      return streamOf([
        sse({
          response: {
            candidates: [
              {
                content: { parts: [{ text: "the whole answer" }] },
                groundingMetadata: {
                  webSearchQueries: ["q"],
                  groundingChunks: [{ web: { title: "Docs", uri: "https://example.com/d" } }],
                },
              },
            ],
          },
        }),
        "data: [DONE]\n\n",
      ]);
    };

    const updates: string[] = [];
    const result = await executeAntigravitySearchStream({
      apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
      contents: [{ role: "user", parts: [{ text: "q" }] }],
      tools: [{ google_search: {} }],
      onUpdate: (update) => {
        const text = update.content?.[0]?.text;
        if (typeof text === "string") updates.push(text);
      },
    });

    assert(endpoints.length === 3, `walked all three endpoints, got ${endpoints.length}`);
    assert(result.text === "the whole answer", `no partial text leaked, got: ${result.text}`);
    assert(result.model === "gemini-3.8-flash-tiered", "keeps the preferred model");
    assert(result.sources.length === 1, "grounding still becomes sources");
    assert(
      !updates.some((text) => text.includes("half an answer the whole answer")),
      "the retry does not append to the dead endpoint's text",
    );
    assert(updates[updates.length - 1] === "the whole answer", "streams the live answer");

    // Every model on the preference order can fail; then search throws.
    globalThis.fetch = async () => new Response("missing", { status: 404 });
    try {
      await executeAntigravitySearchStream({
        apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
        contents: [{ role: "user", parts: [{ text: "q" }] }],
        tools: [{ google_search: {} }],
      });
      throw new Error("expected search to fail");
    } catch (error) {
      assert(
        error instanceof Error && /Failed to execute search via Antigravity/.test(error.message),
        `throws when all models fail: ${String(error)}`,
      );
    }

    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = async () => {
      throw new Error("should not be called after abort");
    };
    try {
      await executeAntigravitySearchStream({
        apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
        contents: [{ role: "user", parts: [{ text: "q" }] }],
        tools: [{ google_search: {} }],
        signal: controller.signal,
      });
      throw new Error("expected abort");
    } catch (error) {
      assert(
        error instanceof Error && error.message === "Request was aborted",
        `abort is an error here: ${String(error)}`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const saved = savedEnv.get(key);
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  }
  console.log("✓ testSearchRidesSharedTransport passed");
}

/** Backend error bodies reach the transcript; credentials echoed in them must not. */
async function testSearchRedactsBackendErrors() {
  const originalFetch = globalThis.fetch;
  const envKeys = ["ANTIGRAVITY_BASE_URL", "NOAGY_BASE_URL", "ANTIGRAVITY_SEARCH_MODEL"];
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  const token = "ya29.AbCdEf-secret-access-token";
  const request = {
    apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
    contents: [{ role: "user" as const, parts: [{ text: "q" }] }],
  };

  try {
    // Non-retryable HTTP status: the backend echoes the credential back.
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: `bad request for ${token}` } }), {
        status: 400,
      });
    try {
      await executeAntigravitySearchStream({ ...request, tools: [{ google_search: {} }] });
      throw new Error("expected search to fail");
    } catch (error) {
      assert(error instanceof Error, "throws an Error");
      assert(!error.message.includes(token), `HTTP body token redacted: ${error.message}`);
      assert(
        error.message.includes("[redacted-access-token]"),
        `keeps a readable reason: ${error.message}`,
      );
      assert(
        error.message.includes("Antigravity search request failed (400)"),
        "keeps the status",
      );
    }

    // Mid-stream API error chunk carries the same kind of text.
    globalThis.fetch = async () =>
      new Response(
        `data: ${JSON.stringify({ error: { code: 500, message: `Bearer ${token} rejected` } })}\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    try {
      await executeAntigravitySearchStream({ ...request, tools: [{ google_search: {} }] });
      throw new Error("expected search to fail");
    } catch (error) {
      assert(error instanceof Error, "throws an Error");
      assert(!error.message.includes(token), `SSE chunk token redacted: ${error.message}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const saved = savedEnv.get(key);
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  }
  console.log("✓ testSearchRedactsBackendErrors passed");
}

async function main() {
  await testApplyCitationsAscii();
  await testApplyCitationsMultibyteUtf8();
  await testNormalizeAndJunkUrls();
  await testYouTubeRegex();
  await testGoogleGroundingDetails();
  await testSearchModelResolution();
  await testExecuteWebSearchAndUrlContextMock();
  await testSearchRidesSharedTransport();
  await testSearchRedactsBackendErrors();
  console.log("All search and grounding tests passed successfully!");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
