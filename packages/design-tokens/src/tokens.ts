/**
 * @receipta/design-tokens — opencode-derived monochrome design tokens.
 *
 * The single source of truth for the receipta docs theme. Every value here is
 * mirrored in `variables.css`, kept in sync by `parity.test.ts` (zero drift).
 *
 * Literal color values are read directly from opencode.ai's served CSS (research
 * ledger, all verified `[V]`). The muted/subtle/weak-dark tokens the ledger does
 * not enumerate are design choices within the same monochrome warm system (BA-2:
 * exact rem/hex values are a design choice for the planner). All body-text tokens
 * meet WCAG AA (≥4.5:1); `text-subtle` is large/secondary-only (≥3:1), enforced
 * by `tokens.test.ts` (INV-11).
 */

/**
 * A color token. Expressed as `hsl()`/`hsla()` — opencode's format — so the WCAG
 * helper and parity test can parse a single shape. No `#hex`, no `gradient`.
 */
export type Color = string;

/** Required color tokens for one theme (light or dark). Keys are CSS var names. */
export interface Palette {
  "--receipta-c-bg": Color;
  "--receipta-c-bg-weak": Color;
  "--receipta-c-bg-weak-hover": Color;
  "--receipta-c-bg-strong": Color;
  "--receipta-c-bg-interactive": Color;
  "--receipta-c-text-strong": Color;
  "--receipta-c-text-muted": Color;
  "--receipta-c-text-subtle": Color;
  "--receipta-c-text-inverted": Color;
  "--receipta-c-border": Color;
  "--receipta-c-border-weak": Color;
}

/**
 * Light palette (default). Backgrounds + text-strong + border + interactive are
 * opencode's served `[V]` values; muted/subtle/weak-hover are derived in-system.
 */
export const lightPalette: Palette = {
  "--receipta-c-bg": "hsl(0, 20%, 99%)",
  "--receipta-c-bg-weak": "hsl(0, 8%, 97%)",
  "--receipta-c-bg-weak-hover": "hsl(0, 8%, 94%)",
  "--receipta-c-bg-strong": "hsl(0, 5%, 12%)",
  "--receipta-c-bg-interactive": "hsl(62, 84%, 88%)",
  "--receipta-c-text-strong": "hsl(0, 5%, 12%)",
  "--receipta-c-text-muted": "hsl(0, 5%, 32%)",
  "--receipta-c-text-subtle": "hsl(0, 4%, 48%)",
  "--receipta-c-text-inverted": "hsl(0, 20%, 99%)",
  "--receipta-c-border": "hsl(30, 2%, 81%)",
  "--receipta-c-border-weak": "hsla(0, 100%, 3%, 0.12)",
};

/**
 * Dark palette. Background/text-strong/border/interactive are opencode's served
 * `[V]` dark values; the rest are derived to match the warm-monochrome system.
 */
export const darkPalette: Palette = {
  "--receipta-c-bg": "hsl(0, 9%, 7%)",
  "--receipta-c-bg-weak": "hsl(0, 8%, 11%)",
  "--receipta-c-bg-weak-hover": "hsl(0, 8%, 14%)",
  "--receipta-c-bg-strong": "hsl(0, 15%, 94%)",
  "--receipta-c-bg-interactive": "hsl(62, 100%, 90%)",
  "--receipta-c-text-strong": "hsl(0, 15%, 94%)",
  "--receipta-c-text-muted": "hsl(0, 8%, 72%)",
  "--receipta-c-text-subtle": "hsl(0, 6%, 60%)",
  "--receipta-c-text-inverted": "hsl(0, 9%, 7%)",
  "--receipta-c-border": "hsl(0, 3%, 28%)",
  "--receipta-c-border-weak": "hsla(0, 100%, 97%, 0.12)",
};

/** Typography stacks (BA-5: mono display, sans body). Theme-independent. */
export const typography = {
  "--receipta-font-mono":
    "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  "--receipta-font-sans":
    "'IBM Plex Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
} as const;

/**
 * Radii — opencode's crisp set (research: opencode uses 4/6/8/14/2px; we adopt
 * the crisp set 2/4/6/8). Theme-independent.
 */
export const radius = {
  "--receipta-radius-xs": "2px",
  "--receipta-radius-sm": "4px",
  "--receipta-radius-md": "6px",
  "--receipta-radius-lg": "8px",
} as const;

/** Border — 1px hairlines (opencode's pervasive hairline system). */
export const border = {
  "--receipta-border-width": "1px",
} as const;

/** All non-color token groups, for exhaustive shape + parity assertions. */
export const sharedTokens = {
  ...typography,
  ...radius,
  ...border,
} as const;

/** Every palette, named for iteration in tests. */
export const palettes = {
  light: lightPalette,
  dark: darkPalette,
} as const;
