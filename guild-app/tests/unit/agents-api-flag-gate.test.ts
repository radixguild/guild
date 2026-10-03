import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

/**
 * Every /api/v1/agents/* route sits behind the `agentsAdd` flag
 * (behindAgentsFlag, src/lib/agent-api.ts). Until 2026-10-03 only the "Add an
 * agent" button was gated and the routes answered with the flag off — a pairing
 * code was issued from a browser console that day.
 *
 * This test finds the route files itself (import.meta.glob), so a route added
 * later without the gate fails here rather than shipping open. For each
 * exported handler: flag off → 503 FEATURE_DISABLED and the session is never
 * read (withAuth's handler never runs); flag on → the request reaches withAuth.
 */

const S = vi.hoisted(() => ({ flagOn: false, authReached: 0 }))

vi.mock("@/lib/features", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/features")>()
  return {
    ...actual,
    isEnabled: (f: Parameters<typeof actual.isEnabled>[0]) => (f === "agentsAdd" ? S.flagOn : actual.isEnabled(f)),
  }
})

// withAuth stands in for the session: its handler running means the gate let the
// request through. It never touches the DB or the chain.
vi.mock("@/lib/auth", () => ({
  withAuth: () => async () => {
    S.authReached++
    return NextResponse.json({ ok: true, reached: "withAuth" })
  },
}))

const ROUTES = import.meta.glob("../../src/app/api/v1/agents/**/route.ts")
const METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PATCH", "PUT", "DELETE"] as const

// The one handler that answers differently while off: the kit's live badge mint
// asks GET /agents/me first and proceeds only on AGENT_NOT_PAIRED
// (packages/agent-client/src/mint.ts askGuildPairing), so a 503 there would
// block the badge-first path. Every other handler answers 503 FEATURE_DISABLED.
const OFF_ANSWER: Record<string, { status: number; code: string }> = {
  "GET ../../src/app/api/v1/agents/me/route.ts": { status: 404, code: "AGENT_NOT_PAIRED" },
}
const DEFAULT_OFF = { status: 503, code: "FEATURE_DISABLED" }

async function handlers() {
  const out: { file: string; method: string; fn: (req: NextRequest, ctx: unknown) => Promise<Response> }[] = []
  for (const [file, load] of Object.entries(ROUTES)) {
    const mod = (await load()) as Record<string, unknown>
    for (const m of METHODS) {
      if (typeof mod[m] === "function") out.push({ file, method: m, fn: mod[m] as never })
    }
  }
  return out
}

function call(fn: (req: NextRequest, ctx: unknown) => Promise<Response>, method: string) {
  const req = new NextRequest("https://radixguild.com/api/v1/agents/x", {
    method,
    ...(method === "GET" ? {} : { body: "{}", headers: { "Content-Type": "application/json" } }),
  })
  return fn(req, { params: Promise.resolve({ id: "1", code: "ABCD2345" }) })
}

beforeEach(() => {
  S.authReached = 0
})

describe("/api/v1/agents/* behind the agentsAdd flag", () => {
  it("finds every route file (12 on 2026-10-03) and at least one handler in each", async () => {
    const files = Object.keys(ROUTES)
    expect(files.length).toBeGreaterThanOrEqual(12)
    const hs = await handlers()
    for (const f of files) expect(hs.some((h) => h.file === f), f).toBe(true)
  })

  it("flag off: every handler answers 503 FEATURE_DISABLED (GET /me: 404 AGENT_NOT_PAIRED) and never reads the session", async () => {
    S.flagOn = false
    const hs = await handlers()
    expect(hs.some((h) => `${h.method} ${h.file}` in OFF_ANSWER)).toBe(true)
    for (const h of hs) {
      const want = OFF_ANSWER[`${h.method} ${h.file}`] ?? DEFAULT_OFF
      const res = await call(h.fn, h.method)
      expect(res.status, `${h.method} ${h.file}`).toBe(want.status)
      expect((await res.json()).error.code, `${h.method} ${h.file}`).toBe(want.code)
    }
    expect(S.authReached).toBe(0)
  })

  it("flag on: every handler passes the request on to withAuth", async () => {
    S.flagOn = true
    const hs = await handlers()
    for (const h of hs) {
      const res = await call(h.fn, h.method)
      expect(res.status, `${h.method} ${h.file}`).toBe(200)
      expect((await res.json()).reached, `${h.method} ${h.file}`).toBe("withAuth")
    }
    expect(S.authReached).toBe(hs.length)
  })
})
