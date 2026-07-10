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
import { anthropicProvider, withReceipts } from "./index.js";

const TMP = path.join(process.cwd(), ".vitest-tmp", "anthropic");

/** A recorded Anthropic Messages response body. */
const MESSAGE_BODY = {
  id: "msg_test_001",
  type: "message",
  role: "assistant",
  model: "claude-3-5-sonnet-20241022",
  content: [{ type: "text", text: "Hello! How can I assist you today?" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 15, output_tokens: 9 },
};

function makeMockFetch(opts: {
  status?: number;
  body?: unknown;
  requestIdHeader?: string;
} = {}): { fetch: FetchLike; calls: Array<{ url: unknown; init?: RequestInit }> } {
  const status = opts.status ?? 200;
  const body = opts.body ?? MESSAGE_BODY;
  const header = opts.requestIdHeader ?? "request-id";
  const calls: Array<{ url: unknown; init?: RequestInit }> = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: input, init });
    const headers = new Headers({ "content-type": "application/json" });
    headers.set(header, "req-anthropic-789");
    return new Response(JSON.stringify(body), { status, headers });
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

describe("anthropicProvider — provider adapter", () => {
  it("extracts usage from a Message body (input_tokens/output_tokens)", () => {
    expect(anthropicProvider.extractUsage(MESSAGE_BODY)).toEqual({ input_tokens: 15, output_tokens: 9 });
  });

  it("extracts the model from a Message body", () => {
    expect(anthropicProvider.extractModel(MESSAGE_BODY)).toBe("claude-3-5-sonnet-20241022");
  });

  it("returns undefined usage when the body has none", () => {
    expect(anthropicProvider.extractUsage({ id: "x" })).toBeUndefined();
  });

  it("classifies 2xx as success and others as error", () => {
    expect(anthropicProvider.outcomeFromStatus(200)).toBe("success");
    expect(anthropicProvider.outcomeFromStatus(529)).toBe("error"); // Anthropic overloaded
  });
});

describe("anthropic adapter — non-interference (S2.1)", () => {
  let setup: Awaited<ReturnType<typeof freshStore>>;

  beforeEach(async () => {
    setup = await freshStore();
  });
  afterEach(async () => {
    await setup.store.close();
  });

  it("returns the SAME response body to the caller as the unwrapped fetch would", async () => {
    const { fetch: unwrappedMock } = makeMockFetch();
    const unwrappedRes = await unwrappedMock("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", messages: [{ role: "user", content: "hi" }] }),
    });
    const unwrappedText = await unwrappedRes.text();

    const { fetch: wrappedMock } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      anthropicProvider,
      { store: setup.store, signer: keyPairToSigner(setup.kp), actor: { type: "service", id: "app" } },
      wrappedMock,
    );
    const wrappedRes = await wrappedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", messages: [{ role: "user", content: "hi" }] }),
    });
    const wrappedText = await wrappedRes.text();

    expect(wrappedText).toBe(unwrappedText);
    expect(JSON.parse(wrappedText)).toEqual(MESSAGE_BODY);
  });

  it("the response is still consumable AFTER the wrapper reads it (S2.1)", async () => {
    const { fetch: mockFetch } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      anthropicProvider,
      { store: setup.store, signer: keyPairToSigner(setup.kp), actor: { type: "service", id: "app" } },
      mockFetch,
    );
    const res = await wrappedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", messages: [] }),
    });
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(MESSAGE_BODY);
  });
});

