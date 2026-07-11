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
  type JsonValue,
  parseSseEvents,
} from "@receipta/core";
import type { KeyPair } from "@receipta/core";

/**
 * The OpenAI provider adapter — how to read OpenAI-specific fields out of a response.
 *
 * ChatCompletion body shape: { id, model, choices: [{ finish_reason }], usage: { prompt_tokens,
 * completion_tokens } }. The request id is in the `x-request-id` header for api.openai.com;
 * the list also covers common OpenAI-compatible gateways (NVIDIA NIM `nvcf-reqid`, Azure
 * `apim-request-id`/`x-ms-request-id`, Cloudflare `cf-ray`), checked in priority order.
 */
export const openaiProvider: ProviderAdapter = {
  provider: "openai",
  // Ordered: first present header wins. api.openai.com sends x-request-id, so it stays first.
  requestIdHeaders: ["x-request-id", "request-id", "nvcf-reqid", "apim-request-id", "x-ms-request-id", "cf-ray"],
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
  /**
   * Assemble a ChatCompletion from buffered streaming chunks (D8, S2.5).
   *
   * OpenAI streams `choices[].delta` fragments. Per choice (keyed by `index`) we accumulate
   * `content` (concat), `reasoning_content` (concat), `tool_calls` (merged by index — append
   * `function.arguments` fragments, first non-null `id`/`type`/`function.name`), and the legacy
   * `function_call`, plus `finish_reason`. The final chunk may carry `usage` (including on a
   * `choices: []` chunk when `stream_options.include_usage` is set or the gateway emits it
   * unsolicited). ALL choices are assembled (not only `choices[0]`), so the output commitment
   * covers everything the provider sent (S2.5 / S1.3 — G2.1).
   */
  assembleStream(sseText) {
    const events = parseSseEvents(sseText);
    if (events.length === 0) return undefined;
    let model: string | undefined;
    let id: string | undefined;
    let usage: Record<string, unknown> | undefined;
    // Per-choice accumulator keyed by `index`. A Map (not an array) so sparse/late indices work.
    const choicesByIndex = new Map<number, ChoiceAccumulator>();
    for (const ev of events) {
      if (!ev || typeof ev !== "object" || Array.isArray(ev)) continue;
      const obj = ev as Record<string, unknown>;
      if (typeof obj.id === "string") id = obj.id;
      if (typeof obj.model === "string") model = obj.model;
      const choices = obj.choices;
      if (Array.isArray(choices)) {
        for (const c of choices as Array<Record<string, unknown>>) {
          const index = typeof c.index === "number" ? c.index : 0;
          const existing = choicesByIndex.get(index);
          const choice: ChoiceAccumulator =
            existing ?? { index, content: "", reasoningContent: "", toolCalls: new Map<number, ToolCallAccumulator>() };
          if (!existing) choicesByIndex.set(index, choice);
          const delta = c.delta as Record<string, unknown> | undefined;
          if (delta) {
            if (typeof delta.content === "string") choice.content += delta.content;
            if (typeof delta.reasoning_content === "string") choice.reasoningContent += delta.reasoning_content;
            // Legacy function_call (deprecated by tool_calls, but still emitted by some models).
            if (delta.function_call && typeof delta.function_call === "object" && !Array.isArray(delta.function_call)) {
              const fc = delta.function_call as Record<string, unknown>;
              choice.functionCall = {
                name: typeof fc.name === "string" ? fc.name : choice.functionCall?.name,
                arguments:
                  typeof fc.arguments === "string"
                    ? (choice.functionCall?.arguments ?? "") + fc.arguments
                    : choice.functionCall?.arguments,
              };
            }
            // tool_calls: merge by `index`. Append function.arguments fragments; first non-null wins for id/type/name.
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
                const tcIndex = typeof tc.index === "number" ? tc.index : 0;
                const existingTc = choice.toolCalls.get(tcIndex);
                const tcc: ToolCallAccumulator =
                  existingTc ?? { index: tcIndex, function: { arguments: "" } };
                if (!existingTc) choice.toolCalls.set(tcIndex, tcc);
                if (typeof tc.id === "string" && tcc.id === undefined) tcc.id = tc.id;
                if (typeof tc.type === "string" && tcc.type === undefined) tcc.type = tc.type;
                const fn = tc.function as Record<string, unknown> | undefined;
                if (fn) {
                  if (typeof fn.name === "string" && tcc.function.name === undefined) tcc.function.name = fn.name;
                  if (typeof fn.arguments === "string") tcc.function.arguments += fn.arguments;
                }
              }
            }
          }
          if (typeof c.finish_reason === "string" && c.finish_reason !== "null") choice.finishReason = c.finish_reason;
        }
      }
      if (obj.usage && typeof obj.usage === "object" && !Array.isArray(obj.usage)) {
        usage = obj.usage as Record<string, unknown>;
      }
    }
    // Assemble ALL choices, sorted by index, each carrying whatever fields appeared.
    const choices = [...choicesByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, acc]) => {
        const toolCalls = [...acc.toolCalls.values()]
          .sort((x, y) => x.index - y.index)
          .map((tcc) => {
            // The non-streaming ChatCompletion shape carries id/type/function (NOT the streaming
            // `index`, which was only the merge key).
            const out: Record<string, unknown> = { function: tcc.function };
            if (tcc.id !== undefined) out.id = tcc.id;
            if (tcc.type !== undefined) out.type = tcc.type;
            return out;
          });
        const message: Record<string, unknown> = { role: "assistant", content: acc.content };
        if (acc.reasoningContent) message.reasoning_content = acc.reasoningContent;
        if (toolCalls.length > 0) message.tool_calls = toolCalls;
        if (acc.functionCall) message.function_call = acc.functionCall;
        return { index, message, finish_reason: acc.finishReason ?? "stop" };
      });
    return {
      id: id ?? "stream",
      object: "chat.completion",
      model: model ?? "unknown",
      choices,
      ...(usage ? { usage } : {}),
    } as unknown as JsonValue;
  },
};

/** Per-choice streaming accumulator (G2.1). */
interface ChoiceAccumulator {
  index: number;
  content: string;
  reasoningContent: string;
  toolCalls: Map<number, ToolCallAccumulator>;
  functionCall?: { name?: string; arguments?: string };
  finishReason?: string;
}

/** Per-tool-call accumulator: deltas for the same `index` merge (lost-update guard). */
interface ToolCallAccumulator {
  index: number;
  id?: string;
  type?: string;
  function: { name?: string; arguments: string };
}

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
