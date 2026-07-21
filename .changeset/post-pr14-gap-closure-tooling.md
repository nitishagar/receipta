---
'@receipta/core': minor
'@receipta/openai': minor
'@receipta/anthropic': minor
'@receipta/cli': minor
'@receipta/vercel': minor
---

Introduced changeset-managed versioning (`@changesets/cli`, `.changeset/config.json`,
`pnpm changeset` / `pnpm run version`) and a CI markdown-lint gate (`markdownlint-cli2`).
Populated `attempt_index` on receipts best-effort from the Stainless `x-stainless-retry-count`
request header (OpenAI/Anthropic SDKs); omitted honestly when the header is absent.
