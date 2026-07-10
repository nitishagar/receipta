import { describe, it, expect, beforeEach } from "vitest";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { openStore, appendReceipt, appendBody, type ReceiptStore } from "./store.js";
import { buildReceipt, verifyChain, keyPairSigner } from "./chain.js";
import { loadTrustRoot, resolverFromTrustRoot, writeTrustedKey } from "./trust.js";
import { generateKeyPair, exportPublicKey, sign } from "./crypto.js";
import { type Receipt, type ReceiptBody } from "./schema.js";

const TMP = path.join(process.cwd(), ".vitest-tmp", "chain");

async function freshDir(name: string): Promise<string> {
  const dir = path.join(TMP, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

async function freshStore(name: string): Promise<{ store: ReceiptStore; dir: string }> {
  const dir = await freshDir(name);
  const store = await openStore(path.join(dir, "log.receipta"));
  return { store, dir };
}

/** Build a minimal valid receipt body for testing. */
function mkBody(overrides: {
  seq: number;
  prevHash: string;
  chainId: string;
  keyId: string;
  outcome?: ReceiptBody["outcome"];
}): Omit<ReceiptBody, "schema_version" | "suite"> {
  return {
    chain_id: overrides.chainId,
    seq: overrides.seq,
    prev_hash: overrides.prevHash,
    key_id: overrides.keyId,
    timestamp: { iso8601_ms: "2026-07-10T08:06:00.000Z", trust_level: "local_asserted" },
    actor: { type: "service", id: "test-actor" },
    provider: "openai",
    model: "gpt-test",
    request_id: "req-" + overrides.seq,
    attempt_index: 0,
    outcome: overrides.outcome ?? "success",
    content_captured: true,
    capture_mode: "full",
    content: { request: { prompt: "hello" }, response: { text: "world" } },
    usage: { input_tokens: 5, output_tokens: 3 },
  };
}

/** Append a sequence of valid receipts to a store and return them. */
async function appendN(store: ReceiptStore, kp: ReturnType<typeof generateKeyPair>, n: number): Promise<Receipt[]> {
  const signer = keyPairSigner(kp);
  const out: Receipt[] = [];
  for (let i = 0; i < n; i++) {
    const r = buildReceipt({
      prevHash: store.lastHash,
      seq: store.lastSeq + 1,
      chainId: store.meta.chain_id,
      signer,
      body: mkBody({
        seq: store.lastSeq + 1,
        prevHash: store.lastHash,
        chainId: store.meta.chain_id,
        keyId: kp.keyId,
      }),
    });
    // appendReceipt expects a sealed receipt; we built it manually so prev_hash matches.
    await appendReceipt(store, r);
    out.push(r);
  }
  return out;
}

describe("store + chain — valid chain verifies", () => {
  let kp: ReturnType<typeof generateKeyPair>;
  let keyDir: string;

  beforeEach(async () => {
    kp = generateKeyPair();
    keyDir = path.join(TMP, "keys-" + Math.random().toString(36).slice(2));
    await writeTrustedKey(keyDir, kp.keyId, exportPublicKey(kp.publicKey));
  });

  it("appends receipts and verifies the full chain (S1.5)", async () => {
    const { store, dir } = await freshStore("valid-chain");
    await appendN(store, kp, 5);
    await store.close();

    const root = await loadTrustRoot(keyDir);
    const report = await verifyChain(path.join(dir, "log.receipta"), resolverFromTrustRoot(root));

    expect(report.ok).toBe(true);
    expect(report.verifiedCount).toBe(5);
    expect(report.firstDivergence).toBeNull();
  });

  it("an empty store (no receipts) does not verify as ok", async () => {
    const { store, dir } = await freshStore("empty");
    await store.close();
    const root = await loadTrustRoot(keyDir);
    const report = await verifyChain(path.join(dir, "log.receipta"), resolverFromTrustRoot(root));
    expect(report.ok).toBe(false); // no receipts → not "ok" (chain has no signed content)
  });
});

describe("chain — tamper detection names the first divergence (S1.5)", () => {
  let kp: ReturnType<typeof generateKeyPair>;
  let keyDir: string;

  beforeEach(async () => {
    kp = generateKeyPair();
    keyDir = path.join(TMP, "keys-" + Math.random().toString(36).slice(2));
    await writeTrustedKey(keyDir, kp.keyId, exportPublicKey(kp.publicKey));
  });

  async function buildChain(dir: string, n: number): Promise<Receipt[]> {
    const store = await openStore(path.join(dir, "log.receipta"));
    const receipts = await appendN(store, kp, n);
    await store.close();
    return receipts;
  }

  /** Rewrite the on-disk log from an edited list of receipts (for tamper tests). */
  async function rewriteLog(dir: string, receipts: Receipt[]): Promise<void> {
    const logPath = path.join(dir, "log.receipta");
    const { canonicalize } = await import("./canon.js");
    const frames = receipts.map((r) => {
      const bytes = Buffer.from(canonicalize(r as unknown as Record<string, unknown>), "utf8");
      const frame = Buffer.alloc(4 + bytes.length + 1);
      frame.writeUInt32BE(bytes.length, 0);
      bytes.copy(frame, 4);
      frame[frame.length - 1] = 0x0a;
      return frame;
    });
    await writeFile(logPath, Buffer.concat(frames));
  }

  async function verify(dir: string) {
    const root = await loadTrustRoot(keyDir);
    return verifyChain(path.join(dir, "log.receipta"), resolverFromTrustRoot(root));
  }

  it("mutation of a receipt field is detected and names the field (S1.5)", async () => {
    const dir = await freshDir("mutate");
    const receipts = await buildChain(dir, 3);
    // Mutate the model on receipt #2. This changes its signed bytes → signature now invalid.
    receipts[1]!.body.model = "tampered-model";
    await rewriteLog(dir, receipts);

    const report = await verify(dir);
    expect(report.ok).toBe(false);
    expect(report.firstDivergence?.kind).toBe("tamper");
    expect(report.firstDivergence?.receiptSeq).toBe(2);
    expect(report.firstDivergence?.field).toMatch(/signature|model/);
  });

  it("deletion of a receipt is detected via seq/prev_hash gap (S1.5)", async () => {
    const dir = await freshDir("delete");
    const receipts = await buildChain(dir, 4);
    // Delete receipt #2 (index 1). Now #3's prev_hash points at the deleted one's hash.
    const tampered = [receipts[0]!, receipts[2]!, receipts[3]!];
    await rewriteLog(dir, tampered);

    const report = await verify(dir);
    expect(report.ok).toBe(false);
    expect(report.firstDivergence?.kind).toBe("tamper");
    expect(report.firstDivergence?.receiptSeq).toBe(3); // seq 3 follows seq 1 — gap detected
  });

  it("reordering is detected via prev_hash mismatch (S1.5)", async () => {
    const dir = await freshDir("reorder");
    const receipts = await buildChain(dir, 3);
    // Swap #2 and #3 (indices 1, 2). #2's prev_hash no longer follows #1's hash.
    const tampered = [receipts[0]!, receipts[2]!, receipts[1]!];
    await rewriteLog(dir, tampered);

    const report = await verify(dir);
    expect(report.ok).toBe(false);
    expect(report.firstDivergence?.kind).toBe("tamper");
  });

  it("insertion is detected via seq mismatch (S1.5)", async () => {
    const dir = await freshDir("insert");
    const receipts = await buildChain(dir, 2);
    // Duplicate receipt #2 (index 1) — insert it again. seq 2 appears twice.
    const tampered = [receipts[0]!, receipts[1]!, receipts[1]!];
    await rewriteLog(dir, tampered);

    const report = await verify(dir);
    expect(report.ok).toBe(false);
    expect(report.firstDivergence?.kind).toBe("tamper");
  });
});

describe("chain — torn tail vs tamper (S2.4)", () => {
  let kp: ReturnType<typeof generateKeyPair>;
  let keyDir: string;

  beforeEach(async () => {
    kp = generateKeyPair();
    keyDir = path.join(TMP, "keys-" + Math.random().toString(36).slice(2));
    await writeTrustedKey(keyDir, kp.keyId, exportPublicKey(kp.publicKey));
  });

  it("a truncated FINAL record is recoverable-incomplete, not tamper (S2.4)", async () => {
    const dir = await freshDir("torntail");
    const receipts = await (async () => {
      const store = await openStore(path.join(dir, "log.receipta"));
      const r = await appendN(store, kp, 3);
      await store.close();
      return r;
    })();

    // Truncate the last record's bytes on disk (simulate a torn write / crash before rename).
    const logPath = path.join(dir, "log.receipta");
    const full = await readFile(logPath);
    const lastReceiptBytes = Buffer.from(
      JSON.stringify(receipts[2] as unknown as Record<string, unknown>),
      "utf8",
    );
    // Find where the last record starts: search backward for the last full frame.
    const lastFrameStart = full.length - (4 + lastReceiptBytes.length + 1);
    // Keep everything up to lastFrameStart + half the last record (truncated mid-record).
    const truncated = full.subarray(0, lastFrameStart + Math.floor(lastReceiptBytes.length / 2));
    await writeFile(logPath, truncated);

    const root = await loadTrustRoot(keyDir);
    const report = await verifyChain(logPath, resolverFromTrustRoot(root));
    expect(report.ok).toBe(false);
    expect(report.firstDivergence?.kind).toBe("recoverable-incomplete");
    expect(report.verifiedCount).toBe(2); // the first two receipts still verify
  });

  it("a malformed record in the MIDDLE is tamper (S2.4)", async () => {
    const dir = await freshDir("midmalformed");
    await (async () => {
      const store = await openStore(path.join(dir, "log.receipta"));
      await appendN(store, kp, 3);
      await store.close();
    })();

    // Corrupt receipt #2 (middle): overwrite its bytes with invalid JSON but keep the frame.
    const logPath = path.join(dir, "log.receipta");
    const full = await readFile(logPath);
    // Locate record index 1 (the middle one) by walking frames.
    let offset = 0;
    const recordStarts: number[] = [];
    while (offset < full.length) {
      recordStarts.push(offset);
      const len = full.readUInt32BE(offset);
      offset += 4 + len + 1;
    }
    const midStart = recordStarts[1]!;
    const midLen = full.readUInt32BE(midStart);
    const corrupted = Buffer.from(full);
    // Overwrite the JSON body with garbage (keep length field so it's still "a record").
    const garbage = Buffer.alloc(midLen, 0x20); // spaces — invalid JSON
    garbage[0] = 0x40; // '@' — definitely not valid JSON
    garbage.copy(corrupted, midStart + 4);
    await writeFile(logPath, corrupted);

    const root = await loadTrustRoot(keyDir);
    const report = await verifyChain(logPath, resolverFromTrustRoot(root));
    expect(report.ok).toBe(false);
    expect(report.firstDivergence?.kind).toBe("tamper");
  });
});

describe("chain — concurrency (S2.3)", () => {
  it("100 concurrent appends produce a valid linear chain with no lost updates (D6)", async () => {
    const kp = generateKeyPair();
    const keyDir = path.join(TMP, "keys-concurrency-" + Math.random().toString(36).slice(2));
    await writeTrustedKey(keyDir, kp.keyId, exportPublicKey(kp.publicKey));
    const { store, dir } = await freshStore("concurrency");

    // Fire 100 appends concurrently. Without the mutex, these would interleave prev_hash reads
    // and lose updates. With the mutex (D6), the read-tip → build → append critical section in
    // `appendBody` is serialized, so each receipt chains to the correct predecessor.
    const signer = {
      keyId: kp.keyId,
      sign: (canon: string) => sign(Buffer.from(canon, "utf8"), kp.privateKey),
    };
    const tasks = Array.from({ length: 100 }, () =>
      appendBody(
        store,
        mkBody({ seq: 0, prevHash: "", chainId: store.meta.chain_id, keyId: kp.keyId }),
        signer,
      ).then((r) => r.body.seq),
    );
    const returnedSeqs = await Promise.all(tasks);
    await store.close();

    // Every append returned a distinct sequence number 1..100 — no lost updates, no duplicates.
    expect(returnedSeqs.sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));

    // The on-disk chain verifies end-to-end: 100 receipts, valid signatures, continuous linkage.
    const root = await loadTrustRoot(keyDir);
    const report = await verifyChain(path.join(dir, "log.receipta"), resolverFromTrustRoot(root));
    expect(report.ok).toBe(true);
    expect(report.verifiedCount).toBe(100);
    // seq numbers on disk must be exactly 1..100 with no gaps or duplicates (no lost updates).
    const diskSeqs = report.receipts.map((r) => r.body.seq).sort((a, b) => a - b);
    expect(diskSeqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });
});

describe("trust — offline trust check (S4.2)", () => {
  it("verify fails loud when the signing key is not in the trust root (S4.2)", async () => {
    const kp = generateKeyPair();
    const { store, dir } = await freshStore("untrusted");
    await appendN(store, kp, 2);
    await store.close();

    // A trust root with a DIFFERENT key.
    const otherKp = generateKeyPair();
    const otherKeyDir = path.join(TMP, "otherkeys-" + Math.random().toString(36).slice(2));
    await writeTrustedKey(otherKeyDir, otherKp.keyId, exportPublicKey(otherKp.publicKey));
    const root = await loadTrustRoot(otherKeyDir);

    const report = await verifyChain(path.join(dir, "log.receipta"), resolverFromTrustRoot(root));
    expect(report.ok).toBe(false);
    expect(report.firstDivergence?.kind).toBe("untrusted-key");
    expect(report.firstDivergence?.field).toBe("key_id");
  });

  it("loadTrustRoot throws if the directory is missing (S4.2 — fail loud)", async () => {
    await expect(loadTrustRoot(path.join(TMP, "does-not-exist"))).rejects.toThrow(/trust root not found/);
  });

  it("loadTrustRoot throws if a key file's name doesn't match its fingerprint (anti-substitution)", async () => {
    const kp = generateKeyPair();
    const badKeyDir = path.join(TMP, "badname-" + Math.random().toString(36).slice(2));
    // Write the key under a WRONG filename (a different hex string).
    await writeTrustedKey(badKeyDir, "deadbeef".repeat(8), exportPublicKey(kp.publicKey));
    await expect(loadTrustRoot(badKeyDir)).rejects.toThrow(/does not match.*fingerprint/);
  });

  it("a trusted key round-trips: pubkey bytes → file → trust root → verifies (D5)", async () => {
    const kp = generateKeyPair();
    const keyDir = path.join(TMP, "roundtrip-" + Math.random().toString(36).slice(2));
    await writeTrustedKey(keyDir, kp.keyId, exportPublicKey(kp.publicKey));
    const root = await loadTrustRoot(keyDir);
    expect(root.keys.has(kp.keyId)).toBe(true);

    // A signature from the original key verifies under the loaded trust root.
    const resolver = resolverFromTrustRoot(root);
    const verifyFn = resolver(kp.keyId);
    expect(verifyFn).toBeDefined();
    const data = Buffer.from("trust round trip", "utf8");
    const sig = sign(data, kp.privateKey);
    expect(verifyFn!(data, sig)).toBe(true);
  });
});

describe("store — atomicity & process lock (D4/S2.3)", () => {
  it("creating a store writes a meta sidecar with chain_id and commitment_key", async () => {
    const { store, dir } = await freshStore("meta");
    await store.close();
    const metaPath = path.join(dir, "log.receipta.meta.json");
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    expect(meta.chain_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(meta.commitment_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reopening a store preserves its chain_id and tip (appends continue the chain)", async () => {
    const kp = generateKeyPair();
    const keyDir = path.join(TMP, "reopen-keys-" + Math.random().toString(36).slice(2));
    await writeTrustedKey(keyDir, kp.keyId, exportPublicKey(kp.publicKey));
    const dir = path.join(TMP, "reopen");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });

    const store1 = await openStore(path.join(dir, "log.receipta"));
    const chainId = store1.meta.chain_id;
    await appendN(store1, kp, 3);
    await store1.close();

    // Reopen — should see the same chain_id and seq=3.
    const store2 = await openStore(path.join(dir, "log.receipta"));
    expect(store2.meta.chain_id).toBe(chainId);
    expect(store2.lastSeq).toBe(3);
    await appendN(store2, kp, 2);
    await store2.close();

    const root = await loadTrustRoot(keyDir);
    const report = await verifyChain(path.join(dir, "log.receipta"), resolverFromTrustRoot(root));
    expect(report.ok).toBe(true);
    expect(report.verifiedCount).toBe(5); // 3 + 2, continuous
  });

  it("a second opener fails loud while the first holds the lock (multi-process honesty, D3)", async () => {
    const { store, dir } = await freshStore("lock");
    // store is still open (lock held)
    await expect(openStore(path.join(dir, "log.receipta"))).rejects.toThrow(/locked by another writer/);
    await store.close();
    // After close, the lock is released and reopening works.
    const reopened = await openStore(path.join(dir, "log.receipta"));
    await reopened.close();
  });
});

describe("chain — re-canonicalization at verify (D1 defense in depth)", () => {
  it("a receipt whose stored field order differs still verifies (re-canon, D1)", async () => {
    const kp = generateKeyPair();
    const keyDir = path.join(TMP, "recanon-keys-" + Math.random().toString(36).slice(2));
    await writeTrustedKey(keyDir, kp.keyId, exportPublicKey(kp.publicKey));
    const { store, dir } = await freshStore("recanon");
    await appendN(store, kp, 2);
    await store.close();

    // Read the log, re-serialize receipt #1 with REVERSED key order, and rewrite. The bytes the
    // verifier sees are different from what was signed ONLY if the verifier naively re-stringifies.
    // Our verifier re-canonicalizes (D1), so it should still verify.
    const logPath = path.join(dir, "log.receipta");
    const full = await readFile(logPath);
    // Parse the two records.
    const records: Receipt[] = [];
    let offset = 0;
    while (offset < full.length) {
      const len = full.readUInt32BE(offset);
      const json = full.subarray(offset + 4, offset + 4 + len).toString("utf8");
      records.push(JSON.parse(json) as Receipt);
      offset += 4 + len + 1;
    }
    // Reverse the key order of record[0].body by round-tripping through a deliberately-ordered JSON.
    const reversed = reverseKeyOrder(records[0]!.body);
    records[0]!.body = reversed as ReceiptBody;
    // Rewrite the log (re-canonicalizing each record into its frame).
    const { canonicalize } = await import("./canon.js");
    const frames = records.map((r) => {
      const bytes = Buffer.from(canonicalize(r as unknown as Record<string, unknown>), "utf8");
      const frame = Buffer.alloc(4 + bytes.length + 1);
      frame.writeUInt32BE(bytes.length, 0);
      bytes.copy(frame, 4);
      frame[frame.length - 1] = 0x0a;
      return frame;
    });
    await writeFile(logPath, Buffer.concat(frames));

    const root = await loadTrustRoot(keyDir);
    const report = await verifyChain(logPath, resolverFromTrustRoot(root));
    expect(report.ok).toBe(true); // still verifies — the signature is over canonical bytes (D1)
  });
});

/** Reverse the key order of an object's own keys (to simulate a different serializer). */
function reverseKeyOrder(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(reverseKeyOrder);
  if (obj && typeof obj === "object") {
    const entries = Object.entries(obj).reverse();
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = reverseKeyOrder(v);
    return out;
  }
  return obj;
}
