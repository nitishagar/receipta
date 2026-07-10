/**
 * @receipta/openai — emit signed, hash-chained receipts for OpenAI chat completions.
 *
 * USAGE:
 * ```ts
 * import OpenAI from "openai";
 * import { withReceipts } from "@receipta/openai";
 *
 * const client = withReceipts(new OpenAI({ apiKey }), { store, signer, actor });
 * // use `client` exactly as you would a normal OpenAI instance — receipts are emitted per call.
 * const res = await client.chat.completions.create({ model: "gpt-4o", messages: [...] });
 * ```
 *
 * DESIGN (PLAN D11, IMPLICIT_SPEC S2.1/S2.2):
 * - No fork: we inject a `fetch` into the OpenAI client. The SDK invokes it per HTTP attempt
 *   (verified firsthand in openai v6: makeRequest→fetchWithAuth→fetchWithTimeout→this.fetch),
 *   so receipta attributes every attempt including failures and retries.
 * - Non-interference: the response is cloned before reading; the original is returned unconsumed
 *   so the SDK's own parser sees an intact body (S2.1). Receipt emission is try/caught and never
 *   throws into the wrapped call.
 * - Per-attempt: each fetch invocation = one receipt (outcome success/error, request id, status).
 */
import {
  createReceiptFetch,
  keyPairToSigner,
  type ProviderAdapter,
  type ReceiptCaptureConfig,
  type FetchLike,
} from "@receipta/core";
import type { KeyPair } from "@receipta/core";

/**
 * The OpenAI provider adapter — how to read OpenAI-specific fields out of a response.
 *
 * ChatCompletion body shape: { id, model, choices: [{ finish_reason }], usage: { prompt_tokens,
 * completion_tokens } }. The request id is in the `x-request-id` header (verified firsthand).
 */
export const openaiProvider: ProviderAdapter = {
  provider: "openai",
  requestIdHeaders: ["x-request-id"],
  extractUsage(body) {
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const usage = (body as Record<string, unknown>).usage;
      if (usage && typeof usage === "object" && !Array.isArray(usage)) {
        const u = usage as Record<string, unknown>;
        return {
          input_tokens: num(u.prompt_tokens),
          output_tokens: num(u.completion_tokens),
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
 * Wrap the OpenAI SDK so every chat completion emits a receipt.
 *
 * Pass the `OpenAI` constructor, your options, and a capture config. Returns a client you use
 * exactly as you would `new OpenAI(options)` — the fetch hook is injected, so every HTTP attempt
 * is attributed. We construct the client for you (rather than wrapping an existing instance)
 * because the fetch hook is a constructor option; reaching into a constructed client's private
 * state to re-inject it would be version-fragile.
 *
 * ```ts
 * import OpenAI from "openai";
 * const client = withReceipts(OpenAI, { apiKey }, { store, signer, actor });
 * ```
 */
export function withReceipts<T extends new (opts: Record<string, unknown>) => unknown>(
  Client: T,
  options: Record<string, unknown>,
  capture: Omit<ReceiptCaptureConfig, "signer"> & { signer: KeyPair },
): InstanceType<T> {
  const receiptFetch = createReceiptFetch(
    openaiProvider,
    toConfig(capture),
    (options.fetch as FetchLike | undefined) ?? undefined,
  );
  return new Client({ ...options, fetch: receiptFetch }) as InstanceType<T>;
}

function toConfig(capture: Omit<ReceiptCaptureConfig, "signer"> & { signer: KeyPair }): ReceiptCaptureConfig {
  return { ...capture, signer: keyPairToSigner(capture.signer) };
}

// Re-export the pieces a user might want for custom integrations.
export { createReceiptFetch, keyPairToSigner } from "@receipta/core";
export type { ProviderAdapter, ReceiptCaptureConfig, FetchLike } from "@receipta/core";
