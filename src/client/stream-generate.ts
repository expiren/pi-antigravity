import { AntigravityRequestType, AntigravityUserAgent } from "../types/enums.js";
import { antigravityFetch } from "../utils/http.js";
import { redactSecrets, safeError } from "../utils/security.js";
import { antigravityRequestEnvelope, isRecord } from "../utils/util.js";
import { antigravityHeaders, endpointCandidates, jsonOrTextError, parseApiKey } from "./client.js";

/**
 * One Cloud Code `streamGenerateContent` call.
 *
 * Owns the envelope, endpoint fallback, and SSE framing. It does not choose a
 * model, rotate accounts, or interpret candidates. Image generation,
 * `web_search`, `url_context`, and `analyze_file` call this; model selection,
 * grounding, citations, and file handling stay with the callers.
 */
export const STREAM_GENERATE_CONTENT_PATH = "/v1internal:streamGenerateContent?alt=sse";

/** Statuses that may be tried against the next endpoint. Non-members stop the loop. */
export const RETRYABLE_STREAM_STATUSES = [403, 404, 429, 500, 502, 503, 504] as const;

export type StreamGenerateRequest = {
  contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  systemInstruction?: { role: string; parts: Array<{ text: string }> };
  tools?: unknown[];
  generationConfig?: Record<string, unknown>;
};

export type StreamGenerateChunk = {
  error?: { message?: string; code?: number; status?: string };
  candidates?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type StreamGenerateSuccess = {
  ok: true;
  model: string;
  endpoint: string;
  chunks: StreamGenerateChunk[];
};

export type StreamGenerateFailure = {
  ok: false;
  aborted: boolean;
  status?: number;
  /** Already redacted: backend error bodies can echo credentials. */
  message: string;
  chunks: StreamGenerateChunk[];
};

export type StreamGenerateResult = StreamGenerateSuccess | StreamGenerateFailure;

export function isRetryableStreamStatus(status: number): boolean {
  return (RETRYABLE_STREAM_STATUSES as readonly number[]).includes(status);
}

function abortedResult(chunks: StreamGenerateChunk[] = []): StreamGenerateFailure {
  return { ok: false, aborted: true, message: "Request was aborted", chunks };
}

/**
 * The single funnel for transport failures, so `message` is always safe to show
 * the model or the transcript: HTTP bodies and SSE error chunks are redacted here.
 */
function failure(
  message: string,
  extra?: { status?: number; chunks?: StreamGenerateChunk[] },
): StreamGenerateFailure {
  return {
    ok: false,
    aborted: false,
    status: extra?.status,
    message: redactSecrets(message),
    chunks: extra?.chunks ?? [],
  };
}

function normalizeChunk(parsed: unknown): StreamGenerateChunk | undefined {
  if (!isRecord(parsed)) return undefined;
  const nested = isRecord(parsed.response) ? parsed.response : undefined;
  const source = nested ?? parsed;
  const rawCandidates = source.candidates;
  const candidates = Array.isArray(rawCandidates) ? rawCandidates.filter(isRecord) : undefined;
  const errorSource = isRecord(parsed.error)
    ? parsed.error
    : isRecord(source.error)
      ? source.error
      : undefined;
  const error = errorSource
    ? {
        message: typeof errorSource.message === "string" ? errorSource.message : undefined,
        code: typeof errorSource.code === "number" ? errorSource.code : undefined,
        status: typeof errorSource.status === "string" ? errorSource.status : undefined,
      }
    : undefined;
  return {
    ...parsed,
    ...(candidates ? { candidates } : {}),
    ...(error ? { error } : {}),
  };
}

async function readSse(
  response: Response,
  signal: AbortSignal | undefined,
  onChunk: ((chunk: StreamGenerateChunk) => void) | undefined,
): Promise<{ chunks: StreamGenerateChunk[]; error?: string; aborted?: boolean }> {
  if (!response.body) return { chunks: [], error: "No response body" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const chunks: StreamGenerateChunk[] = [];
  try {
    while (true) {
      if (signal?.aborted) return { chunks, aborted: true };
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) continue;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const json = line.slice(5).trim();
        if (!json || json === "[DONE]") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch {
          continue;
        }
        const chunk = normalizeChunk(parsed);
        if (!chunk) continue;
        chunks.push(chunk);
        onChunk?.(chunk);
        if (chunk.error) {
          const message = chunk.error.message || JSON.stringify(chunk.error);
          const code = chunk.error.code || chunk.error.status || "unknown";
          return { chunks, error: `Antigravity API error (${code}): ${message}` };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { chunks };
}

export async function streamGenerateContent(options: {
  apiKey: string;
  model: string;
  request: StreamGenerateRequest;
  /** Optional local safety budget for the complete serialized request envelope. */
  maxRequestBytes?: number;
  signal?: AbortSignal;
  /** Search and URL context stream text from here. Image generation ignores it. */
  onChunk?: (chunk: StreamGenerateChunk) => void;
  /**
   * An attempt abandoned mid-stream (API error chunk, missing body) is normally
   * final. Search opts in so a bad endpoint cannot take down a whole answer: it
   * walks the next endpoint instead, then the next model.
   */
  retryOnStreamError?: boolean;
  /**
   * Called whenever an attempt is dropped and the next endpoint is tried, so a
   * streaming caller can discard text already emitted by the dead endpoint.
   */
  onRetry?: (reason: string) => void;
}): Promise<StreamGenerateResult> {
  if (options.signal?.aborted) return abortedResult();

  let creds: ReturnType<typeof parseApiKey>;
  try {
    creds = parseApiKey(options.apiKey);
  } catch (error) {
    return failure(safeError(error));
  }

  const envelope = antigravityRequestEnvelope(options.model, false);
  const body = JSON.stringify({
    project: creds.projectId,
    model: options.model,
    request: options.request,
    requestType: AntigravityRequestType.Agent,
    userAgent: AntigravityUserAgent.Antigravity,
    requestId: envelope.requestId,
  });
  if (options.maxRequestBytes !== undefined && Buffer.byteLength(body) > options.maxRequestBytes) {
    return failure(
      "Serialized request exceeds the local byte budget; use a smaller file or instruction.",
    );
  }
  const headers = {
    ...antigravityHeaders(creds.token),
    Accept: "text/event-stream",
  };

  let last = failure("No Antigravity endpoint available");
  for (const endpoint of endpointCandidates()) {
    if (options.signal?.aborted) return abortedResult();
    try {
      const response = await antigravityFetch(`${endpoint}${STREAM_GENERATE_CONTENT_PATH}`, {
        method: "POST",
        headers,
        body,
        signal: options.signal,
      });
      if (!response.ok) {
        const message = jsonOrTextError(await response.text()).slice(0, 400);
        last = failure(message, { status: response.status });
        if (!isRetryableStreamStatus(response.status)) return last;
        options.onRetry?.(message);
        continue;
      }
      const parsed = await readSse(response, options.signal, options.onChunk);
      if (parsed.aborted) return abortedResult(parsed.chunks);
      if (parsed.error) {
        last = failure(parsed.error, { chunks: parsed.chunks });
        if (!options.retryOnStreamError) return last;
        options.onRetry?.(parsed.error);
        continue;
      }
      return { ok: true, model: options.model, endpoint, chunks: parsed.chunks };
    } catch (error) {
      if (options.signal?.aborted) return abortedResult();
      last = failure(safeError(error));
      options.onRetry?.(last.message);
    }
  }
  return last;
}
