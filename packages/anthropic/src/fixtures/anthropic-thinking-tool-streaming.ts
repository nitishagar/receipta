/**
 * Anthropic streaming trace carrying a `thinking` block (from `thinking_delta`), a `text`
 * block, and a `tool_use` block assembled from `input_json_delta` partial-JSON fragments.
 *
 * Pins G2.2: assembled `content` MUST be an ordered array of blocks [thinking, text, tool_use]
 * matching the non-streaming Message shape, with the tool input parsed at block end. The
 * `content_block_start`/`content_block_stop` lifecycle is included (canonical Anthropic shape);
 * the assembler must also tolerate delta-only traces (fallback) — covered separately.
 *
 * Payloads are JSON.stringify'd from JS objects to guarantee valid JSON.
 */

function data(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}`;
}

export const anthropicThinkingToolStreaming = {
  name: 'anthropic-thinking-tool-streaming',
  streaming: true,
  sseText: [
    data({
      type: 'message_start',
      message: { id: 'msg_tt', model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 10 } },
    }),
    '',
    data({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    }),
    '',
    data({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Reasoning ' },
    }),
    '',
    data({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'about the weather.' },
    }),
    '',
    data({ type: 'content_block_stop', index: 0 }),
    '',
    data({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    '',
    data({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Let me check.' },
    }),
    '',
    data({ type: 'content_block_stop', index: 1 }),
    '',
    data({
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: {} },
    }),
    '',
    data({
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"loc' },
    }),
    '',
    data({
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: 'ation":"SF"}' },
    }),
    '',
    data({ type: 'content_block_stop', index: 2 }),
    '',
    data({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 8 },
    }),
    '',
  ].join('\n'),
  headers: { 'content-type': 'text/event-stream', 'request-id': 'req-anthropic-tt-001' },
  expect: {
    request_id: 'req-anthropic-tt-001',
    usage: { input_tokens: 10, output_tokens: 8 },
    /** Ordered block types in the assembled content array. */
    blockTypes: ['thinking', 'text', 'tool_use'],
    thinkingText: 'Reasoning about the weather.',
    textText: 'Let me check.',
    toolUse: { id: 'toolu_01', name: 'get_weather', input: { location: 'SF' } },
    stopReason: 'tool_use',
  },
} as const;
