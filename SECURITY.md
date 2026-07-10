# Security Policy

receipta is a tamper-evidence tool: its own integrity and the integrity of the receipts it
produces are its core value proposition. We take security reports seriously.

## Supported Versions

receipta is pre-1.0. Only the latest minor release line receives security fixes.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities privately via GitHub's advisory feature:

1. Go to https://github.com/nitishagar/receipta/security/advisories/new
2. Fill in the details (affected component, reproduction, impact).
3. Submit as a draft advisory.

Alternatively, email the maintainer at **1592163+nitishagar@users.noreply.github.com** with the
details (optionally PGP-encrypted; request a key if you need one).

### What to include

- A description of the issue and its security impact.
- The version of receipta affected.
- A minimal reproduction (code, receipt files, or a forged store are all welcome).
- For cryptographic claims (e.g. a way to forge a signature, break the hash chain, or tamper
  undetected), show the inputs and the expected vs. actual verify result.

## Response timeline

We aim to:

- Acknowledge receipt within **72 hours**.
- Provide an initial assessment within **7 days**.
- Coordinate a fix and disclosure window with you (default: 90 days, adjustable).

## Threat model (scope of "secure")

receipta v0.1's tamper-evidence defends against the threat class **T1**: an external party who
has access to the receipt store but **not** the signing key, attempting to alter stored records
undetected. It does **not** defend against:

- **T2** — the operator/record-keeper (who holds the signing key) re-signing a rewritten chain.
- **T3** — truncation of the chain tail (deleting recent records).
- **T4** — fork/split-view attacks (presenting different chains to different verifiers).

These require external anchoring (RFC 3161 timestamps, transparency-log inclusion proofs, or
witness co-signatures), which the receipt **format** supports (the `anchor` field and
`trust_level` enum) but v0.1 does not populate. See
[docs](https://nitishagar.github.io/receipta/guide/threat-model) for the full threat model.

A report that "the operator can forge receipts using their own signing key" is **expected
behavior**, not a vulnerability in v0.1 — it is the documented boundary of local-only signing.

## Sensitive data

Do not commit real API keys, provider credentials, or personal data embedded in test receipts.
The receipt store files (`*.receipta`, `.store/`) are gitignored. If you accidentally commit a
private key, treat the key as compromised: rotate it (generate a new key, retire the old
`keys/<key_id>.pub`), and open an issue so the published key bundle can be updated.
