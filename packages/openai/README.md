# @receipta/openai

> Tamper-evident receipts for every OpenAI call.

`@receipta/openai` wraps the [`openai`](https://www.npmjs.com/package/openai) SDK (v5+, including
current v6) so every chat completion emits an **Ed25519-signed, hash-chained receipt** into an
append-only local store — verifiable offline with the
[`receipta` CLI](https://www.npmjs.com/package/@receipta/cli). Part of
[receipta](https://github.com/nitishagar/receipta).

## Install

```bash
npm install @receipta/openai @receipta/core openai
```

## Usage

```ts
import OpenAI from 'openai';
import { withReceipts } from '@receipta/openai';
import { openStore, generateKeyPair } from '@receipta/core';

const store = await openStore('./receipts.log.receipta');
const signer = generateKeyPair(); // in practice, load from env/KMS

// Use the wrapped client exactly as you would `new OpenAI(...)`.
const client = withReceipts(
  OpenAI,
  { apiKey: process.env.OPENAI_API_KEY! },
  {
    store,
    signer,
    actor: { type: 'service', id: 'my-app' },
    captureMode: 'full', // or "metadata_only" to omit content
  },
);

const res = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

Then verify the chain offline:

```bash
npx receipta verify ./receipts.log.receipta --trust-root keys/
```

## How it works

No fork. The OpenAI SDK accepts a `fetch` constructor option and invokes it **per HTTP attempt**
(including retries). receipta injects a `fetch` that delegates to the real one, reads a
`clone()` of the response (the original stays unconsumed — your result is byte-identical), and
appends a signed receipt. Emission is wrapped in try/catch and never throws into your call.

## What gets captured

- `model` and `usage` (`prompt_tokens`/`completion_tokens` → `input_tokens`/`output_tokens`)
- `request_id` from an ordered header list (`x-request-id` first, then `request-id`,
  `nvcf-reqid`, `apim-request-id`, `x-ms-request-id`, `cf-ray`) covering api.openai.com and
  common OpenAI-compatible gateways
- `outcome` (`success` for 2xx, `error` otherwise); a 2xx body carrying a top-level `error`
  object is recorded as `error` too (gateway soft-failure). One receipt per attempt.
- request + response content when `captureMode: "full"`, with keyed HMAC-SHA256 commitments
- streaming: the output commitment is computed over the **final assembled** message, not raw SSE
  chunks — including `reasoning_content`, `tool_calls`, and `function_call` (not just visible
  text), so the commitment covers reasoning and tool output

## Gateway compatibility

This adapter works against any OpenAI-compatible endpoint (NVIDIA NIM, Azure OpenAI,
Cloudflare AI Gateway, vLLM, LiteLLM, OpenRouter, …), not just api.openai.com.

**Request id.** The wrapper detects `request_id` from an ordered header list (above). If your
gateway uses a nonstandard header, pass the full list via the `provider` override — no fork, no
copy of the assembler:

```ts
const client = withReceipts(
  OpenAI,
  { apiKey, baseURL: 'https://integrate.api.nvidia.com/v1' },
  {
    store,
    signer,
    actor: { type: 'service', id: 'my-app' },
    // Override REPLACES the default list — include the headers you want checked, in priority order.
    provider: { requestIdHeaders: ['my-gateway-req-id', 'x-request-id'] },
  },
);
```

**Streaming usage.** Whether a usage chunk is emitted at all is provider/model-dependent (e.g.
some NVIDIA NIM models omit it unless asked). To capture token usage on streaming calls, set
`stream_options: { include_usage: true }` in your request — the wrapper does **not** inject this
(it must not alter your request) and will capture usage when the provider sends it:

```ts
await client.chat.completions.create({
  model: 'z-ai/glm-5.2',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true,
  stream_options: { include_usage: true }, // opt in — the wrapper captures the usage chunk
});
```

When no usage chunk arrives, the receipt records `usage: undefined` (honest absence), never `0`.

## Docs

Full documentation: **<https://nitishagar.github.io/receipta/adapters/openai>**

## License

Apache-2.0
