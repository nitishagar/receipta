import { describe, it, expect } from 'vitest';
import { canonicalize, compareKeysUtf16 } from './canon.js';

/**
 * RFC 8785 canonicalization tests.
 *
 * The byte-exact vectors come from RFC 8785 Appendix B (https://www.rfc-editor.org/rfc/rfc8785#name-example-numbers)
 * and the PLAN's verified-firsthand divergence cases (IMPLICIT_SPEC S1.1). Each case asserts the
 * EXACT canonical string — this is a trust foundation; off-by-one-byte is a verification break.
 */
describe('canonicalize — RFC 8785 §3.2.2.3 number serialization', () => {
  // RFC 8785 Appendix B.1 numbers + ECMAScript delegation sanity cases.
  // These confirm the cases where JSON.stringify already matches RFC 8785.
  const cases: Array<[unknown, string]> = [
    [0, '0'],
    [-0, '-0'], // *** the load-bearing divergence: JSON.stringify(-0) === "0" ***
    [1, '1'],
    [1.0, '1'], // verified firsthand: String(1.0) === "1" — matches RFC 8785
    [10, '10'],
    [1e1, '10'], // verified firsthand: String(1e1) === "10"
    [100, '100'],
    [3.1415926, '3.1415926'],
    [1e21, '1e+21'], // verified firsthand: String(1e21) === "1e+21" — matches RFC 8785 (NOT a divergence)
    [1e-7, '1e-7'],
    [-1, '-1'],
    [-0.5, '-0.5'],
    [9007199254740991, '9007199254740991'], // Number.MAX_SAFE_INTEGER
  ];
  for (const [input, expected] of cases) {
    it(`serializes ${JSON.stringify(input)} → "${expected}"`, () => {
      expect(canonicalize(input)).toBe(expected);
    });
  }

  it('specifically fixes the -0 divergence vs JSON.stringify (S1.1 load-bearing)', () => {
    // JSON.stringify gets this WRONG; canonicalize MUST get it right.
    expect(JSON.stringify(-0)).toBe('0');
    expect(canonicalize(-0)).toBe('-0');
  });

  it('rejects NaN (RFC 8785 §3.2.2.3 — no representation)', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
  });

  it('rejects Infinity (RFC 8785 §3.2.2.3 — no representation)', () => {
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalize(Number.NEGATIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('canonicalize — RFC 8785 §3.2.3 key ordering (the other load-bearing divergence)', () => {
  it('sorts object keys by UTF-16 code unit, not insertion order (S1.1)', () => {
    // JSON.stringify preserves insertion order; RFC 8785 requires code-unit sort.
    const input = { b: 1, a: 2 };
    expect(JSON.stringify(input)).toBe('{"b":1,"a":2}'); // stringify is WRONG here
    expect(canonicalize(input)).toBe('{"a":2,"b":1}'); // canonicalize fixes it
  });

  it('sorts nested object keys recursively', () => {
    expect(canonicalize({ z: { y: 1, x: 2 }, a: 3 })).toBe('{"a":3,"z":{"x":2,"y":1}}');
  });

  it('sorts keys across mixed case (uppercase sorts before lowercase by code unit)', () => {
    // 'B' (0x42) < 'a' (0x61) < 'b' (0x62)
    expect(canonicalize({ b: 1, a: 2, B: 3 })).toBe('{"B":3,"a":2,"b":1}');
  });

  it('produces identical output regardless of insertion order (determinism)', () => {
    const a = { foo: 1, bar: 2, baz: 3 };
    const b = { baz: 3, foo: 1, bar: 2 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('compares keys by UTF-16 code unit, not locale (compareKeysUtf16 is locale-independent)', () => {
    // In many locales 'ä' sorts near 'a'; RFC 8785 sorts by code unit, so 'ä' (0xE4) > 'z' (0x7A).
    expect(canonicalize({ z: 1, ä: 2 })).toBe('{"z":1,"ä":2}');
    expect(compareKeysUtf16('z', 'ä')).toBeLessThan(0);
  });
});

describe('canonicalize — RFC 8785 Appendix B full-object vectors (byte-exact)', () => {
  const cases: Array<[unknown, string]> = [
    [{}, '{}'],
    [[], '[]'],
    [null, 'null'],
    [true, 'true'],
    [false, 'false'],
    // Appendix B-style sample
    [
      { 1: 'e50', 10: 'e50', 100: 'e50', 2: 'e50', 3: 'e50' },
      // Numeric-looking keys are STRINGS in JSON object position, so they sort lexicographically by
      // UTF-16 code unit (not numerically): "1" < "10" < "100" < "2" < "3".
      '{"1":"e50","10":"e50","100":"e50","2":"e50","3":"e50"}',
    ],
    // Appendix B sample object. The precision-dropping literals are deliberate: RFC 8785
    // delegates number serialization to ECMAScript, so these values' canonical form IS whatever
    // ECMAScript's float produces (e.g. 333333333.33333333 → "333333333.3333333"). Asserting
    // the exact output is the point.
    [
      {
        // eslint-disable-next-line no-loss-of-precision -- intentional precision-dropping vector
        numbers: [333333333.33333333, 1e30, 4.5, 2, -0, -2.3, 1.0000000000000002],
        string: '\\u20ac$€>𝕏',
      },
      '{"numbers":[333333333.3333333,1e+30,4.5,2,-0,-2.3,1.0000000000000002],"string":"\\\\u20ac$€>𝕏"}',
    ],
  ];
  for (const [input, expected] of cases) {
    it(`produces byte-exact "${expected.slice(0, 40)}…"`, () => {
      expect(canonicalize(input)).toBe(expected);
    });
  }
});

describe('canonicalize — RFC 8785 §3.2.2.2 string escaping', () => {
  it('escapes control characters', () => {
    expect(canonicalize('a\tb\nc\rd')).toBe('"a\\tb\\nc\\rd"');
  });

  it('escapes quote and backslash', () => {
    expect(canonicalize('he said "hi" \\ done')).toBe('"he said \\"hi\\" \\\\ done"');
  });

  it('escapes other control chars (e.g. 0x01) as \\uXXXX', () => {
    expect(canonicalize('x\x01y')).toBe('"x\\u0001y"');
  });

  it('escapes lone high surrogate as \\uXXXX (not raw)', () => {
    // A lone surrogate (no following low surrogate). JSON.stringify emits raw (invalid UTF-8);
    // RFC 8785 escapes it.
    const loneHigh = '\uD800';
    expect(canonicalize(loneHigh)).toBe('"\\ud800"');
  });

  it('escapes lone low surrogate as \\uXXXX', () => {
    expect(canonicalize('\uDC00')).toBe('"\\udc00"');
  });

  it('keeps a valid surrogate pair (non-BMP char) intact', () => {
    // 𝕏 (U+1D54F) is a valid surrogate pair in JS. It stays as the two code units.
    expect(canonicalize('𝕏')).toBe('"𝕏"');
  });
});

describe('canonicalize — undefined member omission (JSON semantics)', () => {
  it('omits object members whose value is undefined (like JSON.stringify)', () => {
    // A receipt body commonly has optional fields (anchor, extensions) that are undefined when
    // unset. These must be dropped, not serialized (undefined has no JSON representation).
    expect(canonicalize({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('nested undefined members are omitted', () => {
    expect(canonicalize({ outer: { x: undefined, y: 2 } })).toBe('{"outer":{"y":2}}');
  });
});

describe('canonicalize — round-trip equivalence', () => {
  it('two logically-equal objects with different insertion order produce identical canonical bytes', () => {
    // This is the property the hash chain relies on: re-canonicalizing a receipt at verify time
    // produces the same bytes that were signed at emit time, regardless of how the fields were
    // ordered when the object was constructed.
    const emit = { c: 3, a: 1, b: { z: 26, y: 25 } };
    const verify = { a: 1, b: { y: 25, z: 26 }, c: 3 };
    expect(canonicalize(emit)).toBe(canonicalize(verify));
  });
});
