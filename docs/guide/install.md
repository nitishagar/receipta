# Install

receipta is a pnpm-workspace monorepo. For local development:

```bash
git clone https://github.com/nitishagar/receipta.git
cd receipta
corepack enable
corepack prepare pnpm@11.4.0 --activate
pnpm install
```

Prerequisites:

- **Node.js ≥ 20** (Node 22 LTS recommended)
- **pnpm 11.4.0** (pinned via corepack)

Once installed, verify everything works:

```bash
pnpm test          # the full suite
pnpm verify:demo   # build a store, verify it, tamper it, watch verification fail
```

## Using receipta as a dependency

The packages are published to npm under the `@receipta` scope:

```bash
pnpm add @receipta/core @receipta/openai
# or: npm install @receipta/core @receipta/openai
```

| Package | Purpose |
| --- | --- |
| `@receipta/core` | Schema, canonicalization, crypto, store, verify (zero runtime deps) |
| `@receipta/openai` | Fetch wrapper for the `openai` SDK |
| `@receipta/anthropic` | Fetch wrapper for the `@anthropic-ai/sdk` |
| `@receipta/vercel` | Telemetry integration for the `ai` SDK |
| `@receipta/cli` | The `receipta` CLI (verify, export, key gen) |

The provider SDKs (`openai`, `@anthropic-ai/sdk`, `ai`) are **peer dependencies** — receipta uses your installed version and never forces an upgrade.
