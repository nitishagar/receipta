# receipta

> Tamper-evident receipts for every AI decision.

`receipta` is an Apache-2.0 TypeScript SDK + CLI that wraps your LLM provider calls
(OpenAI, Anthropic, Vercel AI SDK) and emits **Ed25519-signed, hash-chained decision receipts**
into an append-only local store — verifiable offline, with no vendor service required.

## Why

Every LLM call is a decision: what was asked, what model answered, what it cost. Today those
decisions live in mutable observability dashboards or ephemeral logs. `receipta` makes each one
a cryptographically signed, tamper-evident record an auditor can verify independently — without
trusting the operator, the dashboard, or the network.

## Status

**v0.1 (MVP).** Single-process local store, Ed25519 signatures, full-chain offline verification,
JSON-native receipts (RFC 8785 canonical), DSSE/in-toto export. See the
[threat model](https://nitishagar.github.io/receipta/guide/threat-model) for what v0.1 defends
against (and honestly does not).

## Packages

| Package | What |
| --- | --- |
| [`@receipta/core`](./packages/core) | Zero-runtime-dep foundation: schema, canonicalization, crypto, store, chain, verify |
| [`@receipta/cli`](./packages/cli) | The `receipta` binary: `verify`, `export`, `key gen` |
| [`@receipta/openai`](./packages/openai) | `fetch` wrapper for the `openai` SDK |
| [`@receipta/anthropic`](./packages/anthropic) | `fetch` wrapper for the `@anthropic-ai/sdk` |
| [`@receipta/vercel`](./packages/vercel) | `Telemetry` integration for the `ai` SDK |

## Quick start

```bash
pnpm install
pnpm test          # unit + integration
pnpm verify:demo   # build a store, verify it, tamper, re-verify → watch it fail
```

## License

Apache-2.0. See [LICENSE](./LICENSE). Contributions require DCO sign-off (see
[CONTRIBUTING.md](./CONTRIBUTING.md)).
