import { sessionFailure } from "@/lib/session-outcome"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * /profile/[address] — the Archived section vs a lapsed guild_session
 * (2026-09-14, follow-up to the archived-task fix that added the section).
 *
 * The gap: `isOwnProfile` is a CLIENT belief (useWallet's `account` equals
 * the URL address), but GET /api/v1/tasks decides server-side, per request,
 * whether the caller may see their own cancelled rows — from the httpOnly
 * guild_session cookie, which the client cannot see expire. When the two
 * disagree (the incident shape: wallet badge still says "you", cookie gone),
 * the lists arrive filtered to the public view and the Archived cards render
 * "No archived claimed tasks." to an owner who may have some — the same
 * misleading empty state the task page's ARCHIVED_SIGN_IN_REQUIRED closed.
 *
 * The route now says which view it served (`ownerView`, see
 * src/lib/owner-view.ts); this pins that the page (a) shows a sign-in
 * prompt — not the cards — on an explicit `ownerView: false` for an own
 * profile, (b) still renders the cards, empty or populated, on `true`,
 * (c) stays silent on someone else's profile, (d) does NOT blame the session
 * for a fetch that failed outright, and (e) reloads the lists after a
 * successful sign-in and swaps the prompt for the cards.
 *
 * Mock set mirrors tests/unit/create-task-github-reality.test.tsx (AppShell,
 * next/link, next/navigation, useWallet, apiFetch) plus the two reads this
 * page adds on top: the strict Gateway badge lookup and the XRD→USD context.
 */

const ME = "account_rdx12ynlx369me0000000000000000000000000000000000000000000000"
const OTHER = "account_rdx12ynlx369other000000000000000000000000000000000000000000"

const CANCELLED_CLAIMED = {
  id: 68,
  title: "Cancelled-after-claim job",
  rewardXrd: "76.45",
  status: "cancelled",
  onChainTaskId: 4,
}
const CANCELLED_POSTED = {
  id: 71,
  title: "Posted then withdrawn",
  rewardXrd: "30",
  status: "cancelled",
  onChainTaskId: null,
}

const H = vi.hoisted(() => ({
  address: "" as string,
  account: null as string | null,
  ownerView: false as unknown,
  listFails: false,
  claimedRows: [] as unknown[],
  postedRows: [] as unknown[],
  signIn: vi.fn(),
  signInDetailed: vi.fn(),
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
  useWallet: () => ({
    account: H.account,
    connected: !!H.account,
    signIn: H.signIn,
    signInDetailed: H.signInDetailed,
  }),
}))

