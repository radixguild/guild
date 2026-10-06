"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { notFound, useRouter } from "next/navigation"
import { ArrowLeft, HandCoins } from "lucide-react"
import { AppShell } from "@/components/app-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { SignInPrompt } from "@/components/wallet/sign-in-prompt"
import { FundingDisclosure } from "@/components/funding/funding-disclosure"
import { apiFetch } from "@/lib/api-fetch"
import { isEnabled } from "@/lib/features"
import { useWallet } from "@/hooks/useWallet"
import { signInDidNotComplete } from "@/lib/session-outcome"
import { useXrdUsd } from "@/lib/use-xrd-usd"
import { XrdAmount } from "@/components/XrdAmount"
import {
  FUNDING_DEFAULT_DEADLINE_SECS,
  FUNDING_INSURANCE_FRACTION,
  FUNDING_MAX_DEADLINE_SECS,
  FUNDING_MIN_DEADLINE_SECS,
} from "@/lib/funding-config"
import { ceilXrdMultiple, isPositiveXrd } from "@/lib/xrd-decimal"
import { DONE_CHECKS, DONE_LABELS, type DoneCheck } from "@/lib/task-terms"
import {
  STEWARDS,
  STEWARD_LABELS,
  charterReadiness,
  type PoolCharter,
} from "@/lib/pool-charter"

const DAY = 24 * 60 * 60
const MIN_DAYS = FUNDING_MIN_DEADLINE_SECS / DAY
const MAX_DAYS = FUNDING_MAX_DEADLINE_SECS / DAY
const DEFAULT_DAYS = FUNDING_DEFAULT_DEADLINE_SECS / DAY

export default function CreatePoolPage() {
  if (!isEnabled("crowdfund")) notFound()
  return <CreatePoolContent />
}

