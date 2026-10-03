import { test, expect, type Page } from "@playwright/test";
import { dismissGuides } from "./helpers";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 667 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1024, height: 768 },
  { name: "desktop", width: 1440, height: 900 },
];

// Post-P1 routes: / is home (no /dashboard), tasks live at /tasks.
// Admin/deploy are URL-reachable but out of nav. /decisions was removed
// 2026-09-04 (bigdev's instruction) along with the rest of the on-chain
// governance surface.
const PAGES = [
  { path: "/", name: "Home" },
  { path: "/tasks", name: "Tasks" },
  { path: "/leaderboard", name: "Leaderboard" },
  { path: "/mint", name: "Mint" },
  { path: "/admin", name: "Admin" },
];

async function checkNoHorizontalOverflow(page: Page) {
  return page.evaluate(() => {
    return (
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth
    );
  });
}

test.describe("Responsive Design", () => {
  for (const vp of VIEWPORTS) {
    for (const pg of PAGES) {
      test(`${pg.name} page at ${vp.width}px - no horizontal overflow`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
        });
        await dismissGuides(context);
        const page = await context.newPage();
        await page.goto(pg.path);
        // Let client effects settle (external API fetches resolve or fail);
        // networkidle is unreliable with third-party hosts, so wait on paint.
        await page.waitForTimeout(500);

        const hasOverflow = await checkNoHorizontalOverflow(page);
        expect(hasOverflow).toBe(false);

        await context.close();
      });
    }
  }

  test("mobile (375px) shows bottom nav with 4 links + More menu", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 667 },
    });
    const page = await context.newPage();
    await page.goto("/");

    // Mobile bottom nav should be visible
    const mobileNav = page.locator("nav.sm\\:hidden");
    await expect(mobileNav).toBeVisible();

    // 5-slot ceiling: 4 one-tap link destinations (Home, Tasks, Create, Mint)
    // plus a "More" menu button holding Projects/Groups/Docs.
    const navLinks = mobileNav.locator("a");
    await expect(navLinks).toHaveCount(4);
    await expect(
      mobileNav.getByRole("button", { name: "More navigation" })
    ).toBeVisible();

    await context.close();
  });

  test("mobile (375px) hides desktop nav", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 667 },
    });
    const page = await context.newPage();
    await page.goto("/");

    // Desktop nav should be hidden
    const desktopNav = page.locator("nav.hidden.sm\\:flex");
    await expect(desktopNav).toBeHidden();

    await context.close();
  });

  test("tablet (768px) shows the grouped desktop nav", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 768, height: 1024 },
    });
    const page = await context.newPage();
    await page.goto("/");

    // At 768px (≥ sm breakpoint), the grouped desktop nav shows
    const desktopNav = page.locator("nav.hidden.sm\\:flex");
    await expect(desktopNav).toBeVisible();
    await expect(desktopNav.getByText("Build")).toBeVisible();

    // ⚠️ This asserted a "Govern" group label until 2026-08-21, and correctly
    // went red when that group was ungrouped ("Govern" was a labelled column
    // with its own separator — the same visual weight as Build's four live
    // items — spent on ONE link into a surface whose own page opened "CV2 is
    // parked… voting is off"). The label went first, then the link itself:
    // /decisions was removed outright 2026-09-04 (bigdev's instruction). What
    // this test guards is now the remaining ungrouped destinations — Mint and
    // Docs — are still reachable at tablet width alongside the one remaining
    // group label.
    await expect(desktopNav.getByRole("link", { name: "Mint" })).toBeVisible();
    await expect(desktopNav.getByRole("link", { name: "Docs" })).toBeVisible();

    await context.close();
  });

  test("mobile touch targets are large enough (40px min)", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 667 },
    });
    const page = await context.newPage();
    await page.goto("/");

    // Check mobile nav link sizes
    const navLinks = page.locator("nav.sm\\:hidden a");
    const count = await navLinks.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const box = await navLinks.nth(i).boundingBox();
      if (box) {
        // Touch targets should be at least ~40px in one dimension
        expect(box.width >= 40 || box.height >= 40).toBe(true);
      }
    }

    await context.close();
  });

  test("desktop (1440px) tasks page shows header row and list area", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await dismissGuides(context);
    const page = await context.newPage();
    await page.goto("/tasks");

    await expect(
      page.getByRole("heading", { name: "Tasks", exact: true })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Task" })).toBeVisible();
    // Empty DB in CI → empty state; with data the responsive grid renders.
    const emptyState = page.getByText(
      /Be the first to post a task|No tasks match your filters/
    );
    const grid = page.locator("main .grid.sm\\:grid-cols-2").first();
    await expect(emptyState.or(grid)).toBeVisible({ timeout: 15000 });

    await context.close();
  });

  test("mobile (375px) feature cards stack vertically", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 667 },
    });
    const page = await context.newPage();
    await page.goto("/");

    // Feature grid should be single-column on mobile
    const grid = page.locator(".grid.grid-cols-1");
    const count = await grid.count();
    expect(count).toBeGreaterThan(0);

    await context.close();
  });
});
