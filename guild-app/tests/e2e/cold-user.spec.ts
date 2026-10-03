import { test, expect } from "@playwright/test";
import { stubChainData } from "./helpers";
import {
  BANNED,
  PULL_BANNED,
  CLIENT_RENDERED,
  COLD_ROUTES,
  DYNAMIC_ROUTES,
  OPTIONAL_ROUTES,
  violation,
  visibleText,
} from "../../scripts/honest-copy.mjs";

/**
 * Cold-user launch guards (G-L) — the two things a stranger's first visit
 * depends on that nothing else tested.
 *
 * Scope note: the board-renders-for-a-stranger case is already covered
 * (task-flows.spec.ts "task board" — empty-DB safe), and the connect
 * affordance + radix-connect-button mount are covered by landing.spec.ts.
 * This file deliberately adds only what was UNCOVERED:
 *
 *   1. dApp verification — /.well-known/radix.json must actually be SERVED.
 *   2. Honest copy — the claims we must never make to a cold user.
 *
 * Neither needs a database, so both run in every environment.
 * Ref: docs/GUILD-PRODUCTION-PLAN-2026-07-16.md §3 (G-L "Cold-user flows"
 * [P0] wallet connect; Wave C "strip all fee claims" / live-copy overclaim sweep).
 *
 * SISTER CHECK — scripts/launch-check.sh CHECK 4. It no longer MIRRORS the rule
 * table, it IMPORTS the same one (scripts/honest-copy.mjs), so the two cannot
 * drift; they used to be kept together by a comment saying "KEEP IN SYNC", and
 * by 2026-07-26 they had silently diverged by three rules and an `allow` field.
 * DAPP_DEF below is still duplicated there — it is one constant, checked by both.
 *
 * The two gates stay separate because they prove different things: this spec
 * fetches over HTTP from a RUNNING server (so it alone covers Caddy's
 * /.well-known passthrough, dynamic routes like /ledger, and hydrated copy),
 * while launch-check reads the built artifact on the VPS between `npm run build`
 * and `pm2 restart` — where no server is up and no e2e run exists.
 */

// The dApp-definition account the Radix Wallet must find at
// /.well-known/radix.json to treat this origin as a VERIFIED dApp. Ground truth:
// src/lib/config.ts DAPP_DEF (the master owner-badge account). Two ways this
// breaks a cold user, both silent:
//   • the file stops being served (a dot-directory under public/ is easy to lose
//     in a build/deploy change, and the VPS's Caddy must pass it through);
//   • its address diverges from the one useWallet hands RadixDappToolkit.
// Either way DEFAULT (non-dev-mode) wallets refuse to connect and a stranger
// cannot sign in at all — the long-standing G-L [P0]. A deliberate dApp-def
// change SHOULD turn this red.
const DAPP_DEF =
  "account_rdx12yepj6wme9ehcnmffk9fvelhumrfskzqyxdy6zde8ltn5zxy42mrcz";

// Which escrow is this copy describing? (redesign §11b chunk H.)
//
// PULL_BANNED is the inverse of BANNED: the copy it bans is TRUE today and
// becomes false once the escrow settles by pull, so it stays dormant until the
// build says otherwise. Read from the SAME env var the bundle was built with —
// playwright starts the server itself (see playwright.config.ts webServer), so
// the spec and the server it fetches from cannot disagree about the mode.
//
// launch-check CHECK 4 arms the same table off the COMPILED flag in
// .next/static/chunks instead, because it runs on a box where the build env is
// long gone. Two detections, one rule table — the split this module exists to
// prevent applies to the RULES, not to how each gate learns which escrow is live.
// UNCONDITIONAL SINCE S3 — and it was disarmed in CI for as long as it wasn't.
//
// This read `process.env.NEXT_PUBLIC_ESCROW_PULL === "true"` and armed
// PULL_BANNED only when that was set. It is set in exactly one place in this
// repo (ops/agent-env/gate1-env.sh) and in NEITHER playwright.config.ts nor
// .github/workflows — so on every CI run this spec has checked BANNED only,
// with the entire pull table dormant. The gate looked green because it was
// half-armed, which is the same failure launch-check CHECK 4 had and S3 fixed
// there by concatenating unconditionally. Fixing one and not the other left the
// dormant half in the gate that scans MORE routes (this one adds every
// DYNAMIC_ROUTES entry, which the artifact scan can never see).
//
// There is no flag to consult any more: the app cannot build a push manifest,
// so push-era copy is false in every build and must redden every gate.
const RULES = [...BANNED, ...PULL_BANNED];

