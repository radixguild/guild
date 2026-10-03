import { test, expect } from "@playwright/test";
import { dismissGuides } from "./helpers";

// Board note M5 (2026-09-03), ruling R1: XRD is the unit of account AND the
// settlement asset; USD is DISPLAY ONLY. Task rewards render via <XrdAmount>
// (src/components/XrdAmount.tsx) as an XRD headline ("500 XRD") with a muted
// "≈ $0.50" suffix — never the other way around, and the suffix disappears
// whenever the underlying quote is stale. This SUPERSEDES the retired P3
// "$X (Y XRD)" USD-first format this file asserted before R1.
//
// The quote comes from GET /api/v1/quote/xrd-usd (Astrolescent primary,
// CoinGecko fallback, fail-closed 503) and now reports `stale` / `age_seconds`
// computed from the served PRICE's own age, not our fetch/cache clock (see
// that route's doc block) — the mocked responses below use that current
// shape, not the retired `staleness_seconds` one.
//
// Both the quote and the task list are stubbed via page.route so the assertion
// is deterministic in dev AND CI (empty DB) — no Gateway weather, no seeded rows.
// The list route is matched by RegExp so it can't also swallow /tasks/stats or
// /tasks/[id]. Routes are registered before goto: the card first paints XRD-only
// (rate starts null) and re-renders once the quote fetch resolves.

const TASKS_LIST = /\/api\/v1\/tasks(\?|$)/;
const QUOTE = "**/api/v1/quote/xrd-usd";

function stubTasksList(json: unknown) {
  return (route: import("@playwright/test").Route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(json),
    });
}

const ONE_TASK = {
  ok: true,
  data: [
    {
      id: 1,
      title: "Priced test task",
      description: "A task whose reward should render with a USD dual-label.",
      status: "open",
      rewardXrd: "500",
      creatorId: "account_rdx1abc",
      assigneeId: null,
      requiredTier: "member",
      xpReward: 100,
      onChainTaskId: 1,
      deadline: null,
      disputedAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
  ],
  cursor: null,
  hasMore: false,
};

function stubQuote(body: Record<string, unknown>, status = 200) {
  return (route: import("@playwright/test").Route) =>
    route.fulfill({
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
}

// A fresh quote, in the route's CURRENT response shape (`stale`/`age_seconds`,
// not the retired `staleness_seconds`). rate 0.001 USD/XRD → 500 XRD = $0.50.
const FRESH_QUOTE = {
  rate: 0.001,
  inverse_rate: 1000,
  source: "astrolescent",
  fetched_at: "2026-07-09T00:00:00.000Z",
  staleness_seconds: 0,
  fallback_active: false,
  stale: false,
  age_seconds: 30,
};

test.describe("USD dual-label on task rewards (R1)", () => {
  test.beforeEach(async ({ page }) => {
    await dismissGuides(page);
    await page.route(TASKS_LIST, stubTasksList(ONE_TASK));
  });

  // `.first()` throughout: since 2026-09-20 an open, funded task renders its reward TWICE on
  // /tasks — once in the "Claimable now" strip, once on its card — through the same
  // <XrdAmount>. Every format assertion below therefore covers both, and the negative ones
  // (toHaveCount(0)) already did.
  test("shows the XRD headline with a muted ≈$ suffix when the quote resolves", async ({
    page,
  }) => {
    await page.route(QUOTE, stubQuote(FRESH_QUOTE));

    await page.goto("/tasks");
    // XRD is the headline, USD is an appended, visually secondary estimate —
    // never the reverse, and never rendered as "$0.50 (500 XRD)" (the retired
    // P3 format this spec asserted before ruling R1).
    await expect(page.getByText("500 XRD ≈ $0.50", { exact: true }).first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText("$0.50 (500 XRD)")).toHaveCount(0);
  });

  test("degrades to XRD-only when the quote feed is down (fail-open)", async ({ page }) => {
    // Both feeds unavailable → the route fails closed (503); the client hook
    // resets rate to null and the component drops the "≈ $…" suffix entirely
    // instead of throwing or showing a stale/fabricated dollar figure.
    await page.route(QUOTE, stubQuote({ error: "price_feed_unavailable", message: "down" }, 503));

    await page.goto("/tasks");
    // The bare XRD amount still renders, with no USD suffix appended...
    await expect(page.getByText("500 XRD", { exact: true }).first()).toBeVisible({ timeout: 15000 });
    // ...and no USD figure is fabricated when there's no rate, in either format.
    await expect(page.getByText("≈ $")).toHaveCount(0);
    await expect(page.getByText("$0.50 (500 XRD)")).toHaveCount(0);
  });

  test("suppresses the USD suffix when the quote is stale, even with a rate present (R1)", async ({
    page,
  }) => {
    // The route can return a normal-looking `rate` alongside `stale: true` —
    // e.g. both feeds are down and a frozen cache entry is served past the
    // 30-minute bar (see the route's STALE_PRICE_AFTER_MS). A caller must
    // never render a dollar figure from that: <XrdAmount> checks `stale`
    // before formatting USD at all, independent of whether `rate` looks
    // usable. This is the behaviour R1 introduced — the old USD-first
    // rendering had no staleness awareness and would have shown the dollar
    // figure regardless, so this assertion would FAIL against it.
    await page.route(
      QUOTE,
      stubQuote({
        rate: 0.001,
        inverse_rate: 1000,
        source: "astrolescent",
        fetched_at: "2026-07-09T00:00:00.000Z",
        staleness_seconds: 0,
        fallback_active: false,
        stale: true,
        age_seconds: 3600,
      })
    );

    await page.goto("/tasks");
    await expect(page.getByText("500 XRD", { exact: true }).first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("≈ $")).toHaveCount(0);
  });
});
