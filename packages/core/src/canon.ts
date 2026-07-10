/**
 * RFC 8785 (JSON Canonicalization Scheme, "JCS") — vendored, dependency-free implementation.
 *
 * WHY THIS EXISTS — see IMPLICIT_SPEC S1.1 and PLAN D2.
 * Receipts are signed over their canonical bytes, and verified by re-canonicalizing. Two
 * independent serializations of the same logical receipt MUST produce byte-identical pre-signature
 * input. Bare `JSON.stringify` does NOT satisfy this:
 *   1. Number `-0`: `JSON.stringify(-0)` → `"0"`, but RFC 8785 requires `"-0"`.
 *   2. Key ordering: `JSON.stringify` preserves insertion order; RFC 8785 requires UTF-16 code-unit
 *      sort. `{"b":1,"a":2}` must serialize as `{"a":2,"b":1}`.
 *   3. Lone surrogates: bare stringify emits them raw; RFC 8785 escapes them as `\uXXXX`.
 *
 * `1e21` and `1.0` etc. are NOT divergences — `JSON.stringify` already matches ECMAScript's
 * number-to-string (which RFC 8785 §3.2.2.3 delegates to), so `"1e+21"` and `"1"` are correct and
 * we reuse the engine's serialization for those.
 *
 * Reference: https://www.rfc-editor.org/rfc/rfc8785 (Appendix B holds the test vectors).
 *
 * SECURITY: this file is part of the trust foundation (the signed bytes). It is deliberately
 * self-contained and free of runtime dependencies (PLAN S5.2). Do not change the serialization
 * without updating the byte-exact test vectors in canon.test.ts.
 */

/**
 * Serialize a JSON-compatible value to its RFC 8785 canonical string.
 *
 * @throws {TypeError} on values that have no JSON representation (`undefined`, `NaN`, `Infinity`,
 *   `bigint`, symbols, functions). Surrogates in strings are escaped, never emitted raw.
 */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  serializeValue(value, out);
  return out.join("");
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function serializeValue(value: unknown, out: string[]): void {
  switch (typeof value) {
    case "object":
      if (value === null) {
        out.push("null");
        return;
      }
      if (Array.isArray(value)) {
        serializeArray(value as Json[], out);
        return;
      }
      serializeObject(value as Record<string, Json>, out);
      return;
    case "string":
      out.push(serializeString(value));
      return;
    case "number":
      out.push(serializeNumber(value));
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    default:
      // undefined, bigint, symbol, function
      throw new TypeError(
        `canonicalize: value of type ${typeof value} has no JSON representation`,
      );
  }
}

/** RFC 8785 §3.2.2.3 — number serialization, delegating to ECMAScript with `-0` correction. */
function serializeNumber(value: number): string {
  if (Number.isNaN(value)) {
    throw new TypeError("canonicalize: NaN is not serializable (RFC 8785 §3.2.2.3)");
  }
  if (!Number.isFinite(value)) {
    throw new TypeError(
      `canonicalize: ${value > 0 ? "Infinity" : "-Infinity"} is not serializable (RFC 8785 §3.2.2.3)`,
    );
  }
  // ECMAScript's number-to-string already matches RFC 8785 for the common cases (integers,
  // decimals, and the scientific form e.g. 1e21 → "1e+21"). The ONE divergence is -0:
  // `String(-0)` === "0", but RFC 8785 requires "-0".
  if (Object.is(value, -0)) {
    return "-0";
  }
  return String(value);
}

/**
 * RFC 8785 §3.2.2.2 — string serialization.
 * Control chars (< 0x20), the quote, and the backslash are escaped. Lone (unpaired) surrogates
 * must be escaped as `\uXXXX`; in JSON.stringify they are emitted raw, which is non-portable.
 */
function serializeString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const cp = value.charCodeAt(i);
    if (cp === 0x22) {
      out += '\\"';
      continue;
    }
    if (cp === 0x5c) {
      out += "\\\\";
      continue;
    }
    if (cp < 0x20) {
      out += controlEscape(cp);
      continue;
    }
    // High surrogate without a following low surrogate, or a low surrogate not preceded by a
    // high surrogate → a "lone surrogate". RFC 8785 escapes it as \uXXXX rather than emitting
    // it raw (which would produce invalid UTF-8 downstream).
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // valid surrogate pair — emit both code units as-is (the JS string already holds them)
        out += value[i]! + value[i + 1]!;
        i++;
      } else {
        out += "\\u" + hex4(cp);
      }
      continue;
    }
    if (cp >= 0xdc00 && cp <= 0xdfff) {
      out += "\\u" + hex4(cp);
      continue;
    }
    out += value[i]!;
  }
  out += '"';
  return out;
}

/** RFC 8785 §3.2.2.2 — the mandatory control-character escapes. */
function controlEscape(cp: number): string {
  switch (cp) {
    case 0x08:
      return "\\b";
    case 0x09:
      return "\\t";
    case 0x0a:
      return "\\n";
    case 0x0c:
      return "\\f";
    case 0x0d:
      return "\\r";
    default:
      return "\\u" + hex4(cp);
  }
}

function hex4(cp: number): string {
  return cp.toString(16).padStart(4, "0").toLowerCase();
}

/** RFC 8785 §3.2.3 — object members sorted by UTF-16 code unit of the member name. */
function serializeObject(obj: Record<string, Json>, out: string[]): void {
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    out.push("{}");
    return;
  }
  keys.sort(compareKeysUtf16);
  out.push("{");
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (i > 0) out.push(",");
    out.push(serializeString(key));
    out.push(":");
    serializeValue(obj[key], out);
  }
  out.push("}");
}

function serializeArray(arr: Json[], out: string[]): void {
  if (arr.length === 0) {
    out.push("[]");
    return;
  }
  out.push("[");
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) out.push(",");
    serializeValue(arr[i], out);
  }
  out.push("]");
}

/**
 * Compare two member names by UTF-16 code unit (RFC 8785 §3.2.3). This is *not* a locale string
 * comparison — `String.prototype.localeCompare` is locale-dependent and would break determinism.
 * A plain `<`/`>` on JS strings compares by UTF-16 code unit, which is exactly what RFC 8785
 * specifies, but we implement it explicitly so the intent is unambiguous and testable.
 */
export function compareKeysUtf16(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ac = a.charCodeAt(i);
    const bc = b.charCodeAt(i);
    if (ac !== bc) return ac - bc;
  }
  return a.length - b.length;
}
