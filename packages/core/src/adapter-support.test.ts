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
  keyPairToSigner,
  createReceiptFetch,
  type FetchLike,
  type ReceiptStore,
  type ProviderAdapter,
} from './index.js';

const TMP = path.join(process.cwd(), '.vitest-tmp', 'core-adapter');

/** A minimal provider whose outcomeFromStatus is status-only (the body-aware layer is in core). */
const statusOnlyProvider: ProviderAdapter = {
  provider: 'test',
  requestIdHeaders: ['x-request-id'],
  extractUsage: () => undefined,
  extractModel: () => 'test-model',
  outcomeFromStatus: (status) => (status >= 200 && status < 300 ? 'success' : 'error'),
};

async function freshStore() {
  const dir = path.join(TMP, `s-${Math.random().toString(36).slice(2)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const store = await openStore(path.join(dir, 'log.receipta'));
  const kp = generateKeyPair();
  const keyDir = path.join(dir, 'keys');
  await writeTrustedKey(keyDir, kp.keyId, exportPublicKey(kp.publicKey));
  return { store, keyDir, kp };
}

/** Drive one response through the wrapper and return the recorded outcome. */
async function recordOutcome(
  store: ReceiptStore,
  kp: ReturnType<typeof generateKeyPair>,
  keyDir: string,
  response: { status: number; body: string; headers?: Record<string, string> },
): Promise<string> {
  const baseFetch: FetchLike = async () =>
    new Response(response.body, {
      status: response.status,
      headers: response.headers ?? { 'content-type': 'application/json', 'x-request-id': 'r-1' },
    });
  const wrappedFetch = createReceiptFetch(
    statusOnlyProvider,
    { store, signer: keyPairToSigner(kp), actor: { type: 'service', id: 'app' } },
    baseFetch,
  );
  await wrappedFetch('https://example.test/v1/chat', {
    method: 'POST',
    body: JSON.stringify({ model: 'test-model', messages: [] }),
  });
  await store.close();
  const root = await loadTrustRoot(keyDir);
  const report = await verifyChain(store.path, resolverFromTrustRoot(root));
  return report.receipts[0]!.body.outcome;
}

describe('body-aware outcome (G4) — bodyHasError branches via createReceiptFetch', () => {
  let setup: Awaited<ReturnType<typeof freshStore>>;
  beforeEach(async () => {
    setup = await freshStore();
  });
  afterEach(async () => {
    await setup.store.close();
  });

  it('a 2xx body with a top-level error object → outcome error (G4.1)', async () => {
    const outcome = await recordOutcome(setup.store, setup.kp, setup.keyDir, {
      status: 200,
      body: JSON.stringify({ error: { message: 'soft fail', type: 'gateway_error' } }),
    });
    expect(outcome).toBe('error');
  });

  it('a 2xx body with NO top-level error → outcome success (G4.2)', async () => {
    const outcome = await recordOutcome(setup.store, setup.kp, setup.keyDir, {
      status: 200,
      body: JSON.stringify({ choices: [], id: 'ok' }),
    });
    expect(outcome).toBe('success');
  });

  it('a 2xx body that is a JSON ARRAY (not object) → outcome success (G4.2)', async () => {
    const outcome = await recordOutcome(setup.store, setup.kp, setup.keyDir, {
      status: 200,
      body: JSON.stringify([{ not: 'an object with error' }]),
    });
    expect(outcome).toBe('success');
  });

  it('a 2xx body that is malformed/non-JSON → outcome success (G4.2)', async () => {
    const outcome = await recordOutcome(setup.store, setup.kp, setup.keyDir, {
      status: 200,
      body: '<html>not json</html>',
      headers: { 'content-type': 'text/html', 'x-request-id': 'r-1' },
    });
    expect(outcome).toBe('success');
  });

  it('a 2xx body whose error field is null/absent → outcome success (G4.2)', async () => {
    const outcome = await recordOutcome(setup.store, setup.kp, setup.keyDir, {
      status: 200,
      body: JSON.stringify({ error: null, data: 'fine' }),
    });
    expect(outcome).toBe('success');
  });

  it('a non-2xx status keeps outcome error regardless of body (no regression)', async () => {
    const outcome = await recordOutcome(setup.store, setup.kp, setup.keyDir, {
      status: 500,
      body: JSON.stringify({ error: { message: 'real error' } }),
    });
    expect(outcome).toBe('error');
  });
});
