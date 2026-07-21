# Changelog

All notable changes to receipta are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases are tagged
`v<version>`; each `@receipta/*` package is versioned in lockstep with the repo tag.

## [Unreleased]

### Added

- **DSSE + in-toto export** (`@receipta/cli`): `receipta export --format intoto` emits an in-toto
  Statement v1 per receipt (unsigned, pipeable into cosign/other signers); `--format dsse` emits a
  DSSE v1 envelope over each Statement, signed at export time with a user-supplied key
  (`--key <file>`). The export path is read-only — the store and every receipt body are untouched;
  the DSSE layer is a NEW envelope around the unmodified receipt.
- **Private-key persistence** (`@receipta/cli`): `receipta key gen --out-private <file>` writes the
  key pair in a stable on-disk JSON format (`{keyId, publicKey, privateKey}`, hex-encoded byte
  fields) with mode `0600` and atomic refuse-overwrite. A stern warning reminds the operator to
  protect the file. Default behavior (discard the private key) is unchanged.
- **Quality gates**: coverage now measures the provider adapters and enforces thresholds
  (90% stmts / 79% branches / 91% funcs / 91% lines); `pnpm format:check` enforces Prettier; CI
  runs across Node 20/22/24, includes coverage, format check, and `verify:demo` (the tamper-detection
  acceptance test).
- **Core test coverage**: dedicated `store.test.ts`, `trust.test.ts`, and `schema.test.ts` covering
  torn-tail classification at the frame level, lockfile contention, the filename==fingerprint
  anti-substitution rule, and `receiptBodyHash`/`canonicalForSigning` vectors.

### Changed

- **Vercel adapter**: removed the never-implemented `onEnd` member from `ReceiptaTelemetry` and the
  exported `GenerationEndEvent` type (its only use). The per-call `onLanguageModelCallEnd` hook is
  the canonical record; a second generation-end emission would risk a double receipt for a single
  call. **Type-level breaking change** — ship as minor; consumers referencing `onEnd` or
  `GenerationEndEvent` must drop them. The `flush()` pending-chain behavior is unchanged.
- Narrowed the coverage exclude so provider adapters' `index.ts` (real integration code) is measured;
  only `@receipta/core`'s barrel and the CLI entry (tested via subprocess) remain excluded.

## [0.2.0] - 2026-07-11

### Added

- OpenAI-compatible **gateway receipt fidelity**: per-attempt attribution for OpenAI-compatible
  gateways (Azure OpenAI, OpenRouter, etc.), including soft-fail (2xx body error) handling.

## [0.1.1] - 2026-07-11

### Added

- Per-package READMEs for `@receipta/{core,cli,openai,anthropic,vercel}`.

## [0.1.0] - 2026-07-11

### Added

- Initial release. `@receipta/core` (RFC 8785 canonicalization, Ed25519 signing, append-only store,
  hash-chained offline verification, zero runtime dependencies), `@receipta/cli`
  (`receipta key gen` / `verify` / `export json|csv|ocsf`), and provider adapters for the OpenAI,
  Anthropic, and Vercel AI SDKs.
- Tamper-evident receipt chains: signature forgery, deletion, reordering, and insertion are all
  detected and the first divergence is named precisely; torn tails classify as recoverable.

[Unreleased]: https://github.com/nitishagar/receipta/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/nitishagar/receipta/releases/tag/v0.2.0
[0.1.1]: https://github.com/nitishagar/receipta/releases/tag/v0.1.1
[0.1.0]: https://github.com/nitishagar/receipta/releases/tag/v0.1.0
