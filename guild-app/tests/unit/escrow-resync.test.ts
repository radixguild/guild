/**
 * Unit tests for the per-task chain resync (src/lib/escrow-resync.ts) — the
 * self-service half of the reconciler (smoke finding 3).
 *
 * Pins the actor split (claim = caller's user actor via the on-chain claim
 * receipt FIRST, then the chain-derived reconciler fallback — the receipt
 * burns at submit, so a completed lifecycle can never be proven by it), the
 * fail-closed emitter + task_id pins on the stream scan, and the
 * blocked-behind-pending reporting (a later event must never be silently
 * absorbed while an earlier one is stuck). classifyEscrowEvent and
 * decideClaimHeal run UNMOCKED — these tests exercise the real verdict logic,
 * including the assignee-keyed claim rule (smoke finding 7) and the
 * worker_account attribution triage
 * (design/reconciler-claim-heal-boundary-2026-07-16.md).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// Inert DB so importOriginal on the confirm core never opens a connection.
vi.mock("@/db", () => ({ db: { transaction: vi.fn() } }))

const GATEWAY = "https://gateway.test"
const COMPONENT = "component_rdx1escrow"
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  GATEWAY: "https://gateway.test",
  ESCROW_COMPONENT: "component_rdx1escrow",
}))

// Real classifyEscrowEvent + ALLOWED_FROM; only the write path is mocked.
const { mockApply } = vi.hoisted(() => ({ mockApply: vi.fn() }))
vi.mock("@/lib/escrow-confirm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/escrow-confirm")>()),
  applyEscrowConfirm: mockApply,
}))

const { mockFindEscrowByTask, mockRecordEntitlement } = vi.hoisted(() => ({
  mockFindEscrowByTask: vi.fn(),
  mockRecordEntitlement: vi.fn(),
}))
vi.mock("@/db/queries/escrow", () => ({
  findEscrowByTask: mockFindEscrowByTask,
  recordEntitlementLedgerRow: mockRecordEntitlement,
}))

// Live claim-state read for the NOT_CLAIMER fallback; the rest of the gateway
// module stays real (the confirm core is mocked above, so nothing else calls it).
const { mockClaimInfo } = vi.hoisted(() => ({ mockClaimInfo: vi.fn() }))
vi.mock("@/lib/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gateway")>()),
  readOnChainClaimInfo: mockClaimInfo,
}))

const { mockFindUserById } = vi.hoisted(() => ({ mockFindUserById: vi.fn() }))
vi.mock("@/db/queries/users", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/queries/users")>()),
  findUserById: mockFindUserById,
}))

import { resyncTaskFromChain, ingestEntitlements } from "@/lib/escrow-resync"

// ── fixtures ────────────────────────────────────────────────────────────────

const CALLER = "account_rdx1caller"
const WORKER = "account_rdx1chainworker"
const FUND_TX = "txid_rdx1fund"

const task = (over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    creatorId: "account_rdx1poster",
    assigneeId: null,
    status: "open",
    onChainTaskId: 7,
    rewardXrd: "25",
    ...over,
  }) as never

const ev = (name: string, taskId = 7, emitter = COMPONENT) => ({
  name,
  emitter: { entity: { entity_address: emitter } },
  data: { programmatic_json: { fields: [{ field_name: "task_id", value: String(taskId) }] } },
})

const txItem = (intentHash: string, events: unknown[]) => ({
  transaction_status: "CommittedSuccess",
  intent_hash: intentHash,
  state_version: 101,
  receipt: { events },
})

/**
 * A `SettlementCreditedEvent` with the blueprint's field shape. `lanes` names the
 * per-lane amount fields (`worker_entitled`, `poster_bond_entitled`, …) exactly as
 * the blueprint emits them — a zero lane is emitted and parsed away, so pass "0"
 * to exercise that, not to omit the lane.
 */
const settleEv = (lanes: Record<string, string>, taskId = 7, emitter = COMPONENT) => ({
  name: "SettlementCreditedEvent",
  emitter: { entity: { entity_address: emitter } },
  data: {
    programmatic_json: {
      fields: [
        { field_name: "task_id", value: String(taskId) },
        ...Object.entries(lanes).map(([field_name, value]) => ({ field_name, value })),
      ],
    },
  },
})

/**
 * A `WithdrawalEvent`. `party` and `lane` are enum VARIANTS, not values — the
 * parser reads `variant_name`, and getting that wrong is how a real event decodes
 * to null and disappears silently.
 */
