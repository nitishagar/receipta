# @receipta/vercel

> Tamper-evident receipts for every Vercel AI SDK call.

`@receipta/vercel` integrates with the [`ai`](https://www.npmjs.com/package/ai) SDK (v7, with a
v6 shim) via its **Telemetry** integration, so every `generateText`/`streamText` emits an
**Ed25519-signed, hash-chained receipt** into an append-only local store — verifiable offline
with the [`receipta` CLI](https://www.npmjs.com/package/@receipta/cli). Part of
[receipta](https://github.com/nitishagar/receipta).

## Install

```bash
npm install @receipta/vercel @receipta/core ai
```

## Usage (AI SDK v7)

```ts
import { registerTelemetry } from "ai";
import { receiptaTelemetry } from "@receipta/vercel";
import { openStore, generateKeyPair } from "@receipta/core";

const store = await openStore("./receipts.log.receipta");
const signer = generateKeyPair(); // in practice, load from env/KMS

registerTelemetry(receiptaTelemetry({
  store,
  signer,
  actor: { type: "agent", id: "my-agent" },
  captureMode: "full",
}));

// every generateText/streamText now emits a receipt
```

### AI SDK v6

```ts
import { registerTelemetryIntegration } from "ai";
import { receiptaTelemetryV6 } from "@receipta/vercel";

registerTelemetryIntegration(receiptaTelemetryV6({ store, signer, actor }));
```

Then verify the chain offline:

```bash
npx receipta verify ./receipts.log.receipta --trust-root keys/
```

## How it works

Unlike the fetch adapters, there's no HTTP to wrap — the SDK's `onLanguageModelCallEnd` callback
delivers the **full assembled result** (streaming included), and receipta signs a receipt over
it. Emission is wrapped in try/catch, so it never surfaces into your `generateText`/`streamText`.
If a receipt can't be written before the process exits (fire-and-forget), call the integration's
`flush()` to await pending emissions.

If you disable `recordOutputs`, the callback still fires without content; receipta sets
`content_captured: false` honestly — the receipt stays valid, and a verifier is never misled
into thinking content was captured when it wasn't.

## Docs

Full documentation: **https://nitishagar.github.io/receipta/adapters/vercel**

## License

Apache-2.0
