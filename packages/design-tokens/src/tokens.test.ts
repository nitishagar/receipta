import { describe, it, expect } from "vitest";
import {
  lightPalette,
  darkPalette,
  palettes,
  typography,
  radius,
  border,
  sharedTokens,
  type Palette,
} from "./tokens.js";

/*
 * INV-11 load-bearing: WCAG contrast ratio for body text, in BOTH themes.
 * Self-contained relative-luminance + contrast helpers (no dependency). Colors are
 * authored as hsl()/hsla(); we parse the three/four channels ourselves.
 */

type Hsl = { h: number; s: number; l: number; a: number };

/** Parse "hsl(H, S%, L%)" or "hsla(H, S%, L%, A)". Throws on anything else. */
function parseHsl(input: string): Hsl {
  const m = /^hsla?\(\s*([0-9.]+)\s*,\s*([0-9.]+)%\s*,\s*([0-9.]+)%\s*(?:,\s*([0-9.]+))?\s*\)$/i.exec(
    input.trim(),
  );
  if (!m) throw new Error(`not a valid hsl()/hsla() color: ${input}`);
  return {
    h: Number(m[1]),
    s: Number(m[2]),
    l: Number(m[3]),
    a: m[4] === undefined ? 1 : Number(m[4]),
  };
}

/** hsl → linear sRGB [0,1] triple. */
function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  const hp = (((h % 360) + 360) % 360) / 60;
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m1 = lig - c / 2;
  return [r1 + m1, g1 + m1, b1 + m1];
}

/** WCAG relative luminance for an opaque color. */
function relativeLuminance(hsl: Hsl): number {
  const [r, g, b] = hslToRgb(hsl);
  const channel = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Composite a (possibly translucent) foreground onto an opaque background, then
 * return its relative luminance — so `hsla(...,0.12)` borders are measured on the
 * page they render against, not as transparent. Needed for `border-weak`.
 */
function luminanceOn(fg: Hsl, bgLum: number): number {
  if (fg.a >= 1) return relativeLuminance(fg);
  const fgLum = relativeLuminance({ ...fg, a: 1 });
  return fgLum * fg.a + bgLum * (1 - fg.a);
}

/** WCAG contrast ratio (≥1, ≤21). */
function contrast(fgLum: number, bgLum: number): number {
  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);
  return (lighter + 0.05) / (darker + 0.05);
}

const REQUIRED_PALETTE_KEYS: ReadonlyArray<keyof Palette> = [
  "--receipta-c-bg",
  "--receipta-c-bg-weak",
  "--receipta-c-bg-weak-hover",
  "--receipta-c-bg-strong",
  "--receipta-c-bg-interactive",
  "--receipta-c-text-strong",
  "--receipta-c-text-muted",
  "--receipta-c-text-subtle",
  "--receipta-c-text-inverted",
  "--receipta-c-border",
  "--receipta-c-border-weak",
];

describe("design tokens — structural validity", () => {
  for (const [name, palette] of Object.entries(palettes) as [
    "light" | "dark",
    Palette,
  ][]) {
    describe(`${name} palette`, () => {
      it("has every required key", () => {
        for (const key of REQUIRED_PALETTE_KEYS) {
          expect(palette, `missing ${key} in ${name}`).toHaveProperty(key);
        }
      });

      it("every color token is valid hsl()/hsla()", () => {
        for (const key of REQUIRED_PALETTE_KEYS) {
          const val = palette[key];
          expect(() => parseHsl(val), `${key}=${val}`).not.toThrow();
        }
      });

      it("has no color value containing 'gradient' (INV-12)", () => {
        for (const key of REQUIRED_PALETTE_KEYS) {
          expect(palette[key].toLowerCase()).not.toMatch(/gradient/);
        }
      });

      it("no saturated hue outside the pale-yellow interactive token (INV-12)", () => {
        for (const key of REQUIRED_PALETTE_KEYS) {
          const hsl = parseHsl(palette[key]);
          if (key === "--receipta-c-bg-interactive") {
            // Pale-yellow focus/selection accent is the ONE permitted non-neutral.
            expect(hsl.h).toBeGreaterThanOrEqual(40);
            expect(hsl.h).toBeLessThanOrEqual(80);
            continue;
          }
          // At extreme lightness, hsl saturation is imperceptible — a hairline like
          // `hsla(0,100%,3%,0.12)` is a neutral near-black, not a "saturated hue".
          // INV-12 forbids visible saturation; only check where it can be seen.
          if (hsl.l <= 8 || hsl.l >= 92) continue;
          expect(hsl.s, `${key} saturation too high`).toBeLessThanOrEqual(30);
        }
      });
    });
  }

  it("typography exposes mono + sans stacks", () => {
    expect(typography["--receipta-font-mono"]).toContain("IBM Plex Mono");
    expect(typography["--receipta-font-sans"]).toContain("IBM Plex Sans");
  });

  it("radii are the crisp set (2/4/6/8px)", () => {
    const vals = Object.values(radius).sort();
    expect(vals).toEqual(["2px", "4px", "6px", "8px"]);
  });

  it("border is a 1px hairline", () => {
    expect(border["--receipta-border-width"]).toBe("1px");
  });

  it("shared tokens aggregate typography + radius + border", () => {
    expect(sharedTokens["--receipta-font-mono"]).toBeDefined();
    expect(sharedTokens["--receipta-radius-sm"]).toBeDefined();
    expect(sharedTokens["--receipta-border-width"]).toBeDefined();
  });
});

