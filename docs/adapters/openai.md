# OpenAI adapter

`@receipta/openai` wraps the [`openai`](https://www.npmjs.com/package/openai) SDK (v5+, including current v6) so every chat completion emits a receipt.

## How it works

No fork. The OpenAI SDK accepts a `fetch` constructor option and invokes it **per HTTP attempt** (including retries — verified firsthand). receipta injects a `fetch` that:

1. reads the request body (model, messages, params),
2. delegates to the real `fetch`,
3. `clone()`s the response and reads the clone (the **original** stays unconsumed so the SDK's own parser sees an intact body — non-interference),
4. builds a receipt with usage, model, and the `x-request-id` header,
5. appends it to the store,
6. returns the original response.

Receipt emission is wrapped in try/catch — it never throws into your call.

## Usage

```ts
import OpenAI from 'openai';
import { withReceipts } from '@receipta/openai';
import { openStore, generateKeyPair } from '@receipta/core';

const store = await openStore('./receipts.log.receipta');
const signer = generateKeyPair();

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

## What gets captured

- `provider`: `"openai"`
- `model`: from the response body
- `usage`: `prompt_tokens` / `completion_tokens` (mapped to `input_tokens` / `output_tokens`)
- `request_id`: the `x-request-id` header
- `attempt_index`: best-effort, sourced from the Stainless SDK's `x-stainless-retry-count` request header (`0` on the first attempt, incrementing on retry); omitted when the header is absent
- `outcome`: `success` for 2xx, `error` otherwise
- `content`: the request + response bodies (when `captureMode: "full"`)
- `content_commitments`: HMAC-SHA256 over request/response (keyed, not bare digests)

## Streaming

For streaming responses, the fetch wrapper buffers the cloned SSE stream and computes the output commitment over the **final assembled** message (not intermediate chunks).
