import { defineConfig, devices } from "@playwright/test";

// Port the webServer binds to and the baseURL Playwright tests against.
// Override with E2E_PORT when :3000 is already taken locally (a common state
// on a machine running several repos' dev servers) — the default (3000) is
// unchanged, so CI and every existing invocation behave exactly as before.
// See guild-app/tests/README.md for the documented override.
const E2E_PORT = process.env.E2E_PORT || "3000";

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  // Write the report where CI's upload-artifact step looks for it
  // (guild-app/playwright-report — see .github/workflows/test.yml), and never
  // auto-serve it (the local report server would block scripted runs).
  reporter: [["html", { outputFolder: "../../playwright-report", open: "never" }]],
  use: {
    baseURL: process.env.BASE_URL || `http://localhost:${E2E_PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chrome", use: { ...devices["Pixel 5"] } },
  ],
  webServer: {
    // In CI: build once + run prod server (instant startup, faster end-to-end).
    // Locally: dev mode (auto-reload, no build wait). bun forwards `-p` to the
    // underlying `next dev`/`next start`; with E2E_PORT unset it is `-p 3000`,
    // next's own default, so the command behaves exactly as before.
    command: process.env.CI
      ? `cd .. && bun run build && bun run start -p ${E2E_PORT}`
      : `cd .. && bun run dev -p ${E2E_PORT}`,
    url: `http://localhost:${E2E_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180000,
    // PLAYWRIGHT_E2E disables the dev-tools indicator (dev mode only) so it
    // can't overlap the mobile bottom nav and intercept clicks — see
    // next.config.ts, grep marker e2e-dev-indicator. Harmless in CI (prod build
    // has no indicator anyway).
    //
    // NEXT_PUBLIC_FEATURE_ESCROW pins the escrow surface ON — this is an
    // anti-false-green measure, not a convenience. Unset (the previous state),
    // isEscrowDeployed() is false, so escrow-actions.tsx returns null at every
    // one of its four entry points (:177, :265, :433, :570) and escrow-truth.tsx
    // short-circuits (:40). Any spec asserting escrow behaviour would then pass
    // VACUOUSLY against a surface that never rendered — green meaning nothing.
    // Prod runs escrow on, so e2e should too. Grep marker: e2e-escrow-flag.
    //
    // NEXT_PUBLIC_GIFT_* pins the gift rails ON, same anti-false-green reason:
    // unset, /gift 404s by design (lib/gift.ts), so every gift spec would pass
    // vacuously against a route that does not exist. Grep marker: e2e-gift-env.
    //
    // NEXT_PUBLIC_FEATURE_CROWDFUND pins the community-funding pages ON for the
    // same reason again: unset (the production default) /fund, /fund/[id] and
    // /fund/create notFound(), so the cold-user copy sweep would skip the three
    // newest claim-bearing pages in the product entirely. Those pages tell a
    // stranger what a pledge is and is not — the one thing on that surface that
    // must never drift — so pinning the flag here is what puts them under the
    // honest-copy rules in CI rather than only under a source-text unit test.
    // Grep marker: e2e-crowdfund-flag.
    // These are FIXTURES, never real destinations — the XRD value is this
    // repo's already-public dApp-definition account and the BTC value is the
    // BIP-350 spec's own example address (derived from the secp256k1 generator
    // point, nobody's wallet). Real destinations live only in the VPS's
    // .env.local and must never be committed here.
    env: {
      PLAYWRIGHT_E2E: "1",
      // Separate from PLAYWRIGHT_E2E on purpose. PLAYWRIGHT_E2E is cosmetic —
      // it hides the dev-tools indicator (see the note above). THIS one turns
      // OFF the ROLA signature check on the production sign-in route
      // (src/lib/rola.ts), so it gets a name that says what it does and can
      // never be armed by someone reaching for the cosmetic flag.
      // launch-check.sh fails the deploy if it is ever present in the pm2 env.
      GUILD_E2E_AUTH_BYPASS: "1",
      // The bypass's BUILD-time half. rola.ts honours GUILD_E2E_AUTH_BYPASS only
      // in a build made with GUILD_E2E_BUILD=1: next.config.ts inlines this
      // value at `next build` (and in `next dev`), so it must be present when
      // the command above BUILDS, not just when it starts. The box's build runs
      // with it stripped (scripts/deploy.sh) and bakes in "", which is what
      // keeps the bypass out of production no matter what its runtime env says.
      GUILD_E2E_BUILD: "1",
      NEXT_PUBLIC_FEATURE_ESCROW: "true",
      NEXT_PUBLIC_FEATURE_CROWDFUND: "true",
      NEXT_PUBLIC_GIFT_XRD_ADDRESS:
        "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw",
      NEXT_PUBLIC_GIFT_BTC_ADDRESS:
        "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
      NEXT_PUBLIC_GIFT_STRIPE_URL: "https://buy.stripe.com/8wMbJe0Zq2Sw6JydQQ",
      NEXT_PUBLIC_GIFT_PAYPAL_URL: "https://paypal.me/exampleguildhandle",
    },
  },
});
