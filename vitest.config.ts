import { defineConfig } from 'vitest/config';

/**
 * Root vitest config. A single root config with workspace globbing is enough for receipta's
 * size; individual packages do not need their own config files.
 */
export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts'],
    environment: 'node',
    // Determinism: no real timers leaking through; tests control time explicitly.
    pool: 'threads',
    reporter: 'default',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.ts'],
      // Exclude test files everywhere, plus core's index.ts (a pure re-export barrel — counting its
      // `export *` lines as uncovered noise would distort the metric). Adapter index.ts files carry
      // real integration code and ARE measured (WI-7: narrowed from `packages/*/src/**/index.ts`).
      // The CLI's cli.ts is also excluded: its tests spawn the built binary (`dist/cli.js`) as a
      // subprocess, so the v8 instrumenter (attached to the test process) never observes execution
      // of the source module — it would read a misleading 0% despite thorough subprocess coverage.
      // CLI behavior is instead guarded by the cli.test.ts subprocess suite + verify:demo (S8).
      exclude: [
        'packages/*/src/**/*.test.ts',
        'packages/core/src/index.ts',
        'packages/cli/src/cli.ts',
      ],
      // Measure-then-floor (WI-8): set each threshold to floor(measured) − 2pts after the scope
      // narrowing (WI-7) and new tests (WI-10) landed. Re-measure and adjust if the scope changes.
      // Measured 2026-07-18: stmts 92.9, branch 81.14, funcs 93.8, lines 93.93.
      thresholds: {
        statements: 90,
        branches: 79,
        functions: 91,
        lines: 91,
      },
    },
  },
});
