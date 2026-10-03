/**
 * Telegram wallet linking — src/lib/tg-link.ts and POST /api/v1/telegram/link-code.
 *
 * The PARITY vectors were produced by the bot's own encoder (guild-public
 * bot/services/verify.js `encodeToken`) and are pinned on both sides. If either
 * repo changes the format, the other one's test fails instead of /link breaking
 * silently in production.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { createHmac } from "node:crypto"

const S = vi.hoisted(() => ({ userId: "account_rdx1" + "b".repeat(54) }))

vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: S.userId } }),
  getSessionUser: vi.fn(),
}))

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  getClientIp: () => "203.0.113.9",
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

import { issueCode, tgLinkSecret, verifyTicket } from "@/lib/tg-link"
import { POST } from "@/app/api/v1/telegram/link-code/route"

const SECRET = "x".repeat(40)
const ADDR = "account_rdx1" + "b".repeat(54)
const T = 1_800_000_000 // unix seconds

const PARITY = {
  ticket: "gl1.eyJrIjoidCIsInRnIjo0MiwiZXhwIjoxODAwMDAwOTAwfQ.mK11sQWyuu-QQtyxeIC4OgbQnXhEqAqplbHnTlB8ULI",
  code:
    "gl1.eyJrIjoiYyIsInRnIjo0MiwiYSI6ImFjY291bnRfcmR4MWJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiIsImV4cCI6MTgwMDAwMDYwMCwibiI6IkFBQUFBQUFBQUFBQUFBQUFBQUFBQUEifQ.pFvOAiMpHtVlo_0TKfSHTOWGrxCIEK-qEMAWcMItarA",
}

// A ticket the way the bot builds one, for arbitrary payloads in the negative cases.
function token(payload: object, secret = SECRET) {
  const body = "gl1." + Buffer.from(JSON.stringify(payload)).toString("base64url")
  return body + "." + createHmac("sha256", secret).update(body).digest("base64url")
}

describe("tg-link format parity with the bot", () => {
  it("accepts the ticket the bot issues", () => {
    expect(verifyTicket(SECRET, PARITY.ticket, T)).toEqual({ ok: true, tgId: 42 })
  })

  it("issues byte-for-byte the code the bot expects", () => {
    const { code, expiresAt } = issueCode(SECRET, { tgId: 42, address: ADDR, nowS: T, nonce: "A".repeat(22) })
    expect(expiresAt).toBe(T + 600)
    expect(code).toBe(PARITY.code)
  })
})

describe("verifyTicket", () => {
  it("rejects a wrong secret and a tampered payload", () => {
    expect(verifyTicket("y".repeat(40), PARITY.ticket, T)).toEqual({ ok: false, reason: "bad-signature" })
    const [, , sig] = PARITY.ticket.split(".")
    const forged = "gl1." + Buffer.from(JSON.stringify({ k: "t", tg: 43, exp: T + 900 })).toString("base64url") + "." + sig
    expect(verifyTicket(SECRET, forged, T)).toEqual({ ok: false, reason: "bad-signature" })
  })

  it("rejects a code presented as a ticket", () => {
    expect(verifyTicket(SECRET, PARITY.code, T)).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects expired and too-far-future tickets", () => {
    expect(verifyTicket(SECRET, token({ k: "t", tg: 42, exp: T }), T).ok).toBe(false)
    expect(verifyTicket(SECRET, token({ k: "t", tg: 42, exp: T + 16 * 60 }), T).ok).toBe(false)
  })

  it("rejects non-integer and non-positive TG ids, and junk", () => {
    for (const tg of [0, -1, 4.2, "42", null]) {
      expect(verifyTicket(SECRET, token({ k: "t", tg, exp: T + 60 }), T)).toEqual({ ok: false, reason: "malformed" })
    }
    expect(verifyTicket(SECRET, "hello", T)).toEqual({ ok: false, reason: "malformed" })
  })
})

describe("tgLinkSecret", () => {
  it("is off without a secret or with one under 32 chars", () => {
    expect(tgLinkSecret({} as NodeJS.ProcessEnv)).toBeNull()
    expect(tgLinkSecret({ TG_LINK_SECRET: "short" } as unknown as NodeJS.ProcessEnv)).toBeNull()
    expect(tgLinkSecret({ TG_LINK_SECRET: SECRET } as unknown as NodeJS.ProcessEnv)).toBe(SECRET)
  })
})

describe("POST /api/v1/telegram/link-code", () => {
  const req = (body: unknown) => ({ json: async () => body, headers: new Headers() }) as never
  const call = async (body: unknown) => {
    const res = await POST(req(body), { params: Promise.resolve({}) })
    return { status: res.status, json: await res.json() }
  }

  beforeEach(() => {
    process.env.TG_LINK_SECRET = SECRET
    S.userId = ADDR
    vi.useRealTimers()
  })

  it("503 when linking is not configured", async () => {
    delete process.env.TG_LINK_SECRET
    const r = await call({ ticket: PARITY.ticket })
    expect(r.status).toBe(503)
  })

  it("issues a code for the SESSION's address, ignoring any address in the body", async () => {
    vi.useFakeTimers({ now: T * 1000 })
    const r = await call({ ticket: PARITY.ticket, address: "account_rdx1" + "a".repeat(54) })
    expect(r.status).toBe(200)
    expect(r.json.data.address).toBe(ADDR)
    const payload = JSON.parse(Buffer.from(r.json.data.code.split(".")[1], "base64url").toString())
    expect(payload).toMatchObject({ k: "c", tg: 42, a: ADDR, exp: T + 600 })
  })

  it("refuses a persona session (not an account address)", async () => {
    S.userId = "identity_rdx1" + "c".repeat(54)
    const r = await call({ ticket: PARITY.ticket })
    expect(r.status).toBe(403)
  })

  it("410 on an expired ticket, 400 on a forged or missing one", async () => {
    vi.useFakeTimers({ now: (T + 901) * 1000 })
    expect((await call({ ticket: PARITY.ticket })).status).toBe(410)
    vi.useFakeTimers({ now: T * 1000 })
    expect((await call({ ticket: token({ k: "t", tg: 42, exp: T + 60 }, "z".repeat(40)) })).status).toBe(400)
    expect((await call({})).status).toBe(400)
    expect((await call(null)).status).toBe(400)
  })
})
