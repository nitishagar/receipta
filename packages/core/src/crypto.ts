/**
 * Cryptographic primitives for receipta — thin typed wrappers over Node's `crypto`.
 *
 * Zero runtime dependencies (PLAN S5.2). Ed25519 (FIPS 186-5) is the v0.1 signature suite.
 * SHA-256 backs the hash chain; HMAC-SHA256 backs privacy commitments (PLAN D10 — keyed, not
 * bare, so commitments over personal data are not dictionary-reversible).
 *
 * All byte-oriented functions return `Uint8Array`. Internally we operate on Node `Buffer` (a
 * `Uint8Array` subclass) so the return values are directly usable as `Uint8Array`.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  createHmac,
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export type { KeyObject };

const SUITE = 'ed25519' as const;

/** A serialized Ed25519 key pair: 32-byte raw public key + PKCS#8 private key. */
export interface SerializedKeyPair {
  /** 32-byte raw Ed25519 public key. */
  publicKey: Uint8Array;
  /** PKCS#8 DER-encoded private key (encrypted-at-rest is the caller's concern). */
  privateKey: Uint8Array;
  /** Stable identifier: hex of the SHA-256 of the public key. Used as `key_id` in receipts. */
  keyId: string;
}

export interface KeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
  /** Stable identifier: hex of the SHA-256 of the public key. Used as `key_id` in receipts. */
  keyId: string;
}

/**
 * Generate a fresh Ed25519 key pair.
 * `crypto.generateKeyPairSync('ed25519')` produces a 64-byte signature under `sign(null, ...)`.
 */
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = computeKeyId(publicKey);
  return { publicKey, privateKey, keyId };
}

/** Serialize a KeyPair to portable bytes (for storage in `keys/<key_id>` files). */
export function serializeKeyPair(kp: KeyPair): SerializedKeyPair {
  return {
    publicKey: exportPublicKey(kp.publicKey),
    privateKey: kp.privateKey.export({ type: 'pkcs8', format: 'der' }) as Uint8Array,
    keyId: kp.keyId,
  };
}

/**
 * Build a KeyPair from serialized bytes. The privateKey may be omitted to construct a
 * verification-only key holder (the trust bundle carries public keys only).
 */
export function deserializeKeyPair(
  serialized: Pick<SerializedKeyPair, 'publicKey'> & Partial<Pick<SerializedKeyPair, 'privateKey'>>,
): KeyPair {
  const publicKey = importPublicKey(serialized.publicKey);
  const privateKey = serialized.privateKey
    ? createPrivateKey({ key: Buffer.from(serialized.privateKey), format: 'der', type: 'pkcs8' })
    : undefined;
  const keyId = computeKeyId(publicKey);
  return { publicKey, privateKey: privateKey as KeyObject, keyId };
}

/** Export a public key as 32 raw bytes (WebCrypto `raw` / SPKI-stripped form). */
export function exportPublicKey(publicKey: KeyObject): Uint8Array {
  // Ed25519 SPKI is 44 bytes: a 12-byte ASN.1 prefix + 32 raw key bytes. We strip the prefix so
  // the stored/exchanged form is the canonical 32 bytes (matches WebCrypto exportKey('raw')).
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Uint8Array;
  const ED25519_SPKI_PREFIX_LEN = 12;
  if (spki.length !== 44) {
    throw new Error(`exportPublicKey: expected 44-byte Ed25519 SPKI, got ${spki.length}`);
  }
  return spki.subarray(ED25519_SPKI_PREFIX_LEN);
}

/** Import a 32-byte raw Ed25519 public key back into a KeyObject. */
export function importPublicKey(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) {
    throw new Error(`importPublicKey: expected 32-byte raw Ed25519 key, got ${raw.length}`);
  }
  // Reconstruct the SPKI by prefixing the standard 12-byte Ed25519 AlgorithmIdentifier.
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]);
  return createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

// ASN.1 AlgorithmIdentifier for Ed25519 (RFC 8410): SEQUENCE { OID 1.3.101.112 }
const ED25519_SPKI_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/**
 * Sign `data` with an Ed25519 private key. Ed25519 is deterministic, so the same input always
 * produces the same 64-byte signature (important for reproducible receipts).
 */
