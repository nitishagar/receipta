# Pull Request

## Summary

<!-- What does this change do, and why? One or two sentences. -->

## Change type

- [ ] feat — new capability
- [ ] fix — bug fix
- [ ] refactor — no behavior change
- [ ] test — test-only
- [ ] docs — documentation only
- [ ] chore — build/CI/tooling
- [ ] breaking — changes a public API or CLI (requires a CHANGELOG note + minor/major bump)

## Checklist

- [ ] **Tests** — new behavior and any spec edge case it touches are covered (`pnpm test`).
- [ ] **Typecheck / lint / format** — `pnpm typecheck && pnpm lint && pnpm format:check` are green.
- [ ] **Coverage** — `pnpm coverage` is green (if it drops, the thresholds need re-measuring, not lowering without reason).
- [ ] **Canonicalization** — if `canon.ts` was touched, the RFC 8785 Appendix B vectors still pass.
- [ ] **Non-interference** — if an adapter was touched, the wrapped-result fidelity tests still pass.
- [ ] **Docs** — public API/CLI changes are reflected in docs and the CHANGELOG `[Unreleased]` section.
- [ ] **No new core dependency** — `@receipta/core` stays zero-runtime-dep (see CONTRIBUTING.md).
- [ ] **No private keys / secrets in the diff** (including in receipts or examples).

## DCO

Every commit must be signed off (`-s`), certifying origin under the Developer Certificate of
Origin (see [CONTRIBUTING.md](../CONTRIBUTING.md)). This PR will be blocked by the DCO check until
all commits carry a `Signed-off-by:` trailer. No co-author/AI-attribution trailers, please.

## Notes for reviewers

<!-- Anything reviewers should focus on, alternatives considered, or follow-ups. -->
