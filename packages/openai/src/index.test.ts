import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir } from "node:fs/promises";
import * as path from "node:path";
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
} from "@receipta/core";
import { openaiProvider, withReceipts } from "./index.js";

const TMP = path.join(process.cwd(), ".vitest-tmp", "openai");

/** A recorded OpenAI ChatCompletion response body. */
const CHAT_COMPLETION_BODY = {
  id: "chatcmpl-test-123",
  object: "chat.completion",
  created: 1720000000,
  model: "gpt-4o-2024-08-06",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello! How can I help?" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
};

/** Build a mock fetch that returns a recorded response, recording the calls it receives. */
function makeMockFetch(opts: {
  status?: number;
  body?: unknown;
  requestIdHeader?: string;
  delayMs?: number;
} = {}): { fetch: FetchLike; calls: Array<{ url: unknown; init?: RequestInit }> } {
  const status = opts.status ?? 200;
  const body = opts.body ?? CHAT_COMPLETION_BODY;
  const header = opts.requestIdHeader ?? "x-request-id";
  const calls: Array<{ url: unknown; init?: RequestInit }> = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: input, init });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const bodyText = JSON.stringify(body);
    const headers = new Headers({ "content-type": "application/json" });
    headers.set(header, "req-test-456");
    return new Response(bodyText, { status, headers });
  };
  return { fetch, calls };
}

