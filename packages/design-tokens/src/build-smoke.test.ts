import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/*
 * INV-2 / INV-9 / INV-1: build contract guard. Asserts the VitePress build emits
 * the expected structure at docs/.vitepress/dist (INV-2), that fonts resolve under
 * the project base "/receipta/" rather than as broken absolute paths (INV-1), and
 * that the theme font family is referenced (the restyle actually shipped).
 *
 * SELF-CONTAINED: the test ensures a dist/ build exists before asserting by running
 * `pnpm docs:build` (= `vitepress build docs`) in beforeAll when dist is absent. This
 * is critical because CI runs `pnpm test` BEFORE `pnpm docs:build` (ci.yml:43 vs :49)
 * and dist/ is not committed — without this, the assertions would no-op on a clean
 * CI runner and INV-1/2/9 coverage would be dark at the merge gate.
 */

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const distDir = resolve(repoRoot, "docs/.vitepress/dist");

// Base path the site is served under (INV-1) — must match docs/.vitepress/config.ts.
const BASE = "/receipta/";

/** Ensure a dist/ build exists before assertions run. */
function ensureBuild(): void {
  if (existsSync(resolve(distDir, "index.html"))) return;
  // Run the documented `docs:build` script (package.json) from the repo root so
  // VitePress resolves config + workspace exactly as CI does. pnpm handles the
  // vitepress binary resolution; invoking the JS path directly is fragile under
  // pnpm's hoisted/symlinked node_modules.
  const result = spawnSync("pnpm", ["docs:build"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(
      `vitepress build failed (exit ${result.status})\n${result.stderr}`,
    );
  }
}

describe("docs build contract (INV-2 / INV-9 / INV-1)", () => {
  let indexHtml: string;

  beforeAll(() => {
    ensureBuild();
    indexHtml = readFileSync(resolve(distDir, "index.html"), "utf8");
  });

  it("emits index.html (INV-2 build-output contract)", () => {
    expect(indexHtml.length).toBeGreaterThan(0);
    expect(indexHtml).toContain("<html");
  });

  it("index.html references at least one CSS stylesheet (theme shipped)", () => {
    expect(indexHtml).toMatch(/<link[^>]+\.css/i);
  });

  it("references the IBM Plex font family in built CSS (the restyle took effect)", () => {
    // Find the CSS files referenced from index.html and check at least one carries
    // the receipta font stack. The font-family value is emitted from variables.css.
    const assetsDir = resolve(distDir, "assets");
    if (!existsSync(assetsDir)) {
      throw new Error("dist/assets missing — build did not emit hashed assets");
    }
    const cssFiles = readdirSync(assetsDir).filter((f) => f.endsWith(".css"));
    expect(cssFiles.length, "expected at least one built CSS file").toBeGreaterThan(0);
    const allCss = cssFiles
      .map((f) => readFileSync(resolve(assetsDir, f), "utf8"))
      .join("\n");
    expect(allCss).toContain("IBM Plex Mono");
    expect(allCss).toContain("IBM Plex Sans");
  });

  it("every font url(...) resolves under the project base (INV-1, no broken absolute paths)", () => {
    // Font woff2 files are emitted as hashed assets under /receipta/assets/. A
    // non-based absolute path like url(/assets/x.woff2) would 404 in prod (works in
    // docs:dev). Catch that: every url(...) pointing at a font must start with the base.
    const assetsDir = resolve(distDir, "assets");
    const cssFiles = readdirSync(assetsDir).filter((f) => f.endsWith(".css"));
    const allCss = cssFiles
      .map((f) => readFileSync(resolve(assetsDir, f), "utf8"))
      .join("\n");
    // Match url(...) inside @font-face src that reference woff/woff2/ttf. Even
    // pre-Phase-3 the default theme bundles Inter woff2 (14 files), so this is
    // load-bearing today; Phase 3's IBM Plex fonts add more urls to guard.
    const fontUrlRe = /url\(([^)]+\.(?:woff2?|ttf|otf)[^)]*)\)/gi;
    const matches = [...allCss.matchAll(fontUrlRe)].map((m) => m[1]);
    for (const url of matches) {
      const cleaned = url.replace(/^['"]|['"]$/g, "");
      // Allowed: relative (assets/...), base-prefixed (/receipta/...), or data: URIs.
      const isRelative = !cleaned.startsWith("/");
      const isBased = cleaned.startsWith(BASE);
      const isData = cleaned.startsWith("data:");
      expect(
        isRelative || isBased || isData,
        `font url not base-prefixed: ${cleaned}`,
      ).toBe(true);
    }
  });
});
