import { test, expect } from "@playwright/test";
import { dbAvailable, dismissGuides } from "./helpers";

test.describe("Landing Page", () => {
  test("page loads without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto("/");
    await page.waitForTimeout(1000);
    // Allow fetch errors from external APIs (expected when unreachable), but no JS crashes
    const jsErrors = errors.filter(
      (e) => !e.includes("fetch") && !e.includes("Failed to fetch") && !e.includes("NetworkError")
    );
    expect(jsErrors).toHaveLength(0);
  });

  test("title and description are visible", async ({ page }) => {
    await page.goto("/");
    // The disconnected hero (src/app/page.tsx). Matched by ROLE so it can't
    // collide with the same words elsewhere on the page.
    await expect(
      page.getByRole("heading", { name: "Commission real work on Radix" })
    ).toBeVisible();
    // Substring, not the full sentence: the surrounding copy is trust-sensitive
    // and gets reworded (see cold-user.spec.ts's honest-copy guard), so this
    // pins only the claim the hero exists to make — that it is a task
    // marketplace for the Radix community. Phrased as two loose fragments so a
    // further honest-copy edit does not redden a page that is still accurate.
    await expect(page.getByText(/task marketplace for the Radix community/)).toBeVisible();
  });

  test("connect wallet button/element is present", async ({ page }) => {
    await page.goto("/");
    // The Radix Connect Button is a web component or the onboarding text
    await expect(page.getByText("Connect Wallet")).toBeVisible();
  });

  test("radix-connect-button web component mounts after hydration", async ({ page }) => {
    // AppShell renders <radix-connect-button/> only when the
    // useSyncExternalStore hydration gate flips to true (PR #75 refactor).
    // If the gate regresses to a useEffect+setState pattern, this catches it.
    await page.goto("/");
    await expect(page.locator("radix-connect-button").first()).toBeAttached({ timeout: 3000 });
  });

  test("clicking Connect Wallet does not crash the page", async ({ page }) => {
    // Sanity: without a wallet extension installed, clicking should be a
    // no-op (RDT opens its own modal) but the page MUST NOT throw.
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto("/");
    const btn = page.locator("radix-connect-button").first();
    if (await btn.isVisible()) {
      await btn.click();
      await page.waitForTimeout(500);
    }
    expect(errors).toEqual([]);
  });

  test("navigation links work", async ({ page, request }) => {
    // needs-db: without a database the /tasks API 500s, and in dev mode the
    // Next.js error overlay (<nextjs-portal>) then intercepts bottom-nav
    // clicks on mobile. CI runs a prod build with Postgres — no overlay.
    test.skip(!(await dbAvailable(request)), "needs-db: no database in this environment");
    await dismissGuides(page);
    await page.goto("/");

    // Nav: Home, then the Build group (Tasks, Projects, Groups, Agents, Create), then
    // Mint and Docs ungrouped. ⚠️ Decisions was its own labelled "Govern" group
    // until 2026-08-21 — a labelled column for ONE link into a parked feature
    // — then ungrouped, then removed outright 2026-09-04 (bigdev's
    // instruction) along with the /decisions page itself. Leaderboard left the
    // chrome (route stays live, linked from the profile surface). Attached
    // even when a nav is hidden (desktop vs mobile variant).
    for (const label of ["Home", "Tasks", "Projects", "Groups", "Agents", "Create", "Mint", "Docs"]) {
      const link = page.locator(`nav a:has-text("${label}")`).first();
      await expect(link).toBeAttached();
    }

    await page.locator('nav a[href="/tasks"]:visible').first().click();
    await expect(page).toHaveURL(/\/tasks$/);

    await page.locator('nav a[href="/"]:visible').first().click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("mobile viewport renders correctly at 375px", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 667 },
    });
    const page = await context.newPage();
    await page.goto("/");

    // Mobile bottom nav should be visible
    const mobileNav = page.locator("nav.sm\\:hidden").first();
    await expect(mobileNav).toBeVisible();

    // Desktop nav should be hidden
    const desktopNav = page.locator("nav.hidden.sm\\:flex").first();
    await expect(desktopNav).toBeHidden();

    // Hero still visible
    await expect(
      page.getByRole("heading", { name: "Commission real work on Radix" })
    ).toBeVisible();

    await context.close();
  });

  test("header shows Radix Guild branding", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.locator("header").getByRole("link", { name: "Radix Guild" })
    ).toBeVisible();
  });

  test("footer shows Ledger link and Built on Radix", async ({ page }) => {
    // MVP-5 trim: the footer is Trust / Ledger / About / Bug Bounty / Gift.
    // Transparency (/docs#transparency) left the footer; the footer renders on
    // every viewport now, so no mobile skip.
    await page.goto("/");
    await expect(page.getByText("Built on Radix")).toBeVisible();
    await expect(
      page.locator("footer").getByRole("link", { name: "Ledger" })
    ).toBeVisible();
    // P9: dead GitHub link removed until source publishes — must not reappear
    await expect(page.locator("footer").getByText("GitHub")).toHaveCount(0);
  });

  test("dark mode is locked (forced theme beats a persisted 'light')", async ({ page }) => {
    // Dark-only by decision (2026-07-18): light mode shipped unreadable
    // primary text on money-critical addresses, so the toggle was removed and
    // the theme forced. The load-bearing half is forcedTheme: a visitor who
    // persisted "light" back when the toggle existed must still get dark.
    await page.goto("/");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.evaluate(() => localStorage.setItem("theme", "light"));
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("onboarding steps shown (1-2-3)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Connect Wallet")).toBeVisible();
    await expect(page.getByText("Mint Badge")).toBeVisible();
    await expect(page.getByText("Browse Tasks")).toBeVisible();
  });

  // The strip above is the WORKER's route. A poster needs one too (stranger
  // walkthrough 2026-09-17, finding 4) — and it must lead to a create form that
  // is usable signed out. Asserts the path, never the host.
  test("a poster has a route off the front page", async ({ page }) => {
    await page.goto("/");
    const posterPath = page.getByTestId("poster-path");
    await expect(posterPath).toBeVisible();
    await posterPath.getByRole("link", { name: /Draft a task/ }).click();
    await expect(page).toHaveURL(/\/tasks\/create$/);
    await expect(page.getByRole("heading", { name: "What needs doing?" })).toBeVisible();
  });

  test("feature cards are displayed", async ({ page }) => {
    await page.goto("/");
    // Asserted via each card's DESCRIPTION, not its title: the titles ("Task
    // Marketplace", "No Token") risk colliding with the guide catalogue's
    // titles (src/components/guides/guides.ts), where a page-wide title match
    // hits two nodes and trips Playwright's strict mode. The descriptions are
    // 1:1 with the three hero cards in src/app/page.tsx.
    await expect(page.getByText("Fund work in escrow, delivered on-chain")).toBeVisible();
    // Was "Portable reputation in your wallet" until 2026-09-20 — the badge records
    // membership; reputation lives in the Guild database. The false version must stay gone.
    await expect(page.getByText("A free membership NFT — your key to claim tasks")).toBeVisible();
    await expect(page.getByText("Portable reputation in your wallet")).toHaveCount(0);
    // Third card changed 2026-09-02: was "Community Governance — Vote on
    // proposals in Telegram", which survived the 2026-08-26 cull (#460) that
    // retired the programme it pointed at. A stranger's first three sentences
    // now carry the no-token fact instead. This assertion is what makes that a
    // deliberate change rather than a silent one — it went red on the copy edit,
    // which is exactly its job.
    await expect(page.getByText("Membership is a badge; work is paid in XRD")).toBeVisible();
    // And the retired pillar must not creep back in.
    await expect(page.getByText("Vote on proposals in Telegram")).toHaveCount(0);
  });
});
