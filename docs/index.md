---
layout: home

hero:
  name: receipta
  text: Tamper-evident receipts for every AI decision
  tagline: Ed25519-signed, hash-chained, offline-verifiable. Wrap your LLM calls and every decision becomes a cryptographically attested record.
  actions:
    - theme: brand
      text: Quickstart
      link: /guide/quickstart
    - theme: alt
      text: GitHub
      link: https://github.com/nitishagar/receipta

features:
  - title: Offline verification
    details: Verify a receipt chain with no network and no vendor service. Only the receipt files and a trusted public key are needed.
  - title: Cross-vendor
    details: One consistent receipt format across OpenAI, Anthropic, and the Vercel AI SDK. No fork — a fetch hook and a telemetry integration.
  - title: Open schema
    details: A published, versioned JSON receipt schema (RFC 8785 canonical). Map to DSSE/in-toto or OCSF for auditors.
  - title: Zero-dependency core
    details: The trust foundation (@receipta/core) has zero runtime dependencies — Node crypto only. No supply chain in the load-bearing code.
  - title: Provenance-attested
    details: npm publishes carry Sigstore provenance attestations. Reproducible builds via a pinned lockfile and corepack.
  - title: Apache-2.0
    details: Permissively licensed. DCO (not CLA) for contributions.
---
