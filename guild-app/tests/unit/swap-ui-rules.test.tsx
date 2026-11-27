/**
 * The NFT swap pages' money-path rules (review findings, 2026-10-06).
 *
 *   1. One transaction guard per listing page. Fill and the seller actions
 *      share it, and every action (the alternative picks too) stays disabled
 *      while the wallet is open, while the page waits for the ledger to show
 *      the viewer's own transaction, and on a view that gave up waiting — an
 *      old "Open" view offered again would only send a reverting transaction.
 *   2. A just-listed page settles only once the receipt holder is readable,
 *      or the seller lands on "Receipt: not found" with no seller panel.
 *   3. `seller` is a payee the lister names (nft_swap.rs `list(seller, …)`),
 *      not proof of who listed: the page says "Proceeds to", never "Seller",
 *      and no copy claims the site's account "signs the listing".
 *   4. Swap errors in swap words: the blueprint's refusals mapped, and the
 *      task humanizer's task lines ("resyncing", "add some XRD") never shown.
 *   5. The List form: a failed resource read fails the holdings read (the
 *      soulbound check cannot fail open), and the form stays disarmed from a
 *      committed list until the listing id is read back.
 *   6. The board: "Pays my account" turns off when the account changes, a
 *      filter answered from a truncated read says so, and reads time out.
 *
 * Follow-up (2026-10-06): "Try again" on a view that gave up waiting re-reads
 * against the same settle rule, so only a caught-up read re-arms the page; a
 * failed ask lookup on the List form says so and offers Try again; the
 * humanizer maps only the refusals this site's manifests can reach.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor, act, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

const SELLER = "account_rdx12seller0000000000000000000000000000000000000000000000"
const OTHER = "account_rdx12other00000000000000000000000000000000000000000000000"
const ASSET = "resource_rdx1asset000000000000000000000000000000000000000000000000"
const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"
const T = 1_800_000_000
// The swap component's listing-receipt resource, as its state reports it.
const RECEIPT = "resource_rdx1receipt00000000000000000000000000000000000000000000"
// A token that is not on the common list, with recall and freeze both locked
// (the shape of live listing 9's ask, CIGGIE), and one that calls itself XRD.
const CIGGIE = "resource_rdx1ciggie000000000000000000000000000000000000000000000"
const FAKE_XRD = "resource_rdx1fakexrd00000000000000000000000000000000000000000000"
type Recall = "locked-deny" | "recallable" | "unknown"
type Freeze = "locked-deny" | "freezable" | "unknown"
type Transfer = "locked-open" | "restrictable" | "unknown"
// freeze / transfer: null = a read that does not carry the field at all.
const token = (address: string, symbol: string, name: string, recall: Recall = "locked-deny", freeze: Freeze | null = "locked-deny", transfer: Transfer | null = "locked-open") => ({
  address, kind: "fungible", divisibility: 18, name, symbol, iconUrl: null, withdraw: "open", recall, ...(freeze ? { freeze } : {}), ...(transfer ? { transfer } : {}),
})

const W = vi.hoisted(() => ({ account: null as string | null, send: vi.fn() }))
vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    account: W.account,
    rdt: W.account ? { walletApi: { sendTransaction: W.send } } : null,
  }),
}))

const F = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock("@/lib/api-fetch", () => ({ apiFetch: F.apiFetch }))

// The site's one XRD/USD quote (use-xrd-usd.tsx), set per test; empty = no usable quote.
const QUOTE_NONE = { rate: null as number | null, stale: false, ageSeconds: null as number | null, source: null as string | null }
const Q = vi.hoisted(() => ({
  value: { rate: null, stale: false, ageSeconds: null, source: null } as {
    rate: number | null
    stale: boolean
    ageSeconds: number | null
    source: string | null
  },
}))
vi.mock("@/lib/use-xrd-usd", () => ({ useXrdUsd: () => Q.value }))

// The two asset-carrying builders record their arguments (the guard is the last).
const M = vi.hoisted(() => ({ fill: [] as unknown[][], list: [] as unknown[][] }))
vi.mock("@/lib/manifests", () => ({
  burnListingReceiptManifest: () => "BURN",
  cancelSwapManifest: () => "CANCEL",
  extendSwapListingManifest: () => "EXTEND",
  fillSwapManifest: (...a: unknown[]) => (M.fill.push(a), "FILL"),
  withdrawSwapProceedsManifest: () => "WITHDRAW",
  listSwapManifest: (...a: unknown[]) => (M.list.push(a), "LIST"),
}))

const G = vi.hoisted(() => ({
  readAccountNonFungibles: vi.fn(),
  readListedListingId: vi.fn(),
  readNftDisplay: vi.fn(),
  readResourceDisplay: vi.fn(),
  readSwapComponentState: vi.fn(),
}))
vi.mock("@/lib/nft-swap-gateway", () => G)

// The board keeps ?sort= and ?collection= in the URL. A tiny stand-in for the
// router: replace() rewrites the query and re-renders whoever reads it.
const NAV = vi.hoisted(() => {
  let params = new URLSearchParams()
  const subs = new Set<() => void>()
  return {
    get: () => params,
    set: (qs: string) => {
      params = new URLSearchParams(qs)
      subs.forEach((f) => f())
    },
    subscribe: (f: () => void) => {
      subs.add(f)
      return () => void subs.delete(f)
    },
  }
})
const R = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react")
  return {
    useRouter: () => R,
    usePathname: () => "/swaps",
    useSearchParams: () => useSyncExternalStore(NAV.subscribe, NAV.get, NAV.get),
  }
})

import { humanizeSwapTxError } from "@/components/swaps/swap-bits"
import { SwapDetail } from "@/components/swaps/swap-detail"
import { SwapBoard } from "@/components/swaps/swap-board"
import { ListNftForm } from "@/components/swaps/list-nft-form"
import { humanizeTxError } from "@/lib/escrow-utils"
import { shortAddress } from "@/lib/nft-swap"
import * as swapsCopy from "@/content/swaps"
import { ASK_PROBLEM_TEXT, BOARD_COPY, DETAIL_COPY, LIST_COPY } from "@/content/swaps"
import { ESCROW_CLAIM_RECEIPT_RESOURCE, ESCROW_RECEIPT_RESOURCE } from "@/lib/config"
import type { SwapBoardView, SwapDetailView } from "@/lib/nft-swap-service"

const committed = (hash = "txid_rdx1committed") => ({
  isOk: () => true,
  value: { transactionIntentHash: hash, status: "CommittedSuccess" },
})

function deferred<V>() {
  let resolve!: (v: V) => void
  const promise = new Promise<V>((r) => (resolve = r))
  return { promise, resolve }
}

const assetResource = (recall: Recall, freeze: Freeze | null = "locked-deny", transfer: Transfer | null = "locked-open") => ({
  [ASSET]: { kind: "nonFungible", divisibility: null, name: "Dinos", symbol: null, iconUrl: null, withdraw: "open", recall, ...(freeze ? { freeze } : {}), ...(transfer ? { transfer } : {}) },
})

function detail(
  over: {
    receipt?: SwapDetailView["receipt"]
    expiresAt?: number
    recall?: Recall | null
    freeze?: Freeze | null
    transfer?: Transfer | null
    assetResource?: string
    asks?: SwapDetailView["listing"]["asks"]
    resources?: Record<string, unknown>
  } = {},
): SwapDetailView {
  return {
    component: "component_rdx1swap",
    receiptResource: RECEIPT,
    ledgerTime: T,
    fees: { fill: { unit: "XRD", amount: "5" }, extend: { unit: "XRD", amount: "1" } },
    // recall: null = the asset's resource is missing from the read.
    resources: {
      ...(over.recall === null ? {} : assetResource(over.recall ?? "locked-deny", over.freeze === undefined ? "locked-deny" : over.freeze, over.transfer === undefined ? "locked-open" : over.transfer)),
      ...over.resources,
    } as SwapDetailView["resources"],
    listing: {
      listingId: 7,
      seller: SELLER,
      assetResource: over.assetResource ?? ASSET,
      assetId: "#1#",
      asks: over.asks ?? [
        { kind: "fungible", resource: XRD, amount: "100" },
        { kind: "fungible", resource: XRD, amount: "200" },
      ],
      createdAt: T - 100,
      expiresAt: over.expiresAt ?? T + 86_400,
      state: "Listed",
      filledWith: null,
      proceedsWithdrawn: false,
      status: "open",
      asset: { name: "Dino", imageUrl: null },
      hidden: false,
    },
    receipt: over.receipt === undefined ? { holder: SELLER, burned: false } : over.receipt,
    askNfts: {},
  }
}

const answer = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) })

beforeEach(() => {
  W.account = SELLER
  Q.value = { ...QUOTE_NONE }
  W.send.mockReset()
  // The wallet mock runs the page's manifest builder, as the real hook does.
  M.fill.length = 0
  M.list.length = 0
  F.apiFetch.mockReset()
  Object.values(G).forEach((f) => f.mockReset())
  R.push.mockReset()
  R.replace.mockReset()
  R.replace.mockImplementation((url: string) => NAV.set(url.split("?")[1] ?? ""))
  NAV.set("")
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// ── 4. The swap humanizer ────────────────────────────────────────────────────

describe("humanizeSwapTxError", () => {
  const engine = (msg: string) => `{"error":"Wallet","message":"ApplicationError(PanicMessage(\\"${msg} @ nft_swap.rs\\"))"}`

  it.each([
    ["listing is not Listed", /no longer open/],
    ["listing has expired", /passed its expiry/],
    ["payment resource does not match the chosen alternative", /did not match the alternative/],
    ["payment amount does not match the chosen alternative", /did not match the alternative/],
    ["payment NFT id does not match the chosen alternative", /did not match the alternative/],
    ["proceeds already withdrawn", /already withdrawn/],
    ["cannot burn the receipt while the listing is still Listed — cancel first", /Cancel the listing first/],
    ["cannot burn the receipt while proceeds are still owed — withdraw first", /Withdraw them first/],
    ["expires_at must be at most 30 days out (S2 — mandatory expiry ceiling)", /refused the expiry/],
  ])("maps the blueprint's %j to a plain line", (msg, line) => {
    const raw = engine(msg)
    const h = humanizeSwapTxError(raw)
    expect(h.summary).toMatch(line)
    expect(h.detail).toBe(raw)
  })

  it.each([
    "listing must escrow exactly one NFT",
    "wrong receipt resource",
    "must present exactly 1 receipt",
    "alternative index out of range",
  ])("has no row for %j, which the site's own manifests rule out — the generic line, raw detail kept", (msg) => {
    const raw = engine(msg)
    const h = humanizeSwapTxError(raw)
    expect(h.summary).toBe(humanizeTxError(raw).summary)
    expect(h.detail).toBe(raw)
  })

  it("keeps the wallet-transport lines of the shared humanizer", () => {
    const rejected = JSON.stringify({ error: "rejectedByUser", message: "" })
    const undelivered = JSON.stringify({ error: "missingExtension", interactionId: "x", message: "" })
    expect(humanizeSwapTxError(rejected).summary).toBe(humanizeTxError(rejected).summary)
    expect(humanizeSwapTxError(undelivered).summary).toBe(humanizeTxError(undelivered).summary)
    expect(humanizeSwapTxError(undelivered).summary).toMatch(/Connector/)
  })

  it("never shows a task line, a resync promise or 'add XRD' on a swap page", () => {
    const raws = [
      "NonFungibleVaultError(MissingId(#7#))",
      "MissingNonFungibleLocalId",
      "VaultError(ResourceError(InsufficientBalance { requested: 5000, actual: 1 }))",
      "task must be Open to claim",
      "task must be Claimed to submit",
    ]
    for (const raw of raws) {
      const { summary } = humanizeSwapTxError(raw)
      expect(summary, raw).not.toMatch(/task|resync|Add some XRD/i)
      expect(summary, raw).toMatch(/nothing changed hands/i)
    }
  })

  it("leaves a WorktopError to the neutral fallback, not the balance line", () => {
    const raw = `{"error":"x","message":"WorktopError(InsufficientBalance)"}`
    expect(humanizeSwapTxError(raw).summary).toBe(humanizeTxError(raw).summary)
  })
})

// ── 1–3. The listing page ────────────────────────────────────────────────────

const fillPicks = () => screen.getAllByRole("button", { name: /Fill with this/ })

describe("SwapDetail", () => {
  it("shares one guard: while a fill waits on the wallet, every seller action and pick is disabled", async () => {
    F.apiFetch.mockResolvedValue(answer(detail()))
    const wallet = deferred<unknown>()
    W.send.mockReturnValue(wallet.promise)
    render(<SwapDetail listingId="7" />)

    fireEvent.click((await screen.findAllByRole("button", { name: /Fill with this/ }))[0])
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: /Open my wallet to fill/ }))
    await screen.findByText("Check your wallet…")

    expect(screen.getByRole("button", { name: "Cancel listing" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Extend by 30 days" })).toBeDisabled()
    for (const b of fillPicks()) expect(b).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Cancel listing" }))
    expect(W.send).toHaveBeenCalledTimes(1)
    await act(async () => wallet.resolve({ isOk: () => false, error: { error: "rejectedByUser" } }))
  })

  it("after a committed Extend, stays disabled while waiting and on the exhausted stale view", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    F.apiFetch.mockResolvedValue(answer(detail()))
    W.send.mockResolvedValue(committed())
    render(<SwapDetail listingId="7" />)

    fireEvent.click(await screen.findByRole("button", { name: "Extend by 30 days" }))
    await screen.findByText(DETAIL_COPY.waiting)
    expect(screen.getByRole("button", { name: "Extend by 30 days" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Cancel listing" })).toBeDisabled()
    for (const b of fillPicks()) expect(b).toBeDisabled()
    expect(screen.getAllByText(DETAIL_COPY.behind).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole("button", { name: "Extend by 30 days" }))
    expect(W.send).toHaveBeenCalledTimes(1)

    // The ledger read never shows the extension: the page gives up waiting
    // and marks the view stale — still no action offered on it.
    for (let i = 0; i < 8; i++) await act(() => vi.advanceTimersByTimeAsync(1600))
    await screen.findByRole("button", { name: "Try again" })
    expect(screen.queryByText(DETAIL_COPY.waiting)).toBeNull()
    expect(screen.getByRole("button", { name: "Extend by 30 days" })).toBeDisabled()
    expect(screen.getAllByText(DETAIL_COPY.behind).length).toBeGreaterThan(0)

    // "Try again" answered with the SAME old view: still behind the Extend,
    // so nothing re-arms — a second Extend would commit and charge again.
    const before = F.apiFetch.mock.calls.length
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    await waitFor(() => expect(F.apiFetch.mock.calls.length).toBe(before + 1))
    await act(() => vi.advanceTimersByTimeAsync(1600))
    expect(F.apiFetch.mock.calls.length).toBe(before + 1) // one read per press, no retry loop
    await screen.findByRole("button", { name: "Try again" })
    expect(screen.getByRole("button", { name: "Extend by 30 days" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Cancel listing" })).toBeDisabled()
    for (const b of fillPicks()) expect(b).toBeDisabled()
    expect(screen.getAllByText(DETAIL_COPY.behind).length).toBeGreaterThan(0)

    // A read that catches up re-arms the page.
    F.apiFetch.mockResolvedValue(answer(detail({ expiresAt: T + 86_400 * 31 })))
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Extend by 30 days" })).toBeEnabled())
    expect(screen.queryByText(DETAIL_COPY.behind)).toBeNull()
  })

  it("a just-listed page waits for the receipt holder before it settles", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    F.apiFetch
      .mockResolvedValueOnce(answer(detail({ receipt: { holder: null, burned: false } })))
      .mockResolvedValueOnce(answer(detail({ receipt: { holder: null, burned: false } })))
      .mockResolvedValue(answer(detail()))
    render(<SwapDetail listingId="7" justListed />)

    for (let i = 0; i < 3; i++) await act(() => vi.advanceTimersByTimeAsync(1600))
    await screen.findByText(DETAIL_COPY.sellerHeading)
    expect(F.apiFetch).toHaveBeenCalledTimes(3)
    expect(screen.queryByText("not found")).toBeNull()
  })

  it.each([
    ["recallable", DETAIL_COPY.recallNoFill],
    ["unknown", DETAIL_COPY.recallNoFillUnknown],
    [null, DETAIL_COPY.recallNoFillUnknown], // the asset's resource missing from the read
  ] as const)("recall guard, %s: no Fill is offered, the reason shows, cancel and extend stay", async (recall, line) => {
    W.account = SELLER
    F.apiFetch.mockResolvedValue(answer(detail({ recall })))
    render(<SwapDetail listingId="7" />)
    expect(await screen.findByTestId("recall-no-fill")).toHaveTextContent(line)
    expect(screen.queryAllByRole("button", { name: /Fill/ })).toHaveLength(0)
    expect(screen.getByRole("button", { name: "Cancel listing" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Extend by 30 days" })).toBeEnabled()
  })

  it.each(["recallable", "unknown"] as const)(
    "recall guard, %s: Withdraw proceeds and Burn receipt stay available on listings already settled",
    async (recall) => {
      const base = detail({ recall })
      const owed = { ...base, listing: { ...base.listing, state: "Filled", status: "filled", filledWith: 0, proceedsWithdrawn: false } }
      F.apiFetch.mockResolvedValue(answer(owed))
      const first = render(<SwapDetail listingId="7" />)
      expect(await screen.findByRole("button", { name: /^Withdraw / })).toBeEnabled()
      first.unmount()
      const done = { ...base, listing: { ...base.listing, state: "Filled", status: "filled", filledWith: 0, proceedsWithdrawn: true } }
      F.apiFetch.mockResolvedValue(answer(done))
      render(<SwapDetail listingId="7" />)
      expect(await screen.findByRole("button", { name: "Burn the listing receipt" })).toBeEnabled()
    },
  )

  it("recall guard, locked-deny: Fill is offered and no reason shows", async () => {
    F.apiFetch.mockResolvedValue(answer(detail({ recall: "locked-deny" })))
    render(<SwapDetail listingId="7" />)
    expect((await screen.findAllByRole("button", { name: /Fill with this/ })).length).toBeGreaterThan(0)
    expect(screen.queryByTestId("recall-no-fill")).toBeNull()
  })

  it("labels the payee 'Proceeds to', with its caveat, and says 'pays your account' to it", async () => {
    F.apiFetch.mockResolvedValue(answer(detail()))
    render(<SwapDetail listingId="7" />)
    await screen.findByText("Proceeds to")
    expect(screen.getByText(DETAIL_COPY.payeeCaption)).toBeInTheDocument()
    expect(screen.queryByText("Seller")).toBeNull()
    expect(screen.getByText(DETAIL_COPY.ownListing)).toBeInTheDocument()
    expect(DETAIL_COPY.ownListing).toMatch(/^This listing pays your account/)
  })

  it("no swap copy claims the payee is who listed or signed", () => {
    const all: string[] = []
    const walk = (v: unknown) => {
      if (typeof v === "string") all.push(v)
      else if (typeof v === "function") all.push(String((v as (n: number) => string)(1000)))
      else if (v && typeof v === "object") Object.values(v).forEach(walk)
    }
    walk(swapsCopy)
    for (const s of all) {
      expect(s, s).not.toMatch(/signs the listing|You made this listing|My listings|seller account named/i)
    }
  })

  it("says when the listing has more asks than the page looked up, and only then", async () => {
    F.apiFetch.mockResolvedValue(answer({ ...detail(), moreAsks: true }))
    render(<SwapDetail listingId="7" />)
    await screen.findByText(DETAIL_COPY.moreAsks)
    cleanup()
    F.apiFetch.mockResolvedValue(answer({ ...detail(), moreAsks: false }))
    render(<SwapDetail listingId="7" />)
    await screen.findByText("Proceeds to")
    expect(screen.queryByText(DETAIL_COPY.moreAsks)).toBeNull()
  })

  it("leads with the NFT: its name is the one h1, 'Collection #id' sits under it, the tab is retitled", async () => {
    const d = detail()
    d.listing.assetId = "#9897#"
    d.resources = { [ASSET]: { name: "Lantern Foxes", symbol: null, divisibility: null, kind: "nonFungible", iconUrl: null } } as never
    d.listing.asset = { name: "Maple Quillson", imageUrl: null }
    F.apiFetch.mockResolvedValue(answer(d))
    document.title = "Listing #7 · NFT swap — Radix Guild"
    render(<SwapDetail listingId="7" />)

    await screen.findByRole("heading", { level: 1, name: "Maple Quillson" })
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1)
    expect(screen.getByText("Lantern Foxes #9897")).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe("Maple Quillson · Lantern Foxes #9897 — Radix Guild"))
    // The id row reads #9897 and keeps the raw id in its hover title and its copy button.
    expect(screen.getByText("#9897")).toHaveAttribute("title", "#9897#")
    expect(screen.getByRole("button", { name: "Copy NFT id" })).toBeInTheDocument()
    expect(screen.getByText("Receipt held by")).toBeInTheDocument()
    expect(screen.queryByText("Receipt")).toBeNull()
  })

  it("copies the RAW local id, not the readable one", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    const d = detail()
    d.listing.assetId = "#9897#"
    F.apiFetch.mockResolvedValue(answer(d))
    render(<SwapDetail listingId="7" />)
    fireEvent.click(await screen.findByRole("button", { name: "Copy NFT id" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("#9897#"))
  })

  it("without an NFT name the heading is 'Collection #id' and no second line repeats it", async () => {
    const d = detail()
    d.listing.assetId = "<dino_7>"
    d.listing.asset = { name: null, imageUrl: null }
    d.resources = { [ASSET]: { name: "Dinos", symbol: null, divisibility: null, kind: "nonFungible", iconUrl: null } } as never
    F.apiFetch.mockResolvedValue(answer(d))
    render(<SwapDetail listingId="7" />)
    await screen.findByRole("heading", { level: 1, name: "Dinos dino_7" })
    expect(screen.getAllByText("Dinos dino_7")).toHaveLength(1)
    await waitFor(() => expect(document.title).toBe("Dinos dino_7 — Radix Guild"))
  })

  it("a hidden listing keeps the plain NFT heading and the hidden copy, and never retitles the tab", async () => {
    const d = detail()
    d.listing.hidden = true
    d.listing.asset = { name: null, imageUrl: null }
    d.resources = { [ASSET]: { name: "Should Not Show", symbol: null, divisibility: null, kind: "nonFungible", iconUrl: null } } as never
    F.apiFetch.mockResolvedValue(answer(d))
    document.title = "Listing #7 · NFT swap — Radix Guild"
    render(<SwapDetail listingId="7" />)
    await screen.findByRole("heading", { level: 1, name: "NFT #1" })
    expect(screen.getByText(DETAIL_COPY.hidden)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain("Should Not Show")
    expect(document.title).toBe("Listing #7 · NFT swap — Radix Guild")
  })

  it("a listing that becomes hidden while the page is open puts the plain 'Listing #n' title back", async () => {
    const shown = detail()
    shown.listing.asset = { name: "Maple Quillson", imageUrl: null }
    const hiddenNow = detail({ expiresAt: T + 86_400 * 31 })
    hiddenNow.listing.hidden = true
    hiddenNow.listing.asset = { name: null, imageUrl: null }
    F.apiFetch.mockResolvedValueOnce(answer(shown)).mockResolvedValue(answer(hiddenNow))
    W.send.mockResolvedValue(committed())
    document.title = "Listing #7 · NFT swap — Radix Guild"
    render(<SwapDetail listingId="7" />)
    await waitFor(() => expect(document.title).toContain("Maple Quillson"))

    // The seller extends; the re-read answers with the listing hidden by then.
    fireEvent.click(await screen.findByRole("button", { name: "Extend by 30 days" }))
    await screen.findByText(DETAIL_COPY.hidden)
    await waitFor(() => expect(document.title).toBe("Listing #7 · NFT swap — Radix Guild"))
    expect(document.body.textContent).not.toContain("Maple Quillson")
  })

  it("has a heading while it loads and when the read fails, and the tab title is left alone until it loads", async () => {
    document.title = "Listing #7 · NFT swap — Radix Guild"
    F.apiFetch.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"))
    render(<SwapDetail listingId="7" />)
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(DETAIL_COPY.pageHeading)
    await screen.findByText(/could not be read/)
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(DETAIL_COPY.pageHeading)
    expect(document.title).toBe("Listing #7 · NFT swap — Radix Guild")
  })

  it("bounds the detail read with a timeout and treats a failed read as unreadable", async () => {
    F.apiFetch.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"))
    render(<SwapDetail listingId="7" />)
    await screen.findByText(/could not be read/)
    expect(F.apiFetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })
})

// ── 6. The board ─────────────────────────────────────────────────────────────

function board(over: Partial<SwapBoardView> = {}): SwapBoardView {
  return {
    component: "component_rdx1swap",
    receiptResource: RECEIPT,
    ledgerTime: T,
    fees: { fill: null, extend: null },
    resources: {},
    total: 1500,
    truncated: false,
    unreadable: [],
    hidden: 0,
    listings: [],
    collections: [],
    moreCollections: 0,
    nextCursor: null,
    ...over,
  }
}

const lastUrl = () => String(F.apiFetch.mock.calls.at(-1)?.[0])

describe("SwapBoard", () => {
  it("turns 'Pays my account' off when the account switches or disconnects", async () => {
    F.apiFetch.mockResolvedValue(answer(board()))
    const view = render(<SwapBoard />)
    fireEvent.click(await screen.findByRole("button", { name: BOARD_COPY.mine }))
    await waitFor(() => expect(lastUrl()).toContain(`seller=${SELLER}`))

    W.account = OTHER
    view.rerender(<SwapBoard />)
    await waitFor(() => expect(lastUrl()).not.toContain("seller="))
    expect(screen.getByRole("button", { name: BOARD_COPY.mine })).toHaveAttribute("aria-pressed", "false")

    fireEvent.click(screen.getByRole("button", { name: BOARD_COPY.mine }))
    await waitFor(() => expect(lastUrl()).toContain(`seller=${OTHER}`))
    W.account = null
    view.rerender(<SwapBoard />)
    await waitFor(() => expect(lastUrl()).not.toContain("seller="))
    W.account = OTHER
    view.rerender(<SwapBoard />)
    await screen.findByRole("button", { name: BOARD_COPY.mine })
    expect(screen.getByRole("button", { name: BOARD_COPY.mine })).toHaveAttribute("aria-pressed", "false")
    expect(lastUrl()).not.toContain("seller=")
  })

  it("an empty filter answered from a truncated read says it searched only the newest 1000", async () => {
    F.apiFetch.mockResolvedValue(answer(board({ truncated: true })))
    render(<SwapBoard />)
    await screen.findByText(BOARD_COPY.truncatedFiltered(1000))
    expect(BOARD_COPY.truncatedFiltered(1000)).toContain("newest 1,000 listings")
    expect(screen.queryByText(BOARD_COPY.empty.open)).toBeNull()
  })

  it("bounds the board read with a timeout", async () => {
    F.apiFetch.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"))
    render(<SwapBoard />)
    await screen.findByText(BOARD_COPY.unreadable)
    expect(F.apiFetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })
})

const COLL_B = "resource_rdx1nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0002"
const named = (name: string) => ({ name, symbol: null, divisibility: null, kind: "nonFungible", iconUrl: null, withdraw: "open", recall: "locked-deny", freeze: "locked-deny", transfer: "locked-open" })

function card(id: number, over: Partial<SwapBoardView["listings"][number]> = {}): SwapBoardView["listings"][number] {
  const d = detail().listing
  return { ...d, listingId: id, assetId: `#${9890 + id}#`, asset: { name: `Fox ${id}`, imageUrl: null }, ...over }
}

describe("SwapBoard — cards, sort and collection filter", () => {
  const withFacets = (over: Partial<SwapBoardView> = {}) =>
    board({
      listings: [card(7)],
      resources: { [ASSET]: named("Lantern Foxes"), [COLL_B]: named("Dinos") } as never,
      collections: [{ resource: ASSET, count: 12 }, { resource: COLL_B, count: 3 }],
      ...over,
    })

  it("a card leads with the NFT's name, then 'Collection #id', and ends on the listing number", async () => {
    F.apiFetch.mockResolvedValue(answer(withFacets()))
    render(<SwapBoard />)
    const name = await screen.findByText("Fox 7")
    const line = screen.getByText("Lantern Foxes #9897")
    expect(line).toHaveAttribute("title", `${ASSET} #9897#`)
    const last = screen.getByText(/^Listing 7 ·/)
    // document order: name, then the id line, then the listing number
    expect(name.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(line.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("an unnamed NFT shows 'Collection #id' once; a hidden one keeps the hidden copy and an address", async () => {
    F.apiFetch.mockResolvedValue(
      answer(
        withFacets({
          listings: [
            card(7, { asset: { name: null, imageUrl: null } }),
            card(8, { hidden: true, asset: { name: null, imageUrl: null } }),
          ],
        }),
      ),
    )
    render(<SwapBoard />)
    await screen.findByText(BOARD_COPY.hiddenCard)
    expect(screen.getAllByText("Lantern Foxes #9897")).toHaveLength(1)
    expect(screen.getByText(`${shortAddress(ASSET)} #9898`)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain("#9898#")
  })

  it("starts from the URL: ?sort= and ?collection= go straight into the first read", async () => {
    NAV.set(`sort=price-desc&collection=${COLL_B}`)
    F.apiFetch.mockResolvedValue(answer(withFacets()))
    render(<SwapBoard />)
    await waitFor(() => expect(F.apiFetch).toHaveBeenCalled())
    const u = new URL(lastUrl(), "http://x")
    expect(u.searchParams.get("sort")).toBe("price-desc")
    expect(u.searchParams.get("collection")).toBe(COLL_B)
    expect(u.searchParams.get("status")).toBe("open")
    expect(await screen.findByLabelText("Sort")).toHaveValue("price-desc")
    expect(screen.getByLabelText("Collection")).toHaveValue(COLL_B)
  })

  it("ignores a ?sort= or ?collection= it does not know — the API never sees them", async () => {
    NAV.set("sort=cheapest&collection=nope")
    F.apiFetch.mockResolvedValue(answer(withFacets()))
    render(<SwapBoard />)
    await screen.findByText("Fox 7")
    expect(lastUrl()).not.toContain("sort=")
    expect(lastUrl()).not.toContain("collection=")
    expect(screen.getByLabelText("Sort")).toHaveValue("newest")
  })

  it("choosing a sort writes it to the URL and re-reads with it; newest drops it again", async () => {
    F.apiFetch.mockResolvedValue(answer(withFacets()))
    render(<SwapBoard />)
    await screen.findByText("Fox 7")
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "price-asc" } })
    expect(R.replace).toHaveBeenLastCalledWith("/swaps?sort=price-asc", { scroll: false })
    await waitFor(() => expect(lastUrl()).toContain("sort=price-asc"))
    // The note says what a price sort covers; it is not there for other sorts.
    expect(screen.getByText(BOARD_COPY.sort.notes.price)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "ending" } })
    await waitFor(() => expect(lastUrl()).toContain("sort=ending"))
    expect(screen.queryByText(BOARD_COPY.sort.notes.price)).toBeNull()
    expect(screen.getByText(BOARD_COPY.sort.notes.ending)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "newest" } })
    expect(R.replace).toHaveBeenLastCalledWith("/swaps", { scroll: false })
    await waitFor(() => expect(lastUrl()).not.toContain("sort="))
  })

  it("lists the collections present with their counts and names, keyed by resource address", async () => {
    F.apiFetch.mockResolvedValue(answer(withFacets({ moreCollections: 4 })))
    render(<SwapBoard />)
    const select = await screen.findByLabelText("Collection")
    const opts = Array.from(select.querySelectorAll("option")).map((o) => [o.value, o.textContent])
    expect(opts).toEqual([
      ["", BOARD_COPY.collection.all],
      [ASSET, "Lantern Foxes (12)"],
      [COLL_B, "Dinos (3)"],
    ])
    expect(screen.getByText(BOARD_COPY.collection.notListed(4))).toBeInTheDocument()

    fireEvent.change(select, { target: { value: COLL_B } })
    expect(R.replace).toHaveBeenLastCalledWith(`/swaps?collection=${COLL_B}`, { scroll: false })
    await waitFor(() => expect(lastUrl()).toContain(`collection=${COLL_B}`))
  })

  it("a chosen collection with none left under this status stays in the select, as (0)", async () => {
    NAV.set(`collection=${COLL_B}`)
    F.apiFetch.mockResolvedValue(answer(withFacets({ listings: [], collections: [{ resource: ASSET, count: 12 }] })))
    render(<SwapBoard />)
    const select = await screen.findByLabelText("Collection")
    expect(select).toHaveValue(COLL_B)
    expect(screen.getByRole("option", { name: `${shortAddress(COLL_B)} (0)` })).toBeInTheDocument()
    // With a collection chosen, an empty answer is a filter result, not "nothing is listed".
    expect(screen.queryByText(BOARD_COPY.empty.open)).toBeNull()
    expect(screen.getByText(BOARD_COPY.empty.other)).toBeInTheDocument()
  })

  it("Load more pages newest with `before` (a listing id) and every other sort with `offset`", async () => {
    F.apiFetch.mockResolvedValue(answer(withFacets({ nextCursor: 7 })))
    const view = render(<SwapBoard />)
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }))
    await waitFor(() => expect(lastUrl()).toContain("before=7"))
    expect(lastUrl()).not.toContain("offset=")
    view.unmount()

    NAV.set("sort=name")
    F.apiFetch.mockReset()
    F.apiFetch.mockResolvedValue(answer(withFacets({ nextCursor: 48 })))
    render(<SwapBoard />)
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }))
    await waitFor(() => expect(lastUrl()).toContain("offset=48"))
    expect(lastUrl()).toContain("sort=name")
    expect(lastUrl()).not.toContain("before=")
  })

  it("Load more shows a listing once when the server re-sorted between pages, with unique keys", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    NAV.set("sort=name")
    F.apiFetch
      .mockResolvedValueOnce(answer(withFacets({ listings: [card(1), card(2)], nextCursor: 2 })))
      .mockResolvedValueOnce(answer(withFacets({ listings: [card(2), card(3)], nextCursor: null })))
    render(<SwapBoard />)
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }))
    await screen.findByText("Fox 3")
    expect(screen.getAllByText("Fox 1")).toHaveLength(1)
    expect(screen.getAllByText("Fox 2")).toHaveLength(1)
    expect(errors.mock.calls.filter((c) => /same key|unique "key"/i.test(String(c[0])))).toEqual([])
    errors.mockRestore()
  })

  it("a reply from before the sort changed is not spliced into the new order", async () => {
    const later = deferred<unknown>()
    F.apiFetch.mockResolvedValueOnce(answer(withFacets({ nextCursor: 7 }))).mockReturnValueOnce(later.promise)
    render(<SwapBoard />)
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }))
    await waitFor(() => expect(F.apiFetch).toHaveBeenCalledTimes(2))
    F.apiFetch.mockResolvedValue(answer(withFacets({ listings: [card(1)] })))
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "name" } })
    await screen.findByText("Fox 1")
    await act(async () => later.resolve(answer(withFacets({ listings: [card(99)] }))))
    expect(screen.queryByText("Fox 99")).toBeNull()
  })
})

// ── 5. The List form ─────────────────────────────────────────────────────────

function holdings(resourceRead: Map<string, unknown> | null) {
  G.readSwapComponentState.mockResolvedValue({ ledgerNow: T, receiptResource: RECEIPT })
  G.readAccountNonFungibles.mockResolvedValue({ groups: [{ resource: ASSET, ids: ["#1#"], more: false }], moreResources: false })
  G.readNftDisplay.mockResolvedValue(new Map())
  G.readResourceDisplay.mockImplementation(async (addrs: string[]) =>
    addrs.includes(ASSET) ? resourceRead : new Map([[XRD, { address: XRD, kind: "fungible", divisibility: 18, name: "Radix", symbol: "XRD", iconUrl: null, withdraw: "open", recall: "locked-deny", freeze: "locked-deny", transfer: "locked-open" }]]),
  )
}

const listRes = (recall: Recall, freeze: Freeze | null = "locked-deny", resource = ASSET, transfer: Transfer | null = "locked-open") =>
  new Map([[resource, { address: resource, kind: "nonFungible", divisibility: null, name: "Dinos", symbol: null, iconUrl: null, withdraw: "open", recall, ...(freeze ? { freeze } : {}), ...(transfer ? { transfer } : {}) }]])

describe("recall guard — list form", () => {
  it.each([
    ["recallable", /Recall is not permanently switched off for this collection's NFTs, so it cannot be listed/],
    ["unknown", /could not confirm that recall, freezing and transfer restrictions are permanently off/],
  ] as const)("a %s collection: the NFT cannot be picked, the reason shows, submit stays disabled", async (state, line) => {
    holdings(listRes(state))
    render(<ListNftForm />)
    await screen.findByText(line)
    expect(screen.getByRole("button", { name: /#1#/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: /Open my wallet to list/ })).toBeDisabled()
    expect(W.send).not.toHaveBeenCalled()
  })

  it("a locked-deny collection can still be listed", async () => {
    holdings(listRes("locked-deny"))
    render(<ListNftForm />)
    fireEvent.click(await screen.findByRole("button", { name: /#1#/ }))
    fireEvent.change(screen.getByLabelText("Alternative 1 amount"), { target: { value: "5" } })
    await waitFor(() => expect(screen.getByRole("button", { name: /Open my wallet to list/ })).toBeEnabled())
    expect(screen.queryByText(/not permanently switched off/)).toBeNull()
  })
})

describe("ListNftForm", () => {
  it("a failed resource read fails the holdings read, so no NFT can be armed", async () => {
    holdings(null)
    render(<ListNftForm />)
    await screen.findByText(/NFTs in this account could not be read/)
    expect(screen.queryByRole("button", { name: /#1#/ })).toBeNull()
    expect(screen.getByRole("button", { name: /Open my wallet to list/ })).toBeDisabled()
  })

  it("a failed ask-resource lookup says so with Try again, which re-reads it — never 'Looking up…' for good", async () => {
    holdings(new Map([[ASSET, { address: ASSET, kind: "nonFungible", divisibility: null, name: "Dinos", symbol: null, iconUrl: null, withdraw: "open", recall: "locked-deny", freeze: "locked-deny", transfer: "locked-open" }]]))
    const xrd = { address: XRD, kind: "fungible", divisibility: 18, name: "Radix", symbol: "XRD", iconUrl: null, withdraw: "open", recall: "locked-deny", freeze: "locked-deny", transfer: "locked-open" }
    let askReads = 0
    G.readResourceDisplay.mockImplementation(async (addrs: string[]) => {
      if (addrs.includes(ASSET)) return new Map([[ASSET, { address: ASSET, kind: "nonFungible", divisibility: null, name: "Dinos", symbol: null, iconUrl: null, withdraw: "open", recall: "locked-deny", freeze: "locked-deny", transfer: "locked-open" }]])
      askReads++
      return askReads === 1 ? null : new Map([[XRD, xrd]])
    })
    render(<ListNftForm />)

    await screen.findByText(/This resource could not be read/)
    expect(screen.queryByText("Looking up…")).toBeNull()
    expect(askReads).toBe(1) // a failure is not re-read in a loop
    fireEvent.click(await screen.findByRole("button", { name: /#1#/ }))
    fireEvent.change(screen.getByLabelText("Alternative 1 amount"), { target: { value: "5" } })
    expect(screen.getByRole("button", { name: /Open my wallet to list/ })).toBeDisabled()

    const retry = screen.getAllByRole("button", { name: "Try again" }).at(-1)!
    fireEvent.click(retry)
    await screen.findByText("Radix (XRD)")
    expect(askReads).toBe(2)
    expect(screen.queryByText(/This resource could not be read/)).toBeNull()
    await waitFor(() => expect(screen.getByRole("button", { name: /Open my wallet to list/ })).toBeEnabled())
  })

  it("stays disarmed from a committed list until the listing id is read back, showing the transaction", async () => {
    holdings(new Map([[ASSET, { address: ASSET, kind: "nonFungible", divisibility: null, name: "Dinos", symbol: null, iconUrl: null, withdraw: "open", recall: "locked-deny", freeze: "locked-deny", transfer: "locked-open" }]]))
    const readBack = deferred<number | null>()
    G.readListedListingId.mockReturnValue(readBack.promise)
    W.send.mockResolvedValue(committed("txid_rdx1listed"))
    render(<ListNftForm />)

    fireEvent.click(await screen.findByRole("button", { name: /#1#/ }))
    fireEvent.change(screen.getByLabelText("Alternative 1 amount"), { target: { value: "5" } })
    const list = await screen.findByRole("button", { name: /Open my wallet to list/ })
    await waitFor(() => expect(list).toBeEnabled())
    fireEvent.click(list)
    fireEvent.click(list)

    await screen.findByRole("link", { name: "View transaction" })
    const button = screen.getByRole("button", { name: /Reading the ledger|Open my wallet to list/ })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(W.send).toHaveBeenCalledTimes(1)

    await act(async () => readBack.resolve(9))
    expect(R.push).toHaveBeenCalledWith("/swaps/9?listed=1")
  })
})

// ── 7. PR A polish: empty state, loading text, ≈US$, short addresses ─────────

describe("SwapBoard — empty state", () => {
  it("an empty open board says what a swap is and how to list, with the link", async () => {
    F.apiFetch.mockResolvedValue(answer(board()))
    render(<SwapBoard />)
    const title = await screen.findByText(BOARD_COPY.empty.open)
    expect(screen.getByText(`${BOARD_COPY.emptyWhat} ${BOARD_COPY.emptyHint}`)).toBeInTheDocument()
    // The link to the existing list flow sits inside the empty state itself.
    const box = title.parentElement as HTMLElement
    expect(within(box).getByRole("link", { name: BOARD_COPY.listCta })).toHaveAttribute("href", "/swaps/list")
    expect(box.querySelector("h3")).toBe(title)
  })

  it("an empty filter answer is a filter result: no swap explainer, no second list button", async () => {
    F.apiFetch.mockResolvedValue(answer(board()))
    render(<SwapBoard />)
    await screen.findByText(BOARD_COPY.empty.open)
    fireEvent.click(screen.getByRole("button", { name: "Expired" }))
    const title = await screen.findByText(BOARD_COPY.empty.other)
    expect(screen.queryByText(BOARD_COPY.empty.open)).toBeNull()
    expect(screen.queryByText(new RegExp(BOARD_COPY.emptyWhat.slice(0, 20)))).toBeNull()
    expect(within(title.parentElement as HTMLElement).queryByRole("link")).toBeNull()
  })

  it("is not shown for a board that has listings", async () => {
    F.apiFetch.mockResolvedValue(answer(board({ listings: [card(7)] })))
    render(<SwapBoard />)
    await screen.findByText("Fox 7")
    expect(screen.queryByText(BOARD_COPY.empty.open)).toBeNull()
  })
})

describe("loading text", () => {
  it("the board says it is loading, over the skeletons, until the read answers", async () => {
    const read = deferred<ReturnType<typeof answer>>()
    F.apiFetch.mockReturnValue(read.promise)
    render(<SwapBoard />)
    const line = screen.getByText(BOARD_COPY.loading)
    expect(line).toHaveAttribute("role", "status")
    expect(line.parentElement).toHaveAttribute("aria-busy", "true")
    expect(screen.queryByText(BOARD_COPY.empty.open)).toBeNull()
    await act(async () => read.resolve(answer(board({ listings: [card(7)] }))))
    await screen.findByText("Fox 7")
    expect(screen.queryByText(BOARD_COPY.loading)).toBeNull()
  })

  it("the board says it is loading again when a filter asks for a new read", async () => {
    F.apiFetch.mockResolvedValueOnce(answer(board({ listings: [card(7)] })))
    render(<SwapBoard />)
    await screen.findByText("Fox 7")
    const next = deferred<ReturnType<typeof answer>>()
    F.apiFetch.mockReturnValue(next.promise)
    fireEvent.click(screen.getByRole("button", { name: "Filled" }))
    expect(screen.getByText(BOARD_COPY.loading)).toBeInTheDocument()
    await act(async () => next.resolve(answer(board())))
    await screen.findByText(BOARD_COPY.empty.other)
  })

  it("the listing page says it is loading, never a bare skeleton, then shows the listing", async () => {
    const read = deferred<ReturnType<typeof answer>>()
    F.apiFetch.mockReturnValue(read.promise)
    render(<SwapDetail listingId="7" />)
    expect(screen.getByText(DETAIL_COPY.loading)).toHaveAttribute("role", "status")
    expect(screen.getByRole("heading", { level: 1, name: DETAIL_COPY.pageHeading })).toBeInTheDocument()
    await act(async () => read.resolve(answer(detail())))
    await screen.findByText("Proceeds to")
    expect(screen.queryByText(DETAIL_COPY.loading)).toBeNull()
  })

  it("a just-listed page shows the waiting line in the loading slot, not two status lines", async () => {
    const read = deferred<ReturnType<typeof answer>>()
    F.apiFetch.mockReturnValue(read.promise)
    render(<SwapDetail listingId="7" justListed />)
    expect(screen.getByText(DETAIL_COPY.waiting)).toBeInTheDocument()
    expect(screen.queryByText(DETAIL_COPY.loading)).toBeNull()
  })
})

describe("≈US$ beside an XRD ask", () => {
  const FRESH = { rate: 0.0006, stale: false, ageSeconds: 180, source: "astrolescent" }
  const TOKEN = "resource_rdx1tokenxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  const xrdAsk = (amount: string) => ({ kind: "fungible" as const, resource: XRD, amount })

  it("shows ≈US$ on the board card for the first XRD ask, display only, with its source and age", async () => {
    Q.value = FRESH
    F.apiFetch.mockResolvedValue(answer(board({ listings: [card(7, { asks: [xrdAsk("5000"), xrdAsk("100")] })] })))
    render(<SwapBoard />)
    const usd = await screen.findByText("≈US$3.00")
    expect(usd.title).toContain("Display only")
    expect(usd.title).toContain("set and paid in XRD")
    expect(usd.title).toContain("Astrolescent")
    expect(usd.title).toContain("updated 3 min ago")
    // The card still reads "<ask> … or 1 more": the dollar figure is only an addition.
    expect(usd.parentElement?.textContent).toContain("or 1 more")
  })

  it("shows ≈US$ on each XRD alternative on the listing page, and on what a filled listing was paid", async () => {
    Q.value = FRESH
    const d = detail()
    d.listing.asks = [xrdAsk("100"), xrdAsk("200")]
    F.apiFetch.mockResolvedValue(answer(d))
    const view = render(<SwapDetail listingId="7" />)
    await screen.findByText("≈US$0.06")
    expect(screen.getByText("≈US$0.12")).toBeInTheDocument()
    view.unmount()

    const filled = detail()
    filled.listing.asks = [xrdAsk("100"), xrdAsk("200")]
    filled.listing.state = "Filled"
    filled.listing.filledWith = 1
    filled.listing.status = "filled"
    F.apiFetch.mockResolvedValue(answer(filled))
    render(<SwapDetail listingId="7" />)
    await screen.findByText("Filled with")
    expect(screen.getAllByText("≈US$0.12").length).toBeGreaterThan(0)
  })

  it("never prices a token or an NFT ask, which the XRD rate says nothing about", async () => {
    Q.value = FRESH
    const d = detail()
    d.listing.asks = [
      { kind: "fungible", resource: TOKEN, amount: "5000" },
      { kind: "nonFungible", resource: ASSET, id: "#1#" },
    ]
    F.apiFetch.mockResolvedValue(answer(d))
    render(<SwapDetail listingId="7" />)
    await screen.findByText("Proceeds to")
    expect(document.body.textContent).not.toContain("US$")
  })

  it.each([
    ["no quote at all", { ...QUOTE_NONE }],
    ["a stale quote", { ...FRESH, stale: true }],
    ["a zero rate", { ...FRESH, rate: 0 }],
  ])("shows no dollar text with %s — never a zero, never a guess", async (_label, quote) => {
    Q.value = quote
    F.apiFetch.mockResolvedValue(answer(board({ listings: [card(7, { asks: [xrdAsk("5000")] })] })))
    const view = render(<SwapBoard />)
    await screen.findByText("Fox 7")
    expect(document.body.textContent).not.toContain("US$")
    view.unmount()
    F.apiFetch.mockResolvedValue(answer(detail()))
    render(<SwapDetail listingId="7" />)
    await screen.findByText("Proceeds to")
    expect(document.body.textContent).not.toContain("US$")
  })

  it("never puts a dollar figure into the sentence the buyer confirms", async () => {
    Q.value = FRESH
    W.account = OTHER
    const d = detail()
    d.listing.asks = [xrdAsk("100")]
    F.apiFetch.mockResolvedValue(answer(d))
    render(<SwapDetail listingId="7" />)
    fireEvent.click(await screen.findByRole("button", { name: "Fill" }))
    // "You send exactly <ask> from <account>. You receive the NFT …": the line the buyer acts on.
    const sentence = (await screen.findByText(/You receive the NFT/)).textContent ?? ""
    expect(sentence).toContain("You send exactly")
    expect(sentence).not.toContain("US$")
  })
})

describe("short addresses", () => {
  const writeText = vi.fn()
  beforeEach(() => {
    writeText.mockReset()
    writeText.mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
  })

  it("shows every address on the listing page in the short form, with the full value in the title and on the Dashboard link", async () => {
    F.apiFetch.mockResolvedValue(answer(detail()))
    render(<SwapDetail listingId="7" />)
    await screen.findByText("Proceeds to")
    for (const full of [SELLER, ASSET, "component_rdx1swap"]) {
      const link = screen.getAllByTitle(full)[0]
      expect(link).toHaveTextContent(shortAddress(full))
      expect(link).toHaveAttribute("href", expect.stringContaining(full))
    }
    // Nothing prints a raw address in the page text (it is all in title / href / copy).
    expect(document.body.textContent).not.toContain(SELLER)
    expect(document.body.textContent).not.toContain(ASSET)
  })

  it("keeps the collection's FULL address in the Fill confirmation, where the buyer compares it before signing", async () => {
    W.account = OTHER
    F.apiFetch.mockResolvedValue(answer(detail()))
    render(<SwapDetail listingId="7" />)
    fireEvent.click((await screen.findAllByRole("button", { name: "Fill with this" }))[0])
    const sentence = (await screen.findByText(/You receive the NFT/)).textContent ?? ""
    expect(sentence).toContain(ASSET)
    expect(sentence).toContain(OTHER)
  })

  it("copies the FULL address, not the short one", async () => {
    F.apiFetch.mockResolvedValue(answer(detail()))
    render(<SwapDetail listingId="7" />)
    await screen.findByText("Proceeds to")
    const row = screen.getByText("Proceeds to").parentElement as HTMLElement
    fireEvent.click(within(row).getByRole("button", { name: "Copy address" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SELLER))
  })
})

// ── 8. 28 Nov 2026: freeze, ask-resource safety, receipts as assets ──────────
//
// The three rules, on the pages. Live listing 9 (an NFT for an amount of a
// token that is not on the common list; recall and freeze locked-deny on both
// resources) is the shape that must keep listing and filling.

describe("SwapDetail — freeze guard, receipt assets and look-alike asks", () => {
  const noFillButtons = () => expect(screen.queryAllByRole("button", { name: /Fill/ })).toHaveLength(0)

  it.each([
    ["freezable", DETAIL_COPY.freezeNoFill],
    ["unknown", DETAIL_COPY.recallNoFillUnknown],
    [null, DETAIL_COPY.recallNoFillUnknown], // a read that carries no freeze at all
  ] as const)("freeze %s: no Fill is offered, the reason shows, cancel and extend stay", async (freeze, line) => {
    F.apiFetch.mockResolvedValue(answer(detail({ freeze })))
    render(<SwapDetail listingId="7" />)
    expect(await screen.findByTestId("recall-no-fill")).toHaveTextContent(line)
    noFillButtons()
    expect(screen.getByRole("button", { name: "Cancel listing" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Extend by 30 days" })).toBeEnabled()
  })

  it.each([
    ["the swap's own listing receipt (from the view's receiptResource)", RECEIPT],
    ["the escrow's task receipt (config)", ESCROW_RECEIPT_RESOURCE],
    ["the escrow's claim receipt (config)", ESCROW_CLAIM_RECEIPT_RESOURCE],
  ])("a listing whose asset is %s: no Fill is offered, even with locked roles; the seller keeps cancel", async (_what, receipt) => {
    F.apiFetch.mockResolvedValue(
      answer(detail({ assetResource: receipt, resources: { [receipt]: assetResource("locked-deny")[ASSET] } })),
    )
    render(<SwapDetail listingId="7" />)
    expect(await screen.findByTestId("recall-no-fill")).toHaveTextContent(DETAIL_COPY.receiptNoFill)
    noFillButtons()
    expect(screen.getByRole("button", { name: "Cancel listing" })).toBeEnabled()
  })

  it("a view with no readable receipt resource offers no Fill (the receipt check cannot fail open)", async () => {
    F.apiFetch.mockResolvedValue(answer({ ...detail(), receiptResource: undefined }))
    render(<SwapDetail listingId="7" />)
    await screen.findByTestId("recall-no-fill")
    noFillButtons()
  })

  it("the shape of live listing 9 — both resources locked, the ask a token off the common list — still fills", async () => {
    W.account = OTHER
    W.send.mockResolvedValue(committed("txid_rdx1filled"))
    F.apiFetch.mockResolvedValue(
      answer(detail({ asks: [{ kind: "fungible", resource: CIGGIE, amount: "420" }], resources: { [CIGGIE]: token(CIGGIE, "CIGGIE", "Ciggie") } })),
    )
    render(<SwapDetail listingId="7" />)
    fireEvent.click(await screen.findByRole("button", { name: "Fill" }))
    expect(screen.queryByTestId("recall-no-fill")).toBeNull()
    expect(screen.queryByTestId("look-alike-ask")).toBeNull()
    // A token off the common list reads with its address beside its symbol.
    expect(screen.getAllByText(`420 CIGGIE (${shortAddress(CIGGIE)})`).length).toBeGreaterThan(0)
    expect(screen.queryByText("420 CIGGIE")).toBeNull()
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: /Open my wallet to fill/ }))
    await waitFor(() => expect(W.send).toHaveBeenCalledTimes(1))
    expect(W.send.mock.calls[0][0].transactionManifest).toBe("FILL")
    // The builder got the asset check the page made.
    expect(M.fill[0].at(-1)).toEqual({ control: "locked", receiptResources: [RECEIPT, ESCROW_RECEIPT_RESOURCE, ESCROW_CLAIM_RECEIPT_RESOURCE], assetName: "Dinos" })
  })

  it.each([
    ["restrictable", DETAIL_COPY.transferNoFill],
    ["unknown", DETAIL_COPY.recallNoFillUnknown],
    [null, DETAIL_COPY.recallNoFillUnknown], // a read that carries no transfer field
  ] as const)("transfer rules %s: no Fill is offered, the reason shows, cancel stays", async (transfer, line) => {
    F.apiFetch.mockResolvedValue(answer(detail({ transfer })))
    render(<SwapDetail listingId="7" />)
    expect(await screen.findByTestId("recall-no-fill")).toHaveTextContent(line)
    noFillButtons()
    expect(screen.getByRole("button", { name: "Cancel listing" })).toBeEnabled()
  })

  it("an ask in a token that calls itself XRD never reads as XRD: it shows by address, with a warning and the full address", async () => {
    W.account = OTHER
    F.apiFetch.mockResolvedValue(
      answer(detail({ asks: [{ kind: "fungible", resource: FAKE_XRD, amount: "100" }], resources: { [FAKE_XRD]: token(FAKE_XRD, "XRD", "Radix") } })),
    )
    render(<SwapDetail listingId="7" />)
    expect(await screen.findByTestId("look-alike-ask")).toHaveTextContent(DETAIL_COPY.lookAlikeAsk("XRD"))
    expect(screen.queryByText("100 XRD")).toBeNull()
    expect(screen.getByText(`100 of ${shortAddress(FAKE_XRD)} (calls itself “XRD”)`)).toBeInTheDocument()
    // The full address is on the page, not only in a hover title.
    expect(screen.getByRole("link", { name: FAKE_XRD })).toBeInTheDocument()
  })

  it("the real XRD still reads as XRD", async () => {
    F.apiFetch.mockResolvedValue(answer(detail({ resources: { [XRD]: token(XRD, "XRD", "Radix") } })))
    render(<SwapDetail listingId="7" />)
    expect((await screen.findAllByText("100 XRD")).length).toBeGreaterThan(0)
    expect(screen.queryByTestId("look-alike-ask")).toBeNull()
  })
})

describe("SwapBoard — look-alike asks", () => {
  it("a card whose ask is a token calling itself XRD shows the address, not '100 XRD'; a real XRD card is unchanged", async () => {
    const fake = card(8, { asks: [{ kind: "fungible", resource: FAKE_XRD, amount: "100" }] })
    const real = card(9, { asks: [{ kind: "fungible", resource: XRD, amount: "100" }] })
    F.apiFetch.mockResolvedValue(
      answer(board({ listings: [fake, real], resources: { [FAKE_XRD]: token(FAKE_XRD, "XRD", "Radix"), [XRD]: token(XRD, "XRD", "Radix") } as never })),
    )
    render(<SwapBoard />)
    await screen.findByText("Fox 8")
    expect(screen.getByText(`100 of ${shortAddress(FAKE_XRD)} (calls itself “XRD”)`)).toBeInTheDocument()
    expect(screen.getAllByText("100 XRD")).toHaveLength(1)
  })

  it("a token off the common list always carries its address on a card; a nameless one shows by address alone", async () => {
    const ciggie = card(8, { asks: [{ kind: "fungible", resource: CIGGIE, amount: "420" }] })
    const nameless = card(9, { asks: [{ kind: "fungible", resource: FAKE_XRD, amount: "5" }] })
    F.apiFetch.mockResolvedValue(answer(board({ listings: [ciggie, nameless], resources: { [CIGGIE]: token(CIGGIE, "CIGGIE", "Ciggie") } as never })))
    render(<SwapBoard />)
    await screen.findByText("Fox 8")
    expect(screen.getByText(`420 CIGGIE (${shortAddress(CIGGIE)})`)).toBeInTheDocument()
    expect(screen.getByText(`5 ${shortAddress(FAKE_XRD)}`)).toBeInTheDocument()
  })
})

describe("SwapBoard — a listing its page offers no Fill for says so on the card", () => {
  const asset = (over: Record<string, unknown> = {}) => ({ ...assetResource("locked-deny")[ASSET], ...over })
  const show = async (resources: Record<string, unknown>, listings = [card(7)]) => {
    F.apiFetch.mockResolvedValue(answer(board({ listings, resources: resources as never })))
    render(<SwapBoard />)
    await screen.findByText(/^Listing 7 ·/)
  }

  it("a locked asset (the shape of live listing 9) carries no such line", async () => {
    await show({ [ASSET]: asset() })
    expect(screen.queryByTestId("card-no-fill")).toBeNull()
  })
  it.each([
    ["recallable", { recall: "recallable" }],
    ["freezable", { freeze: "freezable" }],
    ["transfer-restrictable", { transfer: "restrictable" }],
    ["unread", { transfer: undefined }],
  ])("a %s asset is marked", async (_what, over) => {
    await show({ [ASSET]: asset(over) })
    expect(screen.getByTestId("card-no-fill")).toHaveTextContent(BOARD_COPY.noFillCard)
  })
  it("an asset missing from the read is marked", async () => {
    await show({})
    expect(screen.getByTestId("card-no-fill")).toBeInTheDocument()
  })
  it("a Guild receipt listed as the asset is marked, even with locked roles", async () => {
    await show({ [RECEIPT]: asset() }, [card(7, { assetResource: RECEIPT })])
    expect(screen.getByTestId("card-no-fill")).toBeInTheDocument()
  })
  it("a listing that is no longer open is not marked: there is no Fill to miss", async () => {
    await show({ [ASSET]: asset({ recall: "recallable" }) }, [card(7, { status: "filled", state: "Filled", filledWith: 0 })])
    expect(screen.queryByTestId("card-no-fill")).toBeNull()
  })
})

describe("ListNftForm — freeze guard, receipts and ask resources", () => {
  const submit = () => screen.getByRole("button", { name: /Open my wallet to list/ })
  /** Arm the form with the asset picked, then paste `address` as the ask's token. */
  async function pasteAsk(askRead: Record<string, unknown>, address: string, amount = "420") {
    holdings(listRes("locked-deny"))
    G.readResourceDisplay.mockImplementation(async (addrs: string[]) =>
      addrs.includes(ASSET) ? listRes("locked-deny") : new Map(Object.entries({ [XRD]: token(XRD, "XRD", "Radix"), ...askRead })),
    )
    render(<ListNftForm />)
    fireEvent.click(await screen.findByRole("button", { name: /#1#/ }))
    fireEvent.change(screen.getByLabelText("Alternative 1 token"), { target: { value: "other" } })
    fireEvent.change(screen.getByLabelText("Alternative 1 token address"), { target: { value: address } })
    if (amount) fireEvent.change(screen.getByLabelText("Alternative 1 amount"), { target: { value: amount } })
  }

  it.each([
    ["freezable", LIST_COPY.freezable],
    ["unknown", LIST_COPY.recallUnknown],
    [null, LIST_COPY.recallUnknown], // a read that carries no freeze at all
  ] as const)("a collection whose freeze is %s: the NFT cannot be picked, the reason shows, submit stays disabled", async (freeze, line) => {
    holdings(listRes("locked-deny", freeze))
    render(<ListNftForm />)
    await screen.findByText(line)
    expect(screen.getByRole("button", { name: /#1#/ })).toBeDisabled()
    expect(submit()).toBeDisabled()
  })

  it.each([
    ["restrictable", LIST_COPY.restrictable],
    ["unknown", LIST_COPY.recallUnknown],
    [null, LIST_COPY.recallUnknown], // a read that carries no transfer field
  ] as const)("a collection whose transfer rules are %s: the NFT cannot be picked, the reason shows", async (transfer, line) => {
    holdings(listRes("locked-deny", "locked-deny", ASSET, transfer))
    render(<ListNftForm />)
    await screen.findByText(line)
    expect(screen.getByRole("button", { name: /#1#/ })).toBeDisabled()
    expect(submit()).toBeDisabled()
  })

  it.each([
    ["the swap's own listing receipts (read from the component)", RECEIPT],
    ["the escrow's task receipts (config)", ESCROW_RECEIPT_RESOURCE],
    ["the escrow's claim receipts (config)", ESCROW_CLAIM_RECEIPT_RESOURCE],
  ])("%s in the account cannot be picked, even with locked roles", async (_what, receipt) => {
    holdings(listRes("locked-deny", "locked-deny", receipt))
    G.readAccountNonFungibles.mockResolvedValue({ groups: [{ resource: receipt, ids: ["#1#"], more: false }], moreResources: false })
    G.readResourceDisplay.mockResolvedValue(listRes("locked-deny", "locked-deny", receipt))
    render(<ListNftForm />)
    await screen.findByText(LIST_COPY.isReceipt)
    expect(screen.getByRole("button", { name: /#1#/ })).toBeDisabled()
    expect(submit()).toBeDisabled()
  })

  it("nothing can be picked while the component's receipt resource is unread", async () => {
    holdings(listRes("locked-deny"))
    G.readSwapComponentState.mockResolvedValue(null)
    render(<ListNftForm />)
    expect(await screen.findByRole("button", { name: /#1#/ })).toBeDisabled()
    expect(submit()).toBeDisabled()
  })

  it("the shape of live listing 9 — a locked collection for a pasted, locked token off the common list — still lists, with the address and warning shown", async () => {
    W.send.mockResolvedValue(committed("txid_rdx1listed"))
    G.readListedListingId.mockResolvedValue(9)
    await pasteAsk({ [CIGGIE]: token(CIGGIE, "CIGGIE", "Ciggie") }, CIGGIE)
    const note = await screen.findByTestId("ask-not-common")
    expect(note).toHaveTextContent(LIST_COPY.notCommonWarning)
    expect(note).toHaveTextContent(CIGGIE)
    await waitFor(() => expect(submit()).toBeEnabled())
    fireEvent.click(submit())
    await waitFor(() => expect(W.send).toHaveBeenCalledTimes(1))
    expect(W.send.mock.calls[0][0].transactionManifest).toBe("LIST")
    // The builder got the asset check, with the receipt resource from the read made at submit.
    expect(M.list[0].at(-1)).toEqual({ control: "locked", receiptResources: [RECEIPT, ESCROW_RECEIPT_RESOURCE, ESCROW_CLAIM_RECEIPT_RESOURCE], assetName: "Dinos" })
  })

  it("a common token shows no pasted-token warning", async () => {
    holdings(listRes("locked-deny"))
    render(<ListNftForm />)
    await screen.findByText("Radix (XRD)")
    expect(screen.queryByTestId("ask-not-common")).toBeNull()
  })

  it.each([
    ["recallable", token(CIGGIE, "CIGGIE", "Ciggie", "recallable"), ASK_PROBLEM_TEXT.issuer_recall],
    ["freezable", token(CIGGIE, "CIGGIE", "Ciggie", "locked-deny", "freezable"), ASK_PROBLEM_TEXT.issuer_freeze],
    ["unreadable", token(CIGGIE, "CIGGIE", "Ciggie", "locked-deny", "unknown"), ASK_PROBLEM_TEXT.issuer_unknown],
    ["missing from the read", token(CIGGIE, "CIGGIE", "Ciggie", "locked-deny", null), ASK_PROBLEM_TEXT.issuer_unknown],
    ["transfer-restrictable", token(CIGGIE, "CIGGIE", "Ciggie", "locked-deny", "locked-deny", "restrictable"), ASK_PROBLEM_TEXT.issuer_transfer],
    ["without a transfer read", token(CIGGIE, "CIGGIE", "Ciggie", "locked-deny", "locked-deny", null), ASK_PROBLEM_TEXT.issuer_unknown],
  ])("a pasted ask token whose recall or freeze is %s blocks the listing and says why, before an amount is typed", async (_what, read, line) => {
    await pasteAsk({ [CIGGIE]: read }, CIGGIE, "")
    await screen.findByText(line)
    fireEvent.change(screen.getByLabelText("Alternative 1 amount"), { target: { value: "5" } })
    expect(screen.getByText(line)).toBeInTheDocument()
    expect(submit()).toBeDisabled()
    expect(W.send).not.toHaveBeenCalled()
  })

  it("a pasted token that calls itself XRD at another address is blocked as a look-alike, with its address shown", async () => {
    await pasteAsk({ [FAKE_XRD]: token(FAKE_XRD, "XRD", "Radix") }, FAKE_XRD)
    await screen.findByText(ASK_PROBLEM_TEXT.look_alike)
    expect(screen.getByTestId("ask-not-common")).toHaveTextContent(FAKE_XRD)
    expect(submit()).toBeDisabled()
  })

  it.each([
    ["a listing receipt", RECEIPT],
    ["a task receipt", ESCROW_RECEIPT_RESOURCE],
  ])("%s cannot be asked for, even with locked roles", async (_what, receipt) => {
    holdings(listRes("locked-deny"))
    G.readResourceDisplay.mockImplementation(async (addrs: string[]) =>
      addrs.includes(ASSET) ? listRes("locked-deny") : new Map<string, unknown>([[XRD, token(XRD, "XRD", "Radix")], ...listRes("locked-deny", "locked-deny", receipt)]),
    )
    render(<ListNftForm />)
    fireEvent.click(await screen.findByRole("button", { name: /#1#/ }))
    fireEvent.change(screen.getByLabelText("Alternative 1 kind"), { target: { value: "nonFungible" } })
    fireEvent.change(screen.getByLabelText("Alternative 1 collection"), { target: { value: receipt } })
    fireEvent.change(screen.getByLabelText("Alternative 1 NFT id"), { target: { value: "#2#" } })
    await screen.findByText(ASK_PROBLEM_TEXT.receipt_ask)
    expect(submit()).toBeDisabled()
  })

  it("an NFT ask in a collection whose issuer can freeze it is blocked too", async () => {
    const COLL = "resource_rdx1askcoll0000000000000000000000000000000000000000000"
    holdings(listRes("locked-deny"))
    G.readResourceDisplay.mockImplementation(async (addrs: string[]) =>
      addrs.includes(ASSET) ? listRes("locked-deny") : new Map<string, unknown>([[XRD, token(XRD, "XRD", "Radix")], ...listRes("locked-deny", "freezable", COLL)]),
    )
    render(<ListNftForm />)
    fireEvent.click(await screen.findByRole("button", { name: /#1#/ }))
    fireEvent.change(screen.getByLabelText("Alternative 1 kind"), { target: { value: "nonFungible" } })
    fireEvent.change(screen.getByLabelText("Alternative 1 collection"), { target: { value: COLL } })
    fireEvent.change(screen.getByLabelText("Alternative 1 NFT id"), { target: { value: "#2#" } })
    await screen.findByText(ASK_PROBLEM_TEXT.issuer_freeze)
    expect(screen.getByTestId("ask-not-common")).toHaveTextContent(COLL)
    expect(submit()).toBeDisabled()
  })
})

// ── 9. Review follow-up (28 Nov 2026): receipts by name, NFT ask addresses ───
//
// Mainnet listing 4's asset was a "Guild Marketplace Task Receipt" of an
// escrow instance that is not the configured one: locked roles, an address in
// no list. The name is what marks it.

describe("a Guild receipt the address list does not know", () => {
  const NAME = "Guild Marketplace Task Receipt"
  const named = { ...assetResource("locked-deny")[ASSET], name: NAME }

  it("listing page: no Fill is offered, the receipt reason shows, the seller keeps cancel", async () => {
    F.apiFetch.mockResolvedValue(answer(detail({ resources: { [ASSET]: named } })))
    render(<SwapDetail listingId="7" />)
    expect(await screen.findByTestId("recall-no-fill")).toHaveTextContent(DETAIL_COPY.receiptNoFill)
    expect(screen.queryAllByRole("button", { name: /Fill/ })).toHaveLength(0)
    expect(screen.getByRole("button", { name: "Cancel listing" })).toBeEnabled()
  })
  it("board: the card says Fill is not offered", async () => {
    F.apiFetch.mockResolvedValue(answer(board({ listings: [card(7)], resources: { [ASSET]: named } as never })))
    render(<SwapBoard />)
    expect(await screen.findByTestId("card-no-fill")).toBeInTheDocument()
  })
  it("list form: it cannot be picked, and it cannot be asked for", async () => {
    holdings(new Map([[ASSET, { address: ASSET, ...named }]]))
    const first = render(<ListNftForm />)
    await screen.findByText(LIST_COPY.isReceipt)
    expect(screen.getByRole("button", { name: /#1#/ })).toBeDisabled()
    first.unmount()

    const COLL = "resource_rdx1otherreceipt00000000000000000000000000000000000000000"
    holdings(listRes("locked-deny"))
    G.readResourceDisplay.mockImplementation(async (addrs: string[]) =>
      addrs.includes(ASSET) ? listRes("locked-deny") : new Map<string, unknown>([[XRD, token(XRD, "XRD", "Radix")], [COLL, { address: COLL, ...named }]]),
    )
    render(<ListNftForm />)
    fireEvent.click(await screen.findByRole("button", { name: /#1#/ }))
    fireEvent.change(screen.getByLabelText("Alternative 1 kind"), { target: { value: "nonFungible" } })
    fireEvent.change(screen.getByLabelText("Alternative 1 collection"), { target: { value: COLL } })
    fireEvent.change(screen.getByLabelText("Alternative 1 NFT id"), { target: { value: "#2#" } })
    await screen.findByText(ASK_PROBLEM_TEXT.receipt_ask)
    expect(screen.getByRole("button", { name: /Open my wallet to list/ })).toBeDisabled()
  })
})

describe("an NFT ask never shows a collection name without its address", () => {
  const COLL = "resource_rdx1askcoll0000000000000000000000000000000000000000000"
  const asks = [{ kind: "nonFungible" as const, resource: COLL, id: "#5#" }]
  it("board card: name and short address; with no name, the address alone", async () => {
    F.apiFetch.mockResolvedValue(
      answer(board({ listings: [card(7, { asks }), card(8, { asks: [{ ...asks[0], resource: FAKE_XRD }] })], resources: { [COLL]: { ...assetResource("locked-deny")[ASSET], name: "Ciggie Puffs" } } as never })),
    )
    render(<SwapBoard />)
    await screen.findByText("Fox 7")
    expect(screen.getByText(`NFT #5# of Ciggie Puffs (${shortAddress(COLL)})`)).toBeInTheDocument()
    expect(screen.getByText(`NFT #5# of ${shortAddress(FAKE_XRD)}`)).toBeInTheDocument()
    expect(screen.queryByText("NFT #5# of Ciggie Puffs")).toBeNull()
  })
})
