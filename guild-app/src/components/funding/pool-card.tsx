import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { XrdAmount } from "@/components/XrdAmount"
import {
  deadlineSummary,
  poolProgressPercent,
  statusPresentation,
  toPoolState,
  type FundingPoolJson,
} from "@/lib/funding-display"
import { formatXrdAmount } from "@/lib/format-xrd-usd"
import { Users } from "lucide-react"

/**
 * One pool, in a list. Presentational and server-renderable: like TaskCard it
 * takes the USD rate as props from a parent that read `useXrdUsd()`, rather
 * than reading the hook itself (see XrdAmount's module doc on that contract).
 *
 * The progress bar is a plain div, not <Progress>: base-ui's Progress renders
 * its own label/track structure aimed at a single determinate task, and what
 * a pool needs is a bar annotated with two money figures that must stay
 * exact decimal strings. Reaching for the primitive here would mean fighting
 * it to keep the numbers out of a `value` number.
 */
export function PoolCard({
  pool,
  contributorCount,
  now,
  defaultGraceWindowSecs,
  usdRate,
  usdStale,
  usdAgeSeconds,
  usdSource,
}: {
  pool: FundingPoolJson
  contributorCount?: number
  now: Date
  defaultGraceWindowSecs: number
  usdRate?: number | null
  usdStale?: boolean
  usdAgeSeconds?: number | null
  usdSource?: string | null
}) {
  const state = toPoolState(pool, defaultGraceWindowSecs)
  const percent = poolProgressPercent(pool.pooledXrd, pool.targetXrd)
  const status = statusPresentation(state.status)
  const clock = deadlineSummary(state, now)

  return (
    <Card className="transition-colors hover:border-primary/40">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <Link href={`/fund/${pool.id}`} className="font-medium no-underline hover:underline">
            {pool.title}
          </Link>
          <Badge variant={status.tone}>{status.label}</Badge>
        </div>

        <p className="line-clamp-2 text-sm text-muted-foreground">{pool.description}</p>

        <div>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${percent}% of target pledged`}
          >
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
            <span className="font-medium tabular-nums">
              <XrdAmount
                amountXrd={pool.pooledXrd}
                usdRate={usdRate}
                stale={usdStale}
                ageSeconds={usdAgeSeconds}
                source={usdSource}
              />
              <span className="text-muted-foreground"> pledged of {formatXrdAmount(pool.targetXrd)} XRD</span>
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">{percent}%</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {clock.remaining ? (
            <span className={clock.urgent ? "text-amber-600 dark:text-amber-500" : undefined}>
              {clock.label} {clock.remaining}
            </span>
          ) : (
            <span>{status.meaning}</span>
          )}
          {typeof contributorCount === "number" && (
            <span className="inline-flex items-center gap-1">
              <Users className="h-3 w-3" aria-hidden />
              {contributorCount} {contributorCount === 1 ? "backer" : "backers"}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
