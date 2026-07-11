/**
 * @receipta/anthropic — emit signed, hash-chained receipts for Anthropic Messages API calls.
 *
 * USAGE:
 * ```ts
 * import Anthropic from "@anthropic-ai/sdk";
 * import { withReceipts } from "@receipta/anthropic";
 *
 * const client = withReceipts(Anthropic, { apiKey }, { store, signer, actor });
 * const res = await client.messages.create({ model: "claude-3-5-sonnet-20241022", messages: [...] });
 * ```
 *
 * DESIGN (PLAN D11): reuses the SAME shared fetch-wrapper as @receipta/openai (both SDKs share
 * the `fetchWithTimeout` lineage — verified firsthand). The only provider-specific differences:
 *   - request id header is `request-id` (Anthropic) vs `x-request-id` (OpenAI)
 *   - usage is `input_tokens`/`output_tokens` (Anthropic) vs `prompt_tokens`/`completion_tokens`
 *   - the response carries `stop_reason` (Anthropic) vs `finish_reason` (OpenAI)
 * The fetch layer is the version-stable single integration point (the high-level MessageStream
 * also flows through it), so we hook there.
 */
import {
  createReceiptFetch,
  keyPairToSigner,
  type FetchLike,
  type JsonValue,
  type ProviderAdapter,
  type ReceiptCaptureConfig,
  parseSseEvents,
} from "@receipta/core";
import type { KeyPair } from "@receipta/core";

/**
 * The Anthropic provider adapter. The Messages response body shape:
 * `{ id, model, role: "assistant", content, stop_reason, usage: { input_tokens, output_tokens } }`.
 */
export const anthropicProvider: ProviderAdapter = {
  provider: "anthropic",
  // Ordered: first present header wins. api.anthropic.com sends `request-id` (verified firsthand
  // in @anthropic-ai/sdk, line 565); the list also covers OpenAI-compatible gateways / proxies.
  requestIdHeaders: ["request-id", "x-request-id", "anthropic-request-id"],
  extractUsage(body) {
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const usage = (body as Record<string, unknown>).usage;
      if (usage && typeof usage === "object" && !Array.isArray(usage)) {
        const u = usage as Record<string, unknown>;
        return {
          input_tokens: num(u.input_tokens),
          output_tokens: num(u.output_tokens),
        };
      }
    }
    return undefined;
  },
  extractModel(body) {
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const m = (body as Record<string, unknown>).model;
      return typeof m === "string" ? m : undefined;
    }
    return undefined;
  },
  outcomeFromStatus(status) {
    return status >= 200 && status < 300 ? "success" : "error";
  },
  /**
   * Assemble a Message from buffered streaming events (D8, S2.5).
   * Anthropic streams event-typed chunks: `message_start` (model, input usage), `content_block_delta`
   * (text fragments in `delta.text`), `message_delta` (output usage, stop_reason). Concatenate text
   * and accumulate usage into the assembled Message shape.
   */
  assembleStream(sseText) {
    const events = parseSseEvents(sseText);
    if (events.length === 0) return undefined;
    let text = "";
    let model: string | undefined;
    let id: string | undefined;
    let stopReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    for (const ev of events) {
      if (!ev || typeof ev !== "object" || Array.isArray(ev)) continue;
      const obj = ev as Record<string, unknown>;
      const type = obj.type;
      if (type === "message_start") {
        const msg = obj.message as Record<string, unknown> | undefined;
        if (msg) {
          if (typeof msg.model === "string") model = msg.model;
          if (typeof msg.id === "string") id = msg.id;
          const u = msg.usage as Record<string, unknown> | undefined;
          if (u) {
            inputTokens = num(u.input_tokens) ?? inputTokens;
          }
        }
      } else if (type === "content_block_delta") {
        const delta = obj.delta as Record<string, unknown> | undefined;
        if (delta && typeof delta.text === "string") text += delta.text;
      } else if (type === "message_delta") {
        const delta = obj.delta as Record<string, unknown> | undefined;
        if (delta && typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
        const u = obj.usage as Record<string, unknown> | undefined;
        if (u) outputTokens = num(u.output_tokens) ?? outputTokens;
      }
    }
    return {
      id: id ?? "msg_stream",
      type: "message",
      role: "assistant",
      model: model ?? "unknown",
      content: [{ type: "text", text }],
      stop_reason: stopReason ?? "end_turn",
      usage: {
        input_tokens: inputTokens ?? 0,
        output_tokens: outputTokens ?? 0,
      },
    } as unknown as JsonValue;
  },
};

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/**
 * Wrap the Anthropic SDK so every Messages call emits a receipt. Same pattern as the OpenAI
 * adapter: construct the client with an injected fetch (the per-attempt hook).
 */
export function withReceipts<T extends new (opts: Record<string, unknown>) => unknown>(
  Client: T,
  options: Record<string, unknown>,
  capture: Omit<ReceiptCaptureConfig, "signer"> & { signer: KeyPair },
): InstanceType<T> {
  const receiptFetch = createReceiptFetch(
    anthropicProvider,
    toConfig(capture),
    (options.fetch as FetchLike | undefined) ?? undefined,
  );
  return new Client({ ...options, fetch: receiptFetch }) as InstanceType<T>;
}

function toConfig(capture: Omit<ReceiptCaptureConfig, "signer"> & { signer: KeyPair }): ReceiptCaptureConfig {
  return { ...capture, signer: keyPairToSigner(capture.signer) };
}

export { createReceiptFetch, keyPairToSigner } from "@receipta/core";
export type { ProviderAdapter, ReceiptCaptureConfig, FetchLike } from "@receipta/core";
