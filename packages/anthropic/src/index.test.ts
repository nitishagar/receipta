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
import {
  anthropicThinkingToolStreaming,
  anthropicNoUsageStreaming,
  anthropicRedactedStreaming,
  anthropicStreamingFixtures,
} from "./fixtures/index.js";

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
    // S1.3: the receipt MUST remain valid when content is absent (only commitments + metadata).
    expect(report.ok).toBe(true);
    const r = report.receipts[0]!;
    expect(r.body.content_captured).toBe(false);
    expect(r.body.capture_mode).toBe("metadata_only");
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

describe("anthropic adapter — streaming assembly (D8, S2.5)", () => {
  let setup: Awaited<ReturnType<typeof freshStore>>;

  beforeEach(async () => {
    setup = await freshStore();
  });
  afterEach(async () => {
    await setup.store.close();
  });

  it("assembles the final Message from buffered SSE events and commits over IT", async () => {
    // Anthropic streams event-typed chunks: message_start, content_block_delta, message_delta.
    const sseBody = [
      'data: {"type":"message_start","message":{"id":"msg_s","model":"claude-3-5-sonnet-20241022","usage":{"input_tokens":6}}}',
      "",
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}',
      "",
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world!"}}',
      "",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
      "",
    ].join("\n");
    const streamFetch: FetchLike = async () => {
      const headers = new Headers({ "content-type": "text/event-stream" });
      headers.set("request-id", "req-anthropic-stream");
      return new Response(sseBody, { status: 200, headers });
    };
    const wrappedFetch = createReceiptFetch(
      anthropicProvider,
      { store: setup.store, signer: keyPairToSigner(setup.kp), actor: { type: "service", id: "app" } },
      streamFetch,
    );
    await wrappedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", messages: [], stream: true }),
    });
    await setup.store.close();

    const report = await verifyStore(path.dirname(setup.store.path), setup.keyDir);
    const r = report.receipts[0]!;
    // Assembled content = concatenation of text deltas.
    const content = r.body.content?.response as { content: Array<{ text: string }> };
    expect(content.content[0].text).toBe("Hello world!");
    expect(r.body.usage).toEqual({ input_tokens: 6, output_tokens: 4 });
    expect(r.body.model).toBe("claude-3-5-sonnet-20241022");
    expect(r.body.request_id).toBe("req-anthropic-stream");
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

// ---------------------------------------------------------------------------
// Gateway fidelity — recorded-trace corpus (G1–G6), TDD red in Phase 1.
// ---------------------------------------------------------------------------

/** Build a mock fetch that replays a recorded-trace fixture's raw bytes + full header map. */
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
  fixture: { streaming?: boolean; sseText?: string; body?: unknown; headers: Record<string, string>; status?: number },
  store: ReceiptStore,
  kp: ReturnType<typeof generateKeyPair>,
  keyDir: string,
) {
  const { fetch: traceFetch } = makeTraceFetch(fixture);
  const wrappedFetch = createReceiptFetch(
    anthropicProvider,
    { store, signer: keyPairToSigner(kp), actor: { type: "service", id: "app" } },
    traceFetch,
  );
  const reqBody = fixture.streaming
    ? { model: "claude-3-5-sonnet-20241022", messages: [], stream: true }
    : { model: "claude-3-5-sonnet-20241022", messages: [] };
  await wrappedFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: JSON.stringify(reqBody),
  });
  await store.close();
  const root = await loadTrustRoot(keyDir);
  const report = await verifyChain(store.path, resolverFromTrustRoot(root));
  return report.receipts[0]!;
}

describe("anthropic gateway fidelity — request_id via override (G1.2)", () => {
  it("request_id captured from an alternate header via override", async () => {
    const setup = await freshStore();
    const { fetch: traceFetch } = makeTraceFetch({
      streaming: true,
      sseText: anthropicNoUsageStreaming.sseText,
      headers: { "content-type": "text/event-stream", "x-bedrock-request-id": "bedrock-req-42" },
    });
    const wrappedFetch = createReceiptFetch(
      anthropicProvider,
      {
        store: setup.store,
        signer: keyPairToSigner(setup.kp),
        actor: { type: "service", id: "app" },
        provider: { requestIdHeaders: ["x-bedrock-request-id", ...anthropicProvider.requestIdHeaders] },
      },
      traceFetch,
    );
    await wrappedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", messages: [], stream: true }),
    });
    await setup.store.close();
    const root = await loadTrustRoot(setup.keyDir);
    const report = await verifyChain(setup.store.path, resolverFromTrustRoot(root));
    // FAILS today: no provider override seam. Phase 2 adds it.
    expect(report.receipts[0]!.body.request_id).toBe("bedrock-req-42");
  });
});

