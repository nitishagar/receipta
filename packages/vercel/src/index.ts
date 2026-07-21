/**
 * @receipta/vercel — emit signed, hash-chained receipts for Vercel AI SDK calls.
 *
 * USAGE (v7):
 * ```ts
 * import { registerTelemetry } from "ai";
 * import { receiptaTelemetry } from "@receipta/vercel";
 *
 * const telemetry = receiptaTelemetry({ store, signer, actor });
 * registerTelemetry(telemetry);
 * // every generateText/streamText now emits a receipt via the onLanguageModelCallEnd callback.
 * await telemetry.flush(); // before closing the store — see the flush() contract below.
 * ```
 *
 * DESIGN (PLAN D8/D11, IMPLICIT_SPEC S1.3/S2.1/S2.5):
 * - Unlike the fetch adapters, there's no HTTP to wrap. The `Telemetry` integration's
 *   `onLanguageModelCallEnd` callback delivers the FULL ASSEMBLED RESULT (independent of
 *   recordInputs/recordOutputs — verified firsthand), so the output commitment is over the final
 *   assembled output (S2.5).
 * - `content_captured` reflects whether the user enabled `recordInputs`/`recordOutputs`. The
 *   callback always fires, but content may be absent if recording was disabled → we set the flag
 *   honestly (the S1.3 metadata-only edge case).
 * - Emission inside the callback is wrapped in try/catch and logged to a sidecar: the callback
 *   runs inside the SDK's own dispatch, so an uncaught throw would surface to the user's
 *   generateText/streamText and violate S2.1. NOTE: because the SDK callback contract is
 *   `(event) => void` (not awaited), receipt emission is fire-and-forget; if the build/append
 *   throws SYNCHRONOUSLY before a promise exists, that throw is converted to a rejection inside
 *   `emit()` and logged rather than propagated to the caller. Call `flush()` to await the tail.
 * - A v6 shim maps the v6 names (`registerTelemetryIntegration`, `experimental_telemetry`,
 *   `onFinish`) to the v7 callback shape.
 */
import { Buffer } from 'node:buffer';
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
} from '@receipta/core';

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

