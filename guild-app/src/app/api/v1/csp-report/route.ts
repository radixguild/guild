/**
 * POST /api/v1/csp-report — sink for the browser's own CSP violation reports.
 *
 * next.config.ts's CSP header (added #586 as `Content-Security-Policy-Report-Only`,
 * ENFORCED since 2026-09-30; it reports here via `report-uri`) had no sink since it shipped:
 * report-only means a violating browser only ever printed the violation to its
 * own devtools console. This endpoint IS that sink, nothing more — it logs one
 * compact line per violation and returns. It never gates, blocks, or stores
 * anything, and a bug here must never be able to fail the page it reports for
 * (see the fail-open shape of every branch below: worst case is a 4xx/5xx the
 * reporting browser silently drops).
 *
 * ── Two request shapes, because two delivery mechanisms exist ──────────────
 * Legacy `report-uri` (CSP directive; still the only one some engines send):
 *   Content-Type: application/csp-report
 *   Body: { "csp-report": { "document-uri", "violated-directive",
 *           "effective-directive", "blocked-uri", "source-file",
 *           "line-number", "column-number", "disposition", ... } }
 * Reporting API `report-to` (batches multiple violations into one POST):
 *   Content-Type: application/reports+json
 *   Body: [ { "type": "csp-violation", "body": { "documentURL",
 *           "effectiveDirective", "blockedURL", "sourceFile", "lineNumber",
 *           "columnNumber", "disposition", ... } }, ... ]
 * Both shapes stay accepted. But since 2026-09-30 next.config.ts sets
 * `report-uri` ONLY. The 0914 header also set `report-to`, "so whichever
 * mechanism a browser implements is covered". Measured, Chromium ignores
 * report-uri whenever report-to is present, and then delivered nothing to
 * this route over the Reporting API (0 of 3 live probes). next.config.ts has
 * the numbers. The `reports+json` branch is kept for a future report-to that
 * comes with a delivery measurement.
 *
 * ── Why this route is never itself blocked by the policy it reports for ────
 * `connect-src 'self'` already permits a same-origin POST here even once CSP
 * moves from report-only to enforcing. That permission is moot anyway: per
 * spec, a browser's CSP/Reporting-API report delivery is NOT subject to the
 * page's own CSP at all — it is the user agent reporting ON the policy, not a
 * page-initiated fetch the policy could logically gate — and every shipping
 * implementation follows that. Noted here so a future pass doesn't "fix" a
 * phantom gap by loosening connect-src for this path.
 *
 * ── What is logged, and the privacy line ────────────────────────────────────
 * document-uri / source-file: origin + path only, query string stripped — a
 * query string can carry a session token, a password-reset code, anything a
 * developer happened to put in a URL, and this endpoint has no business
 * retaining any of it. blocked-uri: origin + path for ANY value that parses
 * with an authority — not just http(s); ws/wss/ftp/anything-with-a-host get
 * the same stripping (a `wss://…?token=…` websocket is a real value here —
 * see next.config.ts's connect-src), so a query string never survives
 * regardless of scheme. The literal value for the CSP keywords/opaque
 * tokens a browser sends when there IS no authority ('inline', 'eval',
 * 'data', 'blob', 'self', 'wasm-eval', 'about') — there is nothing to strip,
 * and the literal IS the signal.
 * violated/effective directive, line, column, disposition: passed through as
 * given. NEVER logged: User-Agent, cookies, Referrer, the raw report body, or
 * any other request header. NEVER written to the DB — this is an operational
 * signal read from process logs, not a data model.
 *
 * ── Auth / CORS ──────────────────────────────────────────────────────────
 * No auth: browsers send CSP/Reporting-API reports unauthenticated, with no
 * custom headers and no credentials, by spec — the user agent controls this
 * request, not page script, so there is no session to require. src/proxy.ts's
 * matcher (`/api/:path*`) covers this path but only ever ADDS response
 * headers (X-Content-Type-Options etc.) — it never checks a session and never
 * sets a CORS header, so nothing there blocks or needs adjusting for this
 * route. No CORS headers are added here either: the report is always
 * same-origin (the browser is reporting on radixguild.com's own policy TO
 * radixguild.com), so none are needed — adding permissive CORS to a POST
 * endpoint no other origin has legitimate reason to call would only widen the
 * attack surface for free.
 *
 * Promotion path (report-only → enforcing) and how to read these logs on the
 * box: docs/HARDENING-API.md §7.
 */
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { z } from "zod"
import { logger } from "@/lib/hardening/logger"
import { createRateLimiter, getClientIp, rateLimitResponse } from "@/lib/rate-limit"

