"use client"

// /swaps/list — pick an NFT from the connected account, set the terms, sign
// `list`. Reads the account and the component straight from the Gateway in
// the browser (the account's holdings are the viewer's own business, and the
// component is public); nothing is written anywhere but the ledger.

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Plus, Trash2, Wallet } from "lucide-react"
import { NFT_SWAP_COMPONENT } from "@/lib/config"
import { XRD_ADDRESS } from "@/lib/radix"
import { listSwapManifest } from "@/lib/manifests"
import {
  askProblems,
  expiryForDays,
  isResourceAddress,
  MAX_ASKS,
  shortAddress,
  type AskResourceKind,
  type SwapAsk,
} from "@/lib/nft-swap"
import {
  readAccountNonFungibles,
  readListedListingId,
  readNftDisplay,
  readResourceDisplay,
  readSwapComponentState,
  type AccountNftGroup,
  type NftDisplay,
  type ResourceDisplay,
} from "@/lib/nft-swap-gateway"
import type { SwapResourceView } from "@/lib/nft-swap-service"
import { ASK_PROBLEM_TEXT, LIST_COPY } from "@/content/swaps"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { askText, NftImage, TxDoneLine, TxErrorLine, useSwapTx, utcStamp } from "./swap-bits"

const DAY_CHOICES = [1, 3, 7, 14, 30] as const
/** NFT pictures fetched for the picker, at most — the rest show their id. */
const PICKER_DISPLAY_CAP = 60

type Holdings =
  | { state: "idle" | "loading" | "failed" }
  | { state: "ok"; groups: AccountNftGroup[]; moreResources: boolean; nfts: Map<string, NftDisplay>; res: Map<string, ResourceDisplay> }

/** The account's NFTs with display data — no React state touched here. */
async function readHoldings(acct: string): Promise<Holdings> {
  const read = await readAccountNonFungibles(acct)
  if (!read) return { state: "failed" }
  const res = (await readResourceDisplay(read.groups.map((g) => g.resource))) ?? new Map<string, ResourceDisplay>()
  const nfts = new Map<string, NftDisplay>()
  let budget = PICKER_DISPLAY_CAP
  for (const g of read.groups) {
    if (budget <= 0) break
    const ids = g.ids.slice(0, budget)
    budget -= ids.length
    const d = await readNftDisplay(g.resource, ids)
    if (d) for (const [id, v] of d) nfts.set(key(g.resource, id), v)
  }
  return { state: "ok", groups: read.groups, moreResources: read.moreResources, nfts, res }
}

const key = (resource: string, id: string) => `${resource} ${id}`

