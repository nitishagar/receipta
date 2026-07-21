#!/usr/bin/env node
/**
 * receipta — the CLI.
 *
 * Subcommands:
 *   receipta key gen [--out keys/]            generate an Ed25519 key, write the pubkey, print fingerprint
 *   receipta verify <store> [--trust-root keys/] [--format json|text]
 *                                             verify a receipt chain offline; exit 0 on valid, non-zero otherwise
 *   receipta export <store> --format json|csv|ocsf|intoto|dsse [--out file] [--key keyfile]
 *                                             export receipts in an auditor-consumable format without re-signing
 *                                             (dsse signs a NEW envelope around each receipt with a user-supplied key)
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
  keyPairFromJsonString,
  keyPairToJsonString,
  receiptBodyHash,
  type Receipt,
  type KeyObject,
} from '@receipta/core';

const HELP = `receipta — tamper-evident receipts for AI decisions

Usage:
  receipta key gen [--out <dir>] [--out-private <file>]
                                              Generate an Ed25519 key pair; write the public key, print the fingerprint.
                                              With --out-private, also persist the private key (mode 0600; refuse overwrite).
  receipta verify <store> [--trust-root <dir>] [--format json|text]
                                              Verify a receipt chain offline. Exit 0 if valid, non-zero otherwise.
  receipta export <store> --format json|csv|ocsf|intoto|dsse [--out <file>] [--key <keyfile>]
                                              Export receipts (no re-signing).

verify needs no network. The trust root (keys/<key_id>.pub) must be supplied or defaults to ./keys.
key gen --out-private writes a receipta key-pair JSON file ({keyId, publicKey, privateKey}, byte
                                              fields hex-encoded, mode 0600). PROTECT THIS FILE — it can sign receipts.
export --format dsse requires --key <keyfile> (a receipta key-pair JSON file); the envelope signs a
                                              NEW DSSE layer around each receipt; the store is untouched.
`;

/** Supported `export --format` values. Keep in lockstep with the switch in `cmdExport`. */
const EXPORT_FORMATS = ['json', 'csv', 'ocsf', 'intoto', 'dsse'] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

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
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      out: { type: 'string' },
      'out-private': { type: 'string' },
      'trust-root': { type: 'string' },
      format: { type: 'string', default: 'text' },
      key: { type: 'string' },
    },
    allowPositionals: true,
    tokens: false,
  });
  return { command, values, positionals };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { command, values, positionals } = parse(argv);

  switch (command) {
    case 'key':
      return cmdKey(positionals, values);
    case 'verify':
      return cmdVerify(positionals, values);
    case 'export':
      return cmdExport(positionals, values);
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
  // needs assurance runs `verify` first; export just renders whatever is in the store.
  const receipts: Receipt[] = [];
  for await (const rec of readAll(storePath)) {
    if ('receipt' in rec) receipts.push(rec.receipt);
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
