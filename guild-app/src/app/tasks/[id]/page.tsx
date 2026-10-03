"use client"

import { use, useState, useEffect } from "react"
import Link from "next/link"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { SubmissionsSection } from "@/components/tasks/submissions-section"
import { TaskStageStrip } from "@/components/tasks/task-stage-strip"
import { CountdownChip } from "@/components/tasks/countdown-chip"
import {
  EscrowDepositButton,
  EscrowClaimButton,
  EscrowSubmitButton,
  EscrowApproveButton,
  ReleaseAfterReviewTimeoutButton,
  EscrowCancelButton,
  RaiseDisputeButton,
  FinalizeDisputeButton,
  EscrowResyncButton,
  EscrowPushEntitlementButton,
  EscrowWithdrawButton,
  ExpireClaimButton,
} from "@/components/tasks/escrow-actions"
import { EscrowDisabledNotice } from "@/components/tasks/escrow-disabled-notice"
import { PrivateRepoTaskNote } from "@/components/tasks/private-repo-note"
import { ScamSafetyNotice } from "@/components/tasks/scam-safety-notice"
import { ClaimDeadlineNotice, DisputeRaiserNotice } from "@/components/tasks/escrow-truth"
import { DisputeEvidenceCard } from "@/components/tasks/dispute-alerts"
import {
  SettlementHistoryPanel,
  type SettlementHistoryEvent,
} from "@/components/tasks/settlement-history-panel"
import { SignInPrompt } from "@/components/wallet/sign-in-prompt"
import { apiFetch } from "@/lib/api-fetch"
import { AppShell } from "@/components/app-shell"
import type { Task } from "@/lib/marketplace-types"
import {
  formatAddress,
  getStatusColor,
  isOpenAndFunded,
} from "@/lib/marketplace-utils"
import { XrdAmount } from "@/components/XrdAmount"
import { useXrdUsd } from "@/lib/use-xrd-usd"
import { INSURANCE_RATE } from "@/lib/marketplace"
import { renderContractSummary, hasTerms, canonicalTermsBlock } from "@/lib/task-terms"
import { TRUST_TIER_LABELS, TRUST_TIER_BADGE_CLASS, type TrustTier } from "@/lib/trust"
import type { PosterCancelStats } from "@/lib/poster-cancel-stats"
import {
  ArrowLeft,
  AlertCircle,
  Calendar,
  Coins,
  User,
  Shield,
} from "lucide-react"

type TaskWithCount = Task & {
  submissionCount?: number
  project?: { id: number; name: string; slug: string } | null
  assigneeTrust?: { tier: TrustTier } | null
  posterCancelStats?: PosterCancelStats
  // Only present when status === "cancelled" AND the viewer is this task's
  // creator/assignee — see GET /api/v1/tasks/[id]. Absent (not empty) for
  // every other status/viewer combination.
  settlementHistory?: SettlementHistoryEvent[]
}

// "Cancelled after claim" vs a plain "Cancelled" — both are the SAME raw DB
// status (the badge elsewhere on this page always shows `task.status`
// verbatim; this is a supplementary label, never a replacement for it).
// Derived from assigneeId alone: a task that was never claimed has no
// assignee to have cancelled "after". No new column, no invented timestamp.
function cancelledStatusLabel(task: Pick<TaskWithCount, "assigneeId">): string {
  return task.assigneeId ? "Cancelled after claim" : "Cancelled"
}

interface TaskDetailPageProps {
  params: Promise<{ id: string }>
}

export default function TaskDetailPage({ params }: TaskDetailPageProps) {
  const { id } = use(params)
  // key={id} forces remount when the route param changes, so the inner
  // component's state resets to initial without setState-in-effect.
  return <AppShell><TaskDetailView id={id} key={id} /></AppShell>
}

