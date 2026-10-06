import { NextResponse } from "next/server"
import { SITE_URL } from "@/lib/config"

/**
 * Same-origin gate for cookie-authenticated writes (CSRF).
 *
 * The session cookie is SameSite=Lax. "Site" is the registrable domain, so a
 * sibling subdomain (any other app under the same domain) counts as the SAME
 * site and the browser attaches the cookie to its requests. A plain-text
 * `fetch(..., { mode: "no-cors", credentials: "include" })` from such a page is
 * a "simple" request: no preflight, and the route's `req.json()` parses the
 * body anyway. The cookie alone cannot tell that request from our own UI; the
 * Origin header can.
 *
 * Rule, for state-changing methods only (POST/PUT/PATCH/DELETE):
 *   - Origin present → it must be one of ours (below), else 403 BAD_ORIGIN.
 *     "null" (sandboxed frames, some redirects) is never ours.
 *   - Origin absent → a browser sends Origin on every non-GET fetch, so an
 *     absent one means a non-browser caller (the agent kit, curl, the bot).
 *     Those hold the cookie themselves; there is no ambient credential to
 *     ride. Allowed — unless Sec-Fetch-Site says the request came from another
 *     site or a sibling subdomain, which only a browser sends.
 *
 * "Ours" = the request's own Host (how dev, CI and e2e work with no config),
 * the canonical SITE_URL origin, the ROLA expected origin, and any origins the
 * operator lists in GUILD_ALLOWED_ORIGINS (comma-separated, full origins).
 * There are no CORS headers anywhere in this app, so no legitimate browser
 * caller lives on another origin today.
 */

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

function originOf(value: string | undefined | null): string | null {
  if (!value) return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function allowedOrigins(): Set<string> {
  const out = new Set<string>()
  for (const v of [SITE_URL, process.env.ROLA_EXPECTED_ORIGIN || "https://radixguild.com"]) {
    const o = originOf(v)
    if (o) out.add(o)
  }
  for (const raw of (process.env.GUILD_ALLOWED_ORIGINS ?? "").split(",")) {
    const o = originOf(raw.trim())
    if (o) out.add(o)
  }
  return out
}

interface HeaderSource {
  method?: string
  headers?: { get(name: string): string | null }
}

/** True when this request may proceed as far as the origin is concerned. */
export function isSameOriginWrite(req: HeaderSource): boolean {
  const method = (req.method ?? "GET").toUpperCase()
  if (!UNSAFE_METHODS.has(method)) return true
  const headers = req.headers
  if (!headers || typeof headers.get !== "function") return true // no headers = no browser

  const origin = headers.get("origin")
  if (origin === null) {
    const site = headers.get("sec-fetch-site")
    return site !== "cross-site" && site !== "same-site"
  }

  const parsed = originOf(origin)
  if (!parsed) return false // "null" or garbage
  if (allowedOrigins().has(parsed)) return true
  const host = headers.get("host")
  return host !== null && new URL(parsed).host === host.toLowerCase()
}

/** The 403 the gate answers with, or null when the request may proceed. */
export function crossOriginRefusal(req: HeaderSource): NextResponse | null {
  if (isSameOriginWrite(req)) return null
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "BAD_ORIGIN",
        message: "Refused: this write did not come from this site's own pages.",
      },
    },
    { status: 403 },
  )
}
