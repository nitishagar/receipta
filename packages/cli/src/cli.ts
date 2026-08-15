#!/usr/bin/env node
/**
 * receipta — the CLI.
 *
 * Subcommands:
 *   receipta key gen [--out keys/]            generate an Ed25519 key, write the pubkey, print fingerprint
 *   receipta verify <store> [--trust-root keys/] [--format json|text]
 *                                             verify a receipt chain offline; exit 0 on valid, non-zero otherwise
 *   receipta export <store> --format json|csv|ocsf|intoto|dsse [--out file] [--key keyfile]
 *                                             [filters: --from-seq --to-seq --since --until --actor --provider]
 *                                             export receipts in an auditor-consumable format without re-signing
 *                                             (dsse signs a NEW envelope around each receipt with a user-supplied key)
 *   receipta show <store> <seq>               print one receipt (pretty JSON) by sequence number
 *   receipta tail <store> [n]                 print the last n receipts (default 10), one JSON object per line
 *
 * DESIGN (PLAN Phase 4, IMPLICIT_SPEC S4.1-S4.3): uses node:util parseArgs (zero added deps),
 * depends only on @receipta/core. verify needs no network. export does not alter the store.
 */
import { parseArgs } from 'node:util';
import { exit } from 'node:process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  generateKeyPair,
  exportPublicKey,
  writeTrustedKey,
  loadTrustRoot,
  resolverFromTrustRoot,
  verifyChain,
  readAll,
  sign,
  toHex,
  keyPairFromJsonString,
  keyPairToJsonString,
  receiptBodyHash,
  type Receipt,
  type KeyObject,
} from '@receipta/core';

const HELP = `receipta — tamper-evident receipts for AI decisions

Usage:
  receipta key gen [--out <dir>] [--out-private <file>] [--format text|json]
                                              Generate an Ed25519 key pair; write the public key, print the fingerprint.
                                              With --out-private, also persist the private key (mode 0600; refuse overwrite).
                                              With --format json, print a machine-readable summary (never the private key).
  receipta verify <store> [--trust-root <dir>] [--format json|text]
                                              Verify a receipt chain offline. Exit 0 if valid, non-zero otherwise.
  receipta export <store> --format json|csv|ocsf|intoto|dsse [--out <file>] [--key <keyfile>]
                                              [--from-seq <n>] [--to-seq <n>] [--since <iso>] [--until <iso>]
                                              [--actor <id>] [--provider <name>]
                                              Export receipts (no re-signing). Filters are inclusive, combine with AND,
                                              and only apply to export. --since/--until take UTC ISO-8601
                                              (e.g. 2026-08-14T20:00:00Z); a filter matching nothing exports an empty set.
  receipta show <store> <seq>
                                              Print one receipt (pretty JSON) by its sequence number. Exit 1 if absent.
  receipta tail <store> [n]
                                              Print the last n receipts (default 10), one JSON object per line.

verify needs no network. The trust root (keys/<key_id>.pub) must be supplied or defaults to ./keys.
key gen --out-private writes a receipta key-pair JSON file ({keyId, publicKey, privateKey}, byte
                                              fields hex-encoded, mode 0600). PROTECT THIS FILE — it can sign receipts.
export --format dsse requires --key <keyfile> (a receipta key-pair JSON file); the envelope signs a
                                              NEW DSSE layer around each receipt; the store is untouched.
show/tail and filtered export read the store without verifying — run verify first for assurance.
`;

/** Supported `export --format` values. Keep in lockstep with the switch in `cmdExport`. */
const EXPORT_FORMATS = ['json', 'csv', 'ocsf', 'intoto', 'dsse'] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Filter options: valid ONLY on `export` (single choke point in `main`). Inclusive bounds, AND-composed. */
const FILTER_OPTIONS = ['from-seq', 'to-seq', 'since', 'until', 'actor', 'provider'] as const;

/**
 * UTC ISO-8601 shape accepted by --since/--until. The fixed-width `Z` form is required (not +hh:mm)
 * because filtering compares `body.timestamp.iso8601_ms` lexicographically — safe only when every
 * string is the same UTC shape, which is also exactly what every emitter writes (`toISOString()`).
 */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Parsed, validated export filters (all optional). */
