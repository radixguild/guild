import { test, expect, type Page, type Route } from "@playwright/test";
import { injectWalletMock, MOCK_ACCOUNT } from "./helpers";
import {
  cancelSwapManifest,
  fillSwapManifest,
  listSwapManifest,
} from "../../src/lib/manifests";
import { expiryForDays } from "../../src/lib/nft-swap";

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
const SELLER = "account_rdx12y6ch4m8wjcgu7hrnwfqjeqt70w4kh7qy7k3gs2j9wyx3596fgt3fm";
const LEDGER_ISO = "2026-10-06T07:00:00.000Z";
const LEDGER = Date.parse(LEDGER_ISO) / 1000;

const RESOURCES = {
  [XRD]: { kind: "fungible", divisibility: 18, name: "Radix", symbol: "XRD", iconUrl: null, withdraw: "open" },
  [NFT]: { kind: "nonFungible", divisibility: null, name: "Guild Swap Throwaway NFT", symbol: null, iconUrl: null, withdraw: "open" },
};

const ASKS = [
  { kind: "fungible" as const, resource: XRD, amount: "5000" },
  { kind: "nonFungible" as const, resource: NFT, id: "#1#" },
];

function detail(receiptHolder: string) {
  return {
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
      },
      receipt: { holder: receiptHolder, burned: false },
      askNfts: {},
    },
  };
}

async function sentManifests(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __GUILD_E2E_SENT_MANIFESTS__: string[] }).__GUILD_E2E_SENT_MANIFESTS__);
}

async function stubDetail(page: Page, receiptHolder: string) {
  await page.route("**/api/v1/swaps/3", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detail(receiptHolder)) }),
  );
}

test.describe("NFT swap — the listing page", () => {
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
});

// ── The List page reads the Gateway from the browser ─────────────────────────

const GATEWAY = "https://mainnet.radixdlt.com";
const ledgerState = { network: "mainnet", state_version: 1, proposer_round_timestamp: LEDGER_ISO };

async function stubGateway(page: Page) {
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
    await expect(page).toHaveURL(/\/swaps\/3$/);
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
});