export function sign(data: Uint8Array, privateKey: KeyObject): Uint8Array {
  return cryptoSign(null, Buffer.from(data), privateKey);
}

/** Verify an Ed25519 signature. Returns true iff the signature is valid for `data` under `publicKey`. */
export function verify(data: Uint8Array, signature: Uint8Array, publicKey: KeyObject): boolean {
  return cryptoVerify(null, Buffer.from(data), publicKey, Buffer.from(signature));
}

/** SHA-256 digest. Used for `prev_hash` and `key_id` derivation. */
export function sha256(data: Uint8Array): Uint8Array {
  return createHash('sha256').update(Buffer.from(data)).digest();
}

/**
 * HMAC-SHA256. Used for privacy commitments over content (PLAN D10): a keyed MAC, not a bare
 * digest, so a commitment over a low-entropy value (e.g. an email) is not dictionary-reversible.
 */
export function hmac(key: Uint8Array, data: Uint8Array): Uint8Array {
  return createHmac('sha256', Buffer.from(key)).update(Buffer.from(data)).digest();
}

/**
 * `key_id` = hex(sha256(publicKey)). Deterministic and short enough to use as a filename
 * (`keys/<key_id>.pub`) and to carry in every receipt (S3.1).
 */
export function computeKeyId(publicKey: KeyObject): string {
  return Buffer.from(sha256(exportPublicKey(publicKey))).toString('hex');
}

/** Hex encode (lowercase) — convenience for fingerprints and digests in receipts/reports. */
export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Hex decode — inverse of toHex. */
export function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/**
 * On-disk key-pair envelope: JSON `{ keyId, publicKey, privateKey }` with the byte fields hex-encoded.
 * (`serializeKeyPair`'s `Uint8Array` fields do not survive naive `JSON.stringify` — they'd emit
 * index-keyed objects — so this format defines a stable, human-auditable on-disk encoding.) The same
 * format is written by `receipta key gen --out-private` and read by `receipta export --format dsse`.
 */
export interface KeyPairJson {
  keyId: string;
  /** Hex of the 32-byte raw Ed25519 public key. */
  publicKey: string;
  /** Hex of the PKCS#8 DER private key. Absent for verify-only bundles. */
  privateKey?: string;
}

/** Serialize a KeyPair to the on-disk JSON string format. */
export function keyPairToJsonString(kp: KeyPair): string {
  const s = serializeKeyPair(kp);
  const envelope: KeyPairJson = {
    keyId: s.keyId,
    publicKey: toHex(s.publicKey),
    privateKey: toHex(s.privateKey),
  };
  return JSON.stringify(envelope);
}

/**
 * Parse an on-disk key-pair JSON string into a KeyPair. Throws on malformed JSON, missing fields, or
 * a `keyId` that does not match the SHA-256 of the embedded public key (anti-substitution, S7).
 */
export function keyPairFromJsonString(text: string): KeyPair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`keyPairFromJsonString: not valid JSON (${(e as Error).message})`, {
      cause: e,
    });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('keyPairFromJsonString: expected a JSON object');
  }
  const obj = parsed as Partial<KeyPairJson>;
  if (typeof obj.keyId !== 'string' || typeof obj.publicKey !== 'string') {
    throw new Error('keyPairFromJsonString: missing required string fields keyId/publicKey');
  }
  if (obj.privateKey !== undefined && typeof obj.privateKey !== 'string') {
    throw new Error('keyPairFromJsonString: privateKey must be a hex string when present');
  }
  const kp = deserializeKeyPair({
    publicKey: fromHex(obj.publicKey),
    privateKey: obj.privateKey ? fromHex(obj.privateKey) : undefined,
  });
  if (kp.keyId !== obj.keyId) {
    throw new Error(
      `keyPairFromJsonString: embedded keyId "${obj.keyId}" does not match fingerprint "${kp.keyId}" ` +
        `of the public key (mislabeled key — possible substitution).`,
    );
  }
  return kp;
}

/** The signature suite identifier carried in every receipt (PLAN D7). */
export const SIGNATURE_SUITE = SUITE;
