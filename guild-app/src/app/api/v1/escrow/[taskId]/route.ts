import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { findTaskById } from "@/db/queries/tasks"
import { findEscrowByTask } from "@/db/queries/escrow"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"

const readLimiter = createRateLimiter({ windowMs: 60_000, max: 30 })

/**
 * A task's escrow ledger rows — poster and worker only.
 *
 * ⚠️ The authorization below was MISSING until 2026-09-02. `withAuth` proves
 * only that SOMEONE is signed in, and sign-up costs nothing (ROLA sign-in, no
 * gate), so any account could walk `/api/v1/escrow/1`, `/2`, `/3`… and pull
 * every task's ledger. Task ids are sequential integers printed on the public
 * board, so the walk needs no target-specific knowledge. Every sibling route in
 * this tree already gated on identity — `tasks/[id]/submissions`,
 * `submissions/[id]/review`, `submissions/[id]/verify-pr` all check
 * `task.creatorId`/submitter before returning. This one route dropped the
 * pattern.
 *
 * ⚠️ AND IT IS NOT A CONFIDENTIALITY FIX — do not let this comment imply the
 * rows are secret now, because they are not. `/ledger` deliberately PUBLISHES
 * the settlement rows (release/refund/dispute/settle/withdraw) with both
 * account addresses, the amount and the tx hash, and every one of them is on
 * mainnet where anyone can read it anyway. Honesty is the whole point of that
 * page. What this gate actually buys is narrower and worth stating exactly:
 * the `fund` rows (which `/ledger` excludes by design), and the ability to
 * enumerate the whole table cheaply through one authenticated endpoint rather
 * than reconstructing it from chain. It restores the house pattern; it does not
 * make anything private that was not already public.
 */
export const GET = withAuth(async (_req, { params, user }) => {
  const limit = readLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const { taskId } = await params
  const id = parseInt(taskId)
  if (isNaN(id)) {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_ID", message: "Invalid task ID" } },
      { status: 400 },
    )
  }

  const task = await findTaskById(id)
  if (!task) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Task not found" } },
      { status: 404 },
    )
  }

  // The two parties to the escrow. Deliberately NOT "anyone who ever submitted"
  // — a losing submitter is not a party to the money, and the settlement rows
  // they can legitimately see are on /ledger already.
  const isParty = task.creatorId === user.userId || task.assigneeId === user.userId
  if (!isParty) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "FORBIDDEN", message: "Not authorized to view this escrow ledger" },
      },
      { status: 403 },
    )
  }

  const transactions = await findEscrowByTask(id)
  return NextResponse.json({ ok: true, data: transactions })
})
