#!/usr/bin/env node
/**
 * Local sample-package smoke — prove the npm-consumer experience BEFORE publishing.
 *
 * What this does (R7, PLAN Phase 5):
 *   1. builds every package;
 *   2. `pnpm pack`s each @receipta/* package into .smoke/packs (tarballs exactly as they would
 *      ship — `files`/`bin`/workspace-dep rewriting included);
 *   3. creates a fresh sample npm project in .smoke/consumer and installs the tarballs
 *      (offline-favoring; no API keys, no LLM network);
 *   4. asserts `npm ls` resolves every @receipta/* to the LOCAL tarball, not the registry
 *      (version equality proves nothing while the workspace version matches the published one);
 *   5. runs a consumer walkthrough against ONLY the installed artifacts: key gen --format json
 *      (with a private-key-leak grep), receipt emission through the SDK with a stubbed fetch,
 *      CLI verify / show / tail / export --format dsse (independently re-verified), and a
 *      tamper check that must flip verify to a non-zero exit.
 *
 * On success the consumer dir is cleaned; on failure it is kept for triage and the exit is
 * non-zero with the failing step named. Run: `pnpm smoke:local`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SMOKE = path.join(ROOT, '.smoke');
const PACKS = path.join(SMOKE, 'packs');
const CONSUMER = path.join(SMOKE, 'consumer');
const PACKAGES = ['core', 'openai', 'anthropic', 'vercel', 'cli'];

/** Run a command, capturing output; on failure throw with the step's name for a clean message. */
async function exec(step, cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await run(cmd, args, { encoding: 'utf8', ...opts });
    return { stdout, stderr };
  } catch (e) {
    const out = (e.stdout ?? '') + (e.stderr ?? '');
    throw new Error(
      `${step}: "${cmd} ${args.join(' ')}" failed (exit ${e.code ?? '?'}):\n${out.slice(0, 4000)}`,
      { cause: e },
    );
  }
}

async function main() {
  // ── 1. Build + pack ─────────────────────────────────────────────────────────
  await rm(SMOKE, { recursive: true, force: true });
  await mkdir(PACKS, { recursive: true });
  await exec('build', 'pnpm', ['build'], { cwd: ROOT });
  const filters = PACKAGES.map((p) => ['--filter', `@receipta/${p}`]).flat();
  await exec('pack', 'pnpm', [...filters, 'pack', '--pack-destination', PACKS], { cwd: ROOT });
  const tarballs = (await readdir(PACKS)).filter((f) => f.endsWith('.tgz')).sort();
  if (tarballs.length !== PACKAGES.length) {
    throw new Error(`pack: expected ${PACKAGES.length} tarballs, found ${tarballs.length}`);
  }
  console.log(`▶ packed ${tarballs.length} tarballs into .smoke/packs`);

  // ── 2. Fresh sample npm project, install from the local tarballs ────────────
  await mkdir(CONSUMER, { recursive: true });
  await writeFile(
    path.join(CONSUMER, 'package.json'),
    JSON.stringify(
      { name: 'receipta-smoke-consumer', private: true, version: '0.0.0', type: 'module' },
      null,
      2,
    ) + '\n',
  );
  await exec(
    'npm install (local tarballs)',
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
      ...tarballs.map((t) => path.join(PACKS, t)),
    ],
    { cwd: CONSUMER },
  );
  console.log('▶ sample project installed @receipta/* from local tarballs');

  // ── 3. Provenance: every @receipta/* must resolve to the LOCAL tarball ──────
  const ls = await exec('npm ls', 'npm', ['ls', '--json'], { cwd: CONSUMER });
  const tree = JSON.parse(ls.stdout || '{}');
  const resolved = {};
  (function walk(node) {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (name.startsWith('@receipta/')) resolved[name] = child.resolved;
      walk(child);
    }
  })(tree);
  const expected = PACKAGES.map((p) => `@receipta/${p}`);
  for (const name of expected) {
    // npm reports file-tarball installs as `file:<abs path>.tgz`; registry installs as https URLs.
    const raw = resolved[name];
    const r = raw?.startsWith('file:') ? raw.slice('file:'.length) : raw;
    if (!r || !r.endsWith('.tgz') || !r.startsWith(PACKS)) {
      throw new Error(
        `provenance: ${name} did not resolve to the local tarball (resolved: ${raw ?? 'absent'}). ` +
          'It may have come from the npm registry — version equality is not proof of locality.',
      );
    }
  }
  console.log('▶ npm ls confirms all @receipta/* resolve to local tarballs (not the registry)');

  // ── 4. Consumer walkthrough via INSTALLED artifacts only ────────────────────
  await writeFile(path.join(CONSUMER, 'sample.mjs'), CONSUMER_SCRIPT);
  await exec('consumer walkthrough', 'node', ['sample.mjs'], { cwd: CONSUMER });
  console.log('▶ consumer walkthrough passed (key gen, receipts, verify, show/tail, DSSE, tamper)');

  // ── 5. Clean on success (kept on failure for triage) ────────────────────────
  await rm(CONSUMER, { recursive: true, force: true });
  console.log('\n✓ smoke:local complete — the sample package installed and worked end-to-end.');
}

