/**
 * Receipt schema — the TypeScript types for a receipta receipt, plus the canonical-signing helper.
 *
 * Field set per PLAN §Phase 1 (`src/schema.ts`) and the IMPLICIT_SPEC invariants (each field's
 * reason is noted in comments and surfaced in the docs schema reference). The signed bytes are the
 * RFC 8785 canonicalization of the receipt MINUS the signature envelope — see `canonicalForSigning`.
 */
import { canonicalize } from "./canon.js";
import { sha256, toHex } from "./crypto.js";

/** Every receipt self-identifies its schema version (PLAN D7, S1.8). */
export const SCHEMA_VERSION = "receipta.v0" as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

/** v0.1 signature suite. The field exists to permit ML-DSA / FIPS-provider suites later (S1.8). */
export type SignatureSuite = "ed25519" | (string & {}); // open for future suites

/**
 * Trust level of a timestamp/anchor (S1.7). v0.1 only ever populates `local_asserted`; the enum
 * is complete so a receipt is never silently presented as more trustworthy than it is.
 */
export type TrustLevel = "local_asserted" | "rfc3161" | "transparency_log" | "witness";

/** What was captured for this call (S1.3). A verifier must not be misled about content presence. */
export type ContentCaptureMode = "full" | "metadata_only";

/** ISO-8601 UTC millisecond timestamp carrying its own trust level (S1.7). */
export interface ReceiptTimestamp {
  /** ISO-8601, millisecond precision, UTC (e.g. "2026-07-10T08:06:00.123Z"). */
  iso8601_ms: string;
  trust_level: TrustLevel;
}

/** Who/what made the decision — distinct from the signing key (S3.2). */
export interface Actor {
  /** "human" | "service" | "agent" — the class of actor. */
  type: "human" | "service" | "agent";
  /** Stable identifier (user id, service name, agent id). */
  id: string;
  /** Optional human-readable label. */
  label?: string;
}

/** Privacy commitments over content — keyed HMAC, not bare digest (PLAN D10, S1.4). */
export interface ContentCommitments {
  /** HMAC-SHA256(commitment_key, request_content), hex. Over the captured request body. */
  request?: string;
  /** HMAC-SHA256(commitment_key, response_content), hex. Over the assembled response. */
  response?: string;
  /** sha256(request_content), hex — present only when content is captured, so a verifier can
   * re-check integrity against the embedded bytes. (Commitment is keyed/private; this is the
   * unkeyed integrity digest.) */
  request_integrity?: string;
  response_integrity?: string;
}

/** Captured content (S1.3). Absent when `content_captured` is false (metadata-only receipts). */
export interface CapturedContent {
  /** The request body sent to the provider (e.g. messages, model, params). */
  request?: JsonValue;
  /** The assembled response (the final message, not intermediate chunks — PLAN D8). */
  response?: JsonValue;
}

/** Token usage for the call (auditor reconstruction, Seam 5 req 2). */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  /** Some providers report a separate cached/reasoning count. */
  cached_input_tokens?: number;
  reasoning_tokens?: number;
}

/**
 * A reserved anchoring slot (S1.6). v0.1 leaves this absent; the field existing means a future
 * release can add RFC 3161 / transparency-log / witness anchors without a schema break.
 */
export interface Anchor {
  type: "rfc3161" | "transparency_log" | "witness";
  trust_level: TrustLevel;
  /** Opaque, suite-specific anchor data (a TSA token, an inclusion proof, a witness co-sig). */
  data: JsonValue;
}

/**
 * Extension field (S1.8). Unknown fields with `critical: true` MUST fail verification — a
 * non-critical unknown is ignored (forward-compat for e.g. future anchor fields).
 */
export interface ExtensionField {
  critical: boolean;
  value: JsonValue;
}

/** A null/boolean/number/string/array/object JSON value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/**
 * The receipt body — everything that is part of the signed payload. Order of fields here defines
 * the *logical* receipt; the canonical form re-sorts keys per RFC 8785.
 */
export interface ReceiptBody {
  schema_version: SchemaVersion;
  suite: SignatureSuite;
  chain_id: string;
  seq: number;
  /** Hex of sha256(canon(prev receipt body)) — all-zero hex for seq 0 (the chain root). */
  prev_hash: string;
  key_id: string;
  timestamp: ReceiptTimestamp;
  actor: Actor;
  provider: string;
  model: string;
  request_id?: string;
  attempt_index?: number;
  /** "success" | "error" | "retry" — was the call successful, errored, or a retry attempt (S2.2). */
  outcome: "success" | "error" | "retry";
  content_captured: boolean;
  capture_mode: ContentCaptureMode;
  content?: CapturedContent;
  content_commitments?: ContentCommitments;
  usage?: Usage;
  anchor?: Anchor;
  extensions?: Record<string, ExtensionField>;
}

/**
 * A sealed receipt: body + the detached signature over the canonical body bytes.
 * `signature` is the Ed25519 signature, hex-encoded.
 */
export interface Receipt {
  body: ReceiptBody;
  signature: string;
}

/** The all-zero hash used as `prev_hash` for the chain root (seq 0). */
export const ZERO_HASH = toHex(new Uint8Array(32));

/**
 * Produce the exact pre-signature bytes for a receipt body: the RFC 8785 canonical JSON of the body.
 * `signature` is NEVER part of the signed bytes (it is a detached signature over these bytes).
 */
export function canonicalForSigning(body: ReceiptBody): string {
  return canonicalize(body as unknown as JsonValue);
}

/** SHA-256 (hex) of a receipt body's canonical bytes — used to compute the next `prev_hash`. */
export function receiptBodyHash(body: ReceiptBody): string {
  return toHex(sha256(Buffer.from(canonicalForSigning(body), "utf8")));
}