const withdrawEv = (
  party: "Worker" | "Poster",
  lane: "Reward" | "Bond",
  amount: string,
  destination: string | null = null,
  taskId = 7,
) => ({
  name: "WithdrawalEvent",
  emitter: { entity: { entity_address: COMPONENT } },
  data: {
    programmatic_json: {
      fields: [
        { field_name: "task_id", value: String(taskId) },
        { field_name: "party", variant_name: party },
        { field_name: "lane", variant_name: lane },
        { field_name: "amount", value: amount },
        ...(destination === null ? [] : [{ field_name: "destination", value: destination }]),
      ],
    },
  },
})

/** Stub fetch: committed-details answers the anchor lookup, stream serves `items`. */
function stubGateway(items: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/transaction/committed-details")) {
        return {
          ok: true,
          json: async () => ({
            transaction: { transaction_status: "CommittedSuccess", state_version: 100 },
          }),
        }
      }
      return {
        ok: true,
        json: async () => ({
          ledger_state: { state_version: 999 },
          items,
          next_cursor: null,
        }),
      }
    }),
  )
}

/** Like stubGateway, but records each /stream/transactions request body. */
function stubGatewayCapturing(items: unknown[]): Record<string, unknown>[] {
  const streamBodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, opts?: { body?: string }) => {
      if (String(url).includes("/transaction/committed-details")) {
        return {
          ok: true,
          json: async () => ({
            transaction: { transaction_status: "CommittedSuccess", state_version: 100 },
          }),
        }
      }
      streamBodies.push(JSON.parse(opts?.body ?? "{}"))
      return {
        ok: true,
        json: async () => ({ ledger_state: { state_version: 999 }, items, next_cursor: null }),
      }
    }),
  )
  return streamBodies
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  mockFindEscrowByTask.mockResolvedValue([{ txType: "fund", txHash: FUND_TX, amountXrd: "27.5" }])
  // Fallback collaborators: reset IMPLEMENTATIONS too (clearAllMocks keeps
  // them), so a test that never expects the fallback can't inherit one.
  mockClaimInfo.mockReset()
  mockFindUserById.mockReset()
  // Default: every entitlement row is a fresh physical insert. Tests that care
  // about replays override this per call.
  mockRecordEntitlement.mockReset()
  mockRecordEntitlement.mockResolvedValue({ inserted: true })
})

// ── tests ───────────────────────────────────────────────────────────────────

