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

The full text of the DCO is at <https://developercertificate.org/>.

## Development setup

Prerequisites: **Node.js ≥ 22.13** (the repo pins `pnpm@11.4.0`, which requires it) and **pnpm**
(`corepack enable` then `corepack prepare pnpm@11.4.0 --activate`).

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

```text
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

Version bumps and the per-package `CHANGELOG.md` files are **changeset-managed**
([changesets](https://github.com/changesets/changesets)) rather than hand-edited across files.
`@receipta/design-tokens` (`private: true`) is excluded from the managed set; the root package is
not published and its version is reconciled manually.

### Adding a changeset

For every consumer-visible change, add a changeset describing the affected package(s) and the bump
level (`patch`/`minor`/`major`):

```bash
pnpm changeset
```

This writes a file under `.changeset/` (ephemeral fragments, not prose). Commit the changeset with
its change. Multiple changesets may accumulate before a release.

### Cutting a release

1. Consume the pending changesets and bump versions + per-package `CHANGELOG.md` files:

   ```bash
   pnpm run version
   ```

   (`pnpm run version`, not bare `pnpm version` — the latter is shadowed by pnpm's built-in version
   command.) This rewrites each `packages/*/package.json` version, appends a dated section to that
   package's own `CHANGELOG.md` from the changeset entries, and removes the consumed changeset
   files. Internal dependents are bumped at the `patch` level (`updateInternalDependencies`).

2. Review the diff, then commit the version bump.
3. Tag and push: `git tag v<version> && git push origin v<version>`.
4. The Publish workflow builds all packages and publishes to npm with `--provenance`
   (Sigstore/SLSA attestation). Confirm each `@receipta/*` package appears on npm with a
   "Provenance" badge.
5. A successful `Publish` triggers the [`Smoke-publish`](/.github/workflows/smoke-publish.yml)
   workflow, which installs the just-tagged versions from npm in a clean directory and imports each
   `@receipta/*` package. A **green** `Publish` followed by a **red** `Smoke-publish` means the
   published artifacts are broken (e.g. a malformed `files`/`exports` whitelist shipped a package
   that installs but can't be imported) — the release should be patched or yanked. Check
   `gh run list --workflow=smoke-publish.yml` after a release.

> **Root `CHANGELOG.md`:** changesets maintains a per-package changelog under each
> `packages/*/CHANGELOG.md`. The root [`CHANGELOG.md`](./CHANGELOG.md) is the curated,
> human-written release narrative — update it manually when cutting a release that warrants a
> narrative entry. The two are complementary: per-package logs are machine-generated from
> changesets; the root log is the release story.

The tag-triggered `publish.yml` is unchanged by this flow — changesets manage versions and the
per-package changelogs; the Publish workflow still runs on the tag. The `changesets/action`
auto-PR-on-merge bot is intentionally **not** wired (that is a separate workflow-design decision);
the flow above is the minimal manual `changeset` → `version` → tag → publish path.

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
