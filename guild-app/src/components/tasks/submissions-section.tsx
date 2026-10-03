"use client"

import { useEffect, useState } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty-state"
import { SubmissionCard } from "@/components/tasks/submission-card"
import { ReviewForm } from "@/components/tasks/review-form"
import { SignInPrompt } from "@/components/wallet/sign-in-prompt"
import { apiFetch } from "@/lib/api-fetch"
import { extractPrUrl, prMatchesRepo } from "@/lib/pr-verify"
import { DONE_LABELS, type DoneCheck } from "@/lib/task-terms"
import type { Submission, Task, User } from "@/lib/marketplace-types"
import { FileText, Lock, AlertCircle, GitPullRequest } from "lucide-react"

interface SubmissionsSectionProps {
  task: Task
}

export function SubmissionsSection({ task }: SubmissionsSectionProps) {
  // reloadKey bumps to force a fresh inner remount (e.g. after sign-in) so the
  // loading/error/auth state resets cleanly — same no-setState-in-effect
  // pattern as the per-task remount.
  const [reloadKey, setReloadKey] = useState(0)
  return (
    <SubmissionsList
      task={task}
      key={`${task.id}:${reloadKey}`}
      onReload={() => setReloadKey((k) => k + 1)}
    />
  )
}

function SubmissionsList({ task, onReload }: SubmissionsSectionProps & { onReload: () => void }) {
  const [me, setMe] = useState<User | null>(null)
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [unauthenticated, setUnauthenticated] = useState(false)

  useEffect(() => {
    let cancelled = false

    Promise.all([
      apiFetch("/api/v1/auth/me").then(async (res) => {
        if (res.status === 401) return null
        const body = await res.json().catch(() => ({}))
        if (!res.ok || !body.ok) {
          throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
        }
        return body.data.user as User
      }),
      apiFetch(`/api/v1/tasks/${task.id}/submissions`).then(async (res) => {
        if (res.status === 401) return { unauth: true as const }
        if (res.status === 403) return { forbidden: true as const }
        const body = await res.json().catch(() => ({}))
        if (!res.ok || !body.ok) {
          throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
        }
        return { list: body.data as Submission[] }
      }),
    ])
      .then(([user, result]) => {
        if (cancelled) return
        setMe(user)
        if ("unauth" in result) {
          setUnauthenticated(true)
        } else if ("forbidden" in result) {
          setForbidden(true)
        } else {
          setSubmissions(result.list)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load submissions")
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [task.id])

  function onReviewed(updated: Submission) {
    setSubmissions((prev) =>
      prev.map((s) => (s.id === updated.id ? updated : s))
    )
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 rounded-lg bg-muted/30" />
        <Skeleton className="h-24 rounded-lg bg-muted/30" />
      </div>
    )
  }

  if (error) {
    return (
      <EmptyState
        icon={<AlertCircle />}
        title="Failed to load submissions"
        description={error}
      />
    )
  }

  if (unauthenticated) {
    return (
      <SignInPrompt
        title="Sign in to view submissions"
        description="Approve a one-time wallet signature to verify your account, then we'll load this task's submissions."
        onSignedIn={onReload}
      />
    )
  }

  if (forbidden) {
    return (
      <EmptyState
        icon={<Lock />}
        title="Submissions are private"
        description="Only the task creator and submitters can see this list."
      />
    )
  }

  const isCreator = me?.id === task.creatorId
  // Task-level rollup (Step 2, docs/design/github-reality-acceptance.md #2) —
  // computed here, not on the task detail page itself, because this is the
  // earliest point in the render tree that actually HAS submission rows
  // (GET /api/v1/tasks/[id] only returns submissionCount, not the rows with
  // their prVerification). Reads what is already fetched/stored; no GitHub call.
  const reality = deriveGithubReality(task, submissions)

  if (submissions.length === 0) {
    return (
      <div className="space-y-4">
        {reality && <GithubRealityStatus summary={reality} />}
        <EmptyState
          icon={<FileText />}
          title="No submissions yet"
          description="Submitters' work will appear here once they post it."
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {reality && <GithubRealityStatus summary={reality} />}
      {submissions.map((submission) => (
        <div key={submission.id} className="space-y-3">
          <SubmissionCard submission={submission} />
          <PrVerificationPanel
            task={task}
            submission={submission}
            canVerify={me?.id === task.creatorId || me?.id === submission.submitterId}
            onVerified={onReviewed}
          />
          {isCreator &&
            submission.status === "pending" &&
            task.status === "submitted" && (
              <ReviewForm submission={submission} onReviewed={onReviewed} />
            )}
        </div>
      ))}
    </div>
  )
}

// ── "GitHub reality" status rollup (Step 2) ─────────────────────────────────
// One task-level verdict, distinct from PrVerificationPanel's per-submission
// panel below: takes the LATEST submission that carries a stored verdict
// (page order — no re-sorting), falling back to "not yet verified" when the
// task committed a repoUrl but nothing has been checked yet. Renders nothing
// when neither is true (nothing to say about GitHub reality for this task).

export type GithubRealityState = "verified" | "pending" | "failed" | "not_yet_verified"

export interface GithubRealitySummary {
  state: GithubRealityState
  prUrl: string | null
  doneChecks: Partial<Record<DoneCheck, boolean | null>>
  checkedAt: string | null
}

const REALITY_LABEL: Record<GithubRealityState, string> = {
  verified: "Verified",
  pending: "Pending",
  failed: "Failed",
  not_yet_verified: "Not yet verified",
}

/**
 * `deriveGithubReality` reads ONLY what is already on the task/submission
 * rows — no GitHub fetch, matching PrVerificationPanel's "read what is
 * stored" rule. Exported for unit testing (see
 * tests/unit/github-reality-status.test.tsx).
 */
export function deriveGithubReality(
  task: Pick<Task, "terms">,
  submissions: Submission[],
): GithubRealitySummary | null {
  // "Latest" = the last one in the array the page already gets back from
  // GET /api/v1/tasks/[id]/submissions — no independent re-sort here.
  let latestWithVerdict: Submission | undefined
  for (const s of submissions) {
    if (s.prVerification) latestWithVerdict = s
  }
  if (latestWithVerdict?.prVerification) {
    const v = latestWithVerdict.prVerification
    return { state: v.overall, prUrl: v.prUrl, doneChecks: v.doneChecks, checkedAt: v.checkedAt }
  }

  const repoUrl = task.terms?.repoUrl
  // No stored verdict anywhere. Only worth saying something when the task
  // actually committed to a repo — otherwise there is no "GitHub reality" to
  // be not-yet-verified about.
  if (!repoUrl) return null

  // A PR may already sit in a submission's content, unverified (nobody has
  // pressed Verify yet). Same repo pin verify-pr enforces, so we never link a
  // PR from some other project as if it were this task's evidence.
  let latestRef: ReturnType<typeof extractPrUrl> = null
  for (const s of submissions) {
    const ref = extractPrUrl(s.content)
    if (ref && prMatchesRepo(ref, repoUrl)) latestRef = ref
  }
  return { state: "not_yet_verified", prUrl: latestRef?.url ?? null, doneChecks: {}, checkedAt: null }
}

export function GithubRealityStatus({ summary }: { summary: GithubRealitySummary }) {
  const doneEntries = Object.entries(summary.doneChecks)
  return (
    <div className="rounded-md border border-border/60 bg-muted/10 px-3 py-2.5 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <GitPullRequest className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium">GitHub reality</span>
        <Badge className={`px-1.5 py-0 text-[10px] ${REALITY_STYLE[summary.state]}`}>
          {REALITY_LABEL[summary.state]}
        </Badge>
        {doneEntries.map(([check, ok]) => (
          <Badge key={check} variant="secondary" className="px-1.5 py-0 text-[10px]">
            {DONE_LABELS[check as DoneCheck]} {ok === true ? "✓" : ok === false ? "✗" : "—"}
          </Badge>
        ))}
        {summary.prUrl ? (
          <a href={summary.prUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">
            View PR
          </a>
        ) : (
          <span className="text-muted-foreground">no pull request linked yet</span>
        )}
      </div>
      {summary.checkedAt && (
        <p className="text-[10px] text-muted-foreground">
          checked {new Date(summary.checkedAt).toLocaleString()}
        </p>
      )}
    </div>
  )
}

// ── PR auto-verify v1 (lib/pr-verify.ts) ───────────────────────────────────────
// Renders only when the submission links a GitHub PR. The verdict is checked
// against the task's committed definition-of-done and stored on the row, so
// every later viewer sees the same evidence without a GitHub round-trip.

const OVERALL_STYLE: Record<string, string> = {
  verified: "bg-green-500/10 text-green-500",
  pending: "bg-muted text-muted-foreground",
  failed: "bg-red-500/10 text-red-500",
}

// Step 2's status rollup reuses the three colours above verbatim and adds
// exactly one more, for a state PrVerification.overall doesn't have: no
// stored verdict yet. Borrows the SAME amber "awaiting" convention already
// used on this page for other not-yet-actionable states (the task detail
// page's "Awaiting escrow funding" notice and "Not funded" badge) rather than
// inventing a new colour.
const REALITY_STYLE: Record<GithubRealityState, string> = {
  verified: OVERALL_STYLE.verified,
  pending: OVERALL_STYLE.pending,
  failed: OVERALL_STYLE.failed,
  not_yet_verified: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
}

function PrVerificationPanel({
  task,
  submission,
  canVerify,
  onVerified,
}: {
  task: Task
  submission: Submission
  canVerify: boolean
  onVerified: (updated: Submission) => void
}) {
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = extractPrUrl(submission.content)
  if (!ref) return null

  const v = submission.prVerification

  async function handleVerify() {
    setChecking(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/v1/submissions/${submission.id}/verify-pr`, {
        method: "POST",
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
      onVerified(body.data as Submission)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed")
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <GitPullRequest className="h-3.5 w-3.5 text-muted-foreground" />
        <a href={ref.url} target="_blank" rel="noopener noreferrer" className="text-primary underline">
          {ref.owner}/{ref.repo}#{ref.number}
        </a>
        {v ? (
          <>
            <Badge className={`px-1.5 py-0 text-[10px] capitalize ${OVERALL_STYLE[v.overall]}`}>
              {v.overall}
            </Badge>
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              {v.merged ? "merged ✓" : "not merged"}
            </Badge>
            {Object.entries(v.doneChecks).map(([check, ok]) => (
              <Badge key={check} variant="secondary" className="px-1.5 py-0 text-[10px]">
                {DONE_LABELS[check as DoneCheck]} {ok === true ? "✓" : ok === false ? "✗" : "—"}
              </Badge>
            ))}
            <span className="text-muted-foreground">
              checked {new Date(v.checkedAt).toLocaleString()}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">not verified against GitHub yet</span>
        )}
        {canVerify && (
          <Button size="sm" variant="outline" className="ml-auto h-6 px-2 text-[11px]"
            onClick={handleVerify} disabled={checking}>
            {checking ? "Checking…" : v ? "Re-verify" : "Verify PR"}
          </Button>
        )}
      </div>
      {/* role="alert" matches every other inline error surface in this codebase
          (submit page, review-form, sign-in-prompt, escrow-actions); this one was
          the exception, so a PR-verification failure was visible to sighted
          users only. */}
        {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
