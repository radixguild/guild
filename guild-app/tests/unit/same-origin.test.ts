// @vitest-environment node
// (happy-dom's Request drops the browser-forbidden Origin / Host / Sec-Fetch-*
// headers, which are exactly what this file sets — Node's undici keeps them.)
/**
 * CSRF gate for cookie-authenticated writes (src/lib/same-origin.ts), and its
 * wiring into withAuth: a sibling subdomain shares the site, so SameSite=Lax
 * still sends the session cookie on its no-cors POSTs. The Origin header is
 * what tells those apart from our own pages.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const mockCookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() }
vi.mock("next/headers", () => ({ cookies: vi.fn(() => Promise.resolve(mockCookieStore)) }))
const { mockFindUserById } = vi.hoisted(() => ({ mockFindUserById: vi.fn() }))
vi.mock("@/db/queries/users", () => ({ findUserById: mockFindUserById }))

import { isSameOriginWrite, crossOriginRefusal } from "@/lib/same-origin"
import { createSession, withAuth } from "@/lib/auth"

const SITE = "https://radixguild.com"
const SIBLING = "https://memegrid.radixguild.com"
const TEST_ADDR = "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw"

function req(method: string, headers: Record<string, string> = {}, url = `${SITE}/api/v1/tasks`) {
  return new NextRequest(url, { method, headers: { host: new URL(url).host, ...headers } })
}

beforeAll(() => {
  vi.stubEnv("JWT_SECRET", "test-secret-do-not-use-in-prod")
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv("JWT_SECRET", "test-secret-do-not-use-in-prod")
})

describe("isSameOriginWrite", () => {
  it("refuses a POST from a sibling subdomain (same site, different origin)", () => {
    expect(isSameOriginWrite(req("POST", { origin: SIBLING }))).toBe(false)
  })

  it("refuses a POST from an unrelated site and from an opaque 'null' origin", () => {
    expect(isSameOriginWrite(req("POST", { origin: "https://evil.example" }))).toBe(false)
    expect(isSameOriginWrite(req("POST", { origin: "null" }))).toBe(false)
  })

  it("refuses PATCH and DELETE from a foreign origin too", () => {
    expect(isSameOriginWrite(req("PATCH", { origin: SIBLING }))).toBe(false)
    expect(isSameOriginWrite(req("DELETE", { origin: SIBLING }))).toBe(false)
  })

  it("allows a POST from the site's own origin", () => {
    expect(isSameOriginWrite(req("POST", { origin: SITE }))).toBe(true)
  })

  it("allows a POST whose Origin matches the request's own Host (dev / CI / e2e, no config)", () => {
    const local = req("POST", { origin: "http://localhost:3100" }, "http://localhost:3100/api/v1/tasks")
    expect(isSameOriginWrite(local)).toBe(true)
  })

  it("refuses a foreign Origin even when the Host is ours (the attack shape)", () => {
    const r = req("POST", { origin: SIBLING, host: "radixguild.com" })
    expect(isSameOriginWrite(r)).toBe(false)
  })

  it("allows a POST with no Origin at all (agent kit, curl, server-to-server)", () => {
    expect(isSameOriginWrite(req("POST"))).toBe(true)
  })

  it("refuses an Origin-less POST that a browser marked cross-site or same-site", () => {
    expect(isSameOriginWrite(req("POST", { "sec-fetch-site": "cross-site" }))).toBe(false)
    expect(isSameOriginWrite(req("POST", { "sec-fetch-site": "same-site" }))).toBe(false)
    expect(isSameOriginWrite(req("POST", { "sec-fetch-site": "same-origin" }))).toBe(true)
  })

  it("never gates reads: GET and HEAD with a foreign Origin pass", () => {
    expect(isSameOriginWrite(req("GET", { origin: SIBLING }))).toBe(true)
    expect(isSameOriginWrite(req("HEAD", { origin: SIBLING }))).toBe(true)
  })

  it("honours the operator's GUILD_ALLOWED_ORIGINS list", () => {
    vi.stubEnv("GUILD_ALLOWED_ORIGINS", "https://staging.example, https://other.example")
    expect(isSameOriginWrite(req("POST", { origin: "https://staging.example" }))).toBe(true)
    expect(isSameOriginWrite(req("POST", { origin: SIBLING }))).toBe(false)
  })

  it("answers a refusal with 403 BAD_ORIGIN", async () => {
    const res = crossOriginRefusal(req("POST", { origin: SIBLING }))
    expect(res?.status).toBe(403)
    expect((await res!.json()).error.code).toBe("BAD_ORIGIN")
    expect(crossOriginRefusal(req("POST", { origin: SITE }))).toBeNull()
  })
})

describe("withAuth enforces the origin gate", () => {
  beforeEach(async () => {
    mockFindUserById.mockReset().mockResolvedValue(null)
    mockCookieStore.get.mockReturnValue({ value: await createSession(TEST_ADDR) })
  })

  const ctx = { params: Promise.resolve({}) }

  it("a signed-in visitor's cookie riding a sibling-subdomain POST never reaches the handler", async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }))
    const res = await withAuth(handler)(req("POST", { origin: SIBLING, "content-type": "text/plain" }), ctx)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe("BAD_ORIGIN")
    expect(handler).not.toHaveBeenCalled()
  })

  it("the same POST from our own origin runs", async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }))
    const res = await withAuth(handler)(req("POST", { origin: SITE }), ctx)
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it("an Origin-less POST (the agent kit) runs", async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }))
    const res = await withAuth(handler)(req("POST"), ctx)
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it("a GET with a foreign Origin runs (reads are not gated)", async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }))
    const res = await withAuth(handler)(req("GET", { origin: SIBLING }), ctx)
    expect(res.status).toBe(200)
  })
})