// ---- limits ----------------------------------------------------------------
// A real violation report is a few hundred bytes. 64KB is generous headroom
// for a large `script-sample`/long URLs while still rejecting anything that
// looks like someone using this endpoint as a free upload sink.
const MAX_BODY_BYTES = 64 * 1024
// The Reporting API batches multiple violations into one POST. Capping the
// batch bounds the worst-case log fan-out a single request can cause;
// rejecting an oversized batch (rather than silently truncating it) keeps the
// contract legible — a client either fits or gets a 400 it can act on.
const MAX_REPORTS_PER_REQUEST = 20
// ~2KB per string field: generous for a URL, directive list or script sample,
// tight enough that a field can't be used to smuggle an arbitrarily large
// payload through what is supposed to be a small structured report.
const MAX_FIELD_LEN = 2048

// Per-IP token bucket — the same primitive every other public route in this
// app uses (createRateLimiter from @/lib/rate-limit; see auth/challenge,
// tasks, funding-pools). 60/min per IP is generous for a page that legitimately
// fires a handful of violations on load across a few tabs, while still
// bounding a scripted flood aimed at this one endpoint.
const limiter = createRateLimiter({ windowMs: 60_000, max: 60 })

// Loose on purpose: every field is optional, unknown extra keys survive via
// `.passthrough()`, and a string is capped rather than pattern-matched. This
// is a report FROM the browser about ITS OWN policy — the shape is dictated by
// engines we don't control, evolves without our input, and a schema strict
// enough to reject a field a future Chrome adds would silently start
// dropping every report from that Chrome, which defeats the endpoint's whole
// purpose. The 64KB body cap and 2KB per-field cap are the actual defenses
// here, not shape strictness.
const field = z.union([z.string().max(MAX_FIELD_LEN), z.number(), z.null()]).optional()

// Legacy `report-uri` shape — kebab-case keys are per the (obsolete but still
// sent) CSP3 reporting spec, not a style choice.
const legacyReportSchema = z
  .object({
    "csp-report": z
      .object({
        "document-uri": field,
        referrer: field,
        "violated-directive": field,
        "effective-directive": field,
        "original-policy": field,
        disposition: field,
        "blocked-uri": field,
        "line-number": field,
        "column-number": field,
        "source-file": field,
        "status-code": field,
        "script-sample": field,
      })
      .passthrough(),
  })
  .passthrough()

// Reporting API `report-to` shape — always an array, one entry per violation.
const reportingApiEntrySchema = z
  .object({
    type: z.string().max(64).optional(),
    age: z.number().optional(),
    url: field,
    // Accepted (browsers send it) but NEVER logged — see the file doc above.
    user_agent: z.string().max(MAX_FIELD_LEN).optional(),
    body: z
      .object({
        documentURL: field,
        referrer: field,
        disposition: field,
        effectiveDirective: field,
        blockedURL: field,
        sourceFile: field,
        lineNumber: field,
        columnNumber: field,
        originalPolicy: field,
        sample: field,
        statusCode: field,
      })
      .passthrough(),
  })
  .passthrough()

const reportingApiSchema = z.array(reportingApiEntrySchema).max(MAX_REPORTS_PER_REQUEST)

interface NormalizedViolation {
  documentUri: string | null
  violatedDirective: string | null
  effectiveDirective: string | null
  blockedUri: string | null
  sourceFile: string | null
  line: number | string | null
  column: number | string | null
  disposition: string | null
}

