---
'@receipta/cli': minor
'@receipta/vercel': patch
---

Receipt inspection and filtering for auditors, machine-readable key generation, and an ai-SDK
usage-field fix:

- **`receipta show <store> <seq>`** — print exactly one receipt (pretty JSON) by sequence number.
  Read-only; torn/malformed frames are skipped; exits 1 naming the seq when absent.
- **`receipta tail <store> [n]`** — print the last n receipts (default 10) as NDJSON, one JSON
  object per line, ready for `jq`/scripting.
- **Export filters** — `--from-seq/--to-seq/--since/--until/--actor/--provider` on `export` only:
  inclusive bounds that combine with AND; a filter matching nothing exports an empty set. `verify`
  is unchanged and always verifies the whole chain (filter flags on any other command exit 2).
- **`receipta key gen --format json`** — machine-readable summary
  (`{keyId, publicKey, publicKeyPath}` + `privateKeyPath` with `--out-private`); warnings move to
  stderr so stdout stays parseable. Private-key material is never printed to either stream.
- **Vercel adapter fix** — `usage` now maps BOTH ai-SDK spellings (`promptTokens`/`completionTokens`
  and v7's `inputTokens`/`outputTokens`); previously the v7 spelling silently dropped to undefined.
  Absence stays honest (no invented zeros).