function CreatePoolContent() {
  const router = useRouter()
  const { authed, ensureSessionDetailed } = useWallet()
  const usd = useXrdUsd()
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [targetXrd, setTargetXrd] = useState("")
  const [days, setDays] = useState(String(DEFAULT_DAYS))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── The charter ──────────────────────────────────────────────────────────
  // A pool is a project agreed BEFORE it is a fundraiser: these are the
  // fields someone deciding whether to put money behind an outcome needs to
  // be able to read. See src/lib/pool-charter.ts for why `terms` here is the
  // task wizard's own TaskTermsSchema rather than a lookalike.
  const [problem, setProblem] = useState("")
  const [deliverablesText, setDeliverablesText] = useState("")
  const [outOfScopeText, setOutOfScopeText] = useState("")
  const [criteriaText, setCriteriaText] = useState("")
  const [doneChecks, setDoneChecks] = useState<DoneCheck[]>([])
  const [eligibility, setEligibility] = useState<"both" | "humans" | "agents">("both")
  const [steward, setSteward] = useState<(typeof STEWARDS)[number] | "">("")
  const [specUrl, setSpecUrl] = useState("")

  const charter: Partial<PoolCharter> = useMemo(() => {
    const lines = (t: string) =>
      t.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 7)
    const deliverables = lines(deliverablesText)
    const outOfScope = lines(outOfScopeText)
    const acceptanceCriteria = lines(criteriaText)
    return {
      ...(problem.trim() ? { problem: problem.trim() } : {}),
      ...(deliverables.length ? { deliverables } : {}),
      ...(outOfScope.length ? { outOfScope } : {}),
      ...(steward ? { steward } : {}),
      terms: {
        ...(acceptanceCriteria.length ? { acceptanceCriteria } : {}),
        ...(doneChecks.length ? { definitionOfDone: doneChecks } : {}),
        claimEligibility: eligibility,
        ...(specUrl.trim().startsWith("https://") ? { specUrl: specUrl.trim() } : {}),
      },
    }
  }, [problem, deliverablesText, outOfScopeText, criteriaText, doneChecks, eligibility, steward, specUrl])

  // The SAME function the publish endpoint gates on (pool-charter.ts), so the
  // checklist a poster reads here and the server's refusal can never disagree.
  const readiness = useMemo(() => charterReadiness(charter), [charter])

  const toggleDone = (c: DoneCheck) =>
    setDoneChecks((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]))

  // Quoted with the SAME function the route uses to record it
  // (ceilXrdMultiple against FUNDING_INSURANCE_FRACTION), so the figure shown
  // before submitting is the figure stored on the row — the insurance is
  // poster-prepaid precisely so `target` stays exactly what the worker
  // receives, and a preview that rounded differently would misstate the cost.
  const insuranceXrd = useMemo(() => {
    const t = targetXrd.trim()
    if (!/^\d+(\.\d{1,18})?$/.test(t) || !isPositiveXrd(t)) return null
    return ceilXrdMultiple(t, String(FUNDING_INSURANCE_FRACTION))
  }, [targetXrd])

  const dayCount = Number(days)
  const daysValid = Number.isInteger(dayCount) && dayCount >= MIN_DAYS && dayCount <= MAX_DAYS
  const canSubmit =
    title.trim().length > 0 &&
    description.trim().length > 0 &&
    insuranceXrd !== null &&
    daysValid &&
    !submitting

  async function submit() {
    setError(null)
    const gate = await ensureSessionDetailed()
    if (!gate.ok) {
      setError(signInDidNotComplete("no pool was opened", gate))
      return
    }
    setSubmitting(true)
    try {
      const res = await apiFetch("/api/v1/funding-pools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          target_xrd: targetXrd.trim(),
          charter,
          deadline_secs: dayCount * DAY,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
      router.push(`/fund/${data.data.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open the pool")
      setSubmitting(false)
    }
  }

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6">
        <Link href="/fund" className="inline-block">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            All pools
          </Button>
        </Link>

        <div>
          <h1 className="text-2xl font-semibold">Open a funding pool</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Agree the project first — scope, deliverables, what &quot;done&quot; means and who
            accepts it — then set what it should pay. It opens as a draft; pledging starts only
            when you publish it.
          </p>
        </div>

        <FundingDisclosure />

        {!authed ? (
          <SignInPrompt
            title="Sign in to open a pool"
            description="Approve a one-time wallet signature so the pool is recorded against your account."
          />
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>What needs doing?</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="pool-title">
                    Title <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="pool-title"
                    maxLength={200}
                    placeholder="e.g. A dApp-definition verifier anyone can run"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pool-description">
                    Description <span className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    id="pool-description"
                    rows={6}
                    maxLength={5000}
                    placeholder="What you want built, what good looks like, and why it matters."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>The project</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  A pool is an agreement before it is a fundraiser. Everything here is fixed the
                  moment you open it for pledges, because it is what people are pledging against.
                </p>

                <div className="space-y-2">
                  <Label htmlFor="pool-problem">
                    What problem does this solve? <span className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    id="pool-problem"
                    rows={3}
                    maxLength={600}
                    placeholder="What is broken or missing today, and who it costs."
                    value={problem}
                    onChange={(e) => setProblem(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="pool-deliverables">
                    Deliverables — one per line (max 7) <span className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    id="pool-deliverables"
                    rows={3}
                    placeholder={"A CLI that verifies a dApp definition\nA short README showing one worked example"}
                    value={deliverablesText}
                    onChange={(e) => setDeliverablesText(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    What exists at the end that doesn&apos;t now. Concrete things, not activities.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="pool-criteria">
                    Acceptance criteria — one per line (max 7){" "}
                    <span className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    id="pool-criteria"
                    rows={3}
                    placeholder={"Runs against mainnet with no API key\nAll existing tests stay green"}
                    value={criteriaText}
                    onChange={(e) => setCriteriaText(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Statements a reviewer can check. These carry into the task&apos;s terms and are
                    committed into the on-chain brief when the pool becomes a task.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="pool-out-of-scope">Out of scope — one per line</Label>
                  <Textarea
                    id="pool-out-of-scope"
                    rows={2}
                    placeholder={"A hosted web version\nSupport for networks other than mainnet"}
                    value={outOfScopeText}
                    onChange={(e) => setOutOfScopeText(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    The cheapest argument you will ever prevent. Most &quot;that isn&apos;t what we
                    funded&quot; disputes are about something nobody wrote down as excluded.
                  </p>
                </div>

                <div className="space-y-2">
                  <span className="text-sm font-medium leading-none">Done means</span>
                  <div className="flex flex-wrap gap-2">
                    {DONE_CHECKS.map((check) => {
                      const on = doneChecks.includes(check)
                      return (
                        <button
                          key={check}
                          type="button"
                          onClick={() => toggleDone(check)}
                          aria-pressed={on}
                          className={`rounded-full border px-3 py-1 text-xs transition-colors ${on ? "border-primary bg-primary/10 text-foreground" : "border-input text-muted-foreground hover:border-primary/60"}`}
                        >
                          {DONE_LABELS[check]}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Who can build it</Label>
                    <div className="flex gap-1">
                      {(["both", "humans", "agents"] as const).map((who) => (
                        <button
                          key={who}
                          type="button"
                          onClick={() => setEligibility(who)}
                          aria-pressed={eligibility === who}
                          className={`flex-1 rounded-md border px-1 py-1.5 text-[11px] capitalize transition-colors ${eligibility === who ? "border-primary bg-primary/10" : "border-input text-muted-foreground"}`}
                        >
                          {who}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pool-steward">Who accepts the work</Label>
                    <select
                      id="pool-steward"
                      className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                      value={steward}
                      onChange={(e) => setSteward(e.target.value as typeof steward)}
                    >
                      <option value="">Not decided</option>
                      {STEWARDS.map((sv) => (
                        <option key={sv} value={sv}>
                          {STEWARD_LABELS[sv]}
                        </option>
                      ))}
                    </select>
                    {/* The honesty note this field cannot ship without: naming a
                        steward records an intention, it does not grant anyone
                        authority, because the blueprint that would hold the task
                        receipt and gate approve on it is still a design. */}
                    <p className="text-[11px] text-muted-foreground">
                      Recorded, not enforced — whoever holds the task receipt approves until the
                      pool blueprint ships.
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="pool-spec">Spec or repo link</Label>
                  <Input
                    id="pool-spec"
                    placeholder="https://github.com/org/repo/issues/42"
                    value={specUrl}
                    onChange={(e) => setSpecUrl(e.target.value)}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Readiness — driven by charterReadiness(), the same function the
                publish endpoint gates on, so this can never promise a publish
                the server will refuse. */}
            <Card className={readiness.ready ? "border-primary/30" : "border-amber-500/30"}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  {readiness.ready ? "Ready to open for pledges" : "Before this can take pledges"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-muted-foreground">
                {readiness.blocking.map((b) => (
                  <p key={b} className="flex gap-2">
                    <span className="text-destructive">•</span>
                    <span>{b}</span>
                  </p>
                ))}
                {readiness.advisory.map((a) => (
                  <p key={a} className="flex gap-2">
                    <span className="text-muted-foreground/60">•</span>
                    <span>{a}</span>
                  </p>
                ))}
                {readiness.ready && readiness.advisory.length === 0 && (
                  <p>Everything worth settling up front is settled.</p>
                )}
                <p className="pt-1 text-[11px]">
                  You can save this as a draft either way — a draft takes no pledges and its clock
                  hasn&apos;t started, so there is no rush to get it right in one sitting.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Target &amp; window</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="pool-target">
                      Target (XRD) <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="pool-target"
                      inputMode="decimal"
                      placeholder="e.g. 500"
                      value={targetXrd}
                      onChange={(e) => setTargetXrd(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      What the person doing the work would receive.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pool-days">Open for (days)</Label>
                    <Input
                      id="pool-days"
                      type="number"
                      min={MIN_DAYS}
                      max={MAX_DAYS}
                      step={1}
                      value={days}
                      onChange={(e) => setDays(e.target.value)}
                      aria-invalid={!daysValid}
                    />
                    <p className={`text-xs ${daysValid ? "text-muted-foreground" : "text-destructive"}`}>
                      Between {MIN_DAYS} and {MAX_DAYS} days.
                    </p>
                  </div>
                </div>

                {insuranceXrd !== null && (
                  <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-muted-foreground">Insurance you would pre-pay</span>
                      <span className="font-medium tabular-nums">
                        <XrdAmount
                          amountXrd={insuranceXrd}
                          usdRate={usd.rate}
                          stale={usd.stale}
                          ageSeconds={usd.ageSeconds}
                          source={usd.source}
                        />
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Recorded now and charged when the pool becomes a task, so the target stays
                      exactly what the worker receives rather than being shaved to cover it.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <Button disabled={!canSubmit} onClick={submit}>
              <HandCoins className="mr-2 h-4 w-4" />
              {submitting ? "Saving…" : "Save as draft"}
            </Button>
          </>
        )}
      </div>
    </AppShell>
  )
}