interface ExportFilters {
  fromSeq?: number;
  toSeq?: number;
  since?: string;
  until?: string;
  actor?: string;
  provider?: string;
}

/** Inclusive, AND-composed projection filter over a receipt body (export is a projection, not a lookup). */
function receiptPassesFilters(r: Receipt, f: ExportFilters): boolean {
  const b = r.body;
  if (f.fromSeq !== undefined && b.seq < f.fromSeq) return false;
  if (f.toSeq !== undefined && b.seq > f.toSeq) return false;
  if (f.since !== undefined && b.timestamp.iso8601_ms < f.since) return false;
  if (f.until !== undefined && b.timestamp.iso8601_ms > f.until) return false;
  if (f.actor !== undefined && b.actor.id !== f.actor) return false;
  if (f.provider !== undefined && b.provider !== f.provider) return false;
  return true;
}

/** Parse + validate filter values from the shared values map; exits 2 on any malformed value. */
function parseFilters(values: Record<string, unknown>): ExportFilters {
  const f: ExportFilters = {};
  const fromSeq = values['from-seq'] as string | undefined;
  const toSeq = values['to-seq'] as string | undefined;
  if (fromSeq !== undefined) {
    if (!/^\d+$/.test(fromSeq)) {
      process.stderr.write(
        `receipta export: --from-seq must be a non-negative integer (got "${fromSeq}").\n`,
      );
      exit(2);
    }
    f.fromSeq = Number(fromSeq);
  }
  if (toSeq !== undefined) {
    if (!/^\d+$/.test(toSeq)) {
      process.stderr.write(
        `receipta export: --to-seq must be a non-negative integer (got "${toSeq}").\n`,
      );
      exit(2);
    }
    f.toSeq = Number(toSeq);
  }
  const since = values.since as string | undefined;
  const until = values.until as string | undefined;
  if (since !== undefined) {
    if (!ISO_UTC_RE.test(since)) {
      process.stderr.write(
        `receipta export: --since must be UTC ISO-8601 with Z, e.g. 2026-08-14T20:00:00Z (got "${since}").\n`,
      );
      exit(2);
    }
    f.since = since;
  }
  if (until !== undefined) {
    if (!ISO_UTC_RE.test(until)) {
      process.stderr.write(
        `receipta export: --until must be UTC ISO-8601 with Z, e.g. 2026-08-14T20:00:00Z (got "${until}").\n`,
      );
      exit(2);
    }
    f.until = until;
  }
  const actor = values.actor as string | undefined;
  if (actor !== undefined) f.actor = actor; // exact match on body.actor.id
  const provider = values.provider as string | undefined;
  if (provider !== undefined) f.provider = provider; // exact match on body.provider
  return f;
}

interface ParsedArgs {
  command: string;
  values: Record<string, unknown>;
  positionals: string[];
}

function parse(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    process.stdout.write(HELP);
    exit(0);
  }
  const command = argv[0]!;
  const rest = argv.slice(1);
  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        out: { type: 'string' },
        'out-private': { type: 'string' },
        'trust-root': { type: 'string' },
        format: { type: 'string', default: 'text' },
        key: { type: 'string' },
        'from-seq': { type: 'string' },
        'to-seq': { type: 'string' },
        since: { type: 'string' },
        until: { type: 'string' },
        actor: { type: 'string' },
        provider: { type: 'string' },
      },
      allowPositionals: true,
      tokens: false,
    });
  } catch (e) {
    // parseArgs strict mode throws on anything option-shaped but unknown (e.g. `tail store -5`
    // parses `-5` as an unknown option). That is a usage error → exit 2, never a stack-trace exit 1.
    process.stderr.write(`receipta: invalid arguments: ${(e as Error).message}\n`);
    exit(2);
  }
  return { command, values: parsed.values, positionals: parsed.positionals };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { command, values, positionals } = parse(argv);

  // Single choke point (not per-command): filter flags are projection options for `export` only.
  // Rejecting them here means `verify --since=…` can never be read as "verify part of the chain".
  if (command !== 'export') {
    for (const opt of FILTER_OPTIONS) {
      if (values[opt] !== undefined) {
        process.stderr.write(
          `receipta: --${opt} is only valid with the export command (got it on "${command}").\n`,
        );
        exit(2);
      }
    }
  }

  switch (command) {
    case 'key':
      return cmdKey(positionals, values);
    case 'verify':
      return cmdVerify(positionals, values);
    case 'export':
      return cmdExport(positionals, values);
    case 'show':
      return cmdShow(positionals);
    case 'tail':
      return cmdTail(positionals);
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`unknown command "${command}".\n\n${HELP}`);
      exit(1);
  }
}