export function ListNftForm() {
  const router = useRouter()
  const tx = useSwapTx()
  const account = tx.account

  // Both are tagged with the account they belong to, so switching accounts
  // in the wallet can never list an NFT picked from the previous one.
  const [loaded, setLoaded] = useState<{ account: string; h: Holdings } | null>(null)
  const [holdingsKey, setHoldingsKey] = useState(0)
  const [pickedRaw, setPicked] = useState<{ account: string; resource: string; id: string } | null>(null)
  const holdings: Holdings = !account ? { state: "idle" } : loaded?.account === account ? loaded.h : { state: "loading" }
  const picked = pickedRaw && pickedRaw.account === account ? { resource: pickedRaw.resource, id: pickedRaw.id } : null
  const [asks, setAsks] = useState<SwapAsk[]>([{ kind: "fungible", resource: XRD_ADDRESS, amount: "" }])
  const [askRes, setAskRes] = useState<Map<string, ResourceDisplay | null>>(new Map())
  const [days, setDays] = useState<number>(7)
  const [ledgerNow, setLedgerNow] = useState<number | null>(null)
  const [componentOk, setComponentOk] = useState<boolean | null>(null)
  const [after, setAfter] = useState<string | null>(null)

  // The component (validates the address and gives the ledger clock).
  useEffect(() => {
    let live = true
    void readSwapComponentState(NFT_SWAP_COMPONENT).then((s) => {
      if (!live) return
      setComponentOk(Boolean(s))
      if (s) setLedgerNow(s.ledgerNow)
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!account) return
    let cancelled = false
    readHoldings(account).then((h) => {
      if (!cancelled) setLoaded({ account, h })
    })
    return () => {
      cancelled = true
    }
  }, [account, holdingsKey])

  // Live kind/divisibility for every resource an ask names.
  const askResources = useMemo(() => [...new Set(asks.map((a) => a.resource).filter(isResourceAddress))], [asks])
  useEffect(() => {
    const missing = askResources.filter((r) => !askRes.has(r))
    if (missing.length === 0) return
    let live = true
    void readResourceDisplay(missing).then((m) => {
      if (!live || !m) return
      setAskRes((prev) => {
        const next = new Map(prev)
        for (const r of missing) next.set(r, m.get(r) ?? null)
        return next
      })
    })
    return () => {
      live = false
    }
  }, [askResources, askRes])

  const kindOf = useCallback(
    (r: string): AskResourceKind | null => {
      const d = askRes.get(r)
      if (!d) return null
      if (d.kind === "nonFungible") return { kind: "nonFungible" }
      return d.divisibility === null ? null : { kind: "fungible", divisibility: d.divisibility }
    },
    [askRes],
  )
  const problems = askProblems(asks, kindOf, picked ?? undefined)
  // An unknown resource is only a problem once the Gateway has answered.
  const shownProblem = (i: number) =>
    problems[i] === "bad_resource" && isResourceAddress(asks[i].resource) && !askRes.has(asks[i].resource)
      ? null
      : problems[i]
  const empty = (a: SwapAsk) => (a.kind === "fungible" ? a.amount.trim() === "" : a.id.trim() === "")
  const asksOk = asks.length > 0 && problems.every((p) => p === null) && !asks.some(empty)

  const pickedRes = picked && holdings.state === "ok" ? holdings.res.get(picked.resource) : undefined
  const pickedNft = picked && holdings.state === "ok" ? holdings.nfts.get(key(picked.resource, picked.id)) : undefined
  const canList = Boolean(picked && asksOk && ledgerNow !== null && pickedRes?.withdraw !== "denied" && componentOk)

  const resourcesForText = useMemo(() => {
    const out: Record<string, SwapResourceView> = {}
    for (const [r, d] of askRes) if (d) out[r] = d
    return out
  }, [askRes])

  const submit = async () => {
    if (!picked || !canList) return
    setAfter(null)
    tx.reset()
    // Re-read the ledger clock right before signing: the 30-day ceiling is
    // measured from the clock when the transaction executes.
    const fresh = await readSwapComponentState(NFT_SWAP_COMPONENT)
    if (!fresh) {
      setAfter("The swap component could not be read just now, so nothing was sent. Try again shortly.")
      return
    }
    const expiresAt = expiryForDays(fresh.ledgerNow, days)
    const txId = await tx.send((acct) =>
      listSwapManifest(NFT_SWAP_COMPONENT, acct, picked.resource, picked.id, asks.map(normalizeAsk), expiresAt),
    )
    if (!txId) return
    const listingId = await readListedListingId(txId, NFT_SWAP_COMPONENT)
    if (listingId) {
      router.push(`/swaps/${listingId}?listed=1`)
      return
    }
    // Listed, but the id is not readable yet. Disarm the form — the NFT has
    // left this account, and a second press would only send a failing list —
    // and re-read the account so the picker shows what is really there.
    setPicked(null)
    setLoaded(null)
    setHoldingsKey((k) => k + 1)
    setAfter("Listed. The listing id could not be read back yet — it will appear on the board shortly.")
  }

  const setAsk = (i: number, next: SwapAsk) => setAsks((xs) => xs.map((a, j) => (j === i ? next : a)))

  return (
    <div className="space-y-6">
      {componentOk === false && (
        <p className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive" role="alert">
          The swap component could not be read from the Radix Gateway, so listing is unavailable right now.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{LIST_COPY.pickHeading}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!account && <p className="text-sm text-muted-foreground">{LIST_COPY.connect}</p>}
          {holdings.state === "loading" && (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="aspect-square w-full rounded-lg" />
              ))}
            </div>
          )}
          {holdings.state === "failed" && (
            <p className="text-sm text-destructive" role="alert">
              The NFTs in this account could not be read from the Radix Gateway.{" "}
              <button type="button" className="underline" onClick={() => {
                  setLoaded(null)
                  setHoldingsKey((k) => k + 1)
                }}>
                Try again
              </button>
            </p>
          )}
          {holdings.state === "ok" && holdings.groups.length === 0 && (
            <p className="text-sm text-muted-foreground">This account holds no NFTs.</p>
          )}
          {holdings.state === "ok" &&
            holdings.groups.map((g) => {
              const r = holdings.res.get(g.resource)
              const denied = r?.withdraw === "denied"
              return (
                <div key={g.resource} className="space-y-1.5">
                  <p className="text-xs text-muted-foreground" title={g.resource}>
                    {r?.name ?? "Unnamed collection"} · <span className="font-mono">{shortAddress(g.resource)}</span>
                  </p>
                  {denied && <p className="text-[11px] text-muted-foreground">{LIST_COPY.notWithdrawable}</p>}
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                    {g.ids.map((id) => {
                      const d = holdings.nfts.get(key(g.resource, id))
                      const on = picked?.resource === g.resource && picked.id === id
                      return (
                        <button
                          key={id}
                          type="button"
                          disabled={denied}
                          onClick={() => account && setPicked({ account, resource: g.resource, id })}
                          aria-pressed={on}
                          className={`overflow-hidden rounded-lg border text-left disabled:opacity-40 ${on ? "border-primary ring-2 ring-primary/40" : ""}`}
                        >
                          <NftImage src={d?.imageUrl ?? null} alt={d?.name ?? id} className="aspect-square w-full" />
                          <span className="block truncate px-1.5 py-1 text-[11px]">{d?.name ?? id}</span>
                        </button>
                      )
                    })}
                  </div>
                  {g.more && <p className="text-[11px] text-muted-foreground">More of this collection are in the account than are shown.</p>}
                </div>
              )
            })}
          {holdings.state === "ok" && holdings.moreResources && (
            <p className="text-[11px] text-muted-foreground">The account holds more collections than are shown.</p>
          )}
          {pickedRes?.withdraw === "restricted" && <p className="text-xs text-muted-foreground">{LIST_COPY.restricted}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{LIST_COPY.asksHeading}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{LIST_COPY.asksIntro}</p>
          {asks.map((a, i) => {
            const p = shownProblem(i)
            const d = askRes.get(a.resource)
            return (
              <div key={i} className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label={`Alternative ${i + 1} kind`}
                    className="h-8 rounded-md border bg-background px-2 text-sm"
                    value={a.kind}
                    onChange={(e) =>
                      setAsk(
                        i,
                        e.target.value === "fungible"
                          ? { kind: "fungible", resource: XRD_ADDRESS, amount: "" }
                          : { kind: "nonFungible", resource: "", id: "" },
                      )
                    }
                  >
                    <option value="fungible">An amount of a token</option>
                    <option value="nonFungible">A specific NFT</option>
                  </select>
                  {asks.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove alternative ${i + 1}`}
                      onClick={() => setAsks((xs) => xs.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                {a.kind === "fungible" ? (
                  <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
                    <Input
                      inputMode="decimal"
                      placeholder="Amount"
                      aria-label={`Alternative ${i + 1} amount`}
                      value={a.amount}
                      onChange={(e) => setAsk(i, { ...a, amount: e.target.value.trim() })}
                    />
                    <Input
                      placeholder="Token resource address"
                      aria-label={`Alternative ${i + 1} token`}
                      className="font-mono text-xs"
                      value={a.resource}
                      onChange={(e) => setAsk(i, { ...a, resource: e.target.value.trim() })}
                    />
                  </div>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-[1fr_10rem]">
                    <Input
                      placeholder="NFT collection resource address"
                      aria-label={`Alternative ${i + 1} collection`}
                      className="font-mono text-xs"
                      value={a.resource}
                      onChange={(e) => setAsk(i, { ...a, resource: e.target.value.trim() })}
                    />
                    <Input
                      placeholder="NFT id, e.g. #1#"
                      aria-label={`Alternative ${i + 1} NFT id`}
                      className="font-mono text-xs"
                      value={a.id}
                      onChange={(e) => setAsk(i, { ...a, id: e.target.value.trim() })}
                    />
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  {d ? `${d.name ?? "Unnamed"}${d.symbol ? ` (${d.symbol})` : ""}` : isResourceAddress(a.resource) ? "Looking up…" : ""}
                </p>
                {p && !empty(a) && <p className="text-xs text-destructive">{ASK_PROBLEM_TEXT[p]}</p>}
              </div>
            )
          })}
          {asks.length < MAX_ASKS && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAsks((xs) => [...xs, { kind: "fungible", resource: XRD_ADDRESS, amount: "" }])}
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> Add an alternative
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{LIST_COPY.expiryHeading}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{LIST_COPY.expiryIntro}</p>
          <div className="flex flex-wrap gap-2">
            {DAY_CHOICES.map((d) => (
              <Button key={d} size="sm" variant={days === d ? "default" : "outline"} onClick={() => setDays(d)} aria-pressed={days === d}>
                {d} day{d === 1 ? "" : "s"}
              </Button>
            ))}
          </div>
          {ledgerNow !== null && (
            <p className="text-xs text-muted-foreground">Expires about {utcStamp(expiryForDays(ledgerNow, days))}.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{LIST_COPY.reviewHeading}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {picked && asksOk ? (
            <p>
              List <strong>{pickedNft?.name ?? picked.id}</strong> ({picked.id} of{" "}
              <span className="font-mono text-xs break-all">{picked.resource}</span>) for{" "}
              {asks.map((a, i) => (
                <span key={i}>
                  {i > 0 && " or "}
                  <strong>{askText(normalizeAsk(a), resourcesForText)}</strong>
                </span>
              ))}
              , for {days} day{days === 1 ? "" : "s"}. Proceeds will be paid to{" "}
              <span className="font-mono text-xs break-all">{account}</span>.
            </p>
          ) : (
            <p className="text-muted-foreground">Choose an NFT and complete the terms above.</p>
          )}
          <p className="text-xs text-muted-foreground">{LIST_COPY.receiptNote}</p>
          <p className="text-xs text-muted-foreground">{LIST_COPY.noRoyalty}</p>
          <Button onClick={() => void submit()} disabled={!canList || tx.busy}>
            <Wallet className="mr-2 h-4 w-4" />
            {tx.busy ? "Check your wallet…" : "Open my wallet to list"}
          </Button>
          <TxErrorLine error={tx.error} />
          {after && (
            <TxDoneLine txId={tx.txId}>{after}</TxDoneLine>
          )}
          {after && !tx.txId && <p className="text-xs text-destructive">{after}</p>}
        </CardContent>
      </Card>
    </div>
  )
}

/** Trim and drop trailing-zero noise the way the chain will store it. */
function normalizeAsk(a: SwapAsk): SwapAsk {
  if (a.kind === "fungible") {
    const amt = a.amount.trim()
    return { ...a, amount: amt.includes(".") ? amt.replace(/0+$/, "").replace(/\.$/, "") : amt }
  }
  return { ...a, id: a.id.trim() }
}