describe("anthropic gateway fidelity — assembler completeness (G2.2)", () => {
  it("assembles thinking + text + tool_use blocks in order from deltas", async () => {
    const setup = await freshStore();
    const r = await driveFixture(anthropicThinkingToolStreaming, setup.store, setup.kp, setup.keyDir);
    const content = r.body.content?.response as { content: Array<Record<string, unknown>> };
    const blocks = content.content;
    // FAILS today: only text_delta is read; thinking/input_json_delta are dropped.
    expect(blocks.map((b) => b.type)).toEqual(anthropicThinkingToolStreaming.expect.blockTypes);
    const thinking = blocks.find((b) => b.type === "thinking") as Record<string, unknown> | undefined;
    expect(thinking?.thinking).toBe(anthropicThinkingToolStreaming.expect.thinkingText);
    const text = blocks.find((b) => b.type === "text") as Record<string, unknown> | undefined;
    expect(text?.text).toBe(anthropicThinkingToolStreaming.expect.textText);
    const toolUse = blocks.find((b) => b.type === "tool_use") as Record<string, unknown> | undefined;
    expect(toolUse?.id).toBe(anthropicThinkingToolStreaming.expect.toolUse.id);
    expect(toolUse?.name).toBe(anthropicThinkingToolStreaming.expect.toolUse.name);
    expect(toolUse?.input).toEqual(anthropicThinkingToolStreaming.expect.toolUse.input);
  });

  it("assembles redacted_thinking blocks in order with their data (G2.2)", async () => {
    const setup = await freshStore();
    const r = await driveFixture(anthropicRedactedStreaming, setup.store, setup.kp, setup.keyDir);
    const content = r.body.content?.response as { content: Array<Record<string, unknown>> };
    const blocks = content.content;
    // G2.2 block ordering: redacted_thinking first, then text.
    expect(blocks.map((b) => b.type)).toEqual(anthropicRedactedStreaming.expect.blockTypes);
    const redacted = blocks.find((b) => b.type === "redacted_thinking") as Record<string, unknown> | undefined;
    // The redacted `data` must survive into the assembled block.
    expect(redacted?.data).toBe(anthropicRedactedStreaming.expect.redactedData);
    const text = blocks.find((b) => b.type === "text") as Record<string, unknown> | undefined;
    expect(text?.text).toBe(anthropicRedactedStreaming.expect.textText);
  });
});

describe("anthropic gateway fidelity — honest usage absence (G3.1)", () => {
  it("usage is undefined when no usage events are sent (not fabricated 0/0)", async () => {
    const setup = await freshStore();
    const r = await driveFixture(anthropicNoUsageStreaming, setup.store, setup.kp, setup.keyDir);
    // FAILS today: Anthropic fabricates usage:{input_tokens:0,output_tokens:0}. Phase 4 fixes it.
    expect(r.body.usage).toBeUndefined();
  });
});

describe("anthropic gateway fidelity — fidelity property (G6.3)", () => {
  // Every distinct delta `type` in the fixture's content_block_delta events MUST be represented
  // in the assembled body. Allowlist is empty after Phase 3. During Phase 1 (red) this fails for
  // any fixture whose deltas include a type the assembler drops today (thinking/input_json).
  const KNOWN_DROPPED: ReadonlySet<string> = new Set<string>([]);

  it.each(anthropicStreamingFixtures.map((f) => [f.name, f] as const))(
    "every delta type in %s is represented in the assembled body",
    async (_name, fixture) => {
      const setup = await freshStore();
      const r = await driveFixture(fixture, setup.store, setup.kp, setup.keyDir);
      const assembled = r.body.content?.response as Record<string, unknown> | undefined;
      const assembledStr = JSON.stringify(assembled ?? {});
      const deltaTypes = collectDeltaTypes(fixture.sseText!);
      const unrepresented: string[] = [];
      for (const dt of deltaTypes) {
        if (KNOWN_DROPPED.has(dt)) continue;
        if (!isDeltaTypeRepresented(dt, assembledStr)) unrepresented.push(dt);
      }
      expect(unrepresented).toEqual([]);
    },
  );
});

/** Collect every distinct `delta.type` across the fixture's content_block_delta events. */
function collectDeltaTypes(sseText: string): string[] {
  const types = new Set<string>();
  for (const line of sseText.split("\n")) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>;
      if (obj.type === "content_block_delta") {
        const delta = obj.delta as Record<string, unknown> | undefined;
        if (delta && typeof delta.type === "string") types.add(delta.type);
      }
    } catch {
      // skip unparseable
    }
  }
  return [...types];
}

/** Is a given Anthropic delta type represented in the assembled body? */
function isDeltaTypeRepresented(deltaType: string, assembledStr: string): boolean {
  switch (deltaType) {
    case "text_delta":
      // text block always present in the assembled content array.
      return assembledStr.includes('"type":"text"');
    case "thinking_delta":
      return assembledStr.includes('"type":"thinking"');
    case "redacted_thinking_delta":
      // represented as a redacted_thinking block in the assembled content array.
      return assembledStr.includes('"type":"redacted_thinking"');
    case "input_json_delta":
      // represented as a tool_use block with parsed input.
      return assembledStr.includes('"type":"tool_use"');
    default:
      return assembledStr.includes(deltaType);
  }
}