describe("resyncTaskFromChain", () => {
  it("rejects a task with no on-chain escrow id (NOT_FUNDED)", async () => {
    const result = await resyncTaskFromChain(task({ onChainTaskId: null }), CALLER)
    expect(result).toMatchObject({ ok: false, code: "NOT_FUNDED", httpStatus: 409 })
  })

  it("rejects when the ledger has no fund row to anchor the scan (NO_FUND_ROW)", async () => {
    mockFindEscrowByTask.mockResolvedValue([])
    const result = await resyncTaskFromChain(task(), CALLER)
    expect(result).toMatchObject({ ok: false, code: "NO_FUND_ROW", httpStatus: 409 })
  })

  it("heals a missed cancel through the reconciler actor", async () => {
    stubGateway([txItem("txid_rdx1cancel", [ev("TaskCancelledEvent")])])
    mockApply.mockResolvedValue({ ok: true, task: task({ status: "cancelled" }) })

    const result = await resyncTaskFromChain(task({ status: "open" }), CALLER)

    expect(mockApply).toHaveBeenCalledTimes(1)
    expect(mockApply).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "cancel", "txid_rdx1cancel", {
      kind: "reconciler",
    })
    expect(result).toMatchObject({
      ok: true,
      applied: [{ kind: "cancel", intentHash: "txid_rdx1cancel", status: "cancelled" }],
      pending: [],
    })
  })

  it("applies a lost claim with the CALLER's user actor (claim receipt proves it)", async () => {
    stubGateway([txItem("txid_rdx1claim", [ev("TaskClaimedEvent")])])
    mockApply.mockResolvedValue({
      ok: true,
      task: task({ status: "assigned", assigneeId: CALLER }),
    })

    const result = await resyncTaskFromChain(task({ status: "open" }), CALLER)

    expect(mockApply).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "claim", "txid_rdx1claim", {
      kind: "user",
      userId: CALLER,
    })
    expect(result).toMatchObject({ ok: true, applied: [{ kind: "claim", status: "assigned" }] })
  })

  // ── NOT_CLAIMER fallback: chain-derived attribution ─────────────────────────
  // The claim receipt burns at submit, so for any lifecycle at/past Submitted
  // even the true worker fails the user-actor proof. The fallback resolves the
  // assignee from the live TaskState's worker_account (decideClaimHeal — the
  // cron's triage), which the caller cannot influence.

  it("NOT_CLAIMER falls back to the chain-resolved worker and heals the full backlog in order", async () => {
    stubGateway([
      txItem("txid_rdx1claim", [ev("TaskClaimedEvent")]),
      txItem("txid_rdx1submit", [ev("WorkSubmittedEvent")]),
      txItem("txid_rdx1approve", [ev("TaskReleasedEvent")]),
    ])
    // Lifecycle completed on-chain; worker_account retained (lib.rs clears it
    // only on expire/cancel-after-claim).
    mockClaimInfo.mockResolvedValue({ state: "Released", workerAccount: WORKER })
    mockFindUserById.mockResolvedValue({ id: WORKER })
    mockApply.mockImplementation(async (_task, kind, _hash, actor: { kind: string }) => {
      if (kind === "claim" && actor.kind === "user")
        return { ok: false, code: "NOT_CLAIMER", httpStatus: 403, message: "Caller does not hold a claim receipt for this task" }
      const status = { claim: "assigned", submit: "submitted", approve: "paid" }[kind as string]
      return { ok: true, task: task({ status, assigneeId: WORKER }) }
    })

    const result = await resyncTaskFromChain(task({ status: "open" }), CALLER)

    // The live read is pinned to THIS task on THIS component, and the FK check
    // is for the CHAIN-resolved worker — argument-blind mocks here previously
    // let wrong-id / wrong-component / wrong-user regressions pass the suite.
    expect(mockClaimInfo).toHaveBeenCalledWith(7, COMPONENT)
    expect(mockFindUserById).toHaveBeenCalledWith(WORKER)
    // The heal used the CHAIN's worker, not the caller's identity.
    expect(mockApply).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "claim", "txid_rdx1claim", {
      kind: "reconciler",
      resolvedAssignee: WORKER,
    })
    expect(mockApply).not.toHaveBeenCalledWith(expect.anything(), "claim", expect.anything(), {
      kind: "reconciler",
      resolvedAssignee: CALLER,
    })
    expect(result).toMatchObject({
      ok: true,
      applied: [
        { kind: "claim", status: "assigned" },
        { kind: "submit", status: "submitted" },
        { kind: "approve", status: "paid" },
      ],
      pending: [],
    })
  })

  it("fallback live read is pinned to the task's STORED component, not the config global", async () => {
    const stored = "component_rdx1legacyx"
    stubGateway([txItem("txid_rdx1claim", [ev("TaskClaimedEvent", 7, stored)])])
    mockClaimInfo.mockResolvedValue({ state: "Claimed", workerAccount: WORKER })
    mockFindUserById.mockResolvedValue({ id: WORKER })
    mockApply.mockImplementation(async (_task, kind, _hash, actor: { kind: string }) => {
      if (kind === "claim" && actor.kind === "user")
        return { ok: false, code: "NOT_CLAIMER", httpStatus: 403, message: "Caller does not hold a claim receipt for this task" }
      return { ok: true, task: task({ status: "assigned", assigneeId: WORKER, escrowComponent: stored }) }
    })

    const result = await resyncTaskFromChain(task({ status: "open", escrowComponent: stored }), CALLER)

    // on_chain_task_id collides across the cutover — reading the CURRENT
    // component's task 7 for a legacy-component row would attribute a
    // stranger's claim.
    expect(mockClaimInfo).toHaveBeenCalledWith(7, stored)
    expect(result).toMatchObject({ ok: true, applied: [{ kind: "claim", status: "assigned" }] })
  })

  it("NOT_CLAIMER + inconsistent chain shape (worker on an Open task): pending with the surface reason, never absorbed as in-sync", async () => {
    stubGateway([txItem("txid_rdx1claim", [ev("TaskClaimedEvent")])])
    // Structurally impossible on-chain (expire clears the worker) — the triage
    // surfaces it; the resync must REPORT it, not count it reflected.
    mockClaimInfo.mockResolvedValue({ state: "Open", workerAccount: WORKER })
    mockApply.mockResolvedValue({
      ok: false,
      code: "NOT_CLAIMER",
      httpStatus: 403,
      message: "Caller does not hold a claim receipt for this task",
    })

    const result = await resyncTaskFromChain(task({ status: "open" }), CALLER)

    expect(mockApply).toHaveBeenCalledTimes(1) // no reconciler heal on an anomaly
    expect(result).toMatchObject({
      ok: true,
      applied: [],
      pending: [{ kind: "claim", reason: expect.stringContaining("should not retain a worker_account") }],
    })
    if (result.ok) expect(result.reflected).toBe(0)
  })

  it("NOT_CLAIMER + worker not yet a guild user: pending, and the events behind it stay blocked", async () => {
    stubGateway([
      txItem("txid_rdx1claim", [ev("TaskClaimedEvent")]),
      txItem("txid_rdx1submit", [ev("WorkSubmittedEvent")]),
    ])
    mockClaimInfo.mockResolvedValue({ state: "Claimed", workerAccount: WORKER })
    mockFindUserById.mockResolvedValue(null)
    mockApply.mockResolvedValue({
      ok: false,
      code: "NOT_CLAIMER",
      httpStatus: 403,
      message: "Caller does not hold a claim receipt for this task",
    })

    const result = await resyncTaskFromChain(task({ status: "open" }), CALLER)

    // Only the user-actor claim was attempted (no reconciler heal without the
    // FK user); the submit behind it must not apply NOR count as in-sync.
    // The existence check is for the CHAIN-resolved worker, not the caller.
    expect(mockFindUserById).toHaveBeenCalledWith(WORKER)
    expect(mockApply).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      ok: true,
      applied: [],
      pending: [
        { kind: "claim", reason: expect.stringContaining("no guild account") },
        { kind: "submit", reason: expect.stringContaining("Blocked behind") },
      ],
    })
  })

  it("NOT_CLAIMER + expired claim (worker_account cleared): stale history, reflected — never healed to the abandoner", async () => {
    stubGateway([txItem("txid_rdx1claim", [ev("TaskClaimedEvent")])])
    mockClaimInfo.mockResolvedValue({ state: "Open", workerAccount: null })
    mockApply.mockResolvedValue({
      ok: false,
      code: "NOT_CLAIMER",
      httpStatus: 403,
      message: "Caller does not hold a claim receipt for this task",
    })

    const result = await resyncTaskFromChain(task({ status: "open" }), CALLER)

    expect(mockApply).toHaveBeenCalledTimes(1) // the user-actor attempt only
    expect(result).toMatchObject({ ok: true, applied: [], pending: [], reflected: 1 })
  })

  it("NOT_CLAIMER + unreadable live state: pending with a retry hint, nothing guessed", async () => {
    stubGateway([txItem("txid_rdx1claim", [ev("TaskClaimedEvent")])])
    mockClaimInfo.mockRejectedValue(new Error("Gateway 502"))
    mockApply.mockResolvedValue({
      ok: false,
      code: "NOT_CLAIMER",
      httpStatus: 403,
      message: "Caller does not hold a claim receipt for this task",
    })

    const result = await resyncTaskFromChain(task({ status: "open" }), CALLER)

    expect(mockApply).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      ok: true,
      applied: [],
      pending: [{ kind: "claim", reason: expect.stringContaining("retry") }],
    })
  })

  it("surfaces a claim lost before the lifecycle moved on (assignee never recorded)", async () => {
    stubGateway([
      txItem("txid_rdx1claim", [ev("TaskClaimedEvent")]),
      txItem("txid_rdx1submit", [ev("WorkSubmittedEvent")]),
    ])

    // The smoke's stranded shape: status already past claiming, assignee null.
    const result = await resyncTaskFromChain(task({ status: "submitted", assigneeId: null }), CALLER)

    expect(mockApply).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: true,
      applied: [],
      pending: [{ kind: "claim", reason: expect.stringContaining("operator") }],
    })
    // The submit IS reflected (status: submitted) — only the claim is stuck.
    if (result.ok) expect(result.reflected).toBe(1)
  })

  it("counts a fully synced lifecycle as reflected, applying nothing", async () => {
    stubGateway([
      txItem("txid_rdx1claim", [ev("TaskClaimedEvent")]),
      txItem("txid_rdx1submit", [ev("WorkSubmittedEvent")]),
      txItem("txid_rdx1approve", [ev("TaskReleasedEvent")]),
    ])

    const result = await resyncTaskFromChain(
      task({ status: "paid", assigneeId: "account_rdx1worker" }),
      CALLER,
    )

    expect(mockApply).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, applied: [], pending: [], reflected: 3 })
  })

  it("ignores foreign-emitter and wrong-task events (fail-closed pins)", async () => {
    stubGateway([
      txItem("txid_rdx1foreign", [ev("TaskCancelledEvent", 7, "component_rdx1lookalike")]),
      txItem("txid_rdx1other", [ev("TaskCancelledEvent", 8)]),
    ])

    const result = await resyncTaskFromChain(task({ status: "open" }), CALLER)

    expect(mockApply).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, applied: [], pending: [], reflected: 0 })
  })

  // ── component-scoped scan (old→vNext cutover) ──────────────────────────────
  // on_chain_task_id collides across the cutover; the scan must pin to the
  // task's OWN funding component, both for the Gateway filter and the emitter.

  it("scans on the task's stored escrow component, not the config global", async () => {
    const stored = "component_rdx1legacyx"
    const bodies = stubGatewayCapturing([
      txItem("txid_rdx1cancel", [ev("TaskCancelledEvent", 7, stored)]),
    ])
    mockApply.mockResolvedValue({ ok: true, task: task({ status: "cancelled" }) })

    const result = await resyncTaskFromChain(task({ status: "open", escrowComponent: stored }), CALLER)

    // Stream pinned to the task's own component…
    expect(bodies[0].affected_global_entities_filter).toEqual([stored])
    // …and the event emitted by that component heals.
    expect(mockApply).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      "cancel",
      "txid_rdx1cancel",
      { kind: "reconciler" },
    )
    expect(result).toMatchObject({ ok: true, applied: [{ kind: "cancel", status: "cancelled" }] })
  })

  it("emitter pin uses the stored component — a config-global event is ignored", async () => {
    const stored = "component_rdx1legacyx"
    // Event emitted by the CONFIG GLOBAL (COMPONENT), but the task was funded on
    // `stored` — the fail-closed emitter pin must reject it.
    stubGatewayCapturing([txItem("txid_rdx1cancel", [ev("TaskCancelledEvent", 7, COMPONENT)])])

    const result = await resyncTaskFromChain(task({ status: "open", escrowComponent: stored }), CALLER)

    expect(mockApply).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, applied: [], reflected: 0 })
  })

  it("falls back to the config global for a pre-backfill row (null component)", async () => {
    const bodies = stubGatewayCapturing([txItem("txid_rdx1cancel", [ev("TaskCancelledEvent", 7, COMPONENT)])])
    mockApply.mockResolvedValue({ ok: true, task: task({ status: "cancelled" }) })

    const result = await resyncTaskFromChain(task({ status: "open", escrowComponent: null }), CALLER)

    expect(bodies[0].affected_global_entities_filter).toEqual([COMPONENT])
    expect(mockApply).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, applied: [{ kind: "cancel", status: "cancelled" }] })
  })
})

