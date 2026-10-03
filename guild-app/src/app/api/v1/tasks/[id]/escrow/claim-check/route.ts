import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { findTaskById } from "@/db/queries/tasks"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"

// GET /api/v1/tasks/[id]/escrow/claim-check — pre-signature self-claim guard
// (P3-3b).
//
// Until this route existed, the ONLY self-claim check was the SELF_CLAIM
// branch inside applyEscrowConfirm (src/lib/escrow-confirm.ts) — reached via
// POST /tasks/[id]/escrow, which requires an intentHash. By the time that
// runs, claim_task has already been signed and broadcast, and the ~0.5 XRD
// lock fee is burned: the blueprint asserts worker != poster (lib.rs
// `claim_task`'s "self-claim not allowed" assert), so
// a self-claim can only ever land as a CommittedFailure. The client-side
// render gate in EscrowClaimButton (escrow-actions.tsx) hides the button for
// browser users, but a hand-built manifest or any non-browser client never
// touches that component. This route is the genuine server-side check EITHER
// kind of client can call before spending gas — same shape as SELF_SUBMIT
// (submissions/route.ts), just split out as a standalone pre-flight because
// (unlike submit) claiming has no other app API call in its path to attach
// the check to.
//
// Pure DB read: task.creatorId, already loaded by findTaskById. No Gateway
// call — a Gateway outage can never move this verdict either direction, and
// nothing here can turn a transient failure into a false "allowed".
//
// Deliberately scoped to self-claim only. A DB-status precheck (task not
// "open" / already claimed) was considered — same task row, no extra
// cost — and dropped: ALLOWED_FROM.claim (escrow-confirm.ts) explicitly lists
// "assigned" as a valid claim-FROM state (an expired-claim retry), so
// "status !== open" does NOT guarantee a CommittedFailure the way self-claim
// does. task.creatorId, by contrast, is immutable for a task's lifetime — this
// check can never go stale in either direction. Blocking on stale "assigned"
// here would misfire on a legitimate retry before the existing live on-chain
// Open read in EscrowClaimButton (which already handles that race via resync)
// ever runs.
// One call per claim-button press, not polled — but it is authenticated and
// hits the DB, so it gets the same per-account ceiling as the confirm route.
const claimCheckLimiter = createRateLimiter({ windowMs: 60_000, max: 30 })

export const GET = withAuth(async (_req, { params, user }) => {
  const limit = claimCheckLimiter(user.userId)
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

  if (task.creatorId === user.userId) {
    return NextResponse.json(
      { ok: false, error: { code: "SELF_CLAIM", message: "Cannot claim your own task" } },
      { status: 403 },
    )
  }

  return NextResponse.json({ ok: true, data: { allowed: true } })
})
