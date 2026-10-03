/**
 * The operator settlement drivers must not claim a PULL leg paid anyone.
 *
 * Verified against escrow/scrypto/guild-marketplace-escrow/src/lib.rs (by content):
 * `pub fn cancel_task(&mut self, receipt: Proof)` burns nothing and calls
 * `credit_entitlement(task_id, EntitledParty::Poster, …)` for reward and insurance;
 * `cancel_task_by_poster_after_claim` also `credit_bond_entitlement`s the worker's
 * bond; `approve_and_release` credits the worker and the poster. Nothing reaches an
 * account until `withdraw_poster` / `withdraw_worker`. Measured 2026-09-16: a keyless
 * /transaction/preview of on-chain task 30's cancel moved the component -500, -25,
 * +525 — net zero, 0 XRD to the poster.
 *
 * Until this test, cancel-task.mjs's header said the cancel "Burns the Task Receipt,
 * reward + insurance back", its log said "refund → reward + insurance back to …", and
 * its success line said "refunded to the poster" / "claim bond returned to worker";
 * approve-task.mjs printed "PAID". The operator then had to find the collect step,
 * whose two traps (on-chain id, opt-in dry-run) cost a round-trip on 2026-09-16.
 *
 * Two halves:
 *  - collectPointerLines is pure, so its traps are asserted by BEHAVIOUR.
 *  - the drivers call main() and process.exit at import, so they cannot be imported
 *    under vitest (same constraint as reconcile-escrow-fetch-timeout.test.ts); their
 *    copy is asserted on SOURCE. Every banned rule is anchored to the verbatim
 *    pre-fix string it exists for (TEETH), so a rule that silently stops matching
 *    fails here instead of passing vacuously.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { privateInputs } from "../support/private-input"

// cancel-task.mjs, approve-task.mjs and scripts/lib/collect-pointer.mjs stay
// private at the open-source flip (not guild-app/scripts/** carve-outs, unlike
// poster-harness.mjs below) — the tests that read them skip in the public
// export and name the input; a missing input throws in the private tree
// (tests/support/private-input.ts).
const PRIV = privateInputs(
  "guild-app/scripts/cancel-task.mjs",
  "guild-app/scripts/approve-task.mjs",
  "guild-app/scripts/lib/collect-pointer.mjs",
)
const COLLECT_POINTER_PATH = "../../scripts/lib/collect-pointer.mjs"
const collectPointerMod = PRIV.skip ? null : await import(COLLECT_POINTER_PATH)
const { collectPointerLines } = collectPointerMod ?? ({} as NonNullable<typeof collectPointerMod>)

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8")
const CANCEL = PRIV.skip ? "" : read("scripts/cancel-task.mjs")
const APPROVE = PRIV.skip ? "" : read("scripts/approve-task.mjs")
// The harness both drivers import — its cancel/auto-resolve comments carried the same claims.
const HARNESS = read("scripts/poster-harness.mjs")

// Push-era claims: that a PULL settlement leg delivered money, or burned the receipt.
const BANNED: Array<{ label: string; re: RegExp }> = [
  { label: "receipt burned at cancel", re: /\bburns?\s+the\s+task\s+receipt\b/i },
  { label: "refunded to <party>", re: /\brefunded\s+to\b/i },
  // No trailing \b: `${user.id}` ends in a non-word char, so a boundary never matches after it.
  { label: "back/returned to <party>", re: /\b(back|returns?|returned)\s+to\s+(\$\{user\.id\}|the\s+poster\b|(the\s+)?worker\b)/i },
  { label: "returned in full", re: /\bis\s+returned\s+in\s+full\b/i },
  { label: "refund arrow-routed to a party", re: /\brefund\s+→/i },
  { label: "bond arrow-routed to worker", re: /\bbond\s+→\s+(the\s+)?worker\b/i },
  { label: "cancel + refund", re: /\bcancel\s*\+\s*refund\b/i },
  { label: "approve + release", re: /\bapprove\s*\+\s*release\b/i },
  { label: "release escrow", re: /\brelease\s+escrow\b/i },
  { label: "PAID success line", re: /\bPAID\s+—/ },
]

// The exact strings that shipped before this fix. Each must trip at least one rule.
const TEETH = [
  "cancel_task. Burns the Task Receipt, reward + insurance back.",
  "refund → reward + insurance back to ${user.id} (unclaimed — nobody else is owed)",
  "refund → reward + insurance to ${user.id}; claim bond → worker ${info.workerAccount}",
  "task #${dbId} CANCELLED — reward + insurance refunded to the poster",
  "  claim bond returned to worker ${info.workerAccount} (${cancel.claimBondXrd} XRD)",
  "DRY-RUN — nothing signed. Re-run with --live to cancel + refund.",
  "approve it, release escrow, confirm → PAID.",
  "DRY-RUN — nothing signed. Re-run with --live to approve + release.",
  "task #${dbId} PAID — worker xpReward=${paid.xpReward}",
  // poster-harness.mjs
  "the poster and the worker's claim bond is returned IN FULL.",
  "returns to the poster; lib.rs credit_split_for_parties).",
]

const hits = (text: string) =>
  BANNED.filter((r) => r.re.test(text)).map((r) => `${r.label}: ${text.match(r.re)?.[0]}`)

describe("banned push-era settlement phrasings", () => {
  it.each(TEETH)("rule table catches the pre-fix string %j", (s) => {
    expect(hits(s).length).toBeGreaterThan(0)
  })

  it.skipIf(PRIV.skip)("cancel-task.mjs makes none of those claims", () => {
    expect(hits(CANCEL)).toEqual([])
  })

  it.skipIf(PRIV.skip)("approve-task.mjs makes none of those claims", () => {
    expect(hits(APPROVE)).toEqual([])
  })

  it("poster-harness.mjs makes none of those claims", () => {
    expect(HARNESS).toContain("export async function cancelTaskAfterClaim(") // not an empty/renamed file
    expect(hits(HARNESS)).toEqual([])
  })
})

describe.skipIf(PRIV.skip)("the drivers say what was CREDITED and point at the collect step", () => {
  // Vacuous-pass guards: if the success lines move or the pointer is dropped, the
  // banned scan above could pass on a file that no longer says anything at all.
  it("cancel-task.mjs: success line states a credit, not a delivery", () => {
    expect(CANCEL).toContain("CANCELLED — reward + insurance CREDITED to the poster's entitlement")
    expect(CANCEL).toMatch(/claim bond \(\$\{cancel\.claimBondXrd\} XRD\) CREDITED to worker/)
    expect(CANCEL).toMatch(/collectPointerLines\(\{ onChainTaskId: task\.onChainTaskId, dbId, as: "poster"/)
  })

  it("approve-task.mjs: success line states a credit, and points both parties at collect", () => {
    expect(APPROVE).toContain("settled (DB status=paid)")
    expect(APPROVE).toContain("CREDITED to the worker's entitlement")
    expect(APPROVE).toMatch(/for \(const as of \["worker", "poster"\]\)/)
    expect(APPROVE).toMatch(/collectPointerLines\(\{ onChainTaskId: task\.onChainTaskId, dbId, as,/)
  })

  it("neither driver passes the DB id as the pointer's on-chain id", () => {
    for (const src of [CANCEL, APPROVE]) {
      expect(src).not.toMatch(/onChainTaskId:\s*dbId\b/)
    }
  })
})

describe.skipIf(PRIV.skip)("collectPointerLines — the two traps", () => {
  // .skipIf only skips test EXECUTION — this describe callback still runs at
  // collection time, so the private-module call must stay guarded here too.
  const lines = PRIV.skip ? [] : collectPointerLines({ onChainTaskId: 30, dbId: 94, as: "poster", driver: "cancel-task.mjs" })
  const text = lines.join("\n")

  it("names the collect command with the ON-CHAIN id, never the board id", () => {
    expect(text).toContain("bun scripts/poster-harness.mjs withdraw --task 30 --as poster")
    expect(text).not.toMatch(/--task 94\b/)
    expect(text).toMatch(/ON-CHAIN task id \(30\), NOT the board\/DB id cancel-task\.mjs took \(94\)/)
  })

  it("offers the preview WITH --dry-run and warns that omitting it signs", () => {
    const preview = lines.find((l) => l.includes("preview:"))
    const sign = lines.find((l) => l.includes("sign:"))
    expect(preview).toMatch(/--as poster --dry-run$/)
    expect(sign).toMatch(/--as poster$/)
    expect(text).toMatch(/dry-run is OPT-IN: without --dry-run it SIGNS/)
  })

  it("routes the worker to --as worker", () => {
    const w = collectPointerLines({ onChainTaskId: 31, dbId: 95, as: "worker", driver: "approve-task.mjs" }).join("\n")
    expect(w).toContain("withdraw --task 31 --as worker --dry-run")
    expect(w).not.toContain("--as poster")
  })

  it("refuses an unknown party or a missing on-chain id rather than printing a wrong command", () => {
    expect(() => collectPointerLines({ onChainTaskId: 30, dbId: 94, as: "arbiter" as never, driver: "x" })).toThrow()
    expect(() => collectPointerLines({ onChainTaskId: null as never, dbId: 94, as: "poster", driver: "x" })).toThrow()
  })
})
