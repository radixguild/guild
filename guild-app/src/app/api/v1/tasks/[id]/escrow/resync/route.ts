import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { findTaskById } from "@/db/queries/tasks"
import { resyncTaskFromChain } from "@/lib/escrow-resync"
import { fromError } from "@/lib/api-response"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"

// POST /api/v1/tasks/[id]/escrow/resync — self-service "resync from chain".
//
// Walks the task's on-chain lifecycle from its funding tx and replays every
// event the DB is missing through the shared confirm core (applyEscrowConfirm)
// — reconciler actor for chain-grounded kinds, the caller's own session for
// claim (the core requires their on-chain claim receipt, fail-closed). Any
// authed user may trigger it: it can only move the DB TOWARD chain truth, the
// same trust basis as the public on-chain `resolve`. Replaces the
// DevTools-console confirm ritual from the mainnet smoke.
//
// Deliberately NOT gated by the agent-lane kill switch (AGENT_LANE_LIVE):
// the chain stays public regardless of that flag, so blocking resync would
// not stop an on-chain claim — it would only blind the DB to it and turn the
// drift watcher into a siren. Healing stays open; see src/lib/agent-lane.ts.
//
// Gateway-heavy (streams the component's tx history), so per-user limited.
const resyncLimiter = createRateLimiter({ windowMs: 60_000, max: 3 })

export const POST = withAuth(async (_req, { params, user }) => {
  try {
    const limit = resyncLimiter(user.userId)
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

    const result = await resyncTaskFromChain(task, user.userId)
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: { code: result.code, message: result.message } },
        { status: result.httpStatus },
      )
    }
    return NextResponse.json({
      ok: true,
      data: {
        task: result.task,
        applied: result.applied,
        pending: result.pending,
        reflected: result.reflected,
      },
    })
  } catch (err) {
    return fromError(err)
  }
})
