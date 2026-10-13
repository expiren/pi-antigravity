import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { streamGenerateContent, type StreamGenerateChunk } from "../client/stream-generate.js";
import { parseApiKey } from "../client/client.js";
import { isRecord } from "../utils/util.js";
import {
  deriveSources,
  extractGoogleSearchDetails,
  resolveGoogleGroundingRedirectUrls,
  sanitizeSearchResults,
} from "./grounding.js";
import type {
  GroundingMetadata,
  SearchContent,
  SearchStreamResult,
  SearchToolDeclaration,
  UrlContextMetadata,
} from "./types.js";

export const DEFAULT_SEARCH_MODEL = "gemini-3.8-flash-tiered";

export function resolveSearchModel(customModel?: string): string {
  const envModel = process.env.ANTIGRAVITY_SEARCH_MODEL?.trim();
  const raw = customModel?.trim() || envModel || DEFAULT_SEARCH_MODEL;
  if (
    raw === "gemini-3.8-flash" ||
    raw === "gemini-3.7-flash" ||
    raw === "gemini-3.7-flash-tiered" ||
    raw === "gemini-3.7-flash-low"
  ) {
    return "gemini-3.8-flash-tiered";
  }
  return raw;
}

const SEARCH_MODEL_FALLBACKS = [
  "gemini-3.8-flash-tiered",
  "gemini-3.8-flash-low",
  "gemini-3.8-flash-medium",
];

interface SearchCandidate {
  content?: { parts?: unknown };
  groundingMetadata?: GroundingMetadata;
  urlContextMetadata?: UrlContextMetadata;
  url_context_metadata?: UrlContextMetadata;
}

/** Everything one endpoint contributes to an answer, before citations are derived. */
interface SearchStreamState {
  text: string;
  groundingMetadata?: GroundingMetadata;
  urlContextMetadata?: UrlContextMetadata;
}

function searchCandidate(chunk: StreamGenerateChunk): SearchCandidate | undefined {
  const candidates = chunk.candidates;
  if (!Array.isArray(candidates)) return undefined;
  return candidates.find(isRecord);
}

/**
 * Folds one SSE chunk into the live answer. Text is forwarded as it arrives so
 * the tool still streams; grounding metadata is kept until the stream ends.
 */
function applySearchChunk(
  state: SearchStreamState,
  chunk: StreamGenerateChunk,
  onUpdate?: AgentToolUpdateCallback,
): void {
  const candidate = searchCandidate(chunk);
  if (!candidate) return;
  const parts = candidate.content?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!isRecord(part) || typeof part.text !== "string" || !part.text) continue;
      state.text += part.text;
      onUpdate?.({
        content: [{ type: "text", text: state.text }],
        details: { streaming: true },
      });
    }
  }
  if (candidate.groundingMetadata) state.groundingMetadata = candidate.groundingMetadata;
  const urlContextMetadata = candidate.urlContextMetadata || candidate.url_context_metadata;
  if (urlContextMetadata) state.urlContextMetadata = urlContextMetadata;
}

/**
 * Tool-grounded answer over `tools` (google_search, url_context).
 *
 * Model preference order and grounding interpretation live here; the request
 * envelope, endpoint fallback, and SSE framing belong to `streamGenerateContent`.
 * Throws on bad credentials, on abort, and when every model on the preference
 * order fails. Every thrown message is already redacted by the transport.
 */
export async function executeAntigravitySearchStream(options: {
  apiKey: string;
  contents: SearchContent[];
  tools: SearchToolDeclaration[];
  model?: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}): Promise<SearchStreamResult> {
  // Fail on bad credentials before spending a request; the transport parses too.
  parseApiKey(options.apiKey);
  const preferredModel = resolveSearchModel(options.model);
  const candidateModels = [
    preferredModel,
    ...SEARCH_MODEL_FALLBACKS.filter((id) => id !== preferredModel),
  ];

  let lastError = "No Antigravity endpoint available";

  for (const model of candidateModels) {
    if (options.signal?.aborted) throw new Error("Request was aborted");

    let state: SearchStreamState = { text: "" };
    const streamed = await streamGenerateContent({
      apiKey: options.apiKey,
      model,
      request: { contents: options.contents, tools: options.tools },
      signal: options.signal,
      onChunk: (chunk) => applySearchChunk(state, chunk, options.onUpdate),
      // A dead endpoint must not cost the whole answer; try the next one, then the next model.
      retryOnStreamError: true,
      // Text streamed from an abandoned endpoint is not part of the answer.
      onRetry: () => {
        state = { text: "" };
      },
    });

    if (!streamed.ok) {
      if (streamed.aborted) throw new Error("Request was aborted");
      lastError = streamed.status
        ? `Antigravity search request failed (${streamed.status}): ${streamed.message}`
        : streamed.message;
      continue;
    }

    const searchDetails = extractGoogleSearchDetails(state.groundingMetadata);
    await resolveGoogleGroundingRedirectUrls(
      searchDetails.searchResults,
      searchDetails.citations,
      options.signal,
    );
    const searchResults = sanitizeSearchResults(searchDetails.searchResults);
    const citations = sanitizeSearchResults(searchDetails.citations);

    return {
      text: state.text || "No response received.",
      sources: deriveSources(searchResults, citations),
      searchQueries: searchDetails.searchQueries,
      searchResults,
      citations,
      groundingMetadata: state.groundingMetadata,
      urlContextMetadata: state.urlContextMetadata,
      model,
    };
  }

  throw new Error(`Failed to execute search via Antigravity: ${lastError}`);
}
