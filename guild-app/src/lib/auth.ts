import "server-only"
import { SignJWT, jwtVerify } from "jose"
import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { fromError } from "./api-response"
import { findUserById } from "@/db/queries/users"
import { crossOriginRefusal } from "./same-origin"

let _jwtSecret: Uint8Array | undefined
function getJwtSecret(): Uint8Array {
  if (!_jwtSecret) {
    const secret = process.env.JWT_SECRET
    if (!secret) {
      throw new Error("JWT_SECRET environment variable is not set")
    }
    _jwtSecret = new TextEncoder().encode(secret)
  }
  return _jwtSecret
}
const COOKIE_NAME = "guild_session"
const SESSION_DURATION = 7 * 24 * 60 * 60 // 7 days in seconds

export interface SessionUser {
  userId: string // Radix address
}

export async function createSession(userId: string): Promise<string> {
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION}s`)
    .sign(getJwtSecret())
}

export async function verifySession(token: string): Promise<SessionUser | null> {
  const secret = getJwtSecret()
  try {
    const { payload } = await jwtVerify(token, secret)
    return { userId: payload.userId as string }
  } catch (err) {
    if (err instanceof Error && err.name === "JWSSignatureVerificationFailed") {
      console.error("JWT signature verification failed — possible token tampering")
    } else if (err instanceof Error && err.name !== "JWTExpired") {
      console.warn("JWT verification failed:", err.message)
    }
    return null
  }
}

export async function setSessionCookie(token: string) {
  const cookieStore = await cookies()
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_DURATION,
    path: "/",
  })
}

// ⚠ Sign-out deletes the cookie in THIS browser only. The JWT itself is not
// revoked: a copy of it (another device, a HAR file, an extension) keeps
// authenticating until its 7-day exp. Killing one session needs a per-user
// session version checked in withAuth (a users column + migration), which is
// not built; today the only levers are suspending the account or rotating
// JWT_SECRET (which signs everyone out).
export async function clearSessionCookie() {
  const cookieStore = await cookies()
  cookieStore.delete(COOKIE_NAME)
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  if (!token) return null
  return verifySession(token)
}

type RouteHandler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<NextResponse>

type AuthenticatedHandler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>>; user: SessionUser },
) => Promise<NextResponse>

// The ONE enforcement point for app-level account suspension (P1-14 /
// catalogue task 86). Every authed route goes through withAuth, so this is
// the single place a suspended address is refused — see
// docs/runbooks/agent-badge-recall.md "suspend an account (app-level)" for
// what this does and (loudly) does not cover: it stops a suspended account's
// use of the SITE/API (this check, plus auth/verify below refusing a new
// session); it CANNOT stop a raw on-chain `claim_task` by that same address
// bypassing the app entirely — the Member badge is `recaller: DenyAll`
// (permanently un-recallable) and the escrow component is permissionless for
// any badge holder. Public read routes never call withAuth, so they stay
// readable regardless of suspension.
export async function isSuspended(userId: string): Promise<boolean> {
  const dbUser = await findUserById(userId)
  return dbUser != null && dbUser.suspendedAt != null
}

export function withAuth(handler: AuthenticatedHandler): RouteHandler {
  return async (req, ctx) => {
    try {
      // CSRF: a cookie-authed write must come from our own pages (see
      // same-origin.ts). Checked before the session so a foreign page learns
      // nothing about the visitor's sign-in state.
      const refused = crossOriginRefusal(req)
      if (refused) return refused
      const user = await getSessionUser()
      if (!user) {
        return NextResponse.json(
          { ok: false, error: { code: "AUTH_REQUIRED", message: "Authentication required" } },
          { status: 401 },
        )
      }
      if (await isSuspended(user.userId)) {
        return NextResponse.json(
          {
            ok: false,
            error: {
              code: "ACCOUNT_SUSPENDED",
              message: "This account has been suspended. Contact the operator for details.",
            },
          },
          { status: 403 },
        )
      }
      return await handler(req, { ...ctx, user })
    } catch (err) {
      return fromError(err)
    }
  }
}
