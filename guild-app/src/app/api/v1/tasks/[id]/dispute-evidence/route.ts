import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { findTaskById, updateTask } from "@/db/queries/tasks"
import { fromError } from "@/lib/api-response"
import { chainWriteGate } from "@/lib/chain-halt-gate"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"
import {
  DISPUTE_EVIDENCE_MAX_CHARS,
  checkDisputeEvidence,
  disputeEvidenceHash,
  normalizeDisputeEvidence,
} from "@/lib/dispute-evidence"

// POST /api/v1/tasks/[id]/dispute-evidence — store the raiser's statement.
// Body: { evidence: string }.
//
// WHY THIS IS ITS OWN ROUTE AND NOT PART OF THE ESCROW CONFIRM. The confirm
// route is a thin shell over applyEscrowConfirm, the shared transition core
// that both the UI and the reconciler drive, and that carries the ALLOWED_FROM
// lifecycle gate and the atomic status+ledger writes. Threading a free-text
// field through it would put user prose inside the money path's most carefully
// guarded function for no benefit: this write moves no funds, advances no
// status, and has no on-chain event of its own. It is deliberately a separate,
// narrow, failure-tolerant call — if it fails, the dispute still stands and the
// only loss is that the statement was not recorded.
//
// The chain does not depend on this succeeding, and the UI must not pretend
// otherwise: the commitment went on-chain with the dispute transaction. This
// route stores the preimage so the commitment can be OPENED later.
// Disputes are rare and this endpoint persists operator-readable free text,
// so it matches the submission limiter rather than the looser confirm one.
const evidenceLimiter = createRateLimiter({ windowMs: 60_000, max: 5 })

export const POST = withAuth(async (req, { params, user }) => {
  const limit = evidenceLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  // A dispute is resolved on-chain by the arbiter. See src/lib/chain-halt-gate.ts.
  const halted = await chainWriteGate()
  if (halted) return halted

  try {
    const { id } = await params
    const taskId = parseInt(id)
    if (isNaN(taskId)) {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_ID", message: "Invalid task ID" } },
        { status: 400 },
      )
    }

    const body = await req.json().catch(() => null)
    const evidence: unknown = body?.evidence
    if (typeof evidence !== "string") {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_BODY", message: "evidence must be a string" } },
        { status: 400 },
      )
    }
    const problem = checkDisputeEvidence(evidence)
    if (problem === "empty") {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_BODY", message: "evidence must not be empty" } },
        { status: 400 },
      )
    }
    if (problem === "too_long") {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "INVALID_BODY",
            message: `evidence must be at most ${DISPUTE_EVIDENCE_MAX_CHARS} characters`,
          },
        },
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

    // Only the two parties. The blueprint already authorises raise_dispute off
    // a Task Receipt or the claimer's badge, so a third party cannot have
    // raised the dispute this statement belongs to — but the DB has no such
    // proof in hand, and an unauthenticated statement attached to someone
    // else's dispute would be worse than none.
    if (user.userId !== task.creatorId && user.userId !== task.assigneeId) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: "FORBIDDEN", message: "Only the task poster or worker can file evidence" },
        },
        { status: 403 },
      )
    }

    // The statement only means anything against a live dispute. Accepting one
    // on a settled or never-disputed task would let a party attach prose to a
    // task with no on-chain commitment to check it against.
    if (task.status !== "disputed") {
      return NextResponse.json(
        {
          ok: false,
          error: { code: "INVALID_STATE", message: "Task is not disputed" },
        },
        { status: 409 },
      )
    }

    // WRITE-ONCE. The hash went on-chain when the dispute was raised and cannot
    // change; letting the plaintext be replaced afterwards would leave a stored
    // statement that no longer opens the on-chain commitment, while still
    // rendering as if it did. An overwrite is refused, not silently ignored, so
    // a client bug surfaces instead of losing someone's statement.
    if (task.disputeEvidence !== null) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "ALREADY_FILED",
            message: "Evidence for this dispute has already been filed and cannot be replaced",
          },
        },
        { status: 409 },
      )
    }

    // Hashed HERE, server-side, from the same normalised preimage the client
    // committed. Trusting a client-supplied hash would defeat the point — the
    // stored pair has to be one we computed ourselves for it to be worth
    // checking against the ledger.
    const normalized = normalizeDisputeEvidence(evidence)
    const hash = await disputeEvidenceHash(normalized)

    const updated = await updateTask(taskId, {
      disputeEvidence: normalized,
      disputeEvidenceHash: hash,
    })

    return NextResponse.json({
      ok: true,
      data: { evidence: updated.disputeEvidence, evidenceHash: updated.disputeEvidenceHash },
    })
  } catch (err) {
    return fromError(err)
  }
})
