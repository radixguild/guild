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

import { useEffect, useRef, useState } from "react"
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
  type SwapTx,
} from "./swap-bits"

/** A panel reports a committed action up, so the line survives the refresh
 *  that re-renders (or removes) the panel itself. `settled` says what the
 *  re-read must show before the page believes it: a Gateway read can trail
 *  the node the wallet polled, and an unchanged "Open" offered again under a
 *  "Filled" notice would invite a second, reverting transaction. */
type Done = (text: string, txId: string, settled: (v: SwapDetailView) => boolean) => void

/** Re-reads after the viewer's own transaction, 1.5 s apart, before showing
 *  whatever the ledger read says with a "may be behind" note. */
const SETTLE_TRIES = 6
const SETTLE_DELAY_MS = 1500
/** A read that has not answered by then counts as failed, so a hung Gateway
 *  ends in "Try again" rather than a skeleton forever. */
const READ_TIMEOUT_MS = 20_000

/** What every action panel gets from the page. One `tx` for the whole page,
 *  so its re-entry guard covers Fill and the seller actions together;
 *  `behind` = the view on screen may predate the viewer's own transaction,
 *  and acting on it would only send a transaction that reverts. */
type PanelProps = { view: SwapDetailView; tx: SwapTx; behind: boolean; onDone: Done }

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
        {nft?.burned && <p className="text-xs text-destructive">{DETAIL_COPY.burnedAsk}</p>}
      </div>
    </div>
  )
}

