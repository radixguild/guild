import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, cleanup, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { POSTER_PATH } from "@/content/poster-path"
import { INSURANCE_RATE } from "@/lib/marketplace"

/**
 * Home page — a POSTER has a way off the front page.
 *
 * Stranger walkthrough 2026-09-17, finding 4: the homepage's only onboarding
 * route was the worker's (Connect Wallet → Mint Badge → Browse Tasks), under a
 * headline that says "Commission real work on Radix".
 *
 * Pinned here:
 *  1. signed out: a poster path with a link to /tasks/create is rendered;
 *  2. connected, no badge: the mint card ALSO offers the poster door — posting
 *     needs no badge, so "mint first" is the wrong instruction for a poster;
 *  3. the copy never repeats the three phrases two e2e specs assert with a
 *     strict-mode getByText (a second match turns e2e red) — see poster-path.ts.
 */

const H = vi.hoisted(() => ({
  wallet: {
    account: null as string | null,
    connected: false,
    badge: null as unknown,
    badgeLoading: false,
    badgeError: null as unknown,
    refreshBadge: () => {},
  },
  apiFetch: vi.fn(),
}))

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => H.wallet,
}))

vi.mock("@/lib/api-fetch", () => ({
  apiFetch: H.apiFetch,
}))

// Only mounted with a connected account; it has its own tests and its own fetches.
vi.mock("@/components/tasks/dispute-alerts", () => ({
  DisputeActionRequired: () => null,
}))

import Home from "@/app/page"

const jsonRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

beforeEach(() => {
  H.wallet = { account: null, connected: false, badge: null, badgeLoading: false, badgeError: null, refreshBadge: () => {} }
  H.apiFetch.mockReset().mockImplementation(async (path: string) => {
    if (path === "/api/v1/tasks/stats")
      return jsonRes({ ok: true, data: { counts: { open: 0, assigned: 0, submitted: 0, paid: 0 }, totalPaidXrd: "0" } })
    return jsonRes({ ok: true, data: [] })
  })
})
afterEach(cleanup)

describe("Home — poster path, signed out", () => {
  it("renders the poster path with a link to the create form", async () => {
    render(<Home />)
    const block = await screen.findByTestId("poster-path")
    expect(block).toHaveTextContent(POSTER_PATH.lead)
    for (const step of POSTER_PATH.steps) expect(block).toHaveTextContent(step)
    const link = within(block).getByRole("link", { name: new RegExp(POSTER_PATH.ctaLabel) })
    expect(link).toHaveAttribute("href", "/tasks/create")
  })

  it("states the no-badge fact and the insurance rate the create form actually charges", async () => {
    render(<Home />)
    const block = await screen.findByTestId("poster-path")
    expect(block).toHaveTextContent(POSTER_PATH.noBadgeNote)
    expect(block).toHaveTextContent(`${INSURANCE_RATE * 100}% insurance`)
  })

  it("does not render the connected-wallet variant", async () => {
    render(<Home />)
    await screen.findByTestId("poster-path")
    expect(screen.queryByTestId("poster-path-connected")).toBeNull()
  })
})

describe("Home — poster path, wallet connected with no badge", () => {
  beforeEach(() => {
    H.wallet = { ...H.wallet, account: "account_rdx1test", connected: true }
  })

  it("the mint card also offers the poster door", async () => {
    render(<Home />)
    const line = await screen.findByTestId("poster-path-connected")
    expect(line).toHaveTextContent(POSTER_PATH.connectedLead)
    expect(within(line).getByRole("link", { name: new RegExp(POSTER_PATH.ctaLabel) })).toHaveAttribute(
      "href",
      "/tasks/create",
    )
    expect(screen.queryByTestId("poster-path")).toBeNull()
  })
})

describe("poster-path copy — the e2e strict-mode guard", () => {
  // tests/e2e/landing.spec.ts + user-flows.spec.ts: `getByText("Connect Wallet")`
  // etc. resolve to exactly ONE element today. A second one fails strict mode.
  const EVERY_STRING = [
    POSTER_PATH.lead,
    ...POSTER_PATH.steps,
    POSTER_PATH.noBadgeNote,
    POSTER_PATH.ctaLabel,
    POSTER_PATH.connectedLead,
  ]

  it.each(["Connect Wallet", "Mint Badge", "Browse Tasks"])("no poster-path string contains %s", (phrase) => {
    for (const s of EVERY_STRING) expect(s.toLowerCase()).not.toContain(phrase.toLowerCase())
  })

  it("the guard is not vacuous: it covers every string the module exports", () => {
    const exported = Object.values(POSTER_PATH).flatMap((v) => (typeof v === "string" ? [v] : [...v]))
    // href is a path, not copy — everything else must be in the guarded list.
    expect(exported.filter((s) => s !== POSTER_PATH.href).sort()).toEqual([...EVERY_STRING].sort())
  })
})
