import { defineConfig } from "vitest/config";

/**
 * Root vitest config. A single root config with workspace globbing is enough for receipta's
 * size; individual packages do not need their own config files.
 */
export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts"],
    environment: "node",
    // Determinism: no real timers leaking through; tests control time explicitly.
    pool: "threads",
    reporter: "default",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/*.test.ts", "packages/*/src/**/index.ts"],
    },
  },
});
