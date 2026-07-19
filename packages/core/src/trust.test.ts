/**
 * Unit tests for trust.ts — the offline trust root (key distribution + fingerprint verification).
 *
 * Chain-level untrusted-key behavior is exercised in `chain.test.ts`; this file covers the trust
 * primitives in isolation: loading, the filename==fingerprint anti-substitution rule (S7), the
 * resolver contract, and the hex/raw key-file parsing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { loadTrustRoot, resolverFromTrustRoot, writeTrustedKey } from './trust.js';
import { generateKeyPair, exportPublicKey, importPublicKey, sign, toHex } from './crypto.js';

const TMP = path.join(process.cwd(), '.vitest-tmp', 'trust');

beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
});

async function keyDir(name: string): Promise<string> {
  const dir = path.join(TMP, name + '-' + Math.random().toString(36).slice(2));
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('trust — loadTrustRoot basics', () => {
  it('loads a single .pub file and keys the map by its fingerprint', async () => {
    const kp = generateKeyPair();
    const dir = await keyDir('single');
    await writeTrustedKey(dir, kp.keyId, exportPublicKey(kp.publicKey));

    const root = await loadTrustRoot(dir);
    expect(root.dir).toBe(dir);
    expect(root.keys.size).toBe(1);
    expect(root.keys.has(kp.keyId)).toBe(true);
    const trusted = root.keys.get(kp.keyId)!;
    expect(trusted.fingerprint).toBe(kp.keyId);
  });

  it('loads multiple .pub files into one trust root', async () => {
    const kpA = generateKeyPair();
    const kpB = generateKeyPair();
    const dir = await keyDir('multi');
    await writeTrustedKey(dir, kpA.keyId, exportPublicKey(kpA.publicKey));
    await writeTrustedKey(dir, kpB.keyId, exportPublicKey(kpB.publicKey));

    const root = await loadTrustRoot(dir);
    expect(root.keys.size).toBe(2);
    expect(root.keys.has(kpA.keyId)).toBe(true);
    expect(root.keys.has(kpB.keyId)).toBe(true);
  });

  it('ignores non-.pub files in the trust directory', async () => {
    const kp = generateKeyPair();
    const dir = await keyDir('mixed');
    await writeTrustedKey(dir, kp.keyId, exportPublicKey(kp.publicKey));
    await writeFile(path.join(dir, 'README.md'), 'not a key');
    await writeFile(path.join(dir, 'stray.txt'), 'noise');

    const root = await loadTrustRoot(dir);
    expect(root.keys.size).toBe(1);
  });

  it('fails loud if the directory is missing (S4.2)', async () => {
    await expect(loadTrustRoot(path.join(TMP, 'does-not-exist'))).rejects.toThrow(
      /trust root not found/,
    );
  });

  it('fails loud if the directory has no .pub keys (nothing to verify against)', async () => {
    const dir = await keyDir('empty');
    await expect(loadTrustRoot(dir)).rejects.toThrow(/no \*.pub keys/);
  });
});

describe('trust — filename == fingerprint anti-substitution (S7)', () => {
  it("rejects a key file whose name does not match its content's fingerprint", async () => {
    const kp = generateKeyPair();
    const dir = await keyDir('mislabeled');
    // Write the key under a WRONG filename (a well-formed but different hex string).
    await writeTrustedKey(dir, 'deadbeef'.repeat(8), exportPublicKey(kp.publicKey));
    await expect(loadTrustRoot(dir)).rejects.toThrow(/does not match.*fingerprint/);
  });

  it('accepts the same key written under its correct fingerprint filename', async () => {
    const kp = generateKeyPair();
    const dir = await keyDir('correct-name');
    await writeTrustedKey(dir, kp.keyId, exportPublicKey(kp.publicKey));
    const root = await loadTrustRoot(dir);
    expect(root.keys.has(kp.keyId)).toBe(true);
  });
});

describe('trust — key-file parsing (hex form + raw bytes)', () => {
  it('parses a 64-char hex public key line', async () => {
    const kp = generateKeyPair();
    const dir = await keyDir('hex');
    const hex = toHex(exportPublicKey(kp.publicKey));
    // Write the hex form under the correct fingerprint filename.
    await writeFile(path.join(dir, `${kp.keyId}.pub`), hex + '\n');
    const root = await loadTrustRoot(dir);
    expect(root.keys.has(kp.keyId)).toBe(true);
  });

  it('parses 32 raw bytes (optionally followed by a comment line)', async () => {
    const kp = generateKeyPair();
    const dir = await keyDir('raw-with-comment');
    const raw = Buffer.from(exportPublicKey(kp.publicKey));
    // Raw 32 bytes + a newline + a human-readable fingerprint comment.
    await writeFile(
      path.join(dir, `${kp.keyId}.pub`),
      Buffer.concat([raw, Buffer.from('\nfingerprint: ' + kp.keyId + '\n')]),
    );
    const root = await loadTrustRoot(dir);
    expect(root.keys.has(kp.keyId)).toBe(true);
  });

  it('rejects a key file that is too short (< 32 raw bytes and < 64 hex chars)', async () => {
    const dir = await keyDir('tooshort');
    // A 10-byte file under a (fake) fingerprint name. The fingerprint of 10 arbitrary bytes won't
    // match the filename either, but the underlying parse error fires first for short input.
    await writeFile(path.join(dir, 'ab'.repeat(32) + '.pub'), Buffer.alloc(10));
    await expect(loadTrustRoot(dir)).rejects.toThrow();
  });
});

describe('trust — resolverFromTrustRoot', () => {
  it('returns a verify function for a trusted key_id, undefined for an untrusted one', async () => {
    const kp = generateKeyPair();
    const dir = await keyDir('resolver');
    await writeTrustedKey(dir, kp.keyId, exportPublicKey(kp.publicKey));
    const root = await loadTrustRoot(dir);
    const resolver = resolverFromTrustRoot(root);

    expect(resolver(kp.keyId)).toBeDefined();
    expect(resolver('not-a-trusted-key-id')).toBeUndefined();
  });

  it("the resolver's verify function accepts a valid signature and rejects a forged one", async () => {
    const kp = generateKeyPair();
    const dir = await keyDir('resolver-verify');
    await writeTrustedKey(dir, kp.keyId, exportPublicKey(kp.publicKey));
    const resolver = resolverFromTrustRoot(await loadTrustRoot(dir));

    const verifyFn = resolver(kp.keyId)!;
    const data = Buffer.from('trust-me', 'utf8');
    const sig = sign(data, kp.privateKey);
    expect(verifyFn(data, sig)).toBe(true);

    // A signature from a DIFFERENT key must not verify under kp's public key.
    const other = generateKeyPair();
    const forged = sign(data, other.privateKey);
    expect(verifyFn(data, forged)).toBe(false);

    // Tampered data must not verify.
    expect(verifyFn(Buffer.from('trust-you', 'utf8'), sig)).toBe(false);
  });

  it('importPublicKey/exportPublicKey round-trip the 32-byte raw form (used by the loader)', () => {
    const kp = generateKeyPair();
    const raw = exportPublicKey(kp.publicKey);
    expect(raw.length).toBe(32);
    const restored = importPublicKey(raw);
    expect(toHex(exportPublicKey(restored))).toBe(toHex(raw));
  });
});
