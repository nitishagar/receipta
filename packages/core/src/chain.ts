/**
 * Hash-chain build + verify logic.
 *
 * DESIGN (PLAN D3/D7, IMPLICIT_SPEC S1.5/S1.8/S2.4):
 * - `buildReceipt` computes prev_hash from the chain tip, canonicalizes the body, signs it,
 *   returns the sealed receipt. The signed bytes are the RFC 8785 canonical body — `signature`
 *   itself is never signed (it's a detached signature).
 * - `verifyChain` walks the chain and, for each receipt: re-canonicalizes the body (defense in
 *   depth — D1), re-computes its hash and checks it against the *next* receipt's prev_hash,
 *   verifies the signature against the trusted key, and rejects unknown *critical* extensions.
 *   It reports the FIRST divergence precisely: {receiptSeq, field, reason} (S1.5).
 * - Torn-tail vs tamper (S2.4): a malformed FINAL record is `recoverable-incomplete` (skip +
 *   warn, still non-zero exit); a malformed record in the MIDDLE is `tamper` (hard fail).
 */
import { canonicalForSigning, receiptBodyHash, type Receipt, type ReceiptBody } from './schema.js';
import { sign as cryptoSign, type KeyPair } from './crypto.js';
import { readAll } from './store.js';

/** The genesis prev_hash (seq 0's predecessor): SHA-256 of nothing → all-zero hex by convention. */
export const GENESIS_HASH = '0'.repeat(64);

export interface Signer {
  keyId: string;
  sign(canonicalBody: string): Uint8Array;
}

/** Build a signer backed by an Ed25519 KeyPair. */
export function keyPairSigner(kp: KeyPair): Signer {
  return {
    keyId: kp.keyId,
    sign(canonicalBody: string) {
      return cryptoSign(Buffer.from(canonicalBody, 'utf8'), kp.privateKey);
    },
  };
}

/** Build a receipt: fill chain fields, canonicalize, sign. Returns the sealed receipt. */
export function buildReceipt(args: {
  prevHash: string;
  seq: number;
  chainId: string;
  signer: Signer;
  body: Omit<
    ReceiptBody,
    'chain_id' | 'seq' | 'prev_hash' | 'key_id' | 'suite' | 'schema_version'
  > &
    Partial<Pick<ReceiptBody, 'key_id' | 'suite' | 'schema_version'>>;
}): Receipt {
  const fullBody: ReceiptBody = {
    schema_version: args.body.schema_version ?? 'receipta.v0',
    suite: args.body.suite ?? 'ed25519',
    chain_id: args.chainId,
    seq: args.seq,
    prev_hash: args.prevHash,
    key_id: args.signer.keyId,
    timestamp: args.body.timestamp,
    actor: args.body.actor,
    provider: args.body.provider,
    model: args.body.model,
    request_id: args.body.request_id,
    attempt_index: args.body.attempt_index,
    outcome: args.body.outcome,
    content_captured: args.body.content_captured,
    capture_mode: args.body.capture_mode,
    content: args.body.content,
    content_commitments: args.body.content_commitments,
    usage: args.body.usage,
    anchor: args.body.anchor,
    extensions: args.body.extensions,
  };
  const canonical = canonicalForSigning(fullBody);
  const signature = args.signer.sign(canonical);
  return { body: fullBody, signature: Buffer.from(signature).toString('hex') };
}

/** A public-key resolver: given a key_id, return the verifier (or undefined if untrusted). */
export type TrustResolver = (
  keyId: string,
) => ((data: Uint8Array, sig: Uint8Array) => boolean) | undefined;

export type DivergenceKind = 'tamper' | 'recoverable-incomplete' | 'untrusted-key' | 'malformed';

export interface Divergence {
  /** Sequence number of the offending receipt (or -1 if the issue is pre-chain). */
  receiptSeq: number;
  field: string;
  reason: string;
  kind: DivergenceKind;
}

export interface VerifyReport {
  ok: boolean;
  /** Number of receipts that verified successfully before any issue (or total if ok). */
  verifiedCount: number;
  /** The first divergence, if any. Null when the chain is fully valid. */
  firstDivergence: Divergence | null;
  /** All receipts read (parsed), in order — for reporting/export. Empty on unreadable store. */
  receipts: Receipt[];
}

/**
 * Verify a receipt chain end-to-end.
 *
 * `trustResolver` maps key_id → a verify function. A receipt whose key_id is unknown is an
 * `untrusted-key` divergence (S4.2 — fail loud, never verify against an untrusted key).
 *
 * Checks per receipt (in order; the FIRST failure is reported):
 *   1. body.schema_version / suite recognized; unknown *critical* extension → tamper (S1.8).
 *   2. body.chain_id matches the expected chain.
 *   3. body.seq increments by 1 and body.prev_hash equals the previous receipt's body hash.
 *      (Detects insertion, deletion, reordering, mutation — S1.5.)
 *   4. The signature verifies against the trusted key for body.key_id.
 *   5. The receipt's own body hash is recomputable (re-canonicalize — D1 defense in depth).
 *
 * Torn-tail vs tamper (S2.4): a malformed FINAL record is `recoverable-incomplete`; a malformed
 * record in the middle is `tamper`.
 */
