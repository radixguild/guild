import { test, expect, type Page, type Route } from "@playwright/test";
import { injectWalletMock, MOCK_ACCOUNT } from "./helpers";
import {
  burnListingReceiptManifest,
  cancelSwapManifest,
  extendSwapListingManifest,
  fillSwapManifest,
  listSwapManifest,
  withdrawSwapProceedsManifest,
} from "../../src/lib/manifests";
import { NFT_SWAP_PACKAGE } from "../../src/lib/config";
import { expiryForDays, extendedExpiry, shortAddress } from "../../src/lib/nft-swap";
import { BOARD_COPY, DETAIL_COPY } from "../../src/content/swaps";

// The NFT swap wallet flows (P7-04), end to end in a browser with the mock
// wallet (helpers.ts, grep marker e2e-wallet-mock): what the page SENDS to the
// wallet must be byte-identical to the builder the unit suite pins to the
// mainnet proving run (tests/unit/nft-swap-manifests.test.ts).
//
// Nothing here reaches the ledger. The listing page's chain reads come from
// our own API, so those are stubbed at /api/v1/swaps/*; the List page reads
// the Gateway from the browser, so those are stubbed at the Gateway host.

const SWAP = "component_rdx1cq80zarwh84mmrkn95xc7glgg5yvz0vkvqs9amxsnpwxuhkldd5mp4";
const RECEIPT = "resource_rdx1nfq47l0t7glmntfjuandqdmlejzvffq4cvlvrha94kqr52mdrvt2e7";
const NFT = "resource_rdx1ng3k9ll8yygujlamrszv5qu58nv9kqtala6cry2xql4006ccyrykdk";
const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";
// A row of src/lib/common-tokens.ts (EARLY), and a fungible token that is not on that list.
const EARLY = "resource_rdx1t5xv44c0u99z096q00mv74emwmxwjw26m98lwlzq6ddlpe9f5cuc7s";
const OTHER_TOKEN = "resource_rdx1t" + "c".repeat(40) + "0003";
const SELLER = "account_rdx12y6ch4m8wjcgu7hrnwfqjeqt70w4kh7qy7k3gs2j9wyx3596fgt3fm";
const LEDGER_ISO = "2026-10-06T07:00:00.000Z";
const LEDGER = Date.parse(LEDGER_ISO) / 1000;

const RESOURCES = {
  [XRD]: { kind: "fungible", divisibility: 18, name: "Radix", symbol: "XRD", iconUrl: null, withdraw: "open" },
  [NFT]: { kind: "nonFungible", divisibility: null, name: "Guild Swap Throwaway NFT", symbol: null, iconUrl: null, withdraw: "open" },
  [EARLY]: { kind: "fungible", divisibility: 18, name: "EARLY", symbol: "EARLY", iconUrl: null, withdraw: "open" },
  [OTHER_TOKEN]: { kind: "fungible", divisibility: 18, name: "Some Token", symbol: "SOME", iconUrl: null, withdraw: "open" },
};

const ASKS = [
  { kind: "fungible" as const, resource: XRD, amount: "5000" },
  { kind: "nonFungible" as const, resource: NFT, id: "#1#" },
];

function detail(receiptHolder: string, over: { listing?: object; askNfts?: object } = {}) {
  const base = {
    ok: true,
    data: {
      component: SWAP,
      receiptResource: RECEIPT,
      ledgerTime: LEDGER,
      fees: { fill: { unit: "XRD", amount: "0" }, extend: { unit: "XRD", amount: "0" } },
      resources: RESOURCES,
      listing: {
        listingId: 3,
        seller: SELLER,
        assetResource: NFT,
        assetId: "#2#",
        asks: ASKS,
        createdAt: LEDGER - 3600,
        expiresAt: LEDGER + 7 * 86400,
        state: "Listed",
        filledWith: null,
        proceedsWithdrawn: false,
        status: "open",
        asset: { name: "Guild swap throwaway 2", imageUrl: null },
        hidden: false,
      },
      receipt: { holder: receiptHolder, burned: false },
      askNfts: {},
    },
  };
  Object.assign(base.data.listing, over.listing ?? {});
  Object.assign(base.data.askNfts, over.askNfts ?? {});
  return base;
}

