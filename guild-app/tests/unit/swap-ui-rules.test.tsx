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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

const SELLER = "account_rdx12seller0000000000000000000000000000000000000000000000"
const OTHER = "account_rdx12other00000000000000000000000000000000000000000000000"
const ASSET = "resource_rdx1asset000000000000000000000000000000000000000000000000"
const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"
const T = 1_800_000_000

const W = vi.hoisted(() => ({ account: null as string | null, send: vi.fn() }))
vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    account: W.account,
    rdt: W.account ? { walletApi: { sendTransaction: W.send } } : null,
  }),
}))

const F = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock("@/lib/api-fetch", () => ({ apiFetch: F.apiFetch }))

vi.mock("@/lib/manifests", () => ({
  burnListingReceiptManifest: () => "BURN",
  cancelSwapManifest: () => "CANCEL",
  extendSwapListingManifest: () => "EXTEND",
  fillSwapManifest: () => "FILL",
  withdrawSwapProceedsManifest: () => "WITHDRAW",
  listSwapManifest: () => "LIST",
}))

const G = vi.hoisted(() => ({
  readAccountNonFungibles: vi.fn(),
  readListedListingId: vi.fn(),
  readNftDisplay: vi.fn(),
  readResourceDisplay: vi.fn(),
  readSwapComponentState: vi.fn(),
}))
vi.mock("@/lib/nft-swap-gateway", () => G)

const R = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => R }))

import { humanizeSwapTxError } from "@/components/swaps/swap-bits"
import { SwapDetail } from "@/components/swaps/swap-detail"
import { SwapBoard } from "@/components/swaps/swap-board"
import { ListNftForm } from "@/components/swaps/list-nft-form"
import { humanizeTxError } from "@/lib/escrow-utils"
import * as swapsCopy from "@/content/swaps"
import { BOARD_COPY, DETAIL_COPY } from "@/content/swaps"
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

function detail(over: { receipt?: SwapDetailView["receipt"]; expiresAt?: number } = {}): SwapDetailView {
  return {
    component: "component_rdx1swap",
    receiptResource: "resource_rdx1receipt",
    ledgerTime: T,
    fees: { fill: { unit: "XRD", amount: "5" }, extend: { unit: "XRD", amount: "1" } },
    resources: {},
    listing: {
      listingId: 7,
      seller: SELLER,
      assetResource: ASSET,
      assetId: "#1#",
      asks: [
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
  W.send.mockReset()
  F.apiFetch.mockReset()
  Object.values(G).forEach((f) => f.mockReset())
  R.push.mockReset()
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
    ["alternative index out of range", /not on this listing/],
    ["wrong receipt resource", /not this component's listing receipt/],
    ["proceeds already withdrawn", /already withdrawn/],
    ["cannot burn the receipt while the listing is still Listed — cancel first", /Cancel the listing first/],
    ["cannot burn the receipt while proceeds are still owed — withdraw first", /Withdraw them first/],
    ["expires_at must be at most 30 days out (S2 — mandatory expiry ceiling)", /refused the expiry/],
    ["listing must escrow exactly one NFT", /exactly one NFT/],
  ])("maps the blueprint's %j to a plain line", (msg, line) => {
    const raw = engine(msg)
    const h = humanizeSwapTxError(raw)
    expect(h.summary).toMatch(line)
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
    receiptResource: "resource_rdx1receipt",
    ledgerTime: T,
    fees: { fill: null, extend: null },
    resources: {},
    total: 1500,
    truncated: false,
    unreadable: [],
    hidden: 0,
    listings: [],
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

// ── 5. The List form ─────────────────────────────────────────────────────────

function holdings(resourceRead: Map<string, unknown> | null) {
  G.readSwapComponentState.mockResolvedValue({ ledgerNow: T })
  G.readAccountNonFungibles.mockResolvedValue({ groups: [{ resource: ASSET, ids: ["#1#"], more: false }], moreResources: false })
  G.readNftDisplay.mockResolvedValue(new Map())
  G.readResourceDisplay.mockImplementation(async (addrs: string[]) =>
    addrs.includes(ASSET) ? resourceRead : new Map([[XRD, { address: XRD, kind: "fungible", divisibility: 18, name: "Radix", symbol: "XRD", iconUrl: null, withdraw: "open" }]]),
  )
}

describe("ListNftForm", () => {
  it("a failed resource read fails the holdings read, so no NFT can be armed", async () => {
    holdings(null)
    render(<ListNftForm />)
    await screen.findByText(/NFTs in this account could not be read/)
    expect(screen.queryByRole("button", { name: /#1#/ })).toBeNull()
    expect(screen.getByRole("button", { name: /Open my wallet to list/ })).toBeDisabled()
  })

  it("stays disarmed from a committed list until the listing id is read back, showing the transaction", async () => {
    holdings(new Map([[ASSET, { address: ASSET, kind: "nonFungible", divisibility: null, name: "Dinos", symbol: null, iconUrl: null, withdraw: "open" }]]))
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
