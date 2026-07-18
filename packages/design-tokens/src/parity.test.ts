import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  lightPalette,
  darkPalette,
  typography,
  radius,
  border,
  type Palette,
} from "./tokens.js";

/*
 * INV-10 + INV-12: enforce that variables.css (the CSS the theme consumes) stays
 * in lock-step with tokens.ts (the tested source of truth), and that the theme
 * CSS never reintroduces gradients/glow/glassmorphism.
 *
 * Drift between intent (tokens.ts) and delivery (variables.css) is an otherwise
 * SILENT visual regression — this test is what makes it fail loud.
 */

const tokensDir = fileURLToPath(new URL(".", import.meta.url));
const variablesPath = resolve(tokensDir, "variables.css");
const themeDir = resolve(tokensDir, "../../../docs/.vitepress/theme");
// Strip comments once, up front, so neither readVar nor the forbidden-CSS grep is
// fooled by commented-out rules or prose mentioning a term.
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const variablesCss = stripComments(readFileSync(variablesPath, "utf8"));

/**
 * Extract the value of a CSS custom property scoped under `:root` or `.dark`.
 * Searches EVERY block of the given scope (a file may declare :root/.dark in
 * several grouped blocks) and returns the last assignment to `name` — mirroring
 * CSS cascade semantics where later declarations win. Uses brace-depth tracking
 * (not a `indexOf("\n}")` heuristic) so it stays correct under minified CSS and
 * nested rules, and so a var under :root never mistakenly matches the .dark value.
 */
