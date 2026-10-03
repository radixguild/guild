import { test, expect } from "@playwright/test";
import { dbAvailable, dismissGuides, stubChainData } from "./helpers";

test.describe("Landing Page & Onboarding", () => {
  test("shows welcome message when not connected", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Commission real work on Radix" })
    ).toBeVisible();
    await expect(page.getByText("Connect Wallet")).toBeVisible();
  });

  test("shows onboarding steps indicator", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Connect Wallet")).toBeVisible();
    await expect(page.getByText("Mint Badge")).toBeVisible();
    await expect(page.getByText("Browse Tasks")).toBeVisible();
  });

  test("navigation links work", async ({ page }) => {
    await dismissGuides(page);
    await page.goto("/");
    await page.locator('nav a[href="/tasks"]:visible').first().click();
    await expect(page).toHaveURL(/\/tasks$/);
  });

  test("theme defaults to dark", async ({ page }) => {
    await page.goto("/");
    const html = page.locator("html");
    await expect(html).toHaveClass(/dark/);
  });
});

test.describe("Task Marketplace", () => {
  test.beforeEach(async ({ page }) => {
    await dismissGuides(page);
  });

  test("shows empty state on a fresh database", async ({ page, request }) => {
    // needs-db: empty-DB list state requires the CI Postgres service.
    test.skip(!(await dbAvailable(request)), "needs-db: no database in this environment");
    await page.goto("/tasks");
    // Empty DB in CI → cold "Be the first to post a task" empty state; with
    // seeded data, cards render. (Filtered empty state reads differently.)
    const emptyState = page.getByText(
      /Be the first to post a task|No tasks match your filters/
    );
    const firstTaskCard = page
      .locator('main a[href^="/tasks/"]:not([href="/tasks/create"])')
      .first();
    await expect(emptyState.or(firstTaskCard)).toBeVisible({ timeout: 15000 });
  });

  test("filter controls are visible", async ({ page }) => {
    await page.goto("/tasks");
    // Filters live on the "All tasks" tab (task 89: /tasks defaults to the
    // Projects view instead).
    await page.getByRole("button", { name: /All tasks/i }).click();
    await expect(page.getByPlaceholder("Search tasks...")).toBeVisible();
    await expect(page.getByLabel("Filter tasks by status")).toBeVisible();
    await expect(page.getByLabel("Sort tasks")).toBeVisible();
  });

});

// Deliberately OUTSIDE the blocks that pre-dismiss guides via dismissGuides()
// — this test asserts the auto-open behavior that the helper suppresses.
test.describe("Guides — never cover the board uninvited", () => {
  // Until 2026-09-20 /tasks auto-opened this guide 2s after mount. For a first-time
  // visitor arriving from a shared link it covered the board before they had read a
  // line of it (the whole screen, on a phone). It is opt-in now, from the header "?".
  test("tasks guide does NOT auto-open for a first-time visitor", async ({ page }) => {
    await page.goto("/tasks");
    // Longer than the old 2s timer, so an auto-open would have fired.
    await page.waitForTimeout(3500);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("Profile Page", () => {
  // The badge lookup hits the live mainnet Gateway client-side and the page
  // skeleton stays up until it settles — stubChainData() (helpers.ts,
  // chain-stub) cans the Gateway's invalid-address 400.
  test.beforeEach(async ({ page }) => {
    await stubChainData(page);
  });

  // loadAllBadgesStrict (src/lib/gateway.ts) never asserts "no badge" off a
  // Gateway FAILURE — stubChainData's 400 makes every schema's read `ok:
  // false`, which is "unreadable", not "confirmed empty". The honest render
  // is neither the badge card nor the "No badge found" claim.
  test("shows neither a badge nor a not-found claim when the Gateway read fails", async ({ page }) => {
    // P1 moved profiles from /dashboard/profile/* to /profile/[address].
    await page.goto("/profile/account_rdx_invalid_123");
    // "Tasks Claimed" is unconditional — it renders once loading finishes
    // regardless of badge/summary state — so waiting for it first proves the
    // page actually settled past the skeleton before the absence checks
    // below run (an absence checked against a still-loading page would pass
    // vacuously).
    await expect(page.getByText("Tasks Claimed", { exact: false })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText("No badge found for this address.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Mint a Badge" })).toHaveCount(0);
  });

  // The genuinely-confirmed-empty case: every schema reads 200 with no badge
  // resource in the account's vaults — loadUserBadgeResult's `ok: true,
  // badge: null`. Only THEN is "No badge found" an honest claim.
  test("shows badge not found once the Gateway confirms the address holds none", async ({ page }) => {
    await page.route("**/state/entity/details", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ non_fungible_resources: { items: [] } }] }),
      }),
    );
    await page.goto("/profile/account_rdx1confirmedbadgelessaddresstest0000000");
    await expect(page.getByText("No badge found for this address.")).toBeVisible({
      timeout: 15000,
    });
    // The Mint button must NOT be here. This test used to assert the opposite,
    // and in doing so encoded a real bug: /mint mints to the CONNECTED wallet,
    // so offering it on a STRANGER's badgeless profile read as "fix their
    // missing badge" and would have minted your own. The page is visited
    // disconnected here, so it can never be the viewer's own profile.
    await expect(page.getByRole("button", { name: "Mint a Badge" })).toHaveCount(0);
  });
});

test.describe("Mobile Responsiveness", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("mobile bottom nav is visible", async ({ page }) => {
    await page.goto("/");
    // Mobile nav should be visible (the fixed bottom nav)
    const mobileNav = page.locator("nav.fixed");
    await expect(mobileNav).toBeVisible();
  });

  test("desktop nav is hidden on mobile", async ({ page }) => {
    await page.goto("/");
    const desktopNav = page.locator("nav.hidden.sm\\:flex");
    await expect(desktopNav).toBeHidden();
  });

  test("tasks page renders on mobile", async ({ page }) => {
    await dismissGuides(page);
    await page.goto("/tasks");
    // exact match — otherwise the substring matcher collides with the
    // error empty-state heading "Failed to load tasks" if the API fetch
    // fails, masking real failures behind a strict-mode violation.
    await expect(
      page.getByRole("heading", { name: "Tasks", exact: true })
    ).toBeVisible();
    // Filters live on the "All tasks" tab (task 89: /tasks defaults to the
    // Projects view instead).
    await page.getByRole("button", { name: /All tasks/i }).click();
    await expect(page.getByPlaceholder("Search tasks...")).toBeVisible();
  });
});

test.describe("Error Handling", () => {
  test("unknown numeric task ID shows not-found state", async ({ page, request }) => {
    // needs-db: the 404 path does a real DB lookup; without a database the
    // API 500s and the page shows the failed-to-load state instead.
    test.skip(!(await dbAvailable(request)), "needs-db: no database in this environment");
    await page.goto("/tasks/99999");
    await expect(page.getByText("Task not found")).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByRole("button", { name: "Back to Tasks" })
    ).toBeVisible();
  });
});
