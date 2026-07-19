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
  type FetchLike,
  createReceiptFetch,
  keyPairToSigner,
} from '@receipta/core';
import { openaiProvider, withReceipts } from './index.js';
import {
  nvidiaGlm52Streaming,
  nvidiaLlamaStreaming,
  openaiReasoningToolStreaming,
  openaiNoUsageStreaming,
  openai2xxBodyError,
  openaiLegacyFnMultichoiceStreaming,
  openaiStreamingFixtures,
} from './fixtures/index.js';

const TMP = path.join(process.cwd(), '.vitest-tmp', 'openai');

/** A recorded OpenAI ChatCompletion response body. */
const CHAT_COMPLETION_BODY = {
  id: 'chatcmpl-test-123',
  object: 'chat.completion',
  created: 1720000000,
  model: 'gpt-4o-2024-08-06',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Hello! How can I help?' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
};

/** Build a mock fetch that returns a recorded response, recording the calls it receives. */
function makeMockFetch(
  opts: {
    status?: number;
    body?: unknown;
    requestIdHeader?: string;
    delayMs?: number;
  } = {},
): { fetch: FetchLike; calls: Array<{ url: unknown; init?: RequestInit }> } {
  const status = opts.status ?? 200;
  const body = opts.body ?? CHAT_COMPLETION_BODY;
  const header = opts.requestIdHeader ?? 'x-request-id';
  const calls: Array<{ url: unknown; init?: RequestInit }> = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: input, init });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const bodyText = JSON.stringify(body);
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.set(header, 'req-test-456');
    return new Response(bodyText, { status, headers });
  };
  return { fetch, calls };
}

async function freshStore(): Promise<{
  store: ReceiptStore;
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
  return { store, keyDir, kp };
}

async function verifyStore(dir: string, keyDir: string) {
  const root = await loadTrustRoot(keyDir);
  return verifyChain(path.join(dir, 'log.receipta'), resolverFromTrustRoot(root));
}

describe('openaiProvider — provider adapter', () => {
  it('extracts usage from a ChatCompletion body (prompt_tokens/completion_tokens)', () => {
    const usage = openaiProvider.extractUsage(CHAT_COMPLETION_BODY);
    expect(usage).toEqual({ input_tokens: 12, output_tokens: 7 });
  });

  it('extracts the model from a ChatCompletion body', () => {
    expect(openaiProvider.extractModel(CHAT_COMPLETION_BODY)).toBe('gpt-4o-2024-08-06');
  });

  it('returns undefined usage when the body has none', () => {
    expect(openaiProvider.extractUsage({ id: 'x' })).toBeUndefined();
  });

  it('classifies 2xx as success and others as error', () => {
    expect(openaiProvider.outcomeFromStatus(200)).toBe('success');
    expect(openaiProvider.outcomeFromStatus(429)).toBe('error');
    expect(openaiProvider.outcomeFromStatus(500)).toBe('error');
  });
});

describe('createReceiptFetch — non-interference (S2.1)', () => {
  let setup: Awaited<ReturnType<typeof freshStore>>;

  beforeEach(async () => {
    setup = await freshStore();
  });
  afterEach(async () => {
    await setup.store.close();
  });

  it('returns the SAME response body to the caller as the unwrapped fetch would (S2.1)', async () => {
    const { fetch: mockFetch } = makeMockFetch();

    // Unwrapped: what the caller would normally see.
    const unwrappedRes = await mockFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const unwrappedText = await unwrappedRes.text();

    // Wrapped: what receipta returns.
    const { fetch: mockFetch2 } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: 'service', id: 'app' },
      },
      mockFetch2,
    );
    const wrappedRes = await wrappedFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const wrappedText = await wrappedRes.text();

    // The body the caller sees must be byte-identical (non-interference).
    expect(wrappedText).toBe(unwrappedText);
    expect(JSON.parse(wrappedText)).toEqual(CHAT_COMPLETION_BODY);
  });

  it('the response is still consumable AFTER the wrapper reads it (clone-then-read, S2.1)', async () => {
    const { fetch: mockFetch } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: 'service', id: 'app' },
      },
      mockFetch,
    );
    const res = await wrappedFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    // The SDK would call res.text()/res.json() — it must work on the original.
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(CHAT_COMPLETION_BODY);
  });
});

