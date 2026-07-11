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
   *
   * Anthropic streams a block lifecycle: `content_block_start` (opens a block at `index` with a
   * type + initial fields), `content_block_delta` (type-specific delta — text/thinking/input-json),
   * `content_block_stop`. We assemble `content` as the ordered array of blocks [text, thinking,
   * tool_use, redacted_thinking], matching the non-streaming Message shape so the output
   * commitment covers everything the provider sent (S2.5 / S1.3 — G2.2). `message_start` carries
   * the model/id/input usage; `message_delta` carries stop_reason/output usage. Traces that omit
   * `content_block_start` (some proxies) still assemble: the block type is inferred from the delta.
   */
  assembleStream(sseText) {
    const events = parseSseEvents(sseText);
    if (events.length === 0) return undefined;
    let model: string | undefined;
    let id: string | undefined;
    let stopReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    // Content blocks accumulated in arrival order, keyed by `index`.
    const blocks = new Map<number, AnthropicBlock>();
    let maxBlockIndex = -1;

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
      } else if (type === "content_block_start") {
        const index = typeof obj.index === "number" ? obj.index : 0;
        const cb = obj.content_block as Record<string, unknown> | undefined;
        const blockType = normalizeBlockType(typeof cb?.type === "string" ? cb.type : "text");
        const block = openBlock(blockType, cb);
        blocks.set(index, block);
        if (index > maxBlockIndex) maxBlockIndex = index;
      } else if (type === "content_block_delta") {
        const index = typeof obj.index === "number" ? obj.index : 0;
        const delta = obj.delta as Record<string, unknown> | undefined;
        if (!delta) continue;
        // Fallback: if no content_block_start opened this index, infer the block type from delta.
        let block = blocks.get(index);
        if (!block) {
          block = openBlock(deltaTypeToBlockType(typeof delta.type === "string" ? delta.type : "text_delta"), undefined);
          blocks.set(index, block);
          if (index > maxBlockIndex) maxBlockIndex = index;
        }
        extendBlock(block, delta);
      } else if (type === "message_delta") {
        const delta = obj.delta as Record<string, unknown> | undefined;
        if (delta && typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
        const u = obj.usage as Record<string, unknown> | undefined;
        if (u) outputTokens = num(u.output_tokens) ?? outputTokens;
      }
    }

    // Assemble content: ordered blocks by index. If no blocks at all, emit an empty text block
    // (matches the prior behavior for traces with no content deltas).
    const content =
      maxBlockIndex >= 0
        ? [...blocks.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, b]) => finalizeBlock(b))
        : [{ type: "text", text: "" }];

    return {
      id: id ?? "msg_stream",
      type: "message",
      role: "assistant",
      model: model ?? "unknown",
      content,
      stop_reason: stopReason ?? "end_turn",
      usage: {
        input_tokens: inputTokens ?? 0,
        output_tokens: outputTokens ?? 0,
      },
    } as unknown as JsonValue;
  },
};

/** A streaming content-block accumulator (G2.2). */
interface AnthropicBlock {
  type: "text" | "thinking" | "tool_use" | "redacted_thinking";
  text: string;
  thinking: string;
  // tool_use:
  toolId?: string;
  toolName?: string;
  toolInputJson: string;
  // redacted_thinking:
  redactedData?: unknown;
}

/** Open a block from a content_block_start payload (or inferred type for the fallback path). */
function openBlock(blockType: AnthropicBlock["type"], cb: Record<string, unknown> | undefined): AnthropicBlock {
  const block: AnthropicBlock = { type: blockType, text: "", thinking: "", toolInputJson: "" };
  if (cb) {
    if (blockType === "tool_use") {
      if (typeof cb.id === "string") block.toolId = cb.id;
      if (typeof cb.name === "string") block.toolName = cb.name;
    }
    if (blockType === "redacted_thinking" && cb.data !== undefined) block.redactedData = cb.data;
  }
  return block;
}

/** Extend a block from a content_block_delta payload (type-specific). */
function extendBlock(block: AnthropicBlock, delta: Record<string, unknown>): void {
  const dt = typeof delta.type === "string" ? delta.type : "";
  if (dt === "text_delta" && typeof delta.text === "string") {
    block.text += delta.text;
  } else if (dt === "thinking_delta" && typeof delta.thinking === "string") {
    block.thinking += delta.thinking;
  } else if (dt === "input_json_delta" && typeof delta.partial_json === "string") {
    block.toolInputJson += delta.partial_json;
  } else if (dt === "redacted_thinking_delta" && delta.data !== undefined) {
    block.redactedData = delta.data;
  }
}

/** Map a delta `type` to the block type it implies (fallback path when no content_block_start). */
function deltaTypeToBlockType(deltaType: string): AnthropicBlock["type"] {
  if (deltaType === "thinking_delta") return "thinking";
  if (deltaType === "input_json_delta") return "tool_use";
  if (deltaType === "redacted_thinking_delta") return "redacted_thinking";
  return "text";
}

/** Coerce a raw block-type string to the known union, defaulting unknown values to "text". */
function normalizeBlockType(raw: string): AnthropicBlock["type"] {
  if (raw === "text" || raw === "thinking" || raw === "tool_use" || raw === "redacted_thinking") return raw;
  return "text";
}

/** Produce the assembled block in the non-streaming Message content shape. */
function finalizeBlock(b: AnthropicBlock): Record<string, unknown> {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "thinking":
      return { type: "thinking", thinking: b.thinking };
    case "tool_use": {
      // Best-effort parse of the concatenated partial-JSON fragments; keep the raw string if it
      // isn't valid JSON yet (mid-stream / partial). The commitment is over the assembled body
      // regardless, so a string input is still honest evidence.
      let input: unknown = b.toolInputJson;
      if (b.toolInputJson !== "") {
        try {
          input = JSON.parse(b.toolInputJson);
        } catch {
          // keep the raw concatenated string
        }
      }
      const out: Record<string, unknown> = { type: "tool_use", input };
      if (b.toolId !== undefined) out.id = b.toolId;
      if (b.toolName !== undefined) out.name = b.toolName;
      return out;
    }
    case "redacted_thinking": {
      const out: Record<string, unknown> = { type: "redacted_thinking" };
      if (b.redactedData !== undefined) out.data = b.redactedData;
      return out;
    }
  }
}

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
