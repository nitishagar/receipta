# Quickstart

This walks through wrapping an LLM call so it emits a signed receipt, then verifying the chain offline.

## 1. Generate a signing key

```bash
npx receipta key gen --out keys/
```

This writes `keys/<key_id>.pub` (the trusted public key) and prints the key's fingerprint. **Verify
the fingerprint on a second channel** (e.g. confirm it matches what's in the repo's README) — this is
the trust bootstrap. By default the private key is held in memory only and discarded; store it
securely (env/KMS) for signing.

If you want to sign DSSE exports later, persist the private key too:

```bash
npx receipta key gen --out keys/ --out-private signing-key.json
# signing-key.json is mode 0600 — PROTECT THIS FILE.
```

See the [CLI reference](../cli/) for the full `key gen` contract.

## 2. Wrap your OpenAI calls

```ts
import OpenAI from 'openai';
import { withReceipts } from '@receipta/openai';
import { openStore, generateKeyPair } from '@receipta/core';

// Open (or create) a receipt store — a single append-only file holding one hash chain.
const store = await openStore('./receipts.log.receipta');

// Load your signing key (here generated in-memory; in practice load from env/KMS).
const signer = generateKeyPair();

// Construct a wrapped client — use it exactly as you would `new OpenAI(...)`.
const client = withReceipts(
  OpenAI,
  { apiKey: process.env.OPENAI_API_KEY! },
  {
    store,
    signer,
    actor: { type: 'service', id: 'my-app', label: 'support-bot' },
  },
);

// Every chat completion now emits a signed, hash-chained receipt:
const res = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Summarize the quarterly report.' }],
});
console.log(res.choices[0]?.message?.content);
```

Each call appends one receipt per HTTP attempt (including retries) to `./receipts.log.receipta`. The response you receive is byte-identical to what you'd get without receipta — wrapping never changes the result.

## 3. Anthropic

```ts
import Anthropic from '@anthropic-ai/sdk';
import { withReceipts } from '@receipta/anthropic';

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

## 4. Vercel AI SDK

```ts
import { registerTelemetry } from 'ai';
import { receiptaTelemetry } from '@receipta/vercel';

registerTelemetry(receiptaTelemetry({ store, signer, actor: { type: 'agent', id: 'my-agent' } }));
// every generateText/streamText now emits a receipt via the telemetry callback
```

## 5. Verify the chain offline

```bash
npx receipta verify ./receipts.log.receipta --trust-root keys/
```

On a valid chain:

```text
✓ valid: 42 receipt(s) verified.
```

Exit code is `0` on success, non-zero on any divergence, and `2` if the trust root can't be established. Verification needs no network — only the receipt file and the trusted public key.

## 6. Export for auditors

```bash
# OCSF (for SIEMs), JSON, or CSV — no re-signing, store never altered:
npx receipta export ./receipts.log.receipta --format ocsf --out receipts.ocsf.json

# in-toto Statement v1 per receipt (unsigned, pipeable into cosign/another signer):
npx receipta export ./receipts.log.receipta --format intoto

# DSSE envelope over each Statement, signed at export time with your key:
npx receipta export ./receipts.log.receipta --format dsse --key signing-key.json
```

Exports to JSON, CSV, OCSF, in-toto, or DSSE **without re-signing** — the store is never altered. The
DSSE format signs a NEW envelope around each unmodified receipt with the key from `--key` (produced
by `receipta key gen --out-private`). See the [CLI reference](../cli/) for how a recipient verifies a
DSSE envelope.

## 7. Watch a forged receipt fail

```bash
pnpm verify:demo
```

Builds a demo store, verifies it (passes), tampers one receipt's content, and re-verifies — showing the precise divergence (which receipt, which field, why).