/** The v7 Telemetry integration shape (a subset — receipta only needs the per-call hook). */
export interface ReceiptaTelemetry {
  onLanguageModelCallEnd?: (event: LanguageModelCallEndEvent) => void;
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
 * A telemetry integration that also exposes a `flush()` to await pending receipts.
 *
 * The SDK's callback contract is `(event) => void` — it does not await our work. So receipt
 * emission is launched but not awaited. Call `flush()` before closing the store (or at the end of
 * a request) to guarantee every pending receipt has landed durably. Without this, closing the
 * store immediately after a generation can lose the final receipt(s).
 */
export interface ReceiptaTelemetryWithFlush extends ReceiptaTelemetry {
  /** Await all in-flight receipt emissions. Resolves when the queue is drained. */
  flush(): Promise<void>;
}

/**
 * Build a Telemetry integration that emits a receipt for each language-model call.
 *
 * Returns an object suitable for `registerTelemetry(receiptaTelemetry(cfg))`. The receipt is built
 * in `onLanguageModelCallEnd` — the per-call hook is the canonical record (a generation maps 1:1 to a
 * model call in the common case). There is intentionally NO generation-end hook: the SDK does not
 * guarantee one fires before the caller's promise resolves in a way we can rely on, and a second
 * emission there would risk a double receipt for a single call.
 *
 * Because the SDK callback is `(event) => void` (not awaited), emission is fire-and-forget. The
 * returned object exposes `flush()` — call it before closing the store to drain pending receipts
 * (otherwise the final receipt(s) of a generation can be lost). Note `flush()` drains the snapshot of
 * in-flight emissions at call time; emissions racing in after `flush()` returns are caller misuse.
 */
export function receiptaTelemetry(config: ReceiptaTelemetryConfig): ReceiptaTelemetryWithFlush {
  const captureMode = config.captureMode ?? 'full';
  const logError = config.logError ?? defaultLogError;
  const signer = keyPairToSigner(config.signer);
  const commitmentKey = Buffer.from(config.store.meta.commitment_key, 'hex');

  // Track in-flight emissions so flush() can await them (the fire-and-forget race fix, F-2).
  let pending: Promise<void> = Promise.resolve();

  const onLanguageModelCallEnd = (event: LanguageModelCallEndEvent) => {
    // Wrap emission: the callback runs inside the SDK's dispatch, so a throw would surface to the
    // user's call (S2.1). Catch + log to sidecar. Track the promise so flush() can drain it.
    pending = emit(
      pending,
      () => {
        const model = event.model ?? 'unknown';
        const provider = event.provider ?? 'vercel-ai-sdk';
        const captured = captureMode === 'full' && event.content !== undefined;
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
        const commitments =
          content?.response !== undefined
            ? {
                response: toHex(
                  hmac(commitmentKey, Buffer.from(JSON.stringify(content.response), 'utf8')),
                ),
                response_integrity: toHex(
                  sha256(Buffer.from(JSON.stringify(content.response), 'utf8')),
                ),
              }
            : undefined;

        return appendBody(
          config.store,
          {
            timestamp: { iso8601_ms: new Date().toISOString(), trust_level: 'local_asserted' },
            actor: config.actor,
            provider,
            model,
            request_id: event.callId ?? event.responseId,
            outcome: event.finishReason === 'error' ? 'error' : 'success',
            content_captured: captured,
            capture_mode: captureMode,
            content,
            content_commitments: commitments,
            usage,
          },
          signer,
        );
      },
      logError,
    );
  };

  return {
    onLanguageModelCallEnd,
    async flush() {
      // Await the tail of the pending-emissions chain. New emissions append to `pending` after
      // this await starts; we drain the snapshot at call time (sufficient for "close the store
      // after a generation" — no new emissions are expected once the SDK call has returned).
      await pending;
    },
  };
}

/**
 * Emit, catching any error (S2.1). The build function may throw SYNCHRONOUSLY (e.g. a malformed
 * content payload fails JSON.stringify before appendBody returns a promise), so we defer it into a
 * promise chain with Promise.resolve().then(build) — this turns a synchronous throw into a
 * rejection that `.catch` handles. Without this, a sync throw would propagate out of the callback
 * into the SDK's dispatch and surface to the user's generateText/streamText.
 *
 * Returns the (extended) pending chain so callers can track in-flight emissions for flush().
 */
function emit(
  prev: Promise<void>,
  build: () => Promise<unknown>,
  logError: (msg: string, err: unknown) => void,
): Promise<void> {
  // Chain on the previous pending emission so appends stay in chain order, and swallow errors so
  // one failure doesn't reject the whole chain (each emit logs its own error).
  const next = prev.then(
    () => Promise.resolve().then(build),
    () => Promise.resolve().then(build),
  );
  next.catch((err) => logError('failed to append receipt from telemetry callback', err));
  // Convert to Promise<void> for the chain; a rejection was already logged above.
  return next.then(
    () => undefined,
    () => undefined,
  );
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
  onFinish?: (result: {
    finishReason?: string;
    usage?: { promptTokens?: number; completionTokens?: number };
    text?: string;
    response?: { id?: string; messages?: unknown };
    model?: string;
  }) => void;
  /** Await all in-flight receipt emissions (the fire-and-forget race fix). */
  flush?: () => Promise<void>;
}

export function receiptaTelemetryV6(config: ReceiptaTelemetryConfig): ReceiptaTelemetryV6 {
  const v7 = receiptaTelemetry(config);
  return {
    name: 'receipta',
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
    flush: () => v7.flush(),
  };
}

export { keyPairToSigner } from '@receipta/core';
export type { Actor, ContentCaptureMode, ReceiptStore } from '@receipta/core';