describe('createReceiptFetch — receipt emission', () => {
  let setup: Awaited<ReturnType<typeof freshStore>>;

  beforeEach(async () => {
    setup = await freshStore();
  });
  afterEach(async () => {
    await setup.store.close();
  });

  it('emits a receipt with correct fields (provider, model, usage, request_id, outcome)', async () => {
    const { fetch: mockFetch } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: 'service', id: 'app', label: 'my-app' },
      },
      mockFetch,
    );
    await wrappedFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await setup.store.close();

    const report = await verifyStore(path.dirname(setup.store.path), setup.keyDir);
    expect(report.ok).toBe(true);
    expect(report.receipts).toHaveLength(1);
    const r = report.receipts[0]!;
    expect(r.body.provider).toBe('openai');
    expect(r.body.model).toBe('gpt-4o-2024-08-06'); // from the response body
    expect(r.body.request_id).toBe('req-test-456');
    expect(r.body.outcome).toBe('success');
    expect(r.body.usage).toEqual({ input_tokens: 12, output_tokens: 7 });
    expect(r.body.content_captured).toBe(true);
    expect(r.body.actor).toEqual({ type: 'service', id: 'app', label: 'my-app' });
  });

  it('captures request + response content when captureMode is full', async () => {
    const { fetch: mockFetch } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: 'service', id: 'app' },
        captureMode: 'full',
      },
      mockFetch,
    );
    await wrappedFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'secret-prompt' }],
      }),
    });
    await setup.store.close();

    const report = await verifyStore(path.dirname(setup.store.path), setup.keyDir);
    const r = report.receipts[0]!;
    expect(r.body.content_captured).toBe(true);
    expect(r.body.content?.request).toEqual({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'secret-prompt' }],
    });
    expect(r.body.content?.response).toEqual(CHAT_COMPLETION_BODY);
    // Privacy commitments present (HMAC, D10) — keyed, not bare.
    expect(r.body.content_commitments?.request).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.content_commitments?.response).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.content_commitments?.request_integrity).toMatch(/^[0-9a-f]{64}$/);
  });

  it('emits a metadata-only receipt when captureMode is metadata_only (S1.3)', async () => {
    const { fetch: mockFetch } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: 'service', id: 'app' },
        captureMode: 'metadata_only',
      },
      mockFetch,
    );
    await wrappedFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'secret' }] }),
    });
    await setup.store.close();

    const report = await verifyStore(path.dirname(setup.store.path), setup.keyDir);
    // S1.3: the receipt MUST remain valid when content is absent (only commitments + metadata).
    expect(report.ok).toBe(true);
    const r = report.receipts[0]!;
    expect(r.body.content_captured).toBe(false);
    expect(r.body.capture_mode).toBe('metadata_only');
    expect(r.body.content).toBeUndefined();
    // Metadata still present.
    expect(r.body.model).toBe('gpt-4o-2024-08-06');
    expect(r.body.usage).toEqual({ input_tokens: 12, output_tokens: 7 });
  });

  it('records an error outcome receipt when the API returns a non-2xx (S2.2)', async () => {
    const { fetch: mockFetch } = makeMockFetch({
      status: 429,
      body: { error: { message: 'rate limited', type: 'rate_limit_exceeded' } },
    });
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: 'service', id: 'app' },
      },
      mockFetch,
    );
    const res = await wrappedFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    await setup.store.close();

    expect(res.status).toBe(429); // the error status passes through unchanged (non-interference)
    const report = await verifyStore(path.dirname(setup.store.path), setup.keyDir);
    const r = report.receipts[0]!;
    expect(r.body.outcome).toBe('error');
  });

  it('emits one receipt PER fetch invocation (per-attempt attribution, S2.2)', async () => {
    const { fetch: mockFetch } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: 'service', id: 'app' },
      },
      mockFetch,
    );
    // Simulate two attempts (e.g. an original + a retry) by calling twice.
    for (let i = 0; i < 2; i++) {
      await wrappedFetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
      });
    }
    await setup.store.close();

    const report = await verifyStore(path.dirname(setup.store.path), setup.keyDir);
    expect(report.receipts).toHaveLength(2); // one per attempt
    expect(report.receipts.map((r) => r.body.seq)).toEqual([1, 2]);
  });
});

