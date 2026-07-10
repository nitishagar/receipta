# Vercel AI SDK adapter

`@receipta/vercel` integrates with the [`ai`](https://www.npmjs.com/package/ai) SDK (v7, with a v6 shim) via the **Telemetry** integration. Unlike the fetch adapters, there's no HTTP to wrap — the SDK delivers the assembled result through a callback.

## How it works

The v7 `Telemetry` integration's `onLanguageModelCallEnd` callback fires with the **full assembled result** (independent of `recordInputs`/`recordOutputs` — verified firsthand). receipta builds a receipt from that assembled result:

- the output commitment is computed over the **final assembled output** (not intermediate chunks),
- `content_captured` reflects whether content was actually delivered (the metadata-only edge case),
- emission inside the callback is wrapped in try/catch — the callback runs inside the SDK's own dispatch, so an uncaught throw would surface to your `generateText`/`streamText` (which would violate non-interference).

## Usage (v7)

```ts
import { registerTelemetry } from "ai";
import { receiptaTelemetry } from "@receipta/vercel";
import { openStore, generateKeyPair } from "@receipta/core";

const store = await openStore("./receipts.log.receipta");
const signer = generateKeyPair();

registerTelemetry(receiptaTelemetry({
  store,
  signer,
  actor: { type: "agent", id: "my-agent" },
  captureMode: "full",
}));

// every generateText/streamText now emits a receipt via the callback
```

## v6

For AI SDK v6, use the shim:

```ts
import { registerTelemetryIntegration } from "ai";
import { receiptaTelemetryV6 } from "@receipta/vercel";

registerTelemetryIntegration(receiptaTelemetryV6({ store, signer, actor }));
```

The v7 names exist as deprecated aliases in v7, so a single code path works across both.

## The metadata-only edge case

If you disable `recordOutputs`, the callback still fires but content is absent. receipta sets `content_captured: false` honestly — the receipt is still valid (it signs over the metadata), but a verifier is never misled into thinking content was captured when it wasn't. This is the [S1.3](../schema/) invariant.
