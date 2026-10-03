"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { AlertOctagon, FileText } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useWallet } from "@/hooks/useWallet"
import { apiFetch } from "@/lib/api-fetch"
import { isEnabled } from "@/lib/features"
import { formatRemaining, DISPUTE_WINDOW_MS } from "@/lib/countdown"
import { DEFAULT_DISPUTE_WINDOW_HOURS } from "@/lib/marketplace"

// ─────────────────────────────────────────────────────────────────────────────
// THE GAP THESE TWO COMPONENTS CLOSE
//
// The dispute path went live 2026-08-27 and, from that day, a party could have
// a task moved into Disputed and never be told. The keeper cron alerts on a
// lapsed dispute — to ONE Telegram chat, the operator's. The task page shows
// who raised it and what silence costs, but only to somebody who happens to
// open that page. Nothing pointed anyone AT the page.
//
// That is a 72-hour clock running against a person we never notified, and at
// the end of it the contract splits their reward in half. Us knowing and them
// not knowing is the part that is indefensible; the countdown is worthless to
// whoever cannot see it.
//
// No contact details exist for any user (no email, no Telegram handle bound to
// a wallet), so this cannot be a push notification today. What it CAN be is
// unmissable at the first place every user lands after connecting — which is
// what DisputeActionRequired is.
// ─────────────────────────────────────────────────────────────────────────────

interface DisputedTaskRow {
  id: number
  title: string
  rewardXrd: string
  disputedAt: string | null
  updatedAt: string
}

function windowEndsMs(row: DisputedTaskRow): number {
  // Same fallback the task page and the countdown chip use: disputedAt is the
  // on-chain dispute time, updatedAt only approximates it for rows disputed
  // before that column shipped. The CHAIN enforces the real window either way,
  // so this is a display estimate and is labelled as one.
  const base = row.disputedAt ?? row.updatedAt
  return new Date(base).getTime() + DISPUTE_WINDOW_MS
}

/**
 * Dashboard alert: the connected wallet is a party to N disputed tasks.
 *
 * Renders nothing when there are none, when no wallet is connected, or when the
 * dispute surface is compiled off — a build with disputes off must not point
 * users at affordances it does not mount.
 */
export function DisputeActionRequired() {
  const { account } = useWallet()
  // Stored WITH the account they were fetched for, rather than cleared in the
  // effect when the wallet disconnects. Clearing meant a synchronous setState
  // inside an effect body (cascading render, and the lint rule is right about
  // it); tagging instead makes staleness a render-time comparison, so rows from
  // a previous wallet can never be shown against a new one.
  const [fetched, setFetched] = useState<{ account: string; rows: DisputedTaskRow[] } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const rows = fetched && fetched.account === account ? fetched.rows : []

  useEffect(() => {
    if (!account) return
    let cancelled = false
    // Two queries because a user can be either side of a dispute and the API
    // filters are separate. Both are cheap and the result set is tiny.
    Promise.all([
      apiFetch(`/api/v1/tasks?status=disputed&creator=${encodeURIComponent(account)}&limit=20`)
        .then((r) => r.json())
        .catch(() => null),
      apiFetch(`/api/v1/tasks?status=disputed&assignee=${encodeURIComponent(account)}&limit=20`)
        .then((r) => r.json())
        .catch(() => null),
    ]).then(([asPoster, asWorker]) => {
      if (cancelled) return
      const merged = new Map<number, DisputedTaskRow>()
      for (const body of [asPoster, asWorker]) {
        if (!body?.ok || !Array.isArray(body.data)) continue
        for (const t of body.data as DisputedTaskRow[]) merged.set(t.id, t)
      }
      // Soonest deadline first — the one with least time left is the one that
      // most needs looking at.
      setFetched({
        account,
        rows: [...merged.values()].sort((a, b) => windowEndsMs(a) - windowEndsMs(b)),
      })
    })
    return () => {
      cancelled = true
    }
  }, [account])

  // Tick so the remaining time is not frozen at mount on a tab left open.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  if (!isEnabled("disputes")) return null
  if (!account || rows.length === 0) return null

  return (
    <Card className="border-red-500/40 bg-red-500/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm uppercase tracking-wide text-red-600 dark:text-red-400">
          <AlertOctagon className="h-4 w-4" aria-hidden />
          {rows.length === 1
            ? "A task you are part of is in dispute"
            : `${rows.length} tasks you are part of are in dispute`}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          If nobody rules within the {DEFAULT_DISPUTE_WINDOW_HOURS}-hour window the
          contract settles on its own: the reward splits 50/50 and the insurance
          premium returns to the poster. That happens whether or not you do
          anything, so read the dispute before the time runs out. The countdown
          below is our estimate — the chain enforces the exact window.
        </p>
        <ul className="space-y-2">
          {rows.map((row) => {
            const remaining = windowEndsMs(row) - now
            return (
              <li key={row.id}>
                <Link
                  href={`/tasks/${row.id}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-red-500/20 bg-background/60 px-3 py-2 text-sm no-underline hover:border-red-500/40"
                >
                  <span className="truncate font-medium">{row.title}</span>
                  <span className="shrink-0 font-mono text-xs text-red-600 dark:text-red-400">
                    {remaining > 0 ? `${formatRemaining(remaining)} left` : "window closed"}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}

/**
 * The raiser's written statement, on the disputed task's page.
 *
 * Shows the plaintext and the hash side by side, and says plainly that the two
 * can be checked against each other on the ledger. The point is not that we
 * promise the text is unaltered — it is that nobody has to take our word for it.
 */
export function DisputeEvidenceCard({
  evidence,
  evidenceHash,
}: {
  evidence: string | null
  evidenceHash: string | null
}) {
  // Both or neither, enforced by tasks_dispute_evidence_paired in the schema.
  // Guarding on both anyway: a half-populated row would render as evidence
  // nobody could verify, which is worse than showing nothing.
  if (!evidence || !evidenceHash) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm uppercase tracking-wide text-muted-foreground">
          <FileText className="h-4 w-4" aria-hidden />
          Statement from whoever raised the dispute
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="whitespace-pre-wrap text-sm">{evidence}</p>
        <div className="space-y-1 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            The dispute transaction carries a hash of this text, written at the
            moment the dispute was raised. Hash the statement above yourself and
            compare — if a single character had changed since, the two would not
            match.
          </p>
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            {evidenceHash}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
