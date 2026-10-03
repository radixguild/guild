/**
 * Tests for POST /api/v1/csp-report — the CSP violation report sink that
 * next.config.ts's CSP reports to (`report-uri` only, and enforced, since
 * 2026-09-30; see that route file's own doc comment for the full design).
 * Both body shapes stay under test: the route still accepts the Reporting-API
 * batch shape even though the header no longer asks for it.
 *
 * The route module creates its rate limiter at import time (module-scope
 * `const limiter = createRateLimiter(...)`, same shape as game/roll's
 * `rollLimiter` and tasks/route.ts's `createLimiter`), so every test that
 * cares about a clean bucket does `vi.resetModules()` + a fresh dynamic
 * import first — the cold-cache idiom quote-xrd-usd-route.test.ts already
 * uses for its own module-scope cache. Only the dedicated rate-limit test
 * below relies on the REAL limiter; every other test also uses the real one,
 * but with a single request per fresh module load it can never trip.
 *
 * Fake requests follow tempcheck-route.test.ts's style (a plain object cast
 * `as never`/`as unknown as NextRequest`) rather than constructing a real
 * `next/server` Request, since the route only ever calls `.headers.get()`
 * and `.text()` on it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { NextRequest } from "next/server"

const { mockInfo, mockWarn, mockError } = vi.hoisted(() => ({
  mockInfo: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
}))

vi.mock("@/lib/hardening/logger", () => ({
  logger: { info: mockInfo, warn: mockWarn, error: mockError, debug: vi.fn() },
}))

async function loadRoute() {
  vi.resetModules()
  return import("@/app/api/v1/csp-report/route")
}

function fakeRequest(body: string, contentType: string | null): NextRequest {
  const headers = new Headers()
  if (contentType !== null) headers.set("content-type", contentType)
  return {
    headers,
    text: async () => body,
  } as unknown as NextRequest
}

const LEGACY_BODY = JSON.stringify({
  "csp-report": {
    "document-uri": "https://radixguild.com/tasks?ref=abc123",
    referrer: "https://radixguild.com/",
    "violated-directive": "script-src",
    "effective-directive": "script-src",
    "original-policy": "default-src 'self'",
    disposition: "report",
    "blocked-uri": "https://evil.example/x.js",
    "line-number": 42,
    "column-number": 7,
    "source-file": "https://radixguild.com/_next/static/chunks/main.js?v=2",
    "status-code": 200,
  },
})

function reportsJsonBody(count: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      type: "csp-violation",
      age: i,
      url: "https://radixguild.com/tasks",
      user_agent: "Mozilla/5.0 (should never be logged)",
      body: {
        documentURL: "https://radixguild.com/tasks",
        disposition: "report",
        effectiveDirective: "img-src",
        blockedURL: "https://tracker.example/pixel.gif",
        sourceFile: "https://radixguild.com/_next/static/chunks/app.js",
        lineNumber: 10 + i,
        columnNumber: 3,
        originalPolicy: "default-src 'self'",
      },
    })),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("POST /api/v1/csp-report — legacy application/csp-report", () => {
  it("accepts a well-formed csp-report and returns 204 with exactly one log line", async () => {
    const { POST } = await loadRoute()
    const res = await POST(fakeRequest(LEGACY_BODY, "application/csp-report"))

    expect(res.status).toBe(204)
    expect(mockInfo).toHaveBeenCalledTimes(1)
    const [msg, ctx] = mockInfo.mock.calls[0]
    expect(msg).toBe("csp_violation")
    // query string stripped from document-uri/source-file
    expect(ctx.documentUri).toBe("https://radixguild.com/tasks")
    expect(ctx.sourceFile).toBe("https://radixguild.com/_next/static/chunks/main.js")
    // a real http(s) blocked-uri is origin+path only
    expect(ctx.blockedUri).toBe("https://evil.example/x.js")
    expect(ctx.violatedDirective).toBe("script-src")
    expect(ctx.effectiveDirective).toBe("script-src")
    expect(ctx.line).toBe(42)
    expect(ctx.column).toBe(7)
    expect(ctx.disposition).toBe("report")
    // never logged
    expect(JSON.stringify(ctx)).not.toContain("Mozilla")
    expect(ctx.referrer).toBeUndefined()
    expect(ctx.userAgent).toBeUndefined()
  })

  it("keeps the special blocked-uri tokens ('inline', 'eval', 'data:...') verbatim", async () => {
    const { POST } = await loadRoute()
    const body = JSON.stringify({
      "csp-report": { "document-uri": "https://radixguild.com/", "blocked-uri": "inline" },
    })
    await POST(fakeRequest(body, "application/csp-report"))
    expect(mockInfo.mock.calls[0][1].blockedUri).toBe("inline")
  })

  it("strips the query string from a bare-path document-uri/source-file that fails URL parsing", async () => {
    // Some engines report a bare path (no scheme/host) for a same-document
    // navigation — `new URL()` throws on that, and the catch-branch fallback
    // must still honor the query-stripping privacy guarantee rather than
    // logging the raw string verbatim.
    const { POST } = await loadRoute()
    const body = JSON.stringify({
      "csp-report": {
        "document-uri": "/tasks?session=SECRET_TOKEN_ABC123&ref=email-campaign",
        "source-file": "/app.js?token=SHOULD_NOT_LEAK#frag",
      },
    })
    await POST(fakeRequest(body, "application/csp-report"))
    const ctx = mockInfo.mock.calls[0][1]
    expect(ctx.documentUri).toBe("/tasks")
    expect(ctx.sourceFile).toBe("/app.js")
    expect(JSON.stringify(ctx)).not.toContain("SECRET_TOKEN_ABC123")
    expect(JSON.stringify(ctx)).not.toContain("SHOULD_NOT_LEAK")
  })
})

describe("POST /api/v1/csp-report — blocked-uri non-http(s) authority stripping (peer review)", () => {
  // The first cut of blockedUriFor() only regex-matched `^https?://`, so any
  // other scheme with an authority — notably `wss://…?token=…` (next.config.ts's
  // connect-src whitelists `wss://*.radixdlt.com`) — fell through to the raw
  // literal passthrough and logged its query string verbatim from this
  // unauthenticated endpoint. This block proves that class is closed: every
  // scheme with a host gets origin+path stripping, and only the genuine
  // no-authority CSP keywords pass through literally.
  it("strips query and fragment from a wss:// blocked-uri, keeping origin+path", async () => {
    const { POST } = await loadRoute()
    const body = JSON.stringify({
      "csp-report": {
        "document-uri": "https://radixguild.com/",
        "blocked-uri": "wss://gw.radixdlt.com/ws?token=SECRET#frag",
      },
    })
    await POST(fakeRequest(body, "application/csp-report"))
    const ctx = mockInfo.mock.calls[0][1]
    expect(ctx.blockedUri).toBe("wss://gw.radixdlt.com/ws")
    expect(JSON.stringify(ctx)).not.toContain("SECRET")
  })

  it("passes a bare 'data' and 'inline' blocked-uri token through literally", async () => {
    const { POST } = await loadRoute()
    const body = JSON.stringify({
      "csp-report": { "document-uri": "https://radixguild.com/", "blocked-uri": "data" },
    })
    await POST(fakeRequest(body, "application/csp-report"))
    expect(mockInfo.mock.calls[0][1].blockedUri).toBe("data")

    mockInfo.mockClear()
    const { POST: POST2 } = await loadRoute()
    const body2 = JSON.stringify({
      "csp-report": { "document-uri": "https://radixguild.com/", "blocked-uri": "inline" },
    })
    await POST2(fakeRequest(body2, "application/csp-report"))
    expect(mockInfo.mock.calls[0][1].blockedUri).toBe("inline")
  })

  it("strips the query string from an unknown-scheme blocked-uri with a host", async () => {
    const { POST } = await loadRoute()
    const body = JSON.stringify({
      "csp-report": {
        "document-uri": "https://radixguild.com/",
        "blocked-uri": "foo://x?y=SECRET",
      },
    })
    await POST(fakeRequest(body, "application/csp-report"))
    const ctx = mockInfo.mock.calls[0][1]
    expect(JSON.stringify(ctx)).not.toContain("SECRET")
  })
})

describe("POST /api/v1/csp-report — Reporting API application/reports+json", () => {
  it("accepts a batch and logs one line per report, in order", async () => {
    const { POST } = await loadRoute()
    const res = await POST(fakeRequest(reportsJsonBody(3), "application/reports+json"))

    expect(res.status).toBe(204)
    expect(mockInfo).toHaveBeenCalledTimes(3)
    expect(mockInfo.mock.calls[0][1].line).toBe(10)
    expect(mockInfo.mock.calls[1][1].line).toBe(11)
    expect(mockInfo.mock.calls[2][1].line).toBe(12)
    // Reporting API has no separate "violated" directive, only effective.
    expect(mockInfo.mock.calls[0][1].violatedDirective).toBeNull()
    expect(mockInfo.mock.calls[0][1].effectiveDirective).toBe("img-src")
    // user_agent is accepted by the schema but must never reach the log.
    expect(JSON.stringify(mockInfo.mock.calls[0])).not.toContain("Mozilla")
  })

  it("rejects a batch larger than the per-request cap with 400", async () => {
    const { POST } = await loadRoute()
    const res = await POST(fakeRequest(reportsJsonBody(21), "application/reports+json"))
    expect(res.status).toBe(400)
    expect(mockInfo).not.toHaveBeenCalled()
  })
})

describe("POST /api/v1/csp-report — rejections", () => {
  it("413s a body over the 64KB cap before touching JSON.parse", async () => {
    const { POST } = await loadRoute()
    const huge = "x".repeat(64 * 1024 + 1)
    const res = await POST(fakeRequest(huge, "application/csp-report"))
    expect(res.status).toBe(413)
    expect(mockInfo).not.toHaveBeenCalled()
  })

  it("415s any Content-Type other than the two accepted ones", async () => {
    const { POST } = await loadRoute()
    for (const ct of ["application/json", "text/plain", null]) {
      const res = await POST(fakeRequest(LEGACY_BODY, ct))
      expect(res.status).toBe(415)
    }
    expect(mockInfo).not.toHaveBeenCalled()
  })

  it("400s malformed JSON", async () => {
    const { POST } = await loadRoute()
    const res = await POST(fakeRequest("{not json", "application/csp-report"))
    expect(res.status).toBe(400)
  })

  it("400s an empty body", async () => {
    const { POST } = await loadRoute()
    const res = await POST(fakeRequest("", "application/csp-report"))
    expect(res.status).toBe(400)
  })

  it("400s a csp-report payload missing the csp-report key", async () => {
    const { POST } = await loadRoute()
    const res = await POST(fakeRequest(JSON.stringify({ oops: true }), "application/csp-report"))
    expect(res.status).toBe(400)
  })

  it("400s a reports+json body that isn't an array", async () => {
    const { POST } = await loadRoute()
    const res = await POST(
      fakeRequest(JSON.stringify({ type: "csp-violation" }), "application/reports+json"),
    )
    expect(res.status).toBe(400)
  })
})

describe("POST /api/v1/csp-report — Content-Length pre-check", () => {
  it("413s an oversize Content-Length header without ever reading the body", async () => {
    const { POST } = await loadRoute()
    const headers = new Headers()
    headers.set("content-type", "application/csp-report")
    headers.set("content-length", String(64 * 1024 + 1))
    // The actual body is tiny — the point is that the declared
    // Content-Length alone must be enough to reject, before `.text()` is
    // ever called. `text` throws if touched, so any attempt to read the
    // body fails this test rather than merely being observed via a spy.
    const req = {
      headers,
      text: async () => {
        throw new Error("body must not be read once Content-Length exceeds the cap")
      },
    } as unknown as NextRequest
    const res = await POST(req)
    expect(res.status).toBe(413)
    expect(mockInfo).not.toHaveBeenCalled()
  })

  it("falls through to the post-read check when Content-Length is non-numeric", async () => {
    const { POST } = await loadRoute()
    const headers = new Headers()
    headers.set("content-type", "application/csp-report")
    headers.set("content-length", "not-a-number")
    const req = {
      headers,
      text: async () => LEGACY_BODY,
    } as unknown as NextRequest
    const res = await POST(req)
    expect(res.status).toBe(204)
    expect(mockInfo).toHaveBeenCalledTimes(1)
  })
})

describe("non-POST methods", () => {
  it("405s GET, PUT, PATCH and DELETE with an Allow: POST header", async () => {
    const { GET, PUT, PATCH, DELETE } = await loadRoute()
    for (const handler of [GET, PUT, PATCH, DELETE]) {
      const res = await handler()
      expect(res.status).toBe(405)
      expect(res.headers.get("Allow")).toBe("POST")
    }
  })
})

describe("POST /api/v1/csp-report — rate limiting", () => {
  // Uses the REAL limiter (module-scope `max: 60` per IP per minute) — the
  // fake request sets no x-forwarded-for/x-real-ip, so every call in this
  // test resolves to the same "unknown" bucket and a fresh module load (via
  // loadRoute()) starts that bucket empty.
  it("trips 429 after the configured per-IP budget, with Retry-After", async () => {
    const { POST } = await loadRoute()
    let last!: Awaited<ReturnType<typeof POST>>
    for (let i = 0; i < 61; i++) {
      last = await POST(fakeRequest(LEGACY_BODY, "application/csp-report"))
    }
    expect(last.status).toBe(429)
    expect(last.headers.get("Retry-After")).toBeTruthy()
  })
})
