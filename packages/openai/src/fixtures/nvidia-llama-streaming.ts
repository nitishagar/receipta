/**
 * Recorded-trace fixture: NVIDIA NIM streaming, `meta/llama-3.1-8b-instruct`.
 *
 * Provenance: research "Live Evidence" — NVIDIA sends an UNSOLICITED final `choices: []` usage
 * chunk for this model even WITHOUT `stream_options.include_usage`. This is a regression guard:
 * it PASSES today (the assembler reads usage from any chunk incl. `choices: []`) and must keep
 * passing after every later phase.
 */
export const nvidiaLlamaStreaming = {
  name: 'nvidia-llama-streaming',
  streaming: true,
  sseText: [
    'data: {"id":"chatcmpl-llama-1","object":"chat.completion.chunk","created":1720000000,"model":"meta/llama-3.1-8b-instruct","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-llama-1","object":"chat.completion.chunk","created":1720000000,"model":"meta/llama-3.1-8b-instruct","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-llama-1","object":"chat.completion.chunk","created":1720000000,"model":"meta/llama-3.1-8b-instruct","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: {"id":"chatcmpl-llama-1","object":"chat.completion.chunk","created":1720000000,"model":"meta/llama-3.1-8b-instruct","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7,"prompt_tokens_details":{"cached_tokens":0}}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n'),
  headers: { 'content-type': 'text/event-stream', 'nvcf-reqid': 'r-nvidia-llama-002' },
  expect: {
    // request_id still captured from nvcf-reqid once Phase 2 widens the list; today undefined.
    usage: { input_tokens: 5, output_tokens: 2 },
    contentText: 'Hi there',
  },
} as const;
