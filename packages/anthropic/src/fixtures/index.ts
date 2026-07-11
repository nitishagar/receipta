/**
 * Recorded-trace fixture corpus for the Anthropic adapter (G6.1 provenance). Each fixture
 * bundles a verbatim provider SSE trace, the real response headers, and an `expect` object
 * pinning the per-trace contract.
 */
export { anthropicThinkingToolStreaming } from "./anthropic-thinking-tool-streaming.js";
export { anthropicNoUsageStreaming } from "./anthropic-no-usage-streaming.js";
export { anthropicRedactedStreaming } from "./anthropic-redacted-streaming.js";

import { anthropicThinkingToolStreaming } from "./anthropic-thinking-tool-streaming.js";
import { anthropicNoUsageStreaming } from "./anthropic-no-usage-streaming.js";
import { anthropicRedactedStreaming } from "./anthropic-redacted-streaming.js";

/** All streaming fixtures for the fidelity property + parameterized driver. */
export const anthropicStreamingFixtures = [
  anthropicThinkingToolStreaming,
  anthropicNoUsageStreaming,
  anthropicRedactedStreaming,
];