// ── GM-3: a resync the POSTER starts heals claims through the chain fallback ──
// The user actor refuses the poster with SELF_CLAIM (they can never be the
// claimer), and that used to land as a pending entry instead of falling through
// to the chain-derived attribution — so a poster's resync of an expire →
// re-claim history left the row open/unassigned while the chain said Claimed.
describe("resyncTaskFromChain — poster-started resync (GM-3)", () => {
  const POSTER = "account_rdx1poster"
  const WORKER_A = "account_rdx1workera"
  const WORKER_B = "account_rdx1workerb"

  /** A confirm core that does what the real one would for these kinds. */
  const realisticApply = () =>
    mockApply.mockImplementation(async (t: { status: string }, kind: string, _h: string, actor: { kind: string; userId?: string; resolvedAssignee?: string }) => {
      if (kind === "claim" && actor.kind === "user") {
        if (actor.userId === POSTER) return { ok: false, code: "SELF_CLAIM", httpStatus: 403, message: "Cannot claim your own task" }
        return { ok: false, code: "NOT_CLAIMER", httpStatus: 403, message: "Caller does not hold the active claim receipt" }
      }
      if (kind === "claim") return { ok: true, task: task({ status: "assigned", assigneeId: actor.resolvedAssignee }) }
      if (kind === "expire") return { ok: true, task: task({ status: "open", assigneeId: null }) }
      return { ok: true, task: t }
    })

  it("claim(A) → expire → claim(B), DB already assigned B, poster resyncs → ends assigned B with nothing pending", async () => {
    stubGateway([
      txItem("txid_rdx1claimA", [ev("TaskClaimedEvent")]),
      txItem("txid_rdx1expire", [ev("ClaimExpiredEvent")]),
      txItem("txid_rdx1claimB", [ev("TaskClaimedEvent")]),
    ])
    mockClaimInfo.mockResolvedValue({ state: "Claimed", workerAccount: WORKER_B })
    mockFindUserById.mockResolvedValue({ id: WORKER_B })
    realisticApply()

    const result = await resyncTaskFromChain(task({ status: "assigned", assigneeId: WORKER_B }), POSTER)

    expect(result).toMatchObject({ ok: true, pending: [] })
    expect((result as { task: { status: string; assigneeId: string } }).task).toMatchObject({
      status: "assigned",
      assigneeId: WORKER_B,
    })
    // The re-claim healed off the chain's worker_account, never as the poster.
    expect(mockApply).toHaveBeenCalledWith(expect.anything(), "claim", "txid_rdx1claimB", {
      kind: "reconciler",
      resolvedAssignee: WORKER_B,
    })
    expect(mockApply).not.toHaveBeenCalledWith(expect.anything(), "claim", expect.anything(), {
      kind: "user",
      userId: POSTER,
    })
    expect(mockApply).not.toHaveBeenCalledWith(expect.anything(), "claim", expect.anything(), expect.objectContaining({ resolvedAssignee: WORKER_A }))
  })

  it("a lost claim confirm (DB open/unassigned, chain Claimed by W): the poster's resync heals it to W", async () => {
    stubGateway([txItem("txid_rdx1claim", [ev("TaskClaimedEvent")])])
    mockClaimInfo.mockResolvedValue({ state: "Claimed", workerAccount: WORKER })
    mockFindUserById.mockResolvedValue({ id: WORKER })
    realisticApply()

    const result = await resyncTaskFromChain(task({ status: "open" }), POSTER)

    expect(result).toMatchObject({ ok: true, pending: [], applied: [{ kind: "claim", status: "assigned" }] })
    expect(mockApply).toHaveBeenCalledTimes(1)
    expect(mockApply).toHaveBeenCalledWith(expect.anything(), "claim", "txid_rdx1claim", {
      kind: "reconciler",
      resolvedAssignee: WORKER,
    })
  })

  it("a non-poster caller still tries their own claim receipt first", async () => {
    stubGateway([txItem("txid_rdx1claim", [ev("TaskClaimedEvent")])])
    mockApply.mockResolvedValue({ ok: true, task: task({ status: "assigned", assigneeId: CALLER }) })
    await resyncTaskFromChain(task({ status: "open" }), CALLER)
    expect(mockApply).toHaveBeenCalledWith(expect.anything(), "claim", "txid_rdx1claim", { kind: "user", userId: CALLER })
  })
})

