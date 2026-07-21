/**
 * Streaming trace with NO usage chunk at all — the negative-space case for OpenAI usage.
 * OpenAI is already honest (`extractUsage` returns undefined), so this PASSES today and pins
 * G1.3/G3.1 honest-absence: `usage === undefined` (never fabricated to 0/0).
 */
export const openaiNoUsageStreaming = {
  name: 'openai-no-usage-streaming',
  streaming: true,
  sseText: [
    'data: {"id":"chatcmpl-nou-1","object":"chat.completion.chunk","created":1720000000,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-nou-1","object":"chat.completion.chunk","created":1720000000,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n'),
  headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-nou-004' },
  expect: {
    request_id: 'req-nou-004',
    usageUndefined: true,
    contentText: 'ok',
  },
} as const;
