/**
 * Authz regression test for GET /api/v1/escrow/[taskId].
 *
 * This route returned a task's whole escrow ledger to ANY signed-in caller
 * until 2026-09-02 — `withAuth` proves someone is authenticated, nothing more.
 * Sign-up is free (ROLA sign-in, no gate) and task ids are sequential integers
 * printed on the public board, so `/1`, `/2`, `/3`… was a complete walk of the
 * table for the cost of one script. Every sibling route in this tree already
 * checked `task.creatorId`/submitter; this one had dropped the pattern.
 *
 * Scope, stated honestly so nobody reads more into these tests than they
 * prove: /ledger deliberately PUBLISHES the settlement rows, and all of it is
 * on mainnet anyway. What the gate buys is the `fund` rows /ledger excludes,
 * and cheap enumeration through one endpoint. These tests pin the gate, not a
 * confidentiality claim.
 *
 * The falsifying input, named so this is checkable rather than decorative:
 * delete the `isParty` check in the route and the "unrelated caller" test below
 * goes red — it asserts a 403 AND that findEscrowByTask was never reached, so
 * a handler that queries first and filters after would still fail it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const CALLER = "account_rdx1caller"

vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: CALLER } }),
}))

const { mockFindTaskById } = vi.hoisted(() => ({ mockFindTaskById: vi.fn() }))
vi.mock("@/db/queries/tasks", () => ({ findTaskById: mockFindTaskById }))

const { mockFindEscrowByTask } = vi.hoisted(() => ({ mockFindEscrowByTask: vi.fn() }))
vi.mock("@/db/queries/escrow", () => ({ findEscrowByTask: mockFindEscrowByTask }))

import { GET } from "@/app/api/v1/escrow/[taskId]/route"

const LEDGER = [{ id: 1, taskId: 7, txType: "fund", amountXrd: "500", txHash: "txid_1" }]

function call(taskId: string) {
  return GET({} as never, { params: Promise.resolve({ taskId }) } as never)
}

describe("GET /api/v1/escrow/[taskId] — only the parties", () => {
  beforeEach(() => {
    mockFindTaskById.mockReset()
    mockFindEscrowByTask.mockReset()
    mockFindEscrowByTask.mockResolvedValue(LEDGER)
  })

  it("refuses a signed-in stranger, and never reads the ledger", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 7,
      creatorId: "account_rdx1someposter",
      assigneeId: "account_rdx1someworker",
    })

    const res = await call("7")
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe("FORBIDDEN")
    // The gate must run BEFORE the query — a handler that fetches then filters
    // would leak through any future logging/error path.
    expect(mockFindEscrowByTask).not.toHaveBeenCalled()
  })

  it("serves the poster", async () => {
    mockFindTaskById.mockResolvedValue({ id: 7, creatorId: CALLER, assigneeId: null })
    const res = await call("7")
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual(LEDGER)
  })

  it("serves the assigned worker", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 7,
      creatorId: "account_rdx1someposter",
      assigneeId: CALLER,
    })
    const res = await call("7")
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual(LEDGER)
  })

  it("404s an unknown task rather than 403ing it", async () => {
    // Distinct codes on purpose: a 403 for a task that does not exist would
    // confirm the id space to a walker, which is the thing being closed.
    mockFindTaskById.mockResolvedValue(undefined)
    const res = await call("999999")
    expect(res.status).toBe(404)
    expect(mockFindEscrowByTask).not.toHaveBeenCalled()
  })

  it("rejects a non-numeric id before touching the DB", async () => {
    const res = await call("not-a-number")
    expect(res.status).toBe(400)
    expect(mockFindTaskById).not.toHaveBeenCalled()
  })
})