describe('createReceiptFetch — streaming assembly (D8, S2.5)', () => {
  let setup: Awaited<ReturnType<typeof freshStore>>;

  beforeEach(async () => {
    setup = await freshStore();
  });
  afterEach(async () => {
    await setup.store.close();
  });

  it('assembles the final message from buffered SSE chunks and commits over IT, not raw chunks', async () => {
    // A streaming response: three SSE data chunks whose deltas concatenate to "Hello there!".
    const sseBody = [
      'data: {"id":"chatcmpl-s","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-s","model":"gpt-4o","choices":[{"index":0,"delta":{"content":" there!"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-s","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const streamFetch: FetchLike = async () => {
      const headers = new Headers({ 'content-type': 'text/event-stream' });
      headers.set('x-request-id', 'req-stream-1');
      return new Response(sseBody, { status: 200, headers });
    };
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: 'service', id: 'app' },
      },
      streamFetch,
    );
    await wrappedFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', messages: [], stream: true }),
    });
    await setup.store.close();

    const report = await verifyStore(path.dirname(setup.store.path), setup.keyDir);
    const r = report.receipts[0]!;
    // The assembled content is the CONCATENATION of deltas — "Hello there!" — not raw chunks.
    expect(
      (r.body.content?.response as { choices: Array<{ message: { content: string } }> }).choices[0]
        .message.content,
    ).toBe('Hello there!');
    // Usage extracted from the final chunk (stream_options.include_usage).
    expect(r.body.usage).toEqual({ input_tokens: 4, output_tokens: 3 });
    expect(r.body.outcome).toBe('success');
    // The commitment is over the assembled message bytes (deterministic regardless of chunking).
    expect(r.body.content_commitments?.response).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the streaming response is still consumable by the SDK after the wrapper reads the clone (S2.1)', async () => {
    const sseBody =
      'data: {"id":"x","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const streamFetch: FetchLike = async () =>
      new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: 'service', id: 'app' },
      },
      streamFetch,
    );
    const res = await wrappedFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', messages: [], stream: true }),
    });
    // The SDK consumes the original stream normally.
    const text = await res.text();
    expect(text).toBe(sseBody);
  });
});

describe('createReceiptFetch — emission error isolation (S2.1)', () => {
  it('does NOT fail the wrapped call when receipt emission throws', async () => {
    const { store } = await freshStore();
    // A signer that throws forces a genuine emission failure (the append path signs the body).
    const throwingSigner = {
      keyId: 'throwing-signer',
      sign: () => {
        throw new Error('signing key unavailable');
      },
    };

    const errors: string[] = [];
    const { fetch: mockFetch } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      {
        store,
        signer: throwingSigner,
        actor: { type: 'service', id: 'app' },
        logError: (msg) => errors.push(msg),
      },
      mockFetch,
    );

    // The call must succeed despite the emission failing.
    const res = await wrappedFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual(CHAT_COMPLETION_BODY);
    // The emission error was logged, not thrown into the call (S2.1).
    expect(errors.some((m) => m.includes('failed to append receipt'))).toBe(true);
    await store.close();
  });

  it("re-throws network errors (fetch itself failed) — they are the SDK's to handle", async () => {
    const { store, kp } = await freshStore();
    const failingFetch: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      { store, signer: keyPairToSigner(kp), actor: { type: 'service', id: 'app' } },
      failingFetch,
    );
    await expect(
      wrappedFetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
      }),
    ).rejects.toThrow('ECONNREFUSED');
    await store.close();
  });
});

describe('withReceipts — constructor wrapping', () => {
  it('injects a fetch into the constructed client', async () => {
    const { store, kp } = await freshStore();
    const { fetch: mockFetch } = makeMockFetch();

    // A minimal fake "OpenAI" constructor that records the fetch it received.
    let receivedFetch: unknown = null;
    class FakeOpenAI {
      constructor(opts: Record<string, unknown>) {
        receivedFetch = opts.fetch;
      }
    }

    const client = withReceipts(
      FakeOpenAI,
      { apiKey: 'sk-test' },
      {
        store,
        signer: kp,
        actor: { type: 'service', id: 'app' },
      },
    );
    expect(client).toBeInstanceOf(FakeOpenAI);
    expect(receivedFetch).toBeTypeOf('function');
    // The injected fetch is a receipt-emitting wrapper, not the raw mock.
    expect(receivedFetch).not.toBe(mockFetch);
    await store.close();
  });
});

