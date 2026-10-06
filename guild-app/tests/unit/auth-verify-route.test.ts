// @vitest-environment node
// (Origin must survive into the NextRequest; happy-dom's Request drops it.)
/**
 * POST /api/v1/auth/verify — two refusals that sit in the route itself:
 *   - a persona proof (identity_rdx1…) verifies under ROLA but must not mint a
 *     session or a users row: every userId downstream is read as an ACCOUNT;
 *   - login CSRF: a foreign-origin page posting its own valid proof must not
 *     sign the visitor in.
 * ROLA itself is mocked (it needs a live key pair); everything after it is real.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockCookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() }
vi.mock("next/headers", () => ({ cookies: vi.fn(() => Promise.resolve(mockCookieStore)) }))
const { mockVerifyAndConsume, mockFindOrCreateUser } = vi.hoisted(() => ({
  mockVerifyAndConsume: vi.fn(),
  mockFindOrCreateUser: vi.fn(),
}))
vi.mock("@/lib/rola", () => ({ verifyAndConsume: mockVerifyAndConsume }))
vi.mock("@/db/queries/users", () => ({
  findOrCreateUser: mockFindOrCreateUser,
  findUserById: vi.fn().mockResolvedValue(null),
}))

import { POST } from "@/app/api/v1/auth/verify/route"

const ACCOUNT = "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw"
const PERSONA = "identity_rdx12tgzjrz9u0xz4l28vf04hz87eguclmfaq4d2p8f8lv7zg9ssnzku8j"

function verifyReq(address: string, type: "account" | "persona", headers: Record<string, string> = {}) {
  return new NextRequest("https://radixguild.com/api/v1/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json", host: "radixguild.com", ...headers },
    body: JSON.stringify({
      signed_challenge: {
        challenge: "c".repeat(64),
        address,
        proof: { publicKey: "pk", signature: "sig", curve: "curve25519" },
        type,
      },
    }),
  })
}

beforeAll(() => {
  vi.stubEnv("JWT_SECRET", "test-secret-do-not-use-in-prod")
})

beforeEach(() => {
  vi.clearAllMocks()
  mockFindOrCreateUser.mockImplementation(async (id: string) => ({ id, suspendedAt: null }))
})

describe("POST /api/v1/auth/verify — accounts only", () => {
  it("a ROLA-valid PERSONA proof gets 400 ACCOUNT_REQUIRED, no users row and no session cookie", async () => {
    mockVerifyAndConsume.mockResolvedValue({ ok: true, address: PERSONA })
    const res = await POST(verifyReq(PERSONA, "persona"))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("ACCOUNT_REQUIRED")
    expect(mockFindOrCreateUser).not.toHaveBeenCalled()
    expect(mockCookieStore.set).not.toHaveBeenCalled()
  })

  it("an account proof signs in (row + cookie)", async () => {
    mockVerifyAndConsume.mockResolvedValue({ ok: true, address: ACCOUNT })
    const res = await POST(verifyReq(ACCOUNT, "account", { origin: "https://radixguild.com" }))
    expect(res.status).toBe(200)
    expect(mockFindOrCreateUser).toHaveBeenCalledWith(ACCOUNT)
    expect(mockCookieStore.set).toHaveBeenCalledOnce()
  })
})

describe("POST /api/v1/auth/verify — login CSRF", () => {
  it("a sibling-subdomain page posting a valid proof gets 403 BAD_ORIGIN; ROLA is never consulted", async () => {
    mockVerifyAndConsume.mockResolvedValue({ ok: true, address: ACCOUNT })
    const res = await POST(verifyReq(ACCOUNT, "account", { origin: "https://memegrid.radixguild.com" }))
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe("BAD_ORIGIN")
    expect(mockVerifyAndConsume).not.toHaveBeenCalled()
    expect(mockCookieStore.set).not.toHaveBeenCalled()
  })

  it("the agent kit (no Origin header) still signs in", async () => {
    mockVerifyAndConsume.mockResolvedValue({ ok: true, address: ACCOUNT })
    const res = await POST(verifyReq(ACCOUNT, "account"))
    expect(res.status).toBe(200)
  })
})