// The claims we must never make to a cold user, and the routes a stranger can
// reach, both come from scripts/honest-copy.mjs — the single definition this
// spec shares with launch-check.sh CHECK 4. Read that file for why each rule
// exists; edit the rules THERE and both gates move together.
//
// SUPERSET of launch-check's own scan list on purpose: DYNAMIC_ROUTES entries
// (e.g. /ledger) are never prerendered, so the artifact gate can never see
// them, and /gift 200s here unconditionally because playwright.config.ts pins
// NEXT_PUBLIC_GIFT_* on (grep marker e2e-gift-env), whereas on the VPS it
// 404s unless configured.
const COLD_PAGES = [...COLD_ROUTES, ...DYNAMIC_ROUTES, ...OPTIONAL_ROUTES];

test.describe("cold-user launch guards", () => {
  test("serves /.well-known/radix.json so default wallets can verify the dApp", async ({ request }) => {
    const res = await request.get("/.well-known/radix.json");

    // 200 + JSON: the wallet fetches this cross-origin and parses it strictly.
    expect(res.status(), "the dApp-verification file must be served").toBe(200);
    expect(
      res.headers()["content-type"],
      "the wallet requires JSON content-type",
    ).toContain("application/json");

    const body = await res.json();
    expect(body.dApps?.[0]?.dAppDefinitionAddress).toBe(DAPP_DEF);
  });

  // Pass 1 — SSR/metadata sweep. Fast, no browser, and the only pass that sees
  // <head> (title/description/openGraph): an overclaim once lived in a metadata
  // description, and metadata is not in document.body.
  for (const path of COLD_PAGES) {
    test(`${path} makes no claim we can't back (SSR + metadata)`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
      const text = visibleText(await res.text());
      for (const rule of RULES) {
        const hit = violation(text, rule);
        expect(hit, `${path} must not claim ${rule.label} — matched "${hit}"`).toBeNull();
      }
    });
  }

  // Pass 2 — HYDRATED sweep. Pass 1 cannot see copy behind a client-side
  // loading state, and that is exactly where a known-false string once hid:
  // "Badge-weighted, non-binding." rendered on the now-removed /decisions page
  // (components/governance/on-chain-governance.tsx, deleted 2026-09-04) only
  // AFTER the CV2 fetch resolved — the component started loading=true and
  // returned skeletons, so the claim was absent from every server response
  // and both gates passed green over it. The general risk this pass guards
  // against is unchanged: no live WG has a charter, sunset or budget.
  
  // The bot API these pages fetch defaults to PRODUCTION
  // (config.ts BOT_API_URL → https://radixguild.com/api) and CI sets no
  // NEXT_PUBLIC_API_URL override. Unstubbed, this pass made real calls to prod
  // on every run: slow when the box answered, and a hard 30s timeout on
  // networkidle when it did not — which is exactly how it went red on main
  // against a docs-only commit. Stub it. A test that reaches production is
  // wrong even when it is green.
  //
  // Stubs return 200 WITH data rather than failing: the whole point of this
  // pass is to scan copy that appears only after the fetch RESOLVES, so a
  // failed stub would render the empty state and the scan would pass over an
  // empty page — a false green of the kind this file exists to prevent.
  test.beforeEach(async ({ context }) => {
    await stubChainData(context);
    // /leaderboard's ROW copy — the one place both gates were structurally
    // blind, and §11b flagged it for chunk H.
    //
    // The blindness is real but not where the plan put it: launch-check sees
    // only the skeleton (the route is CLIENT_RENDERED), and this pass — the
    // stated mitigation — could not catch it either, because CI runs an EMPTY
    // database, so the page rendered its empty state and every negative
    // assertion passed over nothing. The money column and its label only exist
    // when a row does. So supply one.
    //
    // Deliberately a WORKER WITH MONEY, which is the case that matters under
    // pull: `xrdEarned` sums `release` ledger rows, i.e. what the escrow
    // CREDITED — not what the worker has collected. Whatever this column is
    // ever labelled, it now gets scanned by the same rule table as everything
    // else, with a real number rendered beside it.
    await context.route("**/api/v1/users/leaderboard", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: [
            {
              id: "account_rdx1e2eleaderboardrow",
              displayName: "e2e worker",
              badgeTier: "member",
              reputation: 42,
              xp: 100,
              tasksCompleted: 3,
              tasksThisMonth: 1,
              xrdEarned: "300",
              xrdEarnedThisMonth: "100",
              trustTier: "established",
            },
          ],
        }),
      }),
    );
    await context.route("**/groups", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [{ id: 1, name: "Infra", description: "Nodes and infra.", icon: "server", member_count: 3 }] }),
      }),
    );
    await context.route("**/groups/expiring", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) }),
    );
    // Backstop: anything on the bot-API host that the routes above miss still
    // must not leave the runner. Registered last so the specific stubs win.
    await context.route("**://radixguild.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: [] }) }),
    );
  });

  for (const path of CLIENT_RENDERED) {
    test(`${path} makes no claim we can't back (hydrated)`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      // /leaderboard's rows come from a STUBBED fetch (see beforeEach), and
      // `networkidle` does not guarantee the stubbed response has been rendered
      // — it only says the network went quiet. That race was latent: the run
      // order happened to hide it until this spec started scanning the pull
      // rules as well, which shifted worker timing enough to lose it roughly one
      // run in three. Wait for the row EXPLICITLY, so the assert below reports a
      // genuinely missing stub rather than a slow one.
      if (path === "/leaderboard") {
        await page
          .getByText("e2e worker", { exact: false })
          .first()
          .waitFor({ state: "attached", timeout: 15_000 })
          .catch(() => {
            /* fall through — the assert below names the failure properly */
          });
      }
      // textContent, not innerText: a claim inside a collapsed accordion or a
      // closed <details> is still shipped copy. Strip script/style/template so
      // the RSC flight payload cannot double-report or false-positive.
      const text = (
        await page.evaluate(() => {
          const c = document.body.cloneNode(true) as HTMLElement;
          c.querySelectorAll("script,style,template,noscript").forEach((n) => n.remove());
          return c.textContent || "";
        })
      ).replace(/\s+/g, " ");
      // Anti-vacuous guard. Every assertion below is a NEGATIVE one, so a page
      // that rendered nothing — blank, crashed, or stuck on a skeleton — passes
      // all of them. This requires the page to have rendered at all, so "no
      // violations" cannot mean "there was nothing to scan".
      //
      // The threshold is deliberately low, and the reason is a real limitation
      // worth stating rather than hiding: CI runs against an EMPTY database, so
      // /projects and /leaderboard render shell-only (measured: 100-399 chars of
      // nav and headings, versus 1000+ once rows exist). This pass therefore
      // covers their STATIC copy, not their row copy. Raising the bar to
      // something that would prove rows rendered would redden CI on a correct
      // empty-DB run — so the honest move is a low floor plus this note, not a
      // high floor that gets deleted the first time it fires.
      expect(
        text.length,
        `${path} rendered almost no text (${text.length} chars) — blank or crashed, so the copy scan below would pass vacuously`,
      ).toBeGreaterThan(80);
      // /leaderboard gets a STRONGER anti-vacuous guard than the shared floor,
      // because it is the route where "no violations" was previously
      // indistinguishable from "no rows". The generic floor passes on the empty
      // state — nav and headings alone clear 80 chars — so it would not notice
      // the stub failing and the row copy going unscanned again. Assert the
      // stubbed row is actually on the page before trusting the scan below it.
      if (path === "/leaderboard") {
        expect(
          text,
          "/leaderboard rendered without the stubbed row — the money column was not scanned, so this route is back to the blind spot chunk H closed",
        ).toContain("e2e worker");
      }
      for (const rule of RULES) {
        const hit = violation(text, rule);
        expect(hit, `${path} must not claim ${rule.label} — matched "${hit}"`).toBeNull();
      }
    });
  }
});
