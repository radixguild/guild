"use client"

// The /swaps grid. Rendered client-side from GET /api/v1/swaps on purpose:
// NFT names and pictures are written by whoever minted the NFT, and keeping
// them out of the prerendered HTML keeps them out of the deploy-time copy
// gate (launch-check CHECK 4), which polices the Guild's own claims — a
// stranger's NFT name must not be able to fail a deploy. This file's own
// strings are still scanned, as a DETAIL_COMPONENT source.

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Images, Plus, RefreshCw } from "lucide-react"
import { useWallet } from "@/hooks/useWallet"
import { apiFetch } from "@/lib/api-fetch"
import { shortAddress } from "@/lib/nft-swap"
import type { SwapBoardView, SwapFilter, SwapListingView } from "@/lib/nft-swap-service"
import { BOARD_COPY } from "@/content/swaps"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { askSummary, NftImage, relativeTime, SwapStatusBadge } from "./swap-bits"

const FILTERS: { key: SwapFilter; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "expired", label: "Expired" },
  { key: "filled", label: "Filled" },
  { key: "cancelled", label: "Cancelled" },
  { key: "all", label: "All" },
]

type Load = { state: "loading" } | { state: "failed" } | { state: "ok"; board: SwapBoardView }

function SwapCard({ l, board }: { l: SwapListingView; board: SwapBoardView }) {
  const coll = l.hidden ? shortAddress(l.assetResource) : (board.resources[l.assetResource]?.name ?? shortAddress(l.assetResource))
  const name = l.hidden ? BOARD_COPY.hiddenCard : (l.asset.name ?? `${coll} ${l.assetId}`)
  return (
    <Link href={`/swaps/${l.listingId}`} className="group block no-underline">
      <Card className="h-full overflow-hidden transition-colors group-hover:border-primary/50">
        <div className="relative">
          <NftImage src={l.asset.imageUrl} alt={name} className="aspect-square w-full" />
          <div className="absolute left-2 top-2">
            <SwapStatusBadge status={l.status} />
          </div>
        </div>
        <CardContent className="space-y-1.5 p-3">
          <p className="line-clamp-2 text-sm font-medium break-words" title={name}>
            {name}
          </p>
          <p className="line-clamp-1 text-xs text-muted-foreground" title={l.assetResource}>
            {coll} · {l.assetId}
          </p>
          <p className="text-sm font-semibold tabular-nums">{askSummary(l.asks, board.resources)}</p>
          <p className="text-xs text-muted-foreground">
            Listing {l.listingId} ·{" "}
            {l.status === "open"
              ? `expires ${relativeTime(l.expiresAt, board.ledgerTime)}`
              : l.status === "expired"
                ? `expired ${relativeTime(l.expiresAt, board.ledgerTime)}`
                : `listed ${relativeTime(l.createdAt, board.ledgerTime)}`}
          </p>
        </CardContent>
      </Card>
    </Link>
  )
}

/** One board page from the API; null = could not be read. */
async function readBoard(url: string): Promise<SwapBoardView | null> {
  try {
    const res = await apiFetch(url)
    const body = await res.json().catch(() => null)
    return res.ok && body?.ok ? (body.data as SwapBoardView) : null
  } catch {
    return null
  }
}

