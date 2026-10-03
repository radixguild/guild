import type { NextConfig } from "next";

// Content-Security-Policy, ENFORCED since 2026-09-30 (ruled by bigdev: enforce
// before the launch post). It shipped REPORT-ONLY on 2026-09-14 (0914 review
// task). The switch changes the header KEY and the reporting directives (see
// report-uri below); no fetch/load directive changed. What cleared it:
//   - a headless-Chromium sweep of all 36 page routes, plus opening the Radix
//     Connect Button, recorded 0 securitypolicyviolation events: on
//     radixguild.com under the report-only policy, and on a local production
//     build under this enforced one (with the escrow, crowdfund and gift flags
//     on, so /fund* and /gift were covered too). A positive control on the
//     same build (an off-policy fetch and <script src>) WAS blocked and
//     reported, so the harness sees what it should;
//   - the report sink's log holds 0 real violations from 09-15 to 09-30. That
//     proves less than it looks: Chromium never delivered a report to it (see
//     report-uri below). It could only have heard from non-Chromium browsers,
//     and there is little of that traffic. The sweep carries the weight.
// To back out, rename the key to `Content-Security-Policy-Report-Only`: a
// one-line revert plus a deploy.
//
// Why here and not src/proxy.ts: proxy.ts (this app's Next 16 middleware —
// the renamed middleware.ts) already sets X-Content-Type-Options,
// X-Frame-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy and
// Strict-Transport-Security, but ONLY for its own `matcher: ["/api/:path*"]`
// — it never runs for page routes. CSP is a page/document concern (it governs
// what a rendered HTML document may load), so it belongs on every route via
// next.config's headers() instead, and is added here rather than duplicating
// any of proxy.ts's existing headers.
//
// Baseline directives are the ones handed down for this task; the origins
// added to style-src/font-src/connect-src come from actually auditing what
// this app loads (grepped src/ + the vendored @radixdlt/radix-dapp-toolkit
// bundle in node_modules — see the PR body for the full trace):
//
// - style-src https://fonts.googleapis.com — TWO independent, confirmed
//   sources: (1) src/app/globals.css line 1 does
//   `@import url("https://fonts.googleapis.com/css2?family=Inter...");`
//   directly (Inter + JetBrains Mono), a real browser-fetched stylesheet
//   import, separate from next/font/google's self-hosted Inter in
//   layout.tsx; (2) the Radix Connect Button web component
//   (@radixdlt/radix-dapp-toolkit, chunk-EDAH65BG.js `injectFontCSS()`)
//   appends its own `<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=IBM+Plex+Sans...">`
//   to document.head at runtime whenever it renders — which is on
//   essentially every page, since the wallet connect UI is global.
// - font-src https://fonts.gstatic.com — the actual font files the above
//   Google Fonts stylesheets reference via @font-face.
// - connect-src https://radixguild.com — same-origin in production already
//   ('self' covers it there), added explicitly for BOT_API_URL
//   (src/lib/config.ts, "Caddy routes radixguild.com/api/* to the bot on
//   :3003") — the one documented cross-origin client fetch target this app
//   defines, even though nothing in src/ currently calls it client-side
//   (grepped: only referenced in config.ts's own definition, a doc comment
//   in api-fetch.ts, and test/script files). Kept for that documented intent
//   and so the policy doesn't silently regress if a client caller is added.
// - https://mainnet.radixdlt.com / https://*.radixdlt.com / wss://*.radixdlt.com
//   (given in the brief, kept as-is) cover the Gateway (src/lib/config.ts
//   GATEWAY) and the Radix Connect Relay
//   (https://radix-connect-relay.radixdlt.com, confirmed in the vendored
//   toolkit bundle) the wallet-linking flow uses. The toolkit's other
//   external hosts (wallet.radixdlt.com, app.radixdlt.com) are only ever
//   opened via `window.open(...)` — a navigation, not a fetch/embed — so
//   they need no connect-src/frame-src entry.
// - No frame-src addition: nothing in this app or the vendored Radix
//   toolkit renders an <iframe> (grepped both); the wallet-linking QR flow
//   opens a new tab/window instead, which CSP does not restrict.
// - No script-src addition: no external <script src>; the Radix SDKs, QR
//   rendering (qrcode.react), toasts (sonner) etc. are all bundled into the
//   app's own JS and served from 'self'.
// - No TradingView/analytics origins: this app has neither (checked
//   package.json + every src/ import) — that concern lives in the trading
//   repos (sats-dashboard, auto-trader-xrd), not guild-saas.
//
// ── report-uri → POST /api/v1/csp-report ──────────────────────────────────
// The sink's route doc has the full design: accepted shapes, size and rate
// limits, exactly what gets logged. An enforced violation is BLOCKED and
// REPORTED (disposition "enforce").
//
// report-uri ONLY. `report-to` + `Reporting-Endpoints` were REMOVED 2026-09-30,
// and the reason was measured, not assumed. From 2026-09-14 this header set
// both, "deliberately redundant", on the theory that each browser sends
// whichever it speaks. Chromium does not work that way: when `report-to` is
// present it IGNORES `report-uri`, and it then delivered nothing over the
// Reporting API either:
//   - 0 of 3 probes reached radixguild.com's sink in 2+ minutes (Chrome 154,
//     Chromium 147 headless, Chrome 152 in the desktop app);
//   - on a minimal local server, Chrome 154 sent report-uri-only 1/1 within
//     1s, report-to-only 0/1 and both 0/1.
// So every Chrome user was silent for 16 days. Under an enforced policy that
// would make a real breakage invisible. `report-uri` is deprecated in the spec
// but delivered by Chrome today (measured above), and Firefox and Safari
// implement it too. Re-add report-to only with a delivery measurement in
// hand. The route still accepts the Reporting-API shape, so nothing there
// changes.
const REPORTING_ENDPOINT_PATH = "/api/v1/csp-report";

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://mainnet.radixdlt.com https://*.radixdlt.com wss://*.radixdlt.com https://radixguild.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  `report-uri ${REPORTING_ENDPOINT_PATH}`,
].join("; ");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Every route: CSP governs documents, and a page path left out of a
        // hand-picked list would be the one page left unprotected.
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: CSP_DIRECTIVES,
          },
        ],
      },
    ];
  },

  // ── The e2e auth bypass, first interlock: fixed at BUILD time ─────────────
  // src/lib/rola.ts skips the ROLA signature check only when
  // process.env.GUILD_E2E_BUILD === "1" AND process.env.GUILD_E2E_AUTH_BYPASS === "1".
  // Listing GUILD_E2E_BUILD here makes `next build` replace every literal
  // `process.env.GUILD_E2E_BUILD` in server AND client code with the value it
  // had when the build ran (next/dist/build/define-env.js spreads config.env
  // into every compilation). The box's build (scripts/deploy.sh) runs with the
  // variable unset, so it bakes in "" — the branch is compiled dead, and no
  // runtime env, pm2 env or dotenv edit can bring it back without a rebuild.
  // Only the e2e harness builds with "1" (tests/e2e/playwright.config.ts
  // webServer env), so the bypass exists only in builds made for the harness.
  //
  // Two rules keep this true. (1) Read it as a literal `process.env.GUILD_E2E_BUILD`:
  // destructuring (`const { GUILD_E2E_BUILD } = process.env`) or a computed key
  // is NOT replaced and would fall back to a runtime read. tests/unit/rola.test.ts
  // pins the literal. (2) Never default it to anything but "": a non-empty
  // default would arm every build that forgot to set it.
  // The second interlock is launch-check.sh CHECK 6, which fails a deploy if
  // either variable appears in a dotenv file, the deploying shell, or pm2's env.
  env: {
    GUILD_E2E_BUILD: process.env.GUILD_E2E_BUILD ?? "",
  },

  // Where `next build` writes its output. Next has no --dist-dir CLI flag, so a
  // relocatable build has to be configured here.
  //
  // This exists for ONE caller: scripts/deploy.sh builds into a CANDIDATE
  // directory so the artifact the running server is reading is never touched
  // until that build has passed the launch gate. Before this, `next build`
  // cleaned and rewrote .next in place, underneath the live process — so every
  // deploy broke the site for the length of the build, and a build that then
  // FAILED the gate left it broken indefinitely (2026-09-08: 2 of 14 homepage
  // chunks served 500 until a human ran the restart). See scripts/deploy.sh.
  //
  // Unset — dev, typecheck, tests, CI, and `next start` on the box — resolves to
  // ".next" exactly as before. `next start` re-reads this config at boot and
  // looks for the directory by the name it resolves to THEN, which is what makes
  // a build produced under another name servable once it is moved into place
  // (verified empirically on Next 16.3.3: 16/16 assets 200 after the move).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // A CANDIDATE build (scripts/deploy.sh builds into .next-candidate while the live .next
  // keeps serving) must not type-check the LIVE build's generated types. tsconfig.json
  // includes ".next/types/**/*.ts"; on the box that folder belongs to the PREVIOUS deploy, and
  // its validator.ts imports every route that existed THEN. The first deploy that moved a
  // route (2026-09-20, /api/agent/feed -> /api/v1/agent/feed) therefore failed with TS2307
  // "Cannot find module '../../src/app/api/agent/feed/route.js'" — on the box only, because
  // CI builds from a clean tree. tsconfig.candidate.json extends tsconfig.json minus that
  // include; Next adds the candidate dir's own types to it during the build, and deploy.sh
  // restores both files afterwards.
  typescript: {
    tsconfigPath:
      process.env.NEXT_DIST_DIR && process.env.NEXT_DIST_DIR !== ".next"
        ? "tsconfig.candidate.json"
        : "tsconfig.json",
  },

  // basePath intentionally unset — this app serves at the domain root.
  // It ran under "/guild" while sharing radixguild.com with the old app;
  // the unification reroutes radixguild.com → this app at root via Caddy.
  // NOTE: keep in sync with BASE_PATH in src/lib/api-fetch.ts.

  // The dev-only Next.js dev-tools indicator is fixed at the bottom-left, exactly
  // where it overlaps the mobile bottom nav — so in `bun run dev` it intercepts
  // Playwright's click on the Home link (tests/e2e/landing.spec.ts "navigation
  // links work" on mobile-chrome). Production builds have no indicator, which is
  // why CI (prod build) stays green while the local dev-server run went red.
  // Disable it only under e2e so the LOCAL `bun run test:e2e` is faithful to CI;
  // a normal `bun run dev` keeps the indicator. Grep marker: e2e-dev-indicator.
  ...(process.env.PLAYWRIGHT_E2E ? { devIndicators: false as const } : {}),
};

export default nextConfig;
