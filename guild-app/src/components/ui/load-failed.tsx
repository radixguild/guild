"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { AlertCircle } from "lucide-react"

/**
 * Failure state for data surfaces — distinct from the empty state on purpose.
 * A degraded backend must never render as "nothing here": an outage shown as
 * "no governance activity" / "no groups yet" tells a visitor the guild is
 * dead, and a badge-holder to re-mint (frontend audit 2026-07-17, Theme C).
 * Use the dashed empty-state Card for a genuinely empty list; use this when
 * the fetch itself failed.
 */
export function LoadFailed({
  what,
  onRetry,
  className = "",
}: {
  /** Short noun for what didn't load, e.g. "governance activity". */
  what: string
  onRetry?: () => void
  className?: string
}) {
  return (
    <Card className={`border-dashed border-amber-500/40 ${className}`}>
      <CardContent className="py-6 text-center space-y-2">
        {/* role="alert" added 2026-08-21. This is the app's shared outage
            surface — it appears when a fetch has already failed and the user is
            looking at a page that may be silently incomplete. Every other
            inline error in this codebase announces itself; this one, the one
            that says "what you are seeing may not be the whole truth", did not. */}
        <p role="alert" className="text-sm text-muted-foreground">
          <AlertCircle className="mr-1 inline h-4 w-4 text-amber-500" aria-hidden />
          Couldn&apos;t load {what} — the data service didn&apos;t respond.
          What&apos;s shown may be incomplete, not empty.
        </p>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
