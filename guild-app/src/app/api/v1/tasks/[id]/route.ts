import { NextRequest, NextResponse } from "next/server"
import { withAuth, getSessionUser } from "@/lib/auth"
import {
  findTaskById,
  updateTask,
  cancelTask,
  getSubmissionCount,
} from "@/db/queries/tasks"
import { findProjectById } from "@/db/queries/projects"
import { getTrustStats } from "@/db/queries/trust"
import { getPosterCancelStats } from "@/db/queries/poster-cancel-stats"
import { findSettlementHistoryForTask } from "@/db/queries/escrow"
import { trustTierFor } from "@/lib/trust"
import { updateTaskSchema } from "@/lib/validation"
import { bannedTaskClaimIn, copyClaimError } from "@/lib/project-copy-gate"
import { fromError } from "@/lib/api-response"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"
import {
  publicTaskView,
  isCancelledTaskVisibleTo,
  cancelledTaskLookupCode,
} from "@/lib/public-task-text"

// One budget for both writes below (edit + cancel), keyed on the session user.
// Both are already ownership-gated; this caps how hard one account can drive
// the DB through them — the same limiter every other mutating route carries.
const writeLimiter = createRateLimiter({ windowMs: 60_000, max: 10 })

function taskNotFoundResponse() {
  return NextResponse.json(
    { ok: false, error: { code: "NOT_FOUND", message: "Task not found" } },
    { status: 404 },
  )
}

// Sibling of taskNotFoundResponse for the one case that is deliberately NOT
// a plain 404: a cancelled task, hidden from a session-less viewer, whose
// party might just have a lapsed cookie. See cancelledTaskLookupCode's
// docblock (public-task-text.ts) for the enumeration analysis this trades
// off against a plain NOT_FOUND.
function archivedSignInRequiredResponse() {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "ARCHIVED_SIGN_IN_REQUIRED",
        message: "This task is archived. Sign in if you're its poster or worker to view it.",
      },
    },
    { status: 404 },
  )
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const taskId = parseInt(id)
    if (isNaN(taskId)) {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_ID", message: "Invalid task ID" } },
        { status: 400 },
      )
    }

    const task = await findTaskById(taskId)
    if (!task) {
      return taskNotFoundResponse()
    }

    // Same unauthenticated-but-optional session read as GET /api/v1/tasks —
    // a session is read but never required (the detail page must stay
    // reachable for a cold visitor). Read up front, before the extra
    // queries below, because it now also gates whether this task is
    // reachable at ALL: see docs/PROJECT-STATE.md's 2026-09-10 board ruling
    // (R6) plus the 2026-09-14 hardening. A cancelled task drops off the
    // default public LIST for anyone but its creator/assignee (see
    // `notCancelledByDefault` in db/queries/tasks.ts) — this route must not
    // let a stranger reach that same row anyway by guessing its id. A
    // SIGNED-IN non-party (including a session read that failed to verify a
    // presented token) gets the identical 404 a truly-missing id would — see
    // cancelledTaskLookupCode (public-task-text.ts). A SESSION-LESS viewer
    // (never signed in, or the cookie read itself threw) gets a DIFFERENT
    // 404, code ARCHIVED_SIGN_IN_REQUIRED — 2026-09-14 archived-task fix,
    // second pass: that population might be this task's own party with a
    // lapsed cookie, and a flat "not found" left one stranded mid-incident
    // with an uncollected bond. Owners and assignees keep reaching their own
    // cancelled tasks. This does NOT change reachability of any other
    // status — only `cancelled` is gated.
    const sessionUser = await getSessionUser().catch(() => null)
    if (!isCancelledTaskVisibleTo(task, sessionUser?.userId)) {
      const code = cancelledTaskLookupCode(sessionUser?.userId)
      return code === "ARCHIVED_SIGN_IN_REQUIRED"
        ? archivedSignInRequiredResponse()
        : taskNotFoundResponse()
    }

    const submissionCount = await getSubmissionCount(taskId)
    // Light project ref for the detail page's "part of project" link.
    const project = task.projectId ? await findProjectById(task.projectId) : null
    // Claimer's ledger-derived tier — the poster sees who they're trusting.
    const assigneeTrust = task.assigneeId
      ? { tier: trustTierFor(await getTrustStats(task.assigneeId)) }
      : null
    // Poster's cancel-after-claim history — the SHIPPABLE-NOW app-side item
    // from docs/PROJECT-STATE.md's 2026-09-01 §20 design packet (an
    // unnumbered "Also in §20" bullet; NOT §20.4, which is an unrelated,
    // still-open expire-bounty poster leak). The worker sees this BEFORE
    // claiming, on the same detail page that renders the claim button.
    // Always computed: every task has a creator.
    const posterCancelStats = await getPosterCancelStats(task.creatorId)
    // Archived panel data (2026-09-14): reaching this line with a cancelled
    // task means isCancelledTaskVisibleTo already confirmed the viewer IS
    // this task's creator or assignee (see its own body — status==='cancelled'
    // only returns true for a matching party), so no separate party check is
    // needed here. Scoped to cancelled only: every other status renders its
    // own live on-chain notices (ClaimDeadlineNotice, DisputeRaiserNotice)
    // instead, and paying for this query on every task fetch isn't worth it.
    const settlementHistory =
      task.status === "cancelled" ? await findSettlementHistoryForTask(taskId) : undefined
    return NextResponse.json({
      ok: true,
      data: {
        ...publicTaskView(task, sessionUser?.userId),
        submissionCount,
        project: project ? { id: project.id, name: project.name, slug: project.slug } : null,
        assigneeTrust,
        posterCancelStats,
        settlementHistory,
      },
    })
  } catch (err) {
    return fromError(err)
  }
}

