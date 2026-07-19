# Receipt Schema

A receipta receipt is a JSON object: a `body` (the signed payload) and a detached `signature` (hex Ed25519 over the RFC 8785-canonical body).

```json
{
  "body": {
    "schema_version": "receipta.v0",
    "suite": "ed25519",
    "chain_id": "550e8400-e29b-41d4-a716-446655440000",
    "seq": 1,
    "prev_hash": "0000...0000",
    "key_id": "a3f5...c91e",
    "timestamp": { "iso8601_ms": "2026-07-10T08:06:00.123Z", "trust_level": "local_asserted" },
    "actor": { "type": "service", "id": "my-app", "label": "support-bot" },
    "provider": "openai",
    "model": "gpt-4o-2024-08-06",
    "request_id": "req_abc123",
    "attempt_index": 0,
    "outcome": "success",
    "content_captured": true,
    "capture_mode": "full",
    "content": { "request": {/* ... */}, "response": {/* ... */} },
    "content_commitments": {
      "request": "b9d0...f1a2",
      "response": "7c4e...88ab",
      "request_integrity": "e3b0...b855",
      "response_integrity": "9a2f...11cd"
    },
    "usage": { "input_tokens": 12, "output_tokens": 7 }
  },
  "signature": "f3a1...c2b9"
}
```

## Fields

| Field                   | Meaning                                                          | Invariant |
| ----------------------- | ---------------------------------------------------------------- | --------- |
| `schema_version`        | `"receipta.v0"` — gates verification                             | S1.8      |
| `suite`                 | `"ed25519"` — the signature suite (permits ML-DSA/FIPS later)    | S1.8      |
| `chain_id`              | UUID of the store/chain this receipt belongs to                  | S1.5      |
| `seq`                   | 1-based sequence within the chain                                | S1.5      |
| `prev_hash`             | hex SHA-256 of the previous receipt body (all-zero for seq 1)    | S1.5      |
| `key_id`                | hex SHA-256 of the signing public key                            | S3.1      |
| `timestamp.iso8601_ms`  | UTC millisecond ISO-8601 timestamp                               | S1.7      |
| `timestamp.trust_level` | `local_asserted` \| `rfc3161` \| `transparency_log` \| `witness` | S1.7      |
| `actor`                 | Who/what made the decision (distinct from the signing key)       | S3.2      |
| `provider`              | `"openai"` \| `"anthropic"` \| `"vercel-ai-sdk"` \| …            | —         |
| `model`                 | The model that answered                                          | —         |
| `request_id`            | The provider's request id (for correlation)                      | —         |
| `attempt_index`         | Which retry attempt (best-effort)                                | S2.2      |
| `outcome`               | `"success"` \| `"error"` \| `"retry"`                            | S2.2      |
| `content_captured`      | Whether prompt/completion bytes are present                      | S1.3      |
| `capture_mode`          | `"full"` \| `"metadata_only"`                                    | S1.3      |
| `content`               | Captured request/response (absent if metadata-only)              | S1.3      |
| `content_commitments`   | HMAC-SHA256 + integrity digests over content                     | S1.4      |
| `usage`                 | Token counts                                                     | —         |
| `anchor`                | _(reserved)_ external anchoring evidence                         | S1.6      |
| `extensions`            | Extension fields; `critical: true` unknowns fail verification    | S1.8      |

## Canonicalization

The signature is over the RFC 8785 canonicalization of `body` (the `signature` field itself is never signed). See [Concepts › Deterministic bytes](../guide/concepts#deterministic-bytes-rfc-8785).
