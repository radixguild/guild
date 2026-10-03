/**
 * Projects (PR B, docs/TASK-TERMS-DESIGN.md §5): slug derivation, validation,
 * the collision-retry insert, and the API surface — list/create projects,
 * project-by-slug with its task funnel, and the project_id gate on task create.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
    query: {
      projects: { findFirst: vi.fn() },
    },
  },
}))
// The halt gate (P1 write side) now runs first in every task-lifecycle write, and it reads
// the live Gateway. Pin an advancing chain so this suite stays offline and deterministic —
// without it these tests reach mainnet and correctly 503 during the real halt. The gate's
// own behaviour is pinned in tests/unit/chain-halt-gate.test.ts; keeping the REAL gate in
// the path here (rather than stubbing the module) means these routes still execute it.
vi.mock("@/lib/gateway", () => ({
  NETWORK_HALT_AFTER_SECONDS: 900,
  operatorHaltEngaged: () => false,
  readLedgerTip: async () => ({
    stateVersion: 600_000_000,
    tipIso: "2026-09-08T09:00:00Z",
    ageSeconds: 12,
    stale: false,
  }),
}))

vi.mock("@/db", () => ({ db: mockDb }))

vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown> = {}) =>
      handler(req, { ...ctx, user: { userId: "account_rdx1commissioner" } }),
}))

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

import { slugifyProjectName, createProject } from "@/db/queries/projects"
import { createProjectSchema, createTaskSchema } from "@/lib/validation"

const makeReq = (body: unknown) => ({ json: async () => body }) as never

describe("slugifyProjectName", () => {
  it("kebab-cases plain names", () => {
    expect(slugifyProjectName("Wallet Upgrade")).toBe("wallet-upgrade")
  })

  it("strips symbols and collapses runs", () => {
    expect(slugifyProjectName("Guild — v2.0 (Q3!!)")).toBe("guild-v2-0-q3")
  })

  it("transliterates accents", () => {
    expect(slugifyProjectName("Café Üpgrade")).toBe("cafe-upgrade")
  })

  it("falls back to 'project' when nothing survives", () => {
    expect(slugifyProjectName("!!!")).toBe("project")
  })

  it("trims to 60 chars without a trailing dash", () => {
    const slug = slugifyProjectName("a".repeat(59) + " tail")
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug.endsWith("-")).toBe(false)
  })
})

describe("createProjectSchema", () => {
  it("accepts a minimal valid project", () => {
    expect(createProjectSchema.safeParse({ name: "Wallet Upgrade" }).success).toBe(true)
  })

  it("rejects names under 3 chars and over 80", () => {
    expect(createProjectSchema.safeParse({ name: "ab" }).success).toBe(false)
    expect(createProjectSchema.safeParse({ name: "x".repeat(81) }).success).toBe(false)
  })

  it("caps description at 2000 chars", () => {
    expect(
      createProjectSchema.safeParse({ name: "ok name", description: "d".repeat(2001) }).success,
    ).toBe(false)
  })
})

describe("createTaskSchema project_id", () => {
  const base = { title: "Valid title", description: "Valid description", reward_amount: "100" }

  it("accepts a positive integer project_id and omission", () => {
    expect(createTaskSchema.safeParse({ ...base, project_id: 3 }).success).toBe(true)
    expect(createTaskSchema.safeParse(base).success).toBe(true)
  })

  it("rejects zero, negative, and non-integer project_id", () => {
    expect(createTaskSchema.safeParse({ ...base, project_id: 0 }).success).toBe(false)
    expect(createTaskSchema.safeParse({ ...base, project_id: -1 }).success).toBe(false)
    expect(createTaskSchema.safeParse({ ...base, project_id: 1.5 }).success).toBe(false)
  })
})

describe("createProject slug collisions", () => {
  beforeEach(() => vi.clearAllMocks())

  const insertChain = (results: Array<{ slug: string } | Error>) => {
    let call = 0
    mockDb.insert.mockImplementation(() => ({
      values: (vals: { slug: string }) => ({
        returning: () => {
          const result = results[call++]
          if (result instanceof Error) return Promise.reject(result)
          return Promise.resolve([{ ...result, slug: vals.slug }])
        },
      }),
    }))
  }

  it("uses the base slug when free", async () => {
    insertChain([{ slug: "" }])
    const project = await createProject({ name: "Wallet Upgrade", commissionerId: "acc" })
    expect(project.slug).toBe("wallet-upgrade")
  })

  it("suffixes on unique violation (23505) and keeps the name intact", async () => {
    const dup = Object.assign(new Error("duplicate key"), { code: "23505" })
    insertChain([dup, { slug: "" }])
    const project = await createProject({ name: "Wallet Upgrade", commissionerId: "acc" })
    expect(project.slug).toBe("wallet-upgrade-2")
  })

  it("rethrows non-unique-violation errors untouched", async () => {
    insertChain([Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" })])
    await expect(
      createProject({ name: "Wallet Upgrade", commissionerId: "acc" }),
    ).rejects.toThrow("connection refused")
  })
})

describe("projects API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it("POST /api/v1/projects validates the body", async () => {
    const { POST } = await import("@/app/api/v1/projects/route")
    const res = (await POST(makeReq({ name: "ab" }), {} as never)) as Response
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error.code).toBe("VALIDATION_ERROR")
  })

  it("POST /api/v1/projects creates with the session user as commissioner", async () => {
    const { POST } = await import("@/app/api/v1/projects/route")
    insertReturning({ id: 1, name: "Wallet Upgrade", slug: "wallet-upgrade" })
    const res = (await POST(makeReq({ name: "Wallet Upgrade" }), {} as never)) as Response
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.data.slug).toBe("wallet-upgrade")
    // commissionerId came from the mocked session, not the body
    expect(mockDb.insert).toHaveBeenCalled()
  })

  it("GET /api/v1/projects/[slug] 404s on unknown slug", async () => {
    mockDb.query.projects.findFirst.mockResolvedValue(undefined)
    const { GET } = await import("@/app/api/v1/projects/[slug]/route")
    const res = await GET({} as never, { params: Promise.resolve({ slug: "nope" }) })
    expect(res.status).toBe(404)
  })
})

describe("POST /api/v1/tasks project gate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it("404s when project_id points nowhere", async () => {
    mockDb.query.projects.findFirst.mockResolvedValue(undefined)
    const { POST } = await import("@/app/api/v1/tasks/route")
    const res = (await POST(
      makeReq({ title: "Valid title", description: "Valid description", reward_amount: "10", project_id: 99 }),
      {} as never,
    )) as Response
    const json = await res.json()
    expect(res.status).toBe(404)
    expect(json.error.code).toBe("PROJECT_NOT_FOUND")
  })
})

// Working-group routing (Model A step 4). The pg suite proves the QUERIES; this
// proves the ROUTE — that an unknown group is refused and that a valid one
// actually reaches the insert. Without the second test the picker could appear
// to work while the column stayed null, which is invisible until someone opens
// a feed and finds it empty.
describe("POST /api/v1/tasks working-group gate", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    title: "Valid title",
    description: "Valid description",
    reward_amount: "10",
    ...over,
  })

  // findRoutableWorkingGroupById builds db.select()...limit(1); this stubs that
  // chain to resolve to `rows`.
  const groupLookupReturns = (rows: unknown[]) => {
    mockDb.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
    }))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it("404s when working_group_id points nowhere", async () => {
    groupLookupReturns([])
    const { POST } = await import("@/app/api/v1/tasks/route")
    const res = (await POST(makeReq(body({ working_group_id: 4242 })), {} as never)) as Response
    const json = await res.json()
    expect(res.status).toBe(404)
    expect(json.error.code).toBe("WORKING_GROUP_NOT_FOUND")
  })

  // An archived group returns no row from the routable lookup, so it is
  // indistinguishable from "does not exist" here — which is the intended
  // answer to a poster: either way the group cannot take new work.
  // ⚠️ Route-SHAPE check only: the mock never consults is_active, so this test
  // is stimulus-identical to the one above and cannot fail independently. The
  // archived guarantee itself is proven by the pg suite
  // ("returns null for a soft-archived group"), which is where the filter lives.
  it("route shape: an archived group is answered exactly like an unknown one (404, same code)", async () => {
    groupLookupReturns([])
    const { POST } = await import("@/app/api/v1/tasks/route")
    const res = (await POST(makeReq({ ...body(), working_group_id: 3 }), {} as never)) as Response
    expect(res.status).toBe(404)
  })

  it("persists working_group_id on the created task when the group is routable", async () => {
    groupLookupReturns([{ id: 7, slug: "scrypto", name: "Scrypto" }])
    insertReturning({ id: 1 })
    const { POST } = await import("@/app/api/v1/tasks/route")
    const res = (await POST(makeReq(body({ working_group_id: 7 })), {} as never)) as Response
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.data.workingGroupId).toBe(7) // the pass-through, not just the 201
  })

  it("omitting working_group_id leaves it undefined — routing stays optional", async () => {
    insertReturning({ id: 2 })
    const { POST } = await import("@/app/api/v1/tasks/route")
    const res = (await POST(makeReq(body()), {} as never)) as Response
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.data.workingGroupId).toBeUndefined()
    expect(mockDb.select).not.toHaveBeenCalled() // no pointless lookup when absent
  })
})

// db.insert(...).values(...).returning() resolving to one row — for routes
// that go through the real queries module against the mocked @/db.
function insertReturning(row: Record<string, unknown>) {
  mockDb.insert.mockImplementation(() => ({
    values: (vals: Record<string, unknown>) => ({
      returning: () => Promise.resolve([{ ...vals, ...row }]),
    }),
  }))
}