// ── GM-8: a scan cut short by the page cap applies NOTHING ────────────────────
describe("resyncTaskFromChain — truncated scan (GM-8)", () => {
  it("a stream that still has a next_cursor after the page cap → not ok, nothing applied or ingested", async () => {
    let streamCalls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/transaction/committed-details")) {
          return { ok: true, json: async () => ({ transaction: { transaction_status: "CommittedSuccess", state_version: 100 } }) }
        }
        streamCalls++
        return {
          ok: true,
          json: async () => ({
            ledger_state: { state_version: 999 },
            items: [txItem(`txid_rdx1expire${streamCalls}`, [ev("ClaimExpiredEvent"), settleEv({ poster_entitled: "1" })])],
            next_cursor: "more",
          }),
        }
      }),
    )
    mockApply.mockResolvedValue({ ok: true, task: task({ status: "open" }) })

    const result = await resyncTaskFromChain(task({ status: "assigned", assigneeId: WORKER }), CALLER)

    expect(result).toMatchObject({ ok: false, code: "SCAN_TRUNCATED" })
    expect(streamCalls).toBe(20)
    expect(mockApply).not.toHaveBeenCalled()
    expect(mockRecordEntitlement).not.toHaveBeenCalled()
  })

  it("a stream that ends inside the cap is applied as before", async () => {
    stubGateway([txItem("txid_rdx1cancel", [ev("TaskCancelledEvent")])])
    mockApply.mockResolvedValue({ ok: true, task: task({ status: "cancelled" }) })
    expect(await resyncTaskFromChain(task({ status: "open" }), CALLER)).toMatchObject({ ok: true })
  })
})