export async function verifyChain(
  logPath: string,
  trustResolver: TrustResolver,
): Promise<VerifyReport> {
  const receipts: Receipt[] = [];
  const malformed: Array<{ index: number; error: Error; isLast: boolean }> = [];

  for await (const rec of readAll(logPath)) {
    if ('error' in rec) {
      malformed.push({ index: rec.index, error: rec.error, isLast: rec.isLast });
      continue;
    }
    receipts.push(rec.receipt);
  }

  // Handle malformed records: torn-tail (last) vs tamper (middle).
  for (const m of malformed) {
    if (!m.isLast) {
      return {
        ok: false,
        verifiedCount: receipts.length,
        firstDivergence: {
          receiptSeq: receipts[m.index]?.body.seq ?? m.index,
          field: 'record',
          reason: `malformed record in the middle of the chain: ${m.error.message}`,
          kind: 'tamper',
        },
        receipts,
      };
    }
    // last-record malformed → torn tail. This is recoverable-incomplete (non-zero, but the rest
    // of the chain can still be reported/verified).
  }

  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  let chainId: string | null = null;

  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]!;
    const b = r.body;

    // 1. schema version / suite / critical extensions.
    if (b.schema_version !== 'receipta.v0') {
      return fail(
        i,
        b.seq,
        'schema_version',
        `unsupported schema_version "${b.schema_version}"`,
        'tamper',
        receipts,
      );
    }
    if (b.suite !== 'ed25519') {
      // A non-ed25519 suite is unknown to v0.1. If treated as critical (suites always are), fail.
      return fail(
        i,
        b.seq,
        'suite',
        `unsupported signature suite "${b.suite}"`,
        'tamper',
        receipts,
      );
    }
    if (b.extensions) {
      for (const [name, ext] of Object.entries(b.extensions)) {
        if (ext.critical) {
          return fail(
            i,
            b.seq,
            `extensions.${name}`,
            `unknown critical extension "${name}" — refusing to verify (S1.8)`,
            'tamper',
            receipts,
          );
        }
      }
    }

    // 2. chain identity.
    if (chainId === null) chainId = b.chain_id;
    else if (b.chain_id !== chainId) {
      return fail(
        i,
        b.seq,
        'chain_id',
        `chain_id changed mid-chain: ${chainId} → ${b.chain_id}`,
        'tamper',
        receipts,
      );
    }

    // 3. sequence + prev_hash linkage (the core of S1.5).
    if (b.seq !== expectedSeq) {
      return fail(
        i,
        b.seq,
        'seq',
        `expected seq ${expectedSeq} but found ${b.seq} (insertion/deletion/reorder)`,
        'tamper',
        receipts,
      );
    }
    if (b.prev_hash !== prevHash) {
      return fail(
        i,
        b.seq,
        'prev_hash',
        `prev_hash ${b.prev_hash} does not match recomputed ${prevHash} (mutation/reorder)`,
        'tamper',
        receipts,
      );
    }

    // 4. signature verification against the trusted key.
    const verifier = trustResolver(b.key_id);
    if (!verifier) {
      return fail(
        i,
        b.seq,
        'key_id',
        `no trusted public key for key_id ${b.key_id} (S4.2: refuse to verify against untrusted key)`,
        'untrusted-key',
        receipts,
      );
    }
    const canonical = canonicalForSigning(b);
    const sigBytes = Buffer.from(r.signature, 'hex');
    if (sigBytes.length !== 64) {
      return fail(
        i,
        b.seq,
        'signature',
        `signature is ${sigBytes.length} bytes, expected 64 (Ed25519)`,
        'tamper',
        receipts,
      );
    }
    if (!verifier(Buffer.from(canonical, 'utf8'), sigBytes)) {
      return fail(
        i,
        b.seq,
        'signature',
        'signature does not verify under the trusted key (forgery/mutation)',
        'tamper',
        receipts,
      );
    }

    // 5. recompute this receipt's body hash to advance the chain (defense in depth, D1).
    prevHash = receiptBodyHash(b);
    expectedSeq++;
  }

  // If there was a torn tail, report it as recoverable-incomplete (non-zero exit, but not tamper).
  const tornTail = malformed.find((m) => m.isLast);
  if (tornTail && receipts.length > 0) {
    return {
      ok: false,
      verifiedCount: receipts.length,
      firstDivergence: {
        receiptSeq: receipts[receipts.length - 1]!.body.seq,
        field: 'tail',
        reason: `torn final record (recoverable-incomplete): ${tornTail.error.message}`,
        kind: 'recoverable-incomplete',
      },
      receipts,
    };
  }
  if (tornTail) {
    // No valid receipts at all, just a torn genesis.
    return {
      ok: false,
      verifiedCount: 0,
      firstDivergence: {
        receiptSeq: 0,
        field: 'tail',
        reason: `torn final record and no valid receipts: ${tornTail.error.message}`,
        kind: 'recoverable-incomplete',
      },
      receipts,
    };
  }

  return {
    ok: receipts.length > 0,
    verifiedCount: receipts.length,
    firstDivergence: null,
    receipts,
  };
}

function fail(
  index: number,
  seq: number,
  field: string,
  reason: string,
  kind: DivergenceKind,
  receipts: Receipt[],
): VerifyReport {
  return {
    ok: false,
    verifiedCount: index,
    firstDivergence: { receiptSeq: seq, field, reason, kind },
    receipts,
  };
}
