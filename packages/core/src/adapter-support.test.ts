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
  canonicalForSigning,
  type FetchLike,
  type ReceiptStore,
  type ProviderAdapter,
  type ReceiptBody,
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

/**
 * N4 — attempt_index best-effort population from the Stainless retry-count request header.
 *
 * The invariant: `attempt_index` reflects the integer in `x-stainless-retry-count` when the SDK
 * sets it (0 on first attempt, incrementing on retry), and is OMITTED (undefined → dropped by
 * canonicalization) otherwise. Defaulting to 0 would be dishonest — "first attempt" without
 * evidence. These tests drive a real receipt through `createReceiptFetch` and assert the field on
 * the verified receipt body, covering the full N4 matrix from PLAN §Phase 1.
 */
describe('attempt_index (N4) — readAttemptIndex via createReceiptFetch', () => {
  let setup: Awaited<ReturnType<typeof freshStore>>;
  beforeEach(async () => {
    setup = await freshStore();
  });
  afterEach(async () => {
    await setup.store.close();
  });

  /**
   * Drive one request through the wrapper with given request `init.headers` (+ optional provider
   * override) and return the verified receipt body, so each test can assert both presence and
   * absence of `attempt_index`.
   */
  async function recordAttemptIndex(
    requestHeaders: HeadersInit | undefined,
    providerOverride?: Partial<ProviderAdapter>,
  ): Promise<ReceiptBody> {
    const baseFetch: FetchLike = async () =>
      new Response(JSON.stringify({ id: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'r-1' },
      });
    const wrappedFetch = createReceiptFetch(
      statusOnlyProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: 'service', id: 'app' },
        ...(providerOverride ? { provider: providerOverride } : {}),
      },
      baseFetch,
    );
    await wrappedFetch('https://example.test/v1/chat', {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ model: 'test-model', messages: [] }),
    });
    await setup.store.close();
    const root = await loadTrustRoot(setup.keyDir);
    const report = await verifyChain(setup.store.path, resolverFromTrustRoot(root));
    return report.receipts[0]!.body;
  }

  it("'x-stainless-retry-count: 0' → attempt_index 0 (first attempt is a real signal, not omitted)", async () => {
    const body = await recordAttemptIndex(new Headers({ 'x-stainless-retry-count': '0' }));
    expect(body.attempt_index).toBe(0);
  });

  it("'x-stainless-retry-count: 2' → attempt_index 2", async () => {
    const body = await recordAttemptIndex(new Headers({ 'x-stainless-retry-count': '2' }));
    expect(body.attempt_index).toBe(2);
  });

  it('header absent → attempt_index omitted (never fabricated to 0)', async () => {
    const body = await recordAttemptIndex(undefined);
    expect(body.attempt_index).toBeUndefined();
  });

  it("non-numeric 'abc' → attempt_index omitted", async () => {
    const body = await recordAttemptIndex(new Headers({ 'x-stainless-retry-count': 'abc' }));
    expect(body.attempt_index).toBeUndefined();
  });

  it("whitespace ' 2 ' via Record form → attempt_index omitted (regex /\\^d+$/ rejects untrimmed)", async () => {
    // The Record / string[][] forms are NOT HTTP-parsed, so ' 2 ' reaches the regex untrimmed and
    // is correctly rejected. (The Headers form trims OWS per the WHATWG spec — see the next test.)
    const body = await recordAttemptIndex({ 'x-stainless-retry-count': ' 2 ' });
    expect(body.attempt_index).toBeUndefined();
  });

  it("Headers form trims OWS per WHATWG: ' 2 ' → attempt_index 2 (HTTP-correct, not fabrication)", async () => {
    // Headers.get() strips leading/trailing optional whitespace per the fetch spec, so ' 2 ' is the
    // same header as '2' — a real retry-count signal of 2. Returning 2 is honest (N4 guards against
    // claiming an index with NO signal; OWS around a present digit is not "no signal"). This is
    // documented behavior, distinct from the untrimmed Record/Array forms above.
    const body = await recordAttemptIndex(new Headers({ 'x-stainless-retry-count': ' 2 ' }));
    expect(body.attempt_index).toBe(2);
  });

  it("float '2.0' → attempt_index omitted", async () => {
    const body = await recordAttemptIndex(new Headers({ 'x-stainless-retry-count': '2.0' }));
    expect(body.attempt_index).toBeUndefined();
  });

  it('Record<string,string> header form works, case-insensitive', async () => {
    // Mixed-case header name; the default list is lower-case 'x-stainless-retry-count'.
    const body = await recordAttemptIndex({ 'X-Stainless-Retry-Count': '1' });
    expect(body.attempt_index).toBe(1);
  });

  it('string[][] header form works', async () => {
    const body = await recordAttemptIndex([['x-stainless-retry-count', '3']]);
    expect(body.attempt_index).toBe(3);
  });

  it('config.provider.retryCountHeaders override REPLACES the default list (mirrors requestIdHeaders override)', async () => {
    // Default 'x-stainless-retry-count' is set to 5, but the override points at 'x-retries' only —
    // so the default header must be IGNORED and x-retries read instead.
    const body = await recordAttemptIndex(
      {
        'x-stainless-retry-count': '5',
        'x-retries': '7',
      },
      { retryCountHeaders: ['x-retries'] },
    );
    expect(body.attempt_index).toBe(7);
  });

  it("header name not in the list ('x-foo: 5') → attempt_index omitted", async () => {
    const body = await recordAttemptIndex({ 'x-foo': '5' });
    expect(body.attempt_index).toBeUndefined();
  });

  it('fetch THROWS (network error → SDK retry path) — wrapper rejects AND the error-path receipt carries the header-derived attempt_index', async () => {
    // Covers the SECOND call site (adapter-support.ts:158, inside the baseFetch `catch`). This path
    // is disproportionately load-bearing for N4: a retry most often follows a thrown fetch, so the
    // catch-path receipt is the most likely one to carry a non-zero attempt_index. A regression
    // dropping the field here would not turn any other test red.
    const throwingFetch: FetchLike = async () => {
      throw new Error('network down');
    };
    const wrappedFetch = createReceiptFetch(
      statusOnlyProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: 'service', id: 'app' },
      },
      throwingFetch,
    );
    // The wrapper must re-throw the original network error (S2.2) AFTER emitting an error receipt.
    await expect(
      wrappedFetch('https://example.test/v1/chat', {
        method: 'POST',
        headers: new Headers({ 'x-stainless-retry-count': '1' }),
        body: JSON.stringify({ model: 'test-model', messages: [] }),
      }),
    ).rejects.toThrow('network down');
    await setup.store.close();
    const root = await loadTrustRoot(setup.keyDir);
    const report = await verifyChain(setup.store.path, resolverFromTrustRoot(root));
    const receipt = report.receipts[0]!;
    // The error-path receipt carries outcome error + the header-derived retry index.
    expect(receipt.body.outcome).toBe('error');
    expect(receipt.body.attempt_index).toBe(1);
  });

  it('present attempt_index appears in the SIGNED CANONICAL bytes the signature covers', async () => {
    // Defense-in-depth for N4 (paired with the next test): pin that "present" means present in the
    // canonical string the signature covers — so a serialization regression would be caught here.
    const body = await recordAttemptIndex(new Headers({ 'x-stainless-retry-count': '4' }));
    expect(canonicalForSigning(body)).toContain('"attempt_index":4');
  });

  it('omitted attempt_index is absent from the SIGNED CANONICAL bytes, not just undefined on the object', async () => {
    // Defense-in-depth for N4: pin that "omitted" means absent from the canonical string the
    // signature covers, so a future regression that serialized `null`/`0` instead of dropping the
    // key would be caught here even though it might still pass a `.toBeUndefined()` check.
    const body = await recordAttemptIndex(undefined);
    expect(canonicalForSigning(body)).not.toContain('attempt_index');
  });

  it('hostile init.headers (throwing value getter) → wrapper does NOT throw and attempt_index is omitted (S2.1 non-interference)', async () => {
    // Covers the try/catch hardening in readAttemptIndex. The lookup does Object.keys(record).find(
    // predicate-on-key) then reads record[matchedKey]. Put the throwing getter on the MATCHED key's
    // VALUE so the `record[key]` access fires the trap — without the try/catch, that throw escapes
    // synchronously into the wrapped call (S2.1 violation). With it, attempt_index collapses to
    // undefined and the call returns normally.
    const hostile: Record<string, string> = {};
    Object.defineProperty(hostile, 'x-stainless-retry-count', {
      enumerable: true,
      get() {
        throw new Error('hostile value getter');
      },
    });
    const baseFetch: FetchLike = async () =>
      new Response(JSON.stringify({ id: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'r-1' },
      });
    const wrappedFetch = createReceiptFetch(
      statusOnlyProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: 'service', id: 'app' },
      },
      baseFetch,
    );
    // Must NOT reject — the hostile getter is swallowed inside readAttemptIndex's try/catch.
    await wrappedFetch('https://example.test/v1/chat', {
      method: 'POST',
      headers: hostile,
      body: JSON.stringify({ model: 'test-model', messages: [] }),
    });
    await setup.store.close();
    const root = await loadTrustRoot(setup.keyDir);
    const report = await verifyChain(setup.store.path, resolverFromTrustRoot(root));
    // The trap fired during the value read, so attempt_index is honestly absent.
    expect(report.receipts[0]!.body.attempt_index).toBeUndefined();
  });
});