/**
 * The WIRE between the entitlement parser and the ledger writer (Phase 4 chunk B).
 *
 * Both ends were verified in isolation — the parser has its own unit suite, the
 * writer its own PGlite integration suite, the schema is checked against real
 * Postgres — and the seam joining them had NOTHING. Replacing `if (isEntitlement)`
 * in collectTaskEvents with `if (false)`, i.e. deleting the only path that turns a
 * chain event into a ledger row, left the entire suite at 1299/1299 green
 * (reproduced 2026-08-02). That is the same false-green shape chunk A was written
 * to remove, shipped one chunk later, and mutation testing could not see it
 * because it is a question about whether a function is CALLED, not whether a guard
 * can fail.
 *
 * So these tests assert the seam from OUTSIDE: drive real event payloads through
 * the public entry point and require them to arrive at the writer. Each one fails
 * if the branch is severed.
 */
describe("resyncTaskFromChain — entitlement ingestion seam", () => {
  it("a SettlementCreditedEvent on the stream reaches the ledger writer", async () => {
    stubGateway([txItem("txid_rdx1settle", [settleEv({ worker_entitled: "25" })])])

    const result = await resyncTaskFromChain(task({ status: "paid", assigneeId: WORKER }), CALLER)

    expect(mockRecordEntitlement).toHaveBeenCalledTimes(1)
    expect(mockRecordEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 1,
        txType: "settle",
        party: "worker",
        lane: "reward",
        amountXrd: "25",
        txHash: "txid_rdx1settle",
        destination: null,
      }),
    )
    expect(result).toMatchObject({ ok: true, entitlementsRecorded: 1 })
  })

  it("a WithdrawalEvent's two lanes both reach the writer under ONE tx hash", async () => {
    // deposit_both_lanes calls take_lane twice in one tx, so a single withdraw
    // emits two events differing only by lane. Anything keying on the resource
    // (which is XRD for both in production) drops a leg here.
    stubGateway([
      txItem("txid_rdx1withdraw", [
        withdrawEv("Worker", "Reward", "25", "account_rdx1payee"),
        withdrawEv("Worker", "Bond", "10", "account_rdx1payee"),
      ]),
    ])

    const result = await resyncTaskFromChain(task({ status: "paid", assigneeId: WORKER }), CALLER)

    expect(mockRecordEntitlement).toHaveBeenCalledTimes(2)
    const lanes = mockRecordEntitlement.mock.calls.map(([row]) => row.lane).sort()
    expect(lanes).toEqual(["bond", "reward"])
    for (const [row] of mockRecordEntitlement.mock.calls) {
      expect(row.txHash).toBe("txid_rdx1withdraw")
      expect(row.txType).toBe("withdraw")
      expect(row.destination).toBe("account_rdx1payee")
    }
    expect(result).toMatchObject({ ok: true, entitlementsRecorded: 2 })
  })

  it("ingests on a task whose lifecycle is fully reflected — no status gate", async () => {
    // The ledger path is deliberately NOT an EscrowConfirmKind: a withdrawal
    // advances no status, so gating it on one would drop real collections on
    // exactly the rows that owe money. A `paid` task with nothing to apply must
    // still ingest.
    stubGateway([txItem("txid_rdx1late", [withdrawEv("Poster", "Reward", "5")])])

    const result = await resyncTaskFromChain(task({ status: "paid" }), CALLER)

    expect(mockApply).not.toHaveBeenCalled()
    expect(mockRecordEntitlement).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, applied: [], entitlementsRecorded: 1 })
  })

  it("counts physical inserts, not events seen — a replay reports 0", async () => {
    stubGateway([txItem("txid_rdx1replay", [settleEv({ worker_entitled: "25" })])])
    mockRecordEntitlement.mockResolvedValue({ inserted: false })

    const result = await resyncTaskFromChain(task({ status: "paid", assigneeId: WORKER }), CALLER)

    expect(mockRecordEntitlement).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, entitlementsRecorded: 0 })
  })

  it("attributes each leg to the party that collects it", async () => {
    stubGateway([
      txItem("txid_rdx1both", [settleEv({ worker_entitled: "25", poster_entitled: "5" })]),
    ])

    await resyncTaskFromChain(task({ status: "paid", assigneeId: WORKER }), CALLER)

    const byParty = Object.fromEntries(
      mockRecordEntitlement.mock.calls.map(([row]) => [row.party, row]),
    )
    expect(byParty.worker).toMatchObject({ toUserId: WORKER, fromUserId: "account_rdx1poster" })
    expect(byParty.poster).toMatchObject({
      toUserId: "account_rdx1poster",
      fromUserId: "account_rdx1poster",
    })
  })

  it("ingests AFTER the lifecycle loop, so a worker leg sees the assignee the claim just recorded", async () => {
    // Ordering is load-bearing (escrow-resync.ts:417): a task whose claim is only
    // being healed NOW has assigneeId null on entry, so ingesting first would pin
    // toUserId to null permanently. Both events arrive in one scan.
    stubGateway([
      txItem("txid_rdx1claim", [ev("TaskClaimedEvent")]),
      txItem("txid_rdx1wd", [withdrawEv("Worker", "Reward", "25")]),
    ])
    mockApply.mockResolvedValue({
      ok: true,
      task: task({ status: "assigned", assigneeId: WORKER }),
    })

    await resyncTaskFromChain(task({ status: "open", assigneeId: null }), CALLER)

    expect(mockRecordEntitlement).toHaveBeenCalledTimes(1)
    expect(mockRecordEntitlement.mock.calls[0][0].toUserId).toBe(WORKER)
  })

  it("holds the emitter and task_id pins — a foreign or wrong-task entitlement is ignored", async () => {
    stubGateway([
      txItem("txid_rdx1foreign", [
        settleEv({ worker_entitled: "25" }, 7, "component_rdx1impostor"),
        settleEv({ worker_entitled: "25" }, 99, COMPONENT),
      ]),
    ])

    const result = await resyncTaskFromChain(task({ status: "paid", assigneeId: WORKER }), CALLER)

    expect(mockRecordEntitlement).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, entitlementsRecorded: 0 })
  })
})


