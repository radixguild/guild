"use client"

// The /swaps grid. Rendered client-side from GET /api/v1/swaps on purpose:
// NFT names and pictures are written by whoever minted the NFT, and keeping
// them out of the prerendered HTML keeps them out of the deploy-time copy
// gate (launch-check CHECK 4), which polices the Guild's own claims — a
// stranger's NFT name must not be able to fail a deploy. This file's own
// strings are still scanned, as a DETAIL_COMPONENT source.

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Images, Plus, RefreshCw } from "lucide-react"
import { useWallet } from "@/hooks/useWallet"
import { apiFetch } from "@/lib/api-fetch"
import { isResourceAddress, shortAddress, SWAP_SCAN_CAP } from "@/lib/nft-swap"
import { isSwapSort, SWAP_SORTS, type SwapSort } from "@/lib/nft-swap-sort"
import type { SwapBoardView, SwapFilter, SwapListingView } from "@/lib/nft-swap-service"
import { BOARD_COPY } from "@/content/swaps"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { Select } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { askSummary, nftParts, NftImage, relativeTime, SwapStatusBadge } from "./swap-bits"

const FILTERS: { key: SwapFilter; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "expired", label: "Expired" },
  { key: "filled", label: "Filled" },
  { key: "cancelled", label: "Cancelled" },
  { key: "all", label: "All" },
]

type Load = { state: "loading" } | { state: "failed" } | { state: "ok"; board: SwapBoardView }

/** The collection filter's options, kept from the last board that answered so
 *  the select does not empty while the next one loads. */
type Facets = { options: { resource: string; name: string | null; count: number }[]; notListed: number }

function facetsOf(board: SwapBoardView): Facets {
  return {
    // An older answer may lack the field; a missing list is no options, not a crash.
    options: (board.collections ?? []).map((c) => ({ ...c, name: board.resources[c.resource]?.name ?? null })),
    notListed: board.moreCollections ?? 0,
  }
}

/** A read that has not answered by then counts as failed ("Try again"),
 *  not a skeleton forever. */
const READ_TIMEOUT_MS = 20_000

