import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import {
  openStore,
  verifyChain,
  loadTrustRoot,
  resolverFromTrustRoot,
  writeTrustedKey,
  generateKeyPair,
  exportPublicKey,
  type ReceiptStore,
} from '@receipta/core';
import { receiptaTelemetry, receiptaTelemetryV6 } from './index.js';

const TMP = path.join(process.cwd(), '.vitest-tmp', 'vercel');

async function freshStore(): Promise<{
  store: ReceiptStore;
  dir: string;
  keyDir: string;
  kp: ReturnType<typeof generateKeyPair>;
}> {
  const dir = path.join(TMP, `s-${Math.random().toString(36).slice(2)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const store = await openStore(path.join(dir, 'log.receipta'));
  const kp = generateKeyPair();
  const keyDir = path.join(dir, 'keys');
  await writeTrustedKey(keyDir, kp.keyId, exportPublicKey(kp.publicKey));
  return { store, dir, keyDir, kp };
}

async function verifyStore(dir: string, keyDir: string) {
  const root = await loadTrustRoot(keyDir);
  return verifyChain(path.join(dir, 'log.receipta'), resolverFromTrustRoot(root));
}

describe('receiptaTelemetry — receipt emission from the callback', () => {
  let setup: Awaited<ReturnType<typeof freshStore>>;

  beforeEach(async () => {
    setup = await freshStore();
  });
  afterEach(async () => {
    await setup.store.close();
  });

  it('emits a receipt with the assembled result fields (model, usage, finishReason)', async () => {
    const tel = receiptaTelemetry({
      store: setup.store,
      signer: setup.kp,
      actor: { type: 'agent', id: 'my-agent' },
    });
    // Simulate the v7 callback firing with an assembled result.
    tel.onLanguageModelCallEnd!({
      callId: 'call-001',
      model: 'gpt-4o',
      provider: 'openai',
      finishReason: 'stop',
      usage: { promptTokens: 11, completionTokens: 6 },
      content: 'The assembled answer.',
    });
    // appendBody is async; give it a tick to flush (it's fire-and-forget in the callback).
    await tel.flush();
    await setup.store.close();

    const report = await verifyStore(setup.dir, setup.keyDir);
    expect(report.ok).toBe(true);
    const r = report.receipts[0]!;
    expect(r.body.provider).toBe('openai');
    expect(r.body.model).toBe('gpt-4o');
    expect(r.body.usage).toEqual({ input_tokens: 11, output_tokens: 6 });
    expect(r.body.outcome).toBe('success');
    expect(r.body.request_id).toBe('call-001');
    expect(r.body.content_captured).toBe(true);
    expect(r.body.content?.response).toBe('The assembled answer.');
    // Output commitment present (HMAC, D10).
    expect(r.body.content_commitments?.response).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computes the output commitment over the FINAL ASSEMBLED output (S2.5), not chunks', async () => {
    // The callback fires ONCE with the fully-assembled content; there is no intermediate-chunk
    // path. We assert the commitment is EXACTLY HMAC over the assembled bytes (recomputed
    // independently) — a regression that committed over raw chunks (or over a different
    // serialization of the content) would change the digest and fail this assertion.
    const tel = receiptaTelemetry({
      store: setup.store,
      signer: setup.kp,
      actor: { type: 'agent', id: 'a' },
    });
    const assembled = { role: 'assistant', content: 'final assembled text' };
    tel.onLanguageModelCallEnd!({ model: 'm', content: assembled, finishReason: 'stop' });
    await tel.flush();
    await setup.store.close();

    const report = await verifyStore(setup.dir, setup.keyDir);
    expect(report.ok).toBe(true);
    const r = report.receipts[0]!;
    expect(r.body.content?.response).toEqual(assembled);
    // Recompute the expected commitment independently from the assembled bytes, using the
    // store's commitment key (the HMAC key, D10). This proves the stored digest was derived
    // from the assembled output, not from some intermediate form.
    const { hmac, toHex } = await import('@receipta/core');
    const expectedKey = Buffer.from(setup.store.meta.commitment_key, 'hex');
    const expectedResp = toHex(hmac(expectedKey, Buffer.from(JSON.stringify(assembled), 'utf8')));
    expect(r.body.content_commitments?.response).toBe(expectedResp);
    // Sanity: the digest is a 64-hex-char string (not undefined / not a bare placeholder).
    expect(r.body.content_commitments?.response).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('receiptaTelemetry — metadata-only edge (S1.3, the load-bearing Vercel case)', () => {
  let setup: Awaited<ReturnType<typeof freshStore>>;

  beforeEach(async () => {
    setup = await freshStore();
  });
  afterEach(async () => {
    await setup.store.close();
  });

  it('emits a valid metadata-only receipt when content is absent (recordOutputs disabled)', async () => {
    // When the user disables recordOutputs, the callback still fires (verified) but content is
    // absent. content_captured must be false, and the receipt must still be valid + useful.
    const tel = receiptaTelemetry({
      store: setup.store,
      signer: setup.kp,
      actor: { type: 'agent', id: 'a' },
      captureMode: 'metadata_only',
    });
    tel.onLanguageModelCallEnd!({
      callId: 'call-002',
      model: 'claude-3-5-sonnet',
      provider: 'anthropic',
      finishReason: 'stop',
      usage: { promptTokens: 8, completionTokens: 4 },
      // content deliberately absent (recordOutputs=false)
    });
    await tel.flush();
    await setup.store.close();

    const report = await verifyStore(setup.dir, setup.keyDir);
    expect(report.ok).toBe(true); // the receipt is still valid (signs over metadata)
    const r = report.receipts[0]!;
    expect(r.body.content_captured).toBe(false);
    expect(r.body.capture_mode).toBe('metadata_only');
    expect(r.body.content).toBeUndefined();
    expect(r.body.content_commitments).toBeUndefined();
    // Metadata still present and useful.
    expect(r.body.model).toBe('claude-3-5-sonnet');
    expect(r.body.usage).toEqual({ input_tokens: 8, output_tokens: 4 });
  });

  it('also sets content_captured=false when captureMode is full but content is absent (honest flag)', async () => {
    // Even in full mode, if the callback delivers no content (recordOutputs off), content_captured
    // is false — the verifier is never misled into thinking content was captured (S1.3).
    const tel = receiptaTelemetry({
      store: setup.store,
      signer: setup.kp,
      actor: { type: 'agent', id: 'a' },
      captureMode: 'full',
    });
    tel.onLanguageModelCallEnd!({ model: 'm', finishReason: 'stop', content: undefined });
    await tel.flush();
    await setup.store.close();

    const report = await verifyStore(setup.dir, setup.keyDir);
    expect(report.receipts[0]!.body.content_captured).toBe(false);
  });
});

describe('receiptaTelemetry — error outcome + emission isolation (S2.1)', () => {
  it("records an error outcome when finishReason is 'error'", async () => {
    const setup = await freshStore();
    const tel = receiptaTelemetry({
      store: setup.store,
      signer: setup.kp,
      actor: { type: 'agent', id: 'a' },
    });
    tel.onLanguageModelCallEnd!({ model: 'm', finishReason: 'error', content: undefined });
    await tel.flush();
    await setup.store.close();

    const report = await verifyStore(setup.dir, setup.keyDir);
    expect(report.receipts[0]!.body.outcome).toBe('error');
  });

  it('does NOT throw into the SDK when emission fails (the callback runs in dispatch, S2.1)', async () => {
    const setup = await freshStore();
    const errors: string[] = [];
    const tel = receiptaTelemetry({
      store: setup.store,
      // A signer that throws forces emission failure.
      signer: {
        keyId: 'x',
        privateKey: undefined as never,
        publicKey: undefined as never,
      } as never,
      actor: { type: 'agent', id: 'a' },
      logError: (m) => errors.push(m),
    });
    // The callback must not throw — it returns normally.
    expect(() =>
      tel.onLanguageModelCallEnd!({ model: 'm', content: 'x', finishReason: 'stop' }),
    ).not.toThrow();
    await tel.flush();
    expect(errors.some((m) => m.includes('failed to append receipt'))).toBe(true);
    await setup.store.close();
  });
});

describe('receiptaTelemetryV6 — v6 shim', () => {
  it('maps the v6 onFinish callback to the v7 onLanguageModelCallEnd receipt', async () => {
    const setup = await freshStore();
    const v6 = receiptaTelemetryV6({
      store: setup.store,
      signer: setup.kp,
      actor: { type: 'agent', id: 'a' },
    });
    expect(v6.name).toBe('receipta');
    expect(v6.onFinish).toBeTypeOf('function');

    // Fire the v6 callback; it should produce the same receipt shape as v7.
    v6.onFinish!({
      finishReason: 'stop',
      usage: { promptTokens: 3, completionTokens: 2 },
      text: 'v6 assembled answer',
      response: { id: 'resp-v6-1' },
      model: 'gpt-4o',
    });
    await v6.flush!();
    await setup.store.close();

    const report = await verifyStore(setup.dir, setup.keyDir);
    expect(report.ok).toBe(true);
    const r = report.receipts[0]!;
    expect(r.body.model).toBe('gpt-4o');
    expect(r.body.usage).toEqual({ input_tokens: 3, output_tokens: 2 });
    expect(r.body.content_captured).toBe(true);
    expect(r.body.content?.response).toBe('v6 assembled answer');
  });
});

describe('receiptaTelemetry — flush() drains pending receipts (the fire-and-forget race fix, F-2)', () => {
  it('flush() ensures the receipt is durable before the store closes', async () => {
    const setup = await freshStore();
    const tel = receiptaTelemetry({
      store: setup.store,
      signer: setup.kp,
      actor: { type: 'agent', id: 'a' },
    });
    tel.onLanguageModelCallEnd!({ model: 'gpt-4o', content: 'drained', finishReason: 'stop' });
    // Without flush, closing here could lose the receipt (the append is in-flight). With flush,
    // we block until it lands.
    await tel.flush();
    await setup.store.close();

    const report = await verifyStore(setup.dir, setup.keyDir);
    expect(report.ok).toBe(true);
    expect(report.receipts).toHaveLength(1);
    expect(report.receipts[0]!.body.content?.response).toBe('drained');
  });

  it('flush() preserves emission-order even when multiple calls fire in quick succession', async () => {
    const setup = await freshStore();
    const tel = receiptaTelemetry({
      store: setup.store,
      signer: setup.kp,
      actor: { type: 'agent', id: 'a' },
    });
    // Fire three callbacks back-to-back (the SDK may call them in sequence without awaiting).
    tel.onLanguageModelCallEnd!({ model: 'm', content: 'first', finishReason: 'stop' });
    tel.onLanguageModelCallEnd!({ model: 'm', content: 'second', finishReason: 'stop' });
    tel.onLanguageModelCallEnd!({ model: 'm', content: 'third', finishReason: 'stop' });
    await tel.flush();
    await setup.store.close();

    const report = await verifyStore(setup.dir, setup.keyDir);
    expect(report.receipts).toHaveLength(3);
    // The chained emit preserves call order (seq 1, 2, 3).
    expect(report.receipts.map((r) => r.body.content?.response)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});