async function sentManifests(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __GUILD_E2E_SENT_MANIFESTS__: string[] }).__GUILD_E2E_SENT_MANIFESTS__);
}

async function stubDetail(page: Page, receiptHolder: string, over: Parameters<typeof detail>[1] = {}) {
  await page.route("**/api/v1/swaps/3", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detail(receiptHolder, over)) }),
  );
}

/** The detail page's own stamp format (swap-bits.tsx utcStamp), kept here so
 *  the spec does not import a client component. */
const stamp = (secs: number) => new Date(secs * 1000).toISOString().replace("T", " ").replace(/:\d\d\.\d{3}Z$/, " UTC");

// Every button that sends a transaction from the listing page.
const TX_BUTTONS = /^(Fill|Fill with this|Cancel listing|Extend by 30 days|Withdraw .*|Burn the listing receipt)$/;

test.describe("NFT swap — the listing page", () => {
  test("after a fill the page re-reads until the ledger shows it, then drops the Fill panel", async ({ page }) => {
    await injectWalletMock(page);
    let filled = false;
    await page.route("**/api/v1/swaps/3", async (route) => {
      // The first re-read after the fill still answers Listed (a lagging
      // Gateway read); the next one shows the fill.
      const sent = (await sentManifests(page)).length;
      const body = sent > 0 && filled ? detail(SELLER, { listing: { state: "Filled", filledWith: 0, status: "filled" } }) : detail(SELLER);
      if (sent > 0) filled = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/swaps/3");
    await page.getByRole("button", { name: "Fill with this" }).first().click();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Open my wallet to fill" }).click();
    await expect(page.getByText("Filled — the NFT is in your account.")).toBeVisible();
    await expect(page.getByText("This listing has been filled.")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Fill with this" })).toHaveCount(0);
  });

  test("a hidden listing offers no Fill, but its receipt holder keeps Cancel", async ({ page }) => {
    await injectWalletMock(page);
    await page.route("**/api/v1/swaps/3", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(detail(MOCK_ACCOUNT, { listing: { hidden: true, asset: { name: null, imageUrl: null } } })),
      }),
    );
    await page.goto("/swaps/3");
    await expect(page.getByText(/hidden this listing from this site/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Fill/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel listing" })).toBeVisible();
  });

  test("an alternative naming a burned NFT is marked and gets no Fill button", async ({ page }) => {
    await injectWalletMock(page);
    await page.route("**/api/v1/swaps/3", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(detail(SELLER, { askNfts: { [`${NFT} #1#`]: { name: "Guild swap throwaway 1", imageUrl: null, burned: true } } })),
      }),
    );
    await page.goto("/swaps/3");
    await expect(page.getByText("That NFT has been burned, so this alternative can never be filled.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Fill with this" })).toHaveCount(1);
  });

  test("Fill sends exactly the fill for the chosen alternative, after the confirm box", async ({ page }) => {
    await injectWalletMock(page);
    await stubDetail(page, SELLER);
    await page.goto("/swaps/3");

    await expect(page.getByRole("heading", { level: 1, name: "Swap listing 3" })).toBeVisible();
    await expect(page.getByText("Guild swap throwaway 2")).toBeVisible();
    // A buyer is not the receipt holder: no seller panel.
    await expect(page.getByRole("button", { name: "Cancel listing" })).toHaveCount(0);

    await page.getByRole("button", { name: "Fill with this" }).first().click();
    const go = page.getByRole("button", { name: "Open my wallet to fill" });
    await expect(go).toBeDisabled();
    await page.getByRole("checkbox").check();
    await go.click();

    await expect.poll(async () => (await sentManifests(page)).length).toBe(1);
    expect((await sentManifests(page))[0]).toBe(fillSwapManifest(SWAP, MOCK_ACCOUNT, 3, 0, ASKS[0]));
    await expect(page.getByText("Filled — the NFT is in your account.")).toBeVisible();
  });

  test("the receipt holder gets Cancel, and it sends the cancel call", async ({ page }) => {
    await injectWalletMock(page);
    await stubDetail(page, MOCK_ACCOUNT);
    await page.goto("/swaps/3");

    await page.getByRole("button", { name: "Cancel listing" }).click();
    await expect.poll(async () => (await sentManifests(page)).length).toBe(1);
    expect((await sentManifests(page))[0]).toBe(cancelSwapManifest(SWAP, MOCK_ACCOUNT, RECEIPT, 3));
  });

  // ASKS[1] is the non-fungible alternative: a wiring slip that always sent
  // alternative 0 would have the buyer confirm one payment and sign another.
  test("Fill with the second alternative sends that alternative, and a new pick clears the confirm box", async ({ page }) => {
    await injectWalletMock(page);
    await stubDetail(page, SELLER);
    await page.goto("/swaps/3");

    const picks = page.getByRole("button", { name: "Fill with this" });
    await picks.nth(0).click();
    await page.getByRole("checkbox").check();
    await picks.nth(1).click();
    await expect(page.getByRole("checkbox")).not.toBeChecked();
    await expect(page.getByText(/^You send exactly/)).toContainText("NFT #1# of Guild Swap Throwaway NFT");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Open my wallet to fill" }).click();

    await expect.poll(async () => (await sentManifests(page)).length).toBe(1);
    expect((await sentManifests(page))[0]).toBe(fillSwapManifest(SWAP, MOCK_ACCOUNT, 3, 1, ASKS[1]));
  });

  // nft_swap.rs keeps cancel and extend open after expiry so the NFT is never
  // stranded: the seller panel keys on the chain state (Listed), not on the
  // status at the ledger clock.
  test("an expired listing offers its receipt holder Extend and Cancel, and no Fill", async ({ page }) => {
    await injectWalletMock(page);
    const expired = { listing: { status: "expired", expiresAt: LEDGER - 60 } };
    const extendedAt = extendedExpiry({ expiresAt: LEDGER - 60 } as never, LEDGER);
    await page.route("**/api/v1/swaps/3", async (route) => {
      // Once Extend is sent, the ledger shows the new expiry, so the page settles.
      const sent = (await sentManifests(page)).length;
      const body = sent > 0 ? detail(MOCK_ACCOUNT, { listing: { expiresAt: extendedAt } }) : detail(MOCK_ACCOUNT, expired);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/swaps/3");

    await expect(page.getByText(DETAIL_COPY.expired)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Fill/ })).toHaveCount(0);
    // Measured from the ledger clock, since the old expiry is already past.
    await expect(page.getByText(/Extending moves the expiry to/)).toContainText(stamp(LEDGER + 30 * 86400));

    await page.getByRole("button", { name: "Extend by 30 days" }).click();
    await expect.poll(async () => (await sentManifests(page)).length).toBe(1);
    expect((await sentManifests(page))[0]).toBe(extendSwapListingManifest(SWAP, MOCK_ACCOUNT, RECEIPT, 3));
    await expect(page.getByText("Extended.")).toBeVisible();

    const cancel = page.getByRole("button", { name: "Cancel listing" });
    await expect(cancel).toBeEnabled({ timeout: 10_000 });
    await cancel.click();
    await expect.poll(async () => (await sentManifests(page)).length).toBe(2);
    expect((await sentManifests(page))[1]).toBe(cancelSwapManifest(SWAP, MOCK_ACCOUNT, RECEIPT, 3));
  });

  // Withdraw is the leg that pays the seller: its label must name the
  // alternative that actually filled (filledWith), and it must send withdraw.
  test("a filled listing's receipt holder withdraws the alternative that filled it; no Burn while owed", async ({ page }) => {
    await injectWalletMock(page);
    await stubDetail(page, MOCK_ACCOUNT, { listing: { state: "Filled", filledWith: 1, status: "filled" } });
    await page.goto("/swaps/3");

    await expect(page.getByRole("button", { name: "Burn the listing receipt" })).toHaveCount(0);
    await page.getByRole("button", { name: "Withdraw NFT #1# of Guild Swap Throwaway NFT" }).click();
    await expect.poll(async () => (await sentManifests(page)).length).toBe(1);
    expect((await sentManifests(page))[0]).toBe(withdrawSwapProceedsManifest(SWAP, MOCK_ACCOUNT, RECEIPT, 3));
  });

  test("a cancelled listing's receipt holder can burn the receipt, and it sends the burn", async ({ page }) => {
    await injectWalletMock(page);
    await stubDetail(page, MOCK_ACCOUNT, { listing: { state: "Cancelled", status: "cancelled" } });
    await page.goto("/swaps/3");

    await expect(page.getByRole("button", { name: /^Withdraw/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Burn the listing receipt" }).click();
    await expect.poll(async () => (await sentManifests(page)).length).toBe(1);
    expect((await sentManifests(page))[0]).toBe(burnListingReceiptManifest(SWAP, MOCK_ACCOUNT, RECEIPT, 3));
  });

  // A Gateway read that never catches up: acting on the old view would only
  // send a transaction that reverts, so every button stays off.
  test("when the ledger read never shows the fill, the page says it may be behind and sends nothing more", async ({ page }) => {
    test.setTimeout(45_000);
    await injectWalletMock(page);
    let reads = 0;
    await page.route("**/api/v1/swaps/3", (route) => {
      reads++;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detail(MOCK_ACCOUNT)) });
    });
    await page.goto("/swaps/3");
    await page.getByRole("button", { name: "Fill with this" }).first().click();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Open my wallet to fill" }).click();
    await expect(page.getByText(DETAIL_COPY.waiting)).toBeVisible();

    const behind = page.getByText(/This may not show your latest transaction yet/);
    await expect(behind).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(DETAIL_COPY.behind).first()).toBeVisible();
    const buttons = page.getByRole("button", { name: TX_BUTTONS });
    expect(await buttons.count()).toBeGreaterThan(0);
    for (const b of await buttons.all()) await expect(b).toBeDisabled();
    expect((await sentManifests(page)).length).toBe(1);

    const before = reads;
    await behind.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => reads).toBeGreaterThan(before);
  });

  // The exhausted settle loop keeps its predicate: "Try again" re-reads against
  // it, and a read that still shows the pre-transaction view leaves every
  // button disabled (a second Extend would charge the royalty twice).
  test("Try again answered with the same old view keeps every transaction button disabled", async ({ page }) => {
    test.setTimeout(45_000);
    await injectWalletMock(page);
    await stubDetail(page, MOCK_ACCOUNT);
    await page.goto("/swaps/3");
    await page.getByRole("button", { name: "Extend by 30 days" }).click();
    const behind = page.getByText(/This may not show your latest transaction yet/);
    await expect(behind).toBeVisible({ timeout: 20_000 });
    await behind.getByRole("button", { name: "Try again" }).click();
    await page.waitForTimeout(2_000);
    await expect(page.getByRole("button", { name: "Extend by 30 days" })).toBeDisabled();
  });

  test("detail 502 LISTING_UNREADABLE and 404 NOT_FOUND show the API's refusal, never a listing", async ({ page }) => {
    await injectWalletMock(page);
    const refusals = [
      [502, "LISTING_UNREADABLE", "Listing #3 exists on chain but its record did not match the shape this site reads, so nothing is shown rather than a guess."],
      [404, "NOT_FOUND", "No listing #3 on the swap component"],
    ] as const;
    for (const [status, code, message] of refusals) {
      await page.unrouteAll();
      await page.route("**/api/v1/swaps/3", (route) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code, message } }) }),
      );
      await page.goto("/swaps/3");
      await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
      await expect(page.getByRole("button", { name: TX_BUTTONS })).toHaveCount(0);
    }
  });

  // The service serves a hidden listing XRD's display data only (unit-tested
  // in nft-swap-gateway.test.ts); the page must still render every ask, by
  // address and id, and not name the collection from anything else it holds.
  test("a hidden listing names no collection and shows its NFT and token asks by address and id", async ({ page }) => {
    await injectWalletMock(page);
    const ASK_NFT = "resource_rdx1n" + "a".repeat(40) + "0001";
    const TOKEN = "resource_rdx1t" + "b".repeat(40) + "0002";
    await stubDetail(page, SELLER, {
      listing: {
        hidden: true,
        asset: { name: null, imageUrl: null },
        asks: [
          { kind: "nonFungible", resource: ASK_NFT, id: "#7#" },
          { kind: "fungible", resource: TOKEN, amount: "1" },
        ],
      },
    });
    await page.goto("/swaps/3");

    await expect(page.getByRole("heading", { level: 2, name: "NFT #2#" })).toBeVisible();
    await expect(page.getByText(`NFT #7# of ${shortAddress(ASK_NFT)}`)).toBeVisible();
    await expect(page.getByText(`1 ${shortAddress(TOKEN)}`)).toBeVisible();
    await expect(page.getByText("Guild Swap Throwaway NFT")).toHaveCount(0);
    await expect(page.locator("main img")).toHaveCount(0);
  });

  // The page looks up display data for the first 8 asks only; the rest must
  // still be shown, and fillable, by address and id — not dropped.
  test("a listing with more than 8 asks renders the later ones by address and id", async ({ page }) => {
    await injectWalletMock(page);
    const COLL = "resource_rdx1n" + "c".repeat(40) + "0003";
    const asks = [
      ...Array.from({ length: 8 }, () => ASKS[0]).map((a, i) => ({ ...a, amount: String(i + 1) })),
      { kind: "nonFungible", resource: COLL, id: "#9#" },
      { kind: "nonFungible", resource: COLL, id: "#10#" },
    ];
    await stubDetail(page, SELLER, { listing: { asks } });
    await page.goto("/swaps/3");

    await expect(page.getByText(`NFT #9# of ${shortAddress(COLL)}`)).toBeVisible();
    await expect(page.getByText(`NFT #10# of ${shortAddress(COLL)}`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Fill with this" })).toHaveCount(10);
  });
});

