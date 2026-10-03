/**
 * Unit tests for the escrow confirm core (src/lib/escrow-confirm.ts) — the
 * transition engine shared by the confirm route (actor = user) and the
 * reconciler (actor = reconciler, scripts/reconcile-escrow.mjs).
 *
 * Pins the actor split:
 *   • reconciler skips caller-authz (it mirrors what the chain proves, not
 *     what a caller asserts) but is still bound by the ALLOWED_FROM lifecycle
 *     gate (409) and on-chain event verification (422) — both fail closed.
 *   • user actors behave exactly as the route always did (the route's own
 *     regression net is tests/unit/escrow-route.test.ts; one representative
 *     kind is re-pinned here at the core seam).
 *   • create/claim are NOT reconcilable: create has no DB linkage without the
 *     poster's intent; claim's assignee comes from the caller's claim receipt
 *     (the event only carries claimer_badge_id) → NOT_RECONCILABLE.
 *
 * Mocks sit at the same seams as the route tests: @/db (transaction),
 * @/db/queries/{tasks,escrow}, @/lib/gateway.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// The core wraps each multi-write confirm kind in db.transaction. Hand the
// callback a recognizable sentinel so tests can assert the task update and the
// ledger write ran on the SAME transaction handle.
const { mockDbTransaction } = vi.hoisted(() => ({ mockDbTransaction: vi.fn() }))
vi.mock("@/db", () => ({ db: { transaction: mockDbTransaction } }))
const TX = { sentinel: "db-tx" }

const { mockUpdateTask, mockUpdateTaskIfStatus, mockCaptureEscrowIdIfUnset } = vi.hoisted(() => ({
  mockUpdateTask: vi.fn(),
  mockUpdateTaskIfStatus: vi.fn(),
  mockCaptureEscrowIdIfUnset: vi.fn(),
}))
vi.mock("@/db/queries/tasks", () => ({
  updateTask: mockUpdateTask,
  updateTaskIfStatus: mockUpdateTaskIfStatus,
  captureEscrowIdIfUnset: mockCaptureEscrowIdIfUnset,
}))

const {
  mockVerifyEscrowEvent,
  mockReadOnChainClaimInfo,
  mockHoldsClaimReceipt,
  mockReadEscrowTaskCreated,
  mockReadDisputeRaised,
  mockReadDisputeAutoResolved,
} = vi.hoisted(() => ({
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
vi.mock("@/db/queries/escrow", () => ({
  recordConfirmedEscrowTx: mockRecordConfirmedEscrowTx,
  findEscrowByTask: mockFindEscrowByTask,
}))

const { mockAwardTaskCompletion } = vi.hoisted(() => ({ mockAwardTaskCompletion: vi.fn() }))
vi.mock("@/db/queries/users", () => ({ awardTaskCompletion: mockAwardTaskCompletion }))

// Import AFTER mocks are registered. @/lib/config is NOT mocked — the create
// branch pins the row to the real ESCROW_COMPONENT the event was verified
// against, so assert against that same constant.
import { applyEscrowConfirm, classifyEscrowEvent, ALLOWED_FROM, REFLECTED_IN, KINDS, ROUTE_KINDS, type EscrowActor } from "@/lib/escrow-confirm"
import { EVENT_TO_KIND } from "@/lib/escrow-resync"
import { ESCROW_COMPONENT, ESCROW_CLAIM_RECEIPT_RESOURCE } from "@/lib/config"
import { XRD_ADDRESS } from "@/lib/radix"

const RECONCILER: EscrowActor = { kind: "reconciler" }
const asUser = (userId: string): EscrowActor => ({ kind: "user", userId })

// Minimal task rows — the core only touches id/status/creatorId/assigneeId/
// onChainTaskId/rewardXrd/xpReward. Cast through never like the route tests do.
const task = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 1,
    onChainTaskId: 42,
    creatorId: "account_rdx1poster",
    assigneeId: null,
    status: "open",
    rewardXrd: "10",
    xpReward: 0,
    ...overrides,
  }) as never

describe("applyEscrowConfirm — reconciler actor", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(TX))
    mockVerifyEscrowEvent.mockResolvedValue(true)
    mockUpdateTask.mockImplementation((_id: number, patch: object) =>
      Promise.resolve({ id: 1, ...patch }),
    )
    mockUpdateTaskIfStatus.mockImplementation((_id: number, patch: object) =>
      Promise.resolve({ id: 1, ...patch }),
    )
    mockRecordConfirmedEscrowTx.mockResolvedValue({ row: { id: 99 }, inserted: true })
    mockFindEscrowByTask.mockResolvedValue([])
  })

  it("skips caller-authz on cancel: heals with no caller identity at all", async () => {
    mockFindEscrowByTask.mockResolvedValue([
      { id: 1, taskId: 1, txType: "fund", amountXrd: "10.5", status: "confirmed" },
    ])

    const result = await applyEscrowConfirm(task(), "cancel", "txid_rdx1can", RECONCILER)

    expect(result.ok).toBe(true)
    // Chain verification still ran — the reconciler trusts events, not callers.
    expect(mockVerifyEscrowEvent).toHaveBeenCalledWith(
      "txid_rdx1can", "TaskCancelledEvent", expect.any(String), 42,
    )
    // Refund row attributes to the task's recorded poster (never to a caller),
    // atomically with the status flip (same TX handle).
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      {
        taskId: 1,
        txType: "refund",
        fromUserId: "account_rdx1poster",
        toUserId: "account_rdx1poster",
        amountXrd: "10.5",
        txHash: "txid_rdx1can",
      },
      TX,
    )
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "cancelled" }, ALLOWED_FROM.cancel, TX)
  })

  it("skips caller-authz on submit and advances assigned → submitted", async () => {
    const result = await applyEscrowConfirm(
      task({ status: "assigned", assigneeId: "account_rdx1worker" }),
      "submit",
      "txid_rdx1sub",
      RECONCILER,
    )

    expect(result.ok).toBe(true)
    expect(mockVerifyEscrowEvent).toHaveBeenCalledWith(
      "txid_rdx1sub", "WorkSubmittedEvent", expect.any(String), 42,
    )
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "submitted" }, ALLOWED_FROM.submit, undefined)
  })

  it("still 409s on a lifecycle violation (no terminal-state regression)", async () => {
    const result = await applyEscrowConfirm(
      task({ status: "paid", assigneeId: "account_rdx1worker" }),
      "submit",
      "txid_rdx1sub",
      RECONCILER,
    )

    expect(result).toEqual({
      ok: false,
      code: "INVALID_STATE",
      httpStatus: 409,
      message: "Cannot confirm 'submit' on a 'paid' task",
    })
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })

  it("still 409s NOT_FUNDED when the on-chain task id was never captured", async () => {
    const result = await applyEscrowConfirm(
      task({ onChainTaskId: null, status: "assigned" }),
      "submit",
      "txid_rdx1sub",
      RECONCILER,
    )

    expect(result).toMatchObject({ ok: false, code: "NOT_FUNDED", httpStatus: 409 })
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  it("still 422s when the on-chain event does not verify (fail closed)", async () => {
    mockVerifyEscrowEvent.mockResolvedValue(false)

    const result = await applyEscrowConfirm(
      task({ status: "assigned" }),
      "submit",
      "txid_rdx1sub",
      RECONCILER,
    )

    expect(result).toMatchObject({ ok: false, code: "EVENT_NOT_VERIFIED", httpStatus: 422 })
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })

  it("returns NOT_RECONCILABLE for claim WITHOUT a resolved assignee", async () => {
    const result = await applyEscrowConfirm(task(), "claim", "txid_rdx1clm", RECONCILER)

    expect(result).toMatchObject({ ok: false, code: "NOT_RECONCILABLE" })
    // Bounced before any chain read or write — nothing to verify, nothing to heal.
    expect(mockVerifyEscrowEvent).not.toHaveBeenCalled()
    expect(mockReadOnChainClaimInfo).not.toHaveBeenCalled()
    expect(mockHoldsClaimReceipt).not.toHaveBeenCalled()
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  it("heals claim WITH a reconciler-resolved assignee (event still verified, no receipt read)", async () => {
    const result = await applyEscrowConfirm(
      task({ status: "open" }),
      "claim",
      "txid_rdx1clm",
      { kind: "reconciler", resolvedAssignee: "account_rdx1worker" },
    )

    expect(result).toMatchObject({ ok: true })
    // The TaskClaimedEvent is still verified — the reconciler trusts the chain,
    // not the caller. The claim RECEIPT is a user-actor proof, never read here.
    expect(mockVerifyEscrowEvent).toHaveBeenCalledWith(
      "txid_rdx1clm", "TaskClaimedEvent", expect.any(String), 42,
    )
    expect(mockReadOnChainClaimInfo).not.toHaveBeenCalled()
    expect(mockHoldsClaimReceipt).not.toHaveBeenCalled()
    // Assignee comes from the resolved account, gated by ALLOWED_FROM.claim.
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(
      1,
      { status: "assigned", assigneeId: "account_rdx1worker" },
      ALLOWED_FROM.claim,
      undefined,
    )
  })

  it("refuses to heal claim on a task already past 'assigned', even with a resolved assignee", async () => {
    // A paid task with a lost claim confirm is a pre-existing lost-attribution
    // row: the lifecycle gate must NOT let the reconciler backfill an assignee
    // by regressing state. Rejected before any chain read or write.
    const result = await applyEscrowConfirm(
      task({ status: "paid" }),
      "claim",
      "txid_rdx1clm",
      { kind: "reconciler", resolvedAssignee: "account_rdx1worker" },
    )

    expect(result).toMatchObject({ ok: false, code: "INVALID_STATE", httpStatus: 409 })
    expect(mockVerifyEscrowEvent).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  it("fails closed (422) on an unverified TaskClaimedEvent, even with a resolved assignee", async () => {
    // The resolved assignee must NOT let an unverified/replayed claim tx write an
    // assignee — the on-chain event proof still gates the money-path write.
    mockVerifyEscrowEvent.mockResolvedValue(false)
    const result = await applyEscrowConfirm(
      task({ status: "open" }),
      "claim",
      "txid_rdx1clm",
      { kind: "reconciler", resolvedAssignee: "account_rdx1worker" },
    )

    expect(result).toMatchObject({ ok: false, code: "EVENT_NOT_VERIFIED", httpStatus: 422 })
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  it("heals claim from status 'assigned' (assignee backfilled under the ALLOWED_FROM.claim gate)", async () => {
    // The "stuck past open" case: an expired-then-reclaimed task can sit at
    // 'assigned' with a null assignee; classifyEscrowEvent marks it healable and
    // ALLOWED_FROM.claim includes 'assigned', so the heal must still write.
    const result = await applyEscrowConfirm(
      task({ status: "assigned", assigneeId: null }),
      "claim",
      "txid_rdx1clm",
      { kind: "reconciler", resolvedAssignee: "account_rdx1worker" },
    )

    expect(result).toMatchObject({ ok: true })
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(
      1,
      { status: "assigned", assigneeId: "account_rdx1worker" },
      ALLOWED_FROM.claim,
      undefined,
    )
  })

  it("returns CONFLICT when a concurrent transition wins the claim heal (CAS matched 0 rows)", async () => {
    mockUpdateTaskIfStatus.mockResolvedValue(null) // the write-time ALLOWED_FROM gate matched nothing
    const result = await applyEscrowConfirm(
      task({ status: "open" }),
      "claim",
      "txid_rdx1clm",
      { kind: "reconciler", resolvedAssignee: "account_rdx1worker" },
    )

    expect(result).toMatchObject({ ok: false, code: "CONFLICT", httpStatus: 409 })
  })

  it("returns NOT_RECONCILABLE for create (no DB linkage without the poster's intent)", async () => {
    const result = await applyEscrowConfirm(
      task({ onChainTaskId: null }),
      "create",
      "txid_rdx1fund",
      RECONCILER,
    )

    expect(result).toMatchObject({ ok: false, code: "NOT_RECONCILABLE" })
    expect(mockReadEscrowTaskCreated).not.toHaveBeenCalled()
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })

  it("on dispute: attributes the marker row from the chain's raised_by, not a caller", async () => {
    const confirmedAt = new Date("2026-06-10T22:46:48Z")
    mockReadDisputeRaised.mockResolvedValue({ raisedBy: "Worker", confirmedAt })

    const result = await applyEscrowConfirm(
      task({ status: "submitted", assigneeId: "account_rdx1worker" }),
      "dispute",
      "txid_rdx1dis",
      RECONCILER,
    )

    expect(result.ok).toBe(true)
    expect(mockReadDisputeRaised).toHaveBeenCalledWith("txid_rdx1dis", expect.any(String), 42)
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      {
        taskId: 1,
        txType: "dispute",
        fromUserId: "account_rdx1worker", // raised_by = Worker → the assignee
        amountXrd: "0",
        txHash: "txid_rdx1dis",
      },
      TX,
    )
    // disputedAt = the tx's consensus timestamp — exact even when the
    // reconciler heals this dispute long after it committed on-chain.
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(
      1,
      { status: "disputed", disputedAt: confirmedAt },
      ALLOWED_FROM.dispute,
      TX,
    )
  })

  it("on dispute: falls back to confirm-time when the tx timestamp is unreadable", async () => {
    mockReadDisputeRaised.mockResolvedValue({ raisedBy: "Worker", confirmedAt: null })
    const before = Date.now()

    const result = await applyEscrowConfirm(
      task({ status: "submitted", assigneeId: "account_rdx1worker" }),
      "dispute",
      "txid_rdx1dis",
      RECONCILER,
    )

    expect(result.ok).toBe(true)
    const patch = mockUpdateTaskIfStatus.mock.calls[0][1] as { disputedAt: Date }
    // Late (>= now) is the safe direction: a window that opens a moment after
    // the chain's is harmless; one that opens early invites a rejected tx.
    expect(patch.disputedAt).toBeInstanceOf(Date)
    expect(patch.disputedAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(patch.disputedAt.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it("on dispute: 422s when the DisputeRaisedEvent cannot be read from the tx", async () => {
    mockReadDisputeRaised.mockResolvedValue(null)

    const result = await applyEscrowConfirm(
      task({ status: "submitted", assigneeId: "account_rdx1worker" }),
      "dispute",
      "txid_rdx1dis",
      RECONCILER,
    )

    expect(result).toMatchObject({ ok: false, code: "EVENT_NOT_VERIFIED", httpStatus: 422 })
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })
})

describe("applyEscrowConfirm — user actor (unchanged route semantics)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(TX))
    mockVerifyEscrowEvent.mockResolvedValue(true)
    mockUpdateTask.mockImplementation((_id: number, patch: object) =>
      Promise.resolve({ id: 1, ...patch }),
    )
    mockUpdateTaskIfStatus.mockImplementation((_id: number, patch: object) =>
      Promise.resolve({ id: 1, ...patch }),
    )
    mockRecordConfirmedEscrowTx.mockResolvedValue({ row: { id: 99 }, inserted: true })
    mockFindEscrowByTask.mockResolvedValue([])
  })

  it("rejects a cancel confirm from a non-creator (403 FORBIDDEN)", async () => {
    const result = await applyEscrowConfirm(
      task(), // creator = account_rdx1poster
      "cancel",
      "txid_rdx1can",
      asUser("account_rdx1stranger"),
    )

    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN", httpStatus: 403 })
    expect(mockVerifyEscrowEvent).not.toHaveBeenCalled() // authz first, like the route
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })

  it("accepts a cancel confirm from the creator (refund row + cancelled, one tx)", async () => {
    const result = await applyEscrowConfirm(
      task(),
      "cancel",
      "txid_rdx1can",
      asUser("account_rdx1poster"),
    )

    expect(result.ok).toBe(true)
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      expect.objectContaining({ txType: "refund", fromUserId: "account_rdx1poster" }),
      TX,
    )
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "cancelled" }, ALLOWED_FROM.cancel, TX)
  })

  it("on dispute: attributes the marker row to the calling party (not the chain)", async () => {
    const confirmedAt = new Date("2026-06-10T22:46:48Z")
    mockReadDisputeRaised.mockResolvedValue({ raisedBy: "Poster", confirmedAt })

    const result = await applyEscrowConfirm(
      task({ status: "submitted", assigneeId: "account_rdx1worker" }),
      "dispute",
      "txid_rdx1dis",
      asUser("account_rdx1worker"),
    )

    expect(result.ok).toBe(true)
    // Both actor paths verify via readDisputeRaised now (same emitter +
    // task_id pin as verifyEscrowEvent, plus it carries the tx's consensus
    // timestamp for disputedAt). Attribution stays caller-based for users:
    // the marker row credits the caller even though the event said Poster.
    expect(mockReadDisputeRaised).toHaveBeenCalledWith("txid_rdx1dis", expect.any(String), 42)
    expect(mockVerifyEscrowEvent).not.toHaveBeenCalled()
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      expect.objectContaining({ txType: "dispute", fromUserId: "account_rdx1worker" }),
      TX,
    )
    // The persisted dispute time comes from the chain, never the caller.
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(
      1,
      { status: "disputed", disputedAt: confirmedAt },
      ALLOWED_FROM.dispute,
      TX,
    )
  })

  it("refuses a self-claim before touching the Gateway (403 SELF_CLAIM)", async () => {
    // The blueprint asserts worker != poster (lib.rs's `claim_task` self-claim gate), so this can only ever
    // land as a CommittedFailure — but nothing app-side said so, and the UI
    // offered the poster a Claim button. Mirrors the existing 403 SELF_SUBMIT.
    const result = await applyEscrowConfirm(
      task(),
      "claim",
      "txid_rdx1clm",
      asUser("account_rdx1poster"), // === task().creatorId
    )

    expect(result).toMatchObject({ ok: false, code: "SELF_CLAIM", httpStatus: 403 })
    // Cheapest guard first: a pure field comparison must not cost a Gateway read
    // (that lane is rate-limited, and a blip there would mask the real verdict).
    expect(mockReadOnChainClaimInfo).not.toHaveBeenCalled()
    expect(mockHoldsClaimReceipt).not.toHaveBeenCalled()
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  it("does NOT apply the self-claim guard to the reconciler — it must still heal toward chain truth", async () => {
    // If a self-claim ever appears on chain it means the M5 spoof was used
    // (`poster` is a free parameter of create_task, so a decoy address bypasses
    // the blueprint gate). Refusing here would strand a row the reconciler could
    // otherwise heal; recording reality is the correct response.
    const result = await applyEscrowConfirm(
      task(),
      "claim",
      "txid_rdx1clm",
      { kind: "reconciler", resolvedAssignee: "account_rdx1poster" } as never,
    )

    expect(result).toMatchObject({ ok: true })
  })

  it("still gates claim on the caller holding the LIVE claim receipt (403 NOT_CLAIMER)", async () => {
    mockReadOnChainClaimInfo.mockResolvedValue({
      state: "Claimed",
      workerAccount: "account_rdx1realworker",
      currentClaimReceiptId: 9,
    })
    mockHoldsClaimReceipt.mockResolvedValue(false)

    const result = await applyEscrowConfirm(
      task(),
      "claim",
      "txid_rdx1clm",
      asUser("account_rdx1stranger"),
    )

    expect(result).toMatchObject({ ok: false, code: "NOT_CLAIMER", httpStatus: 403 })
    // The holding check is against the LIVE receipt id from chain state —
    // never against whatever task_id-matching receipt the caller happens to hold.
    expect(mockHoldsClaimReceipt).toHaveBeenCalledWith("account_rdx1stranger", expect.any(String), 9)
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  it("accepts a claim confirm from the live receipt holder and binds the assignee", async () => {
    mockReadOnChainClaimInfo.mockResolvedValue({
      state: "Claimed",
      workerAccount: "account_rdx1worker",
      currentClaimReceiptId: 9,
    })
    mockHoldsClaimReceipt.mockResolvedValue(true)

    const result = await applyEscrowConfirm(
      task(),
      "claim",
      "txid_rdx1clm",
      asUser("account_rdx1worker"),
    )

    expect(result).toMatchObject({ ok: true })
    // Exact-argument pins (review 2026-07-17): the row has no stored component,
    // so the live read must fall back to the config global; and the holding
    // check must query the CLAIM RECEIPT resource — a wrong-constant swap
    // (e.g. BADGE_NFT, also exported from config) must not survive.
    expect(mockReadOnChainClaimInfo).toHaveBeenCalledWith(42, ESCROW_COMPONENT)
    expect(mockHoldsClaimReceipt).toHaveBeenCalledWith(
      "account_rdx1worker",
      ESCROW_CLAIM_RECEIPT_RESOURCE,
      9,
    )
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(
      1,
      { status: "assigned", assigneeId: "account_rdx1worker" },
      ALLOWED_FROM.claim,
      undefined,
    )
  })

  it("pins the live-claim read to the row's STORED escrow component, not the config global", async () => {
    // on_chain_task_id collides across component cutovers (PR #197) — reading
    // the CURRENT component's task 42 for a legacy-component row would
    // validate the caller against a STRANGER task's live receipt id.
    mockReadOnChainClaimInfo.mockResolvedValue({
      state: "Claimed",
      workerAccount: "account_rdx1worker",
      currentClaimReceiptId: 9,
    })
    mockHoldsClaimReceipt.mockResolvedValue(true)

    const result = await applyEscrowConfirm(
      task({ escrowComponent: "component_rdx1legacyx" }),
      "claim",
      "txid_rdx1clm",
      asUser("account_rdx1worker"),
    )

    expect(result).toMatchObject({ ok: true })
    expect(mockReadOnChainClaimInfo).toHaveBeenCalledWith(42, "component_rdx1legacyx")
  })

  it("REJECTS the orphan-receipt spoof: an expired claimer's task_id-matching receipt is not the live one", async () => {
    // The stale-receipt hole: expire_claim resets current_claim_receipt_id but
    // does NOT burn the old NFT. After worker B re-claims (live receipt #9),
    // expired worker A still holds orphan receipt #7 whose data.task_id
    // matches — the old finder-based authz would have accepted it. The live
    // check must ask "does A hold #9?" (no) and refuse.
    mockReadOnChainClaimInfo.mockResolvedValue({
      state: "Claimed",
      workerAccount: "account_rdx1workerB",
      currentClaimReceiptId: 9,
    })
    mockHoldsClaimReceipt.mockImplementation(
      async (account: string, _res: string, receiptId: number) =>
        account === "account_rdx1workerB" && receiptId === 9,
    )

    const result = await applyEscrowConfirm(
      task(),
      "claim",
      "txid_rdx1clmA", // A's real, committed claim tx — event verification passes
      asUser("account_rdx1workerA"),
    )

    expect(result).toMatchObject({ ok: false, code: "NOT_CLAIMER", httpStatus: 403 })
    expect(mockHoldsClaimReceipt).toHaveBeenCalledWith("account_rdx1workerA", expect.any(String), 9)
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  it("rejects a user claim confirm when no claim is live on-chain (expired/cancelled — nothing to hold)", async () => {
    mockReadOnChainClaimInfo.mockResolvedValue({
      state: "Open",
      workerAccount: null,
      currentClaimReceiptId: null,
    })

    const result = await applyEscrowConfirm(
      task(),
      "claim",
      "txid_rdx1clm",
      asUser("account_rdx1workerA"),
    )

    expect(result).toMatchObject({ ok: false, code: "NOT_CLAIMER", httpStatus: 403 })
    expect(mockHoldsClaimReceipt).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  it("fails CLOSED but RETRYABLE (422) when the live claim state is unreadable — never a false 403, never an assignee", async () => {
    mockReadOnChainClaimInfo.mockRejectedValue(new Error("Gateway 503"))

    const result = await applyEscrowConfirm(
      task(),
      "claim",
      "txid_rdx1clm",
      asUser("account_rdx1worker"),
    )

    expect(result).toMatchObject({ ok: false, code: "CLAIM_STATE_UNREADABLE", httpStatus: 422 })
    expect(mockHoldsClaimReceipt).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })
})

// ── create confirm — component pinning ───────────────────────────────────────
// The create confirm is the SINGLE writer of tasks.escrow_component: it captures
// the blueprint-assigned on-chain id AND the component that id belongs to,
// atomically, so later lookups can disambiguate the id from a collision-numbered
// task on another escrow component (old→vNext §8b cutover).
describe("applyEscrowConfirm — create (component pinning)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(TX))
    mockUpdateTask.mockImplementation((_id: number, patch: object) =>
      Promise.resolve({ id: 1, ...patch }),
    )
    mockUpdateTaskIfStatus.mockImplementation((_id: number, patch: object) =>
      Promise.resolve({ id: 1, ...patch }),
    )
    // CAS capture: default to the swap succeeding (row unfunded or same id).
    mockCaptureEscrowIdIfUnset.mockImplementation((id: number, onChainTaskId: number, escrowComponent: string) =>
      Promise.resolve({ id, onChainTaskId, escrowComponent }),
    )
    mockRecordConfirmedEscrowTx.mockResolvedValue({ row: { id: 99 }, inserted: true })
    // Escrows exactly what task() advertises ("10" XRD) — the chain's spelling.
    mockReadEscrowTaskCreated.mockResolvedValue({
      taskId: 7,
      rewardAmount: "10",
      rewardToken: XRD_ADDRESS,
      insuranceAmount: "1",
    })
  })

  it("captures onChainTaskId AND escrowComponent in one transaction (CAS on unset)", async () => {
    const result = await applyEscrowConfirm(
      task({ onChainTaskId: null }),
      "create",
      "txid_rdx1fund",
      asUser("account_rdx1poster"),
    )

    expect(result.ok).toBe(true)
    // Verified against the deployed component…
    expect(mockReadEscrowTaskCreated).toHaveBeenCalledWith("txid_rdx1fund", ESCROW_COMPONENT)
    // …and pinned onto the row via the compare-and-swap (single writer of
    // onChainTaskId), on the same tx handle as the fund ledger write.
    expect(mockCaptureEscrowIdIfUnset).toHaveBeenCalledWith(1, 7, ESCROW_COMPONENT, TX)
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 1, txType: "fund", txHash: "txid_rdx1fund" }),
      TX,
    )
  })

  it("409 CONFLICT when a second create carries a DIFFERENT on-chain id (no overwrite)", async () => {
    // The row is already funded with a different id; the CAS WHERE misses.
    mockCaptureEscrowIdIfUnset.mockResolvedValue(null)

    const result = await applyEscrowConfirm(
      task({ onChainTaskId: 42 }), // already funded (id 42); this event carries 7
      "create",
      "txid_rdx1fund2",
      asUser("account_rdx1poster"),
    )

    expect(result).toMatchObject({ ok: false, code: "CONFLICT", httpStatus: 409 })
    // The event was verified, but the ledger write must NOT run — the tx that
    // would have paired it is rolled back by the thrown ConfirmStateConflict.
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })

  it("rejects a create confirm from a non-creator before any chain read (403)", async () => {
    const result = await applyEscrowConfirm(
      task({ onChainTaskId: null }),
      "create",
      "txid_rdx1fund",
      asUser("account_rdx1stranger"),
    )

    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN", httpStatus: 403 })
    expect(mockReadEscrowTaskCreated).not.toHaveBeenCalled()
    expect(mockCaptureEscrowIdIfUnset).not.toHaveBeenCalled()
  })
})

// ── create confirm — funding parity (2026-09-23) ─────────────────────────────
// Linking the row is what makes it "funded" (listed under ?funded=true, shown
// claimable), so the reward it ADVERTISES must be the reward the tx ESCROWED.
// Before this, the funded amount was recorded but never compared, and an
// unreadable one fell back to the row's own figure — a 1 XRD create_task could
// be confirmed onto a row advertising 6,400. See src/lib/funded-reward.ts.
describe("applyEscrowConfirm — create (funding parity)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(TX))
    mockCaptureEscrowIdIfUnset.mockImplementation((id: number, onChainTaskId: number, escrowComponent: string) =>
      Promise.resolve({ id, onChainTaskId, escrowComponent }),
    )
    mockRecordConfirmedEscrowTx.mockResolvedValue({ row: { id: 99 }, inserted: true })
  })

  const created = (over: Record<string, unknown> = {}) => ({
    taskId: 6,
    rewardAmount: "6400",
    rewardToken: XRD_ADDRESS,
    insuranceAmount: "320",
    ...over,
  })
  const confirmCreate = (row: Record<string, unknown>) =>
    applyEscrowConfirm(
      task({ onChainTaskId: null, ...row }),
      "create",
      "txid_rdx1fund",
      asUser("account_rdx1poster"),
    )

  it("links a row whose advertised reward equals the escrowed one, across decimal spellings", async () => {
    // numeric(38,18) column spelling vs the chain's Decimal spelling.
    mockReadEscrowTaskCreated.mockResolvedValue(created())
    const result = await confirmCreate({ rewardXrd: "6400.000000000000000000", rewardResource: null })

    expect(result.ok).toBe(true)
    expect(mockCaptureEscrowIdIfUnset).toHaveBeenCalledWith(1, 6, ESCROW_COMPONENT, TX)
    // The ledger records the chain's own amount.
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      expect.objectContaining({ txType: "fund", amountXrd: "6400" }),
      TX,
    )
  })

  it("409 FUNDED_REWARD_MISMATCH when the tx escrowed LESS than the row advertises — nothing linked or written", async () => {
    mockReadEscrowTaskCreated.mockResolvedValue(created({ rewardAmount: "1" }))
    const result = await confirmCreate({ rewardXrd: "6400" })

    expect(result).toMatchObject({ ok: false, code: "FUNDED_REWARD_MISMATCH", httpStatus: 409 })
    expect(result.ok ? "" : result.message).toContain("advertises 6400 XRD but the escrow holds 1 XRD")
    expect(mockDbTransaction).not.toHaveBeenCalled()
    expect(mockCaptureEscrowIdIfUnset).not.toHaveBeenCalled()
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })

  it("refuses a difference at the 18th decimal place (exact compare, never Number())", async () => {
    mockReadEscrowTaskCreated.mockResolvedValue(created({ rewardAmount: "1" }))
    const result = await confirmCreate({ rewardXrd: "1.000000000000000001" })

    expect(result).toMatchObject({ ok: false, code: "FUNDED_REWARD_MISMATCH", httpStatus: 409 })
    expect(mockCaptureEscrowIdIfUnset).not.toHaveBeenCalled()
  })

  it("refuses an over-funded create too — the board must show what is escrowed, not less", async () => {
    mockReadEscrowTaskCreated.mockResolvedValue(created({ rewardAmount: "6400" }))
    const result = await confirmCreate({ rewardXrd: "500" })

    expect(result).toMatchObject({ ok: false, code: "FUNDED_REWARD_MISMATCH", httpStatus: 409 })
    expect(mockCaptureEscrowIdIfUnset).not.toHaveBeenCalled()
  })

  it("refuses a create funded in another token than the row's (NULL reward_resource = XRD)", async () => {
    mockReadEscrowTaskCreated.mockResolvedValue(created({ rewardToken: "resource_rdx1notxrdnotxrdnotxrdnotxrd" }))
    const result = await confirmCreate({ rewardXrd: "6400", rewardResource: null })

    expect(result).toMatchObject({ ok: false, code: "FUNDED_REWARD_MISMATCH", httpStatus: 409 })
    expect(mockCaptureEscrowIdIfUnset).not.toHaveBeenCalled()
  })

  it.each([
    ["amount", { rewardAmount: null }],
    ["token", { rewardToken: null }],
  ])("422 FUNDED_REWARD_UNREADABLE when the event's %s is unreadable — never falls back to the row's figure", async (_what, over) => {
    mockReadEscrowTaskCreated.mockResolvedValue(created(over))
    const result = await confirmCreate({ rewardXrd: "6400" })

    expect(result).toMatchObject({ ok: false, code: "FUNDED_REWARD_UNREADABLE", httpStatus: 422 })
    expect(mockCaptureEscrowIdIfUnset).not.toHaveBeenCalled()
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })
})

// ── Task-completion award (XP / reputation) ──────────────────────────────────
// The payout kinds (approve, worker-favoured resolve) credit the assignee's
// XP/reputation inside the SAME transaction as the release ledger row, keyed
// on that row's first physical insert (recordConfirmedEscrowTx's `inserted`
// flag, backed by the escrow_legacy_task_tx_type_unique index). Pins the
// exactly-once-across-replays invariant the leaderboard depends on — before
// this, no on-chain settlement ever incremented users.xp/reputation and
// /api/v1/users/leaderboard stayed empty with real paid tasks in the DB.
describe("applyEscrowConfirm — task-completion award", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(TX))
    mockVerifyEscrowEvent.mockResolvedValue(true)
    mockUpdateTask.mockImplementation((_id: number, patch: object) =>
      Promise.resolve({ id: 1, ...patch }),
    )
    mockUpdateTaskIfStatus.mockImplementation((_id: number, patch: object) =>
      Promise.resolve({ id: 1, ...patch }),
    )
    mockRecordConfirmedEscrowTx.mockResolvedValue({ row: { id: 99 }, inserted: true })
    mockFindEscrowByTask.mockResolvedValue([
      { id: 1, taskId: 1, txType: "fund", amountXrd: "10.5", status: "confirmed" },
    ])
    mockAwardTaskCompletion.mockResolvedValue({ id: "account_rdx1worker" })
  })

  const submitted = (overrides: Record<string, unknown> = {}) =>
    task({ status: "submitted", assigneeId: "account_rdx1worker", xpReward: 25, ...overrides })

  it("approve: awards the assignee once, in the release transaction, from task.xpReward", async () => {
    const result = await applyEscrowConfirm(submitted(), "approve", "txid_rdx1rel", RECONCILER)

    expect(result.ok).toBe(true)
    expect(mockAwardTaskCompletion).toHaveBeenCalledTimes(1)
    // Awarded to the task's assignee, on the SAME tx handle as the ledger
    // write + status flip. reputation 20 = the existing engine's points for
    // the medium tier (rewardXrd "10"), never poster-set.
    expect(mockAwardTaskCompletion).toHaveBeenCalledWith(
      "account_rdx1worker",
      { xp: 25, reputation: 20 },
      TX,
    )
  })

  it("approve: awards exactly once across replayed confirms (inserted=false on replay)", async () => {
    // First confirm physically inserts the (taskId, 'release') row…
    mockRecordConfirmedEscrowTx
      .mockResolvedValueOnce({ row: { id: 99 }, inserted: true })
      // …the replay (approve allowed from 'paid' as a retry) finds it existing.
      .mockResolvedValue({ row: { id: 99 }, inserted: false })

    const first = await applyEscrowConfirm(submitted(), "approve", "txid_rdx1rel", RECONCILER)
    const replay = await applyEscrowConfirm(
      submitted({ status: "paid" }),
      "approve",
      "txid_rdx1rel",
      RECONCILER,
    )

    expect(first.ok).toBe(true)
    expect(replay.ok).toBe(true)
    // The replayed confirm still no-ops the ledger and re-flips status, but
    // the award fired only with the first insert.
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledTimes(2)
    expect(mockAwardTaskCompletion).toHaveBeenCalledTimes(1)
  })

  it("approve: no award when the task has no assignee (release still recorded)", async () => {
    const result = await applyEscrowConfirm(
      submitted({ assigneeId: null }),
      "approve",
      "txid_rdx1rel",
      RECONCILER,
    )

    expect(result.ok).toBe(true)
    // The chain-verified release is still mirrored (unattributed, warned)…
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      expect.objectContaining({ txType: "release", toUserId: null }),
      TX,
    )
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "paid" }, ALLOWED_FROM.approve, TX)
    // …but there is nobody to credit.
    expect(mockAwardTaskCompletion).not.toHaveBeenCalled()
  })

  it("approve: falls back to the reward-tier XP when xpReward is the unpopulated 0 default", async () => {
    // Tasks created before the route derived xp_reward all carry 0 — the
    // award must not be +0 or the leaderboard stays empty for them.
    const result = await applyEscrowConfirm(
      submitted({ xpReward: 0, rewardXrd: "75" }),
      "approve",
      "txid_rdx1rel",
      RECONCILER,
    )

    expect(result.ok).toBe(true)
    // 75 XRD → hard tier: xp 50, completion points 40.
    expect(mockAwardTaskCompletion).toHaveBeenCalledWith(
      "account_rdx1worker",
      { xp: 50, reputation: 40 },
      TX,
    )
  })

  it("resolve (worker-favoured): awards the assignee once with the release leg", async () => {
    mockReadDisputeAutoResolved.mockResolvedValue({ workerAmount: "10.5", posterAmount: "0" })

    const result = await applyEscrowConfirm(
      submitted({ status: "disputed" }),
      "resolve",
      "txid_rdx1res",
      RECONCILER,
    )

    expect(result.ok).toBe(true)
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      expect.objectContaining({ txType: "release", toUserId: "account_rdx1worker" }),
      TX,
    )
    expect(mockAwardTaskCompletion).toHaveBeenCalledTimes(1)
    expect(mockAwardTaskCompletion).toHaveBeenCalledWith(
      "account_rdx1worker",
      { xp: 25, reputation: 20 },
      TX,
    )
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "paid" }, ALLOWED_FROM.resolve, TX)
  })

  it("resolve (poster-favoured): refund only — the worker earns nothing", async () => {
    mockReadDisputeAutoResolved.mockResolvedValue({ workerAmount: "0", posterAmount: "10.5" })

    const result = await applyEscrowConfirm(
      submitted({ status: "disputed" }),
      "resolve",
      "txid_rdx1res",
      RECONCILER,
    )

    expect(result.ok).toBe(true)
    // Only the poster's refund row is written; no release, no award.
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledTimes(1)
    expect(mockRecordConfirmedEscrowTx).toHaveBeenCalledWith(
      expect.objectContaining({ txType: "refund", toUserId: "account_rdx1poster" }),
      TX,
    )
    expect(mockAwardTaskCompletion).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "refunded" }, ALLOWED_FROM.resolve, TX)
  })

  it("resolve (worker-favoured) replay: the existing release row blocks a second award", async () => {
    mockReadDisputeAutoResolved.mockResolvedValue({ workerAmount: "10.5", posterAmount: "0" })
    mockRecordConfirmedEscrowTx.mockResolvedValue({ row: { id: 99 }, inserted: false })

    const result = await applyEscrowConfirm(
      submitted({ status: "paid" }), // resolve allowed from 'paid' as a retry
      "resolve",
      "txid_rdx1res",
      RECONCILER,
    )

    expect(result.ok).toBe(true)
    expect(mockAwardTaskCompletion).not.toHaveBeenCalled()
  })
})

// ── Concurrency: the ALLOWED_FROM gate enforced at write time (CAS) ──────────
// The in-memory gate check can pass for two racing confirms of different kinds
// (e.g. dispute + approve on the same submitted task). The status write carries
// ALLOWED_FROM in its WHERE clause, so exactly one wins the row; the loser's
// update matches 0 rows, its transaction (ledger row included) rolls back, and
// the core reports CONFLICT instead of last-writer-wins stomping the status.
describe("applyEscrowConfirm — write-time status conflict (CAS)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(TX))
    mockVerifyEscrowEvent.mockResolvedValue(true)
    mockUpdateTaskIfStatus.mockResolvedValue(null) // the concurrent transition won the row
    mockRecordConfirmedEscrowTx.mockResolvedValue({ row: { id: 99 }, inserted: true })
    mockFindEscrowByTask.mockResolvedValue([
      { id: 1, taskId: 1, txType: "fund", amountXrd: "10.5", status: "confirmed" },
    ])
    mockAwardTaskCompletion.mockResolvedValue({ id: "account_rdx1worker" })
  })

  it("approve: reports CONFLICT when the row moved after the in-memory gate passed", async () => {
    const result = await applyEscrowConfirm(
      task({ status: "submitted", assigneeId: "account_rdx1worker", xpReward: 25 }),
      "approve",
      "txid_rdx1rel",
      RECONCILER,
    )

    expect(result).toMatchObject({ ok: false, code: "CONFLICT", httpStatus: 409 })
    // The write carried the kind's full lifecycle gate into the WHERE clause.
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "paid" }, ALLOWED_FROM.approve, TX)
  })

  it("submit (bare status sync): CONFLICT surfaces without a transaction wrapper", async () => {
    const result = await applyEscrowConfirm(
      task({ status: "assigned", assigneeId: "account_rdx1worker" }),
      "submit",
      "txid_rdx1sub",
      RECONCILER,
    )

    expect(result).toMatchObject({ ok: false, code: "CONFLICT", httpStatus: 409 })
    expect(mockDbTransaction).not.toHaveBeenCalled()
  })
})

// ── classifyEscrowEvent (pure) — smoke finding 7 ─────────────────────────────
// Claim is keyed on the ASSIGNEE: a task whose lifecycle moved on with
// assigneeId still null had its claim confirm lost (earnings unattributed).
// Status-only classification bucketed exactly that as "superseded" → silently
// skipped by the reconciler; it must classify healable so callers surface it.
describe("classifyEscrowEvent", () => {
  it("claim: reflected when an assignee is recorded, whatever the status", () => {
    expect(classifyEscrowEvent("claim", { status: "assigned", assigneeId: "account_rdx1w" })).toBe("reflected")
    expect(classifyEscrowEvent("claim", { status: "paid", assigneeId: "account_rdx1w" })).toBe("reflected")
  })

  it("claim: healable when the assignee is missing — even past `assigned` (the stuck-claim shape)", () => {
    expect(classifyEscrowEvent("claim", { status: "open", assigneeId: null })).toBe("healable")
    expect(classifyEscrowEvent("claim", { status: "submitted", assigneeId: null })).toBe("healable")
    expect(classifyEscrowEvent("claim", { status: "paid", assigneeId: null })).toBe("healable")
  })

  it("status kinds: reflected / healable / superseded off the lifecycle maps", () => {
    expect(classifyEscrowEvent("submit", { status: "submitted", assigneeId: null })).toBe("reflected")
    expect(classifyEscrowEvent("submit", { status: "assigned", assigneeId: null })).toBe("healable")
    expect(classifyEscrowEvent("submit", { status: "paid", assigneeId: null })).toBe("superseded")
    expect(classifyEscrowEvent("approve", { status: "submitted", assigneeId: null })).toBe("healable")
    expect(classifyEscrowEvent("resolve", { status: "disputed", assigneeId: null })).toBe("healable")
    expect(classifyEscrowEvent("cancel", { status: "open", assigneeId: null })).toBe("healable")
  })
})

/**
 * expire — the recovery leg for a lapsed claim.
 *
 * Before this existed, ClaimExpiredEvent had NO handling anywhere: the confirm
 * route rejected kind='expire', the reconciler didn't heal it, and resync's
 * EVENT_TO_KIND didn't map it. A live expire_claim therefore left the DB row
 * `assigned` to a worker who no longer held the claim on-chain — while the task
 * was Open again and a DIFFERENT worker could claim it.
 *
 * Reconciler-only by design: expire_claim is PUBLIC on-chain, so its sender need
 * not be a party to the task and may hold no session at all. The verified event
 * is the gate, exactly as for `resolve`.
 */
