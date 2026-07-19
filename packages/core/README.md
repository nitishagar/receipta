# @receipta/core

> Tamper-evident receipts for AI decisions — the zero-runtime-dependency foundation.

`@receipta/core` is the trust core of [receipta](https://github.com/nitishagar/receipta): receipt
schema, RFC 8785 (JCS) canonicalization, Ed25519 signing, an append-only hash-chained store, full
offline chain verification, and the trust-root model. It has **zero runtime dependencies** — only
Node's built-in `crypto` and `fs`.

The provider adapters ([`@receipta/openai`](https://www.npmjs.com/package/@receipta/openai),
[`@receipta/anthropic`](https://www.npmjs.com/package/@receipta/anthropic),
[`@receipta/vercel`](https://www.npmjs.com/package/@receipta/vercel)) and the
[`@receipta/cli`](https://www.npmjs.com/package/@receipta/cli) are all built on this package. Use
it directly when you want to emit or verify receipts for a provider that has no adapter yet, or to
embed verification in your own tooling.

## Install

```bash
npm install @receipta/core
```

## Usage

```ts
import {
  generateKeyPair,
  exportPublicKey,
  sign,
  keyPairToSigner,
  openStore,
  appendBody,
  verifyChain,
  writeTrustedKey,
  loadTrustRoot,
  resolverFromTrustRoot,
} from '@receipta/core';

// 1. Generate a signing key and publish its public key to a trust root.
const kp = generateKeyPair();
await writeTrustedKey('./keys', kp.keyId, exportPublicKey(kp.publicKey));

// 2. Open an append-only store (one file, one hash chain) and append a signed receipt.
const store = await openStore('./receipts.log.receipta');
await appendBody(
  store,
  {
    timestamp: { iso8601_ms: new Date().toISOString(), trust_level: 'local_asserted' },
    actor: { type: 'service', id: 'my-app' },
    provider: 'openai',
    model: 'gpt-4o',
    request_id: 'req-123',
    attempt_index: 0,
    outcome: 'success',
    content_captured: true,
    capture_mode: 'full',
    content: { request: { prompt: '…' }, response: { text: '…' } },
    usage: { input_tokens: 5, output_tokens: 3 },
  },
  keyPairToSigner(kp),
);

// 3. Verify the whole chain offline — no network, only the file and the trusted public key.
const trust = await loadTrustRoot('./keys');
const report = await verifyChain('./receipts.log.receipta', resolverFromTrustRoot(trust));
```

## What's inside

| Module            | What                                                                               |
| ----------------- | ---------------------------------------------------------------------------------- |
| `canon`           | RFC 8785 (JCS) canonical JSON — the byte-stable form that gets signed              |
| `crypto`          | Ed25519 key generation, signing, verification, key fingerprints                    |
| `schema`          | The receipt schema (v0.1) and its types                                            |
| `store`           | Append-only single-file store, safe under concurrent appends                       |
| `chain`           | Hash chaining and full-chain verification with precise divergence reports          |
| `trust`           | Trust-root loading (`keys/<key_id>.pub`) — verification refuses to run without one |
| `adapter-support` | `createReceiptFetch` — the shared fetch-wrapper the provider adapters build on     |

## Guarantees (and honest limits)

Receipts are Ed25519-signed over their canonical form and hash-chained, so an external tamperer
without the signing key cannot alter, reorder, or truncate stored records undetected. v0.1's
threat model is **T1 (external tamper)** — it does not defend against a malicious operator who
holds the signing key. See the
[threat model](https://nitishagar.github.io/receipta/guide/threat-model) for the full picture.

## Docs

Full documentation: **https://nitishagar.github.io/receipta/** — including the
[quickstart](https://nitishagar.github.io/receipta/guide/quickstart),
[concepts](https://nitishagar.github.io/receipta/guide/concepts), and the
[schema reference](https://nitishagar.github.io/receipta/schema/).

## License

Apache-2.0