test.describe("NFT swap — the board", () => {
  const board = (over: object) => ({
    ok: true,
    data: {
      component: SWAP,
      receiptResource: RECEIPT,
      ledgerTime: LEDGER,
      fees: { fill: { unit: "XRD", amount: "0" }, extend: { unit: "XRD", amount: "0" } },
      resources: {},
      total: 7,
      truncated: false,
      unreadable: [],
      hidden: 0,
      listings: [],
      nextCursor: null,
      ...over,
    },
  });
  const stubBoard = (page: Page, status: number, body: unknown) =>
    page.route(/\/api\/v1\/swaps\?/, (route) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }),
    );

  test("a board the chain could not read says so, never 'Nothing is listed'", async ({ page }) => {
    await stubBoard(page, 503, { ok: false, error: { code: "CHAIN_UNREADABLE", message: "The swap component could not be read" } });
    await page.goto("/swaps");
    await expect(page.getByRole("alert").filter({ hasText: BOARD_COPY.unreadable })).toBeVisible();
    await expect(page.getByText(BOARD_COPY.empty.open)).toHaveCount(0);
  });

  test("listings that exist but do not parse fail closed, never 'Nothing is listed'", async ({ page }) => {
    await stubBoard(page, 200, board({ unreadable: [7] }));
    await page.goto("/swaps");
    await expect(page.getByRole("alert").filter({ hasText: BOARD_COPY.unreadableListings(1) })).toBeVisible();
    await expect(page.getByText(BOARD_COPY.empty.open)).toHaveCount(0);
  });
});