function readVar(
  css: string,
  scope: ":root" | ".dark",
  name: string,
): string {
  const scopeRe = new RegExp(
    `${scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`,
    "g",
  );
  let value: string | undefined;
  let matchedAnyBlock = false;
  let scopeMatch: RegExpExecArray | null;
  while ((scopeMatch = scopeRe.exec(css)) !== null) {
    // Walk from the opening brace, tracking depth, to find the matching close brace.
    let depth = 0;
    let i = scopeMatch.index + scopeMatch[0].length - 1; // position at `{`
    let end = -1;
    for (; i < css.length; i++) {
      const ch = css[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break; // unterminated block; stop scanning
    matchedAnyBlock = true;
    const block = css.slice(scopeMatch.index, end);
    const re = new RegExp(
      `${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*([^;]+);`,
    );
    const m = block.match(re);
    if (m) {
      // Last-assignment-wins, matching CSS cascade across repeated :root blocks.
      value = m[1].replace(/\s+/g, " ").trim();
    }
    // Advance past this block to find the next scope occurrence.
    scopeRe.lastIndex = end + 1;
  }
  if (value === undefined) {
    throw new Error(
      matchedAnyBlock
        ? `${name} not found under ${scope}`
        : `scope ${scope} not found in CSS`,
    );
  }
  return value;
}

describe("INV-10 — variables.css matches tokens.ts (zero drift)", () => {
  it.each(Object.entries(lightPalette) as [keyof Palette, string][])(
    "light: %s",
    (key, tsValue) => {
      const cssValue = readVar(variablesCss, ":root", key);
      expect(normalizeCss(cssValue)).toBe(normalizeCss(tsValue));
    },
  );

  it.each(Object.entries(darkPalette) as [keyof Palette, string][])(
    "dark: %s",
    (key, tsValue) => {
      const cssValue = readVar(variablesCss, ".dark", key);
      expect(normalizeCss(cssValue)).toBe(normalizeCss(tsValue));
    },
  );

  it("typography tokens match", () => {
    expect(normalizeCss(readVar(variablesCss, ":root", "--receipta-font-mono"))).toBe(
      normalizeCss(typography["--receipta-font-mono"]),
    );
    expect(normalizeCss(readVar(variablesCss, ":root", "--receipta-font-sans"))).toBe(
      normalizeCss(typography["--receipta-font-sans"]),
    );
  });

  it("radius tokens match", () => {
    for (const [key, val] of Object.entries(radius)) {
      expect(normalizeCss(readVar(variablesCss, ":root", key))).toBe(
        normalizeCss(val),
      );
    }
  });

  it("border token matches", () => {
    expect(normalizeCss(readVar(variablesCss, ":root", "--receipta-border-width"))).toBe(
      normalizeCss(border["--receipta-border-width"]),
    );
  });
});

describe("INV-12 — no gradients/glow/glassmorphism in theme CSS", () => {
  const themeFiles = ["variables.css", "style.css"] as const;

  for (const file of themeFiles) {
    it(`${file} has no forbidden CSS`, () => {
      const css = readFileSync(resolve(themeDir, file), "utf8");
      // Strip comments before grepping so a comment mentioning the term isn't a false hit,
      // but a commented-out rule is still flagged (it's dead either way — but we want live
      // rules caught). We check the raw file: a forbidden term anywhere is a defect to fix.
      const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(
        stripped,
        `${file} uses gradient (INV-12)`,
      ).not.toMatch(/gradient/i);
      expect(
        stripped,
        `${file} uses backdrop-filter (INV-12)`,
      ).not.toMatch(/backdrop-filter/i);
      expect(
        stripped,
        `${file} uses background-clip:text (INV-12)`,
      ).not.toMatch(/background-clip\s*:\s*text/i);
    });
  }
});

describe("INV-11 — custom-container accent contrast (theme variables.css)", () => {
  // The danger/warning container text colors are hand-authored hsl literals in the
  // theme (not in tokens.ts), so they escape the WCAG test in tokens.test.ts. Guard
  // them here: their text must meet the ≥3:1 large/secondary floor against the page
  // background, in BOTH light and dark, so a too-low-contrast "desaturated red"
  // danger box never ships green. (tip/note use token-derived strong/muted text,
  // already covered by tokens.test.ts.)
  //
  // NOTE on file split: the accent tokens (--vp-c-*-1) live in the THEME
  // variables.css; the background token (--receipta-c-bg) lives in the PACKAGE
  // variables.css (imported by the theme). Read each from its own file.
  const themeVarsCss = stripComments(
    readFileSync(resolve(themeDir, "variables.css"), "utf8"),
  );

  // WCAG helpers (mirror tokens.test.ts; duplicated intentionally to keep parity.test
  // self-contained — it must not depend on tokens.test.ts internals).
  function parseHsl(input: string): { h: number; s: number; l: number; a: number } {
    const m = /^hsla?\(\s*([0-9.]+)\s*,\s*([0-9.]+)%\s*,\s*([0-9.]+)%\s*(?:,\s*([0-9.]+))?\s*\)$/i.exec(
      input.trim(),
    );
    if (!m) throw new Error(`not hsl/hsla: ${input}`);
    return {
      h: Number(m[1]),
      s: Number(m[2]),
      l: Number(m[3]),
      a: m[4] === undefined ? 1 : Number(m[4]),
    };
  }
  function relLum({ h, s, l }: { h: number; s: number; l: number }): number {
    const hp = ((((h % 360) + 360) % 360) / 60);
    const sat = s / 100;
    const lig = l / 100;
    const c = (1 - Math.abs(2 * lig - 1)) * sat;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r: number;
    let g: number;
    let b: number;
    if (hp < 1) [r, g, b] = [c, x, 0];
    else if (hp < 2) [r, g, b] = [x, c, 0];
    else if (hp < 3) [r, g, b] = [0, c, x];
    else if (hp < 4) [r, g, b] = [0, x, c];
    else if (hp < 5) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    const m1 = lig - c / 2;
    const ch = (cc: number): number =>
      cc <= 0.03928 ? cc / 12.92 : ((cc + 0.055) / 1.055) ** 2.4;
    return (
      0.2126 * ch(r + m1) + 0.7152 * ch(g + m1) + 0.0722 * ch(b + m1)
    );
  }
  function contrast(a: number, b: number): number {
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  it.each([
    ["light", ":root", "--vp-c-warning-1"],
    ["light", ":root", "--vp-c-danger-1"],
    ["dark", ".dark", "--vp-c-warning-1"],
    ["dark", ".dark", "--vp-c-danger-1"],
  ] as const)(
    "%s %s text accent ≥ 3:1 vs background (container legibility)",
    (_theme, scope, accent) => {
      const accentVal = readVar(themeVarsCss, scope, accent);
      // Background comes from the package variables.css (same scope, same file the
      // INV-10 parity test already guards for drift against tokens.ts).
      const bgVal = readVar(variablesCss, scope, "--receipta-c-bg");
      const ratio = contrast(relLum(parseHsl(accentVal)), relLum(parseHsl(bgVal)));
      expect(
        ratio,
        `${accent}=${accentVal} vs bg=${bgVal} → ${ratio.toFixed(2)}`,
      ).toBeGreaterThanOrEqual(3);
    },
  );
});

/** Normalize a CSS value for comparison: trim, collapse whitespace, unify quotes. */
function normalizeCss(v: string): string {
  return v.replace(/\s+/g, " ").replace(/['"]/g, "'").trim();
}
