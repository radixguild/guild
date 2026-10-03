/**
 * P1-14 (catalogue task 86) — app-level account suspension, end to end
 * against a real (pglite) Postgres-shaped `users` table.
 *
 * Exercises the REAL functions the enforcement depends on, unmocked:
 *   - withAuth (src/lib/auth.ts) — the one place every authed route passes
 *     through. Wraps a trivial passthrough handler here, exactly the way a
 *     real route uses it (e.g. src/app/api/v1/game/state/route.ts:
 *     `export const GET = withAuth(async (_req, { user }) => ...)`).
 *   - POST /api/v1/auth/verify (src/app/api/v1/auth/verify/route.ts) — the
 *     REAL route handler. Only the ROLA wallet-signature check is mocked;
 *     nothing about suspension lives in ROLA.
 *   - findOrCreateUser / findUserById (src/db/queries/users.ts) — REAL,
 *     run against pglite, proving `onConflictDoNothing` never un-suspends
 *     an existing row and a brand-new address is never born suspended.
 *
 * Only `@/db`, `next/headers`'s cookies(), and `@/lib/rola` are mocked.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { eq } from "drizzle-orm"
import * as schema from "@/db/schema"
import { users } from "@/db/schema"
import { NextRequest, NextResponse } from "next/server"

// `withAuth`'s suspension check (findUserById) and auth/verify's
// findOrCreateUser both read `db` from "@/db" — point it at the pglite-backed
// drizzle instance, same proxy trick as task-visibility-routes.pg.test.ts. The
// proxy binds methods to the real instance so drizzle's `this` is preserved.
const H = vi.hoisted(() => ({ db: null as ReturnType<typeof drizzle> | null }))
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get(_t, prop) {
        const target = H.db as unknown as Record<string | symbol, unknown>
        const v = target?.[prop]
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(H.db) : v
      },
    },
  ),
}))

// A real, mutable cookie jar. createSession/setSessionCookie/getSessionUser
// (all real, imported below) and withAuth (real) all read/write through this
// exactly like a browser's cookie store would — nothing about session
// handling is mocked, only the Next.js `cookies()` accessor itself.
const cookieJar = new Map<string, string>()
const mockCookieStore = {
  get: vi.fn((name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name)! } : undefined)),
  set: vi.fn((name: string, value: string) => {
    cookieJar.set(name, value)
  }),
  delete: vi.fn((name: string) => {
    cookieJar.delete(name)
  }),
}
vi.mock("next/headers", () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
}))

// The only thing about auth/verify NOT exercised for real: the actual wallet
// signature check (needs a live Radix key pair). Everything downstream of it
// — findOrCreateUser, the suspension check, createSession, setSessionCookie —
// is real.
const { mockVerifyAndConsume } = vi.hoisted(() => ({ mockVerifyAndConsume: vi.fn() }))
vi.mock("@/lib/rola", () => ({ verifyAndConsume: mockVerifyAndConsume }))

import { withAuth, createSession } from "@/lib/auth"
import { POST as verifyPOST } from "@/app/api/v1/auth/verify/route"

// Standalone `users` DDL (this file has no migration step to run against a
// bare pglite instance). Columns mirror src/db/schema/users.ts exactly.
const DDL = `
CREATE TABLE users (
  id text PRIMARY KEY,
  display_name text,
  badge_id text,
  badge_tier text DEFAULT 'member',
  xp integer NOT NULL DEFAULT 0,
  reputation integer NOT NULL DEFAULT 0,
  is_agent boolean NOT NULL DEFAULT false,
  suspended_at timestamptz,
  suspended_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);`

let pg: PGlite
let db: ReturnType<typeof drizzle>

const ACTIVE = "account_rdx1active_user_p114"
const SUSPENDED = "account_rdx1suspended_user_p114"

function validSignedChallenge(address: string) {
  return {
    challenge: "c".repeat(64),
    address,
    proof: { publicKey: "pk", signature: "sig", curve: "curve25519" as const },
    type: "account" as const,
  }
}

function verifyReq(address: string) {
  return new NextRequest("http://localhost/api/v1/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signed_challenge: validSignedChallenge(address) }),
  })
}

async function sessionCookieFor(address: string) {
  return createSession(address)
}

describe("account suspension (P1-14 / task 86) — real withAuth + real auth/verify against pglite", () => {
  // 60s: see escrow-confirm-parity.pg.test.ts / task-pagination.pg.test.ts —
  // concurrent WASM-Postgres init under a full-suite run exceeds the 10s
  // default.
  beforeAll(async () => {
    vi.stubEnv("JWT_SECRET", "test-secret-do-not-use-in-prod")
    pg = new PGlite()
    db = drizzle(pg, { schema })
    H.db = db
    await pg.exec(DDL)
  }, 60_000)

  beforeEach(async () => {
    vi.clearAllMocks()
    cookieJar.clear()
    await pg.exec("TRUNCATE users")
    await db.insert(users).values([
      { id: ACTIVE, suspendedAt: null, suspendedReason: null },
      {
        id: SUSPENDED,
        suspendedAt: new Date("2026-09-15T00:00:00Z"),
        suspendedReason: "compromised key",
      },
    ])
  })

  describe("withAuth — the one enforcement point every authed route passes through", () => {
    it("refuses a suspended user with 403 ACCOUNT_SUSPENDED, never reaching the handler", async () => {
      const handler = vi.fn(async () => NextResponse.json({ ok: true }))
      cookieJar.set("guild_session", await sessionCookieFor(SUSPENDED))

      const wrapped = withAuth(handler)
      const res = await wrapped({} as NextRequest, { params: Promise.resolve({}) })

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.ok).toBe(false)
      expect(body.error.code).toBe("ACCOUNT_SUSPENDED")
      expect(handler).not.toHaveBeenCalled()
    })

    it("passes an active user through to the handler unchanged", async () => {
      const handler = vi.fn(async (_req: NextRequest, ctx: { user: { userId: string } }) =>
        NextResponse.json({ ok: true, data: { userId: ctx.user.userId } }),
      )
      cookieJar.set("guild_session", await sessionCookieFor(ACTIVE))

      const wrapped = withAuth(handler)
      const res = await wrapped({} as NextRequest, { params: Promise.resolve({}) })

      expect(res.status).toBe(200)
      expect(handler).toHaveBeenCalledOnce()
      const body = await res.json()
      expect(body.data.userId).toBe(ACTIVE)
    })
  })

  describe("POST /api/v1/auth/verify — refuses to mint a session for a suspended address", () => {
    it("suspended address: 403 ACCOUNT_SUSPENDED, no session cookie is ever set", async () => {
      mockVerifyAndConsume.mockResolvedValue({ ok: true, address: SUSPENDED })

      const res = await verifyPOST(verifyReq(SUSPENDED))

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.ok).toBe(false)
      expect(body.error.code).toBe("ACCOUNT_SUSPENDED")
      expect(mockCookieStore.set).not.toHaveBeenCalled()
    })

    it("active address: 200, session cookie set, the user row is returned", async () => {
      mockVerifyAndConsume.mockResolvedValue({ ok: true, address: ACTIVE })

      const res = await verifyPOST(verifyReq(ACTIVE))

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.data.user.id).toBe(ACTIVE)
      expect(mockCookieStore.set).toHaveBeenCalledOnce()
    })

    it("a brand-new address is created and is NOT suspended — findOrCreateUser never suspends on insert", async () => {
      const FRESH = "account_rdx1brand_new_p114"
      mockVerifyAndConsume.mockResolvedValue({ ok: true, address: FRESH })

      const res = await verifyPOST(verifyReq(FRESH))

      expect(res.status).toBe(200)
      const row = await db.query.users.findFirst({ where: eq(users.id, FRESH) })
      expect(row?.suspendedAt ?? null).toBeNull()
    })
  })

  describe("lift restores access — the same write suspend-account.mjs --lift performs", () => {
    it("clearing suspended_at lets a previously-suspended address through withAuth and verify again", async () => {
      await db
        .update(users)
        .set({ suspendedAt: null, suspendedReason: null })
        .where(eq(users.id, SUSPENDED))

      const handler = vi.fn(async () => NextResponse.json({ ok: true }))
      cookieJar.set("guild_session", await sessionCookieFor(SUSPENDED))
      const authRes = await withAuth(handler)({} as NextRequest, { params: Promise.resolve({}) })
      expect(authRes.status).toBe(200)
      expect(handler).toHaveBeenCalledOnce()

      mockVerifyAndConsume.mockResolvedValue({ ok: true, address: SUSPENDED })
      const verifyRes = await verifyPOST(verifyReq(SUSPENDED))
      expect(verifyRes.status).toBe(200)
    })
  })
})
