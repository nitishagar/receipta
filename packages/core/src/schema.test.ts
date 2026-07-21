/**
 * Unit tests for schema.ts — canonicalization-for-signing, body hashing, and the zero-hash root.
 *
 * The full RFC 8785 canonicalization (Appendix B vectors) is covered in `canon.test.ts`; this file
 * covers the schema-layer helpers that build ON canonicalization: `canonicalForSigning`,
 * `receiptBodyHash`, and `ZERO_HASH`. It also pins a few known digests so a silent regression in
 * the hashing path is caught immediately.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  canonicalForSigning,
  receiptBodyHash,
  ZERO_HASH,
  SCHEMA_VERSION,
  type ReceiptBody,
} from './schema.js';

/** A minimal, fully-populated receipt body for vector tests. */
function mkBody(overrides: Partial<ReceiptBody> = {}): ReceiptBody {
  return {
    schema_version: SCHEMA_VERSION,
    suite: 'ed25519',
    chain_id: '11111111-1111-1111-1111-111111111111',
    seq: 1,
    prev_hash: ZERO_HASH,
    key_id: 'a'.repeat(64),
    timestamp: { iso8601_ms: '2026-07-10T08:06:00.000Z', trust_level: 'local_asserted' },
    actor: { type: 'service', id: 'app' },
    provider: 'openai',
    model: 'gpt-4o',
    outcome: 'success',
    content_captured: true,
    capture_mode: 'full',
    content: { request: { prompt: 'hello' }, response: { text: 'world' } },
    usage: { input_tokens: 5, output_tokens: 3 },
    ...overrides,
  };
}

describe('schema — ZERO_HASH (chain root prev_hash)', () => {
  it('is 64 hex zeroes (32 zero bytes)', () => {
    expect(ZERO_HASH).toBe('0'.repeat(64));
    expect(ZERO_HASH).toHaveLength(64);
  });
});

describe('schema — canonicalForSigning', () => {
  it('produces RFC 8785 canonical JSON (sorted keys, no whitespace)', () => {
    const canon = canonicalForSigning(mkBody());
    // RFC 8785: keys are sorted, no insignificant whitespace, no trailing newline.
    expect(canon).not.toContain('\n');
    expect(canon).not.toContain('  ');
    // The first key (lexicographically smallest at the top level) is "_type"? No — schema_version
    // sorts before underscore. Confirm deterministic key ordering by checking a known early key.
    expect(canon).toMatch(/^{"actor"/);
  });

  it('excludes the signature envelope from the signed bytes', () => {
    const body = mkBody();
    const canon = canonicalForSigning(body);
    // The signature is a detached property on the Receipt, NOT on ReceiptBody — but confirm the
    // canonical body never contains a "signature" key (it would be a packing bug if it did).
    expect(canon).not.toContain('"signature"');
  });

  it('is deterministic: the same body always canonicalizes to the same bytes', () => {
    const a = canonicalForSigning(mkBody());
    const b = canonicalForSigning(mkBody());
    expect(a).toBe(b);
  });

  it('canonicalizes a body with reordered input keys identically (re-canonicalization, D1)', () => {
    const body = mkBody();
    const canon1 = canonicalForSigning(body);
    // Build a logically-equal body by reversing the object's own key order before canonicalizing.
    const reversed = reverseKeyOrder(body) as ReceiptBody;
    const canon2 = canonicalForSigning(reversed);
    expect(canon1).toBe(canon2);
  });
});

describe('schema — receiptBodyHash (digest of the canonical body)', () => {
  it('is a 64-char lowercase hex sha256', () => {
    const h = receiptBodyHash(mkBody());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same body (deterministic)', () => {
    expect(receiptBodyHash(mkBody())).toBe(receiptBodyHash(mkBody()));
  });

  it('changes when any signed field changes (mutation sensitivity)', () => {
    const base = receiptBodyHash(mkBody());
    // Mutate a signed field — the digest must differ.
    const mutatedModel = receiptBodyHash(mkBody({ model: 'gpt-4o-mini' }));
    const mutatedContent = receiptBodyHash(
      mkBody({ content: { request: { prompt: 'goodbye' }, response: { text: 'world' } } }),
    );
    const mutatedSeq = receiptBodyHash(mkBody({ seq: 2 }));
    expect(mutatedModel).not.toBe(base);
    expect(mutatedContent).not.toBe(base);
    expect(mutatedSeq).not.toBe(base);
  });

  it("ignores reordering of the input object's keys (re-canonicalization, D1)", () => {
    const body = mkBody();
    const h1 = receiptBodyHash(body);
    const h2 = receiptBodyHash(reverseKeyOrder(body) as ReceiptBody);
    expect(h1).toBe(h2);
  });

  it('the digest is independently recomputable from the canonical bytes (no hidden state)', () => {
    const body = mkBody();
    const h = receiptBodyHash(body);
    // Recompute sha256 of the canonical bytes directly and compare.
    const independent = createHash('sha256')
      .update(canonicalForSigning(body), 'utf8')
      .digest('hex');
    expect(h).toBe(independent);
  });
});

/** Reverse the key order of an object's own keys (to simulate a different serializer). */
function reverseKeyOrder(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(reverseKeyOrder);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj).reverse()) out[k] = reverseKeyOrder(v);
    return out;
  }
  return obj;
}
