"use client"

import { use, useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, AlertCircle, CheckCircle2, HandCoins, Undo2 } from "lucide-react"
import { AppShell } from "@/components/app-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { XrdAmount } from "@/components/XrdAmount"
import { SignInPrompt } from "@/components/wallet/sign-in-prompt"
import { FundingDisclosure } from "@/components/funding/funding-disclosure"
import { apiFetch } from "@/lib/api-fetch"
import { formatXrdAmount } from "@/lib/format-xrd-usd"
import { isEnabled } from "@/lib/features"
import { useWallet } from "@/hooks/useWallet"
import { useXrdUsd } from "@/lib/use-xrd-usd"
import {
  FUNDING_GRACE_WINDOW_SECS,
  FUNDING_MIN_CONTRIBUTION_XRD_DEFAULT,
} from "@/lib/funding-config"
import {
  deadlineSummary,
  describePledge,
  maxLegalPledge,
  poolProgressPercent,
  statusPresentation,
  toPoolState,
  type FundingPoolJson,
} from "@/lib/funding-display"

interface ContributionJson {
  id: number
  poolId: number
  contributorId: string
  amountXrd: string
  refundedAt: string | null
  refundedXrd: string | null
  createdAt: string
}

interface PoolDetail {
  pool: FundingPoolJson
  contributorCount: number
  remainingXrd: string
  yourContribution: ContributionJson | null
  /** Present only when the reader is the poster (the [id] route withholds the
   *  contributor ledger from everyone else — #548 closed exactly this leak). */
  contributions?: ContributionJson[]
}

export default function FundPoolPage({ params }: { params: Promise<{ id: string }> }) {
  if (!isEnabled("crowdfund")) notFound()
  const { id } = use(params)
  return <PoolDetailContent id={id} />
}

