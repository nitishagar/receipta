# Anthropic adapter

`@receipta/anthropic` wraps the [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) (v0.30+, including current v0.110) so every Messages API call emits a receipt.

## How it works

Same no-fork pattern as the OpenAI adapter — both SDKs share the `fetchWithTimeout` lineage (verified firsthand). The only provider-specific differences:

- the request id header is **`request-id`** (Anthropic) vs `x-request-id` (OpenAI),
- usage is `input_tokens` / `output_tokens` (Anthropic) vs `prompt_tokens` / `completion_tokens`,
- the response carries `stop_reason` vs `finish_reason`.

The fetch layer is the version-stable single integration point.

## Usage

```ts
import Anthropic from '@anthropic-ai/sdk';
import { withReceipts } from '@receipta/anthropic';
import { openStore, generateKeyPair } from '@receipta/core';

const store = await openStore('./receipts.log.receipta');
const signer = generateKeyPair();

const client = withReceipts(
  Anthropic,
  { apiKey: process.env.ANTHROPIC_API_KEY! },
  {
    store,
    signer,
    actor: { type: 'service', id: 'my-app' },
  },
);

const res = await client.messages.create({
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
});
```

## What gets captured

- `provider`: `"anthropic"`
- `model`: from the response body
- `usage`: `input_tokens` / `output_tokens`
- `request_id`: the `request-id` header
- `attempt_index`: best-effort, sourced from the Stainless SDK's `x-stainless-retry-count` request header (`0` on the first attempt, incrementing on retry); omitted when the header is absent
- `outcome`: `success` for 2xx, `error` otherwise
- `content`: the request + response bodies (when `captureMode: "full"`)