describe("anthropic adapter — receipt emission", () => {
  let setup: Awaited<ReturnType<typeof freshStore>>;

  beforeEach(async () => {
    setup = await freshStore();
  });
  afterEach(async () => {
    await setup.store.close();
  });

  it("emits a receipt with correct Anthropic fields (provider, model, usage, request_id)", async () => {
    const { fetch: mockFetch } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      anthropicProvider,
      { store: setup.store, signer: keyPairToSigner(setup.kp), actor: { type: "service", id: "app" } },
      mockFetch,
    );
    await wrappedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", messages: [{ role: "user", content: "hi" }] }),
    });
    await setup.store.close();

    const report = await verifyStore(path.dirname(setup.store.path), setup.keyDir);
    expect(report.ok).toBe(true);
    const r = report.receipts[0]!;
    expect(r.body.provider).toBe("anthropic");
    expect(r.body.model).toBe("claude-3-5-sonnet-20241022");
    expect(r.body.request_id).toBe("req-anthropic-789");
    expect(r.body.usage).toEqual({ input_tokens: 15, output_tokens: 9 }); // Anthropic's spelling
    expect(r.body.outcome).toBe("success");
    expect(r.body.content_captured).toBe(true);
  });

  it("reads the request id from the `request-id` header (Anthropic), not x-request-id", async () => {
    const { fetch: mockFetch } = makeMockFetch({ requestIdHeader: "request-id" });
    const wrappedFetch = createReceiptFetch(
      anthropicProvider,
      { store: setup.store, signer: keyPairToSigner(setup.kp), actor: { type: "service", id: "app" } },
      mockFetch,
    );
    await wrappedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", messages: [] }),
    });
    await setup.store.close();

    const report = await verifyStore(path.dirname(setup.store.path), setup.keyDir);
    expect(report.receipts[0]!.body.request_id).toBe("req-anthropic-789");
  });

  it("emits a metadata-only receipt when captureMode is metadata_only (S1.3)", async () => {
    const { fetch: mockFetch } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      anthropicProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: "service", id: "app" },
        captureMode: "metadata_only",
      },
      mockFetch,
    );
    await wrappedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", messages: [{ role: "user", content: "secret" }] }),
    });
    await setup.store.close();

    const report = await verifyStore(path.dirname(setup.store.path), setup.keyDir);
    const r = report.receipts[0]!;
    expect(r.body.content_captured).toBe(false);
    expect(r.body.content).toBeUndefined();
    expect(r.body.usage).toEqual({ input_tokens: 15, output_tokens: 9 });
  });

  it("records an error outcome when the API returns a non-2xx (S2.2)", async () => {
    const { fetch: mockFetch } = makeMockFetch({
      status: 529,
      body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    });
    const wrappedFetch = createReceiptFetch(
      anthropicProvider,
      { store: setup.store, signer: keyPairToSigner(setup.kp), actor: { type: "service", id: "app" } },
      mockFetch,
    );
    const res = await wrappedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", messages: [] }),
    });
    await setup.store.close();
    expect(res.status).toBe(529);
    const report = await verifyStore(path.dirname(setup.store.path), setup.keyDir);
    expect(report.receipts[0]!.body.outcome).toBe("error");
  });
});

describe("anthropic adapter — emission error isolation (S2.1)", () => {
  it("does NOT fail the wrapped call when receipt emission throws", async () => {
    const { store } = await freshStore();
    const throwingSigner = { keyId: "x", sign: () => { throw new Error("key unavailable"); } };
    const errors: string[] = [];
    const { fetch: mockFetch } = makeMockFetch();
    const wrappedFetch = createReceiptFetch(
      anthropicProvider,
      { store, signer: throwingSigner, actor: { type: "service", id: "app" }, logError: (m) => errors.push(m) },
      mockFetch,
    );
    const res = await wrappedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual(MESSAGE_BODY);
    expect(errors.some((m) => m.includes("failed to append receipt"))).toBe(true);
    await store.close();
  });
});

describe("anthropic adapter — withReceipts constructor wrapping", () => {
  it("injects a fetch into the constructed Anthropic client", async () => {
    const { store, kp } = await freshStore();
    const { fetch: mockFetch } = makeMockFetch();
    let receivedFetch: unknown = null;
    class FakeAnthropic {
      constructor(opts: Record<string, unknown>) {
        receivedFetch = opts.fetch;
      }
    }
    const client = withReceipts(FakeAnthropic, { apiKey: "sk-ant-test" }, {
      store,
      signer: kp,
      actor: { type: "service", id: "app" },
    });
    expect(client).toBeInstanceOf(FakeAnthropic);
    expect(receivedFetch).toBeTypeOf("function");
    expect(receivedFetch).not.toBe(mockFetch);
    await store.close();
  });
});