/**
 * `ingestEntitlements` is EXPORTED so the cron reconciler calls this exact
 * function instead of hand-rolling a second copy in a .mjs script.
 *
 * Until 2026-08-02 the reconciler had no entitlement handling at all — its event
 * gate dropped SettlementCreditedEvent and WithdrawalEvent silently — so a
 * withdrawal made by an agent, the CLI or a wallet was recorded ONLY if a human
 * later clicked "Resync from chain" on that task. The writer's own docstring
 * claimed both scanners replayed these events; that described a system that did
 * not exist.
 *
 * These pin the contract the reconciler depends on. A second implementation
 * would be this phase's CRITICAL defect again, one file over.
 */
describe("ingestEntitlements — the shared writer path", () => {
  it("writes one ledger row per lane and counts physical inserts", async () => {
    const n = await ingestEntitlements(task({ assigneeId: WORKER }), [
      {
        intentHash: "txid_rdx1w",
        rows: [
          { txType: "withdraw", party: "worker", lane: "reward", amountXrd: "25", destination: "account_rdx1p" },
          { txType: "withdraw", party: "worker", lane: "bond", amountXrd: "10", destination: "account_rdx1p" },
        ],
      },
    ])

    expect(n).toBe(2)
    expect(mockRecordEntitlement).toHaveBeenCalledTimes(2)
    for (const [row] of mockRecordEntitlement.mock.calls) {
      expect(row.txHash).toBe("txid_rdx1w")
      expect(row.taskId).toBe(1)
    }
  })

  it("attributes each leg to the party that collects it", async () => {
    await ingestEntitlements(task({ assigneeId: WORKER }), [
      {
        intentHash: "txid_rdx1s",
        rows: [
          { txType: "settle", party: "worker", lane: "reward", amountXrd: "25", destination: null },
          { txType: "settle", party: "poster", lane: "reward", amountXrd: "5", destination: null },
        ],
      },
    ])

    const byParty = Object.fromEntries(
      mockRecordEntitlement.mock.calls.map(([row]) => [row.party, row]),
    )
    expect(byParty.worker.toUserId).toBe(WORKER)
    expect(byParty.poster.toUserId).toBe("account_rdx1poster")
    // Funds always originate from the poster's escrow, whoever collects them.
    expect(byParty.worker.fromUserId).toBe("account_rdx1poster")
  })

  it("does not guess a worker payee on a task whose claim was never recorded", async () => {
    await ingestEntitlements(task({ assigneeId: null }), [
      {
        intentHash: "txid_rdx1orphan",
        rows: [{ txType: "withdraw", party: "worker", lane: "bond", amountXrd: "10", destination: null }],
      },
    ])
    // null, not the poster and not a fabricated id — toUserId is nullable for
    // exactly this case.
    expect(mockRecordEntitlement.mock.calls[0][0].toUserId).toBeNull()
  })

  it("counts only physical inserts, so a replayed window reports 0", async () => {
    // reconcile-cron.sh HOLDS its cursor on failure and replays the same window;
    // double-counting there would misreport money as having moved twice.
    mockRecordEntitlement.mockResolvedValue({ inserted: false })
    const n = await ingestEntitlements(task({ assigneeId: WORKER }), [
      {
        intentHash: "txid_rdx1replay",
        rows: [{ txType: "withdraw", party: "worker", lane: "reward", amountXrd: "25", destination: null }],
      },
    ])
    expect(n).toBe(0)
    expect(mockRecordEntitlement).toHaveBeenCalledTimes(1)
  })

  it("writes nothing when there are no rows", async () => {
    expect(await ingestEntitlements(task(), [])).toBe(0)
    expect(mockRecordEntitlement).not.toHaveBeenCalled()
  })
})
