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
  type ProviderAdapter,
  type ReceiptCaptureConfig,
} from "@receipta/core";
import type { KeyPair } from "@receipta/core";

/**
 * The Anthropic provider adapter. The Messages response body shape:
 * `{ id, model, role: "assistant", content, stop_reason, usage: { input_tokens, output_tokens } }`.
 */
export const anthropicProvider: ProviderAdapter = {
  provider: "anthropic",
  // Verified firsthand in @anthropic-ai/sdk (the request id header is `request-id`, line 565).
  requestIdHeaders: ["request-id"],
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
