/**
 * Shared fetch-wrapper support for the OpenAI and Anthropic adapters (PLAN D11).
 *
 * Both SDKs accept a `fetch` constructor option and invoke it **per HTTP attempt** (verified
 * firsthand: openai v6 makeRequest→fetchWithAuth→fetchWithTimeout→this.fetch, retry in
 * retryRequest; Anthropic shares the fetchWithTimeout lineage). So a custom `fetch` sees every
 * attempt — including failures and retries — which is what lets receipta attribute each one (S2.2).
 *
 * The wrapper:
 *   1. reads `init.body` (the request JSON: model, messages, params),
 *   2. delegates to the real `fetch`,
 *   3. `clone()`s the response (clone-then-read leaves the ORIGINAL unconsumed so the SDK's own
 *      parser sees an intact body — the non-interference property, S2.1),
 *   4. reads the clone to compute usage/finish/id + the output commitment (over the final
 *      assembled output, D8),
 *   5. builds + appends a receipt,
 *   6. returns the ORIGINAL unconsumed response.
 *
 * Receipt emission is wrapped in try/catch and logged to a sidecar; it NEVER throws into the
 * wrapped call (S2.1).
 *
 * Provider-specific differences (which header carries the request id, how usage/finish are spelled
 * in the response body) are supplied by a `ProviderAdapter`, so this module is genuinely shared.
 */
import { Buffer } from "node:buffer";
import { hmac, sha256, sign, toHex, type KeyPair } from "./crypto.js";
import type {
  Actor,
  ContentCaptureMode,
  JsonValue,
  ReceiptBody,
  Usage,
} from "./schema.js";
import type { ReceiptStore } from "./store.js";

export type FetchLike = typeof globalThis.fetch;

/** How to read provider-specific fields out of a response body + headers. */
export interface ProviderAdapter {
  /** The provider name recorded on the receipt (e.g. "openai", "anthropic"). */
  provider: string;
  /** The headers that may carry the request id (checked in order). */
  requestIdHeaders: string[];
  /** Extract usage from a parsed response body (or undefined if absent). */
  extractUsage(body: JsonValue): Usage | undefined;
  /** Extract the model from a parsed response body (or undefined if absent). */
  extractModel(body: JsonValue): string | undefined;
  /** Extract a stable outcome from the HTTP status (e.g. success/error). */
  outcomeFromStatus(status: number): "success" | "error";
  /**
   * Assemble a final message from a buffered Server-Sent-Events stream (D8, S2.5).
   *
   * When the request is a streaming request (`stream: true`), the response body is a sequence of
   * SSE `data:` chunks, NOT a single JSON object. The output commitment MUST be computed over the
   * FINAL ASSEMBLED message, not the raw chunks. This method parses the SSE text the clone
   * captured and returns the assembled message (e.g. the concatenated content + accumulated
   * usage). Return undefined if assembly fails (the receipt then carries the raw text as a
   * fallback, flagged via content_captured reflecting reality).
   */
  assembleStream?: (sseText: string) => JsonValue | undefined;
}

/** What the wrapper needs to build receipts. */
export interface ReceiptCaptureConfig {
  store: ReceiptStore;
  /** The signer for receipts (typically the store owner's Ed25519 key). */
  signer: { keyId: string; sign: (canonicalBody: string) => Uint8Array };
  /** Who/what is making the decision. */
  actor: Actor;
  /** Whether to capture content; default "full". */
  captureMode?: ContentCaptureMode;
  /** Optional logger for emission errors (defaults to console.error). */
  logError?: (msg: string, err: unknown) => void;
  /** Optional commitment key override (defaults to the store's commitment_key). */
  commitmentKey?: Uint8Array;
  /**
   * Optional override merged over the built-in provider adapter (e.g. extra request-id headers
   * for a gateway). Field-by-field: an override of `requestIdHeaders` REPLACES the list. Merged
   * once at construction in `createReceiptFetch`, so the override is per-client (G1.2).
   */
  provider?: Partial<ProviderAdapter>;
}

const DEFAULT_ERROR_LOG = (msg: string, err: unknown) => {
  // Log to a sidecar concept; here we write to stderr so it's visible but doesn't interfere.
  // A future strict mode can re-throw.
  process.stderr.write(`[receipta] emission error: ${msg}: ${String(err)}\n`);
};

/**
 * Build a receipt-emitting fetch wrapper for a provider. Returns a function with the standard
 * `fetch` signature, suitable for passing as `new OpenAI({ fetch })` / `new Anthropic({ fetch })`.
 */
