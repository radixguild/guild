import globals from "globals";
import next from "eslint-config-next";

// `scripts/` is plain ESM JavaScript, and until 2026-09-02 NOTHING checked it.
// tsconfig.json's `include` is `**/*.ts` + `**/*.tsx`, so tsc never sees a
// `.mjs`; and typescript-eslint disables `no-undef` project-wide (correctly —
// tsc does that job better for TS), which silently turned it off for these
// files too. eslint READ them and reported clean.
//
// The cost was measured, not theoretical: `backfill-escrow-component.mjs`
// referenced `ESCROW_COMPONENT_LEGACY` after that symbol moved to
// escrow-history.ts and was never re-imported, so the script crashed with
// `ReferenceError` on EVERY invocation — dry-run and `--apply` alike — for two
// weeks. It is the tool CLAUDE.md's deploy runbook tells an operator to run
// after a migration, and the tool `reconcile-escrow.mjs`'s own
// `[unreconcilable]` message points them to. A green lint run said it was fine.
//
// These are the unattended crons — keeper, drift watch, reconcile — running
// every 30 minutes with nobody watching. A ReferenceError there is a silent
// no-op, not a visible failure, which is exactly why it must be caught here.
const scriptGlobals = {
  ...globals.node,
  ...globals.es2025,
  Bun: "readonly",
};

const config = [
  ...next,
  {
    files: ["scripts/**/*.mjs", "scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: scriptGlobals,
    },
    rules: {
      // The whole point of this block. Everything else about these files is
      // already covered (or deliberately not) by the shared config above.
      "no-undef": "error",
    },
  },
];

export default config;