// ─── key gen ──────────────────────────────────────────────────────────────────

async function cmdKey(_positionals: string[], values: Record<string, unknown>): Promise<void> {
  const sub = _positionals[0];
  if (sub !== 'gen') {
    process.stderr.write(`receipta key: expected "gen", got "${sub ?? '(none)'}".\n`);
    exit(1);
  }
  const outDir = (values.out as string) ?? 'keys';
  const outPrivate = values['out-private'] as string | undefined;
  const format = (values.format as string) ?? 'text';
  if (format !== 'text' && format !== 'json') {
    process.stderr.write(`receipta key gen: --format must be text or json (got "${format}").\n`);
    exit(2);
  }
  const kp = generateKeyPair();

  // Failure ordering (PLAN Phase 2 Design Analysis): write the PRIVATE key file FIRST with mode 0600
  // and the `wx` flag (refuse overwrite atomically — no TOCTOU). Only on success do we publish the
  // public trust key. This guarantees: on private-write failure, nothing else is written; on
  // public-write failure, the error names the already-written private file so the user can clean up.
  if (outPrivate) {
    const parent = dirname(outPrivate);
    try {
      // Ensure the parent dir exists so a bare filename in CWD still works and a nested path is created.
      await mkdir(parent, { recursive: true });
    } catch (e) {
      process.stderr.write(
        `receipta key gen: cannot create directory "${parent}": ${(e as Error).message}\n`,
      );
      exit(2);
    }
    try {
      // `flag: "wx"` opens for writing only if the file does NOT exist (atomic refuse-overwrite).
      // `mode: 0o600` restricts to owner read/write — the private key must not be world-readable.
      await writeFile(outPrivate, keyPairToJsonString(kp), { mode: 0o600, flag: 'wx' });
    } catch (e) {
      const msg =
        (e as NodeJS.ErrnoException).code === 'EEXIST'
          ? `refusing to overwrite existing file "${outPrivate}" (private key not written)`
          : `cannot write private key to "${outPrivate}": ${(e as Error).message}`;
      process.stderr.write(`receipta key gen: ${msg}\n`);
      exit(2);
    }
    try {
      await writeTrustedKey(outDir, kp.keyId, exportPublicKey(kp.publicKey));
    } catch (e) {
      // The private key was already written; name it so the user can clean up.
      process.stderr.write(
        `receipta key gen: wrote private key to "${outPrivate}" but failed to publish the public ` +
          `trust key: ${(e as Error).message}\n` +
          `  (the private key file above already exists — remove it if you are re-running.)\n`,
      );
      exit(1);
    }
    if (format === 'json') {
      // Machine-readable mode: stdout carries ONLY the JSON summary (parseable); the stern warning
      // goes to stderr so it is still shown. The private key material itself is NEVER printed in
      // either stream — only the path where it was written.
      process.stderr.write(
        [
          `WARNING: the PRIVATE key was written to disk. PROTECT THIS FILE — anyone holding it can`,
          `  sign receipts as this key_id. Move it to a secret store / KMS for production use.`,
          ``,
        ].join('\n'),
      );
      process.stdout.write(
        JSON.stringify(
          {
            keyId: kp.keyId,
            publicKey: toHex(exportPublicKey(kp.publicKey)),
            publicKeyPath: `${outDir}/${kp.keyId}.pub`,
            privateKeyPath: outPrivate,
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }
    process.stdout.write(
      [
        `generated Ed25519 key pair.`,
        `  key_id:      ${kp.keyId}`,
        `  public key:  ${outDir}/${kp.keyId}.pub (32 raw bytes)`,
        `  private key: ${outPrivate} (mode 0600; receipta key-pair JSON)`,
        `  fingerprint: ${kp.keyId}  (sha256 of the public key; verify this on a second channel)`,
        ``,
        `  WARNING: the PRIVATE key was written to disk. PROTECT THIS FILE — anyone holding it can`,
        `  sign receipts as this key_id. Move it to a secret store / KMS for production use.`,
        ``,
      ].join('\n'),
    );
    return;
  }

  // Default path: publish the public trust key only; the private key stays in memory and is discarded.
  await writeTrustedKey(outDir, kp.keyId, exportPublicKey(kp.publicKey));
  if (format === 'json') {
    process.stderr.write(
      [
        `NOTE: the PRIVATE key was held in memory and NOT saved. To use it for signing,`,
        `  store it securely (env/KMS). This command only publishes the trusted public key.`,
        ``,
      ].join('\n'),
    );
    process.stdout.write(
      JSON.stringify(
        {
          keyId: kp.keyId,
          publicKey: toHex(exportPublicKey(kp.publicKey)),
          publicKeyPath: `${outDir}/${kp.keyId}.pub`,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  process.stdout.write(
    [
      `generated Ed25519 key pair.`,
      `  key_id:      ${kp.keyId}`,
      `  public key:  ${outDir}/${kp.keyId}.pub (32 raw bytes)`,
      `  fingerprint: ${kp.keyId}  (sha256 of the public key; verify this on a second channel)`,
      ``,
      `  NOTE: the PRIVATE key was held in memory and NOT saved. To use it for signing,`,
      `  store it securely (env/KMS). This command only publishes the trusted public key.`,
      ``,
    ].join('\n'),
  );
}

// ─── verify ───────────────────────────────────────────────────────────────────

async function cmdVerify(positionals: string[], values: Record<string, unknown>): Promise<void> {
  const storePath = positionals[0];
  if (!storePath) {
    process.stderr.write('receipta verify: missing <store> path.\n');
    exit(2);
  }
  const trustRootDir = (values['trust-root'] as string) ?? 'keys';
  const format = (values.format as string) ?? 'text';

  let resolver;
  try {
    const root = await loadTrustRoot(trustRootDir);
    resolver = resolverFromTrustRoot(root);
  } catch (e) {
    process.stderr.write(`receipta verify: cannot establish trust root: ${(e as Error).message}\n`);
    exit(2); // S4.2: fail loud, distinct exit code for trust failure
  }

  const report = await verifyChain(storePath, resolver);

  if (format === 'json') {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    if (report.ok) {
      process.stdout.write(`✓ valid: ${report.verifiedCount} receipt(s) verified.\n`);
    } else if (report.firstDivergence) {
      const d = report.firstDivergence;
      process.stdout.write(
        [
          `✗ divergence at receipt seq=${d.receiptSeq} (field="${d.field}", kind=${d.kind}).`,
          `  ${d.reason}`,
          `  ${report.verifiedCount} receipt(s) verified before the divergence.`,
          d.kind === 'recoverable-incomplete'
            ? `  (the final record is torn — the rest of the chain still verified.)`
            : ``,
          ``,
        ].join('\n'),
      );
    } else {
      // ok:false with no divergence and no receipts: the store is empty or missing. This is
      // distinct from a tamper/torn-tail divergence, so we say so explicitly rather than exiting
      // non-zero with no output (which leaves the user guessing).
      process.stdout.write(
        `✗ no verifiable receipts found in ${storePath} (empty or missing store).\n`,
      );
    }
  }

  exit(report.ok ? 0 : 1);
}

// ─── export ───────────────────────────────────────────────────────────────────

async function cmdExport(positionals: string[], values: Record<string, unknown>): Promise<void> {
  const storePath = positionals[0];
  if (!storePath) {
    process.stderr.write('receipta export: missing <store> path.\n');
    exit(2);
  }
  const rawFormat = values.format as string;
  if (!rawFormat || !EXPORT_FORMATS.includes(rawFormat as ExportFormat)) {
    process.stderr.write('receipta export: --format must be one of json|csv|ocsf|intoto|dsse.\n');
    exit(2);
  }
  const format: ExportFormat = rawFormat as ExportFormat;
  // `--key` is required for dsse (signs the envelope), rejected for the other formats.
  const keyFile = values.key as string | undefined;
  if (format === 'dsse' && !keyFile) {
    process.stderr.write('receipta export: --format dsse requires --key <keyfile>.\n');
    exit(2);
  }
  if (format !== 'dsse' && keyFile) {
    process.stderr.write(
      `receipta export: --key is only valid with --format dsse (got "${format}").\n`,
    );
    exit(2);
  }

  // Read receipts WITHOUT verifying (export is read-only, never re-signs — S4.3). A verifier who
  // needs assurance runs `verify` first; export just renders whatever is in the store. Filters are
  // inclusive projections over the parsed receipts — a filter matching nothing exports an empty set.
  const filters = parseFilters(values);
  const receipts: Receipt[] = [];
  for await (const rec of readAll(storePath)) {
    if ('receipt' in rec && receiptPassesFilters(rec.receipt, filters)) receipts.push(rec.receipt);
  }

  let output: string;
  switch (format) {
    case 'json':
      output = JSON.stringify(receipts, null, 2);
      break;
    case 'csv':
      output = toCsv(receipts);
      break;
    case 'ocsf':
      output = JSON.stringify(receipts.map(toOcsf), null, 2);
      break;
    case 'intoto':
      output = JSON.stringify(receipts.map(toInTotoStatement), null, 2);
      break;
    case 'dsse': {
      const key = await loadExportKey(keyFile!);
      output = JSON.stringify(
        receipts.map((r) => toDsseEnvelope(toInTotoStatement(r), key)),
        null,
        2,
      );
      break;
    }
    default: {
      // Exhaustiveness guard (WI-5): if a new format is added to the enum above but not here, this
      // line becomes reachable and fails loudly rather than silently emitting empty output.
      const _exhaustive: never = format;
      throw new Error(`receipta export: unhandled format "${_exhaustive}"`);
    }
  }

  const outFile = values.out as string | undefined;
  if (outFile) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(outFile, output + '\n', 'utf8');
    process.stdout.write(`exported ${receipts.length} receipt(s) to ${outFile} (${format}).\n`);
  } else {
    process.stdout.write(output + '\n');
  }
}

// ─── show / tail ──────────────────────────────────────────────────────────────

/**
 * `receipta show <store> <seq>` — print exactly one receipt (pretty JSON) by its sequence number.
 * Read-only: iterates `readAll` without acquiring the write lock and without creating anything.
 * Torn/malformed frames yield `{error}` records and are skipped (the receipt behind a torn tail is
 * not parseable, so it cannot be shown). A seq that is absent (or hidden behind a torn frame, or
 * the store is missing/empty) exits 1 naming the requested seq.
 */
async function cmdShow(positionals: string[]): Promise<void> {
  const storePath = positionals[0];
  if (!storePath) {
    process.stderr.write('receipta show: missing <store> path.\n');
    exit(2);
  }
  const seqArg = positionals[1];
  if (seqArg === undefined || !/^\d+$/.test(seqArg)) {
    process.stderr.write(
      `receipta show: expected a non-negative integer <seq> positional (got "${seqArg ?? '(none)'}").\n`,
    );
    exit(2);
  }
  const seq = Number(seqArg);
  for await (const rec of readAll(storePath)) {
    if ('receipt' in rec && rec.receipt.body.seq === seq) {
      process.stdout.write(JSON.stringify(rec.receipt, null, 2) + '\n');
      return;
    }
  }
  process.stderr.write(
    `receipta show: no receipt with seq=${seq} in "${storePath}" ` +
      `(the store may be missing/empty, have fewer receipts, or the record is torn).\n`,
  );
  exit(1);
}

/**
 * `receipta tail <store> [n]` — print the last n receipts (default 10) as NDJSON, one JSON object
 * per line. Read-only, same skip-error-frames rule as export. n is parsed from the POSITIONAL STRING
 * (never a negative number: parseArgs strict mode treats `-5` as an unknown option and `parse`
 * exits 2). n=0 prints nothing, exit 0; a missing/empty store prints nothing, exit 0 (matches
 * export's empty-set semantics).
 */
async function cmdTail(positionals: string[]): Promise<void> {
  const storePath = positionals[0];
  if (!storePath) {
    process.stderr.write('receipta tail: missing <store> path.\n');
    exit(2);
  }
  const nArg = positionals[1] ?? '10';
  if (!/^\d+$/.test(nArg)) {
    process.stderr.write(
      `receipta tail: optional count must be a non-negative integer (got "${nArg}").\n`,
    );
    exit(2);
  }
  const n = Number(nArg);
  const receipts: Receipt[] = [];
  for await (const rec of readAll(storePath)) {
    if ('receipt' in rec) receipts.push(rec.receipt);
  }
  // slice(-n) would return ALL records for n=0 (-0 === 0); compute the start explicitly instead.
  const start = Math.max(0, receipts.length - n);
  for (const r of receipts.slice(start)) {
    process.stdout.write(JSON.stringify(r) + '\n');
  }
}

/**
 * Load a receipta key-pair JSON file for DSSE envelope signing. Throws (→ unexpected-error exit 1)
 * if the file is unreadable or malformed; the store is never opened for write, so a load failure
 * cannot corrupt it. Exits 2 with a clear message to match the other user-facing arg errors.
 */
async function loadExportKey(keyFile: string): Promise<{ privateKey: KeyObject; keyId: string }> {
  // `keyId` IS computeKeyId(pub) (hex sha256 of the pubkey) — see core's generateKeyPair. We carry
  // it out so the DSSE keyid hint is the same identifier receipts use, with no recomputation here.
  let text: string;
  try {
    text = await readFile(keyFile, 'utf8');
  } catch (e) {
    process.stderr.write(
      `receipta export: cannot read key file "${keyFile}": ${(e as Error).message}\n`,
    );
    exit(2);
  }
  try {
    const kp = keyPairFromJsonString(text);
    if (!kp.privateKey) {
      process.stderr.write(
        `receipta export: key file "${keyFile}" has no private key (public-only bundle).\n`,
      );
      exit(2);
    }
    return { privateKey: kp.privateKey, keyId: kp.keyId };
  } catch (e) {
    process.stderr.write(
      `receipta export: malformed key file "${keyFile}": ${(e as Error).message}\n`,
    );
    exit(2);
  }
}

/**
 * in-toto Statement v1 (https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md) for a
 * single receipt. The receipt body is the attested artifact; `subject.digest.sha256` is
 * `receiptBodyHash(body)` (independently recomputable from the predicate), and `name` is
 * `<chain_id>/<seq>`. `predicateType` is a receipta-specific extension URI.
 */
function toInTotoStatement(r: Receipt): {
  _type: string;
  subject: { name: string; digest: Record<string, string> }[];
  predicateType: string;
  predicate: Receipt;
} {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: `${r.body.chain_id}/${r.body.seq}`,
        digest: { sha256: receiptBodyHash(r.body) },
      },
    ],
    predicateType: 'https://receipta.dev/receipt/v0',
    predicate: r,
  };
}

/**
 * DSSE v1 envelope (https://github.com/secure-systems-lab/dsse/blob/master/protocol.md) over an
 * in-toto Statement. The signature is over PAE(payloadType, serializedBody) where `serializedBody`
 * is the RAW UTF-8 bytes of `JSON.stringify(statement)` — NEVER the base64 string. `payload` carries
 * the base64 form for transport. One envelope per receipt. The `keyid` is the key's stable identifier
 * (hex sha256 of the public key — the same id receipts carry).
 */
function toDsseEnvelope(
  statement: ReturnType<typeof toInTotoStatement>,
  key: { privateKey: KeyObject; keyId: string },
): { payloadType: string; payload: string; signatures: { keyid: string; sig: string }[] } {
  const payloadType = 'application/vnd.in-toto+json';
  const serializedBody = Buffer.from(JSON.stringify(statement), 'utf8');
  const pae = paeEncode(payloadType, serializedBody);
  const sig = sign(pae, key.privateKey);
  return {
    payloadType,
    payload: serializedBody.toString('base64'),
    signatures: [{ keyid: key.keyId, sig: Buffer.from(sig).toString('base64') }],
  };
}

/**
 * DSSE PreAuthEncoding (PAE): `"DSSEv1 " + len(type) + " " + type + " " + len(body) + " " + body`,
 * where the lengths are ASCII decimal and `type`/`body` are the raw bytes (not base64).
 */
function paeEncode(payloadType: string, body: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(payloadType, 'utf8');
  const parts: Buffer[] = [
    Buffer.from('DSSEv1 ', 'utf8'),
    Buffer.from(String(typeBytes.length), 'utf8'),
    Buffer.from(' ', 'utf8'),
    typeBytes,
    Buffer.from(' ', 'utf8'),
    Buffer.from(String(body.length), 'utf8'),
    Buffer.from(' ', 'utf8'),
    Buffer.from(body),
  ];
  return Buffer.concat(parts);
}

/** Flatten a receipt to CSV (one row per receipt, key fields). */
function toCsv(receipts: Receipt[]): string {
  const cols = [
    'seq',
    'chain_id',
    'timestamp',
    'provider',
    'model',
    'actor_id',
    'request_id',
    'outcome',
    'content_captured',
    'input_tokens',
    'output_tokens',
    'key_id',
  ];
  const rows = receipts.map((r) =>
    [
      r.body.seq,
      r.body.chain_id,
      r.body.timestamp.iso8601_ms,
      r.body.provider,
      r.body.model,
      r.body.actor.id,
      r.body.request_id ?? '',
      r.body.outcome,
      r.body.content_captured,
      r.body.usage?.input_tokens ?? '',
      r.body.usage?.output_tokens ?? '',
      r.body.key_id,
    ]
      .map(csvEscape)
      .join(','),
  );
  return [cols.join(','), ...rows].join('\n');
}

function csvEscape(v: unknown): string {
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Map a receipt to an OCSF v1.7 API Activity event (class uid 6003) — the LangSmith precedent
 * (research [R:61]). OCSF has no AI-specific class; API Activity is the closest auditor-consumable
 * shape. This is a lossy projection for SIEM ingestion, not a re-signing.
 */
function toOcsf(r: Receipt): Record<string, unknown> {
  return {
    class_uid: 6003,
    category_uid: 6,
    category_name: 'Application Activity',
    class_name: 'API Activity',
    type_uid: 600301,
    type_name: 'API Call',
    activity_id: 1,
    time: r.body.timestamp.iso8601_ms,
    status: r.body.outcome === 'success' ? 'Success' : 'Failure',
    severity: r.body.outcome === 'error' ? 2 : 1,
    actor: {
      uid: r.body.actor.id,
      type: r.body.actor.type,
      name: r.body.actor.label ?? r.body.actor.id,
    },
    api: {
      operation: 'llm_completion',
      service: { name: r.body.provider },
      request: { uid: r.body.request_id ?? '' },
    },
    resource: { uid: r.body.chain_id, type: 'receipta_chain' },
    metadata: {
      product: { name: 'receipta', version: '0.1' },
      sequence: r.body.seq,
      prev_hash: r.body.prev_hash,
      key_id: r.body.key_id,
      receipt_schema: r.body.schema_version,
      signature_suite: r.body.suite,
      content_captured: r.body.content_captured,
    },
    durations: r.body.usage
      ? { input_tokens: r.body.usage.input_tokens, output_tokens: r.body.usage.output_tokens }
      : undefined,
    model: r.body.model,
  };
}

main().catch((e) => {
  process.stderr.write(`receipta: unexpected error: ${e instanceof Error ? e.stack : String(e)}\n`);
  exit(1);
});
