import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * x402 Track 1 — the PAID/FREE product boundary. RULED 2026-09-02 (operator).
 *
 * WHAT THIS FILE USED TO BE. It asserted that the paid endpoint
 * `GET /api/v1/x402/tasks/funded` and the free `GET /api/v1/tasks?funded=true`
 * were not interchangeable, and it carried an `it.fails` because they WERE: both
 * called the same `listTasks` with the same filters, so 0.05 XRD bought data
 * that was free next door.
 *
 * THE RULING CHOSE OPTION (c): drop the paid tier and delete the route, rather
 * than degrade the free one. The argument, kept here because a test file is
 * where the next person will look for it:
 *
 *   THE BUYER WOULD HAVE BEEN THE WORKER. An agent hunting funded work to claim
 *   is the worker side, and worker legs are free and locked — "worker 0%
 *   forever"; the fee is a poster-side dial. A discovery paywall is a
 *   worker-side fee under another name, and worse than a rake: it is charged
 *   BEFORE any earnings exist, to exactly the participant the A2A-first
 *   priority exists to attract.
 *
 *   That ruled out (a), making the free tier coarser — deliberately degrading
 *   the API agents depend on to protect the smallest revenue line on the board.
 *
 *   It also ruled out (b), selling freshness or live TaskState to workers: in a
 *   first-to-claim market that sells a CLAIM ADVANTAGE. Posters want the best
 *   worker, not the one who paid for a head start.
 *
 * SO THE TRIPWIRE IS NOT DELETED, IT IS REPOINTED. Deleting it would have
 * surrendered the ratchet the moment the defect was resolved. It now guards the
 * ruling instead of the defect: the paid route must stay gone, and nothing
 * unbacked may be advertised. Re-adding a worker-side paid route turns this red,
 * which is the point — it forces whoever does it to reopen the ruling above.
 */

const { mockListTasks } = vi.hoisted(() => ({ mockListTasks: vi.fn() }))

vi.mock("@/db/queries/tasks", () => ({
  listTasks: mockListTasks,
  createTask: vi.fn(),
}))

vi.mock("@/db/queries/projects", () => ({ findProjectById: vi.fn() }))

const PAY_TO = "account_rdx12xm464txr74x9srzmmy5404lyqv650kkgy8ezrx76tmjpl5djvnnwv"
const APP = join(process.cwd(), "src/app")

beforeEach(() => {
  mockListTasks.mockReset()
  mockListTasks.mockResolvedValue({ data: [], cursor: null, hasMore: false })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("the ruling: no worker-side paid route exists", () => {
  it("the funded-tasks paid route is GONE from the tree", () => {
    // A source-level check on purpose. An import-based assertion would pass
    // vacuously the moment the module resolves to something else, and would say
    // nothing about a NEW paid route added beside it.
    expect(existsSync(join(APP, "api/v1/x402/tasks/funded/route.ts"))).toBe(false)
  })

  it("NO route under /api/v1/x402 sells anything to workers", () => {
    // The generalisation, not the instance: the ruling is about worker-side
    // paywalls, not about one path. If an x402 route directory reappears, this
    // fails and the ruling gets re-argued rather than quietly bypassed.
    const dir = join(APP, "api/v1/x402")
    const entries = existsSync(dir) ? readdirSync(dir) : []
    expect(entries).toEqual([])
  })

  it("no module still imports a price for a route that does not exist", async () => {
    const config = await import("@/lib/x402/config")
    expect("FUNDED_TASKS_PRICE_ATOMIC" in config).toBe(false)
  })
})

describe("the manifest advertises nothing unbacked", () => {
  const loadManifest = async () => {
    vi.resetModules()
    return import("@/app/.well-known/x402.json/route")
  }

  it("404s when x402 is disabled", async () => {
    vi.stubEnv("X402_ENABLED", "")
    const { GET } = await loadManifest()
    expect(GET().status).toBe(404)
  })

  it("404s even when x402 is ENABLED and configured — there is nothing to sell", async () => {
    // The case that matters. Turning the flag on must not resurrect an
    // advertisement: with no priced resource, a manifest is a payment surface
    // claiming payments it cannot honour, and `discoverable: true` would have
    // fed that to the Bazaar listing.
    vi.stubEnv("X402_ENABLED", "true")
    vi.stubEnv("X402_PAY_TO", PAY_TO)
    const { GET } = await loadManifest()
    const res = GET()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "not_found" })
  })
})

describe("the free route still serves agents in full", () => {
  // The other half of the ruling, and the half a careless reading would break:
  // dropping the paid tier is only correct if the free one keeps working. These
  // pin the exact query an agent needs — funded, open, ranked by reward — so a
  // later attempt to make the free tier "coarser" fails here.
  const loadFree = async () => {
    vi.resetModules()
    return import("@/app/api/v1/tasks/route")
  }

  // The route's module graph (auth, validation, the working-groups query, the
  // copy gate — only tasks/projects are mocked) costs its whole cold load on
  // the FIRST import: 802ms measured 2026-09-30 with this file run alone,
  // against 19ms for the re-import after vi.resetModules() in the next test;
  // no other test in this file passes 20ms. So it was the import, paid inside
  // the first test below, that this file failed on at vitest's 5000ms default
  // in full-suite runs under peer sessions' concurrent suites (load average up
  // to ~295 on 12 cores). Paid here instead, under the 60s
  // hookTimeout (vitest.config.ts). No testTimeout is raised: each test keeps
  // the default, so a route that genuinely got slow still reddens.
  beforeAll(async () => {
    await import("@/app/api/v1/tasks/route")
  })

  const capturedFilters = () => {
    const call = mockListTasks.mock.calls.at(-1)?.[0] ?? {}
    return Object.fromEntries(Object.entries(call).filter(([, v]) => v !== undefined))
  }

  it("serves funded-only, open, reward-ranked discovery with no payment and no session", async () => {
    const free = await loadFree()
    await free.GET(
      new NextRequest("https://radixguild.com/api/v1/tasks?status=open&funded=true&sort=reward"),
    )
    expect(capturedFilters()).toMatchObject({
      status: "open",
      fundedOnly: true,
      sort: "reward",
    })
  })

  it("does not cap the free tier below what a working agent needs", async () => {
    const free = await loadFree()
    await free.GET(new NextRequest("https://radixguild.com/api/v1/tasks?funded=true&limit=50"))
    const filters = capturedFilters() as { limit?: number }
    // Asserts the request's own limit survives rather than being silently
    // reduced — the concrete shape option (a) would have taken.
    expect(filters.limit).toBe(50)
  })
})
