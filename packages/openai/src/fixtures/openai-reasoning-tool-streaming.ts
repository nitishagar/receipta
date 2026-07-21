/**
 * Canonical-ish OpenAI streaming trace carrying BOTH `reasoning_content` deltas AND a
 * multi-delta `tool_calls` entry (same `index`, fragmentary `function.arguments`).
 *
 * This is the lost-update regression pin for tool_calls accumulation (PLAN Design Analysis,
 * tool_calls accumulation correctness): deltas for the same `index` MUST merge —
 * append `function.arguments` fragments in arrival order and take the first non-null
 * `id`/`type`/`function.name`. Shape follows the canonical OpenAI streaming spec.
 *
 * Payloads are JSON.stringify'd from JS objects to guarantee valid JSON (no hand-escaped quotes).
 */

/** Build one SSE `data:` line from a payload object. */
function data(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}`;
}

const id = 'chatcmpl-tool-1';
const created = 1720000000;
const model = 'gpt-4o';

export const openaiReasoningToolStreaming = {
  name: 'openai-reasoning-tool-streaming',
  streaming: true,
  sseText: [
    data({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', reasoning_content: 'deciding ' },
          finish_reason: null,
        },
      ],
    }),
    '',
    data({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { reasoning_content: 'to call a tool.' }, finish_reason: null }],
    }),
    '',
    data({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_abc',
                type: 'function',
                function: { name: 'get_weather', arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    '',
    data({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"loc' } }] },
          finish_reason: null,
        },
      ],
    }),
    '',
    data({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: 'ation":"NYC"}' } }] },
          finish_reason: null,
        },
      ],
    }),
    '',
    data({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    }),
    '',
    'data: [DONE]',
    '',
  ].join('\n'),
  headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-openai-tool-003' },
  expect: {
    request_id: 'req-openai-tool-003',
    hasReasoningContent: true,
    reasoningContent: 'deciding to call a tool.',
    toolCalls: [
      {
        id: 'call_abc',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"location":"NYC"}' },
      },
    ],
    finishReason: 'tool_calls',
  },
} as const;