// ---------------------------------------------------------------------------
// Gateway fidelity — recorded-trace corpus (G1–G6), TDD red in Phase 1.
// ---------------------------------------------------------------------------

/**
 * Build a mock fetch that replays a recorded-trace fixture's raw bytes + full header map.
 * Sibling to `makeMockFetch` (kept for back-compat with the canonical tests above).
 */
function makeTraceFetch(fixture: {
  streaming?: boolean;
  sseText?: string;
  body?: unknown;
  headers: Record<string, string>;
  status?: number;
}): { fetch: FetchLike; calls: Array<{ url: unknown; init?: RequestInit }> } {
  const calls: Array<{ url: unknown; init?: RequestInit }> = [];
  const bodyText = fixture.streaming ? fixture.sseText! : JSON.stringify(fixture.body);
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: input, init });
    return new Response(bodyText, { status: fixture.status ?? 200, headers: fixture.headers });
  };
  return { fetch, calls };
}

/** Drive a fixture through createReceiptFetch and return the single emitted receipt. */
async function driveFixture(
  fixture: {
    streaming?: boolean;
    sseText?: string;
    body?: unknown;
    headers: Record<string, string>;
    status?: number;
  },
  store: ReceiptStore,
  kp: ReturnType<typeof generateKeyPair>,
  keyDir: string,
) {
  const { fetch: traceFetch } = makeTraceFetch(fixture);
  const wrappedFetch = createReceiptFetch(
    openaiProvider,
    { store, signer: keyPairToSigner(kp), actor: { type: 'service', id: 'app' } },
    traceFetch,
  );
  const reqBody = fixture.streaming
    ? { model: 'gpt-4o', messages: [], stream: true }
    : { model: 'gpt-4o', messages: [] };
  await wrappedFetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(reqBody),
  });
  await store.close();
  const root = await loadTrustRoot(keyDir);
  const report = await verifyChain(store.path, resolverFromTrustRoot(root));
  return report.receipts[0]!;
}

describe('gateway fidelity — request_id capture across gateways (G1)', () => {
  it('NVIDIA nvcf-reqid header is captured as request_id', async () => {
    const setup = await freshStore();
    const r = await driveFixture(nvidiaGlm52Streaming, setup.store, setup.kp, setup.keyDir);
    // FAILS today: nvcf-reqid not in requestIdHeaders. Phase 2 widens the list.
    expect(r.body.request_id).toBe(nvidiaGlm52Streaming.expect.request_id);
  });

  it('request_id is undefined when no known header is present (negative-space, G1.3)', async () => {
    const setup = await freshStore();
    const { fetch: traceFetch } = makeTraceFetch({
      streaming: true,
      sseText: openaiNoUsageStreaming.sseText,
      // No request-id header at all.
      headers: { 'content-type': 'text/event-stream' },
    });
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: 'service', id: 'app' },
      },
      traceFetch,
    );
    await wrappedFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', messages: [], stream: true }),
    });
    await setup.store.close();
    const root = await loadTrustRoot(setup.keyDir);
    const report = await verifyChain(setup.store.path, resolverFromTrustRoot(root));
    // Honest absence — never fabricated. (Passes today; regression guard.)
    expect(report.receipts[0]!.body.request_id).toBeUndefined();
  });

  it('withReceipts accepts a provider override adding a custom request-id header (G1.2)', async () => {
    const setup = await freshStore();
    const { fetch: traceFetch } = makeTraceFetch({
      streaming: true,
      sseText: openaiNoUsageStreaming.sseText,
      // A gateway header not in the default list.
      headers: { 'content-type': 'text/event-stream', 'x-custom-req-id': 'custom-req-999' },
    });
    // Override the provider via the capture config — no fork, one-line ergonomics preserved.
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: 'service', id: 'app' },
        provider: { requestIdHeaders: ['x-custom-req-id', ...openaiProvider.requestIdHeaders] },
      },
      traceFetch,
    );
    await wrappedFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', messages: [], stream: true }),
    });
    await setup.store.close();
    const root = await loadTrustRoot(setup.keyDir);
    const report = await verifyChain(setup.store.path, resolverFromTrustRoot(root));
    // FAILS today: ReceiptCaptureConfig has no `provider` override seam. Phase 2 adds it.
    expect(report.receipts[0]!.body.request_id).toBe('custom-req-999');
  });
});

