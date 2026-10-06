"use client"

// /swaps/[id] — one listing, read fresh from the chain through
// GET /api/v1/swaps/{id}, with the buyer's Fill and the receipt holder's
// Cancel / Extend / Withdraw proceeds / Burn receipt. Client-rendered for the
// same reason as the board (swap-board.tsx): NFT text is a stranger's, not
// the Guild's copy.
//
// Which buttons show is asked of the chain, never predicted: the status comes
// from the ledger clock the API read, and the seller panel appears only when
// the Gateway says the connected account holds this listing's receipt.

import { useEffect, useState } from "react"
import { Wallet } from "lucide-react"
import { apiFetch } from "@/lib/api-fetch"
import {
  burnListingReceiptManifest,
  cancelSwapManifest,
  extendSwapListingManifest,
  fillSwapManifest,
  withdrawSwapProceedsManifest,
} from "@/lib/manifests"
import {
  extendedExpiry,
  filledAsk,
  formatAmount,
  proceedsOwed,
  receiptBurnable,
  type SwapAsk,
} from "@/lib/nft-swap"
import type { SwapFee } from "@/lib/nft-swap-gateway"
import type { SwapDetailView } from "@/lib/nft-swap-service"
import { DETAIL_COPY, WHAT_THIS_IS_NOT } from "@/content/swaps"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  AddressLink,
  askText,
  NftImage,
  relativeTime,
  SwapStatusBadge,
  TxDoneLine,
  TxErrorLine,
  useSwapTx,
  utcStamp,
} from "./swap-bits"

/** A panel reports a committed action up, so the line survives the refresh
 *  that re-renders (or removes) the panel itself. */
type Done = (text: string, txId: string) => void

type Load =
  | { state: "loading" }
  | { state: "error"; code: string; message: string }
  | { state: "ok"; view: SwapDetailView; stale?: boolean }

