/**
 * Tests for src/components/XrdAmount.tsx — the site-wide XRD/USD display
 * primitive (board note M5 / ruling R1, 2026-09-03).
 *
 * Three states, and the rule the component exists to enforce: XRD is always
 * the headline text, the USD figure is an ADDITIONAL muted estimate, and it
 * is NEVER shown without a live, non-stale rate — a stale or unusable quote
 * degrades to XRD-only with the reason folded into the tooltip, never a
 * dollar figure with no marker.
 */
import { describe, it, expect, beforeEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { XrdAmount } from "@/components/XrdAmount"

describe("<XrdAmount>", () => {
  beforeEach(() => cleanup())

  it("fresh: renders the XRD figure plus a muted USD estimate, with a display-only tooltip", () => {
    render(
      <XrdAmount amountXrd="100" usdRate={0.05} stale={false} ageSeconds={120} source="astrolescent" />,
    )

    const el = screen.getByText(/100 XRD/)
    expect(el).toBeInTheDocument()
    expect(screen.getByText(/≈\s*\$5\.00/)).toBeInTheDocument()

    const title = el.closest("[title]")?.getAttribute("title") ?? ""
    expect(title).toMatch(/display only/i)
    expect(title).toMatch(/astrolescent/i)
    expect(title).toMatch(/2 min ago/i)
    expect(title).not.toMatch(/usd unavailable/i)
  })

  it("stale: renders XRD only, never a dollar figure, and says USD unavailable in the tooltip", () => {
    render(
      <XrdAmount amountXrd="100" usdRate={0.05} stale={true} ageSeconds={2400} source="astrolescent" />,
    )

    const el = screen.getByText(/100 XRD/)
    expect(el).toBeInTheDocument()
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument()

    const title = el.closest("[title]")?.getAttribute("title") ?? ""
    expect(title).toMatch(/usd unavailable/i)
    expect(title).toMatch(/astrolescent/i)
    expect(title).not.toMatch(/display only/i)
  })

  it("unavailable: no rate at all renders XRD only with a generic USD-unavailable tooltip", () => {
    render(<XrdAmount amountXrd="100" usdRate={null} />)

    const el = screen.getByText(/100 XRD/)
    expect(el).toBeInTheDocument()
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument()

    const title = el.closest("[title]")?.getAttribute("title") ?? ""
    expect(title).toMatch(/usd unavailable/i)
  })

  it("a stale flag suppresses USD even when usdRate looks perfectly normal (belt and braces)", () => {
    // Regression guard: a caller must not be able to show a stale dollar
    // number just by forgetting to gate on `stale` before passing usdRate.
    render(<XrdAmount amountXrd={1000} usdRate={0.1} stale />)
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
  })

  it("never claims the estimate is 'USD-priced' or 'stable' (R1: XRD is the promise, USD is display only)", () => {
    render(
      <XrdAmount amountXrd="100" usdRate={0.05} stale={false} ageSeconds={0} source="coingecko" />,
    )
    const el = screen.getByText(/100 XRD/)
    const title = el.closest("[title]")?.getAttribute("title") ?? ""
    expect(title.toLowerCase()).not.toContain("usd-priced")
    expect(title.toLowerCase()).not.toContain("stable")
  })

  it("compact mode still keeps the muted USD suffix distinct from the XRD headline", () => {
    render(
      <XrdAmount
        amountXrd="5000"
        usdRate={0.05}
        stale={false}
        ageSeconds={5}
        source="astrolescent"
        mode="compact"
      />,
    )
    expect(screen.getByText(/5k XRD/)).toBeInTheDocument()
    expect(screen.getByText(/≈\s*\$250\.00/)).toBeInTheDocument()
  })
})
