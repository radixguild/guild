import { test, expect } from "@playwright/test";

/**
 * Can a human actually GET to these pages?
 *
 * This suite exists because a route audit found /about ↔ /bigdev forming a
 * closed two-node cycle — /about's only inbound links were /bigdev and /start,
 * and /start itself had zero inbound links anywhere — while /gift was reachable
 * ONLY from a footer that is `hidden sm:flex`. So on a phone there was no path
 * to a donation surface at all, and the bio was unreachable from anywhere a
 * reader would start. /guide (Help menu — it absorbed /start in the MVP-5
 * merge) and /bug-bounty (footer + /trust) are linked and pinned below too.
 * Rendering correctly is worth nothing if nobody can arrive.
 *
 * Runs under both the `chromium` (desktop) and `mobile-chrome` (Pixel 5)
 * projects — the mobile one is the point, so nothing here may be desktop-only.
 */

test.describe("reachability", () => {
  test("the footer renders on every viewport, mobile included", async ({ page }) => {
    await page.goto("/");
    const footer = page.getByRole("contentinfo");
    // Was `hidden sm:flex`. If this regresses, /gift silently becomes
    // unreachable on phones again and no other test notices.
    await expect(footer).toBeVisible();
  });

  test("a mobile visitor can reach /gift by tapping, not by typing the URL", async ({ page }) => {
    await page.goto("/");
    const giftLink = page.getByRole("contentinfo").getByRole("link", { name: "Gifts" });
    await expect(giftLink).toBeVisible();
    await giftLink.click();
    await expect(page).toHaveURL(/\/gift$/);
    await expect(page.getByRole("heading", { name: "Gifts", level: 1 })).toBeVisible();
  });

  test("footer links are not obscured by the fixed mobile bottom nav", async ({ page }) => {
    await page.goto("/");
    // The bottom nav is `fixed bottom-0` and 56px tall; the footer carries
    // pb-20 to clear it. A footer link whose box overlaps the nav would be
    // visible-but-untappable — the worst failure mode, since it looks fine.
    const link = page.getByRole("contentinfo").getByRole("link", { name: "About" });
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    const viewport = page.viewportSize()!;
    const isMobile = viewport.width < 640;
    if (isMobile) {
      const navTop = viewport.height - 56;
      // Scroll it into view first, then assert it isn't sitting under the nav.
      await link.scrollIntoViewIfNeeded();
      const scrolled = await link.boundingBox();
      expect(scrolled!.y + scrolled!.height).toBeLessThanOrEqual(navTop);
    }
    expect(box).not.toBeNull();
  });

  test("/about is reachable from the footer on every viewport", async ({ page }) => {
    await page.goto("/");
    // The MVP-5 trim collapsed the Help menu to Getting started / Docs /
    // Telegram, so the footer — which renders on every viewport — is now the
    // chrome link that un-orphans the /about ↔ /bigdev cycle. If /about ever
    // leaves the footer, this is the test that must go red.
    const about = page.getByRole("contentinfo").getByRole("link", { name: "About" });
    await expect(about).toBeVisible();
    await about.click();
    await expect(page).toHaveURL(/\/about$/);
  });

  test("/guide is reachable from the Help menu on every viewport", async ({ page }) => {
    await page.goto("/");
    // /guide absorbed /start (the New-to-Radix onboarding) and /how-it-works
    // in the MVP-5 merge — the Help menu renders on mobile too, so the single
    // onboarding surface stays one tap away on every viewport.
    await page.getByRole("button", { name: "Help" }).click();
    const guide = page.getByRole("menuitem", { name: /getting started/i });
    await expect(guide).toBeVisible();
    await guide.click();
    await expect(page).toHaveURL(/\/guide$/);
    await expect(page.getByRole("heading", { name: /welcome to/i, level: 1 })).toBeVisible();
  });

  test("a visitor can reach /bug-bounty from the footer on every viewport", async ({ page }) => {
    await page.goto("/");
    // /bug-bounty was only ever plain prose on /trust, never a link. The footer
    // renders on every viewport, so it's now tappable on mobile too.
    const bounty = page.getByRole("contentinfo").getByRole("link", { name: "Bug Bounty" });
    await expect(bounty).toBeVisible();
    await bounty.click();
    await expect(page).toHaveURL(/\/bug-bounty$/);
    await expect(page.getByRole("heading", { name: "Bug Bounty", level: 1 })).toBeVisible();
  });

  test("/bug-bounty is also linked from the /trust backing plan", async ({ page }) => {
    await page.goto("/trust");
    await page.getByRole("link", { name: "/bug-bounty" }).click();
    await expect(page).toHaveURL(/\/bug-bounty$/);
  });

  test("/about → /bigdev, and /bigdev → back to /about", async ({ page }) => {
    await page.goto("/about");
    await page.getByRole("link", { name: /more about bigdev/i }).first().click();
    await expect(page).toHaveURL(/\/bigdev$/);
    await page.getByRole("link", { name: /about radix guild/i }).click();
    await expect(page).toHaveURL(/\/about$/);
  });

  test("the sitemap lists the pages a crawler should find", async ({ request }) => {
    const res = await request.get("/sitemap.xml");
    expect(res.status()).toBe(200);
    const xml = await res.text();
    // Host-AGNOSTIC: the <loc> origin is NEXT_PUBLIC_SITE_URL (radixguild.com
    // in prod/CI, localhost only when a dev sets it), so assert the PATHS, not
    // a baked-in host. Parse every <loc>, strip the origin, compare the set —
    // stricter than a substring and it can't false-fail on the deploy host.
    const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
    for (const path of ["/about", "/bigdev", "/gift"]) {
      expect(paths).toContain(path);
    }
  });
});
