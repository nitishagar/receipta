# receipta quickstart

A single-file, **no-network, no-API-key** example that walks the whole pipeline end-to-end:

1. Generates an Ed25519 signing key and publishes the trusted public key.
2. Opens a receipt store.
3. Makes a "provider call" through a receipt-emitting `fetch` wrapper — using a **stub fetch** that
   returns a canned OpenAI-shaped response, so it runs anywhere.
4. Verifies the resulting receipt chain offline.
5. Exports the receipts as DSSE envelopes signed with the generated key.

## Run it

From the repo root (after building the packages once):

```bash
pnpm build
node examples/quickstart/run.mjs
```

Expected output ends with `✓ quickstart complete.` and exit code `0`.

## What it shows

- **Tamper-evidence**: every decision is signed and hash-chained; the offline `verify` step is the
  acceptance test. (Try editing `examples/quickstart/.work/log.receipta` after a run and re-running
  `verify` — it will report the divergence precisely.)
- **Non-interference**: the stub call's response is returned unchanged to the caller; the receipt is
  emitted as a side effect.
- **Portable attestation**: the DSSE export is a standards-conformant envelope an auditor can verify
  independently of receipta, using only the published public key.

## Notes

- The example imports the built packages from `packages/*/dist`, so run `pnpm build` first.
- Its working files land in `.work/` (gitignored) and are recreated each run.
- For a real integration, use the provider adapters (`@receipta/openai`, `@receipta/anthropic`,
  `@receipta/vercel`) instead of the inline stub fetch shown here.