/** Strip query/hash, keep origin+path. Falls back to a length-capped raw
 *  string when the value isn't a parseable absolute URL (some engines report
 *  a bare path for a same-document navigation). */
function originAndPath(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null
  try {
    const u = new URL(value)
    return `${u.origin}${u.pathname}`
  } catch {
    // Not a parseable absolute URL (e.g. a bare path from a same-document
    // navigation). Still enforce the query/hash-stripping guarantee: cut at
    // the first '?' or '#' before capping length, so a bare path carrying a
    // query string (`/tasks?session=SECRET`) never reaches the log verbatim.
    return value.split(/[?#]/, 1)[0]!.slice(0, MAX_FIELD_LEN)
  }
}

// blocked-uri/blockedURL literal values a browser sends verbatim when there
// is genuinely no origin to strip: the CSP keywords/opaque tokens engines
// report for a directive with no network URL behind it (a `data:`/`blob:`
// violation is truncated to its bare scheme per the CSP3 reporting
// algorithm, not sent as a full URL). These ARE the signal — running them
// through origin-stripping would mangle them into null or garbage.
const OPAQUE_BLOCKED_URI_TOKENS = new Set([
  "inline",
  "eval",
  "wasm-eval",
  "data",
  "blob",
  "filesystem",
  "about",
  "self",
])

/** blocked-uri/blockedURL is special-cased separately from `originAndPath`
 *  (rather than reusing it outright) for one reason: this field's privacy
 *  contract must hold for ANY scheme with a network authority, not just
 *  http(s) — `wss://…?token=…` is a real value here (next.config.ts's
 *  connect-src whitelists `wss://*.radixdlt.com`), and the first cut of this
 *  fix only regex-matched `^https?://`, silently falling through every other
 *  scheme (ws/wss/ftp/anything-with-a-host) to the raw-value passthrough
 *  below and logging its query string (e.g. a session token) verbatim from
 *  this unauthenticated endpoint. So: ANY value that parses with a
 *  non-empty `host` — not just http(s) — gets the same origin+path
 *  stripping `originAndPath` gives document-uri/source-file. Only a value
 *  with no authority at all falls through to the literal/opaque-token
 *  handling, and even then only the known CSP keyword set passes through
 *  unchanged — anything else unparseable still gets the query/hash-stripped,
 *  length-capped treatment `originAndPath`'s own catch-branch uses for a
 *  bare path. */
function blockedUriFor(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null
  try {
    const u = new URL(value)
    if (u.host !== "") {
      // `u.origin` is the literal string "null" for a scheme WHATWG deems
      // opaque (any non-"special" scheme, e.g. a hypothetical `foo://host`)
      // — rebuild from protocol+host rather than trust it there, so an
      // unrecognized-but-authority-bearing scheme still gets a sensible
      // origin instead of the string "null".
      const origin = u.origin !== "null" ? u.origin : `${u.protocol}//${u.host}`
      return `${origin}${u.pathname}`
    }
    // Parsed, but no authority (e.g. `data:text/html,...`, `about:blank`,
    // `javascript:...`) — nothing to origin-strip; fall through to the
    // opaque-token / query-stripping handling below.
  } catch {
    // Not a parseable URL at all (e.g. a bare CSP keyword) — fall through.
  }
  if (OPAQUE_BLOCKED_URI_TOKENS.has(value)) return value
  // Same query/hash-stripping guarantee as originAndPath's fallback: cut at
  // the first '?' or '#' before capping, so an opaque value that happens to
  // carry a query string never reaches the log verbatim.
  return value.split(/[?#]/, 1)[0]!.slice(0, MAX_FIELD_LEN)
}

function asLineOrColumn(value: unknown): number | string | null {
  return typeof value === "number" || typeof value === "string" ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function normalizeLegacy(report: Record<string, unknown>): NormalizedViolation {
  return {
    documentUri: originAndPath(report["document-uri"]),
    violatedDirective: asString(report["violated-directive"]),
    effectiveDirective: asString(report["effective-directive"]),
    blockedUri: blockedUriFor(report["blocked-uri"]),
    sourceFile: originAndPath(report["source-file"]),
    line: asLineOrColumn(report["line-number"]),
    column: asLineOrColumn(report["column-number"]),
    disposition: asString(report["disposition"]),
  }
}

function normalizeReportingApi(entry: { body: Record<string, unknown> }): NormalizedViolation {
  const b = entry.body
  return {
    documentUri: originAndPath(b.documentURL),
    // The Reporting API only ever sends `effectiveDirective` — there is no
    // separate "violated" vs "effective" distinction in this shape.
    violatedDirective: null,
    effectiveDirective: asString(b.effectiveDirective),
    blockedUri: blockedUriFor(b.blockedURL),
    sourceFile: originAndPath(b.sourceFile),
    line: asLineOrColumn(b.lineNumber),
    column: asLineOrColumn(b.columnNumber),
    disposition: asString(b.disposition),
  }
}

function logViolation(v: NormalizedViolation): void {
  logger.info("csp_violation", {
    route: "/api/v1/csp-report",
    documentUri: v.documentUri,
    violatedDirective: v.violatedDirective,
    effectiveDirective: v.effectiveDirective,
    blockedUri: v.blockedUri,
    sourceFile: v.sourceFile,
    line: v.line,
    column: v.column,
    disposition: v.disposition,
  })
}

function contentTypeOf(req: NextRequest): string {
  return (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
}

function jsonError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error: { code, message } }, { status })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIp(req)
  const limit = limiter(ip)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const contentType = contentTypeOf(req)
  if (contentType !== "application/csp-report" && contentType !== "application/reports+json") {
    return jsonError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Expected application/csp-report or application/reports+json",
      415,
    )
  }

  // Reject an oversized body BEFORE buffering it, when the client tells the
  // truth about its size: `req.text()` reads the whole body into memory, and
  // the post-read MAX_BODY_BYTES check below only runs once that read has
  // already completed. A declared Content-Length over the cap lets a bad
  // actor be turned away without ever being read. This is a fast path, not a
  // replacement for the post-read check — a chunked request, or one with no
  // (or a non-numeric) Content-Length, falls through unchanged.
  const declaredLength = Number(req.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return jsonError("PAYLOAD_TOO_LARGE", "Report body exceeds the size limit", 413)
  }

  const raw = await req.text().catch(() => null)
  if (raw === null) {
    return jsonError("INVALID_BODY", "Could not read request body", 400)
  }
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return jsonError("PAYLOAD_TOO_LARGE", "Report body exceeds the size limit", 413)
  }

  let parsed: unknown
  try {
    parsed = raw.trim() === "" ? undefined : JSON.parse(raw)
  } catch {
    return jsonError("INVALID_BODY", "Invalid JSON", 400)
  }
  if (parsed === undefined) {
    return jsonError("INVALID_BODY", "Empty body", 400)
  }

  if (contentType === "application/csp-report") {
    const result = legacyReportSchema.safeParse(parsed)
    if (!result.success) {
      return jsonError("VALIDATION_ERROR", "Malformed csp-report payload", 400)
    }
    logViolation(normalizeLegacy(result.data["csp-report"]))
    return new NextResponse(null, { status: 204 })
  }

  // application/reports+json
  const result = reportingApiSchema.safeParse(parsed)
  if (!result.success) {
    return jsonError("VALIDATION_ERROR", "Malformed reports+json payload", 400)
  }
  for (const entry of result.data) {
    logViolation(normalizeReportingApi(entry))
  }
  return new NextResponse(null, { status: 204 })
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "POST only" } },
    { status: 405, headers: { Allow: "POST" } },
  )
}

// Next's App Router already 405s a method with no matching export once this
// runs behind the real server, but that behaviour isn't observable from a
// unit test calling the route module's exports directly — so these are
// explicit, and tested, rather than relied on implicitly.
export const GET = methodNotAllowed
export const PUT = methodNotAllowed
export const PATCH = methodNotAllowed
export const DELETE = methodNotAllowed
