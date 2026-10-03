import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { privateInputs } from "../support/private-input"

/**
 * §22 extended to tasks and working groups (2026-09-19).
 *
 * project-copy-write-gate.test.ts pins the gate on project text. Task and
 * working-group text is the same class — Postgres rows no source gate can see,
 * public, writable by any signed-in stranger — and had no gate at all.
 *
 * The one deliberate difference is pinned here too: a task description is a
 * WORK SPEC, and a spec that fixes a false claim has to name it. A match wholly
 * inside double quotes or backticks is a mention, not a claim. Working groups
 * get no such exemption.
 *
 * To mutate-prove: delete the `bannedTaskClaimIn` call from POST or PATCH, or
 * the `bannedGroupClaimIn` call from propose, and that route's refusal test
 * fails; make `maskQuotedMentions` the identity and the mention tests fail.
 */

vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: "account_rdx1poster" } }),
  getSessionUser: vi.fn(),
}))

const { mockOperatorHalt, mockReadLedgerTip, mockCreateTask, mockFindTaskById, mockUpdateTask, mockCreateProposal } =
  vi.hoisted(() => ({
    mockOperatorHalt: vi.fn(),
    mockReadLedgerTip: vi.fn(),
    mockCreateTask: vi.fn(),
    mockFindTaskById: vi.fn(),
    mockUpdateTask: vi.fn(),
    mockCreateProposal: vi.fn(),
  }))

vi.mock("@/lib/gateway", () => ({
  NETWORK_HALT_AFTER_SECONDS: 900,
  operatorHaltEngaged: mockOperatorHalt,
  readLedgerTip: mockReadLedgerTip,
}))
vi.mock("@/db/queries/tasks", () => ({
  createTask: mockCreateTask,
  listTasks: vi.fn(),
  findTaskById: mockFindTaskById,
  updateTask: mockUpdateTask,
  cancelTask: vi.fn(),
  getSubmissionCount: vi.fn(),
}))
vi.mock("@/db/queries/projects", () => ({ findProjectById: vi.fn() }))
vi.mock("@/db/queries/trust", () => ({ getTrustStats: vi.fn() }))
vi.mock("@/db/queries/working-groups", () => ({
  findRoutableWorkingGroupById: vi.fn(),
  createProposal: mockCreateProposal,
  listProposalsByUser: vi.fn(),
}))
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

import { bannedTaskClaimIn, bannedGroupClaimIn, maskQuotedMentions } from "@/lib/project-copy-gate"
import { POST as POST_TASK } from "@/app/api/v1/tasks/route"
import { PATCH as PATCH_TASK } from "@/app/api/v1/tasks/[id]/route"
import { POST as POST_PROPOSAL } from "@/app/api/v1/groups/propose/route"

const req = (body: unknown) => ({ json: async () => body }) as never
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never

const CLEAN = "Add a unit test for the address formatter. Done when the test fails on a wrong truncation."
const CLAIM = "Build a fully trustless payout page for the marketplace."
const MENTION = 'Remove the word "trustless" from the /docs FAQ and say who actually holds the keys.'

beforeEach(() => {
  vi.clearAllMocks()
  mockOperatorHalt.mockReturnValue(false)
  mockReadLedgerTip.mockResolvedValue({ stateVersion: 600_000_000, tipIso: "2026-09-19T09:00:00Z", ageSeconds: 12, stale: false })
  mockCreateTask.mockResolvedValue({ id: 1 })
  mockFindTaskById.mockResolvedValue({ id: 1, creatorId: "account_rdx1poster", status: "open", onChainTaskId: null, rewardXrd: "500" })
  mockUpdateTask.mockResolvedValue({ id: 1 })
  mockCreateProposal.mockResolvedValue({ id: 1 })
})

