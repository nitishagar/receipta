/**
 * Canonical OpenAI streaming trace carrying BOTH a legacy `delta.function_call` (on choice index 0)
 * AND a second choice (index 1) with its own content. Pins two G2.1 paths no other fixture covers:
 *
 *  - `message.function_call` must survive into the assembled message (G2.1: legacy function_call
 *    "when present"). Deltas carry `{name, arguments}` fragments that concatenate.
 *  - ALL choices must be assembled (G2.1: "ALL choices, not only choices[0]"). The Map accumulator
 *    is keyed by `index`; a choices[1..] fixture proves it isn't silently truncated to index 0.
 *
 * Payloads are JSON.stringify'd from JS objects to guarantee valid JSON.
 */

function data(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}`;
}

const id = 'chatcmpl-fn-mc-1';
const created = 1720000000;
const model = 'gpt-4o';

export const openaiLegacyFnMultichoiceStreaming = {
  name: 'openai-legacy-fn-multichoice-streaming',
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
          delta: {
            role: 'assistant',
            content: '',
            function_call: { name: 'get_time', arguments: '' },
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
        { index: 0, delta: { function_call: { arguments: '{"zone' } }, finish_reason: null },
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
          delta: { function_call: { arguments: '":"UTC"}' } },
          finish_reason: 'function_call',
        },
      ],
    }),
    '',
    data({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 1, delta: { role: 'assistant', content: 'alt ' }, finish_reason: null }],
    }),
    '',
    data({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 1, delta: { content: 'choice' }, finish_reason: 'stop' }],
    }),
    '',
    'data: [DONE]',
    '',
  ].join('\n'),
  headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-openai-fnmc-006' },
  expect: {
    request_id: 'req-openai-fnmc-006',
    /** The legacy function_call assembled from fragmentary deltas (name set once, arguments concatenated). */
    functionCall: { name: 'get_time', arguments: '{"zone":"UTC"}' },
    /** ALL choices assembled — two distinct indices, both present. */
    choiceCount: 2,
    choice1Content: 'alt choice',
    choice1FinishReason: 'stop',
  },
} as const;
