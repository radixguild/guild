import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { formatHeaderBadgePill } from "@/components/app-shell"

/**
 * Header pill XP source — catalogue P4-20, task 88, ruling 2026-09-15.
 *
 * THE BUG: the header pill read the connected wallet's `badge.xp` — the
 * guild_member NFT's own on-chain xp field, written only by the Telegram
 * bot's XP queue (votes/polls/dice, scripts/xp-batch-signer.js). A task
 * payout credits `users.xp` (awardTaskCompletion, src/db/queries/users.ts,
 * called from escrow-confirm.ts on a paid release) and never touches the
 * badge's field, so a worker who had just settled a task for real XP still
 * saw "MEMBER | 0 XP" — the badge's on-chain field, unmoved.
 *
 * `formatHeaderBadgePill` is the pulled-out, pure half of the header pill
 * (app-shell.tsx) — pinned directly, the same way useWallet.tsx's
 * `decideSession` is, rather than mounting AppShell's full chrome
 * (NotificationsMenu, NetworkHaltNotice, guide/dropdown menus) just to read
 * a badge's text content.
 */
describe("formatHeaderBadgePill — the header pill's XP must come from users.xp, not badge.xp", () => {
  it("shows tier + a settled task's xp when a real number (users.xp) is known", () => {
    // The exact regression shape: a worker settles a task worth 300 XP.
    // users.xp is now 300; the badge's own on-chain xp field is still 0
    // (nothing ever wrote it for this account). The pill must reflect the
    // settlement, not the untouched badge field.
    expect(formatHeaderBadgePill("member", 300)).toBe("MEMBER | 300 XP")
  })

  it("shows a real zero honestly — a brand-new member has genuinely earned 0", () => {
    expect(formatHeaderBadgePill("member", 0)).toBe("MEMBER | 0 XP")
  })

  it("omits the XP segment entirely when the number is unknown, rather than fabricate one", () => {
    // No active Guild session (e.g. wallet connected, never signed in) means
    // users.xp is unknowable from the client — the old code filled this gap
    // with badge.xp, which is exactly the wrong-number bug. Showing nothing
    // is the honest alternative; it must never render "| 0 XP" here.
    expect(formatHeaderBadgePill("member", undefined)).toBe("MEMBER")
  })

  it("always uppercases the tier, independent of the xp branch", () => {
    expect(formatHeaderBadgePill("elder", 12000)).toBe("ELDER | 12000 XP")
    expect(formatHeaderBadgePill("elder", undefined)).toBe("ELDER")
  })

  it("a large badge.xp value must NOT leak in as a fallback for an unknown users.xp", () => {
    // Regression shape stated structurally: the function's signature takes
    // ONE xp value, sourced by the caller from `user?.xp` (session), and has
    // no parameter through which a badge's xp could substitute. Calling it
    // as app-shell.tsx does — with the badge's own xp passed in by mistake —
    // is exactly the bug; pin that the call site wires the right value.
    const src = readFileSync(
      join(import.meta.dirname, "../../src/components/app-shell.tsx"),
      "utf8",
    )
    // Every call site (skip the `export function formatHeaderBadgePill(...)`
    // declaration itself — its parameter list is `tier: string, xp: ...`,
    // not an argument list, and would otherwise satisfy a looser match).
    const calls = [...src.matchAll(/(?<!function )formatHeaderBadgePill\(([^)]*)\)/g)]
    expect(calls.length, "app-shell.tsx must call formatHeaderBadgePill for the header pill").toBeGreaterThan(0)
    for (const call of calls) {
      expect(call[1].replace(/\s+/g, "")).toBe("badge.tier,user?.xp")
    }
  })
})