function PoolDetailContent({ id }: { id: string }) {
  const { authed, ensureSession, sessionMismatch, user } = useWallet()
  const usd = useXrdUsd()
  const [detail, setDetail] = useState<PoolDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [amount, setAmount] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  // Re-read on each render pass rather than pinned: this page has a live
  // preview whose legality depends on the deadline, and a form left open
  // across the boundary must start refusing, not keep quoting the old answer.
  const now = new Date()

  const load = useCallback(async () => {
    const res = await apiFetch(`/api/v1/funding-pools/${id}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
    return body.data as PoolDetail
  }, [id])

  useEffect(() => {
    let cancelled = false
    load()
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err?.message ?? "Failed to load this pool")
      })
    return () => {
      cancelled = true
    }
  }, [load])

  const state = useMemo(
    () => (detail ? toPoolState(detail.pool, FUNDING_GRACE_WINDOW_SECS) : null),
    [detail],
  )
  const preview = useMemo(
    () =>
      state && amount.trim() !== ""
        ? describePledge(state, amount, now, FUNDING_MIN_CONTRIBUTION_XRD_DEFAULT)
        : null,
    // `now` is deliberately not a dependency — it changes every render and
    // would defeat the memo; the preview recomputes whenever the amount or the
    // pool does, which is every input the user can actually make.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, amount],
  )
  const restOfPool = useMemo(
    () => (state ? maxLegalPledge(state, now, FUNDING_MIN_CONTRIBUTION_XRD_DEFAULT) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state],
  )

  async function post(path: string, body?: unknown) {
    setActionError(null)
    setFlash(null)
    if (!(await ensureSession())) {
      setActionError("Approve the wallet signature to continue.")
      return
    }
    setSubmitting(true)
    try {
      const res = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
      setDetail(await load())
      return true
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong")
      return false
    } finally {
      setSubmitting(false)
    }
  }

  if (loadError) {
    return (
      <AppShell>
        <div className="mx-auto w-full max-w-2xl px-4 py-6">
          <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <span>{loadError}</span>
          </div>
          <Link href="/fund" className="inline-block">
            <Button className="mt-4" variant="outline">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to pools
            </Button>
          </Link>
        </div>
      </AppShell>
    )
  }

  if (!detail || !state) {
    return (
      <AppShell>
        <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      </AppShell>
    )
  }

  const { pool } = detail
  const status = statusPresentation(state.status)
  const clock = deadlineSummary(state, now)
  const percent = poolProgressPercent(pool.pooledXrd, pool.targetXrd)
  const isPoster = !!user && user.id === pool.posterId
  const yours = detail.yourContribution
  const canPledge = state.status === "pledging"
  const canRefund =
    !!yours && !yours.refundedAt && (state.status === "expired" || state.status === "refunding")

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6">
        <Link href="/fund" className="inline-block">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            All pools
          </Button>
        </Link>

        <div className="space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="text-2xl font-semibold">{pool.title}</h1>
            <Badge variant={status.tone}>{status.label}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{status.meaning}</p>
        </div>

        <Card>
          <CardContent className="space-y-3 p-4">
            <div
              className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${percent}% of target pledged`}
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              <div>
                <div className="text-lg font-semibold tabular-nums">
                  <XrdAmount
                    amountXrd={pool.pooledXrd}
                    usdRate={usd.rate}
                    stale={usd.stale}
                    ageSeconds={usd.ageSeconds}
                    source={usd.source}
                  />
                </div>
                <div className="text-xs text-muted-foreground">
                  pledged of {formatXrdAmount(pool.targetXrd)} XRD target · {detail.contributorCount}{" "}
                  {detail.contributorCount === 1 ? "backer" : "backers"}
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-medium tabular-nums">{formatXrdAmount(detail.remainingXrd)} XRD</div>
                <div className="text-xs text-muted-foreground">still to find</div>
              </div>
              {clock.remaining && (
                <div className="text-right">
                  <div className={`text-sm font-medium ${clock.urgent ? "text-amber-600 dark:text-amber-500" : ""}`}>
                    {clock.remaining}
                  </div>
                  <div className="text-xs text-muted-foreground">{clock.label.toLowerCase()}</div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <FundingDisclosure />

        <Card>
          <CardHeader>
            <CardTitle>What this is for</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{pool.description}</p>
          </CardContent>
        </Card>

        {flash && (
          <div role="status" className="flex items-start gap-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            <span>{flash}</span>
          </div>
        )}

        {yours && (
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="text-sm">
                <span className="text-muted-foreground">Your pledge: </span>
                <span className="font-medium tabular-nums">{formatXrdAmount(yours.amountXrd)} XRD</span>
                {yours.refundedAt && (
                  <span className="ml-2 text-xs text-muted-foreground">released {formatXrdAmount(yours.refundedXrd ?? "0")} XRD</span>
                )}
              </div>
              {canRefund && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={submitting}
                  onClick={async () => {
                    const ok = await post(`/api/v1/funding-pools/${pool.id}/refund`)
                    if (ok) setFlash("Your pledge has been released from this pool's ledger.")
                  }}
                >
                  <Undo2 className="mr-2 h-4 w-4" />
                  Release my pledge
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {canPledge && (
          <Card>
            <CardHeader>
              <CardTitle>Chip in</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!authed ? (
                <SignInPrompt
                  title="Sign in to pledge"
                  description="Approve a one-time wallet signature so your pledge is recorded against your account."
                />
              ) : sessionMismatch ? (
                <p role="alert" className="text-sm text-destructive">
                  Your signed-in account is no longer shared by your wallet. Reconnect it before pledging.
                </p>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="pledge-amount">Amount (XRD)</Label>
                    <div className="flex gap-2">
                      <Input
                        id="pledge-amount"
                        inputMode="decimal"
                        placeholder={`e.g. ${FUNDING_MIN_CONTRIBUTION_XRD_DEFAULT}`}
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        aria-describedby="pledge-preview"
                      />
                      {restOfPool && (
                        <Button type="button" variant="outline" onClick={() => setAmount(restOfPool)}>
                          Fund the rest
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Minimum {formatXrdAmount(FUNDING_MIN_CONTRIBUTION_XRD_DEFAULT)} XRD. This pool does not accept
                      more than its target.
                    </p>
                  </div>

                  <div id="pledge-preview" aria-live="polite" className="min-h-5 text-sm">
                    {preview && !preview.ok && (
                      <p className="text-destructive">{preview.message}</p>
                    )}
                    {preview && preview.ok && (
                      <p className="text-muted-foreground">
                        {preview.wouldMeetTarget
                          ? "This pledge would meet the target and close the pool to further pledges."
                          : `${formatXrdAmount(preview.remainingAfterXrd)} XRD would still be needed after this.`}
                      </p>
                    )}
                  </div>

                  {actionError && (
                    <p role="alert" className="text-sm text-destructive">
                      {actionError}
                    </p>
                  )}

                  <Button
                    disabled={submitting || !preview?.ok}
                    onClick={async () => {
                      const ok = await post(`/api/v1/funding-pools/${pool.id}/pledge`, {
                        amount_xrd: amount.trim(),
                      })
                      if (ok) {
                        setAmount("")
                        setFlash("Pledge recorded. No XRD has moved.")
                      }
                    }}
                  >
                    <HandCoins className="mr-2 h-4 w-4" />
                    {submitting ? "Recording…" : "Record my pledge"}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {isPoster && detail.contributions && detail.contributions.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Backers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Visible to you as the poster only.
              </p>
              {detail.contributions.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
                  <Link href={`/profile/${c.contributorId}`} className="min-w-0 truncate font-mono text-xs no-underline hover:underline">
                    {c.contributorId}
                  </Link>
                  <span className="shrink-0 tabular-nums">
                    {formatXrdAmount(c.amountXrd)} XRD
                    {c.refundedAt && <span className="ml-2 text-xs text-muted-foreground">released</span>}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  )
}