describe('gateway fidelity — usage capture (G3)', () => {
  it('captures usage from a final choices:[] usage chunk (NVIDIA llama — regression guard)', async () => {
    const setup = await freshStore();
    const r = await driveFixture(nvidiaLlamaStreaming, setup.store, setup.kp, setup.keyDir);
    // PASSES today (assembler reads usage from any chunk incl. choices:[]). Pins the working case.
    expect(r.body.usage).toEqual(nvidiaLlamaStreaming.expect.usage);
  });

  it('usage is undefined when no usage chunk is sent (honest absence)', async () => {
    const setup = await freshStore();
    const r = await driveFixture(openaiNoUsageStreaming, setup.store, setup.kp, setup.keyDir);
    // OpenAI is already honest. Passes today; regression guard (never fabricate 0/0).
    expect(r.body.usage).toBeUndefined();
  });
});

describe('gateway fidelity — assembler completeness (G2)', () => {
  it('assembles reasoning_content into the message', async () => {
    const setup = await freshStore();
    const r = await driveFixture(nvidiaGlm52Streaming, setup.store, setup.kp, setup.keyDir);
    const msg = (
      r.body.content?.response as { choices: Array<{ message: Record<string, unknown> }> }
    ).choices[0].message;
    // Phase 3: delta.reasoning_content is now concatenated into the assembled message.
    expect(msg.reasoning_content).toBe(nvidiaGlm52Streaming.expect.reasoningContent);
  });

  it('assembles tool_calls from fragmentary deltas by index (lost-update guard)', async () => {
    const setup = await freshStore();
    const r = await driveFixture(openaiReasoningToolStreaming, setup.store, setup.kp, setup.keyDir);
    const msg = (
      r.body.content?.response as { choices: Array<{ message: Record<string, unknown> }> }
    ).choices[0].message;
    // FAILS today: delta.tool_calls is dropped entirely.
    expect(msg.reasoning_content).toBe(openaiReasoningToolStreaming.expect.reasoningContent);
    const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
    expect(toolCalls).toEqual(openaiReasoningToolStreaming.expect.toolCalls);
  });

  it('assembles legacy function_call AND all choices (not only choices[0]) (G2.1)', async () => {
    const setup = await freshStore();
    const r = await driveFixture(
      openaiLegacyFnMultichoiceStreaming,
      setup.store,
      setup.kp,
      setup.keyDir,
    );
    const choices = (
      r.body.content?.response as {
        choices: Array<{ index: number; message: Record<string, unknown>; finish_reason: string }>;
      }
    ).choices;
    // G2.1 "ALL choices, not only choices[0]": two distinct indices assembled.
    expect(choices).toHaveLength(openaiLegacyFnMultichoiceStreaming.expect.choiceCount);
    expect(choices.map((c) => c.index)).toEqual([0, 1]);
    // G2.1 legacy function_call: name set once, arguments concatenated from fragments.
    const choice0 = choices.find((c) => c.index === 0)!;
    expect(choice0.message.function_call).toEqual(
      openaiLegacyFnMultichoiceStreaming.expect.functionCall,
    );
    // The second choice's content + finish_reason survived.
    const choice1 = choices.find((c) => c.index === 1)!;
    expect(choice1.message.content).toBe(openaiLegacyFnMultichoiceStreaming.expect.choice1Content);
    expect(choice1.finish_reason).toBe(
      openaiLegacyFnMultichoiceStreaming.expect.choice1FinishReason,
    );
  });
});