export function createReceiptFetch(
  provider: ProviderAdapter,
  config: ReceiptCaptureConfig,
  baseFetch: FetchLike = globalThis.fetch,
): FetchLike {
  const captureMode = config.captureMode ?? "full";
  const logError = config.logError ?? DEFAULT_ERROR_LOG;
  const commitmentKey = config.commitmentKey ?? Buffer.from(config.store.meta.commitment_key, "hex");
  // Merge the provider override once, at construction (G1.2). The override wins per field: a
  // `requestIdHeaders` override REPLACES the builtin list (the caller knows their gateway). The
  // builtin supplies every required field, so the merged object satisfies ProviderAdapter.
  const effectiveProvider: ProviderAdapter = config.provider
    ? { ...provider, ...config.provider }
    : provider;

  return async (input, init) => {
    const requestStartTime = new Date();
    // 1. Read the request body (the prompt/params the SDK is sending).
    let requestBody: JsonValue | undefined;
    let requestModel: string | undefined;
    try {
      if (init?.body) {
        const bodyText = typeof init.body === "string" ? init.body : "";
        if (bodyText) {
          requestBody = JSON.parse(bodyText) as JsonValue;
          requestModel = pick(requestBody, "model") as string | undefined;
        }
      }
    } catch {
      // Non-JSON or unreadable body — we still proceed; content_captured will reflect this.
    }

    // 2. Delegate to the real fetch. If this throws, it's a network error — we record an attempt
    //    receipt with outcome "error" and re-throw (the SDK handles retries; each retry re-invokes
    //    this wrapper, so the retry gets its own receipt — S2.2).
    let response: Response;
    try {
      response = await baseFetch(input, init);
    } catch (err) {
      await safeEmit(effectiveProvider, config, logError, commitmentKey, {
        requestStartTime,
        requestModel,
        requestBody,
        responseStatus: 0,
        responseBody: undefined,
        requestId: undefined,
        outcome: "error",
        attemptIndex: readAttemptIndex(init),
        captureMode,
      }).catch(() => undefined);
      throw err;
    }

    // 3. Clone the response and read the clone (S2.1: original stays unconsumed for the SDK).
    // For STREAMING requests (D8, S2.5), the body is a sequence of SSE chunks — we buffer the
    // whole stream and assemble the final message, so the output commitment is over the assembled
    // result, not the raw chunks. For non-streaming, the body is a single JSON object.
    const isStream = isStreamingRequest(requestBody) || isEventStreamResponse(response);
    let responseBody: JsonValue | undefined;
    let responseText: string | undefined;
    try {
      const clone = response.clone();
      responseText = await clone.text();
      if (isStream && effectiveProvider.assembleStream) {
        // D8: assemble the final message from the buffered SSE stream.
        responseBody = effectiveProvider.assembleStream(responseText);
      } else {
        try {
          responseBody = JSON.parse(responseText) as JsonValue;
        } catch {
          // Non-JSON response (e.g. an error page); keep responseText for the commitment.
        }
      }
    } catch {
      // Cloning/reading failed — the original response is still returned; receipt omits content.
    }

    // 4. Read the request id from headers (provider-specific).
    const requestId = readRequestId(response, effectiveProvider.requestIdHeaders);

    // 5. Build + append the receipt (never throws into the call — S2.1).
    await safeEmit(effectiveProvider, config, logError, commitmentKey, {
      requestStartTime,
      requestModel,
      requestBody,
      responseStatus: response.status,
      responseBody,
      responseText,
      requestId,
      outcome: effectiveProvider.outcomeFromStatus(response.status),
      attemptIndex: readAttemptIndex(init),
      captureMode,
    }).catch(() => undefined);

    // 6. Return the ORIGINAL unconsumed response (the SDK parses it normally — S2.1).
    return response;
  };
}

