import { describe, it, expect, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import {
  openStore,
  appendBody,
  generateKeyPair,
  exportPublicKey,
  writeTrustedKey,
  sign,
} from "@receipta/core";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
// The built CLI is at packages/cli/dist/cli.js; run it via node.
const CLI_PATH = path.resolve(__dirname, "..", "dist", "cli.js");
const TMP = path.join(process.cwd(), ".vitest-tmp", "cli");

/** Run the CLI with args; returns { stdout, stderr, exitCode }. */
function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_PATH, ...args], { cwd: process.cwd() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
  });
}

/** Build a demo store with N receipts + a matching trust root; returns the paths. */
async function buildDemoStore(n: number): Promise<{ dir: string; logPath: string; keyDir: string; kp: ReturnType<typeof generateKeyPair> }> {
  const dir = path.join(TMP, `cli-${Math.random().toString(36).slice(2)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const kp = generateKeyPair();
  const keyDir = path.join(dir, "keys");
  await writeTrustedKey(keyDir, kp.keyId, exportPublicKey(kp.publicKey));

  const store = await openStore(path.join(dir, "log.receipta"));
  const signer = { keyId: kp.keyId, sign: (c: string) => sign(Buffer.from(c, "utf8"), kp.privateKey) };
  for (let i = 0; i < n; i++) {
    await appendBody(
      store,
      {
        timestamp: { iso8601_ms: "2026-07-10T08:06:00.000Z", trust_level: "local_asserted" },
        actor: { type: "service", id: "app" },
        provider: "openai",
        model: "gpt-4o",
        request_id: `req-${i}`,
        outcome: "success",
        content_captured: true,
        capture_mode: "full",
        content: { request: { prompt: `q${i}` }, response: { text: `a${i}` } },
        usage: { input_tokens: 5, output_tokens: 3 },
      },
      signer,
    );
  }
  await store.close();
  return { dir, logPath: path.join(dir, "log.receipta"), keyDir, kp };
}

describe("CLI — verify (S4.1)", () => {
  beforeEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    await mkdir(TMP, { recursive: true });
  });

  it("exits 0 on a fully valid chain", async () => {
    const { logPath, keyDir } = await buildDemoStore(3);
    const res = await runCli(["verify", logPath, "--trust-root", keyDir]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("valid");
    expect(res.stdout).toContain("3 receipt");
  });

  it("exits non-zero and names the divergence on a tampered chain (S4.1)", async () => {
    const { logPath, keyDir } = await buildDemoStore(3);
    // Tamper: mutate receipt #2's content on disk.
    const buf = await readFile(logPath);
    const records: unknown[] = [];
    let off = 0;
    while (off < buf.length) {
      const len = buf.readUInt32BE(off);
      records.push(JSON.parse(buf.subarray(off + 4, off + 4 + len).toString("utf8")));
      off += 4 + len + 1;
    }
    (records[1] as { body: { content: { response: { text: string } } } }).body.content.response.text = "TAMPERED";
    const frames = records.map((r) => {
      const bytes = Buffer.from(JSON.stringify(r), "utf8");
      const f = Buffer.alloc(4 + bytes.length + 1);
      f.writeUInt32BE(bytes.length, 0);
      bytes.copy(f, 4);
      f[f.length - 1] = 0x0a;
      return f;
    });
    await writeFile(logPath, Buffer.concat(frames));

    const res = await runCli(["verify", logPath, "--trust-root", keyDir]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout).toContain("divergence");
    expect(res.stdout).toContain("seq=2");
    expect(res.stdout).toContain("tamper");
  });

  it("fails loud (exit 2) when the trust root is missing (S4.2)", async () => {
    const { logPath, dir } = await buildDemoStore(2);
    const missingRoot = path.join(dir, "does-not-exist");
    const res = await runCli(["verify", logPath, "--trust-root", missingRoot]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("trust root");
  });

  it("json format emits a machine-readable report", async () => {
    const { logPath, keyDir } = await buildDemoStore(2);
    const res = await runCli(["verify", logPath, "--trust-root", keyDir, "--format", "json"]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.verifiedCount).toBe(2);
  });
});

describe("CLI — export (S4.3)", () => {
  beforeEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    await mkdir(TMP, { recursive: true });
  });

  it("exports JSON without re-signing (S4.3)", async () => {
    const { logPath } = await buildDemoStore(3);
    const res = await runCli(["export", logPath, "--format", "json"]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].body.provider).toBe("openai");
  });

  it("exports CSV with a header row + one row per receipt", async () => {
    const { logPath } = await buildDemoStore(2);
    const res = await runCli(["export", logPath, "--format", "csv"]);
    expect(res.exitCode).toBe(0);
    const lines = res.stdout.trim().split("\n");
    expect(lines[0]).toContain("seq,chain_id,timestamp");
    expect(lines.length).toBe(3); // header + 2 rows
    expect(lines[1]).toContain("openai");
  });

  it("exports OCSF (API Activity class uid 6003)", async () => {
    const { logPath } = await buildDemoStore(1);
    const res = await runCli(["export", logPath, "--format", "ocsf"]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed[0].class_uid).toBe(6003);
    expect(parsed[0].api.service.name).toBe("openai");
    expect(parsed[0].actor.uid).toBe("app");
  });

  it("--out writes to a file", async () => {
    const { logPath, dir } = await buildDemoStore(2);
    const outFile = path.join(dir, "export.json");
    const res = await runCli(["export", logPath, "--format", "json", "--out", outFile]);
    expect(res.exitCode).toBe(0);
    const written = await readFile(outFile, "utf8");
    expect(JSON.parse(written)).toHaveLength(2);
  });

  it("export does not alter the store (S4.3)", async () => {
    const { logPath, keyDir } = await buildDemoStore(2);
    const before = await readFile(logPath);
    await runCli(["export", logPath, "--format", "json"]);
    const after = await readFile(logPath);
    expect(Buffer.from(before).equals(Buffer.from(after))).toBe(true);
    // And the store still verifies.
    const res = await runCli(["verify", logPath, "--trust-root", keyDir]);
    expect(res.exitCode).toBe(0);
  });
});

describe("CLI — key gen", () => {
  beforeEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    await mkdir(TMP, { recursive: true });
  });

  it("generates a key pair, writes the .pub file, and prints the fingerprint", async () => {
    const outDir = path.join(TMP, "genkeys");
    const res = await runCli(["key", "gen", "--out", outDir]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("key_id");
    expect(res.stdout).toContain("fingerprint");
    // Exactly one .pub file written.
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(outDir);
    const pubFiles = files.filter((f) => f.endsWith(".pub"));
    expect(pubFiles).toHaveLength(1);
    // The filename (minus .pub) equals the key_id printed.
    const keyId = pubFiles[0]!.slice(0, -4);
    expect(res.stdout).toContain(keyId);
  });
});

describe("CLI — help + unknown commands", () => {
  it("prints help with no args (exit 0)", async () => {
    const res = await runCli([]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Usage");
  });

  it("exits 1 on an unknown command", async () => {
    const res = await runCli(["frobnicate"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("unknown command");
  });
});