describe("the fixtures are what they claim to be (controls)", () => {
  it("CLAIM trips the rules as plain text and CLEAN does not", () => {
    expect(bannedGroupClaimIn({ description: CLAIM })?.fragment).toMatch(/trustless/i)
    expect(bannedGroupClaimIn({ description: CLEAN })).toBeNull()
  })

  it("MENTION trips the rules when the exemption is OFF — so its passing below is the exemption, not a miss", () => {
    expect(bannedGroupClaimIn({ description: MENTION })?.fragment).toMatch(/trustless/i)
  })
})

describe("bannedTaskClaimIn", () => {
  it("refuses a claim in the title, the description or the requirements, and names the field", () => {
    expect(bannedTaskClaimIn({ title: "A trustless escrow page" })?.field).toBe("title")
    expect(bannedTaskClaimIn({ title: "Payout page", description: CLAIM })?.field).toBe("description")
    expect(bannedTaskClaimIn({ title: "Payout page", description: CLEAN, requirements: CLAIM })?.field).toBe("requirements")
  })

  it("treats a quoted or backticked mention as a mention, in every supported quote style", () => {
    expect(bannedTaskClaimIn({ description: MENTION })).toBeNull()
    expect(bannedTaskClaimIn({ description: "Replace `trustless` in src/app/docs/page.tsx with the honest sentence." })).toBeNull()
    expect(bannedTaskClaimIn({ description: "The FAQ says “fully trustless” — it is not. Fix it." })).toBeNull()
  })

  it("still refuses a claim that sits OUTSIDE the quotes on the same line", () => {
    const hit = bannedTaskClaimIn({ description: 'Remove "decentralised" from the hero. The rest is fully trustless anyway.' })
    expect(hit?.fragment).toMatch(/trustless/i)
  })

  it("does not honour single quotes — an apostrophe must not open an exemption", () => {
    expect(bannedTaskClaimIn({ description: "It's a trustless system and that's the pitch." })?.fragment).toMatch(/trustless/i)
  })

  it("reports the author's ORIGINAL characters, never the mask", () => {
    const hit = bannedTaskClaimIn({ description: 'See "the old copy". This escrow is trustless.' })
    expect(hit?.fragment).not.toContain("§")
  })

  it("skips absent, null and non-string fields — schema owns shape, this owns honesty", () => {
    expect(bannedTaskClaimIn({})).toBeNull()
    expect(bannedTaskClaimIn({ title: null, description: 42 })).toBeNull()
  })
})

describe("maskQuotedMentions", () => {
  it("preserves length and the quote characters, so offsets index the original", () => {
    const text = 'Remove "trustless" and `soulbound` now.'
    const masked = maskQuotedMentions(text)
    expect(masked.length).toBe(text.length)
    expect(masked).toBe('Remove "§§§§§§§§§" and `§§§§§§§§§` now.')
  })

  it("does not mask across a newline — an unbalanced quote cannot swallow the rest of a spec", () => {
    const text = 'A stray " here.\nThis escrow is trustless.\nAnother " there.'
    expect(bannedTaskClaimIn({ description: text })?.fragment).toMatch(/trustless/i)
  })
})

describe("POST /api/v1/tasks", () => {
  it("400s BANNED_CLAIM on a claim and never writes the row", async () => {
    const res = await POST_TASK(req({ title: "Payout page", description: CLAIM, reward_amount: "30" }), {} as never)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("BANNED_CLAIM")
    expect(body.error.field).toBe("description")
    expect(body.error.message).toContain("double quotes or backticks")
    expect(mockCreateTask).not.toHaveBeenCalled()
  })

  it("creates a task whose spec only MENTIONS the claim it removes", async () => {
    const res = await POST_TASK(req({ title: "Fix the /docs FAQ", description: MENTION, reward_amount: "30" }), {} as never)
    expect(res.status).toBe(201)
    expect(mockCreateTask).toHaveBeenCalledTimes(1)
  })

  it("creates a clean task", async () => {
    const res = await POST_TASK(req({ title: "Formatter test", description: CLEAN, reward_amount: "30" }), {} as never)
    expect(res.status).toBe(201)
  })
})

