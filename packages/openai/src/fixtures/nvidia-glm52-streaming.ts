/**
 * Recorded-trace fixture: NVIDIA NIM streaming, `z-ai/glm-5.2` via integrate.api.nvidia.com.
 *
 * Provenance: captured 2026-07-11 against the live gateway (see
 * thoughts/shared/research/2026-07-11-openai-compat-gateway-receipt-gaps.md, "Live Evidence").
 * The request id arrives ONLY in the `nvcf-reqid` header (no `x-request-id`). Intermediate
 * chunks carry `"usage": null`; the final chunk before `[DONE]` carries the usage object on a
 * `choices: []` chunk — the NVIDIA shape. Reasoning deltas carry `delta.reasoning_content`.
 *
 * This fixture encodes the three confirmed live failures at once:
 *  - request_id must come from `nvcf-reqid` (FAILS today: header not in the list),
 *  - usage must come from the final `choices: []` chunk (passes today — regression guard),
 *  - `reasoning_content` must survive into the assembled message (FAILS today: dropped).
 */
export const nvidiaGlm52Streaming = {
  name: "nvidia-glm52-streaming",
  streaming: true,
  /** Verbatim SSE bytes (data: lines + blank separators). */
  sseText: [
    'data: {"id":"chatcmpl-nvidia-1","object":"chat.completion.chunk","created":1720000000,"model":"z-ai/glm-5.2","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Thinking "},"usage":null,"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl-nvidia-1","object":"chat.completion.chunk","created":1720000000,"model":"z-ai/glm-5.2","choices":[{"index":0,"delta":{"reasoning_content":"it through.","content":"Hello"},"usage":null,"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl-nvidia-1","object":"chat.completion.chunk","created":1720000000,"model":"z-ai/glm-5.2","choices":[{"index":0,"delta":{"content":" world"},"usage":null,"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl-nvidia-1","object":"chat.completion.chunk","created":1720000000,"model":"z-ai/glm-5.2","choices":[{"index":0,"delta":{},"usage":null,"finish_reason":"stop"}]}',
    "",
    'data: {"id":"chatcmpl-nvidia-1","object":"chat.completion.chunk","created":1720000000,"model":"z-ai/glm-5.2","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n"),
  headers: { "content-type": "text/event-stream", "nvcf-reqid": "r-nvidia-glm52-001" },
  expect: {
    request_id: "r-nvidia-glm52-001",
    usage: { input_tokens: 11, output_tokens: 2 },
    hasReasoningContent: true,
    reasoningContent: "Thinking it through.",
    contentText: "Hello world",
  },
} as const;