export const PATCH = withAuth(async (req, { params, user }) => {
  const limit = writeLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const { id } = await params
  const taskId = parseInt(id)
  if (isNaN(taskId)) {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_ID", message: "Invalid task ID" } },
      { status: 400 },
    )
  }

  const task = await findTaskById(taskId)
  if (!task) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Task not found" } },
      { status: 404 },
    )
  }
  if (task.creatorId !== user.userId) {
    return NextResponse.json(
      { ok: false, error: { code: "FORBIDDEN", message: "Only the task creator can update" } },
      { status: 403 },
    )
  }
  if (task.status !== "open") {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_STATUS", message: "Can only update open tasks" } },
      { status: 400 },
    )
  }

  // A funded task stays status='open' until claimed, so the check above does not
  // cover it. On-chain-funded tasks (onChainTaskId set) hold real escrow funds and
  // their reward/terms are bound to the on-chain work-brief hash — editing them
  // off-chain would desync the DB from the chain and drive a wrong release manifest
  // (the payout TAKE_FROM_WORKTOP reads the DB reward). Refuse, mirroring DELETE.
  if (task.onChainTaskId != null) {
    return NextResponse.json(
      { ok: false, error: { code: "ON_CHAIN_ESCROW", message: "Can't edit a funded task's terms — the escrow binds the committed brief on-chain" } },
      { status: 409 },
    )
  }

  const body = await req.json().catch(() => null)
  if (!body) {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_BODY", message: "Invalid JSON" } },
      { status: 400 },
    )
  }

  const parsed = updateTaskSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
      { status: 400 },
    )
  }

  // §22, extended to tasks 2026-09-19. Only the fields PRESENT are scanned, so a
  // reward-only PATCH is never refused over text already stored.
  const bannedClaim = bannedTaskClaimIn(parsed.data)
  if (bannedClaim) return NextResponse.json(copyClaimError(bannedClaim), { status: 400 })

  const updated = await updateTask(taskId, {
    ...(parsed.data.title !== undefined && { title: parsed.data.title }),
    ...(parsed.data.description !== undefined && { description: parsed.data.description }),
    ...(parsed.data.reward_amount !== undefined && { rewardXrd: parsed.data.reward_amount }),
    ...(parsed.data.deadline !== undefined && { deadline: new Date(parsed.data.deadline) }),
  })

  return NextResponse.json({ ok: true, data: updated })
})

export const DELETE = withAuth(async (_req, { params, user }) => {
  const limit = writeLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const { id } = await params
  const taskId = parseInt(id)
  if (isNaN(taskId)) {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_ID", message: "Invalid task ID" } },
      { status: 400 },
    )
  }

  const task = await findTaskById(taskId)
  if (!task) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Task not found" } },
      { status: 404 },
    )
  }
  if (task.creatorId !== user.userId) {
    return NextResponse.json(
      { ok: false, error: { code: "FORBIDDEN", message: "Only the task creator can cancel" } },
      { status: 403 },
    )
  }
  if (task.status !== "open") {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_STATUS", message: "Can only cancel open tasks" } },
      { status: 400 },
    )
  }

  // On-chain-funded tasks hold real funds in the escrow component — cancelling
  // off-chain would strand them and fabricate a bogus refund row. Cancel/refund of
  // a funded task must go through the escrow contract (on-chain cancel wiring is a
  // later phase). Block it here.
  if (task.onChainTaskId != null) {
    return NextResponse.json(
      { ok: false, error: { code: "ON_CHAIN_ESCROW", message: "Cancel an on-chain funded task through the escrow contract" } },
      { status: 409 },
    )
  }

  const subCount = await getSubmissionCount(taskId)
  if (subCount > 0) {
    return NextResponse.json(
      { ok: false, error: { code: "HAS_SUBMISSIONS", message: "Cannot cancel task with submissions" } },
      { status: 400 },
    )
  }

  // No ledger write here: an open task without an onChainTaskId was never
  // funded (the confirm route captures the id and the fund row atomically), so
  // there is nothing to refund. Funded tasks were already 409'd above — refunds
  // happen on-chain and land in the ledger via the escrow-confirm route only.
  await cancelTask(taskId)

  return NextResponse.json({ ok: true, data: null })
})
