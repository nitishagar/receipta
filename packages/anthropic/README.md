# @receipta/anthropic

> Tamper-evident receipts for every Anthropic (Claude) call.

`@receipta/anthropic` wraps the
[`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) (v0.30+) so every Messages
API call emits an **Ed25519-signed, hash-chained receipt** into an append-only local store —
verifiable offline with the [`receipta` CLI](https://www.npmjs.com/package/@receipta/cli). Part of
[receipta](https://github.com/nitishagar/receipta).

## Install

```bash
npm install @receipta/anthropic @receipta/core @anthropic-ai/sdk
```

## Usage

```ts
import Anthropic from "@anthropic-ai/sdk";
import { withReceipts } from "@receipta/anthropic";
import { openStore, generateKeyPair } from "@receipta/core";

const store = await openStore("./receipts.log.receipta");
const signer = generateKeyPair(); // in practice, load from env/KMS

// Use the wrapped client exactly as you would `new Anthropic(...)`.
const client = withReceipts(Anthropic, { apiKey: process.env.ANTHROPIC_API_KEY! }, {
  store,
  signer,
  actor: { type: "service", id: "my-app" },
});

const res = await client.messages.create({
  model: "claude-sonnet-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
});
```

Then verify the chain offline:

```bash
npx receipta verify ./receipts.log.receipta --trust-root keys/
```

## How it works

No fork. The Anthropic SDK accepts a `fetch` constructor option invoked per HTTP attempt.
receipta injects a `fetch` that delegates to the real one, reads a `clone()` of the response
(the original stays unconsumed — your result is byte-identical), and appends a signed receipt.
Emission never throws into your call.

Provider specifics handled for you: the request id header is `request-id` (vs OpenAI's
`x-request-id`), and usage arrives natively as `input_tokens`/`output_tokens`. Streaming
responses are assembled before the output commitment is computed.

## What gets captured

- `model` and `usage` (`input_tokens`/`output_tokens`)
- `request_id` from the `request-id` header
- `outcome` (`success` for 2xx, `error` otherwise), one receipt per attempt
- request + response content when `captureMode: "full"`, with keyed HMAC-SHA256 commitments

## Docs

Full documentation: **https://nitishagar.github.io/receipta/adapters/anthropic**

## License

Apache-2.0
