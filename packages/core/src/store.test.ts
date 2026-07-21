/**
 * Unit tests for store.ts — the append-only log, framing, and the torn-tail / lockfile behaviors.
 *
 * The chain-level integration tests (tamper detection, re-canonicalization, concurrency) stay in
 * `chain.test.ts`; this file covers the store primitives in isolation: framing, the lockfile,
 * torn-tail classification at the frame level, and atomic append.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { openStore, appendBody, appendReceipt, readAll } from './store.js';
import { generateKeyPair } from './crypto.js';
import { buildReceipt, keyPairSigner } from './chain.js';
import type { ReceiptBody } from './schema.js';

const TMP = path.join(process.cwd(), '.vitest-tmp', 'store');

async function freshDir(name: string): Promise<string> {
  const dir = path.join(TMP, name + '-' + Math.random().toString(36).slice(2));
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Minimal valid receipt body for store tests (chain fields are filled by appendBody). */
function mkBody(): Omit<
  ReceiptBody,
  'schema_version' | 'suite' | 'chain_id' | 'seq' | 'prev_hash' | 'key_id'
> {
  return {
    timestamp: { iso8601_ms: '2026-07-10T08:06:00.000Z', trust_level: 'local_asserted' },
    actor: { type: 'service', id: 'test' },
    provider: 'openai',
    model: 'gpt-test',
    outcome: 'success',
    content_captured: true,
    capture_mode: 'full',
    content: { request: { prompt: 'q' }, response: { text: 'a' } },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
});

describe('store — framing (length-prefix + trailing newline)', () => {
  it('each record is a 4-byte big-endian length prefix + JSON body + 0x0a', async () => {
    const dir = await freshDir('framing');
    const logPath = path.join(dir, 'log.receipta');
    const kp = generateKeyPair();
    const store = await openStore(logPath);
    await appendBody(store, mkBody(), keyPairSigner(kp));
    await store.close();

    const buf = await readFile(logPath);
    const len = buf.readUInt32BE(0);
    // The JSON body is exactly `len` bytes, followed by a trailing 0x0a byte.
    const bodyBytes = buf.subarray(4, 4 + len);
    expect(buf[4 + len]).toBe(0x0a);
    expect(JSON.parse(bodyBytes.toString('utf8')).body.provider).toBe('openai');
    expect(buf.length).toBe(4 + len + 1);
  });

  it('readAll yields receipts in append order with continuous indices', async () => {
    const dir = await freshDir('readall');
    const kp = generateKeyPair();
    const store = await openStore(path.join(dir, 'log.receipta'));
    for (let i = 0; i < 3; i++) {
      await appendBody(store, { ...mkBody(), request_id: `r${i}` }, keyPairSigner(kp));
    }
    await store.close();

    const out: number[] = [];
    for await (const rec of readAll(path.join(dir, 'log.receipta'))) {
      if ('receipt' in rec) out.push(rec.index);
    }
    expect(out).toEqual([0, 1, 2]);
  });
});

describe('store — lockfile (single-writer, D3)', () => {
  it('a second openStore on a held store fails loud with a lockfile message', async () => {
    const dir = await freshDir('lock');
    const logPath = path.join(dir, 'log.receipta');
    const store = await openStore(logPath);
    // Lock held — a second open must fail.
    await expect(openStore(logPath)).rejects.toThrow(/locked by another writer/);
    // The lockfile exists on disk while held.
    expect(existsSync(logPath + '.lock')).toBe(true);
    await store.close();
    // After close, the lockfile is gone and reopening works.
    expect(existsSync(logPath + '.lock')).toBe(false);
    const reopened = await openStore(logPath);
    await reopened.close();
  });

  it('a stale lockfile that cannot be acquired is reported clearly (not silently held forever)', async () => {
    const dir = await freshDir('stale');
    const logPath = path.join(dir, 'log.receipta');
    // Pre-create a lockfile so openStore sees an existing lock from a "crashed" prior writer.
    // acquireLock treats an existing lockfile as held (v0.1 is single-writer; manual recovery is
    // documented in the error message).
    await writeFile(logPath + '.lock', 'stale', { flag: 'wx' });
    await expect(openStore(logPath)).rejects.toThrow(/locked by another writer/);
  });
});

