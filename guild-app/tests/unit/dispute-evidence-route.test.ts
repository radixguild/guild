/**
 * POST /api/v1/tasks/[id]/dispute-evidence — the statement must come from the
 * party who RAISED the dispute, and must open the hash the dispute transaction
 * committed (api-sec-01, 2026-10-06).
 *
 * Before this, either party could file, the write was once-only, and nothing
 * compared the text with the chain: the non-raising party could file first,
 * have their prose shown as the raiser's on-chain-committed statement, and
 * lock the raiser's real one out with ALREADY_FILED.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { disputeEvidenceHash, normalizeDisputeEvidence } from "@/lib/dispute-evidence"

const POSTER = "account_rdx1poster"
const WORKER = "account_rdx1worker"
const DISPUTE_TX = "txid_rdx1dispute"
const STATEMENT = "The delivered build does not start.\r\n"

const H = vi.hoisted(() => ({ caller: "" }))
vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: H.caller } }),
}))
vi.mock("@/lib/chain-halt-gate", () => ({ chainWriteGate: async () => null }))
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

const M = vi.hoisted(() => ({
  findTaskById: vi.fn(),
  updateTask: vi.fn(),
  findEscrowByTask: vi.fn(),
  readDisputeEvidenceCommitment: vi.fn(),
}))
vi.mock("@/db/queries/tasks", () => ({ findTaskById: M.findTaskById, updateTask: M.updateTask }))
vi.mock("@/db/queries/escrow", () => ({ findEscrowByTask: M.findEscrowByTask }))
vi.mock("@/lib/gateway", () => ({ readDisputeEvidenceCommitment: M.readDisputeEvidenceCommitment }))

import { POST } from "@/app/api/v1/tasks/[id]/dispute-evidence/route"

const ctx = { params: Promise.resolve({ id: "5" }) } as never
const req = (evidence: unknown = STATEMENT) => ({ json: async () => ({ evidence }) }) as never

let COMMITTED = ""

async function post(caller: string, evidence?: unknown) {
  H.caller = caller
  const res = await POST(req(evidence), ctx)
  return { status: res.status, body: await res.json() }
}

describe("POST /tasks/[id]/dispute-evidence — checked against the dispute transaction", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    COMMITTED = await disputeEvidenceHash(normalizeDisputeEvidence(STATEMENT))
    M.findTaskById.mockResolvedValue({
      id: 5,
      creatorId: POSTER,
      assigneeId: WORKER,
      status: "disputed",
      onChainTaskId: 12,
      escrowComponent: "component_rdx1stored",
      disputeEvidence: null,
      disputeEvidenceHash: null,
    })
    M.findEscrowByTask.mockResolvedValue([
      { txType: "fund", txHash: "txid_rdx1fund" },
      { txType: "dispute", txHash: DISPUTE_TX },
    ])
    // The worker raised it, committing the statement's hash.
    M.readDisputeEvidenceCommitment.mockResolvedValue({ raisedBy: "Worker", evidenceHash: COMMITTED })
    M.updateTask.mockImplementation(async (_id: number, patch: object) => ({ id: 5, ...patch }))
  })

  it("the raiser filing the statement they committed → 200, stored with the server's own hash", async () => {
    const { status, body } = await post(WORKER)
    expect(status).toBe(200)
    expect(M.readDisputeEvidenceCommitment).toHaveBeenCalledWith(DISPUTE_TX, "component_rdx1stored", 12)
    expect(M.updateTask).toHaveBeenCalledWith(5, {
      disputeEvidence: normalizeDisputeEvidence(STATEMENT),
      disputeEvidenceHash: COMMITTED,
    })
    expect(body.data.evidenceHash).toBe(COMMITTED)
  })

  it("the NON-raising party filing first → 403 NOT_RAISER, nothing stored", async () => {
    const { status, body } = await post(POSTER)
    expect(status).toBe(403)
    expect(body.error.code).toBe("NOT_RAISER")
    expect(M.updateTask).not.toHaveBeenCalled()
  })

  it("a poster-raised dispute: the worker is refused, the poster accepted", async () => {
    M.readDisputeEvidenceCommitment.mockResolvedValue({ raisedBy: "Poster", evidenceHash: COMMITTED })
    expect((await post(WORKER)).status).toBe(403)
    expect(M.updateTask).not.toHaveBeenCalled()
    expect((await post(POSTER)).status).toBe(200)
  })

  it("the raiser filing text that does not open the committed hash → 409 EVIDENCE_HASH_MISMATCH, nothing stored", async () => {
    const { status, body } = await post(WORKER, "A different account of events.")
    expect(status).toBe(409)
    expect(body.error.code).toBe("EVIDENCE_HASH_MISMATCH")
    expect(M.updateTask).not.toHaveBeenCalled()
  })

  it("a dispute raised with NO statement hash → 409 NO_COMMITMENT: no prose can be attached as if committed", async () => {
    M.readDisputeEvidenceCommitment.mockResolvedValue({ raisedBy: "Worker", evidenceHash: null })
    const { status, body } = await post(WORKER)
    expect(status).toBe(409)
    expect(body.error.code).toBe("NO_COMMITMENT")
    expect(M.updateTask).not.toHaveBeenCalled()
  })

  it("an unreadable dispute transaction → 503, fail closed: nothing stored", async () => {
    M.readDisputeEvidenceCommitment.mockResolvedValue(null)
    const { status, body } = await post(WORKER)
    expect(status).toBe(503)
    expect(body.error.code).toBe("CHAIN_UNREADABLE")
    expect(M.updateTask).not.toHaveBeenCalled()
  })

  it("no dispute ledger row to check against → 409 NO_DISPUTE_RECORD, no chain read, nothing stored", async () => {
    M.findEscrowByTask.mockResolvedValue([{ txType: "fund", txHash: "txid_rdx1fund" }])
    const { status, body } = await post(WORKER)
    expect(status).toBe(409)
    expect(body.error.code).toBe("NO_DISPUTE_RECORD")
    expect(M.readDisputeEvidenceCommitment).not.toHaveBeenCalled()
    expect(M.updateTask).not.toHaveBeenCalled()
  })

  it("a second file → 409 ALREADY_FILED (write-once is unchanged)", async () => {
    M.findTaskById.mockResolvedValue({
      id: 5, creatorId: POSTER, assigneeId: WORKER, status: "disputed", onChainTaskId: 12,
      escrowComponent: null, disputeEvidence: "already", disputeEvidenceHash: COMMITTED,
    })
    const { status, body } = await post(WORKER)
    expect(status).toBe(409)
    expect(body.error.code).toBe("ALREADY_FILED")
    expect(M.updateTask).not.toHaveBeenCalled()
  })

  it("a third party is still refused before any chain read (403 FORBIDDEN)", async () => {
    const { status, body } = await post("account_rdx1stranger")
    expect(status).toBe(403)
    expect(body.error.code).toBe("FORBIDDEN")
    expect(M.readDisputeEvidenceCommitment).not.toHaveBeenCalled()
  })
})