describe("PATCH /api/v1/tasks/[id]", () => {
  it("400s BANNED_CLAIM on an edited description and never writes", async () => {
    const res = await PATCH_TASK(req({ description: CLAIM }), ctx("1"))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("BANNED_CLAIM")
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })

  it("a reward-only PATCH is never refused — only the fields present are scanned", async () => {
    const res = await PATCH_TASK(req({ reward_amount: "50" }), ctx("1"))
    expect(res.status).toBe(200)
    expect(mockUpdateTask).toHaveBeenCalledTimes(1)
  })
})

describe("POST /api/v1/groups/propose", () => {
  it("400s BANNED_CLAIM on a claim in the name or the description, and never writes", async () => {
    const byName = await POST_PROPOSAL(req({ name: "The Trustless Builders" }), {} as never)
    expect(byName.status).toBe(400)
    const byDesc = await POST_PROPOSAL(req({ name: "Payout builders", description: CLAIM }), {} as never)
    expect(byDesc.status).toBe(400)
    const body = await byDesc.json()
    expect(body.error.code).toBe("BANNED_CLAIM")
    expect(body.error.message).toContain("working group description")
    expect(body.error.message).not.toContain("double quotes")
    expect(mockCreateProposal).not.toHaveBeenCalled()
  })

  it("gives a working group NO quoted-mention exemption — its text is pitch copy", async () => {
    const res = await POST_PROPOSAL(req({ name: "Copy fixers", description: MENTION }), {} as never)
    expect(res.status).toBe(400)
  })

  it("accepts a clean proposal", async () => {
    const res = await POST_PROPOSAL(req({ name: "Copy fixers", description: CLEAN }), {} as never)
    expect(res.status).toBe(201)
    expect(mockCreateProposal).toHaveBeenCalledTimes(1)
  })
})

// docs/guild-task-board.json stays private at the open-source flip — skip in
// the public export, throw in the private tree if it ever goes missing
// (tests/support/private-input.ts).
const PRIV = privateInputs("docs/guild-task-board.json")

describe.skipIf(PRIV.skip)("the task catalogue against this gate (docs/guild-task-board.json)", () => {
  // `acceptance` is an ARRAY in the catalogue. The gate skips non-strings, so passing it raw
  // scanned nothing — join it, which is also how a poster folds it into the posted text.
  type Row = { id: string; title?: string; scope?: string; acceptance?: string[] }
  const rows: Row[] = PRIV.skip ? [] : JSON.parse(readFileSync(join(process.cwd(), "..", "docs", "guild-task-board.json"), "utf8"))

  it("reads a real catalogue (vacuous-pass guard)", () => {
    expect(rows.length).toBeGreaterThan(100)
  })

  // Measured 2026-09-19: exactly one row tripped — P4-07 described a card showing a
  // required tier, unquoted, which is the tier-gating rule's own phrase. It now
  // quotes the label (a mention, which the task gate exempts), so the catalogue is
  // postable as written. This fails LOUDLY if any row stops being.
  it("every row would be accepted if posted as written", () => {
    const refused = rows
      .filter((r) => bannedTaskClaimIn({ title: r.title, description: r.scope, requirements: (r.acceptance ?? []).join("\n") }))
      .map((r) => r.id)
    expect(refused).toEqual([])
  })

  it("P4-07 passes BECAUSE of the quoted mention — unquoted, the same sentence is refused (control)", () => {
    const row = rows.find((r) => r.id === "P4-07")
    expect(row?.scope).toContain('"required tier"')
    expect(bannedTaskClaimIn({ description: row?.scope })).toBeNull()
    expect(bannedTaskClaimIn({ description: row?.scope?.replace(/"/g, "") })?.label).toMatch(/^tier-gating/)
  })
})
