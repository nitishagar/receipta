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
receipta export <store> --format json|csv|ocsf|intoto|dsse [--out <file>] [--key <keyfile>]
```

Exports receipts in an auditor-consumable format **without re-signing** (the store is never altered;
every export is a read-only pass over the log).

- `json`: the raw receipt objects.
- `csv`: one row per receipt with flattened key fields.
- `ocsf`: OCSF v1.7 [API Activity](https://schema.ocsf.io/) events (class uid 6003) — the shape SIEMs and audit pipelines expect.
- `intoto`: an [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)
  per receipt (unsigned JSON). The receipt body is the attested artifact; `subject.digest.sha256` is
  the body hash, and the statement is pipeable into `cosign`/another signer.
- `dsse`: a [DSSE v1](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md) envelope
  around each in-toto Statement, **signed at export time** with a key you supply via `--key`. The
  signature is over the DSSE PAE of the raw statement bytes (not the base64 payload). The store and
  every receipt body stay untouched — the DSSE layer is a NEW envelope around the unmodified receipt.

`--format dsse` requires `--key <keyfile>` (a receipta key-pair JSON file produced by
`receipta key gen --out-private`). `--key` is rejected for the other formats. All formats emit a JSON
array (one entry per receipt).

### Verifying a DSSE export

A recipient verifies an envelope independently of receipta, using only the trusted public key:

1. Decode the base64 `payload` to recover the in-toto Statement bytes.
2. Compute the DSSE PAE: `"DSSEv1 " + len(payloadType) + " " + payloadType + " " + len(bytes) + " " + bytes`.
3. Verify the base64-decoded `sig` against the PAE under the public key whose id matches `signatures[0].keyid`.

## key gen

```bash
receipta key gen [--out <dir>] [--out-private <file>]
```

Generates an Ed25519 key pair, writes the public key to `<out>/<key_id>.pub` (default `<out>` is
`./keys`), and prints the key fingerprint. The fingerprint should be verified on a second channel
(this is the trust bootstrap).

By default **the private key is held in memory only and discarded** — store it securely (env/KMS) for
signing. Pass `--out-private <file>` to also persist the private key to disk in the receipta key-pair
JSON format (`{keyId, publicKey, privateKey}`, hex-encoded byte fields). The file is written with mode
`0600` and the write refuses to overwrite an existing file. **Protect this file** — anyone holding it
can sign receipts as this `key_id`. A persisted key file is what `receipta export --format dsse --key`
consumes.