async function freshStore(): Promise<{ store: ReceiptStore; keyDir: string; kp: ReturnType<typeof generateKeyPair> }> {
  const dir = path.join(TMP, `s-${Math.random().toString(36).slice(2)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const store = await openStore(path.join(dir, "log.receipta"));
  const kp = generateKeyPair();
  const keyDir = path.join(dir, "keys");
  await writeTrustedKey(keyDir, kp.keyId, exportPublicKey(kp.publicKey));
  return { store, keyDir, kp };
}

async function verifyStore(dir: string, keyDir: string) {
  const root = await loadTrustRoot(keyDir);
  return verifyChain(path.join(dir, "log.receipta"), resolverFromTrustRoot(root));
}

describe("openaiProvider — provider adapter", () => {
  it("extracts usage from a ChatCompletion body (prompt_tokens/completion_tokens)", () => {
    const usage = openaiProvider.extractUsage(CHAT_COMPLETION_BODY);
    expect(usage).toEqual({ input_tokens: 12, output_tokens: 7 });
  });

  it("extracts the model from a ChatCompletion body", () => {
    expect(openaiProvider.extractModel(CHAT_COMPLETION_BODY)).toBe("gpt-4o-2024-08-06");
  });

  it("returns undefined usage when the body has none", () => {
    expect(openaiProvider.extractUsage({ id: "x" })).toBeUndefined();
  });

  it("classifies 2xx as success and others as error", () => {
    expect(openaiProvider.outcomeFromStatus(200)).toBe("success");
    expect(openaiProvider.outcomeFromStatus(429)).toBe("error");
    expect(openaiProvider.outcomeFromStatus(500)).toBe("error");
  });
});

describe("createReceiptFetch — non-interference (S2.1)", () => {
  let setup: Awaited<ReturnType<typeof freshStore>>;

  beforeEach(async () => {
    setup = await freshStore();
  });
  afterEach(async () => {
    await setup.store.close();
  });

  it("returns the SAME response body to the caller as the unwrapped fetch would (S2.1)", async () => {
    const { fetch: mockFetch } = makeMockFetch();

    // Unwrapped: what the caller would normally see.
    const unwrappedRes = await mockFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    const unwrappedText = await unwrappedRes.text();

    // Wrapped: what receipta returns.
    const { fetch: mockFetch2 } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      { store: setup.store, signer: keyPairToSigner(setup.kp), actor: { type: "service", id: "app" } },
      mockFetch2,
    );
    const wrappedRes = await wrappedFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    const wrappedText = await wrappedRes.text();

    // The body the caller sees must be byte-identical (non-interference).
    expect(wrappedText).toBe(unwrappedText);
    expect(JSON.parse(wrappedText)).toEqual(CHAT_COMPLETION_BODY);
  });

  it("the response is still consumable AFTER the wrapper reads it (clone-then-read, S2.1)", async () => {
    const { fetch: mockFetch } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      { store: setup.store, signer: keyPairToSigner(setup.kp), actor: { type: "service", id: "app" } },
      mockFetch,
    );
    const res = await wrappedFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    });
    // The SDK would call res.text()/res.json() — it must work on the original.
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(CHAT_COMPLETION_BODY);
  });
});

describe("createReceiptFetch — receipt emission", () => {
  let setup: Awaited<ReturnType<typeof freshStore>>;

  beforeEach(async () => {
    setup = await freshStore();
  });
  afterEach(async () => {
    await setup.store.close();
  });

  it("emits a receipt with correct fields (provider, model, usage, request_id, outcome)", async () => {
    const { fetch: mockFetch } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      { store: setup.store, signer: keyPairToSigner(setup.kp), actor: { type: "service", id: "app", label: "my-app" } },
      mockFetch,
    );
    await wrappedFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    await setup.store.close();

    const report = await verifyStore(path.dirname(setup.store.path), setup.keyDir);
    expect(report.ok).toBe(true);
    expect(report.receipts).toHaveLength(1);
    const r = report.receipts[0]!;
    expect(r.body.provider).toBe("openai");
    expect(r.body.model).toBe("gpt-4o-2024-08-06"); // from the response body
    expect(r.body.request_id).toBe("req-test-456");
    expect(r.body.outcome).toBe("success");
    expect(r.body.usage).toEqual({ input_tokens: 12, output_tokens: 7 });
    expect(r.body.content_captured).toBe(true);
    expect(r.body.actor).toEqual({ type: "service", id: "app", label: "my-app" });
  });

  it("captures request + response content when captureMode is full", async () => {
    const { fetch: mockFetch } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: "service", id: "app" },
        captureMode: "full",
      },
      mockFetch,
    );
    await wrappedFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "secret-prompt" }] }),
    });
    await setup.store.close();

    const report = await verifyStore(path.dirname(setup.store.path), setup.keyDir);
    const r = report.receipts[0]!;
    expect(r.body.content_captured).toBe(true);
    expect(r.body.content?.request).toEqual({
      model: "gpt-4o",
      messages: [{ role: "user", content: "secret-prompt" }],
    });
    expect(r.body.content?.response).toEqual(CHAT_COMPLETION_BODY);
    // Privacy commitments present (HMAC, D10) — keyed, not bare.
    expect(r.body.content_commitments?.request).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.content_commitments?.response).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.content_commitments?.request_integrity).toMatch(/^[0-9a-f]{64}$/);
  });

  it("emits a metadata-only receipt when captureMode is metadata_only (S1.3)", async () => {
    const { fetch: mockFetch } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: "service", id: "app" },
        captureMode: "metadata_only",
      },
      mockFetch,
    );
    await wrappedFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "secret" }] }),
    });
    await setup.store.close();

    const report = await verifyStore(path.dirname(setup.store.path), setup.keyDir);
    const r = report.receipts[0]!;
    expect(r.body.content_captured).toBe(false);
    expect(r.body.capture_mode).toBe("metadata_only");
    expect(r.body.content).toBeUndefined();
    // Metadata still present.
    expect(r.body.model).toBe("gpt-4o-2024-08-06");
    expect(r.body.usage).toEqual({ input_tokens: 12, output_tokens: 7 });
  });

  it("records an error outcome receipt when the API returns a non-2xx (S2.2)", async () => {
    const { fetch: mockFetch } = makeMockFetch({
      status: 429,
      body: { error: { message: "rate limited", type: "rate_limit_exceeded" } },
    });
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      { store: setup.store, signer: keyPairToSigner(setup.kp), actor: { type: "service", id: "app" } },
      mockFetch,
    );
    const res = await wrappedFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    });
    await setup.store.close();

    expect(res.status).toBe(429); // the error status passes through unchanged (non-interference)
    const report = await verifyStore(path.dirname(setup.store.path), setup.keyDir);
    const r = report.receipts[0]!;
    expect(r.body.outcome).toBe("error");
  });

  it("emits one receipt PER fetch invocation (per-attempt attribution, S2.2)", async () => {
    const { fetch: mockFetch } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      { store: setup.store, signer: keyPairToSigner(setup.kp), actor: { type: "service", id: "app" } },
      mockFetch,
    );
    // Simulate two attempts (e.g. an original + a retry) by calling twice.
    for (let i = 0; i < 2; i++) {
      await wrappedFetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
      });
    }
    await setup.store.close();

    const report = await verifyStore(path.dirname(setup.store.path), setup.keyDir);
    expect(report.receipts).toHaveLength(2); // one per attempt
    expect(report.receipts.map((r) => r.body.seq)).toEqual([1, 2]);
  });
});

describe("createReceiptFetch — streaming assembly (D8, S2.5)", () => {
  let setup: Awaited<ReturnType<typeof freshStore>>;

  beforeEach(async () => {
    setup = await freshStore();
  });
  afterEach(async () => {
    await setup.store.close();
  });

  it("assembles the final message from buffered SSE chunks and commits over IT, not raw chunks", async () => {
    // A streaming response: three SSE data chunks whose deltas concatenate to "Hello there!".
    const sseBody = [
      'data: {"id":"chatcmpl-s","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
      "",
      'data: {"id":"chatcmpl-s","model":"gpt-4o","choices":[{"index":0,"delta":{"content":" there!"},"finish_reason":null}]}',
      "",
      'data: {"id":"chatcmpl-s","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const streamFetch: FetchLike = async () => {
      const headers = new Headers({ "content-type": "text/event-stream" });
      headers.set("x-request-id", "req-stream-1");
      return new Response(sseBody, { status: 200, headers });
    };
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      { store: setup.store, signer: keyPairToSigner(setup.kp), actor: { type: "service", id: "app" } },
      streamFetch,
    );
    await wrappedFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", messages: [], stream: true }),
    });
    await setup.store.close();

    const report = await verifyStore(path.dirname(setup.store.path), setup.keyDir);
    const r = report.receipts[0]!;
    // The assembled content is the CONCATENATION of deltas — "Hello there!" — not raw chunks.
    expect((r.body.content?.response as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toBe("Hello there!");
    // Usage extracted from the final chunk (stream_options.include_usage).
    expect(r.body.usage).toEqual({ input_tokens: 4, output_tokens: 3 });
    expect(r.body.outcome).toBe("success");
    // The commitment is over the assembled message bytes (deterministic regardless of chunking).
    expect(r.body.content_commitments?.response).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the streaming response is still consumable by the SDK after the wrapper reads the clone (S2.1)", async () => {
    const sseBody = 'data: {"id":"x","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const streamFetch: FetchLike = async () =>
      new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      { store: setup.store, signer: keyPairToSigner(setup.kp), actor: { type: "service", id: "app" } },
      streamFetch,
    );
    const res = await wrappedFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", messages: [], stream: true }),
    });
    // The SDK consumes the original stream normally.
    const text = await res.text();
    expect(text).toBe(sseBody);
  });
});

describe("createReceiptFetch — emission error isolation (S2.1)", () => {
  it("does NOT fail the wrapped call when receipt emission throws", async () => {
    const { store } = await freshStore();
    // A signer that throws forces a genuine emission failure (the append path signs the body).
    const throwingSigner = {
      keyId: "throwing-signer",
      sign: () => {
        throw new Error("signing key unavailable");
      },
    };

    const errors: string[] = [];
    const { fetch: mockFetch } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      {
        store,
        signer: throwingSigner,
        actor: { type: "service", id: "app" },
        logError: (msg) => errors.push(msg),
      },
      mockFetch,
    );

    // The call must succeed despite the emission failing.
    const res = await wrappedFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual(CHAT_COMPLETION_BODY);
    // The emission error was logged, not thrown into the call (S2.1).
    expect(errors.some((m) => m.includes("failed to append receipt"))).toBe(true);
    await store.close();
  });

  it("re-throws network errors (fetch itself failed) — they are the SDK's to handle", async () => {
    const { store, kp } = await freshStore();
    const failingFetch: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const wrappedFetch = createReceiptFetch(
      openaiProvider,
      { store, signer: keyPairToSigner(kp), actor: { type: "service", id: "app" } },
      failingFetch,
    );
    await expect(
      wrappedFetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
      }),
    ).rejects.toThrow("ECONNREFUSED");
    await store.close();
  });
});

describe("withReceipts — constructor wrapping", () => {
  it("injects a fetch into the constructed client", async () => {
    const { store, kp } = await freshStore();
    const { fetch: mockFetch } = makeMockFetch();

    // A minimal fake "OpenAI" constructor that records the fetch it received.
    let receivedFetch: unknown = null;
    class FakeOpenAI {
      constructor(opts: Record<string, unknown>) {
        receivedFetch = opts.fetch;
      }
    }

    const client = withReceipts(FakeOpenAI, { apiKey: "sk-test" }, {
      store,
      signer: kp,
      actor: { type: "service", id: "app" },
    });
    expect(client).toBeInstanceOf(FakeOpenAI);
    expect(receivedFetch).toBeTypeOf("function");
    // The injected fetch is a receipt-emitting wrapper, not the raw mock.
    expect(receivedFetch).not.toBe(mockFetch);
    await store.close();
  });
});
