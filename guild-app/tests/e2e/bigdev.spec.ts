import { test, expect } from "@playwright/test";

/**
 * /bigdev — the operator's page. Two properties matter here beyond "it renders":
 *
 *  1. It must NOT 404 when gifts are dark. Unlike /gift, the bio is the point;
 *     the rails just disappear. (The dark case is covered by the unit tests in
 *     gift-guard.test.tsx — e2e pins the rails ON via playwright.config.ts.)
 *  2. It must stay handle-only. The identity guard below is deliberately dumb
 *     and deliberately cheap: it is a tripwire against a future edit quietly
 *     adding a name, a location, or an email to a public page.
 */

test.describe("bigdev page", () => {
  test("renders for a cold visitor and is reachable from /about", async ({ page }) => {
    await page.goto("/about");
    // .first(): /about links /bigdev twice on purpose — once in the Operator
    // card (in context, for scanners) and once at the foot of the page (for
    // readers who get to the end). Same name, same target, both fine.
    const link = page.getByRole("link", { name: /more about bigdev/i }).first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/bigdev$/);
    await expect(page.getByRole("heading", { name: "bigdev", level: 1 })).toBeVisible();
  });

  test("loads without JS crashes", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto("/bigdev");
    await page.waitForTimeout(1000);
    const jsErrors = errors.filter(
      (e) => !e.includes("fetch") && !e.includes("Failed to fetch") && !e.includes("NetworkError"),
    );
    expect(jsErrors).toHaveLength(0);
  });

  test("the gift section sits BELOW the bio, not above it", async ({ page }) => {
    await page.goto("/bigdev");
    // A reader should know who they are giving to before being asked. Compare
    // document positions rather than trusting source order.
    const bio = page.getByText(/Solo developer, building on Radix/);
    const gifts = page.getByRole("heading", { name: "Gifts", level: 2 });
    await expect(bio).toBeVisible();
    await expect(gifts).toBeVisible();
    const bioBox = await bio.boundingBox();
    const giftBox = await gifts.boundingBox();
    expect(bioBox!.y).toBeLessThan(giftBox!.y);
  });

  test("carries the same gift disclosure as /gift — never rails without it", async ({ page }) => {
    await page.goto("/bigdev");
    await expect(page.getByText(/a gift buys nothing/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /copy address/i })).toHaveCount(2);
    // Honest-copy guard, same as the /gift spec.
    await expect(page.getByText(/\b(guaranteed|guarantee)\b/i)).toHaveCount(0);
  });

  test("IDENTITY GUARD: handle-only, nothing that could dox the operator", async ({ page }) => {
    await page.goto("/bigdev");
    const body = (await page.locator("body").innerText()).toLowerCase();

    // The public identity, and the only identity.
    expect(body).toContain("@bigdev_xrd");
    expect(body).toContain("@bigdevxrd");

    // No contact address of any kind beyond the published handles: an email on
    // a public page is a permanent, un-rotatable identifier.
    expect(body).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);

    // No hard stats — /about's Operator card drifted on every one of them, two
    // into overclaiming. If someone adds "N tests" or "N commits" here, this
    // fails and they have to go and make it true instead.
    expect(body).not.toMatch(/\d+\+?\s*(commits|tests|endpoints|commands|pages)\b/);
  });
});
