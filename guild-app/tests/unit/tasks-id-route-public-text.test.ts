/**
 * Public-text gate wiring for GET /api/v1/tasks/[id] (2026-09-10 operator
 * ruling; existence-hiding hardened 2026-09-14). src/lib/public-task-text.ts
 * carries the scrubbing rules and their own unit tests; this file pins that
 * the ROUTE calls the gate with the right viewer identity. Mirrors
 * tasks-creator-filter.test.ts's shape for the sibling list route.
 *
 * 2026-09-14: measured on production (deploy 817d357) that a cancelled
 * task's detail page WAS reachable by id for anonymous and non-party
 * callers, even though the default LIST hides cancelled rows — so a
 * stranger who guessed or found an id could still read everything the list
 * filter (`notCancelledByDefault` in db/queries/tasks.ts) was built to hide.
 * This file's docblock previously pinned that as intended ("no 404 on
 * status alone") — that was the bug. Now: a cancelled task 404s for anyone
 * but its creator or assignee; every OTHER status stays reachable by id for
 * anyone, exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockGetSessionUser } = vi.hoisted(() => ({
  mockGetSessionUser: vi.fn(),
}))
vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: "account_rdx1poster" } }),
  getSessionUser: mockGetSessionUser,
}))

const { mockFindTaskById } = vi.hoisted(() => ({
  mockFindTaskById: vi.fn(),
}))
vi.mock("@/db/queries/tasks", () => ({
  findTaskById: mockFindTaskById,
  updateTask: vi.fn(),
  cancelTask: vi.fn(),
  getSubmissionCount: vi.fn().mockResolvedValue(0),
}))
vi.mock("@/db/queries/projects", () => ({ findProjectById: vi.fn().mockResolvedValue(null) }))

const { mockGetTrustStats } = vi.hoisted(() => ({
  mockGetTrustStats: vi.fn(),
}))
vi.mock("@/db/queries/trust", () => ({ getTrustStats: mockGetTrustStats }))
vi.mock("@/db/queries/poster-cancel-stats", () => ({
  getPosterCancelStats: vi.fn().mockResolvedValue({ cancelledAfterClaim: 0, totalClaims: 0 }),
}))

const { mockFindSettlementHistoryForTask } = vi.hoisted(() => ({
  mockFindSettlementHistoryForTask: vi.fn().mockResolvedValue([]),
}))
vi.mock("@/db/queries/escrow", () => ({
  findSettlementHistoryForTask: mockFindSettlementHistoryForTask,
}))

// Import AFTER mocks are registered.
import { GET } from "@/app/api/v1/tasks/[id]/route"

const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never

// An OPEN task — used for the scrub-wiring tests below, which are about
// text redaction, not cancellation. See the separate describe block further
// down for the cancelled-task existence gate.
const rawTask = {
  id: 40,
  creatorId: "account_rdx1poster",
  status: "open",
  title: "Set up off-site backups",
  description: "ssh guild-vps 'cat /opt/guild-saas/backups/backup.sh'\nBudget: 30 XRD.",
  assigneeId: null,
  projectId: null,
  rewardXrd: "30",
}

describe("GET /api/v1/tasks/[id] — public-text gate (2026-09-10 ruling)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindTaskById.mockResolvedValue(rawTask)
  })

  it("an open task is reachable by id for an anonymous viewer, with the SCRUBBED description", async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const res = await GET({} as never, ctx("40"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe("open")
    expect(body.data.description).toBe("Budget: 30 XRD.")
    expect(body.data.description).not.toContain("/opt")
    expect(body.data.description).not.toContain("ssh ")
  })

  it("a DIFFERENT signed-in viewer (not the poster) also gets the scrubbed description", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1someone_else" })
    const res = await GET({} as never, ctx("40"))
    const body = await res.json()
    expect(body.data.description).toBe("Budget: 30 XRD.")
  })

  it("the task's OWN poster sees the raw, unscrubbed description", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1poster" })
    const res = await GET({} as never, ctx("40"))
    const body = await res.json()
    expect(body.data.description).toBe(rawTask.description)
    expect(body.data.description).toContain("/opt/guild-saas/backups/backup.sh")
  })

  it("a session-read failure degrades to the scrubbed public view rather than 500ing", async () => {
    mockGetSessionUser.mockRejectedValue(new Error("cookie store unavailable"))
    const res = await GET({} as never, ctx("40"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.description).toBe("Budget: 30 XRD.")
  })

  it("every non-text field is untouched by the gate", async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const res = await GET({} as never, ctx("40"))
    const body = await res.json()
    expect(body.data.id).toBe(40)
    expect(body.data.creatorId).toBe("account_rdx1poster")
    expect(body.data.rewardXrd).toBe("30")
  })
})

// 2026-09-14 hardening: a cancelled task must not be reachable by id for a
// non-party caller — it must read exactly like a non-existent id (same
// code/message/status), so existence isn't leaked either.
//
// 2026-09-14, second pass: a SESSION-LESS caller (never signed in, or a
// session read that failed) now gets a DIFFERENT 404 — code
// ARCHIVED_SIGN_IN_REQUIRED, not NOT_FOUND — because that population might
// just be this task's own party with a lapsed cookie (the production
// incident this pass fixes). A SIGNED-IN non-party still gets the exact
// same 404 a missing id returns; that invariant just moved from the
// anonymous case (below) to the signed-in-stranger case, since anonymous is
// no longer identical to missing on purpose. See cancelledTaskLookupCode's
// own docblock (public-task-text.ts) for the enumeration analysis.
const cancelledTask = {
  ...rawTask,
  id: 62,
  status: "cancelled",
}

const cancelledTaskWithAssignee = {
  ...cancelledTask,
  assigneeId: "account_rdx1assignee",
}

describe("GET /api/v1/tasks/[id] — cancelled-task existence gate (2026-09-14)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindSettlementHistoryForTask.mockResolvedValue([])
  })

  it("an anonymous viewer gets ARCHIVED_SIGN_IN_REQUIRED, NOT the plain not-found a missing id gets", async () => {
    mockFindTaskById.mockResolvedValue(cancelledTask)
    mockGetSessionUser.mockResolvedValue(null)
    const res = await GET({} as never, ctx("62"))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe("ARCHIVED_SIGN_IN_REQUIRED")

    // Deliberately DIFFERENT from a genuinely-missing id now — that's the
    // whole point of the code, so pin the difference, not an equality.
    mockFindTaskById.mockResolvedValue(null)
    const missingRes = await GET({} as never, ctx("9999"))
    const missingBody = await missingRes.json()
    expect(missingRes.status).toBe(404)
    expect(missingBody.error.code).toBe("NOT_FOUND")
    expect(missingBody).not.toEqual(body)
  })

  it("a signed-in non-party viewer gets the SAME not-found response a missing id would — no extra bit for being signed in", async () => {
    mockFindTaskById.mockResolvedValue(cancelledTask)
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1someone_else" })
    const res = await GET({} as never, ctx("62"))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe("NOT_FOUND")

    // Compare against the route's genuinely-missing-id response, to prove
    // it's the identical path, not a look-alike copy that could drift.
    mockFindTaskById.mockResolvedValue(null)
    const missingRes = await GET({} as never, ctx("9999"))
    const missingBody = await missingRes.json()
    expect(missingRes.status).toBe(res.status)
    expect(missingBody).toEqual(body)
  })

  it("a session-read failure degrades to ARCHIVED_SIGN_IN_REQUIRED, same as anonymous (fails closed, not open, but tells a lapsed party what to do)", async () => {
    mockFindTaskById.mockResolvedValue(cancelledTask)
    mockGetSessionUser.mockRejectedValue(new Error("cookie store unavailable"))
    const res = await GET({} as never, ctx("62"))
    expect(res.status).toBe(404)
    const body = await res.json()
    // A thrown session read and an absent cookie both collapse to the same
    // `sessionUser?.userId === undefined` — the route cannot tell them
    // apart, so neither can this code, on purpose.
    expect(body.error.code).toBe("ARCHIVED_SIGN_IN_REQUIRED")
  })

  it("the task's own creator still gets 200 with the raw description, plus its settlement history", async () => {
    mockFindTaskById.mockResolvedValue(cancelledTask)
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1poster" })
    mockFindSettlementHistoryForTask.mockResolvedValue([
      { id: 1, taskId: 62, txType: "fund", amountXrd: "30" },
    ])
    const res = await GET({} as never, ctx("62"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe("cancelled")
    expect(body.data.description).toBe(cancelledTask.description)
    expect(body.data.settlementHistory).toHaveLength(1)
    expect(mockFindSettlementHistoryForTask).toHaveBeenCalledWith(62)
  })

  // 2026-09-14: this is the exact scenario a "confirmed in the code, not
  // session expiry" claim would need to falsify — a session whose userId
  // genuinely EQUALS assigneeId on a cancelled task. It doesn't: 200, every
  // time, because isCancelledTaskVisibleTo's assignee branch was never the
  // bug (see its own unit tests in public-task-text.test.ts) — that gate
  // only decides whether the ROW is reachable at all. The 2026-09-14
  // incident's worker-side dead end traces to the SESSION not being that —
  // see the anonymous/session-read-failure tests above, which this route
  // now answers with ARCHIVED_SIGN_IN_REQUIRED instead of a silent dead end.
  //
  // 2026-09-15 correction (P3-24): this test USED to assert the assignee got
  // the row back SCRUBBED ("like any other non-owner view") and called that
  // correct — it wasn't. `isTaskTextOwner` (creator-only) governed the TEXT
  // separately from `isCancelledTaskVisibleTo` (creator-or-assignee, which
  // only governs whether the row is served at all), so a claimed task's
  // assignee was served scrubbed text — harmless copy for an ordinary task,
  // but for one the scrub actually touches, the assignee's local
  // canonicalWorkBrief hash could never match what the poster funded, and
  // `submit_task` reverted on-chain (task 90). Fixed by widening the text
  // gate to the SAME creator-or-assignee predicate (`isPartyToTask`,
  // public-task-text.ts) the existence gate already used — see that file's
  // own tests for the money-path detail.
  it("the task's assignee gets 200 with the RAW description — the same party rule as the existence gate, now applied to text too (P3-24)", async () => {
    mockFindTaskById.mockResolvedValue(cancelledTaskWithAssignee)
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1assignee" })
    // The route always computes assigneeTrust when assigneeId is set — give
    // it a stats row so trustTierFor has something to read.
    mockGetTrustStats.mockResolvedValue({
      completed: 0,
      claimed: 0,
      failed: 0,
      disputesRaised: 0,
      disputesAgainst: 0,
      deadlineSubmits: 0,
      onTimeSubmits: 0,
      avgDeliveryDays: null,
    })
    const res = await GET({} as never, ctx("62"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.description).toBe(cancelledTaskWithAssignee.description)
    expect(body.data.description).toContain("/opt/guild-saas/backups/backup.sh")
    expect(body.data.settlementHistory).toEqual([])
  })

  it("a stranger still gets the SCRUBBED description for the same cancelled+assigned task — the party rule, not a blanket unscrub", async () => {
    mockFindTaskById.mockResolvedValue(cancelledTaskWithAssignee)
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1someone_else_entirely" })
    mockGetTrustStats.mockResolvedValue({
      completed: 0,
      claimed: 0,
      failed: 0,
      disputesRaised: 0,
      disputesAgainst: 0,
      deadlineSubmits: 0,
      onTimeSubmits: 0,
      avgDeliveryDays: null,
    })
    const res = await GET({} as never, ctx("62"))
    // A stranger isn't a party, so isCancelledTaskVisibleTo already 404s —
    // this pins that the 404 path is reached, not a 200 with scrubbed text,
    // so the two gates stay consistent with each other.
    expect(res.status).toBe(404)
  })

  it("settlementHistory is absent (not fetched, not present) for a non-cancelled task", async () => {
    mockFindTaskById.mockResolvedValue({ ...cancelledTask, status: "open" })
    mockGetSessionUser.mockResolvedValue(null)
    const res = await GET({} as never, ctx("62"))
    const body = await res.json()
    expect(body.data.settlementHistory).toBeUndefined()
    expect(mockFindSettlementHistoryForTask).not.toHaveBeenCalled()
  })

  it("a non-cancelled status is never gated — an 'open' task with the SAME id stays reachable by anyone", async () => {
    mockFindTaskById.mockResolvedValue({ ...cancelledTask, status: "open" })
    mockGetSessionUser.mockResolvedValue(null)
    const res = await GET({} as never, ctx("62"))
    expect(res.status).toBe(200)
  })
})
