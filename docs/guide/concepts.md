# Concepts

## What is a receipt?

Every time your application makes an LLM call, that's a **decision**: a specific model was asked a specific question and gave a specific answer at a specific time. A **receipt** is a cryptographically signed record of that decision — who asked, what model answered, what the inputs and outputs were (or cryptographic commitments to them), when it happened, and how it turned out.

Receipts are **hash-chained**: each receipt binds to its predecessor (`prev_hash`), so any insertion, deletion, reordering, or mutation of a receipt is detectable.

## The chain

A **store** is a single append-only file holding one hash chain. Every receipt in the store chains to the previous one. The chain has:

- a `chain_id` (a random UUID, created when the store is opened),
- a `commitment_key` (random 32 bytes, used for HMAC content commitments),
- receipts numbered `seq` 1, 2, 3, … each carrying a `prev_hash` linking to its predecessor.

Verification walks the chain and checks, for each receipt: the sequence increments correctly, the `prev_hash` matches, the signature verifies under a trusted key, and the schema/suite are recognized.

## Deterministic bytes (RFC 8785)

A receipt is signed over its **canonical** bytes — the RFC 8785 (JSON Canonicalization Scheme) serialization. This is deliberate, because bare `JSON.stringify` is not canonical:

- `-0` serializes as `"0"` under `JSON.stringify`, but RFC 8785 requires `"-0"`.
- Object keys use insertion order under `JSON.stringify`, but RFC 8785 requires UTF-16 code-unit sort.

Without canonicalization, two independent serializations of the same receipt could produce different bytes, making verification implementation-dependent and fragile. receipta canonicalizes **both** at emit time (so the signed bytes are canonical) and at verify time (defense in depth).

## Content-optional

A receipt is valid whether or not it carries the actual prompt/completion content. Each receipt records `content_captured` — whether the bytes are present, or only cryptographic commitments (HMAC-SHA256 digests). This matters because:

- Some integrations (OTel, the Vercel AI SDK with `recordOutputs=false`) don't expose content by default.
- You may want to retain the tamper-evidence property without storing sensitive content.

When content is absent, the receipt still carries keyed HMAC commitments, so integrity is verifiable without storing the plaintext.

## Trust levels

Every timestamp declares its **trust level**:

- `local_asserted` — the operator's clock, no external evidence. **This is the only level v0.1 populates.**
- `rfc3161` — a Time Stamping Authority token (trust = the TSA's policy).
- `transparency_log` — inclusion in a Merkled transparency log.
- `witness` — co-signed by an independent witness.

The field exists so a receipt is never silently presented as more trustworthy than it is. v0.1 is honestly `local_asserted` only; the higher levels require anchoring (see the [Threat Model](./threat-model)).

## Offline verification

`receipta verify` needs **no network** — only the receipt file and the trusted public key. The trust bootstrap is the `keys/<key_id>.pub` file plus the key fingerprint published on a second channel (the README / this site). Verify the fingerprint before trusting a key bundle.
