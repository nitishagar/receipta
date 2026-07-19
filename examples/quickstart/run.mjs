#!/usr/bin/env node
/**
 * receipta quickstart — end-to-end in one file, no network, no API key.
 *
 * What this demonstrates:
 *   1. Generate an Ed25519 key pair and publish the trusted public key.
 *   2. Open a receipt store.
 *   3. Make a "provider call" through a receipt-emitting fetch wrapper — using a STUB fetch that
 *      returns a canned OpenAI-shaped response, so the example runs anywhere with no network.
 *   4. Verify the resulting receipt chain offline (exit 0 on a valid chain).
 *   5. Export the receipts as DSSE envelopes signed with the generated key.
 *
 * Run: node examples/quickstart/run.mjs
 * (from the repo root, after `pnpm build` so the built packages exist under dist/)
 */
import {
  generateKeyPair,
  exportPublicKey,
  writeTrustedKey,
  openStore,
  verifyChain,
  loadTrustRoot,
  resolverFromTrustRoot,
  createReceiptFetch,
  keyPairToSigner,
  sign,
  keyPairToJsonString,
  receiptBodyHash,
} from '../../packages/core/dist/index.js';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(__dirname, '.work');

// A minimal "openai" provider adapter: tells receipta how to read usage/model/outcome from a
// response body. (The real one ships in @receipta/openai; this is enough for the example.)
const openaiAdapter = {
  provider: 'openai',
  requestIdHeaders: ['x-request-id'],
  extractUsage: (body) =>
    body?.usage
      ? { input_tokens: body.usage.prompt_tokens, output_tokens: body.usage.completion_tokens }
      : undefined,
  extractModel: (body) => body?.model,
  outcomeFromStatus: (status) => (status >= 200 && status < 300 ? 'success' : 'error'),
};

// A stub fetch: returns a fixed OpenAI-style completion. No network, no API key.
function stubFetch(_url, _init) {
  const body = {
    id: 'chatcmpl-example',
    model: 'gpt-4o',
    choices: [{ message: { role: 'assistant', content: 'Hello from a stubbed model!' } }],
    usage: { prompt_tokens: 9, completion_tokens: 6 },
  };
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-stub-001' },
    }),
  );
}

async function main() {
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });

  // 1. Generate the signing key and publish the trusted public key.
  const kp = generateKeyPair();
  const keyDir = path.join(WORK, 'keys');
  await writeTrustedKey(keyDir, kp.keyId, exportPublicKey(kp.publicKey));
  console.log(`▶ generated key ${kp.keyId.slice(0, 16)}… and published the trusted public key.`);

  // Persist the private key (the DSSE export step signs with it). Mode 0600, refuse-overwrite.
  const keyFile = path.join(WORK, 'key.json');
  await writeFile(keyFile, keyPairToJsonString(kp), { mode: 0o600 });

  // 2. Open a receipt store.
  const storePath = path.join(WORK, 'log.receipta');
  const store = await openStore(storePath);

  // 3. Build a receipt-emitting fetch and "call" the stubbed provider. The third argument is the
  //    base fetch the wrapper calls under the hood — pass the stub so NO network is used. (In a real
  //    integration you'd omit it and let the wrapper call globalThis.fetch.)
  const receiptFetch = createReceiptFetch(
    openaiAdapter,
    {
      store,
      signer: keyPairToSigner(kp),
      actor: { type: 'service', id: 'quickstart-app' },
    },
    stubFetch,
  );
  const res = await receiptFetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'say hi' }] }),
  });
  const responseBody = await res.json();
  console.log(`▶ stubbed call returned: "${responseBody.choices[0].message.content}"`);

  await store.close();

  // 4. Verify the chain offline — exit 0 means valid.
  const root = await loadTrustRoot(keyDir);
  const report = await verifyChain(storePath, resolverFromTrustRoot(root));
  console.log(
    `▶ verify: ${report.ok ? '✅ valid' : '❌ invalid'} — ${report.verifiedCount} receipt(s).`,
  );
  if (!report.ok) {
    console.error('  unexpected:', report.firstDivergence);
    process.exit(1);
  }

  // 5. Export as DSSE envelopes (signed with the same key). This is what an auditor receives.
  //    We re-derive the DSSE inline rather than shelling out to the CLI, to keep the example
  //    dependency-free and demonstrate the raw shape.
  const { readAll } = await import('../../packages/core/dist/index.js');
  const receipts = [];
  for await (const rec of readAll(storePath)) {
    if ('receipt' in rec) receipts.push(rec.receipt);
  }

  const envelopes = receipts.map((r) => {
    const statement = {
      _type: 'https://in-toto.io/Statement/v1',
      // The subject digest is sha256 of the receipt body's canonical bytes — independently
      // recomputable from the predicate by any verifier (this is what the CLI export emits).
      subject: [
        { name: `${r.body.chain_id}/${r.body.seq}`, digest: { sha256: receiptBodyHash(r.body) } },
      ],
      predicateType: 'https://receipta.dev/receipt/v0',
      predicate: r,
    };
    const serialized = Buffer.from(JSON.stringify(statement), 'utf8');
    const pae = paeEncode('application/vnd.in-toto+json', serialized);
    return {
      payloadType: 'application/vnd.in-toto+json',
      payload: serialized.toString('base64'),
      signatures: [
        { keyid: kp.keyId, sig: Buffer.from(sign(pae, kp.privateKey)).toString('base64') },
      ],
    };
  });
  console.log(
    `▶ exported ${envelopes.length} DSSE envelope(s). First signature keyid: ${envelopes[0].signatures[0].keyid.slice(0, 16)}…`,
  );

  console.log('\n✓ quickstart complete. Artifacts are in examples/quickstart/.work/ (gitignored).');
}

/** DSSE PreAuthEncoding — see https://github.com/secure-systems-lab/dsse/blob/master/protocol.md */
function paeEncode(payloadType, body) {
  const typeBytes = Buffer.from(payloadType, 'utf8');
  return Buffer.concat([
    Buffer.from('DSSEv1 ', 'utf8'),
    Buffer.from(String(typeBytes.length), 'utf8'),
    Buffer.from(' ', 'utf8'),
    typeBytes,
    Buffer.from(' ', 'utf8'),
    Buffer.from(String(body.length), 'utf8'),
    Buffer.from(' ', 'utf8'),
    Buffer.from(body),
  ]);
}

main().catch((e) => {
  console.error('quickstart failed:', e);
  process.exit(1);
});