function SwapCard({ l, board }: { l: SwapListingView; board: SwapBoardView }) {
  // Name first, then "Collection #id"; a listing's own number is the last line.
  const p = nftParts(l, board.resources)
  const line = `${p.collection} ${p.id}`
  const name = l.hidden ? BOARD_COPY.hiddenCard : (p.name ?? line)
  return (
    <Link href={`/swaps/${l.listingId}`} className="group block no-underline">
      <Card className="h-full overflow-hidden transition-colors group-hover:border-primary/50">
        <div className="relative">
          <NftImage
            src={l.asset.imageUrl}
            fallbackSrc={l.hidden ? null : (board.resources[l.assetResource]?.iconUrl ?? null)}
            alt={name}
            className="aspect-square w-full"
          />
          <div className="absolute left-2 top-2">
            <SwapStatusBadge status={l.status} />
          </div>
        </div>
        <CardContent className="space-y-1.5 p-3">
          <p className="line-clamp-2 text-sm font-medium break-words" title={name}>
            {name}
          </p>
          {name !== line && (
            <p className="line-clamp-2 text-xs text-muted-foreground break-words" title={`${l.assetResource} ${l.assetId}`}>
              {line}
            </p>
          )}
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
    const res = await apiFetch(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
    const body = await res.json().catch(() => null)
    return res.ok && body?.ok ? (body.data as SwapBoardView) : null
  } catch {
    return null
  }
}

export function SwapBoard() {
  const { account } = useWallet()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  // Sort and collection live in the URL (?sort=, ?collection=), so a view can
  // be shared and survives a reload; anything else there is ignored.
  const sortParam = params.get("sort")
  const sort: SwapSort = isSwapSort(sortParam) ? sortParam : "newest"
  const collectionParam = params.get("collection")
  const collection = isResourceAddress(collectionParam) ? collectionParam : ""
  const [facets, setFacets] = useState<Facets>({ options: [], notListed: 0 })
  const [filter, setFilter] = useState<SwapFilter>("open")
  const [mine, setMine] = useState(false)
  const [load, setLoad] = useState<Load>({ state: "loading" })
  const [more, setMore] = useState<{ busy: boolean; failed: boolean }>({ busy: false, failed: false })
  // "Pays my account" belongs to the account it was pressed for. On a switch
  // or a disconnect it turns off, and the board shows loading rather than the
  // previous account's listings until the unfiltered read answers. Adjusted
  // during render (React's pattern for state derived from a prop change).
  const [mineAccount, setMineAccount] = useState(account)
  if (mineAccount !== account) {
    setMineAccount(account)
    if (mine) {
      setMine(false)
      setLoad({ state: "loading" })
    }
  }
  // Which query the board on screen answers. A "Load more" that returns after
  // the filter changed must not splice old-filter listings into the new page.
  const queryKey = `${filter}|${mine && account ? account : ""}|${sort}|${collection}`
  const keyRef = useRef(queryKey)
  useEffect(() => {
    keyRef.current = queryKey
  }, [queryKey])

  const query = useCallback(
    (cursor?: number) => {
      const q = new URLSearchParams({ status: filter })
      if (sort !== "newest") q.set("sort", sort)
      if (collection) q.set("collection", collection)
      if (mine && account) q.set("seller", account)
      // `before` pages the newest order, `offset` every other (nextCursor says which value).
      if (cursor) q.set(sort === "newest" ? "before" : "offset", String(cursor))
      return `/api/v1/swaps?${q}`
    },
    [filter, mine, account, sort, collection],
  )

  const setView = (next: { sort?: SwapSort; collection?: string }) => {
    const nextSort = next.sort ?? sort
    const nextCollection = next.collection ?? collection
    if (nextSort === sort && nextCollection === collection) return
    const q = new URLSearchParams(params.toString())
    if (nextSort === "newest") q.delete("sort")
    else q.set("sort", nextSort)
    if (nextCollection) q.set("collection", nextCollection)
    else q.delete("collection")
    setLoad({ state: "loading" })
    const qs = q.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  const [reloadKey, setReloadKey] = useState(0)
  // State is set only in the promise callbacks (react-hooks/set-state-in-effect);
  // the loading state is set by whatever asked for the reload.
  useEffect(() => {
    let cancelled = false
    readBoard(query()).then((board) => {
      if (cancelled) return
      setLoad(board ? { state: "ok", board } : { state: "failed" })
      if (board) setFacets(facetsOf(board))
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
    setLoad((prev) => {
      if (prev.state !== "ok" || prev.board.nextCursor !== cursor) return prev
      // The server re-sorts from a fresh read every 15 s, so a page fetched by
      // offset can repeat a listing already on screen. Show each once (the
      // card key is the listing id).
      const onScreen = new Set(prev.board.listings.map((l) => l.listingId))
      return {
        state: "ok",
        board: {
          ...next,
          listings: [...prev.board.listings, ...next.listings.filter((l) => !onScreen.has(l.listingId))],
          resources: { ...prev.board.resources, ...next.resources },
        },
      }
    })
    setMore({ busy: false, failed: false })
  }

  // A filtered answer from a truncated read covers only the newest listings;
  // an empty one must not read as "none exist".
  const empty = load.state === "ok" && load.board.listings.length === 0
  const partial =
    load.state === "ok" && load.board.truncated && (mine || filter !== "all" || collection !== "" || sort !== "newest")

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

      <div className="flex flex-wrap items-start gap-4">
        <div className="max-w-xs space-y-1">
          <label className="block text-xs text-muted-foreground" htmlFor="swap-sort">
            {BOARD_COPY.sort.label}
          </label>
          <Select
            id="swap-sort"
            className="h-9 w-auto min-w-44"
            value={sort}
            onChange={(e) => setView({ sort: e.target.value as SwapSort })}
          >
            {SWAP_SORTS.map((s) => (
              <option key={s} value={s}>
                {BOARD_COPY.sort.options[s]}
              </option>
            ))}
          </Select>
          {sort === "ending" && <p className="text-xs text-muted-foreground">{BOARD_COPY.sort.notes.ending}</p>}
          {(sort === "price-asc" || sort === "price-desc") && (
            <p className="text-xs text-muted-foreground">{BOARD_COPY.sort.notes.price}</p>
          )}
        </div>
        {(facets.options.length > 1 || collection !== "") && (
          <div className="max-w-xs space-y-1">
            <label className="block text-xs text-muted-foreground" htmlFor="swap-collection">
              {BOARD_COPY.collection.label}
            </label>
            <Select
              id="swap-collection"
              className="h-9 w-auto min-w-44 max-w-full"
              value={collection}
              onChange={(e) => setView({ collection: e.target.value })}
            >
              <option value="">{BOARD_COPY.collection.all}</option>
              {/* The chosen collection stays choosable when this status or account has none of it. */}
              {(collection && !facets.options.some((o) => o.resource === collection)
                ? [...facets.options, { resource: collection, name: null, count: 0 }]
                : facets.options
              ).map((o) => (
                <option key={o.resource} value={o.resource}>
                  {`${o.name ?? shortAddress(o.resource)} (${o.count})`}
                </option>
              ))}
            </Select>
            {facets.notListed > 0 && (
              <p className="text-xs text-muted-foreground">{BOARD_COPY.collection.notListed(facets.notListed)}</p>
            )}
          </div>
        )}
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
          {empty && load.board.unreadable.length > 0 ? (
            // Fail closed: listings exist that this site could not read, so
            // "nothing is listed" would be a guess presented as a fact.
            <p className="rounded-lg border border-destructive/40 p-4 text-sm" role="alert">
              {BOARD_COPY.unreadableListings(load.board.unreadable.length)}
            </p>
          ) : empty && partial ? (
            <p className="rounded-lg border p-4 text-sm" role="status">
              {BOARD_COPY.truncatedFiltered(SWAP_SCAN_CAP)}
            </p>
          ) : empty ? (
            <EmptyState
              icon={<Images />}
              title={filter === "open" && !mine && !collection ? BOARD_COPY.empty.open : BOARD_COPY.empty.other}
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
          {load.board.truncated && !(empty && partial) && (
            <p className="text-xs text-muted-foreground">
              {partial ? BOARD_COPY.truncatedFiltered(SWAP_SCAN_CAP) : BOARD_COPY.truncated}
            </p>
          )}
        </>
      )}
    </section>
  )
}