describe('gateway fidelity — body-aware outcome (G4)', () => {
  it('a 2xx response with a top-level error body records outcome error', async () => {
    const setup = await freshStore();
    const r = await driveFixture(openai2xxBodyError, setup.store, setup.kp, setup.keyDir);
    // FAILS today: outcomeFromStatus(200) === "success". Phase 4 inspects the body.
    expect(r.body.outcome).toBe(openai2xxBodyError.expect.outcome);
    expect(r.body.request_id).toBe(openai2xxBodyError.expect.request_id);
  });

  it('a 2xx response with a NON-error JSON body still records outcome success (G4.2)', async () => {
    const setup = await freshStore();
    // A normal success body (no top-level error field) must stay "success".
    const r = await driveFixture(
      {
        streaming: false,
        body: CHAT_COMPLETION_BODY,
        headers: { 'content-type': 'application/json', 'x-request-id': 'ok-1' },
      },
      setup.store,
      setup.kp,
      setup.keyDir,
    );
    expect(r.body.outcome).toBe('success');
  });

  it('a 2xx response with a malformed/non-JSON body keeps status-based outcome (G4.2)', async () => {
    const setup = await freshStore();
    // A non-JSON 2xx body (e.g. an HTML page or truncated text) cannot be parsed, so it cannot be
    // inspected for a top-level error — it MUST default to the status-code outcome (no spurious
    // "error"). Use a raw fetch so the body is genuinely unparseable (not JSON.stringify'd).
    const rawFetch: FetchLike = async () =>
      new Response('<html>not json</html>', {
        status: 200,
        headers: { 'content-type': 'text/html', 'x-request-id': 'malformed-1' },
      });
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: 'service', id: 'app' },
      },
      rawFetch,
    );
    await wrappedFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    await setup.store.close();
    const root = await loadTrustRoot(setup.keyDir);
    const report = await verifyChain(setup.store.path, resolverFromTrustRoot(root));
    expect(report.receipts[0]!.body.outcome).toBe('success');
  });
});

describe('gateway fidelity — fidelity property (G6.3)', () => {
  // For each streaming fixture, every distinct `delta` payload field in the SSE input MUST be
  // represented in the assembled body (or in an explicit allowlist of known-dropped fields).
  // The known-dropped allowlist is EMPTY after Phase 3 completes the assembler. During Phase 1
  // (red), the test fails for any fixture whose deltas include a field the assembler drops today
  // (reasoning_content / tool_calls) — which is exactly the contract being driven.
  const KNOWN_DROPPED: ReadonlySet<string> = new Set<string>([]);

  it.each(openaiStreamingFixtures.map((f) => [f.name, f] as const))(
    'every delta field in %s is represented in the assembled body',
    async (_name, fixture) => {
      const setup = await freshStore();
      const r = await driveFixture(fixture, setup.store, setup.kp, setup.keyDir);
      const assembled = r.body.content?.response as Record<string, unknown> | undefined;
      // Collect every distinct delta field across the fixture's data: payloads.
      const deltaFields = collectDeltaFields(fixture.sseText!);
      // Build a stringified view of the assembled body for representation checks.
      const assembledStr = JSON.stringify(assembled ?? {});
      const unrepresented: string[] = [];
      for (const field of deltaFields) {
        if (KNOWN_DROPPED.has(field)) continue;
        if (!isFieldRepresented(field, assembledStr)) {
          unrepresented.push(field);
        }
      }
      expect(unrepresented).toEqual([]);
    },
  );
});

/** Collect every distinct key appearing in any `delta` object across the fixture's SSE stream. */
function collectDeltaFields(sseText: string): string[] {
  const fields = new Set<string>();
  for (const line of sseText.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>;
      // choice-level deltas (OpenAI): choices[].delta
      if (Array.isArray(obj.choices)) {
        for (const c of obj.choices as Array<Record<string, unknown>>) {
          const delta = c.delta as Record<string, unknown> | undefined;
          if (delta && typeof delta === 'object') {
            for (const k of Object.keys(delta)) fields.add(k);
          }
        }
      }
    } catch {
      // skip unparseable
    }
  }
  return [...fields];
}

/**
 * Is a given OpenAI delta field represented in the assembled body?
 * Maps the stream field name to its assembled representation.
 */
function isFieldRepresented(field: string, assembledStr: string): boolean {
  switch (field) {
    case 'content':
    case 'reasoning_content':
    case 'tool_calls':
    case 'function_call':
      return assembledStr.includes(field);
    case 'role':
      // role is always represented in the assembled message.
      return true;
    default:
      // Any other delta field: require it to appear in the assembled body string.
      return assembledStr.includes(field);
  }
}