export function SwapBoard() {
  const { account } = useWallet()
  const [filter, setFilter] = useState<SwapFilter>("open")
  const [mine, setMine] = useState(false)
  const [load, setLoad] = useState<Load>({ state: "loading" })
  const [more, setMore] = useState<{ busy: boolean; failed: boolean }>({ busy: false, failed: false })
  // Which query the board on screen answers. A "Load more" that returns after
  // the filter changed must not splice old-filter listings into the new page.
  const queryKey = `${filter}|${mine && account ? account : ""}`
  const keyRef = useRef(queryKey)
  useEffect(() => {
    keyRef.current = queryKey
  }, [queryKey])

  const query = useCallback(
    (before?: number) => {
      const q = new URLSearchParams({ status: filter })
      if (mine && account) q.set("seller", account)
      if (before) q.set("before", String(before))
      return `/api/v1/swaps?${q}`
    },
    [filter, mine, account],
  )

  const [reloadKey, setReloadKey] = useState(0)
  // State is set only in the promise callbacks (react-hooks/set-state-in-effect);
  // the loading state is set by whatever asked for the reload.
  useEffect(() => {
    let cancelled = false
    readBoard(query()).then((board) => {
      if (!cancelled) setLoad(board ? { state: "ok", board } : { state: "failed" })
    })
    return () => {
      cancelled = true
    }
  }, [query, reloadKey])
  const reload = () => {
    setLoad({ state: "loading" })
    setReloadKey((k) => k + 1)
  }

  const loadMore = async () => {
    if (load.state !== "ok" || load.board.nextCursor === null) return
    const key = queryKey
    const cursor = load.board.nextCursor
    setMore({ busy: true, failed: false })
    const next = await readBoard(query(cursor))
    if (keyRef.current !== key) return setMore({ busy: false, failed: false })
    if (!next) return setMore({ busy: false, failed: true })
    setLoad((prev) =>
      prev.state === "ok" && prev.board.nextCursor === cursor
        ? {
            state: "ok",
            board: {
              ...next,
              listings: [...prev.board.listings, ...next.listings],
              resources: { ...prev.board.resources, ...next.resources },
            },
          }
        : prev,
    )
    setMore({ busy: false, failed: false })
  }

  return (
    <section className="space-y-4" aria-label="Listings">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            size="sm"
            variant={filter === f.key ? "default" : "outline"}
            onClick={() => {
              if (f.key === filter) return
              setLoad({ state: "loading" })
              setFilter(f.key)
            }}
            aria-pressed={filter === f.key}
          >
            {f.label}
          </Button>
        ))}
        {account && (
          <Button size="sm" variant={mine ? "default" : "outline"} onClick={() => {
              setLoad({ state: "loading" })
              setMine((m) => !m)
            }} aria-pressed={mine}>
            {BOARD_COPY.mine}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={reload} aria-label="Refresh listings">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Link href="/swaps/list" className={cn(buttonVariants({ size: "sm" }), "no-underline")}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            {BOARD_COPY.listCta}
          </Link>
        </div>
      </div>

      {load.state === "loading" && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="aspect-[3/4] w-full rounded-xl" />
          ))}
        </div>
      )}

      {load.state === "failed" && (
        <p className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive" role="alert">
          {BOARD_COPY.unreadable}
        </p>
      )}

      {load.state === "ok" && (
        <>
          {load.board.listings.length === 0 && load.board.unreadable.length > 0 ? (
            // Fail closed: listings exist that this site could not read, so
            // "nothing is listed" would be a guess presented as a fact.
            <p className="rounded-lg border border-destructive/40 p-4 text-sm" role="alert">
              {BOARD_COPY.unreadableListings(load.board.unreadable.length)}
            </p>
          ) : load.board.listings.length === 0 ? (
            <EmptyState
              icon={<Images />}
              title={filter === "open" && !mine ? BOARD_COPY.empty.open : BOARD_COPY.empty.other}
              description={BOARD_COPY.emptyHint}
            />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {load.board.listings.map((l) => (
                <SwapCard key={l.listingId} l={l} board={load.board} />
              ))}
            </div>
          )}
          {load.board.nextCursor !== null && (
            <div className="flex flex-col items-center gap-1">
              <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={more.busy}>
                {more.busy ? "Loading…" : "Load more"}
              </Button>
              {more.failed && <p className="text-xs text-destructive">{BOARD_COPY.unreadable}</p>}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {load.board.total} listing{load.board.total === 1 ? "" : "s"} made on the component so far
            {load.board.hidden > 0 && ` · ${load.board.hidden} hidden from this site by the operator`}
            {load.board.unreadable.length > 0 &&
              ` · ${load.board.unreadable.length} on chain in a shape this site does not read (ids ${load.board.unreadable.slice(0, 5).join(", ")})`}
            . Statuses are at the ledger time {new Date(load.board.ledgerTime * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC.
          </p>
          {load.board.truncated && <p className="text-xs text-muted-foreground">{BOARD_COPY.truncated}</p>}
        </>
      )}
    </section>
  )
}
