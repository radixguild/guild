import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { findTaskById } from "@/db/queries/tasks"
import { applyEscrowConfirm, ROUTE_KINDS, type RouteConfirmKind } from "@/lib/escrow-confirm"
import { fromError } from "@/lib/api-response"
import { agentLaneGate } from "@/lib/agent-lane"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"

// POST /api/v1/tasks/[id]/escrow — confirm an escrow lifecycle tx + sync DB.
// Body: { intentHash: string, kind: "create" | "claim" | "submit" | "approve"
//         | "dispute" | "resolve" | "cancel" }.
//
// Thin HTTP shell: parses/validates the request, loads the task, then hands
// off to applyEscrowConfirm (src/lib/escrow-confirm.ts) with a `user` actor —
// the shared transition core that verifies the matching on-chain event and
// performs the atomic status+ledger writes. The escrow reconciler
// (scripts/reconcile-escrow.mjs) drives the same core with a `reconciler`
// actor; per-kind semantics, authz and the ALLOWED_FROM lifecycle gate are
// documented there.
// Every accepted call verifies the matching on-chain event, so each one costs
// a Gateway round trip. 30/min per account is well above any real lifecycle
// pace (task creation itself is capped at 5/min) and bounds what a single
// authenticated session can spend of the Gateway budget.
const confirmLimiter = createRateLimiter({ windowMs: 60_000, max: 30 })

export const POST = withAuth(async (req, { params, user }) => {
  try {
    const limit = confirmLimiter(user.userId)
    if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

    const { id } = await params
    const taskId = parseInt(id)
    if (isNaN(taskId)) {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_ID", message: "Invalid task ID" } },
        { status: 400 },
      )
    }

    const body = await req.json().catch(() => null)
    const intentHash: unknown = body?.intentHash
    const kind: unknown = body?.kind
    if (typeof intentHash !== "string" || !/^txid_(rdx|tdx)/.test(intentHash)) {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_BODY", message: "Valid intentHash required" } },
        { status: 400 },
      )
    }
    // ROUTE_KINDS, not KINDS: `expire` is a real confirm kind the core handles,
    // but it is reachable only via resync (expire_claim is public on-chain, so
    // no confirming party is meaningful here). See ROUTE_KINDS.
    if (typeof kind !== "string" || !ROUTE_KINDS.includes(kind as RouteConfirmKind)) {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_BODY", message: `kind must be ${ROUTE_KINDS.join("|")}` } },
        { status: 400 },
      )
    }

    // Agent-lane kill switch (AGENT_LANE_LIVE=false → 503) — WORKER-side lane
    // kinds only. Poster-side kinds (create/approve/dispute/resolve/cancel)
    // stay open so the operator can wind the board down during an incident;
    // blocking approve would strand already-submitted work. Scope and
    // rationale in src/lib/agent-lane.ts.
    if (kind === "claim" || kind === "submit") {
      const laneOff = agentLaneGate()
      if (laneOff) return laneOff
    }

    const task = await findTaskById(taskId)
    if (!task) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "Task not found" } },
        { status: 404 },
      )
    }

    const result = await applyEscrowConfirm(task, kind as RouteConfirmKind, intentHash, {
      kind: "user",
      userId: user.userId,
    })
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: { code: result.code, message: result.message } },
        { status: result.httpStatus },
      )
    }
    return NextResponse.json({ ok: true, data: result.task })
  } catch (err) {
    return fromError(err)
  }
})
