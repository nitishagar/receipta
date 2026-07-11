/**
 * Anthropic streaming trace with NO usage events (no `message_start` usage, no `message_delta`
 * usage). Pins G3.1: `usage` MUST be `undefined` (honest absence) — today the assembler
 * fabricates `usage: {input_tokens: 0, output_tokens: 0}`, which reads as "zero tokens".
 */
export const anthropicNoUsageStreaming = {
  name: "anthropic-no-usage-streaming",
  streaming: true,
  sseText: [
    'data: {"type":"message_start","message":{"id":"msg_nu","model":"claude-3-5-sonnet-20241022"}}',
    "",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
    "",
    'data: {"type":"content_block_stop","index":0}',
    "",
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    "",
  ].join("\n"),
  headers: { "content-type": "text/event-stream", "request-id": "req-anthropic-nu-002" },
  expect: {
    request_id: "req-anthropic-nu-002",
    usageUndefined: true,
    textText: "hi",
  },
} as const;
