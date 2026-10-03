import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { findTaskById, updateTaskIfStatus } from "@/db/queries/tasks"
import {
  listSubmissionsByTask,
  createSubmission,
  findLatestSubmissionByTaskAndUser,
} from "@/db/queries/submissions"
import { createSubmissionSchema } from "@/lib/validation"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"
import { loadUserBadge } from "@/lib/gateway"
import { BADGE_NFT, AGENT_BADGE_NFT } from "@/lib/config"
import { agentLaneGate } from "@/lib/agent-lane"
import { emitNotification } from "@/lib/notifications"
import { chainWriteGate } from "@/lib/chain-halt-gate"

const submitLimiter = createRateLimiter({ windowMs: 60_000, max: 5 })

export const GET = withAuth(async (_req, { params, user }) => {
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

  const submissions = await listSubmissionsByTask(taskId)

  // Only task creator or submitters can view
  const isCreator = task.creatorId === user.userId
  const isSubmitter = submissions.some((s) => s.submitterId === user.userId)
  if (!isCreator && !isSubmitter) {
    return NextResponse.json(
      { ok: false, error: { code: "FORBIDDEN", message: "Not authorized to view submissions" } },
      { status: 403 },
    )
  }

  return NextResponse.json({ ok: true, data: submissions })
})

export const POST = withAuth(async (req, { params, user }) => {
  // Agent-lane kill switch (AGENT_LANE_LIVE=false → 503) — server-enforced,
  // first check so nothing downstream (badge lookups, DB writes) runs while
  // the lane is off. See src/lib/agent-lane.ts for scope and rationale.
  const laneOff = agentLaneGate()
  if (laneOff) return laneOff

  // Then the halt gate: a work record's counterpart is an on-chain claim carrying a
  // bond, which cannot be signed while the chain is stopped. Lane-off is checked first
  // because it is a local decision and needs no Gateway read. See chain-halt-gate.ts.
  const halted = await chainWriteGate()
  if (halted) return halted

  const limit = submitLimiter(user.userId)
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

  // open/assigned accept first attempts. A `submitted` task accepts exactly
  // one more case: the worker resubmitting after the poster requested a
  // revision — each attempt is a NEW row (decision audit trail), and the
  // caller's OWN latest-row status is the ownership gate (escrow tasks also
  // carry assigneeId — enforced below — but the off-chain lane never sets it:
  // those tasks go open → submitted on first submit). On-chain state is
  // untouched: the task stays WorkSubmitted through the whole revision loop
  // (no on-chain resubmit method exists); content iterates in the DB and the
  // poster approves on-chain when satisfied.
  const isRevisionResubmit =
    task.status === "submitted" &&
    (task.assigneeId == null || task.assigneeId === user.userId) &&
    (await findLatestSubmissionByTaskAndUser(taskId, user.userId))?.status === "revision_requested"

  if (task.status !== "open" && task.status !== "assigned" && !isRevisionResubmit) {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_STATUS", message: "Task is not accepting submissions" } },
      { status: 400 },
    )
  }

  if (task.creatorId === user.userId) {
    return NextResponse.json(
      { ok: false, error: { code: "SELF_SUBMIT", message: "Cannot submit to your own task" } },
      { status: 403 },
    )
  }

  // Once a task is claimed/assigned, only the assigned worker may submit.
  if (task.assigneeId && task.assigneeId !== user.userId) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_ASSIGNEE", message: "Only the assigned worker can submit to this task" } },
      { status: 403 },
    )
  }

  // Builder gate: the submitter must hold a Guild member badge — or an agent
  // badge (operator-minted, on-chain recallable; dormant until
  // NEXT_PUBLIC_AGENT_BADGE_NFT is set) — resolved server-side and fail-closed:
  // loadUserBadge returns null for no badge OR a gateway error, so neither a
  // missing badge nor a Gateway outage can slip past (and the client-side
  // badge check can't be bypassed).
  const badge =
    (await loadUserBadge(user.userId, BADGE_NFT)) ??
    (AGENT_BADGE_NFT ? await loadUserBadge(user.userId, AGENT_BADGE_NFT) : null)
  if (!badge) {
    return NextResponse.json(
      { ok: false, error: { code: "NO_BADGE", message: "A Guild member or agent badge is required to submit work" } },
      { status: 403 },
    )
  }

  const body = await req.json().catch(() => null)
  if (!body) {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_BODY", message: "Invalid JSON" } },
      { status: 400 },
    )
  }

  const parsed = createSubmissionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
      { status: 400 },
    )
  }

  const submission = await createSubmission({
    taskId,
    submitterId: user.userId,
    content: parsed.data.content,
  })

  // Update task status to "submitted" when work is submitted — OFF-CHAIN tasks
  // only. Once a task is escrow-funded (onChainTaskId set), status advances
  // SOLELY via the verified confirm route (WorkSubmittedEvent): the DB
  // submission here is just the content the on-chain submit will commit to,
  // and flipping status off it desyncs the DB from chain (the worker hasn't
  // burned their claim receipt yet, so on-chain the task is still Claimed).
  // The flip is compare-and-swap on open/assigned so it can't stomp a status
  // that moved between our snapshot and this write (a resubmit on `submitted`
  // simply matches 0 rows — nothing to flip).
  if (task.onChainTaskId == null && (task.status === "open" || task.status === "assigned")) {
    await updateTaskIfStatus(taskId, { status: "submitted" }, ["open", "assigned"])
  }

  // Tell the poster work landed — today the only way they'd know is by
  // revisiting the page. This is the ONE site that fires for both on-chain
  // and off-chain tasks (the escrow-confirm "submit" kind is a pure status
  // sync with no content of its own — see escrow-confirm.ts), so hooking it
  // here instead avoids double-notifying an on-chain task. After the write,
  // never inside it (see src/lib/notifications.ts's module doc).
  await emitNotification({
    recipientId: task.creatorId,
    event: "work_submitted",
    taskId: task.id,
    payload: { taskTitle: task.title, submissionId: submission.id, actorId: user.userId },
  })

  return NextResponse.json({ ok: true, data: submission }, { status: 201 })
})
