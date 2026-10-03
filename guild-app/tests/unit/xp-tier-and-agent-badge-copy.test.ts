import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

/**
 * Two served claims that contradicted the chain and the app's own other pages,
 * found by the 2026-09-18 content sweep.
 *
 * 1. /lifecycle said the Agent badge "has a supply of zero". The Gateway
 *    reports total_supply 1 on
 *    resource_rdx1nf3zadak8vdywgx3gdx5xq3svu6tf7x9dsjllvtfh97d6freptcxeh
 *    (GAGENT), minted 2026-09-14. /agents ALREADY said this correctly — so the
 *    site contradicted itself across two pages. The page's practical
 *    conclusion (everyone gets the 7-day deadline) is still right, because no
 *    claim has ever presented the badge; only the stated reason was false.
 *
 * 2. /guide listed five actions under the Member→Elder tier ladder as though
 *    each moved a reader's tier. The 2026-09-18 fix split them into "task
 *    completion" and four "Badge XP (Telegram)" actions. The second half was
 *    ALSO false, found 2026-09-23: the badge NFT's xp field is written only by
 *    the operator's admin badge (update_xp — six calls in April 2026, all on
 *    one badge, none since; corrected 2026-09-24 from "once, by hand"), and the
 *    Telegram bot's points never reach it or Guild XP. And nothing moves a tier
 *    from Guild XP at all: every tier the
 *    app displays is the badge's own on-chain `tier`/`level` field
 *    (badge-card.tsx, tier-progression.tsx, app-shell.tsx). So /guide now lists
 *    one XP source (a completed task) and says the bot's points are separate.
 *
 * WHY SOURCE TESTS: both are hand-written prose, not computed values, so
 * nothing else in CI can see them. The honest-copy gate has no rule for "a
 * claim the chain contradicts".
 *
 * To mutate-prove: restore either original sentence and its assertion fails.
 */
describe("/lifecycle — the Agent badge exists", () => {
  const src = read("src/app/lifecycle/page.tsx")

  it("mentions the Agent badge at all (vacuous-pass guard)", () => {
    // Without this, rewording the section away would make every assertion
    // below pass over prose that no longer exists.
    expect(/Agent badge/i.test(src)).toBe(true)
  })

  it("does not claim the badge has zero supply", () => {
    expect(/supply of zero|supply is zero|zero supply/i.test(src)).toBe(false)
  })

  it("still tells the reader the 7-day deadline applies to them", () => {
    // The conclusion was right for the wrong reason. Correcting the reason must
    // not quietly drop the thing a worker actually needs to know.
    expect(/7 days/.test(src)).toBe(true)
  })
})

describe("/guide — the XP table names the one real XP source", () => {
  const src = read("src/app/guide/page.tsx")

  it("lists task completion as the XP source (vacuous-pass guard)", () => {
    expect(/action: "Complete a task"/.test(src)).toBe(true)
    expect(/tier:\s*true/.test(src)).toBe(true)
  })

  it("does not list votes, proposals, dice or temperature checks as earning XP", () => {
    for (const re of [/action: "Vote on proposal"/, /action: "Create proposal"/, /action: "Dice roll bonus"/, /action: "Temperature check"/]) {
      expect(re.test(src), re.source).toBe(false)
    }
  })

  it("says in words that the bot's points are not Guild XP", () => {
    expect(/not added to your Guild XP/.test(src)).toBe(true)
  })

  it("does not claim Guild XP moves the displayed tier", () => {
    expect(/the only thing that moves your tier/.test(src)).toBe(false)
    expect(/Guild XP does not move it automatically/.test(src)).toBe(true)
  })

  it("never calls the badge's on-chain XP field Telegram XP — on /guide or /profile", () => {
    const profile = read("src/app/profile/[address]/page.tsx")
    expect(/Badge XP \(Telegram\)/.test(src)).toBe(false)
    expect(/Badge XP \(Telegram\)/.test(profile)).toBe(false)
    expect(/Badge XP \(on-chain\)/.test(profile)).toBe(true)
    expect(/never sync/.test(profile)).toBe(true)
  })
})
