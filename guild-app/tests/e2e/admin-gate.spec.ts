import { test, expect } from "@playwright/test";
import {
  dismissGuides,
  injectWalletMock,
  stubChainData,
  stubFungibleVaults,
  MOCK_ACCOUNT,
} from "./helpers";

// P2 added an operator gate on /admin. The gate is client-side surface hygiene
// (src/app/admin/page.tsx AdminGate) — real enforcement is the on-chain admin
// badge, checked by the blueprint; the UI just withholds the Badge Manager
// tooling until the connected wallet holds ADMIN_BADGE.
//
// The disconnected case needs neither a wallet nor a DB: `account` and the gate
// both initialise to the denied state, so the "connect the operator wallet" copy
// is on the first paint (no loading flash, no Gateway round-trip).
//
// ADMIN_BADGE is FUNGIBLE (supply 1, divisibility 0). Until 2026-09-23 the gate
// read it with the NFT lookup, which cannot see a fungible, so it denied
// everyone, the holder included, while this file (then only the disconnected
// case) stayed green. The connected cases use the wallet mock
// (helpers.ts injectWalletMock) and a canned Gateway answer for the holding read.

// config.ts's default. The e2e env does not set NEXT_PUBLIC_ADMIN_BADGE.
const ADMIN_BADGE = "resource_rdx1tkkzwrttvsqrsylyf4nqt2fxq6h27eva4lr4ffwad63x3f2cl43xwe";

test.describe("Admin route is operator-gated", () => {
  test("disconnected visitor sees the gate, not the Badge Manager", async ({ page }) => {
    await page.goto("/admin");

    // The gate card (CardTitle renders as a div, so match by text, not heading).
    await expect(page.getByText("Operator access")).toBeVisible();
    // Full sentence — unique to the no-account branch, so it can't be confused
    // with the header's generic "Connect" button or the connected-but-denied copy.
    await expect(
      page.getByText("Connect the operator wallet to open the badge manager.")
    ).toBeVisible();

    // The operator tooling (AdminContent's "Badge Manager" heading) must be
    // withheld — proves the gate actually gated rather than rendering the shell.
    await expect(page.getByRole("heading", { name: "Badge Manager" })).toHaveCount(0);
  });

  test.describe("with a connected wallet", () => {
    test.beforeEach(async ({ page }) => {
      await dismissGuides(page);
      await injectWalletMock(page);
      await stubChainData(page);
    });

    test("the badge holder gets the Badge Manager", async ({ page }) => {
      await stubFungibleVaults(page, ["1"]);
      const holdingRead = page.waitForRequest(
        (r) => r.method() === "POST" && r.url().endsWith("/state/entity/page/fungible-vaults/")
      );
      await page.goto("/admin");

      // The gate asked about THIS account's balance of THE operator badge.
      expect((await holdingRead).postDataJSON()).toEqual({
        address: MOCK_ACCOUNT,
        resource_address: ADMIN_BADGE,
      });
      await expect(page.getByRole("heading", { name: "Badge Manager" })).toBeVisible();
    });

    test("a wallet without the badge is told so and gets no tooling", async ({ page }) => {
      await stubFungibleVaults(page, []);
      await page.goto("/admin");

      await expect(page.getByText("This wallet doesn't hold the operator badge.")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Badge Manager" })).toHaveCount(0);
    });

    test("a Gateway failure fails closed without blaming the wallet", async ({ page }) => {
      // No fungible-vaults stub: stubChainData's Gateway catch-all answers 500.
      await page.goto("/admin");

      await expect(
        page.getByText("Couldn't check this wallet for the operator badge", { exact: false })
      ).toBeVisible();
      await expect(page.getByText("This wallet doesn't hold the operator badge.")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Badge Manager" })).toHaveCount(0);
    });
  });
});
