import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * /profile/[address] — one XP number, not two read as one. Catalogue P4-20,
 * task 88, ruling 2026-09-15 ("fix xp points").
 *
 * THE BUG: task settlement credits `users.xp` (awardTaskCompletion,
 * src/db/queries/users.ts, called from escrow-confirm.ts on a paid release),
 * but the profile page only ever rendered the guild_member badge's OWN
 * on-chain xp field (`primaryBadge.xp`) — which only the operator's admin
 * badge can write (update_xp — six calls in April 2026, all on one badge, none
 * since) — and only inside badge-gated cards. A
 * worker with real settled XP and no minted badge saw no XP figure at all;
 * one with a badge saw the badge's number captioned as if it were the whole
 * truth.
 *
 * This pins: (1) the Activity card's "XP" stat is `summary.xp` (`users.xp`),
 * shown regardless of whether a badge exists — mirroring "Reputation" beside
 * it; (2) the Badge card's own xp field is labelled "Badge XP (on-chain)"
 * (it read "(Telegram)" until 2026-09-23, on a belief the Gateway refuted),
 * never a bare "XP", so it can't be mistaken for the number in (1); (3) the
 * XP Breakdown card shows BOTH numbers, labelled, with the two-source
 * sentence, and drops the old "invented number" caveat.
 *
 * Mock harness mirrors tests/unit/profile-archived-session.test.tsx (same
 * page, same set of mocked modules).
 */

const ME = "account_rdx12ynlx369me0000000000000000000000000000000000000000000000"

const H = vi.hoisted(() => ({
  address: "" as string,
  account: null as string | null,
  badges: [] as { schema: string; badge: Record<string, unknown> }[],
  badgeLookupComplete: true,
  summary: null as Record<string, unknown> | null,
  apiFetch: vi.fn(),
}))

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

vi.mock("next/navigation", () => ({
  useParams: () => ({ address: H.address }),
}))

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ account: H.account }),
}))

vi.mock("@/lib/gateway", () => ({
  loadAllBadgesStrict: vi.fn(async () => ({
    badges: H.badges,
    complete: H.badgeLookupComplete,
  })),
}))

vi.mock("@/lib/use-xrd-usd", () => ({
  useXrdUsd: () => ({ rate: null, stale: false, ageSeconds: null, source: null }),
}))

vi.mock("@/lib/api-fetch", () => ({
  apiFetch: H.apiFetch,
}))

import ProfilePage from "@/app/profile/[address]/page"

const jsonRes = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

const listBody = () => ({ ok: true, data: [], cursor: null, hasMore: false, ownerView: true })

/** Realistic guild_member BadgeInfo — every field the page reads off it. */
function guildMemberBadge(xp: number, tier = "member") {
  return {
    id: "<guild_member_1>",
    issued_to: ME,
    schema_name: "guild_member",
    issued_at: 1_700_000_000,
    tier,
    status: "active",
    last_updated: 1_700_000_000,
    xp,
    level: tier,
    extra_data: "",
  }
}

function profileSummary(xp: number, overrides: Record<string, unknown> = {}) {
  return {
    address: ME,
    displayName: null,
    badgeTier: "member",
    xp,
    reputation: 240,
    isAgent: false,
    tasksCreated: 0,
    tasksAssigned: 3,
    tasksCompleted: 2,
    submissionsTotal: 2,
    submissionsApproved: 2,
    submissionsRejected: 0,
    xrdEarned: "550",
    xrdEarnedThisMonth: "550",
    xrdSpent: "0",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    ...overrides,
  }
}

describe("/profile/[address] — Activity, Badge and XP Breakdown cards read the right XP source", () => {
  beforeEach(() => {
    H.address = ME
    H.account = ME
    H.badges = []
    H.badgeLookupComplete = true
    H.summary = null
    H.apiFetch.mockReset().mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/tasks?")) return jsonRes(200, listBody())
      if (path.startsWith("/api/v1/groups/memberships")) return jsonRes(200, { ok: true, data: [] })
      if (path.startsWith("/api/v1/users/")) {
        return H.summary
          ? jsonRes(200, { ok: true, data: H.summary })
          : jsonRes(404, { ok: false, error: { code: "NOT_FOUND", message: "no" } })
      }
      throw new Error(`unexpected apiFetch: ${path}`)
    })
  })
  afterEach(cleanup)

  it("a badge holder with settled XP shows Guild XP (users.xp) and Badge XP (on-chain) as two DIFFERENT numbers", async () => {
    // The regression shape: a worker just settled a task worth 300 XP.
    // users.xp is now 300; the badge's own on-chain field is still 0 —
    // a task payout never writes it, and only the operator can.
    H.badges = [{ schema: "guild_member", badge: guildMemberBadge(0) }]
    H.summary = profileSummary(300)

    render(<ProfilePage />)
    await screen.findByText("Activity")

    // (1) Activity card: "XP" is a real, own stat now (never badge-gated,
    // same as Reputation beside it) and its value is the settled total (300)
    // as a bare number — not the badge's untouched 0.
    expect(screen.getByText("XP")).toBeInTheDocument()
    expect(screen.getByText("300")).toBeInTheDocument()

    // (2) Badge card: the badge's own field is labelled "(on-chain)", never
    // a bare "XP" that a reader could mistake for the settled total. It
    // appears twice — the Badge card and the XP Breakdown card below it.
    expect(screen.getAllByText("Badge XP (on-chain)").length).toBe(2)
    expect(screen.queryByText("Badge XP (Telegram)")).not.toBeInTheDocument()

    // (3) XP Breakdown: both numbers, both labelled, and the two-source
    // sentence — never the old "invented number" caveat.
    expect(screen.getByText("Guild XP")).toBeInTheDocument()
    expect(screen.getByText("300 XP")).toBeInTheDocument()
    expect(screen.getByText("0 XP")).toBeInTheDocument()
    expect(screen.getByText(/never sync/i)).toBeInTheDocument()
    expect(screen.queryByText(/wrong in the meantime/i)).not.toBeInTheDocument()
  })

  it("a worker with settled XP but NO minted badge still sees the real number on their profile card", async () => {
    H.badges = [] // Gateway confirmed: no badge for this address
    H.badgeLookupComplete = true
    H.summary = profileSummary(150)

    render(<ProfilePage />)

    await screen.findByText("No badge found for this address.")

    // The Activity card's XP stat does not depend on a badge existing —
    // same as Reputation, which has never been badge-gated.
    expect(screen.getByText("XP")).toBeInTheDocument()
    expect(screen.getByText("150")).toBeInTheDocument()

    // Nothing to break down without a badge — the card simply doesn't render,
    // rather than showing a Badge XP (on-chain) figure of 0 that no badge
    // actually holds.
    expect(screen.queryByText("XP Breakdown")).not.toBeInTheDocument()
    expect(screen.queryByText("Badge XP (on-chain)")).not.toBeInTheDocument()
  })

  it("a badge-holder who has never settled a task shows a real Guild XP of 0, not a missing stat", async () => {
    H.badges = [{ schema: "guild_member", badge: guildMemberBadge(40) }]
    H.summary = profileSummary(0)

    render(<ProfilePage />)

    // Appears twice — the Badge card and the XP Breakdown card below it.
    expect(await screen.findAllByText("Badge XP (on-chain)")).toHaveLength(2)
    expect(screen.getByText("0 XP")).toBeInTheDocument() // Guild XP, in the Breakdown card
    expect(screen.getByText("40 XP")).toBeInTheDocument() // Badge XP (on-chain), same card
  })
})
