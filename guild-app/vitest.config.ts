import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Next.js's "server-only" virtual module isn't available in vitest. Stub it.
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // The tests/integration/*.pg.test.ts suites each boot their own PGlite (real
    // Postgres compiled to WASM) in beforeAll. Vitest runs files in parallel, so
    // every added suite makes that startup contend with the others: at four
    // instances it crosses the 10s default and the FILE fails with "Hook timed
    // out" while reporting 0 failing tests — a confusing red that looks nothing
    // like a real assertion failure, and an intermittent one that would surface
    // first on a slower CI runner. Measured at ~10.7s locally; 60s leaves room
    // for CI without masking a genuinely hung hook, which still fails, just later.
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // Scoped to guild-app's own lib. The repo-root bot/ (the Telegram bot,
      // folded in from guild-public 2026-09-29) is plain npm + node --test with
      // its own CI job; vitest never sees it.
      include: ["src/lib/**"],
    },
  },
});
