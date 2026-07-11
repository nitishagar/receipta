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
import OpenAI from "openai";
import { withReceipts } from "@receipta/openai";
import { openStore, generateKeyPair } from "@receipta/core";

const store = await openStore("./receipts.log.receipta");
const signer = generateKeyPair(); // in practice, load from env/KMS

// Use the wrapped client exactly as you would `new OpenAI(...)`.
const client = withReceipts(OpenAI, { apiKey: process.env.OPENAI_API_KEY! }, {
  store,
  signer,
  actor: { type: "service", id: "my-app" },
  captureMode: "full", // or "metadata_only" to omit content
});

const res = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
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
- `request_id` from the `x-request-id` header
- `outcome` (`success` for 2xx, `error` otherwise), one receipt per attempt
- request + response content when `captureMode: "full"`, with keyed HMAC-SHA256 commitments
- streaming: the output commitment is computed over the **final assembled** message, not raw SSE chunks

## Docs

Full documentation: **https://nitishagar.github.io/receipta/adapters/openai**

## License

Apache-2.0
