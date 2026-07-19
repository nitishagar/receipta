# Contributing to receipta

Thanks for your interest in contributing to receipta! This project is small and focused, and
contributions are welcome — bug fixes, new provider adapters, tests, and docs improvements
especially.

## Developer Certificate of Origin (DCO)

receipta uses the **DCO** (Developer Certificate of Origin) instead of a CLA. Every commit must
be signed off, certifying that you wrote it / have the right to contribute it under the project's
license.

In practice, add `-s` (lowercase) to your commits:

```bash
git commit -s -m "fix(core): handle -0 in canonicalizer"
```

This adds a `Signed-off-by: Your Name <you@example.com>` trailer. (This is **not** GPG signing —
it is the `Signed-off-by` line, same as the Linux kernel uses.) The `probot/dco` app enforces
this on every pull request.

The full text of the DCO is at https://developercertificate.org/.

## Development setup

Prerequisites: **Node.js ≥ 20** and **pnpm** (the repo pins `pnpm@11.4.0` via corepack —
`corepack enable` then `corepack prepare pnpm@11.4.0 --activate`).

```bash
git clone https://github.com/nitishagar/receipta.git
cd receipta
pnpm install          # installs all workspaces with a frozen lockfile in CI
pnpm typecheck        # tsc -b across all packages
pnpm lint             # eslint
pnpm test             # vitest run
pnpm build            # build all packages
pnpm docs:dev         # local docs site (VitePress)
```

## Repository layout

```
packages/
  core/      # zero-runtime-dep foundation: schema, canon, crypto, store, chain, verify
  cli/       # the `receipta` binary
  openai/    # fetch wrapper for the `openai` SDK
  anthropic/ # fetch wrapper for the `@anthropic-ai/sdk`
  vercel/    # Telemetry integration for the `ai` SDK
```

`@receipta/core` is the trust foundation and intentionally has **zero runtime dependencies**
(Node `crypto` only). Do not add a runtime dependency to `core` without raising it in an issue
first — the zero-dep property is a deliberate guarantee (see `IMPLICIT_SPEC` S5.2).

## Conventions

- **Tests**: every public behavior and every spec edge case has a test. Run `pnpm test` before
  pushing. New behavior without a test will be requested to add one.
- **Canonicalization**: receipta signs canonical bytes (RFC 8785). If you touch `canon.ts`, the
  byte-exact RFC 8785 Appendix B vectors must still pass.
- **Non-interference**: provider adapters must never change the wrapped call's result. If you
  touch an adapter, the non-interference tests (wrapped result == unwrapped result) must pass.
- **Commits**: keep them focused. Sign off (`-s`). No co-author/ai-attribution trailers.

## Reporting issues / proposing features

Open a GitHub issue. For security-sensitive matters, see [SECURITY.md](./SECURITY.md) — do not
use a public issue.

## Releasing

Releases are tagged `v<version>` (e.g. `v0.3.0`) and cut from `main`. All `@receipta/*` packages
are versioned in lockstep with the repo tag. The [`Publish`](/.github/workflows/publish.yml)
workflow runs on every `v*` tag.

### Cutting a release

1. Update the version in every `packages/*/package.json` and the root `package.json`, add a dated
   `[<version>]` section to [`CHANGELOG.md`](./CHANGELOG.md), and commit.
2. Tag and push: `git tag v<version> && git push origin v<version>`.
3. The Publish workflow builds all packages and publishes to npm with `--provenance`
   (Sigstore/SLSA attestation). Confirm each `@receipta/*` package appears on npm with a
   "Provenance" badge.

### npm publishing authentication

The Publish workflow currently authenticates with a long-lived **`NPM_TOKEN`** secret (automation
token, scoped to the `@receipta` scope). npm `--provenance` is enabled and derives an attestation
from the GitHub Actions OIDC token, but the publish itself still uses the token.

**To migrate to npm trusted publishing** (recommended — removes the long-lived token):

1. For each published package (`@receipta/core`, `@receipta/cli`, `@receipta/openai`,
   `@receipta/anthropic`, `@receipta/vercel`), open its settings page on npmjs.com.
2. Under **Publishing access**, add a **trusted publisher** for the GitHub repository
   `nitishagar/receipta`, workflow filename `publish.yml`, and environment `npm`.
3. Once all packages are configured, update the Publish workflow to drop `NODE_AUTH_TOKEN` and use
   OIDC token exchange (`npm publish --provenance` with `id-token: write` resolves the token
   automatically when no `NODE_AUTH_TOKEN` is present and a trusted publisher is configured).
4. Rotate/remove the `NPM_TOKEN` secret from the repo and the npm access tokens page.

Until that migration is done, **rotate the `NPM_TOKEN`** periodically and whenever anyone with
access leaves the project.