describe('store — torn tail classification at the frame level (S2.4)', () => {
  // Helper: append N receipts and return the log path + the receipts.
  async function buildChain(n: number): Promise<{ logPath: string; dir: string }> {
    const dir = await freshDir('torn-' + n);
    const kp = generateKeyPair();
    const store = await openStore(path.join(dir, 'log.receipta'));
    for (let i = 0; i < n; i++) {
      await appendBody(store, mkBody(), keyPairSigner(kp));
    }
    await store.close();
    return { logPath: path.join(dir, 'log.receipta'), dir };
  }

  it('a truncated length prefix (fewer than 4 bytes at the very end) is recoverable-incomplete', async () => {
    const { logPath } = await buildChain(2);
    const full = await readFile(logPath);
    // Append a stray 1-byte partial length prefix to the end (a torn write of the next record's
    // length field — fewer than 4 bytes). The reader must classify this as recoverable, not tamper.
    await writeFile(logPath, Buffer.concat([full, Buffer.from([0x00])]));
    const records = [];
    for await (const rec of readAll(logPath)) records.push(rec);
    // The first two records parse; the trailing partial prefix is an error on the last record.
    expect(records.filter((r) => 'receipt' in r)).toHaveLength(2);
    const errRecord = records.find((r) => 'error' in r);
    expect(errRecord).toBeDefined();
    expect((errRecord as { isLast: boolean }).isLast).toBe(true);
  });

  it('a full length prefix but truncated body mid-frame is recoverable-incomplete (torn tail)', async () => {
    const { logPath } = await buildChain(3);
    const full = await readFile(logPath);
    // Walk to the start of the last frame, then keep the length prefix + half the body.
    let offset = 0;
    const starts: number[] = [];
    while (offset < full.length) {
      starts.push(offset);
      offset += 4 + full.readUInt32BE(offset) + 1;
    }
    const lastStart = starts[starts.length - 1]!;
    const lastLen = full.readUInt32BE(lastStart);
    const truncated = full.subarray(0, lastStart + 4 + Math.floor(lastLen / 2));
    await writeFile(logPath, truncated);

    const records = [];
    for await (const rec of readAll(logPath)) records.push(rec);
    expect(records.filter((r) => 'receipt' in r)).toHaveLength(2); // first two intact
    const errRecord = records.find((r) => 'error' in r);
    expect(errRecord).toBeDefined();
    expect((errRecord as { isLast: boolean }).isLast).toBe(true);
  });

  it('a missing trailing 0x0a sentinel (length says X but no newline after the body) is detected', async () => {
    const { logPath } = await buildChain(2);
    const full = await readFile(logPath);
    // Find the end of the first record and zero out its trailing 0x0a sentinel.
    const firstLen = full.readUInt32BE(0);
    const sentinelOffset = 4 + firstLen;
    const tampered = Buffer.from(full);
    tampered[sentinelOffset] = 0x00; // not 0x0a
    await writeFile(logPath, tampered);

    // The reader reports an error on the first record (malformed frame). This is NOT a torn tail
    // (the record is mid-file, not last) — confirm it surfaces as an error, distinguishing the case
    // from a clean truncation.
    const records = [];
    for await (const rec of readAll(logPath)) records.push(rec);
    expect(records.some((r) => 'error' in r)).toBe(true);
  });
});

describe('store — appendReceipt rejects a receipt whose prev_hash is stale', () => {
  it("throws when the receipt's prev_hash does not match the store tip (TOCTOU guard)", async () => {
    const dir = await freshDir('stale-prev');
    const kp = generateKeyPair();
    const store = await openStore(path.join(dir, 'log.receipta'));
    // A receipt built against the all-zero prev_hash (chain root) is valid for the FIRST append.
    const signer = keyPairSigner(kp);
    const first = buildReceipt({
      prevHash: store.lastHash,
      seq: store.lastSeq + 1,
      chainId: store.meta.chain_id,
      signer,
      body: {
        ...mkBody(),
        chain_id: store.meta.chain_id,
        seq: 1,
        prev_hash: store.lastHash,
        key_id: kp.keyId,
      } as Omit<ReceiptBody, 'schema_version' | 'suite'>,
    });
    await appendReceipt(store, first);

    // A SECOND receipt that ALSO claims the all-zero prev_hash is stale (tip has moved).
    const stale = buildReceipt({
      prevHash: '0'.repeat(64),
      seq: 2,
      chainId: store.meta.chain_id,
      signer,
      body: {
        ...mkBody(),
        chain_id: store.meta.chain_id,
        seq: 2,
        prev_hash: '0'.repeat(64),
        key_id: kp.keyId,
      } as Omit<ReceiptBody, 'schema_version' | 'suite'>,
    });
    await expect(appendReceipt(store, stale)).rejects.toThrow(/does not match store tip/);
    await store.close();
  });
});