vi.mock("@/lib/gateway", () => ({
  // Complete, badgeless read: keeps the badge cards out of the way. The
  // Archived section never depends on badge state.
  loadAllBadgesStrict: vi.fn(async () => ({ badges: [], complete: true })),
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

/** Shaped like the real route: paginated envelope + the ownerView flag. */
const listBody = (rows: unknown[]) => ({
  ok: true,
  data: rows,
  cursor: null,
  hasMore: false,
  ownerView: H.ownerView,
})

const listCalls = (param: "assignee" | "creator") =>
  H.apiFetch.mock.calls.filter(([path]) => String(path).startsWith(`/api/v1/tasks?${param}=`))

const signInButton = () => screen.queryByRole("button", { name: /^sign in$/i })
const PROMPT_TITLE = "Sign in to see your archived tasks"

describe("/profile/[address] Archived section vs a lapsed guild_session (2026-09-14)", () => {
  beforeEach(() => {
    H.address = ME
    H.account = ME
    H.ownerView = false
    H.listFails = false
    H.claimedRows = []
    H.postedRows = []
    H.signIn.mockReset()
    H.signInDetailed.mockReset().mockResolvedValue({ ok: true })
    H.apiFetch.mockReset().mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/tasks?")) {
        if (H.listFails) throw new Error("network down")
        const rows = path.includes("assignee=") ? H.claimedRows : H.postedRows
        return jsonRes(200, listBody(rows))
      }
      if (path.startsWith("/api/v1/users/")) {
        // Not in the local DB — the page leaves `summary` null, by design.
        return jsonRes(404, { ok: false, error: { code: "NOT_FOUND", message: "no" } })
      }
      if (path.startsWith("/api/v1/groups/memberships")) {
        return jsonRes(200, { ok: true, data: [] })
      }
      throw new Error(`unexpected apiFetch: ${path}`)
    })
  })
  afterEach(cleanup)

  it("own profile + server says ownerView:false → a sign-in prompt, NOT two 'No archived …' cards", async () => {
    render(<ProfilePage />)

    expect(await screen.findByText(PROMPT_TITLE)).toBeInTheDocument()
    expect(signInButton()).toBeInTheDocument()
    // The misleading empty state is gone in both directions…
    expect(screen.queryByText("No archived claimed tasks.")).not.toBeInTheDocument()
    expect(screen.queryByText("No archived posted tasks.")).not.toBeInTheDocument()
    expect(screen.queryByText(/Archived — Claimed/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Archived — Posted/)).not.toBeInTheDocument()
    // …while the public-view cards still render as they always did.
    expect(screen.getByText(/Tasks Claimed/)).toBeInTheDocument()
    expect(screen.getByText(/Tasks Posted/)).toBeInTheDocument()
  })

  it("the prompt copy names the actual cause — the session, not the tasks", async () => {
    render(<ProfilePage />)
    await screen.findByText(PROMPT_TITLE)
    expect(screen.getByText(/no Guild session for it/i)).toBeInTheDocument()
    expect(screen.getByText(/can't tell whether you have any until you sign in/i)).toBeInTheDocument()
  })

  it("own profile + ownerView:true + a cancelled claimed row → the Archived — Claimed card lists it, no prompt", async () => {
    H.ownerView = true
    H.claimedRows = [CANCELLED_CLAIMED]

    render(<ProfilePage />)

    expect(await screen.findByText(/Archived — Claimed \(1\)/)).toBeInTheDocument()
    expect(screen.getByText("Cancelled-after-claim job")).toBeInTheDocument()
    expect(screen.getByText(/Archived — Posted \(0\)/)).toBeInTheDocument()
    expect(screen.getByText("No archived posted tasks.")).toBeInTheDocument()
    expect(screen.queryByText(PROMPT_TITLE)).not.toBeInTheDocument()
    expect(signInButton()).not.toBeInTheDocument()
    // The cancelled row stays OUT of the live "Tasks Claimed" list (0), as before.
    expect(screen.getByText(/Tasks Claimed \(0\)/)).toBeInTheDocument()
  })

  it("own profile + ownerView:true + a cancelled posted row → the Archived — Posted card lists it", async () => {
    H.ownerView = true
    H.postedRows = [CANCELLED_POSTED]

    render(<ProfilePage />)

    expect(await screen.findByText(/Archived — Posted \(1\)/)).toBeInTheDocument()
    expect(screen.getByText("Posted then withdrawn")).toBeInTheDocument()
    expect(screen.queryByText(PROMPT_TITLE)).not.toBeInTheDocument()
  })

  it("own profile + ownerView:true + nothing cancelled → the honest empty cards (the server DID confirm 'none')", async () => {
    H.ownerView = true

    render(<ProfilePage />)

    expect(await screen.findByText("No archived claimed tasks.")).toBeInTheDocument()
    expect(screen.getByText("No archived posted tasks.")).toBeInTheDocument()
    expect(screen.queryByText(PROMPT_TITLE)).not.toBeInTheDocument()
    expect(signInButton()).not.toBeInTheDocument()
  })

  it("someone ELSE's profile → no Archived section and no prompt, whatever ownerView says", async () => {
    H.account = OTHER // wallet is OTHER, URL is ME
    H.ownerView = false

    render(<ProfilePage />)

    await screen.findByText(/Tasks Claimed/)
    expect(screen.queryByText(PROMPT_TITLE)).not.toBeInTheDocument()
    expect(signInButton()).not.toBeInTheDocument()
    expect(screen.queryByText(/Archived/)).not.toBeInTheDocument()
  })

  it("wallet not connected at all → no Archived section and no prompt (isOwnProfile is false)", async () => {
    H.account = null

    render(<ProfilePage />)

    await screen.findByText(/Tasks Claimed/)
    expect(screen.queryByText(PROMPT_TITLE)).not.toBeInTheDocument()
    expect(screen.queryByText(/Archived/)).not.toBeInTheDocument()
  })

  it("the list fetch failing outright is NOT blamed on the session — cards as before, no prompt", async () => {
    H.listFails = true
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    render(<ProfilePage />)

    await screen.findByText(/Tasks Claimed/)
    expect(screen.queryByText(PROMPT_TITLE)).not.toBeInTheDocument()
    expect(signInButton()).not.toBeInTheDocument()
    // Pre-existing behaviour for a failed read, deliberately unchanged here
    // (the same gap exists for every list on the page — out of scope).
    expect(screen.getByText("No archived claimed tasks.")).toBeInTheDocument()
    errSpy.mockRestore()
  })

  it("a successful sign-in from the prompt re-reads the lists and swaps the prompt for the populated cards", async () => {
    // Session lapsed on first load; signing in re-establishes it, and the
    // re-read now comes back as the owner's view WITH the archived row.
    H.signInDetailed.mockImplementation(async () => {
      H.ownerView = true
      H.claimedRows = [CANCELLED_CLAIMED]
      return { ok: true }
    })

    render(<ProfilePage />)
    await screen.findByText(PROMPT_TITLE)
    const before = listCalls("assignee").length
    expect(before).toBeGreaterThan(0)

    fireEvent.click(signInButton()!)

    expect(await screen.findByText(/Archived — Claimed \(1\)/)).toBeInTheDocument()
    expect(screen.getByText("Cancelled-after-claim job")).toBeInTheDocument()
    expect(screen.queryByText(PROMPT_TITLE)).not.toBeInTheDocument()
    expect(H.signInDetailed).toHaveBeenCalledTimes(1)
    // Both lists were re-read under the new session, not just one.
    await waitFor(() => {
      expect(listCalls("assignee").length).toBeGreaterThan(before)
      expect(listCalls("creator").length).toBeGreaterThan(0)
    })
  })

  it("a declined signature keeps the prompt (with SignInPrompt's own error) and does not re-read", async () => {
    H.signInDetailed.mockResolvedValue(sessionFailure("wallet-declined"))

    render(<ProfilePage />)
    await screen.findByText(PROMPT_TITLE)
    const before = listCalls("assignee").length

    fireEvent.click(signInButton()!)

    expect(await screen.findByRole("alert")).toHaveTextContent(/declined the sign-in request in your wallet/i)
    expect(screen.getByText(PROMPT_TITLE)).toBeInTheDocument()
    expect(listCalls("assignee").length).toBe(before)
  })
})
