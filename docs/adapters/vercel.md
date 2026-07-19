# Vercel AI SDK adapter

`@receipta/vercel` integrates with the [`ai`](https://www.npmjs.com/package/ai) SDK (v7, with a v6 shim) via the **Telemetry** integration. Unlike the fetch adapters, there's no HTTP to wrap — the SDK delivers the assembled result through a callback.

## How it works

The v7 `Telemetry` integration's `onLanguageModelCallEnd` callback fires with the **full assembled result** (independent of `recordInputs`/`recordOutputs` — verified firsthand). receipta builds a receipt from that assembled result:

- the output commitment is computed over the **final assembled output** (not intermediate chunks),
- `content_captured` reflects whether content was actually delivered (the metadata-only edge case),
- emission inside the callback is wrapped in try/catch — the callback runs inside the SDK's own dispatch, so an uncaught throw would surface to your `generateText`/`streamText` (which would violate non-interference).

## Usage (v7)

```ts
import { registerTelemetry } from 'ai';
import { receiptaTelemetry } from '@receipta/vercel';
import { openStore, generateKeyPair } from '@receipta/core';

const store = await openStore('./receipts.log.receipta');
const signer = generateKeyPair();

const telemetry = receiptaTelemetry({
  store,
  signer,
  actor: { type: 'agent', id: 'my-agent' },
  captureMode: 'full',
});
registerTelemetry(telemetry);

// every generateText/streamText now emits a receipt via the callback.
await telemetry.flush(); // before close — see "Draining pending receipts" below.
await store.close();
```

## Draining pending receipts (`flush()`)

The SDK's telemetry callback contract is `(event) => void` — it does **not** await receipta's work.
So receipt emission is launched but not awaited: the `generateText`/`streamText` promise can resolve
before the receipt has landed durably in the store. Closing the store immediately after a generation
can therefore lose the final receipt(s).

`receiptaTelemetry()` returns an object with a `flush()` method that awaits the tail of the in-flight
emission chain. **Call it before `store.close()`** (or at the end of a request) to guarantee every
pending receipt has been appended:

```ts
await telemetry.flush();
await store.close();
```

`flush()` drains the snapshot of emissions pending **at call time**. Emissions that race in after
`flush()` returns are caller misuse — call `flush()` once your generation has fully completed and no
further emissions are expected.

## Emission errors never throw into your call

Receipt emission is wrapped so it never throws into your `generateText`/`streamText`: the callback
runs inside the SDK's own dispatch, and an uncaught throw there would surface to your call (violating
non-interference). A synchronous throw during receipt build (before a promise exists) is converted to
a rejection and logged to stderr by default (override with the `logError` config option); async
failures are likewise caught and logged. Failed emissions are skipped, not retried — inspect stderr
(`[receipta]` prefix) if receipts appear missing.

## v6

For AI SDK v6, use the shim:

```ts
import { registerTelemetryIntegration } from 'ai';
import { receiptaTelemetryV6 } from '@receipta/vercel';

registerTelemetryIntegration(receiptaTelemetryV6({ store, signer, actor }));
```

The v7 names exist as deprecated aliases in v7, so a single code path works across both.

## The metadata-only edge case

If you disable `recordOutputs`, the callback still fires but content is absent. receipta sets `content_captured: false` honestly — the receipt is still valid (it signs over the metadata), but a verifier is never misled into thinking content was captured when it wasn't. This is the [S1.3](../schema/) invariant.