main().catch((e) => {
  console.error(`\n✗ smoke:local FAILED at step — ${e.message}`);
  if (existsSync(CONSUMER)) {
    console.error(`  (consumer project kept for triage: ${CONSUMER})`);
  }
  process.exit(1);
});

/**
 * The sample consumer, written into the fresh project. Imports ONLY installed @receipta/* packages
 * and drives the installed `receipta` bin — it must never reach back into the monorepo. Derived
 * from examples/quickstart/run.mjs (stubbed fetch → no network, no API key).
 */
const CONSUMER_SCRIPT = `#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  openStore,
  createReceiptFetch,
  keyPairFromJsonString,
  keyPairToSigner,
  readAll,
  verify as cryptoVerify,
} from '@receipta/core';
import * as openaiPkg from '@receipta/openai';
import * as anthropicPkg from '@receipta/anthropic';
import * as vercelPkg from '@receipta/vercel';

const run = promisify(execFile);
const ROOT = process.cwd();
const CLI = path.join(ROOT, 'node_modules', '.bin', 'receipta');
const out = (m) => console.log('  ' + m);

async function cli(args, expectZero = true) {
  try {
    const r = await run(CLI, args, { cwd: ROOT, encoding: 'utf8' });
    if (!expectZero) throw new Error('expected non-zero exit for: receipta ' + args.join(' '));
    return { stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    if (expectZero) throw new Error('CLI failed (' + args.join(' ') + '): ' + (e.stdout || '') + (e.stderr || ''));
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code };
  }
}

// 1. key gen --format json: machine-readable, secret-safe.
const gen = await cli(['key', 'gen', '--out', 'keys', '--out-private', 'key.json', '--format', 'json']);
const keyInfo = JSON.parse(gen.stdout);
// privateKeyPath echoes the argument exactly as passed (the CLI does not absolutize).
if (!keyInfo.keyId || !keyInfo.publicKey || keyInfo.privateKeyPath !== 'key.json') {
  throw new Error('key gen json shape unexpected: ' + gen.stdout);
}
const keyFileText = await readFile(path.join(ROOT, 'key.json'), 'utf8');
const persisted = JSON.parse(keyFileText);
if (!persisted.privateKey) throw new Error('key.json missing privateKey');
if (gen.stdout.includes(persisted.privateKey) || gen.stderr.includes(persisted.privateKey)) {
  throw new Error('PRIVATE KEY HEX LEAKED in key gen output');
}
out('key gen --format json ok (no private-key leak)');

// 2. Receipts through the installed SDK with a stubbed fetch (no network, no API key).
const stubFetch = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        id: 'chatcmpl-smoke',
        model: 'gpt-4o',
        choices: [{ message: { role: 'assistant', content: 'Hello from the installed package!' } }],
        usage: { prompt_tokens: 9, completion_tokens: 6 },
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req-smoke-001' } },
    ),
  );
const openaiAdapter = {
  provider: 'openai',
  requestIdHeaders: ['x-request-id'],
  extractUsage: (body) =>
    body?.usage ? { input_tokens: body.usage.prompt_tokens, output_tokens: body.usage.completion_tokens } : undefined,
  extractModel: (body) => body?.model,
  outcomeFromStatus: (status) => (status >= 200 && status < 300 ? 'success' : 'error'),
};
const kp = keyPairFromJsonString(keyFileText);
const store = await openStore(path.join(ROOT, 'log.receipta'));
const receiptFetch = createReceiptFetch(
  openaiAdapter,
  { store, signer: keyPairToSigner(kp), actor: { type: 'service', id: 'smoke-consumer' } },
  stubFetch,
);
const res = await receiptFetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'say hi' }] }),
});
await res.json();
const res2 = await receiptFetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'again' }] }),
});
await res2.json();
await store.close();

// Adapter packages must be importable as installed (parity with the registry smoke test).
if (typeof openaiPkg.withReceipts !== 'function' || typeof anthropicPkg.withReceipts !== 'function' || typeof vercelPkg.receiptaTelemetry !== 'function') {
  throw new Error('adapter packages did not import with their expected exports');
}
out('2 receipts emitted via installed @receipta/core; adapters importable');

// 3. verify (whole chain) → exit 0.
const v1 = await cli(['verify', 'log.receipta', '--trust-root', 'keys']);
if (!v1.stdout.includes('valid') || !v1.stdout.includes('2 receipt')) throw new Error('verify output unexpected: ' + v1.stdout);
out('verify ok (exit 0, 2 receipts)');

// 4. show / tail.
const shown = JSON.parse((await cli(['show', 'log.receipta', '1'])).stdout);
if (shown.body.seq !== 1 || shown.body.provider !== 'openai') throw new Error('show seq=1 unexpected');
const tailLines = (await cli(['tail', 'log.receipta', '1'])).stdout.trim().split('\\n');
if (tailLines.length !== 1 || JSON.parse(tailLines[0]).body.seq !== 2) throw new Error('tail n=1 unexpected');
out('show/tail ok');

// 5. export --format dsse, independently re-verified against the persisted public key.
const exp = await cli(['export', 'log.receipta', '--format', 'dsse', '--key', 'key.json']);
const envelopes = JSON.parse(exp.stdout);
if (!Array.isArray(envelopes) || envelopes.length !== 2) throw new Error('expected 2 DSSE envelopes');
for (const env of envelopes) {
  if (env.payloadType !== 'application/vnd.in-toto+json' || env.signatures.length !== 1) throw new Error('envelope shape unexpected');
  const body = Buffer.from(env.payload, 'base64');
  const type = Buffer.from(env.payloadType, 'utf8');
  const pae = Buffer.concat([
    Buffer.from('DSSEv1 '), Buffer.from(String(type.length)), Buffer.from(' '), type,
    Buffer.from(' '), Buffer.from(String(body.length)), Buffer.from(' '), body,
  ]);
  if (!cryptoVerify(pae, Buffer.from(env.signatures[0].sig, 'base64'), kp.publicKey)) {
    throw new Error('DSSE signature did not verify against the generated public key');
  }
}
out('export --format dsse ok (2 envelopes, PAE signatures verified)');

// 6. Tamper → verify must exit non-zero naming a divergence.
const buf = await readFile(path.join(ROOT, 'log.receipta'));
const i = buf.indexOf(Buffer.from('smoke-consumer'));
if (i < 0) throw new Error('could not locate actor bytes to tamper');
buf[i] = buf[i] ^ 0x20;
await writeFile(path.join(ROOT, 'log.receipta'), buf);
const v2 = await cli(['verify', 'log.receipta', '--trust-root', 'keys'], false);
if (v2.code === 0 || !(v2.stdout + v2.stderr).includes('divergence')) {
  throw new Error('tampered store did not produce a divergence report (exit ' + v2.code + ')');
}
out('tamper detected (verify exits non-zero with a divergence)');
out('all consumer steps passed');
`;
