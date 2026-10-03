"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { apiFetch } from "@/lib/api-fetch"
import { WIDGET_COPY, type TempCheckOption, type CheckId } from "@/content/lights-on"

interface TallyResponse {
  checkId: string
  total: number
  signed: number
  options: { key: string; count: number }[]
  yourVote: string | null
}

/**
 * The interactive widget under each /lights-on question. Renders the option
 * buttons and, once a fetch resolves, the live tally — GET/POST
 * /api/v1/tempcheck/[checkId]. Deliberately no external state library: this
 * is one small piece of per-question state, and useState covers it.
 *
 * The widget copy below is fixed and quoted, not paraphrased — see
 * src/content/lights-on.ts's WIDGET_COPY doc comment for why it must not
 * drift from that string.
 */
export function TempCheck({ checkId, options }: { checkId: CheckId; options: TempCheckOption[] }) {
  const [tally, setTally] = useState<TallyResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [votingKey, setVotingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Synchronous re-entry guard against a double-click firing two POSTs before
  // the first response lands — same pattern as escrow-actions' inFlight ref.
  const inFlight = useRef(false)

  // Inline promise chain rather than an async helper called from the effect
  // body: an `await`-based helper still runs its first setState call
  // synchronously inside the effect (react-hooks/set-state-in-effect), while
  // a `.then()` chain defers it to a microtask the linter treats as an
  // external-system callback — the same shape src/app/tasks/page.tsx uses for
  // its own fetch-on-mount.
  useEffect(() => {
    let cancelled = false
    apiFetch(`/api/v1/tempcheck/${checkId}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null)
        if (!res.ok || !json?.ok) {
          throw new Error(json?.error?.message ?? `Request failed (${res.status})`)
        }
        return json.data as TallyResponse
      })
      .then((data) => {
        if (cancelled) return
        setTally(data)
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : "Could not load this temperature check")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [checkId])

  const vote = useCallback(
    async (optionKey: string) => {
      if (inFlight.current) return
      inFlight.current = true
      setVotingKey(optionKey)
      setError(null)
      try {
        const res = await apiFetch(`/api/v1/tempcheck/${checkId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ option: optionKey }),
        })
        const json = await res.json().catch(() => null)
        if (!res.ok || !json?.ok) {
          throw new Error(json?.error?.message ?? `Vote failed (${res.status})`)
        }
        setTally(json.data)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not record your vote")
      } finally {
        setVotingKey(null)
        inFlight.current = false
      }
    },
    [checkId],
  )

  const countFor = (key: string) => tally?.options.find((o) => o.key === key)?.count ?? 0

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-3">
      <div className="flex flex-col gap-2">
        {options.map((opt) => {
          const isYours = tally?.yourVote === opt.key
          const isSubmitting = votingKey === opt.key
          return (
            <Button
              key={opt.key}
              type="button"
              variant={isYours ? "default" : "outline"}
              size="sm"
              className="h-auto w-full justify-between whitespace-normal py-2 text-left"
              disabled={votingKey !== null}
              onClick={() => vote(opt.key)}
            >
              <span className="flex items-center gap-2">
                {isSubmitting && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />}
                <span>{opt.label}</span>
              </span>
              {tally && (
                <span className="ml-3 shrink-0 text-xs tabular-nums opacity-70">{countFor(opt.key)}</span>
              )}
            </Button>
          )
        })}
      </div>

      {error && (
        <Alert variant="destructive" className="py-2">
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}

      <div className="text-xs text-muted-foreground">
        {loading ? (
          "Loading tally…"
        ) : tally ? (
          <>
            {tally.total} vote{tally.total === 1 ? "" : "s"} so far ({tally.signed} signed in).{" "}
            {tally.yourVote ? "Your vote is recorded above — click another option to change it." : "Pick an option to vote."}
          </>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground/80 border-t border-border pt-2">{WIDGET_COPY}</p>
    </div>
  )
}
