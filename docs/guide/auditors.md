# For Auditors

You are the third party: an auditor, reviewer, or compliance engineer who receives receipts produced
by someone else's system and wants to check them **without trusting the operator**. This page is the
verification walkthrough. Nothing here requires the operator's cooperation beyond handing over two
artifacts, and no step phones home — verification is fully offline.

## What you need

| Artifact       | What it is                                                         | How you get it                     |
| -------------- | ------------------------------------------------------------------ | ---------------------------------- |
| the store      | an append-only receipt log (one file, plus a `.meta.json` sidecar) | copied out-of-band by the operator |
| the trust root | a directory of `keys/<key_id>.pub` public-key files                | published by the operator          |

The critical property: verification never consults the operator's servers, dashboards, or exported
reports — it reads the raw store and checks cryptography. If you are only shown a CSV or dashboard,
you are not verifying; ask for the store file.

## Step 1 — Check the trust root (second channel)

Each `.pub` file's **name is its own fingerprint**: `keys/<key_id>.pub` where `key_id` is the hex
sha256 of the file's bytes. Two consequences:

- `receipta verify` refuses a mislabeled key (a key whose filename does not match its contents) —
  substitution of a different key under a known name fails loud.
- You should still compare the `key_id` you were given against a **second channel** with the
  operator (a signed email, a meeting, a published fingerprint). This is the trust bootstrap: the
  chain proves receipts were not altered after signing; the fingerprint comparison proves the
  signature key is the one you intended.

```bash
receipta verify <store> --trust-root <dir>
```

Exit codes:

- `0` — the chain is fully valid: every receipt's signature verifies under the trusted key, the hash
  chain links receipt-to-receipt, and the schema/suite are as expected.
- `1` — a divergence was found. The report names the **first** divergence: which receipt (`seq`),
  which field, what kind (`tamper`, `recoverable-incomplete`, `untrusted-key`), and why.
- `2` — the trust root itself is unusable (missing directory, no keys, mislabeled key). Fail-loud by
  design.

`recoverable-incomplete` means the final record is torn (a crash mid-append) — the chain up to that
point still verified. Anything else — a mutated field, a deleted middle receipt, a reordered or
inserted receipt — reports as `tamper` at the exact first receipt where it is detectable.

For scripting, `--format json` emits the same report as a machine-readable object
(`{ ok, verifiedCount, firstDivergence, receipts }`).

## Step 2 — Inspect receipts yourself

Do not accept a hand-picked export as evidence; read the store directly:

```bash
receipta show <store> 7        # one receipt (pretty JSON) by sequence number
receipta tail <store> 20       # the last 20 receipts, one JSON object per line
```

`show` exits `1` naming the seq if that receipt is absent (including when it is hidden behind a
torn tail). Both commands are read-only: they never take the store's writer lock and never modify
the log.

To pull a slice for your own tooling, use export with filters (all inclusive, combined with AND):

```bash
receipta export <store> --format csv \
  --since 2026-08-01T00:00:00Z --until 2026-08-31T23:59:59Z \
  --actor my-agent --provider openai --from-seq 100 --to-seq 200
```

Filters only apply to `export`; `verify` always verifies the **whole** chain — a passing run can
never have been narrowed to a friendly subset. `--since`/`--until` take UTC ISO-8601 (`...Z`).

For signed evidence you can forward, export [in-toto Statements or DSSE
envelopes](../cli/) — the DSSE layer is a new signature around each unmodified receipt, and
[the three-step recipient recipe](../cli/#verifying-a-dsse-export) lets you check an envelope
without receipta at all.

## Step 3 — Run verification in CI

Receipt verification is a single offline command with a meaningful exit code, so it drops straight
into a pipeline gate. Example (GitHub Actions):

```yaml
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - name: Verify receipt chain
        run: |
          npx --yes @receipta/cli@0.3.0 verify artifacts/log.receipta --trust-root keys
```

Pin an exact CLI version in CI (as above) so a registry change can never alter your audit semantics.
Bring the store and trust root in as pinned artifacts (or from your own archival storage) rather
than re-downloading them from the system under audit. The step fails the job on any divergence
(exit ≠ 0).

## What verification does and does not prove

`verify` proves: the receipts you hold form an unbroken, Ed25519-signed hash chain under the key you
trusted, with no post-signing mutation detectable from the store itself.

It does **not** prove the operator couldn't re-sign an entire alternative history with the same key,
truncate the tail and re-issue, or simply not record a call — those are the known open threats that
require external anchoring (timestamping, transparency logs, witnesses), discussed honestly in the
[threat model](./threat-model). receipta is a tool for defensibility and auditor
trust; whether it satisfies a specific legal or regulatory logging obligation is a determination for
your own counsel.
