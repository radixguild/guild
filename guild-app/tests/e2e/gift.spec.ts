import { test, expect } from "@playwright/test";

/**
 * Cold-user checks for /gift. Everything here runs against a REAL SWC build
 * (dev locally, `next build` in CI) — which matters, because two of the things
 * asserted below cannot be caught anywhere else: vitest compiles JSX with
 * esbuild, so a unit test would pass regardless of what ships.
 *
 * The destinations come from playwright.config.ts's webServer env (grep marker
 * e2e-gift-env) — fixtures, not real addresses. Without them /gift 404s by
 * design and every test here would pass vacuously, so the first test asserts
 * the page exists at all.
 */

const XRD_FIXTURE = "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw";
const BTC_FIXTURE = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";

test.describe("Gift page", () => {
  test("renders for a cold, wallet-less visitor", async ({ page }) => {
    const res = await page.goto("/gift");
    // Guards every other assertion in this file against a vacuous pass.
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Gifts", level: 1 })).toBeVisible();
  });

  test("loads without JS crashes", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto("/gift");
    await page.waitForTimeout(1000);
    const jsErrors = errors.filter(
      (e) => !e.includes("fetch") && !e.includes("Failed to fetch") && !e.includes("NetworkError"),
    );
    expect(jsErrors).toHaveLength(0);
  });

  test("shows each configured destination IN FULL, never truncated", async ({ page }) => {
    await page.goto("/gift");
    // Full string, because the visible address is the fallback when the
    // clipboard is unavailable and the only way a donor can check what they
    // pasted. A truncated "account_rdx12yh…z9sq" would defeat both.
    await expect(page.getByText(XRD_FIXTURE, { exact: true })).toBeVisible();
    await expect(page.getByText(BTC_FIXTURE, { exact: true })).toBeVisible();
  });

  test("offers a copy button and a scannable QR per crypto rail", async ({ page }) => {
    await page.goto("/gift");
    await expect(page.getByRole("button", { name: /copy address/i })).toHaveCount(2);
    // qrcode.react renders an <svg role="img"> with our title as its label.
    await expect(page.getByRole("img", { name: /radix account address/i })).toBeVisible();
    await expect(page.getByRole("img", { name: /bitcoin/i })).toBeVisible();
  });

  test("BTC presets rewrite the BIP-21 amount", async ({ page }) => {
    await page.goto("/gift");
    const openInWallet = page.getByRole("link", { name: /open in wallet/i });
    // Default is "Any amount": no amount param at all — NOT amount=0, which a
    // wallet would show as a zero-value send. The label stays either way, so
    // the donor's wallet names the payee instead of showing a bare address.
    await expect(openInWallet).toHaveAttribute("href", `bitcoin:${BTC_FIXTURE}?label=Radix+Guild`);

    await page.getByRole("button", { name: "0.001 BTC" }).click();
    await expect(openInWallet).toHaveAttribute(
      "href",
      `bitcoin:${BTC_FIXTURE}?amount=0.001&label=Radix+Guild`,
    );

    // Back to Any amount — the amount must be dropped, not left stale at 0.001.
    await page.getByRole("button", { name: /any amount/i }).click();
    await expect(openInWallet).toHaveAttribute("href", `bitcoin:${BTC_FIXTURE}?label=Radix+Guild`);
  });

  test("fiat rails link OUT and never collect card data on this site", async ({ page }) => {
    await page.goto("/gift");
    for (const name of [/gift by card/i, /gift via paypal/i]) {
      const link = page.getByRole("link", { name });
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", /noopener/);
    }
    // The page must never grow a card field — that is the whole point of
    // linking out. If this ever fails, someone added a payment form.
    await expect(page.locator('input[type="password"], input[autocomplete*="cc-"]')).toHaveCount(0);
  });

  test("states plainly that a gift buys nothing", async ({ page }) => {
    await page.goto("/gift");
    await expect(page.getByText(/a gift buys nothing/i)).toBeVisible();
    // Honest-copy guard: no outcome may be promised for money that buys nothing.
    await expect(page.getByText(/\b(guaranteed|guarantee)\b/i)).toHaveCount(0);
  });

  test("REGRESSION: the space after </strong> survives the SWC build", async ({ page }) => {
    await page.goto("/gift");
    // The <p>, not the <strong> inside it — getByText(/A gift buys nothing/)
    // resolves to the <strong>, whose text stops at the period and can never
    // show the join.
    const text = await page.locator("p", { hasText: /A gift buys nothing/ }).first().innerText();
    // SWC drops the leading whitespace of a JSX text node that contains an HTML
    // entity, so `<strong>…</strong> No token` ships as "nothing.No token"
    // (verified by A/B production build). page.tsx works around it with an
    // explicit {" "}. This is asserted end-to-end because vitest transforms JSX
    // with esbuild and would never reproduce it.
    expect(text).toMatch(/A gift buys nothing\.\s+No token/);
    expect(text).not.toMatch(/nothing\.No token/);
    // If SWC ever fixes the bug, the {" "} would double up — catch that too.
    expect(text).not.toMatch(/nothing\.\s{2,}No token/);
  });

  test("the footer links to /gift while a rail is live", async ({ page }) => {
    await page.goto("/");
    const footerLink = page.getByRole("contentinfo").getByRole("link", { name: "Gifts" });
    // Desktop-only footer — skip on the mobile project, where it is hidden by
    // design (`hidden sm:flex` in app-shell.tsx).
    const viewport = page.viewportSize();
    if (viewport && viewport.width >= 640) {
      await expect(footerLink).toBeVisible();
      await footerLink.click();
      await expect(page).toHaveURL(/\/gift$/);
    }
  });
});