// ── The List page reads the Gateway from the browser ─────────────────────────

const GATEWAY = "https://mainnet.radixdlt.com";
const ledgerState = { network: "mainnet", state_version: 1, proposer_round_timestamp: LEDGER_ISO };

/** `packageAddress`: what the live component reports it was instantiated
 *  from; `accountNfts`: the account's non-fungibles response, when a test
 *  needs another shape. */
async function stubGateway(page: Page, opts: { packageAddress?: string; accountNfts?: () => unknown } = {}) {
  await page.route(`${GATEWAY}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() ?? {};
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });

    if (path === "/state/entity/details") {
      const items = (body.addresses as string[]).flatMap((address) => {
        if (address === SWAP) {
          return [{
            address,
            details: {
              type: "Component",
              blueprint_name: "NftSwap",
              package_address: opts.packageAddress ?? NFT_SWAP_PACKAGE,
              state: {
                fields: [
                  { field_name: "listings", value: "internal_keyvaluestore_rdx1kp9yd7edwqrzn5gnwzc38drdmy8tnjpn864a3v4538tmtxky2x5cqp" },
                  { field_name: "next_listing_id", value: "3" },
                  { field_name: "listing_receipt_manager", value: RECEIPT },
                ],
              },
              royalty_config: { is_enabled: true, method_rules: [{ method_name: "fill", royalty_amount: { unit: "XRD", amount: "0" } }] },
            },
          }];
        }
        const r = RESOURCES[address as keyof typeof RESOURCES];
        if (!r) return [];
        return [{
          address,
          metadata: { items: [{ key: "name", value: { typed: { value: r.name } } }, ...(r.symbol ? [{ key: "symbol", value: { typed: { value: r.symbol } } }] : [])] },
          details: {
            type: r.kind === "fungible" ? "FungibleResource" : "NonFungibleResource",
            divisibility: r.divisibility ?? undefined,
            role_assignments: { entries: [{ role_key: { name: "withdrawer" }, assignment: { explicit_rule: { type: "AllowAll" } } }] },
          },
        }];
      });
      return json({ ledger_state: ledgerState, items });
    }
    if (path === "/state/entity/page/non-fungibles") {
      if (opts.accountNfts) return json(opts.accountNfts());
      return json({ ledger_state: ledgerState, items: [{ resource_address: NFT, vaults: { items: [{ items: ["#2#"] }] } }] });
    }
    if (path === "/state/non-fungible/data") {
      return json({
        ledger_state: ledgerState,
        non_fungible_ids: [{ non_fungible_id: "#2#", is_burned: false, data: { programmatic_json: { fields: [{ field_name: "name", value: "Guild swap throwaway 2" }] } } }],
      });
    }
    if (path === "/transaction/committed-details") {
      return json({
        transaction: {
          transaction_status: "CommittedSuccess",
          receipt: {
            events: [{
              name: "ListedEvent",
              emitter: { entity: { entity_address: SWAP } },
              data: { fields: [{ field_name: "listing_id", kind: "U64", value: "3" }] },
            }],
          },
        },
      });
    }
    // Anything else the page asks the Gateway (the header's badge lookup) gets
    // an empty, well-formed answer rather than a live mainnet read.
    return json({ ledger_state: ledgerState, items: [] });
  });
}

test.describe("NFT swap — List an NFT", () => {
  test("pick, price, sign: the page sends the list call and lands on the new listing", async ({ page }) => {
    await injectWalletMock(page);
    await stubGateway(page);
    await stubDetail(page, MOCK_ACCOUNT);
    await page.goto("/swaps/list");

    await expect(page.getByRole("heading", { level: 1, name: "List an NFT" })).toBeVisible();
    const go = page.getByRole("button", { name: "Open my wallet to list" });
    await expect(go).toBeDisabled();

    await page.getByRole("button", { name: /Guild swap throwaway 2/ }).click();
    await page.getByLabel("Alternative 1 amount").fill("5000");
    await expect(page.getByText("Radix (XRD)")).toBeVisible();
    await expect(go).toBeEnabled();
    await go.click();

    await expect.poll(async () => (await sentManifests(page)).length).toBe(1);
    expect((await sentManifests(page))[0]).toBe(
      listSwapManifest(SWAP, MOCK_ACCOUNT, NFT, "#2#", [{ kind: "fungible", resource: XRD, amount: "5000" }], expiryForDays(LEDGER, 7)),
    );
    await expect(page).toHaveURL(/\/swaps\/3\?listed=1$/);
  });

  // The "Common tokens" select only pre-fills the address; what is sent is
  // the address, looked up on the Gateway like any other.
  test("Common tokens: picking EARLY lists for EARLY's resource address", async ({ page }) => {
    await injectWalletMock(page);
    await stubGateway(page);
    await stubDetail(page, MOCK_ACCOUNT);
    await page.goto("/swaps/list");

    await page.getByRole("button", { name: /Guild swap throwaway 2/ }).click();
    await page.getByLabel("Alternative 1 amount").fill("250");
    await expect(page.getByLabel("Alternative 1 token", { exact: true })).toHaveValue(XRD);
    await page.getByLabel("Alternative 1 token", { exact: true }).selectOption(EARLY);
    await expect(page.getByText("EARLY (EARLY)")).toBeVisible();
    await expect(page.getByLabel("Alternative 1 token address")).toHaveCount(0);
    const go = page.getByRole("button", { name: "Open my wallet to list" });
    await expect(go).toBeEnabled();
    await go.click();

    await expect.poll(async () => (await sentManifests(page)).length).toBe(1);
    expect((await sentManifests(page))[0]).toBe(
      listSwapManifest(SWAP, MOCK_ACCOUNT, NFT, "#2#", [{ kind: "fungible", resource: EARLY, amount: "250" }], expiryForDays(LEDGER, 7)),
    );
  });

  test("Common tokens: Other opens a free-text address, and that address is what is sent", async ({ page }) => {
    await injectWalletMock(page);
    await stubGateway(page);
    await stubDetail(page, MOCK_ACCOUNT);
    await page.goto("/swaps/list");

    await page.getByRole("button", { name: /Guild swap throwaway 2/ }).click();
    await page.getByLabel("Alternative 1 amount").fill("7");
    await page.getByLabel("Alternative 1 token", { exact: true }).selectOption("other");
    const address = page.getByLabel("Alternative 1 token address");
    await expect(address).toHaveValue("");
    const go = page.getByRole("button", { name: "Open my wallet to list" });
    await expect(go).toBeDisabled();
    await address.fill(OTHER_TOKEN);
    await expect(page.getByText("Some Token (SOME)")).toBeVisible();
    await expect(page.getByLabel("Alternative 1 token", { exact: true })).toHaveValue("other");
    await expect(go).toBeEnabled();
    await go.click();

    await expect.poll(async () => (await sentManifests(page)).length).toBe(1);
    expect((await sentManifests(page))[0]).toBe(
      listSwapManifest(SWAP, MOCK_ACCOUNT, NFT, "#2#", [{ kind: "fungible", resource: OTHER_TOKEN, amount: "7" }], expiryForDays(LEDGER, 7)),
    );
  });

  test("an ask the chain would refuse keeps the wallet closed", async ({ page }) => {
    await injectWalletMock(page);
    await stubGateway(page);
    await page.goto("/swaps/list");

    await page.getByRole("button", { name: /Guild swap throwaway 2/ }).click();
    await page.getByLabel("Alternative 1 amount").fill("0");
    await expect(page.getByText("The amount must be more than zero.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open my wallet to list" })).toBeDisabled();
  });

  // The List form escrows the user's NFT on the strength of the component
  // read; a look-alike NftSwap from another package must never get the call.
  test("a live component from another package disarms the form and nothing is sent", async ({ page }) => {
    await injectWalletMock(page);
    await stubGateway(page, { packageAddress: "package_rdx1pkgnotthelivepackagexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    await page.goto("/swaps/list");

    await expect(page.getByRole("alert").filter({ hasText: "listing is unavailable right now" })).toBeVisible();
    await page.getByRole("button", { name: /Guild swap throwaway 2/ }).click();
    await page.getByLabel("Alternative 1 amount").fill("5000");
    await expect(page.getByText("Radix (XRD)")).toBeVisible();
    const go = page.getByRole("button", { name: "Open my wallet to list" });
    await expect(go).toBeDisabled();
    await go.click({ force: true });
    expect(await sentManifests(page)).toEqual([]);
  });

  // An account read in a shape this page does not know is "could not read",
  // never "holds no NFTs" — and Try again reads it again.
  test("an account read in an unknown shape says it could not be read, with Try again", async ({ page }) => {
    await injectWalletMock(page);
    let renamed = true;
    await stubGateway(page, {
      accountNfts: () =>
        renamed
          ? { ledger_state: ledgerState, items: [{ resource_address: NFT, vaults: { entries: [{ items: ["#2#"] }] } }] }
          : { ledger_state: ledgerState, items: [{ resource_address: NFT, vaults: { items: [{ items: ["#2#"] }] } }] },
    });
    await page.goto("/swaps/list");

    const failed = page.getByRole("alert").filter({ hasText: "could not be read" });
    await expect(failed).toBeVisible();
    await expect(page.getByText("This account holds no NFTs.")).toHaveCount(0);
    renamed = false;
    await failed.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("button", { name: /Guild swap throwaway 2/ })).toBeVisible();
  });
});
