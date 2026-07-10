/**
 * @receipta/vercel — emit signed, hash-chained receipts for Vercel AI SDK calls.
 *
 * USAGE (v7):
 * ```ts
 * import { registerTelemetry } from "ai";
 * import { receiptaTelemetry } from "@receipta/vercel";
 *
 * registerTelemetry(receiptaTelemetry({ store, signer, actor }));
 * // every generateText/streamText now emits a receipt via the callback.
 * ```
 *
 * DESIGN (PLAN D8/D11, IMPLICIT_SPEC S1.3/S2.1/S2.5):
 * - Unlike the fetch adapters, there's no HTTP to wrap. The `Telemetry` integration's
 *   `onLanguageModelCallEnd`/`onEnd` callbacks deliver the FULL ASSEMBLED RESULT (independent of
 *   recordInputs/recordOutputs — verified firsthand), so the output commitment is over the final
 *   assembled output (S2.5).
 * - `content_captured` reflects whether the user enabled `recordInputs`/`recordOutputs`. The
 *   callback always fires, but content may be absent if recording was disabled → we set the flag
 *   honestly (the S1.3 metadata-only edge case).
 * - Emission inside the callback is wrapped in try/catch and logged to a sidecar: the callback
 *   runs inside the SDK's own dispatch, so an uncaught throw would surface to the user's
 *   generateText/streamText and violate S2.1.
 * - A v6 shim maps the v6 names (`registerTelemetryIntegration`, `experimental_telemetry`,
 *   `onFinish`) to the v7 callback shape.
 */
import { Buffer } from "node:buffer";
import {
  appendBody,
  hmac,
  sha256,
  toHex,
  keyPairToSigner,
  type Actor,
  type ContentCaptureMode,
  type JsonValue,
  type KeyPair,
  type ReceiptStore,
} from "@receipta/core";

/** The event the v7 Telemetry integration delivers when a language model call ends. */
export interface LanguageModelCallEndEvent {
  callId?: string;
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  responseId?: string;
  /** The assembled output (may be absent if the user disabled recordOutputs). */
  content?: unknown;
  /** Convenience: the assembled text, when the SDK provides it separately from content. */
  text?: string;
  model?: string;
  /** The provider's id, when available. */
  provider?: string;
}

/** The event delivered when a full stream/text generation ends. */
export interface GenerationEndEvent {
  text?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  finishReason?: string;
  responseMessages?: unknown;
  functionId?: string;
  metadata?: Record<string, unknown>;
}

/** The v7 Telemetry integration shape (a subset — receipta only needs the call-end hooks). */
export interface ReceiptaTelemetry {
  onLanguageModelCallEnd?: (event: LanguageModelCallEndEvent) => void;
  onEnd?: (event: GenerationEndEvent) => void;
}

/** What the telemetry factory needs to build receipts. */
export interface ReceiptaTelemetryConfig {
  store: ReceiptStore;
  signer: KeyPair;
  actor: Actor;
  /** Whether content was recorded; default "full". Set "metadata_only" to omit content. */
  captureMode?: ContentCaptureMode;
  /** Optional logger for emission errors (defaults to stderr). */
  logError?: (msg: string, err: unknown) => void;
}

/**
 * Build a Telemetry integration that emits a receipt for each language-model call.
 *
 * Returns an object suitable for `registerTelemetry(receiptaTelemetry(cfg))`. The receipt is
 * built in `onLanguageModelCallEnd` (the per-call hook); `onEnd` is wired for completeness but the
 * canonical record is the per-call one (a generation maps 1:1 to a model call in the common case).
 */
export function receiptaTelemetry(config: ReceiptaTelemetryConfig): ReceiptaTelemetry {
  const captureMode = config.captureMode ?? "full";
  const logError = config.logError ?? defaultLogError;
  const signer = keyPairToSigner(config.signer);
  const commitmentKey = Buffer.from(config.store.meta.commitment_key, "hex");

  const onLanguageModelCallEnd = (event: LanguageModelCallEndEvent) => {
    // Wrap emission: the callback runs inside the SDK's dispatch, so a throw would surface to the
    // user's call (S2.1). Catch + log to sidecar.
    emit(() => {
      const model = event.model ?? "unknown";
      const provider = event.provider ?? "vercel-ai-sdk";
      const captured = captureMode === "full" && event.content !== undefined;
      const content = captured
        ? {
            response: event.content as JsonValue,
          }
        : undefined;
      const usage = event.usage
        ? {
            input_tokens: event.usage.promptTokens,
            output_tokens: event.usage.completionTokens,
          }
        : undefined;
      const commitments = content?.response !== undefined
        ? {
            response: toHex(hmac(commitmentKey, Buffer.from(JSON.stringify(content.response), "utf8"))),
            response_integrity: toHex(sha256(Buffer.from(JSON.stringify(content.response), "utf8"))),
          }
        : undefined;

      return appendBody(
        config.store,
        {
          timestamp: { iso8601_ms: new Date().toISOString(), trust_level: "local_asserted" },
          actor: config.actor,
          provider,
          model,
          request_id: event.callId ?? event.responseId,
          outcome: event.finishReason === "error" ? "error" : "success",
          content_captured: captured,
          capture_mode: captureMode,
          content,
          content_commitments: commitments,
          usage,
        },
        signer,
      );
    }, logError);
  };

  return { onLanguageModelCallEnd };
}

/** Emit, catching any error. Returns the build/append function so the wrapper is shared. */
function emit(build: () => Promise<unknown>, logError: (msg: string, err: unknown) => void): void {
  void build().catch((err) => logError("failed to append receipt from telemetry callback", err));
}

const defaultLogError = (msg: string, err: unknown) => {
  process.stderr.write(`[receipta] ${msg}: ${String(err)}\n`);
};

// ─── v6 shim ────────────────────────────────────────────────────────────────

/**
 * v6 compatibility shim. In AI SDK v6, telemetry used `registerTelemetryIntegration` with an
 * `experimental_telemetry` option and `onFinish` callback. This wraps a v7 receiptaTelemetry so
 * it can be registered with either the v6 or v7 API.
 *
 * The v7 names exist as deprecated aliases in v7, easing a single code path. This shim lets a v6
 * user call `registerTelemetryIntegration(receiptaTelemetryV6(cfg))` and get the same receipts.
 */
export interface ReceiptaTelemetryV6 {
  name: string;
  /** v6 experimental_telemetry options surface. */
  options?: Record<string, unknown>;
  /** v6 finish callback (maps to onLanguageModelCallEnd). */
  onFinish?: (result: { finishReason?: string; usage?: { promptTokens?: number; completionTokens?: number }; text?: string; response?: { id?: string; messages?: unknown }; model?: string }) => void;
}

export function receiptaTelemetryV6(config: ReceiptaTelemetryConfig): ReceiptaTelemetryV6 {
  const v7 = receiptaTelemetry(config);
  return {
    name: "receipta",
    onFinish: (result) => {
      v7.onLanguageModelCallEnd?.({
        finishReason: result.finishReason,
        usage: result.usage,
        text: result.text,
        model: result.model,
        responseId: result.response?.id,
        content: result.text ?? result.response?.messages,
      });
    },
  };
}

export { keyPairToSigner } from "@receipta/core";
export type { Actor, ContentCaptureMode, ReceiptStore } from "@receipta/core";
