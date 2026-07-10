# CLI

The `receipta` CLI (`@receipta/cli`) verifies chains offline, exports receipts for auditors, and generates signing keys.

## verify

```bash
receipta verify <store> [--trust-root <dir>] [--format json|text]
```

Verifies a receipt chain **offline** (no network).

- Exit `0`: the chain is fully valid.
- Exit `1`: a divergence was found (tamper, torn tail, untrusted key). The report names the first divergence — which receipt (`seq`), which `field`, what `kind`, and why.
- Exit `2`: the trust root could not be established (missing directory, no keys, or a mislabeled key). Fails loud rather than verifying against an untrusted key.

`--trust-root` defaults to `./keys`. `--format json` emits a machine-readable report.

## export

```bash
receipta export <store> --format json|csv|ocsf [--out <file>]
```

Exports receipts in an auditor-consumable format **without re-signing** (the store is never altered).

- `json`: the raw receipt objects.
- `csv`: one row per receipt with flattened key fields.
- `ocsf`: OCSF v1.7 [API Activity](https://schema.ocsf.io/) events (class uid 6003) — the shape SIEMs and audit pipelines expect.

## key gen

```bash
receipta key gen [--out <dir>]
```

Generates an Ed25519 key pair, writes the public key to `<out>/<key_id>.pub` (default `<out>` is `./keys`), and prints the key fingerprint. **The private key is held in memory only** — store it securely (env/KMS) for signing. This command publishes the trusted public key; the fingerprint should be verified on a second channel.
