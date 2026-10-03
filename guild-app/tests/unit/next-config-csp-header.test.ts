import { describe, it, expect } from "vitest"
import nextConfig from "../../next.config"

/**
 * next.config.ts headers() — Content-Security-Policy, ENFORCED since 2026-09-30
 * (report-only from the 0914 review task until then; see next.config.ts for the
 * evidence behind the switch). No existing test in this repo exercises next.config's headers()
 * directly (grepped tests/ — the closest precedent, tests/unit/hardening/
 * proxy.test.ts, covers src/proxy.ts's DIFFERENT header set, which is scoped
 * to that file's own `matcher: ["/api/:path*"]` and never runs for page
 * routes). headers() is a plain function returning plain data, so this
 * mirrors the rest of tests/unit/'s pure-function style (e.g.
 * settlement-copy.test.ts) rather than inventing anything Next-specific.
 *
 * Pins: the header is present on every route and is ENFORCED, with no leftover
 * Content-Security-Policy-Report-Only header beside it (two policies would
 * double-report every violation and let the two drift apart), is syntactically
 * sane (no duplicated directive names, every directive names at least one
 * source), and carries the exact origins the CSP audit added — so a future
 * edit that silently drops one of them fails here instead of just quietly
 * under-reporting in production.
 *
 * Extended 0914 (second pass, same task): the report-only header had no
 * destination until POST /api/v1/csp-report was wired as the sink. See that
 * route's own file doc for what it accepts/logs/refuses.
 *
 * Changed 2026-09-30: `report-uri` ONLY. The 0914 pass set `report-to` +
 * `Reporting-Endpoints` beside it. Measured that day, Chromium ignores
 * report-uri whenever report-to is present, and then delivers nothing over
 * the Reporting API (0 of 3 probes reached the live sink; report-uri alone
 * arrived within 1s). next.config.ts has the numbers. These tests pin that
 * report-to does not come back without a new measurement.
 */

async function getCspHeader() {
  const headersFn = nextConfig.headers
  if (!headersFn) throw new Error("next.config.ts no longer exports headers()")
  const rules = await headersFn()
  const rootRule = rules.find((r) => r.source === "/:path*")
  if (!rootRule) throw new Error('no headers() rule for source "/:path*"')
  const header = rootRule.headers.find(
    (h) => h.key === "Content-Security-Policy",
  )
  if (!header) throw new Error("Content-Security-Policy header not found")
  return { rule: rootRule, header }
}

describe("next.config headers() — Content-Security-Policy (enforced)", () => {
  it("is present on every route and is parseable (no duplicate/empty directives)", async () => {
    const { header } = await getCspHeader()
    const directives = header.value
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
    expect(directives.length).toBeGreaterThan(0)

    const names = directives.map((d) => d.split(" ")[0])
    expect(new Set(names).size).toBe(names.length) // no directive name repeated
    for (const d of directives) {
      const [name, ...sources] = d.split(" ")
      expect(name.length).toBeGreaterThan(0)
      expect(sources.length).toBeGreaterThan(0) // every directive names >=1 source
    }
  })

  it("is ENFORCED — exactly one CSP header, and no report-only copy beside it", async () => {
    const { rule } = await getCspHeader()
    expect(rule.headers.filter((h) => h.key === "Content-Security-Policy")).toHaveLength(1)
    expect(rule.headers.some((h) => h.key === "Content-Security-Policy-Report-Only")).toBe(false)
  })

  it("pins the audited additions (Google Fonts, the bot API origin) and the given baseline", async () => {
    const { header } = await getCspHeader()
    expect(header.value).toContain("default-src 'self'")
    expect(header.value).toContain(
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    )
    expect(header.value).toContain("font-src 'self' data: https://fonts.gstatic.com")
    expect(header.value).toContain(
      "connect-src 'self' https://mainnet.radixdlt.com https://*.radixdlt.com wss://*.radixdlt.com https://radixguild.com",
    )
    expect(header.value).toContain("frame-ancestors 'none'")
  })
})

describe("next.config headers() — CSP report sink (report-uri only, since 2026-09-30)", () => {
  it("reports through report-uri to the sink, so an enforced block is still visible", async () => {
    const { header } = await getCspHeader()
    expect(header.value).toContain("report-uri /api/v1/csp-report")
  })

  it("does NOT set report-to or Reporting-Endpoints — with report-to present, Chromium drops report-uri and reports nothing", async () => {
    const { rule, header } = await getCspHeader()
    expect(header.value).not.toMatch(/(^|;\s*)report-to\b/)
    expect(rule.headers.some((h) => h.key.toLowerCase() === "reporting-endpoints")).toBe(false)
    expect(rule.headers.some((h) => h.key.toLowerCase() === "report-to")).toBe(false)
  })

  it("keeps every load directive the report-only policy was cleared with", async () => {
    const { header } = await getCspHeader()
    // The directives the 2026-09-30 sweeps cleared (0 violations, all routes).
    expect(header.value).toContain("default-src 'self'")
    expect(header.value).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'")
    expect(header.value).toContain(
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    )
    expect(header.value).toContain("img-src 'self' data: https:")
    expect(header.value).toContain("font-src 'self' data: https://fonts.gstatic.com")
    expect(header.value).toContain(
      "connect-src 'self' https://mainnet.radixdlt.com https://*.radixdlt.com wss://*.radixdlt.com https://radixguild.com",
    )
    expect(header.value).toContain("frame-ancestors 'none'")
    expect(header.value).toContain("base-uri 'self'")
    expect(header.value).toContain("form-action 'self'")
  })
})
