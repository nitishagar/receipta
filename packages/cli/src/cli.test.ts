import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { rm, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';
import {
  openStore,
  appendBody,
  generateKeyPair,
  exportPublicKey,
  writeTrustedKey,
  sign,
  verify,
  keyPairToJsonString,
  keyPairFromJsonString,
  receiptBodyHash,
} from '@receipta/core';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
// The built CLI is at packages/cli/dist/cli.js; run it via node.
const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'cli.js');
const TMP = path.join(process.cwd(), '.vitest-tmp', 'cli');

/** Run the CLI with args; returns { stdout, stderr, exitCode }. */
function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI_PATH, ...args], { cwd: process.cwd() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
  });
}

/** Build a demo store with N receipts + a matching trust root; returns the paths. */
async function buildDemoStore(n: number): Promise<{
  dir: string;
  logPath: string;
  keyDir: string;
  kp: ReturnType<typeof generateKeyPair>;
}> {
  const dir = path.join(TMP, `cli-${Math.random().toString(36).slice(2)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const kp = generateKeyPair();
  const keyDir = path.join(dir, 'keys');
  await writeTrustedKey(keyDir, kp.keyId, exportPublicKey(kp.publicKey));

  const store = await openStore(path.join(dir, 'log.receipta'));
  const signer = {
    keyId: kp.keyId,
    sign: (c: string) => sign(Buffer.from(c, 'utf8'), kp.privateKey),
  };
  for (let i = 0; i < n; i++) {
    await appendBody(
      store,
      {
        timestamp: { iso8601_ms: '2026-07-10T08:06:00.000Z', trust_level: 'local_asserted' },
        actor: { type: 'service', id: 'app' },
        provider: 'openai',
        model: 'gpt-4o',
        request_id: `req-${i}`,
        outcome: 'success',
        content_captured: true,
        capture_mode: 'full',
        content: { request: { prompt: `q${i}` }, response: { text: `a${i}` } },
        usage: { input_tokens: 5, output_tokens: 3 },
      },
      signer,
    );
  }
  await store.close();
  return { dir, logPath: path.join(dir, 'log.receipta'), keyDir, kp };
}

describe('CLI — verify (S4.1)', () => {
  beforeEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    await mkdir(TMP, { recursive: true });
  });

  it('exits 0 on a fully valid chain', async () => {
    const { logPath, keyDir } = await buildDemoStore(3);
    const res = await runCli(['verify', logPath, '--trust-root', keyDir]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('valid');
    expect(res.stdout).toContain('3 receipt');
  });

  it('exits non-zero and names the divergence on a tampered chain (S4.1)', async () => {
    const { logPath, keyDir } = await buildDemoStore(3);
    // Tamper: mutate receipt #2's content on disk.
    const buf = await readFile(logPath);
    const records: unknown[] = [];
    let off = 0;
    while (off < buf.length) {
      const len = buf.readUInt32BE(off);
      records.push(JSON.parse(buf.subarray(off + 4, off + 4 + len).toString('utf8')));
      off += 4 + len + 1;
    }
    (
      records[1] as { body: { content: { response: { text: string } } } }
    ).body.content.response.text = 'TAMPERED';
    const frames = records.map((r) => {
      const bytes = Buffer.from(JSON.stringify(r), 'utf8');
      const f = Buffer.alloc(4 + bytes.length + 1);
      f.writeUInt32BE(bytes.length, 0);
      bytes.copy(f, 4);
      f[f.length - 1] = 0x0a;
      return f;
    });
    await writeFile(logPath, Buffer.concat(frames));

    const res = await runCli(['verify', logPath, '--trust-root', keyDir]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout).toContain('divergence');
    expect(res.stdout).toContain('seq=2');
    expect(res.stdout).toContain('tamper');
  });

  it('fails loud (exit 2) when the trust root is missing (S4.2)', async () => {
    const { logPath, dir } = await buildDemoStore(2);
    const missingRoot = path.join(dir, 'does-not-exist');
    const res = await runCli(['verify', logPath, '--trust-root', missingRoot]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('trust root');
  });

  it('json format emits a machine-readable report', async () => {
    const { logPath, keyDir } = await buildDemoStore(2);
    const res = await runCli(['verify', logPath, '--trust-root', keyDir, '--format', 'json']);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.verifiedCount).toBe(2);
  });
});

describe('CLI — export (S4.3)', () => {
  beforeEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    await mkdir(TMP, { recursive: true });
  });

  it('exports JSON without re-signing (S4.3)', async () => {
    const { logPath } = await buildDemoStore(3);
    const res = await runCli(['export', logPath, '--format', 'json']);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].body.provider).toBe('openai');
  });

  it('exports CSV with a header row + one row per receipt', async () => {
    const { logPath } = await buildDemoStore(2);
    const res = await runCli(['export', logPath, '--format', 'csv']);
    expect(res.exitCode).toBe(0);
    const lines = res.stdout.trim().split('\n');
    expect(lines[0]).toContain('seq,chain_id,timestamp');
    expect(lines.length).toBe(3); // header + 2 rows
    expect(lines[1]).toContain('openai');
  });

  it('exports OCSF (API Activity class uid 6003)', async () => {
    const { logPath } = await buildDemoStore(1);
    const res = await runCli(['export', logPath, '--format', 'ocsf']);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed[0].class_uid).toBe(6003);
    expect(parsed[0].api.service.name).toBe('openai');
    expect(parsed[0].actor.uid).toBe('app');
  });

  it('--out writes to a file', async () => {
    const { logPath, dir } = await buildDemoStore(2);
    const outFile = path.join(dir, 'export.json');
    const res = await runCli(['export', logPath, '--format', 'json', '--out', outFile]);
    expect(res.exitCode).toBe(0);
    const written = await readFile(outFile, 'utf8');
    expect(JSON.parse(written)).toHaveLength(2);
  });

  it('export does not alter the store (S4.3)', async () => {
    const { logPath, keyDir } = await buildDemoStore(2);
    const before = await readFile(logPath);
    await runCli(['export', logPath, '--format', 'json']);
    const after = await readFile(logPath);
    expect(Buffer.from(before).equals(Buffer.from(after))).toBe(true);
    // And the store still verifies.
    const res = await runCli(['verify', logPath, '--trust-root', keyDir]);
    expect(res.exitCode).toBe(0);
  });

  it('--format intoto emits in-toto Statement v1 with matching subject digest', async () => {
    const { logPath, kp } = await buildDemoStore(2);
    const res = await runCli(['export', logPath, '--format', 'intoto']);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed).toHaveLength(2);
    for (const stmt of parsed) {
      expect(stmt._type).toBe('https://in-toto.io/Statement/v1');
      expect(stmt.predicateType).toBe('https://receipta.dev/receipt/v0');
      expect(stmt.subject).toHaveLength(1);
      // Subject name is <chain_id>/<seq>.
      expect(stmt.subject[0].name).toBe(
        `${stmt.predicate.body.chain_id}/${stmt.predicate.body.seq}`,
      );
      // Subject digest is sha256(canon(body)) — recompute independently from the predicate.
      expect(stmt.subject[0].digest.sha256).toBe(receiptBodyHash(stmt.predicate.body));
    }
    // The key_id carried in the predicate matches the trust root that signed the demo store.
    expect(parsed[0].predicate.body.key_id).toBe(kp.keyId);
  });

  it('--format dsse requires --key (exit 2)', async () => {
    const { logPath } = await buildDemoStore(1);
    const res = await runCli(['export', logPath, '--format', 'dsse']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('--format dsse requires --key');
  });

  it('--key is rejected for non-dsse formats (exit 2)', async () => {
    const { logPath, dir } = await buildDemoStore(1);
    const keyFile = path.join(dir, 'k.json');
    await writeFile(keyFile, '{}');
    const res = await runCli(['export', logPath, '--format', 'json', '--key', keyFile]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('--key is only valid with --format dsse');
  });

  it('--format dsse emits a DSSE envelope whose PAE signature verifies against the trust-root pubkey', async () => {
    const { logPath, kp, keyDir } = await buildDemoStore(2);
    // Write the private key in the core-defined JSON format (Phase 1 lands the format; Phase 2 writes
    // it via the CLI). For this test we author the file directly from core.
    const keyFile = path.join(keyDir, 'export-key.json');
    await writeFile(keyFile, keyPairToJsonString(kp), { mode: 0o600 });

    const before = await readFile(logPath);
    const res = await runCli(['export', logPath, '--format', 'dsse', '--key', keyFile]);
    expect(res.exitCode).toBe(0);
    // The store is untouched (export is read-only — S6).
    const after = await readFile(logPath);
    expect(Buffer.from(before).equals(Buffer.from(after))).toBe(true);

    const envelopes = JSON.parse(res.stdout);
    expect(envelopes).toHaveLength(2);
    for (const env of envelopes) {
      expect(env.payloadType).toBe('application/vnd.in-toto+json');
      expect(env.signatures).toHaveLength(1);
      // keyid is the same identifier receipts use (hex sha256 of the pubkey).
      expect(env.signatures[0].keyid).toBe(kp.keyId);
      // Independently re-derive the PAE and verify the signature against the trust-root public key.
      const serializedBody = Buffer.from(env.payload, 'base64');
      const pae = paeEncode('application/vnd.in-toto+json', serializedBody);
      const sig = Buffer.from(env.signatures[0].sig, 'base64');
      expect(verify(pae, sig, kp.publicKey)).toBe(true);
      // The payload is a valid in-toto Statement whose digest matches the embedded receipt body.
      const stmt = JSON.parse(serializedBody.toString('utf8'));
      expect(stmt.subject[0].digest.sha256).toBe(receiptBodyHash(stmt.predicate.body));
    }
  });

  it('--format dsse fails loud (exit 2) on an unreadable key file, store untouched', async () => {
    const { logPath } = await buildDemoStore(1);
    const before = await readFile(logPath);
    const res = await runCli(['export', logPath, '--format', 'dsse', '--key', '/no/such/key.json']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('cannot read key file');
    const after = await readFile(logPath);
    expect(Buffer.from(before).equals(Buffer.from(after))).toBe(true);
  });

  it('--format dsse fails loud (exit 2) on a malformed key file, store untouched', async () => {
    const { logPath, dir } = await buildDemoStore(1);
    const before = await readFile(logPath);
    const keyFile = path.join(dir, 'bad.json');
    await writeFile(keyFile, 'not json at all');
    const res = await runCli(['export', logPath, '--format', 'dsse', '--key', keyFile]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('malformed key file');
    const after = await readFile(logPath);
    expect(Buffer.from(before).equals(Buffer.from(after))).toBe(true);
  });

  it('--format dsse fails loud (exit 2) on a public-only key file (no private key)', async () => {
    const { logPath, kp, dir } = await buildDemoStore(1);
    const keyFile = path.join(dir, 'pub-only.json');
    // Serialize a public-only bundle (omit privateKey).
    await writeFile(
      keyFile,
      JSON.stringify({
        keyId: kp.keyId,
        publicKey: Buffer.from(exportPublicKey(kp.publicKey)).toString('hex'),
      }),
    );
    const res = await runCli(['export', logPath, '--format', 'dsse', '--key', keyFile]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('no private key');
  });

  it('--format intoto/dsse over an empty store emits an empty array', async () => {
    const { dir, kp } = await buildDemoStore(0);
    const logPath = path.join(dir, 'empty.receipta');
    const store = await openStore(logPath);
    await store.close();
    const keyFile = path.join(dir, 'k.json');
    await writeFile(keyFile, keyPairToJsonString(kp), { mode: 0o600 });

    const intoto = await runCli(['export', logPath, '--format', 'intoto']);
    expect(intoto.exitCode).toBe(0);
    expect(JSON.parse(intoto.stdout)).toEqual([]);

    const dsse = await runCli(['export', logPath, '--format', 'dsse', '--key', keyFile]);
    expect(dsse.exitCode).toBe(0);
    expect(JSON.parse(dsse.stdout)).toEqual([]);
  });

  it('--format dsse carries unicode receipt content through PAE (bytes, not chars)', async () => {
    const { dir, kp, keyDir } = await buildDemoStore(0);
    const logPath = path.join(dir, 'uni.receipta');
    const store = await openStore(logPath);
    await appendBody(
      store,
      {
        timestamp: { iso8601_ms: '2026-07-10T08:06:00.000Z', trust_level: 'local_asserted' },
        actor: { type: 'service', id: 'app' },
        provider: 'openai',
        model: 'gpt-4o',
        outcome: 'success',
        content_captured: true,
        capture_mode: 'full',
        content: { request: { prompt: 'héllo→𝕏 世界' }, response: { text: 'héllo→𝕏 世界' } },
        usage: { input_tokens: 5, output_tokens: 3 },
      },
      { keyId: kp.keyId, sign: (c: string) => sign(Buffer.from(c, 'utf8'), kp.privateKey) },
    );
    await store.close();

    const keyFile = path.join(keyDir, 'k.json');
    await writeFile(keyFile, keyPairToJsonString(kp), { mode: 0o600 });
    const res = await runCli(['export', logPath, '--format', 'dsse', '--key', keyFile]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout)[0];
    const serializedBody = Buffer.from(env.payload, 'base64');
    const pae = paeEncode('application/vnd.in-toto+json', serializedBody);
    expect(verify(pae, Buffer.from(env.signatures[0].sig, 'base64'), kp.publicKey)).toBe(true);
    const stmt = JSON.parse(serializedBody.toString('utf8'));
    expect(stmt.predicate.body.content.request.prompt).toBe('héllo→𝕏 世界');
  });
});

/** DSSE PreAuthEncoding — mirrors the CLI's paeEncode so tests verify against the spec, not the impl. */
function paeEncode(payloadType: string, body: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(payloadType, 'utf8');
  const parts = [
    Buffer.from('DSSEv1 ', 'utf8'),
    Buffer.from(String(typeBytes.length), 'utf8'),
    Buffer.from(' ', 'utf8'),
    typeBytes,
    Buffer.from(' ', 'utf8'),
    Buffer.from(String(body.length), 'utf8'),
    Buffer.from(' ', 'utf8'),
    Buffer.from(body),
  ];
  return Buffer.concat(parts);
}

describe('CLI — key gen', () => {
  beforeEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    await mkdir(TMP, { recursive: true });
  });

  it('generates a key pair, writes the .pub file, and prints the fingerprint', async () => {
    const outDir = path.join(TMP, 'genkeys');
    const res = await runCli(['key', 'gen', '--out', outDir]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('key_id');
    expect(res.stdout).toContain('fingerprint');
    // Exactly one .pub file written.
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(outDir);
    const pubFiles = files.filter((f) => f.endsWith('.pub'));
    expect(pubFiles).toHaveLength(1);
    // The filename (minus .pub) equals the key_id printed.
    const keyId = pubFiles[0]!.slice(0, -4);
    expect(res.stdout).toContain(keyId);
  });

  it('--out-private writes a 0600 key file + the .pub, and warns to protect it', async () => {
    const outDir = path.join(TMP, 'genpriv', 'keys');
    const keyFile = path.join(TMP, 'genpriv', 'k.json');
    const res = await runCli(['key', 'gen', '--out', outDir, '--out-private', keyFile]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('private key:');
    expect(res.stdout).toContain(keyFile);
    // Stern, unmissable warning.
    expect(res.stdout).toContain('WARNING');
    expect(res.stdout).toContain('PROTECT THIS FILE');
    // File mode is 0600 (owner read/write only).
    const st = await stat(keyFile);
    // Mask to the permission bits (discard file-type high bits).
    expect(st.mode & 0o777).toBe(0o600);
    // The .pub was also written.
    const { readdir } = await import('node:fs/promises');
    const pubFiles = (await readdir(outDir)).filter((f) => f.endsWith('.pub'));
    expect(pubFiles).toHaveLength(1);
  });

  it('--out-private round-trips: gen → load → append → verify exits 0 (end-to-end)', async () => {
    const work = path.join(TMP, 'e2e');
    const outDir = path.join(work, 'keys');
    const keyFile = path.join(work, 'k.json');
    const logPath = path.join(work, 'log.receipta');

    const res = await runCli(['key', 'gen', '--out', outDir, '--out-private', keyFile]);
    expect(res.exitCode).toBe(0);

    // Load the persisted private key and use it to sign a receipt appended to a store.
    const text = await readFile(keyFile, 'utf8');
    const kp = keyPairFromJsonString(text);
    const store = await openStore(logPath);
    await appendBody(
      store,
      {
        timestamp: { iso8601_ms: '2026-07-10T08:06:00.000Z', trust_level: 'local_asserted' },
        actor: { type: 'service', id: 'app' },
        provider: 'openai',
        model: 'gpt-4o',
        outcome: 'success',
        content_captured: true,
        capture_mode: 'full',
        content: { request: { prompt: 'q' }, response: { text: 'a' } },
      },
      { keyId: kp.keyId, sign: (c) => sign(Buffer.from(c, 'utf8'), kp.privateKey) },
    );
    await store.close();

    // The CLI's verify against the published trust root must accept the chain.
    const verifyRes = await runCli(['verify', logPath, '--trust-root', outDir]);
    expect(verifyRes.exitCode).toBe(0);
    expect(verifyRes.stdout).toContain('valid');
  });

  it('--out-private refuses to overwrite an existing file (exits non-zero, preserves original)', async () => {
    const work = path.join(TMP, 'nocliff');
    const outDir = path.join(work, 'keys');
    const keyFile = path.join(work, 'k.json');
    await mkdir(work, { recursive: true });
    // Pre-existing file with sentinel content.
    await writeFile(keyFile, 'ORIGINAL-DO-NOT-CLOBBER', { mode: 0o600 });

    const res = await runCli(['key', 'gen', '--out', outDir, '--out-private', keyFile]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('refusing to overwrite');
    // The original content is intact.
    const after = await readFile(keyFile, 'utf8');
    expect(after).toBe('ORIGINAL-DO-NOT-CLOBBER');
    // And no .pub was published (private write failed first → nothing else written).
    const { readdir } = await import('node:fs/promises');
    let pubFiles: string[] = [];
    try {
      pubFiles = (await readdir(outDir)).filter((f) => f.endsWith('.pub'));
    } catch {
      // outDir may not even exist — that's fine, the point is no .pub landed.
    }
    expect(pubFiles).toHaveLength(0);
  });

  it('default gen (no --out-private) still discards the private key and prints the NOTE', async () => {
    const outDir = path.join(TMP, 'default');
    const res = await runCli(['key', 'gen', '--out', outDir]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('held in memory and NOT saved');
    expect(res.stdout).not.toContain('WARNING');
  });
});

describe('CLI — help + unknown commands', () => {
  it('prints help with no args (exit 0)', async () => {
    const res = await runCli([]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Usage');
  });

  it('exits 1 on an unknown command', async () => {
    const res = await runCli(['frobnicate']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('unknown command');
  });
});