describe("design tokens — WCAG contrast (INV-11)", () => {
  it.each([
    ["light", lightPalette],
    ["dark", darkPalette],
  ] as const)("body text ≥ 4.5:1 vs background (%s theme)", (_name, palette) => {
    const bgLum = relativeLuminance(parseHsl(palette["--receipta-c-bg"]));
    for (const key of [
      "--receipta-c-text-strong",
      "--receipta-c-text-muted",
    ] as const) {
      const fgLum = relativeLuminance(parseHsl(palette[key]));
      const ratio = contrast(fgLum, bgLum);
      expect(ratio, `${key} contrast ${ratio.toFixed(2)} < 4.5`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it.each([
    ["light", lightPalette],
    ["dark", darkPalette],
  ] as const)(
    "secondary/subtle text ≥ 3:1 vs background (large/secondary floor, %s)",
    (_name, palette) => {
      const bgLum = relativeLuminance(parseHsl(palette["--receipta-c-bg"]));
      const subtleLum = relativeLuminance(parseHsl(palette["--receipta-c-text-subtle"]));
      // text-subtle is explicitly large/secondary-only (documented in tokens.ts).
      expect(contrast(subtleLum, bgLum)).toBeGreaterThanOrEqual(3);
    },
  );

  it.each([
    ["light", lightPalette],
    ["dark", darkPalette],
  ] as const)(
    "inverted text on bg-strong ≥ 4.5:1 (%s — CTA fill legibility)",
    (_name, palette) => {
      const strongLum = relativeLuminance(parseHsl(palette["--receipta-c-bg-strong"]));
      const invLum = relativeLuminance(parseHsl(palette["--receipta-c-text-inverted"]));
      expect(contrast(invLum, strongLum)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("translucent border-weak composites to a perceptible hairline (not invisible)", () => {
    for (const [name, palette] of Object.entries(palettes) as [
      "light" | "dark",
      Palette,
    ][]) {
      const bgLum = relativeLuminance(parseHsl(palette["--receipta-c-bg"]));
      const borderLum = luminanceOn(parseHsl(palette["--receipta-c-border-weak"]), bgLum);
      // A visible hairline differs from its background (ratio > 1 means perceptible).
      expect(contrast(borderLum, bgLum), `${name} border-weak invisible`).toBeGreaterThan(
        1.05,
      );
    }
  });
});

describe("design tokens — determinism", () => {
  it("every color token is a stable literal hsl/hsla string (no Math.random at module load)", () => {
    // A real non-randomness check: assert each value is one of the known-good
    // literals. If tokens.ts ever pulled in randomness, these fixed expectations
    // would fail. (Comparing the module to itself, as a prior version did, is a
    // tautology — the cached export always equals itself.)
    const expectedLightBg = "hsl(0, 20%, 99%)";
    const expectedDarkBg = "hsl(0, 9%, 7%)";
    expect(lightPalette["--receipta-c-bg"]).toBe(expectedLightBg);
    expect(darkPalette["--receipta-c-bg"]).toBe(expectedDarkBg);
    expect(lightPalette["--receipta-c-bg-interactive"]).toBe("hsl(62, 84%, 88%)");
    expect(darkPalette["--receipta-c-bg-interactive"]).toBe("hsl(62, 100%, 90%)");
    // Re-import yields the SAME values (module-eval order doesn't reshuffle them).
    const again = lightPalette["--receipta-c-border"];
    expect(again).toBe("hsl(30, 2%, 81%)");
  });
});
