import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { findTaskById } from "@/db/queries/tasks"
import {
  findSubmissionById,
  reviewSubmission,
} from "@/db/queries/submissions"
import { reviewSubmissionSchema } from "@/lib/validation"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"
import { emitNotification } from "@/lib/notifications"
import { chainWriteGate } from "@/lib/chain-halt-gate"

const reviewLimiter = createRateLimiter({ windowMs: 60_000, max: 5 })

export const PATCH = withAuth(async (req, { params, user }) => {
  // Approval's counterpart is an on-chain release of the task vault. See
  // src/lib/chain-halt-gate.ts.
  const halted = await chainWriteGate()
  if (halted) return halted

  const limit = reviewLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const { id } = await params
  const submissionId = parseInt(id)
  if (isNaN(submissionId)) {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_ID", message: "Invalid submission ID" } },
      { status: 400 },
    )
  }

  const submission = await findSubmissionById(submissionId)
  if (!submission) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Submission not found" } },
      { status: 404 },
    )
  }

  const task = await findTaskById(submission.taskId)
  if (!task) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Associated task not found" } },
      { status: 404 },
    )
  }

  if (task.creatorId !== user.userId) {
    return NextResponse.json(
      { ok: false, error: { code: "FORBIDDEN", message: "Only the task creator can review submissions" } },
      { status: 403 },
    )
  }

  if (task.status !== "submitted") {
    return NextResponse.json(
      { ok: false, error: {
        code: "INVALID_STATUS",
        message: `Cannot review a task in state "${task.status}" (must be "submitted")`,
      } },
      { status: 400 },
    )
  }

  const body = await req.json().catch(() => null)
  if (!body) {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_BODY", message: "Invalid JSON" } },
      { status: 400 },
    )
  }

  const parsed = reviewSubmissionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
      { status: 400 },
    )
  }

  // The decision write is transactional and guarded (see reviewSubmission):
  // the task status is re-checked under a row lock (a concurrent escrow
  // confirm can't slip a transition between our snapshot above and the write),
  // and the submission row only accepts a decision while `pending` — a second
  // review 409s instead of silently overwriting the first. One decision per
  // row IS the audit trail; the recovery path is the worker's resubmission.
  const result = await reviewSubmission(submissionId, task.id, user.userId, {
    status: parsed.data.status,
    reviewNote: parsed.data.reviewer_notes,
    declineReason: parsed.data.decline_reason,
  })
  if (!result.ok) {
    if (result.code === "ALREADY_REVIEWED") {
      return NextResponse.json(
        { ok: false, error: {
          code: "ALREADY_REVIEWED",
          message: "This submission has already been reviewed — decisions are one per submission",
        } },
        { status: 409 },
      )
    }
    return NextResponse.json(
      { ok: false, error: {
        code: "INVALID_STATUS",
        message: `Cannot review a task in state "${result.taskStatus ?? "unknown"}" (must be "submitted")`,
      } },
      { status: 409 },
    )
  }

  // The on-chain approve_and_release tx + the escrow-confirm route
  // (kind=approve) are the ONLY path that moves money and advances the task to
  // a terminal state. Review records the submission decision only — it must
  // NOT touch the escrow ledger or task status. (The legacy off-chain
  // release-on-approve branch was removed 2026-06-10 with the
  // releaseEscrow/refundEscrow fabricators.)

  // Tell the worker their submission was reviewed — for every verdict, not
  // just revision_requested: "a worker learns a revision was requested only
  // by luck" is the gap (#382), but a worker left guessing after an approval
  // or a decline is the same gap with a different verdict. After the write,
  // never inside it (see src/lib/notifications.ts's module doc).
  await emitNotification({
    recipientId: result.submission.submitterId,
    event: "submission_reviewed",
    taskId: task.id,
    payload: {
      taskTitle: task.title,
      submissionId: result.submission.id,
      actorId: user.userId,
      reviewStatus: parsed.data.status,
      reviewNote: parsed.data.reviewer_notes ?? null,
    },
  })

  return NextResponse.json({ ok: true, data: result.submission })
})
