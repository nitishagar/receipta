/**
 * Anthropic streaming trace carrying a `redacted_thinking` block (from
 * `redacted_thinking_delta`). Pins the one G2.2 path no other fixture covers: redacted thinking
 * blocks must survive into the assembled content array in block order with their `data` carried
 * through. (Anthropic sends these when a thinking block is safety-redacted.)
 *
 * Payloads are JSON.stringify'd from JS objects to guarantee valid JSON.
 */

function data(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}`;
}

export const anthropicRedactedStreaming = {
  name: 'anthropic-redacted-streaming',
  streaming: true,
  sseText: [
    data({
      type: 'message_start',
      message: { id: 'msg_red', model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 4 } },
    }),
    '',
    data({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: '' },
    }),
    '',
    data({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'redacted_thinking_delta', data: 'blk_abc' },
    }),
    '',
    data({ type: 'content_block_stop', index: 0 }),
    '',
    data({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    '',
    data({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'after redaction' },
    }),
    '',
    data({ type: 'content_block_stop', index: 1 }),
    '',
    data({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 3 },
    }),
    '',
  ].join('\n'),
  headers: { 'content-type': 'text/event-stream', 'request-id': 'req-anthropic-red-003' },
  expect: {
    request_id: 'req-anthropic-red-003',
    usage: { input_tokens: 4, output_tokens: 3 },
    /** Ordered block types — redacted_thinking first, then text. */
    blockTypes: ['redacted_thinking', 'text'],
    redactedData: 'blk_abc',
    textText: 'after redaction',
  },
} as const;
