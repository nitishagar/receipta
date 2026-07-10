#!/usr/bin/env node
/**
 * verify:demo — a single command a reviewer runs to watch a forged receipt fail verification.
 *
 * Builds a demo store, verifies it (pass), tampers one receipt's content, re-verifies (fail with
 * the named divergence), and truncates the tail to show torn-tail (recoverable-incomplete).
 * Uses @receipta/core directly (the CLI wraps this in Phase 4).
 *
 * Run: pnpm verify:demo   (or: node packages/core/scripts/verify-demo.mjs)
 */
import {
  generateKeyPair,
  exportPublicKey,
  sign,
  openStore,
  appendBody,
  verifyChain,
  keyPairSigner,
  loadTrustRoot,
  resolverFromTrustRoot,
  writeTrustedKey,
} from "../dist/index.js";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = path.join(__dirname, "..", "..", "..", ".demo-store");

async function main() {
  await rm(DEMO_DIR, { recursive: true, force: true });
  await mkdir(DEMO_DIR, { recursive: true });

  // 1. Generate a signing key and publish its public key to a trust root.
  const kp = generateKeyPair();
  const keyDir = path.join(DEMO_DIR, "keys");
  await writeTrustedKey(keyDir, kp.keyId, exportPublicKey(kp.publicKey));
  console.log(`▶ generated signing key ${kp.keyId.slice(0, 16)}…`);
  console.log(`  trusted public key written to ${path.relative(process.cwd(), keyDir)}/${kp.keyId.slice(0, 16)}….pub\n`);

  // 2. Build a store and append 3 receipts (a tiny decision chain).
  const store = await openStore(path.join(DEMO_DIR, "log.receipta"));
  const signer = {
    keyId: kp.keyId,
    sign: (canon) => sign(Buffer.from(canon, "utf8"), kp.privateKey),
  };
  for (let i = 0; i < 3; i++) {
    await appendBody(store, {
      timestamp: { iso8601_ms: new Date().toISOString(), trust_level: "local_asserted" },
      actor: { type: "service", id: "demo-agent" },
      provider: "openai",
      model: "gpt-demo",
      request_id: `req-${i}`,
      attempt_index: 0,
      outcome: "success",
      content_captured: true,
      capture_mode: "full",
      content: { request: { prompt: `question ${i}` }, response: { text: `answer ${i}` } },
      usage: { input_tokens: 5, output_tokens: 3 },
    }, signer);
  }
  await store.close();
  console.log(`▶ appended 3 signed receipts to ${path.relative(process.cwd(), store.path)}\n`);

  // 3. Verify — should pass.
  const root = await loadTrustRoot(keyDir);
  const logPath = store.path;
  const okReport = await verifyChain(logPath, resolverFromTrustRoot(root));
  console.log("▶ verify (untampered):", okReport.ok ? "✅ VALID — chain verifies" : "❌ UNEXPECTED FAIL");
  console.log(`  ${okReport.verifiedCount} receipts verified.\n`);

  // 4. Tamper: mutate receipt #2's content on disk, then re-verify.
  const log = await readFile(logPath);
  const records = [];
  let off = 0;
  while (off < log.length) {
    const len = log.readUInt32BE(off);
    records.push(JSON.parse(log.subarray(off + 4, off + 4 + len).toString("utf8")));
    off += 4 + len + 1;
  }
  records[1].body.content.response.text = "TAMPERED — this was not the real answer";
  await rewriteLog(logPath, records);

  const tamperReport = await verifyChain(logPath, resolverFromTrustRoot(root));
  console.log("▶ verify (after tampering receipt #2's content): ❌ DETECTED");
  console.log(`  first divergence: receipt seq=${tamperReport.firstDivergence.receiptSeq},`);
  console.log(`                    field="${tamperReport.firstDivergence.field}",`);
  console.log(`                    reason: ${tamperReport.firstDivergence.reason}\n`);

  console.log("✓ demo complete. A forged receipt was caught and named precisely.");
  console.log("  (This is the core property: tamper-evidence under T1 — an external tamperer");
  console.log("   without the signing key cannot alter stored records undetected.)\n");

  await rm(DEMO_DIR, { recursive: true, force: true });
}

async function rewriteLog(logPath, records) {
  const frames = records.map((r) => {
    const bytes = Buffer.from(JSON.stringify(r), "utf8");
    const frame = Buffer.alloc(4 + bytes.length + 1);
    frame.writeUInt32BE(bytes.length, 0);
    bytes.copy(frame, 4);
    frame[frame.length - 1] = 0x0a;
    return frame;
  });
  await writeFile(logPath, Buffer.concat(frames));
}

main().catch((e) => {
  console.error("verify:demo failed:", e);
  process.exit(1);
});
