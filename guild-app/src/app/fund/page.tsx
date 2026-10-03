"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Plus, HandCoins, AlertCircle } from "lucide-react"
import { AppShell } from "@/components/app-shell"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/ui/empty-state"
import { PoolCard } from "@/components/funding/pool-card"
import { FundingDisclosure } from "@/components/funding/funding-disclosure"
import { apiFetch } from "@/lib/api-fetch"
import { isEnabled } from "@/lib/features"
import { useXrdUsd } from "@/lib/use-xrd-usd"
import { FUNDING_GRACE_WINDOW_SECS } from "@/lib/funding-config"
import type { FundingPoolJson } from "@/lib/funding-display"
import type { FundingPoolStatus } from "@/lib/funding-state-machine"

// Same gate shape as /admin and /deploy-escrow: the flag is OFF by default and
// every /api/v1/funding-pools/* route hard-503s behind it (features.ts's
// HIGH-003 pattern), so a reachable page here would be a surface that can only
// ever render an error. notFound() removes it instead.
const FILTERS: { value: FundingPoolStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pledging", label: "Open" },
  { value: "funded", label: "Target met" },
  { value: "finalized", label: "Finalised" },
  { value: "expired", label: "Expired" },
]

export default function FundPage() {
  if (!isEnabled("crowdfund")) notFound()
  return <FundContent />
}

function FundContent() {
  const usd = useXrdUsd()
  const [pools, setPools] = useState<FundingPoolJson[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FundingPoolStatus | "all">("all")
  // Pinned once per mount rather than read per render: every card derives its
  // countdown and its status from this instant, so a re-render mid-scroll
  // cannot make two cards disagree about what "now" is.
  const now = useMemo(() => new Date(), [])

  useEffect(() => {
    let cancelled = false
    apiFetch("/api/v1/funding-pools")
      .then(async (res) => {
        const body = await res.json()
        if (!res.ok || !body.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
        return body.data as FundingPoolJson[]
      })
      .then((data) => {
        if (!cancelled) setPools(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? "Failed to load funding pools")
      })
    return () => {
      cancelled = true
    }
  }, [])

  const visible = useMemo(
    () => (pools ?? []).filter((p) => filter === "all" || p.status === filter),
    [pools, filter],
  )

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Community funding</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Work the community wants done, funded together. Anyone can open a pool; anyone can
              chip in towards its target.
            </p>
          </div>
          <Link href="/fund/create">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Open a pool
            </Button>
          </Link>
        </div>

        <FundingDisclosure />

        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={filter === f.value ? "default" : "outline"}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <span>{error}</span>
          </div>
        )}

        {pools === null && !error && (
          <div className="space-y-3">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}

        {pools !== null && visible.length === 0 && (
          <EmptyState
            icon={<HandCoins />}
            title={filter === "all" ? "No pools yet" : "Nothing here"}
            description={
              filter === "all"
                ? "Be the first to put up something worth building and let people back it."
                : "No pool is in this state right now."
            }
            action={
              filter === "all" ? (
                <Link href="/fund/create">
                  <Button>Open a pool</Button>
                </Link>
              ) : (
                <Button variant="outline" onClick={() => setFilter("all")}>
                  Show all
                </Button>
              )
            }
          />
        )}

        <div className="space-y-3">
          {visible.map((pool) => (
            <PoolCard
              key={pool.id}
              pool={pool}
              now={now}
              defaultGraceWindowSecs={FUNDING_GRACE_WINDOW_SECS}
              usdRate={usd.rate}
              usdStale={usd.stale}
              usdAgeSeconds={usd.ageSeconds}
              usdSource={usd.source}
            />
          ))}
        </div>
      </div>
    </AppShell>
  )
}
