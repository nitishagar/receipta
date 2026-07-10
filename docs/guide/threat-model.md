# Threat Model & Limitations

::: danger Read this before relying on receipta
receipta v0.1 defends against a **specific, narrow** threat: an external party who has access to your receipt store but **not** your signing key. It does **not** defend against several threats that matter for regulated recordkeeping. This page states honestly what v0.1 does and does not protect against.
:::

## The adversary classes

| Class | Description | Defended by v0.1? |
| --- | --- | --- |
| **T1** | External tamperer with store access, **no signing key** | ✅ **Yes** |
| **T2** | The operator/record-keeper themselves (holds the signing key, can rewrite + re-sign) | ❌ No — requires external anchoring |
| **T3** | Tail truncation (deletion of recent records) | ❌ No — requires anchoring |
| **T4** | Fork / split-view (presenting different chains to different verifiers) | ❌ No — requires a transparency log |

## What v0.1 defends (T1)

If an attacker gains access to your receipt store file but does **not** have your Ed25519 signing key, receipta detects any attempt to:

- **mutate** a receipt (the signature no longer verifies),
- **insert** a receipt (the sequence numbers break),
- **delete** a receipt (the `prev_hash` chain breaks),
- **reorder** receipts (the `prev_hash` linkage breaks).

Verification names the **first** divergence precisely (which receipt, which field, why). This is the core property — run `pnpm verify:demo` to watch a forged receipt get caught.

## What v0.1 does NOT defend (T2, T3, T4)

This is the honest boundary. A locally-signed hash chain **cannot**, by itself, defend against:

- **T2 — the operator re-signing a rewritten chain.** The operator holds the signing key, so they can delete the real chain, write a new one, and re-sign every receipt. The signatures would all verify. This is the threat regulators care most about (the SEC WORM rationale is explicitly about protecting records *from the firm keeping them*).
- **T3 — truncating the tail.** Deleting the most recent receipts leaves a valid (but incomplete) prefix chain. Chain verification alone cannot tell you records are missing.
- **T4 — fork/split-view.** An operator can present chain A to one verifier and chain B to another. Local verification of either passes.

### What would defend against T2/T3/T4?

External evidence, periodically anchored into the chain:

- **RFC 3161 timestamps** over checkpoint hashes (a TSA attests "this hash existed at time T" — re-signing after that can't backdate).
- **Transparency-log inclusion** (e.g. Sigstore Rekor v2) — a Merkled log whose consistency proofs make forks detectable and verification O(log n).
- **Witness co-signing** (the C2SP checkpoint + witness pattern) — independent parties co-sign checkpoints.

### The format supports this — v0.1 doesn't ship it

receipta's receipt schema **reserves** the fields needed for anchoring:

- an `anchor` field (for RFC 3161 tokens, transparency-log inclusion proofs, witness co-signatures),
- a graded `timestamp.trust_level` enum (`local_asserted` | `rfc3161` | `transparency_log` | `witness`),
- a `segment_link` record type (for chain continuity across file rotation over multi-year retention).

v0.1 leaves these unpopulated (`trust_level: local_asserted`). **Adding anchoring is a future release**, not a property of v0.1. The format not precluding it is a design requirement; shipping it is out of scope for the MVP.

## Tamper-evidence vs. legal mandate

receipta is marketed as **defensibility and auditor-trust**, not as "legally mandated by EU AI Act Article 12." The claim that Art. 12 *requires* cryptographic tamper-evidence is contested — the article requires logging, retention, and auditability, and how that's satisfied is a compliance determination for your own counsel. receipta is a tool that *can support* such determinations; it is not legal advice and not a compliance certification.

## Single-writer scope

v0.1 is a **single-writer** store. The append-only file is guarded by a lockfile; a second process that tries to open the same store fails loudly. Multi-process/multi-tenant fan-in is out of scope for v0.1 (documented honestly, not silently broken). If you need concurrent writers across processes, expect a future hosted/service tier — the format doesn't preclude it.