describe("applyEscrowConfirm — expire", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(TX))
    mockVerifyEscrowEvent.mockResolvedValue(true)
    mockUpdateTaskIfStatus.mockImplementation((_id: number, patch: object) =>
      Promise.resolve({ id: 1, ...patch }),
    )
    mockRecordConfirmedEscrowTx.mockResolvedValue({ row: { id: 99 }, inserted: true })
    mockFindEscrowByTask.mockResolvedValue([])
  })

  it("reopens the task and CLEARS the assignee, gated on the verified event", async () => {
    const result = await applyEscrowConfirm(
      task({ status: "assigned", assigneeId: "account_rdx1worker" }),
      "expire",
      "txid_rdx1exp",
      RECONCILER,
    )

    expect(result.ok).toBe(true)
    expect(mockVerifyEscrowEvent).toHaveBeenCalledWith(
      "txid_rdx1exp", "ClaimExpiredEvent", expect.any(String), 42,
    )
    // Clearing the assignee is the whole point — a stale one misattributes the
    // NEXT claimer's work to the worker who walked away.
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(
      1, { status: "open", assigneeId: null }, ALLOWED_FROM.expire, undefined,
    )
  })

  // Reward + insurance stay locked in escrow for the next claimer, and the
  // forfeited bond is the worker's stake, not a settlement leg. A ledger row
  // would also collide on the (taskId, txType) unique index if a task expires
  // twice — which it may, since expiry returns it to Open.
  it("writes NO escrow ledger row", async () => {
    await applyEscrowConfirm(
      task({ status: "assigned", assigneeId: "account_rdx1worker" }),
      "expire",
      "txid_rdx1exp",
      RECONCILER,
    )
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })

  it("refuses a user actor — and reads no chain state before refusing", async () => {
    const result = await applyEscrowConfirm(
      task({ status: "assigned", assigneeId: "account_rdx1worker" }),
      "expire",
      "txid_rdx1exp",
      asUser("account_rdx1poster"),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("NOT_CONFIRMABLE")
      expect(result.httpStatus).toBe(403)
    }
    expect(mockVerifyEscrowEvent).not.toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  it("fails closed (422) when the ClaimExpiredEvent is not in the tx", async () => {
    mockVerifyEscrowEvent.mockResolvedValue(false)

    const result = await applyEscrowConfirm(
      task({ status: "assigned", assigneeId: "account_rdx1worker" }),
      "expire",
      "txid_rdx1notexp",
      RECONCILER,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.httpStatus).toBe(422)
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  // The blueprint requires Claimed to expire, so a submitted task's claim can
  // no longer lapse — a replayed ClaimExpiredEvent must not regress it.
  it("refuses to regress a submitted task (409)", async () => {
    const result = await applyEscrowConfirm(
      task({ status: "submitted", assigneeId: "account_rdx1worker" }),
      "expire",
      "txid_rdx1exp",
      RECONCILER,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.httpStatus).toBe(409)
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  it("is idempotent from open (a re-run of the same heal)", async () => {
    const result = await applyEscrowConfirm(
      task({ status: "open", assigneeId: null }),
      "expire",
      "txid_rdx1exp",
      RECONCILER,
    )
    expect(result.ok).toBe(true)
  })
})

describe("expire is reachable only via resync", () => {
  it("is a real confirm kind, but NOT one the public route accepts", () => {
    expect(KINDS).toContain("expire")
    expect(ROUTE_KINDS).not.toContain("expire")
    // Every other kind stays routable — this narrowing is for expire alone.
    for (const k of KINDS.filter((x) => x !== "expire")) expect(ROUTE_KINDS).toContain(k)
  })

  it("resync maps ClaimExpiredEvent to it — the only way in", () => {
    expect(EVENT_TO_KIND.ClaimExpiredEvent).toBe("expire")
  })

  // Without REFLECTED_IN.expire an already-reopened task classifies healable
  // (ALLOWED_FROM.expire lists "open" for idempotency) and resync re-applies
  // the same confirm on every run, reporting it as newly applied each time.
  it("classifies an already-reopened task as reflected, not healable", () => {
    expect(classifyEscrowEvent("expire", { status: "open", assigneeId: null })).toBe("reflected")
    expect(classifyEscrowEvent("expire", { status: "assigned", assigneeId: "account_rdx1w" })).toBe("healable")
    // Past the point a claim can lapse — stale history, never re-applied.
    expect(classifyEscrowEvent("expire", { status: "paid", assigneeId: "account_rdx1w" })).toBe("superseded")
  })
})

/**
 * The arbiter path — regression pins for the bookkeeping hole found 2026-08-25.
 *
 * `resolve_dispute` (lib.rs) settled disputes on chain and the DB never
 * learned. It emits TaskReleasedEvent or TaskRefundedEvent, plus
 * DisputeResolvedEvent. Nothing read DisputeResolvedEvent, and TaskReleasedEvent
 * maps to kind `approve`, whose ALLOWED_FROM excludes `disputed` — so the ruling
 * classified as `superseded` and the resync counted it as `reflected`. The row
 * stayed `disputed` forever and the resync reported success.
 *
 * The AUTO path (auto_resolve_dispute / DisputeAutoResolvedEvent) always booked
 * correctly. Only the human arbiter — the one manual lever there is — did not.
 */
describe("arbiter ruling is bookkeepable", () => {
  it("maps DisputeResolvedEvent to the arbitrate kind (it was mapped to nothing)", () => {
    expect(EVENT_TO_KIND.DisputeResolvedEvent).toBe("arbitrate")
  })

  it("accepts an arbitrate confirm FROM disputed — the position it is always in", () => {
    expect(ALLOWED_FROM.arbitrate).toContain("disputed")
  })

  it("treats arbitrate and resolve as the same lifecycle positions", () => {
    // Both settle a live dispute; both ledger writes are idempotent on
    // (taskId, txType), so paid/refunded are retries for either route.
    expect([...ALLOWED_FROM.arbitrate].sort()).toEqual([...ALLOWED_FROM.resolve].sort())
  })

  it("does NOT map TaskRefundedEvent — auto-resolve emits it too", () => {
    // lib.rs's `resolve_dispute` (arbiter) AND `auto_resolve_dispute` (auto) both
    // emit it on their Refunded arm. Mapping it to `arbitrate`
    // would make every auto-resolve tx hunt for a DisputeResolvedEvent that is
    // not there and report a spurious blocked event. DisputeResolvedEvent is
    // emitted OUTSIDE the Released/Refunded match (lib.rs's `resolve_dispute`), so it already
    // covers both arbiter outcomes on its own.
    expect(EVENT_TO_KIND.TaskRefundedEvent).toBeUndefined()
  })

  it("still classifies a disputed-state TaskReleasedEvent as superseded", () => {
    // Unchanged and harmless: the same tx also carries DisputeResolvedEvent,
    // which heals the row. This pins that we did NOT widen `approve` to accept
    // `disputed`, which would let an approve-shaped confirm settle a dispute.
    expect(ALLOWED_FROM.approve).not.toContain("disputed")
    // ⚠️ This passed a bare string as `task` until 2026-08-26 —
    // classifyEscrowEvent takes {status, assigneeId}, so `task.status` was
    // undefined and the assertion exercised a task with NO status rather than a
    // disputed one. It was green either way, which is what made it worthless:
    // it asserted the fallthrough, not the case its own name describes.
    expect(classifyEscrowEvent("approve", { status: "disputed", assigneeId: null })).toBe(
      "superseded",
    )
  })

  it("keeps arbitrate on the public confirm route", () => {
    // The verified on-chain event is the gate, exactly as for `resolve`.
    expect(ROUTE_KINDS).toContain("arbitrate")
    expect(KINDS).toContain("arbitrate")
  })

  /**
   * The omission that shipped alongside the kind: KINDS ✓, ALLOWED_FROM ✓,
   * REFLECTED_IN ✗.
   *
   * MUTATION: delete `REFLECTED_IN.arbitrate`. Classification then falls through
   * to ALLOWED_FROM.arbitrate — which lists paid/refunded on purpose, for
   * idempotent retries — so an ALREADY-SETTLED arbitration reads `healable` on
   * every resync. escrow-resync has no persisted cursor, so each call re-walks
   * the whole history, re-verifies against the Gateway, re-opens a DB
   * transaction and reports the ruling as newly `applied`. Forever, for a task
   * that will never change again. The `expire` entry exists for exactly this
   * failure and says so in its own comment.
   */
  it("classifies an already-settled arbitration as REFLECTED, not healable", () => {
    expect(REFLECTED_IN.arbitrate).toBeDefined()
    for (const status of ["paid", "refunded"]) {
      expect(classifyEscrowEvent("arbitrate", { status, assigneeId: "acct" })).toBe("reflected")
    }
  })

  it("still heals a dispute that has NOT been booked yet", () => {
    // The reflected entry must not swallow the case the kind exists for.
    expect(classifyEscrowEvent("arbitrate", { status: "disputed", assigneeId: "acct" })).toBe(
      "healable",
    )
  })

  it("mirrors resolve — the two settlement routes classify identically", () => {
    for (const status of ["disputed", "paid", "refunded", "open", "submitted"]) {
      const task = { status, assigneeId: "acct" }
      expect(classifyEscrowEvent("arbitrate", task)).toBe(classifyEscrowEvent("resolve", task))
    }
  })
})
