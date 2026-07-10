#!/usr/bin/env node
/**
 * receipta — the CLI.
 *
 * Subcommands:
 *   receipta key gen [--out keys/]            generate an Ed25519 key, write the pubkey, print fingerprint
 *   receipta verify <store> [--trust-root keys/] [--format json|text]
 *                                             verify a receipt chain offline; exit 0 on valid, non-zero otherwise
 *   receipta export <store> --format json|csv|ocsf [--out file]
 *                                             export receipts in an auditor-consumable format without re-signing
 *
 * DESIGN (PLAN Phase 4, IMPLICIT_SPEC S4.1-S4.3): uses node:util parseArgs (zero added deps),
 * depends only on @receipta/core. verify needs no network. export does not alter the store.
 */
import { parseArgs } from "node:util";
import { exit } from "node:process";
import {
  generateKeyPair,
  exportPublicKey,
  writeTrustedKey,
  loadTrustRoot,
  resolverFromTrustRoot,
  verifyChain,
  readAll,
  type Receipt,
} from "@receipta/core";

const HELP = `receipta — tamper-evident receipts for AI decisions

Usage:
  receipta key gen [--out <dir>]              Generate an Ed25519 key pair; write the public key, print the fingerprint.
  receipta verify <store> [--trust-root <dir>] [--format json|text]
                                              Verify a receipt chain offline. Exit 0 if valid, non-zero otherwise.
  receipta export <store> --format json|csv|ocsf [--out <file>]
                                              Export receipts (no re-signing).

verify needs no network. The trust root (keys/<key_id>.pub) must be supplied or defaults to ./keys.
`;

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
      out: { type: "string" },
      "trust-root": { type: "string" },
      format: { type: "string", default: "text" },
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
    case "key":
      return cmdKey(positionals, values);
    case "verify":
      return cmdVerify(positionals, values);
    case "export":
      return cmdExport(positionals, values);
    case "help":
    case "--help":
    case "-h":
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
  if (sub !== "gen") {
    process.stderr.write(`receipta key: expected "gen", got "${sub ?? "(none)"}".\n`);
    exit(1);
  }
  const outDir = (values.out as string) ?? "keys";
  const kp = generateKeyPair();
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
    ].join("\n"),
  );
}

// ─── verify ───────────────────────────────────────────────────────────────────

async function cmdVerify(positionals: string[], values: Record<string, unknown>): Promise<void> {
  const storePath = positionals[0];
  if (!storePath) {
    process.stderr.write("receipta verify: missing <store> path.\n");
    exit(2);
  }
  const trustRootDir = (values["trust-root"] as string) ?? "keys";
  const format = (values.format as string) ?? "text";

  let resolver;
  try {
    const root = await loadTrustRoot(trustRootDir);
    resolver = resolverFromTrustRoot(root);
  } catch (e) {
    process.stderr.write(`receipta verify: cannot establish trust root: ${(e as Error).message}\n`);
    exit(2); // S4.2: fail loud, distinct exit code for trust failure
  }

  const report = await verifyChain(storePath, resolver);

  if (format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
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
          d.kind === "recoverable-incomplete"
            ? `  (the final record is torn — the rest of the chain still verified.)`
            : ``,
          ``,
        ].join("\n"),
      );
    }
  }

  exit(report.ok ? 0 : 1);
}

// ─── export ───────────────────────────────────────────────────────────────────

async function cmdExport(positionals: string[], values: Record<string, unknown>): Promise<void> {
  const storePath = positionals[0];
  if (!storePath) {
    process.stderr.write("receipta export: missing <store> path.\n");
    exit(2);
  }
  const format = values.format as string;
  if (!format || !["json", "csv", "ocsf"].includes(format)) {
    process.stderr.write('receipta export: --format must be one of json|csv|ocsf.\n');
    exit(2);
  }

  // Read receipts WITHOUT verifying (export is read-only, never re-signs — S4.3). A verifier who
  // needs assurance runs `verify` first; export just renders whatever is in the store.
  const receipts: Receipt[] = [];
  for await (const rec of readAll(storePath)) {
    if ("receipt" in rec) receipts.push(rec.receipt);
  }

  let output: string;
  switch (format) {
    case "json":
      output = JSON.stringify(receipts, null, 2);
      break;
    case "csv":
      output = toCsv(receipts);
      break;
    case "ocsf":
      output = JSON.stringify(receipts.map(toOcsf), null, 2);
      break;
    default:
      output = "";
  }

  const outFile = values.out as string | undefined;
  if (outFile) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outFile, output + "\n", "utf8");
    process.stdout.write(`exported ${receipts.length} receipt(s) to ${outFile} (${format}).\n`);
  } else {
    process.stdout.write(output + "\n");
  }
}

/** Flatten a receipt to CSV (one row per receipt, key fields). */
function toCsv(receipts: Receipt[]): string {
  const cols = [
    "seq",
    "chain_id",
    "timestamp",
    "provider",
    "model",
    "actor_id",
    "request_id",
    "outcome",
    "content_captured",
    "input_tokens",
    "output_tokens",
    "key_id",
  ];
  const rows = receipts.map((r) =>
    [
      r.body.seq,
      r.body.chain_id,
      r.body.timestamp.iso8601_ms,
      r.body.provider,
      r.body.model,
      r.body.actor.id,
      r.body.request_id ?? "",
      r.body.outcome,
      r.body.content_captured,
      r.body.usage?.input_tokens ?? "",
      r.body.usage?.output_tokens ?? "",
      r.body.key_id,
    ]
      .map(csvEscape)
      .join(","),
  );
  return [cols.join(","), ...rows].join("\n");
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
    category_name: "Application Activity",
    class_name: "API Activity",
    type_uid: 600301,
    type_name: "API Call",
    activity_id: 1,
    time: r.body.timestamp.iso8601_ms,
    status: r.body.outcome === "success" ? "Success" : "Failure",
    severity: r.body.outcome === "error" ? 2 : 1,
    actor: {
      uid: r.body.actor.id,
      type: r.body.actor.type,
      name: r.body.actor.label ?? r.body.actor.id,
    },
    api: {
      operation: "llm_completion",
      service: { name: r.body.provider },
      request: { uid: r.body.request_id ?? "" },
    },
    resource: { uid: r.body.chain_id, type: "receipta_chain" },
    metadata: {
      product: { name: "receipta", version: "0.1" },
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