function FillPanel({ view, tx, behind, onDone }: PanelProps) {
  const l = view.listing
  const [picked, setPicked] = useState<number | null>(null)
  const [checked, setChecked] = useState(false)
  const own = tx.account === l.seller
  const locked = tx.busy || behind

  const fill = async () => {
    if (picked === null || behind) return
    const ask = l.asks[picked]
    const id = await tx.send((account) => fillSwapManifest(view.component, account, l.listingId, picked, ask))
    if (id) {
      setPicked(null)
      setChecked(false)
      onDone("Filled — the NFT is in your account.", id, (v) => v.listing.state !== "Listed")
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
              {tx.connected && !(ask.kind === "nonFungible" && view.askNfts[`${ask.resource} ${ask.id}`]?.burned) && (
                <Button
                  size="sm"
                  variant={picked === i ? "default" : "outline"}
                  disabled={locked}
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
        {behind && <p className="text-xs text-muted-foreground">{DETAIL_COPY.behind}</p>}

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
            <Button onClick={() => void fill()} disabled={!checked || locked}>
              <Wallet className="mr-2 h-4 w-4" />
              Open my wallet to fill
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SellerPanel({ view, tx, behind, onDone }: PanelProps) {
  const l = view.listing
  const locked = tx.busy || behind

  const act = async (label: string, build: (account: string) => string, settled: (v: SwapDetailView) => boolean) => {
    if (behind) return
    const id = await tx.send(build)
    if (id) onDone(label, id, settled)
  }
  const owed = filledAsk(l)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{DETAIL_COPY.sellerHeading}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">{DETAIL_COPY.sellerIntro}</p>
        {behind && <p className="text-xs text-muted-foreground">{DETAIL_COPY.behind}</p>}

        {l.state === "Listed" && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={locked}
                onClick={() =>
                  void act(
                    "Cancelled — the NFT is back in your account.",
                    (a) => cancelSwapManifest(view.component, a, view.receiptResource, l.listingId),
                    (v) => v.listing.state !== "Listed",
                  )
                }
              >
                Cancel listing
              </Button>
              <Button
                variant="outline"
                disabled={locked}
                onClick={() =>
                  void act(
                    "Extended.",
                    (a) => extendSwapListingManifest(view.component, a, view.receiptResource, l.listingId),
                    (v) => v.listing.expiresAt > l.expiresAt || v.listing.state !== "Listed",
                  )
                }
              >
                Extend by 30 days
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Cancel carries no fee beyond the network fee and returns the NFT to the account holding the receipt. Extending moves the expiry to{" "}
              {utcStamp(extendedExpiry(l, view.ledgerTime))} and carries the extension fee: {feeText(view.fees.extend)}, plus
              the network fee.
            </p>
          </div>
        )}

        {proceedsOwed(l) && owed && (
          <div className="space-y-2">
            <Button
              disabled={locked}
              onClick={() =>
                void act(
                  "Withdrawn — the proceeds went to the account this listing pays.",
                  (a) => withdrawSwapProceedsManifest(view.component, a, view.receiptResource, l.listingId),
                  (v) => v.listing.proceedsWithdrawn,
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
              disabled={locked}
              onClick={() =>
                void act(
                  "Receipt burned.",
                  (a) => burnListingReceiptManifest(view.component, a, view.receiptResource, l.listingId),
                  (v) => v.receipt?.burned === true,
                )
              }
            >
              Burn the listing receipt
            </Button>
            <p className="text-xs text-muted-foreground">{DETAIL_COPY.burnHint}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

async function readDetail(listingId: string): Promise<{ view: SwapDetailView } | { code: string; message: string }> {
  try {
    const res = await apiFetch(`/api/v1/swaps/${encodeURIComponent(listingId)}`, {
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    })
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

/** `justListed`: the viewer arrived from their own `list` transaction, so a
 *  "no such listing" answer — or one whose receipt holder is not readable
 *  yet, which would hide the seller panel — is retried before it is believed. */
export function SwapDetail({ listingId, justListed = false }: { listingId: string; justListed?: boolean }) {
  const tx = useSwapTx()
  const [load, setLoad] = useState<Load>({ state: "loading" })
  const [notice, setNotice] = useState<{ text: string; txId: string } | null>(null)
  const [waiting, setWaiting] = useState(justListed)

  const [reloadKey, setReloadKey] = useState(0)
  const refresh = () => setReloadKey((k) => k + 1)
  // What the next read must show to count as caught up with the viewer's own
  // transaction (null = nothing pending). A ref: written by event handlers,
  // read in the read's callback, never during render.
  const awaiting = useRef<{ settled: (v: SwapDetailView) => boolean; tries: number } | null>(
    justListed ? { settled: (v) => Boolean(v.receipt?.holder), tries: 0 } : null,
  )
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // State is set only in the promise callback (react-hooks/set-state-in-effect).
  // A failed RE-read keeps the last good view on screen, marked stale: a
  // Gateway blip right after a fill must not blank the page that just
  // reported it.
  useEffect(() => {
    let cancelled = false
    readDetail(listingId).then((r) => {
      if (cancelled) return
      const a = awaiting.current
      const caughtUp = "view" in r && (!a || a.settled(r.view))
      if (a && !caughtUp && a.tries < SETTLE_TRIES) {
        a.tries++
        retryTimer.current = setTimeout(() => setReloadKey((k) => k + 1), SETTLE_DELAY_MS)
        return
      }
      awaiting.current = null
      setWaiting(false)
      setLoad((prev) =>
        "view" in r
          ? { state: "ok", view: r.view, stale: !caughtUp }
          : prev.state === "ok"
            ? { ...prev, stale: true }
            : { state: "error", code: r.code, message: r.message },
      )
    })
    return () => {
      cancelled = true
      if (retryTimer.current) clearTimeout(retryTimer.current)
    }
  }, [listingId, reloadKey])

  const done: Done = (text, txId, settled) => {
    setNotice({ text, txId })
    awaiting.current = { settled, tries: 0 }
    setWaiting(true)
    refresh()
  }

  if (load.state === "loading") {
    return (
      <div className="space-y-3">
        {waiting && <p className="text-xs text-muted-foreground" role="status">{DETAIL_COPY.waiting}</p>}
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
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
  const coll = l.hidden ? null : (view.resources[l.assetResource]?.name ?? null)
  const name = l.hidden ? `NFT ${l.assetId}` : (l.asset.name ?? (coll ? `${coll} ${l.assetId}` : `NFT ${l.assetId}`))
  const holdsReceipt = Boolean(tx.account && view.receipt?.holder === tx.account)
  const filled = filledAsk(l)
  const behind = waiting || Boolean(load.stale)

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
            <Row label="Proceeds to">
              <AddressLink address={l.seller} />
              <p className="text-xs text-muted-foreground">{DETAIL_COPY.payeeCaption}</p>
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
                  · proceeds {l.proceedsWithdrawn ? "withdrawn to the account this listing pays" : "waiting to be withdrawn"}
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

      {waiting && <p className="text-xs text-muted-foreground" role="status">{DETAIL_COPY.waiting}</p>}
      {load.stale && !waiting && (
        <p className="text-xs text-muted-foreground" role="status">
          This may not show your latest transaction yet — the transaction link is the record.{" "}
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
      {tx.busy && <p className="text-xs text-muted-foreground" role="status">Check your wallet…</p>}
      <TxErrorLine error={tx.error} />
      {tx.error && <TxDoneLine txId={tx.txId}>The transaction:</TxDoneLine>}

      {l.hidden && <p className="rounded-lg border p-4 text-sm">{DETAIL_COPY.hidden}</p>}
      {/* Keyed on the account: a pick and a ticked check belong to the
          account that made them. */}
      {l.status === "open" && !l.hidden && (
        <FillPanel key={tx.account ?? ""} view={view} tx={tx} behind={behind} onDone={done} />
      )}
      {l.status === "expired" && <p className="rounded-lg border p-4 text-sm">{DETAIL_COPY.expired}</p>}
      {l.status === "filled" && <p className="rounded-lg border p-4 text-sm">{DETAIL_COPY.filled}</p>}
      {l.status === "cancelled" && <p className="rounded-lg border p-4 text-sm">{DETAIL_COPY.cancelled}</p>}

      {(l.status !== "open" || l.hidden) && (
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

      {holdsReceipt && <SellerPanel view={view} tx={tx} behind={behind} onDone={done} />}
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