function feeText(fee: SwapFee | null): string {
  if (!fee) return "could not be read — the wallet's fee summary shows it"
  if (fee.unit === "USD") return `$${formatAmount(fee.amount)}, paid in XRD at the network's rate`
  return `${formatAmount(fee.amount)} XRD`
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function AskBlock({ ask, view }: { ask: SwapAsk; view: SwapDetailView }) {
  if (ask.kind === "fungible") {
    return (
      <div className="min-w-0">
        <p className="font-semibold tabular-nums">{askText(ask, view.resources)}</p>
        <p className="text-xs text-muted-foreground">
          Exactly this amount of <AddressLink address={ask.resource} />
        </p>
      </div>
    )
  }
  const nft = view.askNfts[`${ask.resource} ${ask.id}`]
  return (
    <div className="flex min-w-0 items-center gap-3">
      <NftImage src={nft?.imageUrl ?? null} alt={nft?.name ?? ask.id} className="h-12 w-12 shrink-0 rounded-md" />
      <div className="min-w-0">
        <p className="font-semibold">{nft?.name ? `${nft.name} (${ask.id})` : askText(ask, view.resources)}</p>
        <p className="text-xs text-muted-foreground">
          The NFT {ask.id} of <AddressLink address={ask.resource} />
        </p>
      </div>
    </div>
  )
}

function FillPanel({ view, onDone }: { view: SwapDetailView; onDone: Done }) {
  const l = view.listing
  const tx = useSwapTx()
  const [picked, setPicked] = useState<number | null>(null)
  const [checked, setChecked] = useState(false)
  const own = tx.account === l.seller

  const fill = async () => {
    if (picked === null) return
    const ask = l.asks[picked]
    const id = await tx.send((account) => fillSwapManifest(view.component, account, l.listingId, picked, ask))
    if (id) {
      setPicked(null)
      setChecked(false)
      onDone("Filled — the NFT is in your account.", id)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{DETAIL_COPY.fillHeading}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">{DETAIL_COPY.fillIntro}</p>
        <ol className="space-y-2">
          {l.asks.map((ask, i) => (
            <li
              key={i}
              className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 ${picked === i ? "border-primary" : ""}`}
            >
              <AskBlock ask={ask} view={view} />
              {tx.connected && (
                <Button
                  size="sm"
                  variant={picked === i ? "default" : "outline"}
                  onClick={() => {
                    setPicked(i)
                    setChecked(false)
                    tx.reset()
                  }}
                  aria-pressed={picked === i}
                >
                  {l.asks.length === 1 ? "Fill" : "Fill with this"}
                </Button>
              )}
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground">
          Fill fee: {feeText(view.fees.fill)} (a component royalty, read from the component just now), plus the Radix
          network fee. Your wallet shows the total before you sign.
        </p>

        {!tx.connected && <p className="text-xs text-muted-foreground">{DETAIL_COPY.fillNoWallet}</p>}
        {own && <p className="text-xs text-muted-foreground">{DETAIL_COPY.ownListing}</p>}

        {picked !== null && (
          <div className="space-y-3 rounded-lg bg-muted/50 p-3">
            <p>
              You send exactly <strong>{askText(l.asks[picked], view.resources)}</strong> from{" "}
              <span className="font-mono text-xs break-all">{tx.account}</span>. You receive the NFT {l.assetId} of{" "}
              <AddressLink address={l.assetResource} /> in the same transaction.
            </p>
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
              />
              <span>{DETAIL_COPY.fillConfirmCheck}</span>
            </label>
            <Button onClick={() => void fill()} disabled={!checked || tx.busy}>
              <Wallet className="mr-2 h-4 w-4" />
              {tx.busy ? "Check your wallet…" : "Open my wallet to fill"}
            </Button>
          </div>
        )}
        <TxErrorLine error={tx.error} />
        {tx.error && <TxDoneLine txId={tx.txId}>The transaction:</TxDoneLine>}
      </CardContent>
    </Card>
  )
}

function SellerPanel({ view, onDone }: { view: SwapDetailView; onDone: Done }) {
  const l = view.listing
  const tx = useSwapTx()

  const act = async (label: string, build: (account: string) => string) => {
    const id = await tx.send(build)
    if (id) onDone(label, id)
  }
  const owed = filledAsk(l)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{DETAIL_COPY.sellerHeading}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">{DETAIL_COPY.sellerIntro}</p>

        {l.state === "Listed" && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={tx.busy}
                onClick={() =>
                  void act("Cancelled — the NFT is back in your account.", (a) =>
                    cancelSwapManifest(view.component, a, view.receiptResource, l.listingId),
                  )
                }
              >
                Cancel listing
              </Button>
              <Button
                variant="outline"
                disabled={tx.busy}
                onClick={() =>
                  void act("Extended.", (a) => extendSwapListingManifest(view.component, a, view.receiptResource, l.listingId))
                }
              >
                Extend by 30 days
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Cancel is free and returns the NFT to the account holding the receipt. Extending moves the expiry to{" "}
              {utcStamp(extendedExpiry(l, view.ledgerTime))} and carries the extension fee: {feeText(view.fees.extend)}, plus
              the network fee.
            </p>
          </div>
        )}

        {proceedsOwed(l) && owed && (
          <div className="space-y-2">
            <Button
              disabled={tx.busy}
              onClick={() =>
                void act("Withdrawn — the proceeds are in the seller account.", (a) =>
                  withdrawSwapProceedsManifest(view.component, a, view.receiptResource, l.listingId),
                )
              }
            >
              <Wallet className="mr-2 h-4 w-4" />
              Withdraw {askText(owed, view.resources)}
            </Button>
            <p className="text-xs text-muted-foreground">
              {DETAIL_COPY.proceedsTo} <AddressLink address={l.seller} />
            </p>
          </div>
        )}

        {receiptBurnable(l) && (
          <div className="space-y-2">
            <Button
              variant="outline"
              size="sm"
              disabled={tx.busy}
              onClick={() =>
                void act("Receipt burned.", (a) => burnListingReceiptManifest(view.component, a, view.receiptResource, l.listingId))
              }
            >
              Burn the listing receipt
            </Button>
            <p className="text-xs text-muted-foreground">{DETAIL_COPY.burnHint}</p>
          </div>
        )}

        {tx.busy && <p className="text-xs text-muted-foreground">Check your wallet…</p>}
        <TxErrorLine error={tx.error} />
        {tx.error && <TxDoneLine txId={tx.txId}>The transaction:</TxDoneLine>}
      </CardContent>
    </Card>
  )
}

async function readDetail(listingId: string): Promise<{ view: SwapDetailView } | { code: string; message: string }> {
  try {
    const res = await apiFetch(`/api/v1/swaps/${encodeURIComponent(listingId)}`)
    const body = await res.json().catch(() => null)
    if (res.ok && body?.ok) return { view: body.data as SwapDetailView }
    return {
      code: body?.error?.code ?? "CHAIN_UNREADABLE",
      message: body?.error?.message ?? "The listing could not be read. Try again shortly.",
    }
  } catch {
    return { code: "NETWORK", message: "The listing could not be read. Try again shortly." }
  }
}

export function SwapDetail({ listingId }: { listingId: string }) {
  const tx = useSwapTx()
  const [load, setLoad] = useState<Load>({ state: "loading" })
  const [notice, setNotice] = useState<{ text: string; txId: string } | null>(null)

  const [reloadKey, setReloadKey] = useState(0)
  const refresh = () => setReloadKey((k) => k + 1)

  // State is set only in the promise callback (react-hooks/set-state-in-effect).
  // A failed RE-read keeps the last good view on screen, marked stale: a
  // Gateway blip right after a fill must not blank the page that just
  // reported it.
  useEffect(() => {
    let cancelled = false
    readDetail(listingId).then((r) => {
      if (cancelled) return
      setLoad((prev) =>
        "view" in r
          ? { state: "ok", view: r.view }
          : prev.state === "ok"
            ? { ...prev, stale: true }
            : { state: "error", code: r.code, message: r.message },
      )
    })
    return () => {
      cancelled = true
    }
  }, [listingId, reloadKey])

  const done: Done = (text, txId) => {
    setNotice({ text, txId })
    refresh()
  }

  if (load.state === "loading") {
    return (
      <Skeleton className="h-80 w-full rounded-xl" />
    )
  }
  if (load.state === "error") {
    return (
      <p className="rounded-lg border p-4 text-sm" role="alert">
        {load.message}
      </p>
    )
  }

  const { view } = load
  const l = view.listing
  const coll = view.resources[l.assetResource]?.name ?? null
  const name = l.asset.name ?? (coll ? `${coll} ${l.assetId}` : `NFT ${l.assetId}`)
  const holdsReceipt = Boolean(tx.account && view.receipt?.holder === tx.account)
  const filled = filledAsk(l)

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <NftImage src={l.asset.imageUrl} alt={name} className="aspect-square w-full rounded-xl" />
        <div className="min-w-0 space-y-4">
          <header className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold break-words">{name}</h2>
              <SwapStatusBadge status={l.status} />
            </div>
            <p className="text-sm text-muted-foreground">On the Guild NFT swap component</p>
          </header>
          <dl className="space-y-2">
            <Row label="Collection">
              {coll && <span className="mr-2">{coll}</span>}
              <AddressLink address={l.assetResource} />
            </Row>
            <Row label="NFT id">
              <span className="font-mono text-xs">{l.assetId}</span>
            </Row>
            <Row label="Seller">
              <AddressLink address={l.seller} />
            </Row>
            <Row label="Listed">{utcStamp(l.createdAt)}</Row>
            <Row label={l.status === "open" ? "Expires" : "Expiry"}>
              {utcStamp(l.expiresAt)}
              {l.state === "Listed" && (
                <span className="text-muted-foreground"> ({relativeTime(l.expiresAt, view.ledgerTime)})</span>
              )}
            </Row>
            {filled && (
              <Row label="Filled with">
                {askText(filled, view.resources)}
                <span className="text-muted-foreground">
                  {" "}
                  · proceeds {l.proceedsWithdrawn ? "withdrawn by the seller" : "waiting for the seller to withdraw"}
                </span>
              </Row>
            )}
            <Row label="Receipt">
              {view.receipt === null ? (
                <span className="text-muted-foreground">holder could not be read</span>
              ) : view.receipt.burned ? (
                <span className="text-muted-foreground">burned</span>
              ) : view.receipt.holder ? (
                <AddressLink address={view.receipt.holder} />
              ) : (
                <span className="text-muted-foreground">not found</span>
              )}
            </Row>
          </dl>
        </div>
      </div>

      {load.stale && (
        <p className="text-xs text-muted-foreground" role="status">
          The listing could not be re-read just now; this is the last read.{" "}
          <button type="button" className="underline" onClick={refresh}>
            Try again
          </button>
        </p>
      )}
      {notice && (
        <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
          <TxDoneLine txId={notice.txId}>{notice.text}</TxDoneLine>
        </div>
      )}

      {l.status === "open" && <FillPanel view={view} onDone={done} />}
      {l.status === "expired" && <p className="rounded-lg border p-4 text-sm">{DETAIL_COPY.expired}</p>}
      {l.status === "filled" && <p className="rounded-lg border p-4 text-sm">{DETAIL_COPY.filled}</p>}
      {l.status === "cancelled" && <p className="rounded-lg border p-4 text-sm">{DETAIL_COPY.cancelled}</p>}

      {l.status !== "open" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{l.asks.length === 1 ? "The seller's terms" : "The seller's alternatives"}</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-2">
              {l.asks.map((ask, i) => (
                <li key={i} className="rounded-lg border p-3">
                  <AskBlock ask={ask} view={view} />
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}

      {holdsReceipt && <SellerPanel view={view} onDone={done} />}
      {!holdsReceipt && tx.account === l.seller && view.receipt?.holder && (
        <p className="text-xs text-muted-foreground">{DETAIL_COPY.receiptElsewhere}</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Before you fill</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
            {WHAT_THIS_IS_NOT.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-muted-foreground">
            Read from <AddressLink address={view.component} /> at
            ledger time {utcStamp(view.ledgerTime)}.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
