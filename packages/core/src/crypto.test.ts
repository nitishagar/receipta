import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  serializeKeyPair,
  deserializeKeyPair,
  exportPublicKey,
  importPublicKey,
  sign,
  verify,
  sha256,
  hmac,
  toHex,
  fromHex,
  SIGNATURE_SUITE,
} from "./crypto.js";

describe("Ed25519 — generateKeyPair / sign / verify", () => {
  it("generates an Ed25519 key pair with a 32-byte raw public key", () => {
    const kp = generateKeyPair();
    const raw = exportPublicKey(kp.publicKey);
    expect(raw.length).toBe(32);
    expect(kp.keyId).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it("signs and verifies a round-trip (Ed25519 is deterministic)", () => {
    const kp = generateKeyPair();
    const data = Buffer.from("hello receipta", "utf8");
    const sig = sign(data, kp.privateKey);
    expect(sig.length).toBe(64); // Ed25519 signatures are 64 bytes
    expect(verify(data, sig, kp.publicKey)).toBe(true);

    // Determinism: same key + data → same signature (important for reproducible receipts).
    const sig2 = sign(data, kp.privateKey);
    expect(Buffer.from(sig2).equals(Buffer.from(sig))).toBe(true);
  });

  it("rejects a signature over tampered data", () => {
    const kp = generateKeyPair();
    const data = Buffer.from("hello", "utf8");
    const sig = sign(data, kp.privateKey);
    const tampered = Buffer.from("hellp", "utf8");
    expect(verify(tampered, sig, kp.publicKey)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const kpA = generateKeyPair();
    const kpB = generateKeyPair();
    const data = Buffer.from("hello", "utf8");
    const sig = sign(data, kpA.privateKey);
    expect(verify(data, sig, kpB.publicKey)).toBe(false);
  });
});

describe("Ed25519 — serialize / deserialize round-trip", () => {
  it("round-trips a full key pair through bytes (keys/<key_id> storage)", () => {
    const kp = generateKeyPair();
    const serialized = serializeKeyPair(kp);
    expect(serialized.publicKey.length).toBe(32);
    expect(serialized.keyId).toBe(kp.keyId);

    const restored = deserializeKeyPair(serialized);
    expect(restored.keyId).toBe(kp.keyId);
    expect(Buffer.from(exportPublicKey(restored.publicKey)).equals(serialized.publicKey)).toBe(true);

    // A signature from the restored private key verifies under both keys.
    const data = Buffer.from("round trip", "utf8");
    const sig = sign(data, restored.privateKey);
    expect(verify(data, sig, kp.publicKey)).toBe(true);
    expect(verify(data, sig, restored.publicKey)).toBe(true);
  });

  it("constructs a verify-only key holder from a public key alone (trust bundle)", () => {
    const kp = generateKeyPair();
    const pubOnly = deserializeKeyPair({ publicKey: exportPublicKey(kp.publicKey) });
    expect(pubOnly.keyId).toBe(kp.keyId);
    expect(pubOnly.privateKey).toBeUndefined();

    // A signature from the original private key verifies under the imported public key.
    const data = Buffer.from("verify only", "utf8");
    const sig = sign(data, kp.privateKey);
    expect(verify(data, sig, pubOnly.publicKey)).toBe(true);
  });

  it("importPublicKey rejects a non-32-byte raw key", () => {
    expect(() => importPublicKey(new Uint8Array(31))).toThrow(/32-byte/);
  });
});

describe("sha256 / hmac", () => {
  it("sha256 produces the known digest of the empty string", () => {
    expect(toHex(sha256(Buffer.alloc(0)))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("sha256 is deterministic", () => {
    const a = sha256(Buffer.from("receipta", "utf8"));
    const b = sha256(Buffer.from("receipta", "utf8"));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("hmac is deterministic for the same key+data (privacy commitments, D10)", () => {
    const key = Buffer.from("commitment-key", "utf8");
    const data = Buffer.from("user@example.com", "utf8");
    const c1 = hmac(key, data);
    const c2 = hmac(key, data);
    expect(Buffer.from(c1).equals(Buffer.from(c2))).toBe(true);
  });

  it("hmac differs for different keys (keyed → not dictionary-reversible, S1.4)", () => {
    const data = Buffer.from("same content", "utf8");
    const c1 = hmac(Buffer.from("key-one", "utf8"), data);
    const c2 = hmac(Buffer.from("key-two", "utf8"), data);
    expect(Buffer.from(c1).equals(Buffer.from(c2))).toBe(false);
  });

  it("hmac differs from bare sha256 of the same data (keyed vs unkeyed)", () => {
    const data = Buffer.from("content", "utf8");
    const bare = sha256(data);
    const keyed = hmac(Buffer.from("a-key", "utf8"), data);
    expect(Buffer.from(bare).equals(Buffer.from(keyed))).toBe(false);
  });
});

describe("key id", () => {
  it("computeKeyId is the hex sha256 of the raw public key (deterministic key_id)", () => {
    const kp = generateKeyPair();
    const raw = exportPublicKey(kp.publicKey);
    expect(kp.keyId).toBe(toHex(sha256(raw)));
  });
});

describe("hex helpers", () => {
  it("toHex / fromHex round-trip", () => {
    const bytes = Buffer.from([0, 1, 2, 254, 255]);
    expect(toHex(bytes)).toBe("000102feff");
    expect(Buffer.from(fromHex("000102feff")).equals(bytes)).toBe(true);
  });
});

describe("suite", () => {
  it("exposes the v0.1 signature suite id", () => {
    expect(SIGNATURE_SUITE).toBe("ed25519");
  });
});
