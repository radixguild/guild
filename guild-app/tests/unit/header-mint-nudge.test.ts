import { describe, it, expect } from "vitest"
import { shouldShowMintNudge } from "@/components/app-shell"

/**
 * Header "Get your badge" nudge — catalogue P4-12, task 98.
 *
 * THE GAP: the header badge slot had no else-branch, so a brand-new or
 * un-minted wallet saw literally nothing there — the only path to
 * discovering minting was noticing "Mint" among equally-weighted nav
 * siblings. `shouldShowMintNudge` is the pulled-out, pure half of that
 * decision (app-shell.tsx) — pinned directly rather than mounting AppShell's
 * full chrome (NotificationsMenu, NetworkHaltNotice, guide/dropdown menus),
 * same precedent as `formatHeaderBadgePill` above it in that file.
 *
 * The one thing worth pinning hard: `badge === null` is NOT on its own
 * "confirmed no badge" — it's also the shape of "still loading" and "the
 * Gateway lookup failed" (useWallet's badgeError doc). A nudge that fired on
 * either of those would tell an existing badge-holder to go re-mint during a
 * blip, the exact failure mint/page.tsx and the profile page's
 * `confirmedNoBadge` were already written to avoid.
 */
describe("shouldShowMintNudge — only a CONFIRMED badge-less connected wallet", () => {
  it("shows for a connected wallet with a confirmed absence of a badge", () => {
    expect(shouldShowMintNudge(true, false, false, false)).toBe(true)
  })

  it("stays off while the badge lookup is still in flight", () => {
    // connected, no badge YET known either way — loading, not confirmed-none.
    expect(shouldShowMintNudge(true, false, true, false)).toBe(false)
  })

  it("stays off when the Gateway lookup failed — unknowable, not confirmed-none", () => {
    expect(shouldShowMintNudge(true, false, false, true)).toBe(false)
  })

  it("stays off for an already-badged wallet — no regression on the existing pill", () => {
    expect(shouldShowMintNudge(true, true, false, false)).toBe(false)
  })

  it("stays off for a fully disconnected visitor, even if `hasBadge` is somehow stale-true", () => {
    // There is no address to check yet — the connect button is the nudge at
    // that point, not this one. Guarded even against a stale-true badge flag
    // so the boolean order (connected gates everything else) is explicit.
    expect(shouldShowMintNudge(false, false, false, false)).toBe(false)
    expect(shouldShowMintNudge(false, true, false, false)).toBe(false)
  })

  it("a loading or errored lookup wins over a stale hasBadge=false — never assume none", () => {
    expect(shouldShowMintNudge(true, false, true, true)).toBe(false)
  })
})
