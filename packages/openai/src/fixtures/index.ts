/**
 * Recorded-trace fixture corpus for the OpenAI adapter (G6.1 provenance). Each fixture bundles
 * a verbatim provider trace (SSE for streaming, JSON for non-streaming), the real response
 * headers, and an `expect` object pinning the per-trace contract. The parameterized trace
 * driver in index.test.ts feeds each through `createReceiptFetch`.
 */
export { nvidiaGlm52Streaming } from "./nvidia-glm52-streaming.js";
export { nvidiaLlamaStreaming } from "./nvidia-llama-streaming.js";
export { openaiReasoningToolStreaming } from "./openai-reasoning-tool-streaming.js";
export { openaiNoUsageStreaming } from "./openai-no-usage-streaming.js";
export { openai2xxBodyError } from "./openai-2xx-body-error.js";

import { nvidiaGlm52Streaming } from "./nvidia-glm52-streaming.js";
import { nvidiaLlamaStreaming } from "./nvidia-llama-streaming.js";
import { openaiReasoningToolStreaming } from "./openai-reasoning-tool-streaming.js";
import { openaiNoUsageStreaming } from "./openai-no-usage-streaming.js";

/** All streaming fixtures for the fidelity property + parameterized driver. */
export const openaiStreamingFixtures = [
  nvidiaGlm52Streaming,
  nvidiaLlamaStreaming,
  openaiReasoningToolStreaming,
  openaiNoUsageStreaming,
];
