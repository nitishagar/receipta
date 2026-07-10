/**
 * Append-only receipt store.
 *
 * DESIGN (see PLAN.md D3/D4/D6, IMPLICIT_SPEC S2.3/S2.4):
 * - Single-writer append-only file. Each record is framed as
 *     [4-byte big-endian length][canonical-json-bytes][0x0a (newline)]
 * - Atomicity (D4): an append writes the framed record to a `.tmp` sibling, fsyncs it, then
 *   `rename(2)`s it onto the log tail. rename is atomic on POSIX regardless of size, so a crash
 *   before rename leaves the log intact and an orphaned .tmp (which verify ignores).
 * - Concurrency (D6): an in-process async mutex serializes read-prev_hash → append, so concurrent
 *   captures cannot interleave and lose updates. Multi-process is OUT OF SCOPE for v0.1; a
 *   `store.lock` file makes a second process fail loudly with a clear message (an honest,
 *   *defined* semantic — S2.3).
 * - Per-store identity (D3): a `chain_id` (random UUID) and a `commitment_key` (random 32 bytes,
 *   for HMAC commitments — D10) are created once on open and stored in a sidecar `.meta.json`.
 */
import { open, readFile, rename, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import * as path from "node:path";
import { canonicalize } from "./canon.js";
import { canonicalForSigning, receiptBodyHash, type Receipt, type ReceiptBody } from "./schema.js";

/** The sidecar holding per-store identity (chain_id + commitment_key). */
export interface StoreMeta {
  /** Random UUID — the chain this store holds. Receipts chain within one store. */
  chain_id: string;
  /** 32 random bytes (hex) used as the HMAC key for content commitments (D10). */
  commitment_key: string;
  /** schema_version of the store format, for future migration. */
  store_version: string;
}

const STORE_VERSION = "receipta.store.v0";
const META_SUFFIX = ".meta.json";
const LOCK_SUFFIX = ".lock";
const TMP_SUFFIX = ".tmp";

/** A frame: 4-byte big-endian length, then the bytes, then a 0x0a terminator. */
const LENGTH_PREFIX_BYTES = 4;
const RECORD_TERMINATOR = 0x0a;

/** A handle on an open receipt store. */
export interface ReceiptStore {
  /** Absolute path to the append-only log file. */
  readonly path: string;
  readonly meta: StoreMeta;
  /** The hex SHA-256 of the most recently appended receipt body (the current chain tip). */
  lastHash: string;
  /** Sequence number of the most recently appended receipt. */
  lastSeq: number;
  /** Release the process lock. Call on close. */
  close(): Promise<void>;
}

/** Open (or create) a receipt store at `logPath`. Acquires a process lock; fails loud if locked. */
export async function openStore(logPath: string): Promise<ReceiptStore> {
  const abs = path.resolve(logPath);
  await mkdir(path.dirname(abs), { recursive: true });

  const metaPath = abs + META_SUFFIX;
  const lockPath = abs + LOCK_SUFFIX;
  const meta = await loadOrCreateMeta(metaPath);
  await acquireLock(lockPath);

  // Determine the current chain tip by scanning existing records (so new appends chain correctly
  // onto whatever is already on disk).
  const { lastHash, lastSeq } = await scanTip(abs, meta.chain_id);

  return {
    path: abs,
    meta,
    lastHash,
    lastSeq,
    async close() {
      await releaseLock(lockPath);
    },
  };
}

/**
 * Append a sealed receipt to the store atomically (D4) and under the in-process mutex (D6).
 * Returns the new chain tip hash.
 *
 * The caller is responsible for having built the receipt correctly (prev_hash matching the
 * current tip). `appendReceipt` does NOT re-derive prev_hash — it trusts the sealed receipt —
 * but it does update the in-memory tip so the next append sees the right predecessor.
 */
/**
 * Tiny in-process async mutex (D6). Serializes the read-tip → build → append critical section so
 * concurrent `await`-ed captures cannot interleave prev_hash read/write (the classic lost-update).
 * ~15 LOC, zero-dep, as the plan specifies.
 */
class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Swallow rejection on the chain so one failure doesn't poison all future acquires.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const appendMutex: AsyncMutex = new AsyncMutex();

export async function appendReceipt(store: ReceiptStore, receipt: Receipt): Promise<string> {
  // The prev_hash check runs INSIDE the mutex to avoid a TOCTOU race: a pre-built receipt's
  // prev_hash could go stale between the check and the append if another append lands in between.
  // (For the concurrency-safe path, prefer appendBody, which builds under the mutex.)
  return appendMutex.run(async () => {
    if (receipt.body.prev_hash !== store.lastHash) {
      throw new Error(
        `appendReceipt: receipt.prev_hash (${receipt.body.prev_hash}) does not match store tip ` +
          `(${store.lastHash}); build receipts with buildReceipt using the current store tip, ` +
          `or use appendBody for the concurrency-safe path.`,
      );
    }
    const bytes = Buffer.from(canonicalize(receipt as unknown as Record<string, unknown>), "utf8");
    const frame = frameRecord(bytes);
    await atomicAppend(store.path, frame);
    const newTip = receiptBodyHash(receipt.body);
    store.lastHash = newTip;
    store.lastSeq = receipt.body.seq;
    return newTip;
  });
}

/**
 * Append a receipt body that has NOT yet been sealed; this builds, signs, and appends — all under
 * the in-process mutex, so this is the concurrency-safe append path (D6). The chain fields
 * (chain_id, seq, prev_hash) and key_id are derived from the store + signer.
 */
export async function appendBody(
  store: ReceiptStore,
  body: Omit<
    ReceiptBody,
    "chain_id" | "seq" | "prev_hash" | "key_id" | "suite" | "schema_version"
  > &
    Partial<Pick<ReceiptBody, "key_id" | "suite" | "schema_version">>,
  signer: { keyId: string; sign: (canonicalBody: string) => Uint8Array },
): Promise<Receipt> {
  return appendMutex.run(async () => {
    const fullBody: ReceiptBody = {
      schema_version: body.schema_version ?? "receipta.v0",
      suite: body.suite ?? "ed25519",
      ...body,
      chain_id: store.meta.chain_id,
      seq: store.lastSeq + 1,
      prev_hash: store.lastHash,
      key_id: body.key_id ?? signer.keyId,
    };
    const canonical = canonicalForSigning(fullBody);
    const signature = signer.sign(canonical);
    const receipt: Receipt = {
      body: fullBody,
      signature: Buffer.from(signature).toString("hex"),
    };
    const bytes = Buffer.from(canonicalize(receipt as unknown as Record<string, unknown>), "utf8");
    const frame = frameRecord(bytes);
    await atomicAppend(store.path, frame);
    store.lastHash = receiptBodyHash(fullBody);
    store.lastSeq = fullBody.seq;
    return receipt;
  });
}

/**
 * Read every record from the store, in order.
 *
 * Yields `{ receipt, raw, index }`. A record that fails to parse is yielded as `{ error }` with
 * its byte offset and whether it was the final record — verify uses this to distinguish torn-tail
 * (recoverable-incomplete) from mid-chain tamper (hard fail). See PLAN D4.
 */
export async function* readAll(
  logPath: string,
): AsyncGenerator<
  | { receipt: Receipt; raw: Buffer; index: number }
  | { error: Error; raw: Buffer; index: number; isLast: boolean }
> {
  const abs = path.resolve(logPath);
  if (!existsSync(abs)) return;

  const handle = await open(abs, "r");
  try {
    const stat = await handle.stat();
    const totalSize = stat.size;
    let offset = 0;
    let index = 0;

    while (offset < totalSize) {
      const prefix = Buffer.alloc(LENGTH_PREFIX_BYTES);
      const { bytesRead } = await handle.read(prefix, 0, LENGTH_PREFIX_BYTES, offset);
      if (bytesRead < LENGTH_PREFIX_BYTES) {
        // A truncated length prefix at the very end = torn tail.
        const raw = prefix.subarray(0, bytesRead);
        yield {
          error: new Error(`truncated length prefix at offset ${offset}`),
          raw,
          index,
          isLast: true,
        };
        return;
      }
      const declaredLen = prefix.readUInt32BE(0);
      const recordStart = offset + LENGTH_PREFIX_BYTES;
      const recordEnd = recordStart + declaredLen + 1; // +1 for terminator
      const isLast = recordEnd >= totalSize;

      if (recordEnd > totalSize) {
        // Declared length runs past EOF = torn tail (partial write before rename completed, or
        // external truncation of the tail). This is recoverable-incomplete, NOT tamper.
        const raw = Buffer.alloc(totalSize - recordStart);
        await handle.read(raw, 0, raw.length, recordStart);
        yield {
          error: new Error(
            `record ${index} declares ${declaredLen} bytes but only ${totalSize - recordStart} remain`,
          ),
          raw,
          index,
          isLast: true,
        };
        return;
      }

      const raw = Buffer.alloc(declaredLen);
      const payloadRead = await handle.read(raw, 0, declaredLen, recordStart);
      if (payloadRead.bytesRead < declaredLen) {
        // The file shrank between the size check and the read (concurrent external truncation).
        // Treat as a torn tail.
        yield {
          error: new Error(
            `record ${index}: read ${payloadRead.bytesRead}/${declaredLen} payload bytes (store shrank mid-read)`,
          ),
          raw: raw.subarray(0, payloadRead.bytesRead),
          index,
          isLast: true,
        };
        return;
      }

      // Verify terminator.
      const term = Buffer.alloc(1);
      const termRead = await handle.read(term, 0, 1, recordStart + declaredLen);
      if (termRead.bytesRead < 1 || term[0] !== RECORD_TERMINATOR) {
        yield {
          error: new Error(
            `record ${index} missing 0x0a terminator (got 0x${(term[0] ?? 0).toString(16)})`,
          ),
          raw,
          index,
          isLast,
        };
        offset = recordEnd;
        index++;
        continue;
      }

      let parsed: Receipt;
      try {
        parsed = JSON.parse(raw.toString("utf8")) as Receipt;
      } catch (e) {
        yield {
          error: e instanceof Error ? e : new Error(String(e)),
          raw,
          index,
          isLast,
        };
        offset = recordEnd;
        index++;
        continue;
      }

      yield { receipt: parsed, raw, index };
      offset = recordEnd;
      index++;
    }
  } finally {
    await handle.close();
  }
}

// ─── internal helpers ──────────────────────────────────────────────────────────

function frameRecord(jsonBytes: Buffer): Buffer {
  const frame = Buffer.alloc(LENGTH_PREFIX_BYTES + jsonBytes.length + 1);
  frame.writeUInt32BE(jsonBytes.length, 0);
  jsonBytes.copy(frame, LENGTH_PREFIX_BYTES);
  frame[frame.length - 1] = RECORD_TERMINATOR;
  return frame;
}

/**
 * Atomic append (D4): write the framed record to a temp file, fsync, then rename onto the log.
 *
 * We append the temp to the *previous* log content via copy+rename because rename replaces the
 * target entirely — so to append we: read current log → write current+new to temp → fsync →
 * rename. For the common small-receipt case this is fine; a future optimization could use a
 * true append + fsync when the payload is below PIPE_BUF. Correctness first (S2.4).
 */
async function atomicAppend(logPath: string, frame: Buffer): Promise<void> {
  const tmpPath = logPath + TMP_SUFFIX;
  // Read the existing log (may not exist yet).
  let existing = Buffer.alloc(0);
  if (existsSync(logPath)) {
    existing = await readFile(logPath);
  }
  const combined = Buffer.concat([existing, frame]);
  // Write temp, fsync, rename.
  const fh = await open(tmpPath, "w");
  try {
    await fh.writeFile(combined);
    await fh.sync(); // fsync the temp before the rename — durability (S2.4)
  } finally {
    await fh.close();
  }
  await rename(tmpPath, logPath);
}

async function loadOrCreateMeta(metaPath: string): Promise<StoreMeta> {
  if (existsSync(metaPath)) {
    const text = await readFile(metaPath, "utf8");
    const meta = JSON.parse(text) as StoreMeta;
    if (!meta.chain_id || !meta.commitment_key) {
      throw new Error(`store meta at ${metaPath} is malformed (missing chain_id/commitment_key)`);
    }
    return meta;
  }
  const meta: StoreMeta = {
    chain_id: randomUUID(),
    commitment_key: randomBytes(32).toString("hex"),
    store_version: STORE_VERSION,
  };
  // Write meta atomically (temp → fsync → rename), so a crash mid-create can't leave a half meta.
  // fsync matches atomicAppend's durability contract (S2.4) — the chain_id/commitment_key must
  // survive a crash to be reproducible.
  const tmp = metaPath + TMP_SUFFIX;
  const tmpHandle = await open(tmp, "w");
  try {
    await tmpHandle.writeFile(JSON.stringify(meta, null, 2), "utf8");
    await tmpHandle.sync();
  } finally {
    await tmpHandle.close();
  }
  await rename(tmp, metaPath);
  return meta;
}

/** Scan the log to recover the current chain tip (last receipt's body hash) and seq. */
async function scanTip(logPath: string, chainId: string): Promise<{ lastHash: string; lastSeq: number }> {
  // The genesis tip is the zero hash, seq 0.
  let lastHash = "0".repeat(64);
  let lastSeq = 0;
  for await (const rec of readAll(logPath)) {
    if ("error" in rec) {
      // A torn/partial tail on open: we keep the tip at the last *valid* record and let the
      // user verify to surface it. Do not advance past a broken record.
      break;
    }
    if (rec.receipt.body.chain_id !== chainId) {
      // A record from a different chain — defensive; should not happen in single-chain store.
      break;
    }
    lastHash = receiptBodyHash(rec.receipt.body);
    lastSeq = rec.receipt.body.seq;
  }
  return { lastHash, lastSeq };
}

// ─── process lock (multi-process fail-loud, D3/S2.3) ────────────────────────────

async function acquireLock(lockPath: string): Promise<void> {
  // O_EXCL create via the "wx" flag: succeeds only if the file did not exist. This is the classic
  // atomic lockfile. The 3rd arg to fs/promises open() is the file *mode* (0o600 = rw-------);
  // "wx" already implies O_EXCL so no flag constant is needed alongside it.
  let fh;
  try {
    fh = await open(lockPath, "wx", 0o600);
    await fh.writeFile(`${process.pid}\n`);
    await fh.sync(); // ensure the pid is durably written before we consider the lock held
  } catch (e) {
    // If we created the file but then failed to write, clean up the orphan so a later retry/open
    // isn't permanently blocked by an empty lockfile.
    if (fh) {
      try {
        await fh.close();
      } catch {
        /* ignore */
      }
      try {
        await unlink(lockPath);
      } catch {
        /* ignore */
      }
    }
    // Re-throw only if it's a genuine "already exists" (EEXIST); other errors (e.g. permission)
    // are surfaced with context.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error(
        `receipta store is locked by another writer: ${lockPath} exists.\n` +
          `v0.1 is single-writer per store. If no other process is running, remove the lockfile manually.`,
      );
    }
    throw new Error(`acquireLock: could not create lockfile ${lockPath}: ${code ?? e}`);
  }
  if (fh) await fh.close();
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch {
    // best-effort; an already-absent lock is fine
  }
}
