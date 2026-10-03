/**
 * Authz regression test for the escrow confirm endpoint
 * (POST /api/v1/tasks/[id]/escrow).
 *
 * Pins the claim-authz fix: a TaskClaimedEvent proves a task was claimed in a
 * tx but NOT by whom (it carries claimer_badge_id, no account). So the handler
 * must reject a caller who does not hold the claim receipt for the task — else
 * any authed user could replay someone else's real claim tx and seize the DB
 * assignee slot. On-chain funds stay safe (the receipt gates submit/payout);
 * this guards the off-chain assignee.
 *
 * Also pins confirm atomicity: every multi-write kind (create, approve,
 * dispute, resolve) must run its status update + ledger write on ONE
 * db.transaction — the TX sentinel below flows through both calls or the
 * assertions fail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// withAuth normally reads + verifies the JWT cookie; inject a fixed caller.
vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: "account_rdx1caller" } }),
}))

// The route wraps each multi-write confirm kind in db.transaction. Hand the
// callback a recognizable sentinel so tests can assert the task update and the
// ledger write ran on the SAME transaction handle.
const { mockDbTransaction } = vi.hoisted(() => ({ mockDbTransaction: vi.fn() }))
vi.mock("@/db", () => ({ db: { transaction: mockDbTransaction } }))
const TX = { sentinel: "db-tx" }

const { mockFindTaskById, mockUpdateTask, mockUpdateTaskIfStatus, mockCaptureEscrowIdIfUnset } = vi.hoisted(() => ({
  mockFindTaskById: vi.fn(),
  mockUpdateTask: vi.fn(),
  mockUpdateTaskIfStatus: vi.fn(),
  mockCaptureEscrowIdIfUnset: vi.fn(),
}))
vi.mock("@/db/queries/tasks", () => ({
  findTaskById: mockFindTaskById,
  updateTask: mockUpdateTask,
  updateTaskIfStatus: mockUpdateTaskIfStatus,
  captureEscrowIdIfUnset: mockCaptureEscrowIdIfUnset,
}))

const { mockVerifyEscrowEvent, mockReadOnChainClaimInfo, mockHoldsClaimReceipt, mockReadEscrowTaskCreated, mockReadDisputeRaised, mockReadDisputeAutoResolved } = vi.hoisted(() => ({
  mockVerifyEscrowEvent: vi.fn(),
  mockReadOnChainClaimInfo: vi.fn(),
  mockHoldsClaimReceipt: vi.fn(),
  mockReadEscrowTaskCreated: vi.fn(),
  mockReadDisputeRaised: vi.fn(),
  mockReadDisputeAutoResolved: vi.fn(),
}))
vi.mock("@/lib/gateway", () => ({
  verifyEscrowEvent: mockVerifyEscrowEvent,
  readOnChainClaimInfo: mockReadOnChainClaimInfo,
  holdsClaimReceipt: mockHoldsClaimReceipt,
  readEscrowTaskCreated: mockReadEscrowTaskCreated,
  readDisputeRaised: mockReadDisputeRaised,
  readDisputeAutoResolved: mockReadDisputeAutoResolved,
}))

const { mockRecordConfirmedEscrowTx, mockFindEscrowByTask } = vi.hoisted(() => ({
  mockRecordConfirmedEscrowTx: vi.fn(),
  mockFindEscrowByTask: vi.fn(),
}))
// The per-account limiter is module state, so ~37 same-user calls in one file
// would exhaust it and 429 the later tests. Same no-op mock as
// submissions-route.test.ts. That the route is wired to a limiter at all is
// pinned by tests/unit/money-path-rate-limit-gate.test.ts, not here.
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

vi.mock("@/db/queries/escrow", () => ({
  recordConfirmedEscrowTx: mockRecordConfirmedEscrowTx,
  findEscrowByTask: mockFindEscrowByTask,
}))

// Import AFTER mocks are registered. @/lib/config is unmocked — the create
// branch pins the row to the real ESCROW_COMPONENT it verified against.
import { POST } from "@/app/api/v1/tasks/[id]/escrow/route"
import { ESCROW_COMPONENT, ESCROW_CLAIM_RECEIPT_RESOURCE } from "@/lib/config"
import { XRD_ADDRESS } from "@/lib/radix"

const makeReq = (body: unknown) => ({ json: async () => body }) as never
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never

// Consensus timestamp the mocked DisputeRaisedEvent read carries — dispute
// confirms persist it as tasks.disputedAt (the on-chain dispute time).
const DISPUTED_AT = new Date("2026-06-10T22:46:48Z")

describe("POST /api/v1/tasks/[id]/escrow — confirm + ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // vi.clearAllMocks() wipes implementations — re-bind the tx passthrough.
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(TX))
    mockFindTaskById.mockResolvedValue({
      id: 1,
      onChainTaskId: 42,
      creatorId: "account_rdx1poster",
      status: "open",
    })
    mockVerifyEscrowEvent.mockResolvedValue(true)
    mockReadDisputeRaised.mockResolvedValue({ raisedBy: "Poster", confirmedAt: DISPUTED_AT })
    mockUpdateTask.mockImplementation((_id: number, patch: object) =>
      Promise.resolve({ id: 1, ...patch }),
    )
    // CAS variant: default to the predicate matching (row advanced). A test
    // that exercises the write-time conflict overrides this with null.
    mockUpdateTaskIfStatus.mockImplementation((_id: number, patch: object) =>
      Promise.resolve({ id: 1, ...patch }),
    )
    // create-capture CAS: default to the swap succeeding (row unfunded/same id).
    mockCaptureEscrowIdIfUnset.mockImplementation((id: number, onChainTaskId: number, escrowComponent: string) =>
      Promise.resolve({ id, onChainTaskId, escrowComponent }),
    )
    mockRecordConfirmedEscrowTx.mockResolvedValue({ id: 99 })
    mockFindEscrowByTask.mockResolvedValue([])
  })

  it("rejects a claim confirm from a caller who does not hold the LIVE claim receipt (403)", async () => {
    // A live claim exists (receipt #7) — but this caller doesn't hold it.
    mockReadOnChainClaimInfo.mockResolvedValue({
      state: "Claimed", workerAccount: "account_rdx1realworker", currentClaimReceiptId: 7,
    })
    mockHoldsClaimReceipt.mockResolvedValue(false)

    const res = await POST(makeReq({ intentHash: "txid_rdx1abc", kind: "claim" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.error.code).toBe("NOT_CLAIMER")
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled() // assignee must NOT be set
  })

  it("accepts a claim confirm from the actual claimer and records the assignee", async () => {
    mockReadOnChainClaimInfo.mockResolvedValue({
      state: "Claimed", workerAccount: "account_rdx1caller", currentClaimReceiptId: 7,
    })
    mockHoldsClaimReceipt.mockResolvedValue(true) // caller holds the LIVE receipt

    const res = await POST(makeReq({ intentHash: "txid_rdx1abc", kind: "claim" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    // Holding is checked against the LIVE receipt id read from chain state —
    // an orphan receipt from an expired claim (task_id match) can't pass this.
    // Exact pins: the fixture row has no stored component (config fallback),
    // and the holding check must query the CLAIM RECEIPT resource.
    expect(mockReadOnChainClaimInfo).toHaveBeenCalledWith(42, ESCROW_COMPONENT)
    expect(mockHoldsClaimReceipt).toHaveBeenCalledWith(
      "account_rdx1caller",
      ESCROW_CLAIM_RECEIPT_RESOURCE,
      7,
    )
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(
      1,
      { status: "assigned", assigneeId: "account_rdx1caller" },
      expect.any(Array),
      undefined,
    )
  })

  it("does not gate submit on the claim receipt (status-only sync)", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1, onChainTaskId: 42, creatorId: "account_rdx1poster", status: "assigned",
    })

    const res = await POST(makeReq({ intentHash: "txid_rdx1abc", kind: "submit" }), ctx("1"))

    expect(res.status).toBe(200)
    expect(mockReadOnChainClaimInfo).not.toHaveBeenCalled()
    expect(mockHoldsClaimReceipt).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "submitted" }, expect.any(Array), undefined)
  })

  // ── Lifecycle gate: a verified historical event must never regress the
  // current status (replayed intentHashes are real events — the gate is the
  // only thing standing between them and a terminal-state rollback). ──────────

  it("rejects a replayed submit confirm on a paid task (409, no regression)", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1, onChainTaskId: 42, creatorId: "account_rdx1poster", status: "paid",
    })

    const res = await POST(makeReq({ intentHash: "txid_rdx1abc", kind: "submit" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error.code).toBe("INVALID_STATE")
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  it("rejects a replayed claim confirm on a submitted task (409)", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1, onChainTaskId: 42, creatorId: "account_rdx1poster", status: "submitted",
    })
    // Even the real live-receipt holder can't regress the lifecycle.
    mockReadOnChainClaimInfo.mockResolvedValue({
      state: "Claimed", workerAccount: "account_rdx1caller", currentClaimReceiptId: 7,
    })
    mockHoldsClaimReceipt.mockResolvedValue(true)

    const res = await POST(makeReq({ intentHash: "txid_rdx1abc", kind: "claim" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error.code).toBe("INVALID_STATE")
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  it("rejects an approve confirm on an open task (409)", async () => {
    const res = await POST(makeReq({ intentHash: "txid_rdx1rel", kind: "approve" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error.code).toBe("INVALID_STATE")
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
    expect(mockDbTransaction).not.toHaveBeenCalled() // rejected before any write
  })

  it("accepts an approve retry on an already-paid task (idempotent confirm)", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1, onChainTaskId: 42, creatorId: "account_rdx1poster",
      assigneeId: "account_rdx1worker", status: "paid", rewardXrd: "10",
    })
    mockFindEscrowByTask.mockResolvedValue([
      { id: 1, taskId: 1, txType: "fund", amountXrd: "10.5", status: "confirmed" },
    ])

    const res = await POST(makeReq({ intentHash: "txid_rdx1rel", kind: "approve" }), ctx("1"))

    expect(res.status).toBe(200)
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "paid" }, expect.any(Array), TX)
  })

  it("on create: captures the on-chain task_id and writes the verified fund row", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1,
      onChainTaskId: null,
      creatorId: "account_rdx1caller", // create requires creator === caller
      status: "open",
      rewardXrd: "10.500000000000000000", // numeric(38,18) spelling of the chain's "10.5"
    })
    mockReadEscrowTaskCreated.mockResolvedValue({ taskId: 42, rewardAmount: "10.5", rewardToken: XRD_ADDRESS })

    const res = await POST(makeReq({ intentHash: "txid_rdx1fund", kind: "create" }), ctx("1"))

    expect(res.status).toBe(200)
    // Both writes carry the SAME tx handle from one db.transaction — a crash
    // can't leave the on-chain id captured without its fund row.
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
    // Capture goes through the compare-and-swap (single writer of onChainTaskId).
    expect(mockCaptureEscrowIdIfUnset).toHaveBeenCalledWith(1, 42, ESCROW_COMPONENT, TX)
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      {
        taskId: 1,
        txType: "fund",
        fromUserId: "account_rdx1caller",
        amountXrd: "10.5",
        txHash: "txid_rdx1fund",
      },
      TX,
    )
  })

  it("on create: 409 CONFLICT when the row is already funded with a different on-chain id", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1,
      onChainTaskId: 42, // already funded
      creatorId: "account_rdx1caller",
      status: "open",
      rewardXrd: "10.5",
    })
    mockReadEscrowTaskCreated.mockResolvedValue({ taskId: 43, rewardAmount: "10.5", rewardToken: XRD_ADDRESS }) // a DIFFERENT id
    mockCaptureEscrowIdIfUnset.mockResolvedValue(null) // CAS WHERE misses → conflict

    const res = await POST(makeReq({ intentHash: "txid_rdx1fund2", kind: "create" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error.code).toBe("CONFLICT")
    // The verified event does NOT get to overwrite the id, and the paired fund
    // ledger write is rolled back with the thrown conflict.
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })

  // Was "falls back to the task reward when the on-chain amount is unparseable".
  // That fallback linked a row as funded without knowing what was escrowed —
  // the gap the 2026-09-23 funding audit closed (src/lib/funded-reward.ts).
  it("on create: 422 FUNDED_REWARD_UNREADABLE when the on-chain amount is unparseable — nothing linked", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1,
      onChainTaskId: null,
      creatorId: "account_rdx1caller",
      status: "open",
      rewardXrd: "7.25",
    })
    mockReadEscrowTaskCreated.mockResolvedValue({ taskId: 42, rewardAmount: null, rewardToken: XRD_ADDRESS })

    const res = await POST(makeReq({ intentHash: "txid_rdx1fund", kind: "create" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.error.code).toBe("FUNDED_REWARD_UNREADABLE")
    expect(mockCaptureEscrowIdIfUnset).not.toHaveBeenCalled()
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })

  // 409, not 422: clients retry a 422 as commit lag, and a mismatch never clears.
  it("on create: 409 FUNDED_REWARD_MISMATCH when the tx escrowed a different reward than the task advertises", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1,
      onChainTaskId: null,
      creatorId: "account_rdx1caller",
      status: "open",
      rewardXrd: "6400.000000000000000000",
    })
    mockReadEscrowTaskCreated.mockResolvedValue({ taskId: 6, rewardAmount: "1", rewardToken: XRD_ADDRESS })

    const res = await POST(makeReq({ intentHash: "txid_rdx1fund", kind: "create" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error.code).toBe("FUNDED_REWARD_MISMATCH")
    expect(json.error.message).toContain("advertises 6400 XRD but the escrow holds 1 XRD")
    expect(mockDbTransaction).not.toHaveBeenCalled()
    expect(mockCaptureEscrowIdIfUnset).not.toHaveBeenCalled()
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })

  it("on approve: writes the release row to the assignee and advances to paid", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1,
      onChainTaskId: 42,
      creatorId: "account_rdx1poster",
      assigneeId: "account_rdx1worker",
      status: "submitted",
      rewardXrd: "10",
    })
    mockFindEscrowByTask.mockResolvedValue([
      { id: 1, taskId: 1, txType: "fund", amountXrd: "10.5", status: "confirmed" },
    ])

    const res = await POST(makeReq({ intentHash: "txid_rdx1rel", kind: "approve" }), ctx("1"))

    expect(res.status).toBe(200)
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      {
        taskId: 1,
        txType: "release",
        fromUserId: "account_rdx1poster",
        toUserId: "account_rdx1worker",
        amountXrd: "10.5",
        txHash: "txid_rdx1rel",
      },
      TX,
    )
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "paid" }, expect.any(Array), TX)
  })

  it("rejects a dispute confirm from a non-party (403)", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1, onChainTaskId: 42, creatorId: "account_rdx1poster",
      assigneeId: "account_rdx1worker", status: "submitted",
    })

    const res = await POST(makeReq({ intentHash: "txid_rdx1dis", kind: "dispute" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.error.code).toBe("FORBIDDEN")
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  it("accepts a dispute confirm from the poster and sets status=disputed", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1, onChainTaskId: 42, creatorId: "account_rdx1caller", status: "submitted",
    })

    const res = await POST(makeReq({ intentHash: "txid_rdx1dis", kind: "dispute" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(mockReadDisputeRaised).toHaveBeenCalledWith("txid_rdx1dis", expect.any(String), 42)
    // disputedAt = the dispute tx's consensus timestamp, persisted so window
    // countdowns stop approximating the dispute time with updatedAt.
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(
      1, { status: "disputed", disputedAt: DISPUTED_AT }, expect.any(Array), TX,
    )
  })

  it("on dispute: records the 0-amount dispute marker row (txHash carries DisputeRaisedEvent)", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1, onChainTaskId: 42, creatorId: "account_rdx1caller", status: "submitted",
    })

    const res = await POST(makeReq({ intentHash: "txid_rdx1dis", kind: "dispute" }), ctx("1"))

    expect(res.status).toBe(200)
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      {
        taskId: 1,
        txType: "dispute",
        fromUserId: "account_rdx1caller",
        amountXrd: "0",
        txHash: "txid_rdx1dis",
      },
      TX,
    )
  })

  it("accepts a dispute confirm from the worker (assignee)", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1, onChainTaskId: 42, creatorId: "account_rdx1poster",
      assigneeId: "account_rdx1caller", status: "submitted",
    })

    const res = await POST(makeReq({ intentHash: "txid_rdx1dis", kind: "dispute" }), ctx("1"))

    expect(res.status).toBe(200)
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(
      1, { status: "disputed", disputedAt: DISPUTED_AT }, expect.any(Array), TX,
    )
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      expect.objectContaining({ txType: "dispute", fromUserId: "account_rdx1caller", amountXrd: "0" }),
      TX,
    )
  })

  it("rejects a dispute when the on-chain DisputeRaisedEvent is not verified (422)", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1, onChainTaskId: 42, creatorId: "account_rdx1caller", status: "submitted",
    })
    mockReadDisputeRaised.mockResolvedValue(null)

    const res = await POST(makeReq({ intentHash: "txid_rdx1dis", kind: "dispute" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.error.code).toBe("EVENT_NOT_VERIFIED")
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })

  it("rejects a dispute on a non-submitted task (409)", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1, onChainTaskId: 42, creatorId: "account_rdx1caller", status: "paid",
    })

    const res = await POST(makeReq({ intentHash: "txid_rdx1dis", kind: "dispute" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error.code).toBe("INVALID_STATE")
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  // ── resolve — the dispute settled on-chain via the public, time-gated
  // auto_resolve_dispute. No party check (the verified event is the gate);
  // ledger rows are written from the VERIFIED event amounts. ─────────────────

  const disputedTask = {
    id: 1,
    onChainTaskId: 42,
    creatorId: "account_rdx1poster",
    assigneeId: "account_rdx1worker",
    status: "disputed",
    rewardXrd: "10",
  }

  it("rejects a resolve confirm on a non-disputed task (409)", async () => {
    mockFindTaskById.mockResolvedValue({ ...disputedTask, status: "submitted" })

    const res = await POST(makeReq({ intentHash: "txid_rdx1res", kind: "resolve" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error.code).toBe("INVALID_STATE")
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })

  it("rejects a resolve when the DisputeAutoResolvedEvent is not verified (422)", async () => {
    mockFindTaskById.mockResolvedValue(disputedTask)
    mockReadDisputeAutoResolved.mockResolvedValue(null)

    const res = await POST(makeReq({ intentHash: "txid_rdx1res", kind: "resolve" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.error.code).toBe("EVENT_NOT_VERIFIED")
    expect(mockReadDisputeAutoResolved).toHaveBeenCalledWith("txid_rdx1res", expect.any(String), 42)
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })

  it("worker-favoured resolve: writes a release row from the VERIFIED amount and sets status=paid", async () => {
    mockFindTaskById.mockResolvedValue(disputedTask)
    mockReadDisputeAutoResolved.mockResolvedValue({ workerAmount: "11.025", posterAmount: "0" })

    const res = await POST(makeReq({ intentHash: "txid_rdx1res", kind: "resolve" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledTimes(1)
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      {
        taskId: 1,
        txType: "release",
        fromUserId: "account_rdx1poster",
        toUserId: "account_rdx1worker",
        amountXrd: "11.025", // exact event decimal, passed through untouched
        txHash: "txid_rdx1res",
      },
      TX,
    )
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "paid" }, expect.any(Array), TX)
  })

  it("poster-favoured resolve: writes a refund row (to the poster) and sets status=refunded", async () => {
    mockFindTaskById.mockResolvedValue(disputedTask)
    mockReadDisputeAutoResolved.mockResolvedValue({ workerAmount: "0", posterAmount: "11.025" })

    const res = await POST(makeReq({ intentHash: "txid_rdx1res", kind: "resolve" }), ctx("1"))

    expect(res.status).toBe(200)
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledTimes(1)
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      {
        taskId: 1,
        txType: "refund",
        fromUserId: "account_rdx1poster",
        toUserId: "account_rdx1poster",
        amountXrd: "11.025",
        txHash: "txid_rdx1res",
      },
      TX,
    )
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "refunded" }, expect.any(Array), TX)
  })

  it("future Split ruling: writes BOTH ledger legs and treats a paid worker as paid", async () => {
    mockFindTaskById.mockResolvedValue(disputedTask)
    mockReadDisputeAutoResolved.mockResolvedValue({ workerAmount: "5.5125", posterAmount: "5.5125" })

    const res = await POST(makeReq({ intentHash: "txid_rdx1res", kind: "resolve" }), ctx("1"))

    expect(res.status).toBe(200)
    // Both settlement legs + the status flip share ONE transaction.
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledTimes(2)
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      expect.objectContaining({ txType: "release", amountXrd: "5.5125" }),
      TX,
    )
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      expect.objectContaining({ txType: "refund", amountXrd: "5.5125" }),
      TX,
    )
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "paid" }, expect.any(Array), TX)
  })

  it("accepts a resolve retry on an already-refunded task (200, idempotent)", async () => {
    mockFindTaskById.mockResolvedValue({ ...disputedTask, status: "refunded" })
    mockReadDisputeAutoResolved.mockResolvedValue({ workerAmount: "0", posterAmount: "11.025" })

    const res = await POST(makeReq({ intentHash: "txid_rdx1res", kind: "resolve" }), ctx("1"))

    expect(res.status).toBe(200)
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "refunded" }, expect.any(Array), TX)
  })

  it("allows a NON-party caller to confirm a resolve (public keeper call)", async () => {
    // caller is account_rdx1caller — neither poster nor worker of disputedTask
    mockFindTaskById.mockResolvedValue(disputedTask)
    mockReadDisputeAutoResolved.mockResolvedValue({ workerAmount: "11.025", posterAmount: "0" })

    const res = await POST(makeReq({ intentHash: "txid_rdx1res", kind: "resolve" }), ctx("1"))

    expect(res.status).toBe(200)
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "paid" }, expect.any(Array), TX)
  })

  // ── cancel — the poster cancelled on-chain. Open tasks emit
  // TaskCancelledEvent (cancel_task); claimed-not-submitted tasks emit
  // TaskCancelledAfterClaimEvent (cancel_task_by_poster_after_claim — the
  // worker's bond goes back to the worker via the manifest, so the ledger
  // records only the poster's reward+insurance refund). Either event confirms;
  // poster-only; refund row + status=cancelled. ───────────────────────────────

  const openTask = {
    id: 1,
    onChainTaskId: 42,
    creatorId: "account_rdx1caller", // cancel requires creator === caller
    status: "open",
    rewardXrd: "10",
  }

  it("rejects a cancel confirm from a non-creator (403)", async () => {
    mockFindTaskById.mockResolvedValue({ ...openTask, creatorId: "account_rdx1poster" })

    const res = await POST(makeReq({ intentHash: "txid_rdx1can", kind: "cancel" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.error.code).toBe("FORBIDDEN")
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })

  it("rejects a cancel confirm on a submitted task (409 — past the point of no cancel)", async () => {
    mockFindTaskById.mockResolvedValue({ ...openTask, status: "submitted" })

    const res = await POST(makeReq({ intentHash: "txid_rdx1can", kind: "cancel" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error.code).toBe("INVALID_STATE")
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })

  it("rejects a cancel confirm on a paid task (409, no terminal-state rollback)", async () => {
    mockFindTaskById.mockResolvedValue({ ...openTask, status: "paid" })

    const res = await POST(makeReq({ intentHash: "txid_rdx1can", kind: "cancel" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error.code).toBe("INVALID_STATE")
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  it("open cancel: verifies TaskCancelledEvent, writes the poster refund row, sets status=cancelled", async () => {
    mockFindTaskById.mockResolvedValue(openTask)
    mockVerifyEscrowEvent.mockImplementation((_hash, eventName) =>
      Promise.resolve(eventName === "TaskCancelledEvent"),
    )
    mockFindEscrowByTask.mockResolvedValue([
      { id: 1, taskId: 1, txType: "fund", amountXrd: "10.5", status: "confirmed" },
    ])

    const res = await POST(makeReq({ intentHash: "txid_rdx1can", kind: "cancel" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(mockVerifyEscrowEvent).toHaveBeenCalledWith(
      "txid_rdx1can", "TaskCancelledEvent", expect.any(String), 42,
    )
    // Refund row + status flip share ONE transaction (same TX handle).
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      {
        taskId: 1,
        txType: "refund",
        fromUserId: "account_rdx1caller",
        toUserId: "account_rdx1caller",
        amountXrd: "10.5", // the verified fund row's amount, not the task reward
        txHash: "txid_rdx1can",
      },
      TX,
    )
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "cancelled" }, expect.any(Array), TX)
  })

  it("after-claim cancel: accepts the TaskCancelledAfterClaimEvent variant on an assigned task", async () => {
    mockFindTaskById.mockResolvedValue({
      ...openTask, status: "assigned", assigneeId: "account_rdx1worker",
    })
    // cancel_task_by_poster_after_claim emits the after-claim event only.
    mockVerifyEscrowEvent.mockImplementation((_hash, eventName) =>
      Promise.resolve(eventName === "TaskCancelledAfterClaimEvent"),
    )

    const res = await POST(makeReq({ intentHash: "txid_rdx1can", kind: "cancel" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(mockVerifyEscrowEvent).toHaveBeenCalledWith(
      "txid_rdx1can", "TaskCancelledAfterClaimEvent", expect.any(String), 42,
    )
    // The worker's bond never hits the ledger (their own collateral, returned
    // by the manifest) — only the poster's refund is recorded.
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledTimes(1)
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      expect.objectContaining({
        txType: "refund",
        fromUserId: "account_rdx1caller",
        toUserId: "account_rdx1caller",
      }),
      TX,
    )
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "cancelled" }, expect.any(Array), TX)
  })

  it("falls back to the task reward when no fund row exists", async () => {
    mockFindTaskById.mockResolvedValue(openTask)
    mockFindEscrowByTask.mockResolvedValue([])

    await POST(makeReq({ intentHash: "txid_rdx1can", kind: "cancel" }), ctx("1"))

    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      expect.objectContaining({ txType: "refund", amountXrd: "10" }),
      TX,
    )
  })

  it("rejects a cancel when neither cancel event verifies (422)", async () => {
    mockFindTaskById.mockResolvedValue(openTask)
    mockVerifyEscrowEvent.mockResolvedValue(false)

    const res = await POST(makeReq({ intentHash: "txid_rdx1can", kind: "cancel" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.error.code).toBe("EVENT_NOT_VERIFIED")
    // Both event names were tried before failing closed.
    expect(mockVerifyEscrowEvent).toHaveBeenCalledWith(
      "txid_rdx1can", "TaskCancelledEvent", expect.any(String), 42,
    )
    expect(mockVerifyEscrowEvent).toHaveBeenCalledWith(
      "txid_rdx1can", "TaskCancelledAfterClaimEvent", expect.any(String), 42,
    )
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })

  it("accepts a cancel retry on an already-cancelled task (200, idempotent)", async () => {
    mockFindTaskById.mockResolvedValue({ ...openTask, status: "cancelled" })

    const res = await POST(makeReq({ intentHash: "txid_rdx1can", kind: "cancel" }), ctx("1"))

    expect(res.status).toBe(200)
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "cancelled" }, expect.any(Array), TX)
  })
})

// ── Agent-lane kill switch (AGENT_LANE_LIVE — 2026-07-31 triage) ─────────────
// The switch is server-enforced here, on the WORKER-side lane kinds only.
// Poster-side kinds (create/approve/dispute/resolve/cancel) must stay open so
// the operator can wind the board down during an incident. Default (env
// unset) = lane LIVE — the fleet worker's current path must be unchanged.
describe("POST /api/v1/tasks/[id]/escrow — agent-lane kill switch", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(TX))
    mockFindTaskById.mockResolvedValue({
      id: 1,
      onChainTaskId: 42,
      creatorId: "account_rdx1poster",
      status: "open",
    })
    mockVerifyEscrowEvent.mockResolvedValue(true)
    mockUpdateTask.mockImplementation((_id: number, patch: object) =>
      Promise.resolve({ id: 1, ...patch }),
    )
    mockUpdateTaskIfStatus.mockImplementation((_id: number, patch: object) =>
      Promise.resolve({ id: 1, ...patch }),
    )
    mockRecordConfirmedEscrowTx.mockResolvedValue({ id: 99 })
    mockFindEscrowByTask.mockResolvedValue([])
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each(["claim", "submit"] as const)(
    "503s a %s confirm when AGENT_LANE_LIVE=false — before any DB or gateway work",
    async (kind) => {
      vi.stubEnv("AGENT_LANE_LIVE", "false")

      const res = await POST(makeReq({ intentHash: "txid_rdx1off", kind }), ctx("1"))
      const json = await res.json()

      expect(res.status).toBe(503)
      expect(json.error.code).toBe("AGENT_LANE_OFF")
      // The gate short-circuits ahead of the task load and the confirm core.
      expect(mockFindTaskById).not.toHaveBeenCalled()
      expect(mockVerifyEscrowEvent).not.toHaveBeenCalled()
      expect(mockUpdateTask).not.toHaveBeenCalled()
      expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
    },
  )

  it("leaves poster-side kinds open while the lane is off (cancel reaches the confirm core)", async () => {
    vi.stubEnv("AGENT_LANE_LIVE", "false")
    mockFindTaskById.mockResolvedValue({
      id: 1,
      onChainTaskId: 42,
      creatorId: "account_rdx1caller", // cancel requires creator === caller
      status: "cancelled", // idempotent retry — 200 without event plumbing
    })

    const res = await POST(makeReq({ intentHash: "txid_rdx1can", kind: "cancel" }), ctx("1"))

    expect(res.status).toBe(200)
    expect(mockFindTaskById).toHaveBeenCalled()
  })

  it("claim confirms proceed by DEFAULT (env unset — live behavior preserved)", async () => {
    mockReadOnChainClaimInfo.mockResolvedValue({
      state: "Claimed",
      workerAccount: "account_rdx1caller",
      currentClaimReceiptId: 7,
    })
    mockHoldsClaimReceipt.mockResolvedValue(true)

    const res = await POST(makeReq({ intentHash: "txid_rdx1abc", kind: "claim" }), ctx("1"))

    expect(res.status).toBe(200)
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(
      1,
      { status: "assigned", assigneeId: "account_rdx1caller" },
      expect.any(Array),
      undefined,
    )
  })

  it("only the literal string \"false\" disarms the lane (\"0\" and \"\" stay live)", async () => {
    vi.stubEnv("AGENT_LANE_LIVE", "0")
    mockReadOnChainClaimInfo.mockResolvedValue({
      state: "Claimed",
      workerAccount: "account_rdx1caller",
      currentClaimReceiptId: 7,
    })
    mockHoldsClaimReceipt.mockResolvedValue(true)

    const res = await POST(makeReq({ intentHash: "txid_rdx1abc", kind: "claim" }), ctx("1"))

    expect(res.status).toBe(200)
  })
})
