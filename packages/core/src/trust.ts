/**
 * Trust root — the offline key-distribution mechanism (PLAN D5, IMPLICIT_SPEC S1.2/S3.1/S4.2).
 *
 * A "trust root" is a directory of public-key files: `keys/<key_id>.pub`, each holding the 32-byte
 * raw Ed25519 public key (optionally followed by an RFC8785-style fingerprint comment). Verifiers
 * load these at startup; `receipta verify` refuses to verify a receipt whose `key_id` has no
 * matching trusted key (fail loud — S4.2).
 *
 * The second-channel fingerprint (in README / docs site) lets a human confirm they have the right
 * key bundle before trusting it. This is the minisign precedent (research [R:102]).
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { importPublicKey, sha256, toHex, verify, type KeyObject } from './crypto.js';
import type { TrustResolver } from './chain.js';

export interface TrustedKey {
  keyId: string;
  publicKey: KeyObject;
  /** Hex of sha256(publicKey) — the fingerprint for the second channel. */
  fingerprint: string;
}

export interface TrustRoot {
  /** Directory the keys were loaded from. */
  dir: string;
  keys: Map<string, TrustedKey>;
}

/**
 * Load every `*.pub` file under `dir` into a trust root. Each file's name (minus `.pub`) is its
 * key_id, which MUST equal the sha256(publicKey) hex. A mismatch is a fail-loud error (the file
 * is mislabeled — a possible substitution attack).
 */
export async function loadTrustRoot(dir: string): Promise<TrustRoot> {
  if (!existsSync(dir)) {
    throw new Error(
      `trust root not found: ${dir} (S4.2: refusing to verify without a trusted key bundle)`,
    );
  }
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir);
  const keys = new Map<string, TrustedKey>();
  for (const entry of entries) {
    if (!entry.endsWith('.pub')) continue;
    const keyIdFromFile = entry.slice(0, -'.pub'.length);
    const fullPath = path.join(dir, entry);
    const raw = parsePubFile(await readFile(fullPath));
    const pub = importPublicKey(raw);
    const fingerprint = toHex(sha256(raw));
    if (fingerprint !== keyIdFromFile) {
      throw new Error(
        `trust root key ${fullPath}: filename key_id "${keyIdFromFile}" does not match ` +
          `fingerprint "${fingerprint}" of the key it contains (mislabeled key — possible substitution).`,
      );
    }
    keys.set(fingerprint, { keyId: fingerprint, publicKey: pub, fingerprint });
  }
  if (keys.size === 0) {
    throw new Error(`trust root ${dir} contains no *.pub keys (S4.2: nothing to verify against).`);
  }
  return { dir, keys };
}

/**
 * Build a TrustResolver from a TrustRoot. Returns a verify function for a key_id, or undefined
 * if the key is not trusted (the chain verifier then reports `untrusted-key`).
 */
export function resolverFromTrustRoot(root: TrustRoot): TrustResolver {
  return (keyId: string) => {
    const trusted = root.keys.get(keyId);
    if (!trusted) return undefined;
    return (data: Uint8Array, sig: Uint8Array) => verify(data, sig, trusted.publicKey);
  };
}

/**
 * Parse a `.pub` file. The file's bytes are the 32 raw public-key bytes, optionally followed by a
 * newline and free-text (e.g. a fingerprint comment for human cross-checking). Only the first 32
 * bytes are read as the key.
 */
function parsePubFile(contents: Buffer): Uint8Array {
  const KEY_BYTES = 32;
  // Hex form? A 64-char hex line.
  const text = contents.toString('utf8').trim();
  const firstLine = text.split('\n', 1)[0]!.trim();
  if (/^[0-9a-fA-F]{64}$/.test(firstLine)) {
    return Uint8Array.from(Buffer.from(firstLine, 'hex'));
  }
  // Otherwise raw bytes (first 32).
  if (contents.length >= KEY_BYTES) {
    return Uint8Array.from(contents.subarray(0, KEY_BYTES));
  }
  throw new Error(
    `public key file is ${contents.length} bytes; expected >= 32 raw or 64 hex chars`,
  );
}

/** Write a trusted public key file (32 raw bytes) to `<dir>/<keyId>.pub`. */
export async function writeTrustedKey(
  dir: string,
  keyId: string,
  rawPublicKey: Uint8Array,
): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${keyId}.pub`), Buffer.from(rawPublicKey));
}
