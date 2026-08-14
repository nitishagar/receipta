---
'@receipta/core': minor
'@receipta/cli': minor
'@receipta/vercel': minor
---

Retroactive changeset for the merged-but-unreleased v0.1 gap-closure features (PR #14), so the next
`changeset version` surfaces them in the release notes (previously documented only in a hand-written
changelog section):

- **DSSE + in-toto export** (`@receipta/cli`): `receipta export --format intoto` emits an in-toto
  Statement v1 per receipt (unsigned, pipeable into cosign/other signers); `--format dsse` emits a
  DSSE v1 envelope over each Statement, signed at export time with a user-supplied key (`--key`).
  The export path is read-only — the store and every receipt body are untouched.
- **Private-key persistence** (`@receipta/cli`, `@receipta/core`): `receipta key gen --out-private
<file>` writes the key pair in a stable on-disk JSON format (`{keyId, publicKey, privateKey}`,
  hex-encoded byte fields) with mode `0600` and atomic refuse-overwrite. Core exports the key-pair
  JSON helpers (`keyPairToJsonString`/`keyPairFromJsonString`).
- **Vercel adapter** (`@receipta/vercel`): removed the never-implemented `onEnd` member from
  `ReceiptaTelemetry` and the exported `GenerationEndEvent` type. The per-call
  `onLanguageModelCallEnd` hook is the canonical record; a second generation-end emission would risk
  a double receipt. Type-level breaking change shipped as minor; consumers referencing `onEnd` or
  `GenerationEndEvent` must drop them.