/** Internal: gather all the fields and append one receipt, swallowing errors. */
async function safeEmit(
  provider: ProviderAdapter,
  config: ReceiptCaptureConfig,
  logError: (msg: string, err: unknown) => void,
  commitmentKey: Uint8Array,
  info: {
    requestStartTime: Date;
    requestModel?: string;
    requestBody?: JsonValue;
    responseStatus: number;
    responseBody?: JsonValue;
    responseText?: string;
    requestId?: string;
    outcome: "success" | "error";
    attemptIndex?: number;
    captureMode: ContentCaptureMode;
  },
): Promise<void> {
  const { appendBody } = await import("./store.js");
  const store = config.store;

  const model = info.responseBody
    ? (provider.extractModel(info.responseBody) ?? info.requestModel ?? "unknown")
    : (info.requestModel ?? "unknown");

  const usage = info.responseBody ? provider.extractUsage(info.responseBody) : undefined;

  // Content + commitments. content_captured reflects whether we actually read content (S1.3).
  const captured = info.captureMode === "full" && info.requestBody !== undefined;
  const responseContent: JsonValue | undefined = info.responseBody ?? (info.responseText as string | undefined);
  const content = captured
    ? {
        request: info.requestBody as JsonValue,
        ...(responseContent !== undefined ? { response: responseContent } : {}),
      }
    : undefined;

  // Privacy commitments (HMAC, D10) over request/response content.
  const commitments = computeCommitments(commitmentKey, info.requestBody, info.responseBody, info.responseText);

  const completionTime = new Date();
  const body: Omit<
    ReceiptBody,
    "chain_id" | "seq" | "prev_hash" | "key_id" | "suite" | "schema_version"
  > = {
    timestamp: {
      iso8601_ms: completionTime.toISOString(),
      trust_level: "local_asserted",
    },
    actor: config.actor,
    provider: provider.provider,
    model,
    request_id: info.requestId,
    attempt_index: info.attemptIndex,
    outcome: info.outcome,
    content_captured: captured,
    capture_mode: info.captureMode,
    content,
    content_commitments: commitments,
    usage,
  };

  try {
    await appendBody(store, body, config.signer);
  } catch (err) {
    // S2.1: emission failure must NOT fail the wrapped call. Log to sidecar.
    logError("failed to append receipt", err);
  }
}

/** Compute HMAC-SHA256 commitments (D10) + unkeyed integrity digests over content. */
function computeCommitments(
  key: Uint8Array,
  requestBody?: JsonValue,
  responseBody?: JsonValue,
  responseText?: string,
): ReceiptBody["content_commitments"] {
  const out: NonNullable<ReceiptBody["content_commitments"]> = {};
  if (requestBody !== undefined) {
    const bytes = Buffer.from(JSON.stringify(requestBody), "utf8");
    out.request = toHex(hmac(key, bytes));
    out.request_integrity = toHex(sha256(bytes));
  }
  const respBytes =
    responseBody !== undefined
      ? Buffer.from(JSON.stringify(responseBody), "utf8")
      : responseText !== undefined
        ? Buffer.from(responseText, "utf8")
        : undefined;
  if (respBytes) {
    out.response = toHex(hmac(key, respBytes));
    out.response_integrity = toHex(sha256(respBytes));
  }
  return out;
}

/** Is this a streaming request (`stream: true` in the body)? */
function isStreamingRequest(requestBody?: JsonValue): boolean {
  if (requestBody === undefined) return false;
  const stream = pick(requestBody, "stream");
  return stream === true;
}

/** Is this an SSE response (content-type text/event-stream)? */
function isEventStreamResponse(response: Response): boolean {
  const ct = response.headers.get("content-type") ?? "";
  return ct.includes("text/event-stream");
}

/** Read a property from a JSON object (case-insensitive on the top level). */
function pick(obj: JsonValue, key: string): JsonValue | undefined {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const lower = key.toLowerCase();
    for (const k of Object.keys(obj)) {
      if (k.toLowerCase() === lower) return (obj as Record<string, JsonValue>)[k];
    }
  }
  return undefined;
}

function readRequestId(response: Response, headers: string[]): string | undefined {
  for (const h of headers) {
    const v = response.headers.get(h);
    if (v) return v;
  }
  return undefined;
}

/**
 * Attempt index: OpenAI/Anthropic don't expose the retry count to the fetch layer directly, but
 * they set headers on retries. We record the attempt as best-effort (defaulting to 0). Each HTTP
 * attempt gets its own receipt regardless (the wrapper is invoked per attempt — S2.2), so even
 * without an exact index, every attempt is attributable.
 */
function readAttemptIndex(init?: RequestInit): number | undefined {
  // No reliable per-attempt index from the SDK; we leave it unset unless the caller threads one.
  // The wrapper being invoked per-attempt is the attribution mechanism.
  void init;
  return undefined;
}

/**
 * Parse a Server-Sent-Events text blob into an ordered list of JSON `data:` payloads.
 * Lines beginning with `data:` carry the event payload; `data: [DONE]` terminates OpenAI streams.
 * Blank lines separate events. This is the shared SSE framing both OpenAI and Anthropic use.
 */
export function parseSseEvents(sseText: string): JsonValue[] {
  const events: JsonValue[] = [];
  const lines = sseText.split("\n");
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload) as JsonValue);
    } catch {
      // Skip unparseable chunks (e.g. partial/keepalive).
    }
  }
  return events;
}

/** Convenience: build a signer from a core KeyPair. */
export function keyPairToSigner(kp: KeyPair) {
  return {
    keyId: kp.keyId,
    sign: (canonicalBody: string) => sign(Buffer.from(canonicalBody, "utf8"), kp.privateKey),
  };
}
