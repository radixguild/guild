/**
 * Unit tests for JWT session management and withAuth middleware.
 *
 * Mocks next/headers cookies() and tests JWT creation/verification,
 * session cookie operations, and the withAuth middleware wrapper.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest"

// Mock cookies store
const mockCookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}
vi.mock("next/headers", () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
}))

// withAuth's P1-14 suspension check reads the DB via findUserById — mock it
// so this file stays DB-free. Default (set in beforeEach below) resolves to
// null (no row / not suspended).
const { mockFindUserById } = vi.hoisted(() => ({ mockFindUserById: vi.fn() }))
vi.mock("@/db/queries/users", () => ({
  findUserById: mockFindUserById,
}))

import {
  createSession,
  verifySession,
  setSessionCookie,
  clearSessionCookie,
  getSessionUser,
  withAuth,
} from "@/lib/auth"
import { NextRequest, NextResponse } from "next/server"

const TEST_ADDR = "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw"

// auth.ts lazily reads JWT_SECRET on first use; stub it before any test runs.
beforeAll(() => {
  vi.stubEnv("JWT_SECRET", "test-secret-do-not-use-in-prod")
})

beforeEach(() => {
  mockFindUserById.mockReset().mockResolvedValue(null)
})

describe("auth: createSession + verifySession", () => {
  it("creates a valid JWT that can be verified", async () => {
    const token = await createSession(TEST_ADDR)
    expect(typeof token).toBe("string")
    expect(token.split(".")).toHaveLength(3) // JWT has 3 parts

    const user = await verifySession(token)
    expect(user).not.toBeNull()
    expect(user!.userId).toBe(TEST_ADDR)
  })

  it("returns null for invalid token", async () => {
    const user = await verifySession("invalid.token.here")
    expect(user).toBeNull()
  })

  it("returns null for empty token", async () => {
    const user = await verifySession("")
    expect(user).toBeNull()
  })

  it("returns null for tampered token", async () => {
    const token = await createSession(TEST_ADDR)
    // Tamper with the signature
    const tampered = token.slice(0, -5) + "XXXXX"
    const user = await verifySession(tampered)
    expect(user).toBeNull()
  })
})

describe("auth: setSessionCookie", () => {
  beforeEach(() => {
    mockCookieStore.set.mockClear()
    mockCookieStore.delete.mockClear()
    mockCookieStore.get.mockClear()
  })

  it("sets httpOnly cookie with correct options", async () => {
    const token = await createSession(TEST_ADDR)
    await setSessionCookie(token)

    expect(mockCookieStore.set).toHaveBeenCalledOnce()
    const [name, value, options] = mockCookieStore.set.mock.calls[0]
    expect(name).toBe("guild_session")
    expect(value).toBe(token)
    expect(options.httpOnly).toBe(true)
    expect(options.sameSite).toBe("lax")
    expect(options.path).toBe("/")
    expect(options.maxAge).toBe(7 * 24 * 60 * 60)
  })
})

describe("auth: clearSessionCookie", () => {
  beforeEach(() => {
    mockCookieStore.delete.mockClear()
  })

  it("deletes the session cookie", async () => {
    await clearSessionCookie()
    expect(mockCookieStore.delete).toHaveBeenCalledWith("guild_session")
  })
})

describe("auth: getSessionUser", () => {
  beforeEach(() => {
    mockCookieStore.get.mockClear()
  })

  it("returns null when no cookie exists", async () => {
    mockCookieStore.get.mockReturnValue(undefined)
    const user = await getSessionUser()
    expect(user).toBeNull()
  })

  it("returns user from valid cookie", async () => {
    const token = await createSession(TEST_ADDR)
    mockCookieStore.get.mockReturnValue({ value: token })
    const user = await getSessionUser()
    expect(user).not.toBeNull()
    expect(user!.userId).toBe(TEST_ADDR)
  })

  it("returns null from invalid cookie", async () => {
    mockCookieStore.get.mockReturnValue({ value: "bad-token" })
    const user = await getSessionUser()
    expect(user).toBeNull()
  })
})

describe("auth: withAuth", () => {
  beforeEach(() => {
    mockCookieStore.get.mockClear()
  })

  it("rejects unauthenticated requests with 401", async () => {
    mockCookieStore.get.mockReturnValue(undefined)

    const handler = withAuth(async (_req, { user }) => {
      return NextResponse.json({ ok: true, data: user })
    })

    const req = new NextRequest("http://localhost/api/test")
    const res = await handler(req, { params: Promise.resolve({}) })
    expect(res.status).toBe(401)

    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe("AUTH_REQUIRED")
  })

  it("passes user to handler when authenticated", async () => {
    const token = await createSession(TEST_ADDR)
    mockCookieStore.get.mockReturnValue({ value: token })

    const handler = withAuth(async (_req, { user }) => {
      return NextResponse.json({ ok: true, data: { userId: user.userId } })
    })

    const req = new NextRequest("http://localhost/api/test")
    const res = await handler(req, { params: Promise.resolve({}) })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.userId).toBe(TEST_ADDR)
  })

  // P1-14 (catalogue task 86): app-level account suspension. withAuth is the
  // one enforcement point every authed route passes through — see
  // docs/runbooks/agent-badge-recall.md "Suspend an account (app-level)" for
  // what this does and does not cover on-chain.
  it("rejects a suspended user with 403 ACCOUNT_SUSPENDED and never calls the handler", async () => {
    const token = await createSession(TEST_ADDR)
    mockCookieStore.get.mockReturnValue({ value: token })
    mockFindUserById.mockResolvedValue({
      id: TEST_ADDR,
      suspendedAt: new Date("2026-09-15T00:00:00Z"),
      suspendedReason: "compromised key",
    })

    const handler = vi.fn(async (_req, { user }) => NextResponse.json({ ok: true, data: user }))
    const wrapped = withAuth(handler)

    const req = new NextRequest("http://localhost/api/test")
    const res = await wrapped(req, { params: Promise.resolve({}) })
    expect(res.status).toBe(403)

    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe("ACCOUNT_SUSPENDED")
    expect(handler).not.toHaveBeenCalled()
  })

  it("passes an active user through even though the DB row exists (suspendedAt null)", async () => {
    const token = await createSession(TEST_ADDR)
    mockCookieStore.get.mockReturnValue({ value: token })
    mockFindUserById.mockResolvedValue({ id: TEST_ADDR, suspendedAt: null, suspendedReason: null })

    const handler = withAuth(async (_req, { user }) => NextResponse.json({ ok: true, data: user }))
    const req = new NextRequest("http://localhost/api/test")
    const res = await handler(req, { params: Promise.resolve({}) })

    expect(res.status).toBe(200)
  })
})