function TaskDetailView({ id }: { id: string }) {
  const [task, setTask] = useState<TaskWithCount | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Single source of truth for "why no task is rendering", instead of two
  // separate booleans: every branch below that reaches a definitive HTTP
  // outcome sets this explicitly (including the success path, which clears
  // it), so a refetch after sign-in can never leave a PREVIOUS outcome
  // (e.g. "archived-sign-in" from before this session existed) lingering
  // alongside a fresh one — no separate reset-at-top-of-effect needed, which
  // is also what react-hooks/set-state-in-effect wants: state changes in
  // response to the fetch settling, not unconditionally at effect start.
  //
  // "archived-sign-in": the task exists and is cancelled, but the request
  // carried no session — see cancelledTaskLookupCode (public-task-text.ts).
  // Could be a genuinely anonymous visitor, or this task's own poster/worker
  // with a lapsed guild_session cookie (the 2026-09-14 incident: a
  // client-cached wallet badge kept showing "signed in" after the
  // server-side session had actually expired). The page can't tell those
  // two apart, so it offers a sign-in instead of the dead end a flat "not
  // found" would be.
  const [notFound, setNotFound] = useState<"none" | "missing" | "archived-sign-in">("none")
  // Bumped by escrow actions (and by a successful sign-in below) to re-fetch
  // the task after its status — or this viewer's session — advances.
  const [refreshKey, setRefreshKey] = useState(0)
  // Client-side XRD→USD rate (fails open to null → XRD-only labels).
  const { rate: usdRate, stale: usdStale, ageSeconds: usdAgeSeconds, source: usdSource } = useXrdUsd()

  useEffect(() => {
    let cancelled = false

    apiFetch(`/api/v1/tasks/${id}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (res.status === 404) {
          if (!cancelled) {
            setError(null)
            setNotFound(
              body?.error?.code === "ARCHIVED_SIGN_IN_REQUIRED" ? "archived-sign-in" : "missing",
            )
          }
          return null
        }
        if (!res.ok || !body.ok) {
          throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
        }
        if (!cancelled) {
          setError(null)
          setNotFound("none")
        }
        return body.data as TaskWithCount
      })
      .then((data) => {
        if (cancelled || !data) return
        setTask({
          ...data,
          deadline: data.deadline ? new Date(data.deadline) : null,
          disputedAt: data.disputedAt ? new Date(data.disputedAt) : null,
          createdAt: new Date(data.createdAt),
          updatedAt: new Date(data.updatedAt),
          settlementHistory: data.settlementHistory?.map((e) => ({
            ...e,
            createdAt: new Date(e.createdAt),
          })),
        })
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? "Failed to load task")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [id, refreshKey])

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-24 rounded bg-muted/30" />
        <Skeleton className="h-10 w-1/2 rounded bg-muted/30" />
        <div className="grid gap-6 lg:grid-cols-3">
          <Skeleton className="h-64 min-w-0 rounded-lg bg-muted/30 lg:col-span-2" />
          <Skeleton className="h-64 min-w-0 rounded-lg bg-muted/30" />
        </div>
      </div>
    )
  }

  if (notFound === "archived-sign-in") {
    return (
      <SignInPrompt
        title="This task is archived"
        description="It was cancelled. Sign in if you're its poster or worker to view it — anyone else sees the same page a missing task would show."
        onSignedIn={() => setRefreshKey((k) => k + 1)}
      />
    )
  }

  if (notFound === "missing") {
    return (
      <EmptyState
        icon={<AlertCircle />}
        title="Task not found"
        description={`No task with id ${id} exists.`}
        action={
          <Link href="/tasks">
            <Button variant="outline">Back to Tasks</Button>
          </Link>
        }
      />
    )
  }

  if (error || !task) {
    return (
      <EmptyState
        icon={<AlertCircle />}
        title="Failed to load task"
        description={error ?? "Unknown error"}
      />
    )
  }

  const submissionCount = task.submissionCount ?? 0

  return (
    <div className="space-y-6">
      <Link
        href="/tasks"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Tasks
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        {/* min-w-0 + break-words: an unbroken title (a pasted URL or hash) is
            one long word, so without both it widened this flex item and
            collided with the Claim/Submit/Fund buttons opposite. */}
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold break-words">
              <span className="mr-2 font-mono text-lg font-normal text-muted-foreground">#{task.id}</span>
              {task.title}
            </h1>
            <Badge
              variant="secondary"
              className={getStatusColor(task.status)}
            >
              {task.status}
            </Badge>
            {/* Supplementary to the raw-status badge above, never a
                replacement for it — see cancelledStatusLabel's own comment. */}
            {task.status === "cancelled" && (
              <span className="text-xs text-muted-foreground">
                ({cancelledStatusLabel(task)})
              </span>
            )}
            {/* Live timing window: open→deadline, disputed→72h auto-resolve
                (disputedAt = persisted on-chain dispute time; updatedAt is the
                legacy fallback, same chain as finalize) */}
            <CountdownChip
              status={task.status}
              deadline={task.deadline}
              disputedAt={task.disputedAt}
              updatedAt={task.updatedAt}
            />
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <User className="h-4 w-4" />
              {formatAddress(task.creatorId)}
            </span>
            <span className="flex items-center gap-1">
              <Coins className="h-4 w-4" />
              <XrdAmount
                amountXrd={task.rewardXrd}
                unit={task.rewardResource ?? "XRD"}
                usdRate={usdRate}
                stale={usdStale}
                ageSeconds={usdAgeSeconds}
                source={usdSource}
              />
            </span>
            {task.deadline && (
              <span className="flex items-center gap-1">
                <Calendar className="h-4 w-4" />
                Due {task.deadline.toLocaleDateString()}
              </span>
            )}
            <span className="flex items-center gap-1">
              <Shield className="h-4 w-4" />+{task.xpReward} XP
            </span>
          </div>
        </div>
        {/* Escrow-off build: every button below this point (fund, claim,
            submit, approve, cancel, dispute, withdraw) renders nothing —
            say so once, here, instead of leaving a silent gap where the
            task's actions would be. */}
        <EscrowDisabledNotice />
        {/* Funded open tasks claim via the single on-chain EscrowClaimButton
            below (#3 — no separate DB "Claim & Submit" link). Unfunded open
            tasks aren't claimable (Rule one) — show an awaiting-funding notice. */}
        {task.status === "open" && task.onChainTaskId == null && (
          <div className="max-w-xs space-y-2">
            <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>Awaiting escrow funding — not claimable yet. The reward becomes claimable once the poster funds the on-chain escrow.</span>
            </div>
            {/* "Fund later" recovery: the poster funds from here (same STORED-row
                brief derivation as /tasks/create, incl. the deadline column). */}
            <EscrowDepositButton
              taskId={String(task.id)}
              posterId={task.creatorId}
              rewardXrd={Number(task.rewardXrd)}
              title={task.title}
              description={task.description}
              termsBlock={
                hasTerms(task.terms) || task.deadline
                  ? canonicalTermsBlock(task.terms, {
                      dueIso: task.deadline ? task.deadline.toISOString() : null,
                    })
                  : ""
              }
              onSuccess={() => setRefreshKey((k) => k + 1)}
            />
          </div>
        )}
        {/* Claimable, but its brief points at the Guild's earlier repository — warn
            BEFORE the claim area (private-repo-note.tsx says why, and when to remove). */}
        {task.status === "open" && (
          <PrivateRepoTaskNote
            taskId={task.id}
            className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs"
          />
        )}
        {/* Escrow claim (renders only when escrow deployed + funded on-chain) */}
        {task.status === "open" && (
          <EscrowClaimButton
            taskDbId={task.id}
            onChainTaskId={task.onChainTaskId}
            posterId={task.creatorId}
            posterCancelStats={task.posterCancelStats}
            onSuccess={() => setRefreshKey((k) => k + 1)}
          />
        )}
        {/* Escrow submit (worker, after claiming). The on-chain evidence
            commits to the worker's stored DB submission, and posting that
            submission flips the task to "submitted" — so the button stays
            available at "submitted" too, until the on-chain submit lands
            (the claim receipt burns on success, which ends the flow). */}
        {/* ⚠️ Wave B: submit_task takes a brief_hash the blueprint checks against
            the committed work_brief_hash (P4-3). title/description/termsBlock
            below MUST be the identical expressions the fund button passes — same
            source, same canonicalization, same v1/v2 choice — or the two hashes
            differ and an HONEST submission is rejected on chain. */}
        {(task.status === "assigned" || task.status === "submitted") && (
          <EscrowSubmitButton
            taskDbId={task.id}
            onChainTaskId={task.onChainTaskId}
            workerId={task.assigneeId}
            hasSubmission={submissionCount > 0}
            title={task.title}
            description={task.description}
            termsBlock={
              hasTerms(task.terms) || task.deadline
                ? canonicalTermsBlock(task.terms, {
                    dueIso: task.deadline ? task.deadline.toISOString() : null,
                  })
                : ""
            }
            onSuccess={() => setRefreshKey((k) => k + 1)}
          />
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2 space-y-6">
          {/* Lifecycle + this viewer's next move, above the fold. The controls
              themselves stay in the sidebar; this is a signpost, not a copy of
              them. Added after the first real two-party settlement, where the
              poster finished the walk without noticing the Collect affordance. */}
          <TaskStageStrip onChainTaskId={task.onChainTaskId} />

          {/* Archived ("what happened") panel — only ever populated by the
              API for this task's own creator/assignee viewing a cancelled
              task (see settlementHistory's comment on TaskWithCount above).
              Reaching this render with task.status === "cancelled" at all
              already proves that: a non-party gets ARCHIVED_SIGN_IN_REQUIRED
              or NOT_FOUND before `task` is ever set. */}
          {task.status === "cancelled" && (
            <SettlementHistoryPanel
              events={task.settlementHistory ?? []}
              postedAt={task.createdAt}
              assigneeId={task.assigneeId ?? null}
              cancelledAt={task.updatedAt}
            />
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
                Description
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                {task.description}
              </p>
            </CardContent>
          </Card>

          {(hasTerms(task.terms) || task.deadline) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
                  Delivery terms
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {task.terms?.acceptanceCriteria?.length ? (
                  <ul className="list-disc pl-5 text-sm space-y-0.5">
                    {task.terms.acceptanceCriteria.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                ) : null}
                {renderContractSummary({
                  rewardXrd: Number(task.rewardXrd),
                  insuranceXrd: Math.ceil(Number(task.rewardXrd) * INSURANCE_RATE),
                  terms: task.terms,
                  dueIso: task.deadline ? task.deadline.toISOString() : null,
                  usdRate,
                  rewardResource: task.rewardResource,
                }).map((line, i) => (
                  <p key={i} className="text-xs text-muted-foreground">
                    {line}
                  </p>
                ))}
                {(task.terms?.repoUrl || task.terms?.specUrl) && (
                  <div className="flex flex-wrap gap-3 pt-1 text-xs">
                    {task.terms.repoUrl && (
                      <a href={task.terms.repoUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                        Repository
                      </a>
                    )}
                    {task.terms.specUrl && (
                      <a href={task.terms.specUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                        Issue / spec
                      </a>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <div className="space-y-4">
            <h2 className="text-lg font-semibold">
              Submissions ({submissionCount})
            </h2>
            <SubmissionsSection task={task} />
          </div>
        </div>

        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
                Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <Badge
                  variant="secondary"
                  className={getStatusColor(task.status)}
                >
                  {task.status}
                </Badge>
              </div>
              {/* Open tasks only (2026-09-24), matching the task card's chip:
                  onChainTaskId stays set for the task's whole life, so this row
                  read "Funded" on paid and submitted tasks. The Status row above
                  already says where those stand. */}
              {task.status === "open" && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Escrow</span>
                  {isOpenAndFunded(task) ? (
                    <Badge variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-600 dark:text-emerald-500">
                      Funded
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-500">
                      Not funded
                    </Badge>
                  )}
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Reward</span>
                <span className="font-mono font-medium">
                  <XrdAmount
                    amountXrd={task.rewardXrd}
                    unit={task.rewardResource ?? "XRD"}
                    usdRate={usdRate}
                    stale={usdStale}
                    ageSeconds={usdAgeSeconds}
                    source={usdSource}
                  />
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">XP Reward</span>
                <span className="font-mono">+{task.xpReward}</span>
              </div>
              {/* No "Min. Tier" row — `required_tier` is an inert column default that nothing
                  sets or enforces. See the note in components/tasks/task-card.tsx. */}
              {task.assigneeId && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Assignee</span>
                  <span className="font-mono text-xs">
                    {formatAddress(task.assigneeId)}
                  </span>
                </div>
              )}
              {task.assigneeTrust && (
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Claimer trust</span>
                  <Link href={`/profile/${task.assigneeId}`}>
                    <Badge className={`text-[10px] ${TRUST_TIER_BADGE_CLASS[task.assigneeTrust.tier]}`}>
                      {TRUST_TIER_LABELS[task.assigneeTrust.tier]}
                    </Badge>
                  </Link>
                </div>
              )}
              {task.project && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Project</span>
                  <Link href={`/projects/${task.project.slug}`} className="text-primary hover:underline">
                    {task.project.name}
                  </Link>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Created</span>
                <span>{task.createdAt.toLocaleDateString()}</span>
              </div>
            </CardContent>
          </Card>

          {/* Always on, beside the money buttons: what a real payout looks like,
              so a DM or site claiming otherwise reads as the scam it is. */}
          <ScamSafetyNotice />

          {/* Collect a settled PULL entitlement (redesign §5c).

              ⚠️ Deliberately NOT inside a task.status condition, and that is the
              whole design: under pull an entitlement outlives the lifecycle, so
              the money is owed on exactly the terminal rows a status gate would
              skip — `paid` (worker's reward), `cancelled`/`refunded` (poster's
              refund), `open` again after an expire (poster's forfeited bond).
              The component asks the CHAIN who is owed what and renders nothing
              otherwise, including against the deployed pre-pull escrow. */}
          <EscrowWithdrawButton
            taskDbId={task.id}
            onChainTaskId={task.onChainTaskId}
            onSuccess={() => setRefreshKey((k) => k + 1)}
          />

          {/* Self-service chain → DB resync (escrow tasks): replays any missed
              lifecycle confirms server-side; renders only when funded on-chain */}
          <EscrowResyncButton
            taskDbId={task.id}
            onChainTaskId={task.onChainTaskId}
            onSynced={() => setRefreshKey((k) => k + 1)}
          />

          {/* Poster cancel — open (unclaimed): cancel_task refunds the
              escrowed reward + insurance to the poster */}
          {task.status === "open" && (
            <EscrowCancelButton
              taskDbId={task.id}
              onChainTaskId={task.onChainTaskId}
              posterId={task.creatorId}
              workerId={task.assigneeId}
              phase="open"
              onSuccess={() => setRefreshKey((k) => k + 1)}
            />
          )}

          {/* Bond-at-risk truth (U2): the on-chain claim deadline is invisible
              in the DB, so read it live — after it, expire_claim forfeits the
              worker's claim bond. Renders only while genuinely Claimed on-chain. */}
          {task.status === "assigned" && (
            <>
              <ClaimDeadlineNotice onChainTaskId={task.onChainTaskId} />
              {/* Expire overdue claim (operator ruling 2026-08-29,
                  docs/PROJECT-STATE.md): expire_claim is PUBLIC and time-gated,
                  so ANY signed-in user — not just the poster or worker — may
                  expire a claim once its deadline has passed and collect the
                  forfeited-bond bounty. The button self-gates on the live
                  on-chain deadline (renders nothing before it passes); the
                  notice above it is just cheap visibility. No keeper/cron
                  here — the watch-only decision stands. Until 2026-08-29 the
                  notice told workers "anyone can call expire_claim" while
                  offering nobody a way. */}
              <ExpireClaimButton
                taskDbId={task.id}
                onChainTaskId={task.onChainTaskId}
                onSuccess={() => setRefreshKey((k) => k + 1)}
              />
            </>
          )}

          {/* Settled-but-uncollected: anyone may deliver a payout to its PINNED
            account. Rendered for BOTH parties and gated on the CHAIN saying
            something is owed, not on who is viewing — the whole point is that a
            payee who cannot collect (lost badge/receipt) is paid by someone
            else. Renders nothing when both lanes are zero. */}
        <EscrowPushEntitlementButton
          onChainTaskId={task.onChainTaskId}
          party="worker"
          onSuccess={() => setRefreshKey((k) => k + 1)}
        />
        <EscrowPushEntitlementButton
          onChainTaskId={task.onChainTaskId}
          party="poster"
          onSuccess={() => setRefreshKey((k) => k + 1)}
        />

        {/* Poster cancel — assigned (claimed, not yet submitted): voids the
              worker's claim; escrow refunds to the poster and the worker's
              claim bond is returned to the worker in the same tx */}
          {task.status === "assigned" && (
            <EscrowCancelButton
              taskDbId={task.id}
              onChainTaskId={task.onChainTaskId}
              posterId={task.creatorId}
              workerId={task.assigneeId}
              phase="claimed"
              onSuccess={() => setRefreshKey((k) => k + 1)}
            />
          )}

          {/* Submitted: review-window countdown + the permissionless finalize
              once it lapses (Wave B stage 6). Reads review_deadline live —
              the DB has no column for it — and renders nothing until there is
              one to show (a pre-Wave-B component included). */}
          {task.status === "submitted" && (
            <ReleaseAfterReviewTimeoutButton
              taskDbId={task.id}
              onChainTaskId={task.onChainTaskId}
              posterId={task.creatorId}
              workerId={task.assigneeId}
              onSuccess={() => setRefreshKey((k) => k + 1)}
            />
          )}

          {/* Escrow approve + release (poster, once work is submitted) */}
          {task.status === "submitted" && (
            <EscrowApproveButton
              taskDbId={task.id}
              onChainTaskId={task.onChainTaskId}
              posterId={task.creatorId}
              rewardXrd={Number(task.rewardXrd)}
              workerAddress={task.assigneeId}
              onSuccess={() => setRefreshKey((k) => k + 1)}
            />
          )}

          {/* Raise dispute (poster or worker, while the work is submitted) */}
          {task.status === "submitted" && (
            <RaiseDisputeButton
              taskDbId={task.id}
              onChainTaskId={task.onChainTaskId}
              posterId={task.creatorId}
              workerId={task.assigneeId}
              onSuccess={() => setRefreshKey((k) => k + 1)}
            />
          )}

          {/* Dispute-raiser + outcome truth (U3): who raised it and what
              silence costs — read live from dispute_raised_by. */}
          {task.status === "disputed" && (
            <DisputeRaiserNotice onChainTaskId={task.onChainTaskId} />
          )}

          {/* The raiser's written statement, if they filed one. Above the
              finalize button on purpose: read what the dispute is about before
              you are offered the control that ends it. */}
          {task.status === "disputed" && (
            <DisputeEvidenceCard
              evidence={task.disputeEvidence ?? null}
              evidenceHash={task.disputeEvidenceHash ?? null}
            />
          )}

          {/* Finalize dispute (poster or worker, after the 72h auto-resolve
              window; disputedAt = persisted on-chain dispute time, falling
              back to updatedAt for rows disputed before it was persisted) */}
          {task.status === "disputed" && (
            <FinalizeDisputeButton
              taskDbId={task.id}
              onChainTaskId={task.onChainTaskId}
              posterId={task.creatorId}
              workerId={task.assigneeId}
              disputedAt={task.disputedAt ?? task.updatedAt}
              onSuccess={() => setRefreshKey((k) => k + 1)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
