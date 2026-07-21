# @receipta/cli

> `receipta` — verify tamper-evident AI decision receipts offline, export them for auditors, generate signing keys.

The command-line companion to [receipta](https://github.com/nitishagar/receipta): a receipt store
written by the [`@receipta/openai`](https://www.npmjs.com/package/@receipta/openai),
[`@receipta/anthropic`](https://www.npmjs.com/package/@receipta/anthropic), or
[`@receipta/vercel`](https://www.npmjs.com/package/@receipta/vercel) adapters (or
[`@receipta/core`](https://www.npmjs.com/package/@receipta/core) directly) can be verified and
exported by anyone with this CLI and the trusted public key — **no network, no vendor service**.

## Install

```bash
npm install -g @receipta/cli   # or: npx receipta ...
```

## Commands

### `receipta verify`

```bash
receipta verify ./receipts.log.receipta --trust-root keys/ [--format json|text]
```

Verifies the whole hash chain offline: every signature against the trust root, every hash link,
the append-only structure. Exit codes:

- `0` — the chain is fully valid.
- `1` — a divergence was found (tamper, torn tail, untrusted key). The report names the first
  divergence: which receipt (`seq`), which `field`, what `kind`, and why.
- `2` — the trust root could not be established. Fails loud rather than verifying against an
  untrusted key.

### `receipta export`

```bash
receipta export ./receipts.log.receipta --format json|csv|ocsf [--out <file>]
```

Exports receipts for auditors **without re-signing** (the store is never altered): raw JSON, a
flattened CSV, or OCSF v1.7 API Activity events (class uid 6003) — the shape SIEMs expect.

### `receipta key gen`

```bash
receipta key gen [--out keys/]
```

Generates an Ed25519 key pair, writes the public key to `<out>/<key_id>.pub`, and prints the key
fingerprint. The private key is held in memory only — store it securely (env/KMS) for signing,
and verify the fingerprint on a second channel.

## Try it

```bash
npx receipta key gen --out keys/
# ... emit receipts via an adapter ...
npx receipta verify ./receipts.log.receipta --trust-root keys/
```

## Docs

Full documentation: **<https://nitishagar.github.io/receipta/cli/>**

## License

Apache-2.0
