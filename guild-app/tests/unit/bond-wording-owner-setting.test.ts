import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The claim bond's size is the escrow OWNER's setting: set_claim_bond_params writes the
 * percentage, the floor and the cap in one signed call, with no delay and no vote (lib.rs; the
 * /docs "What can the owner badge change?" paragraph and /trust say so). So copy that reads
 * "never less than 76.45 XRD, capped on-chain" promises something the contract does not: it
 * describes TODAY's settings. Until 2026-10-03 a dozen surfaces said it that way.
 *
 * The corrected phrasing is "at least {ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting)".
 * This pins it on every surface that has been swept, and bans the old phrases there. The list
 * only grows: add a file here in the same change that rewords it.
 *
 * Source scrape on purpose, comments stripped — a comment that explains why the old phrase
 * went has to be able to quote it.
 */

const ROOT = join(process.cwd(), "..")

function visibleSource(rel: string): string {
  const raw = readFileSync(join(ROOT, rel), "utf8")
  // Plain text (llms.txt) has no comments to strip, and "/api/*" must not read as one.
  if (rel.endsWith(".txt")) return raw.replace(/\s+/g, " ")
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /* … */ and {/* … */}
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1") // // … (not the // in https://)
    .replace(/\s+/g, " ")
}

/** Pages whose bond sentence was reworded, and where the new phrase must appear. */
/** The one phrase the swept human-facing surfaces share: `at least {floor} XRD today`. */
const TODAY = /at least \$?\{ESCROW_CLAIM_BOND_XRD\} XRD today/

const SWEPT: Array<[file: string, mustSay: RegExp]> = [
  // The first sweep: the pages the review named.
  ["guild-app/src/app/docs/page.tsx", /a bond of 10% of the reward, at least\{" "\}\s?\{ESCROW_CLAIM_BOND_XRD\} XRD today \(an owner setting\)/],
  ["guild-app/src/app/mint/page.tsx", /a claim bond of 10% of the reward, at least \{ESCROW_CLAIM_BOND_XRD\} XRD today \(an owner setting\)/],
  ["guild-app/src/app/guide/page.tsx", /a bond of 10% of the task reward, at least \$\{ESCROW_CLAIM_BOND_XRD\} XRD today \(an owner setting\)/],
  ["guild-app/src/app/guide/page.tsx", /the claim bond \(10% of the reward, at least\{" "\}\s?\{ESCROW_CLAIM_BOND_XRD\} XRD today, an owner setting\)/],
  // The second: every other human-facing surface that carried the phrase.
  ["guild-app/src/app/lifecycle/page.tsx", TODAY],
  ["guild-app/src/app/money/page.tsx", TODAY],
  ["guild-app/src/lib/settlement-copy.ts", TODAY],
  ["guild-app/src/app/trust/page.tsx", TODAY],
  ["guild-app/src/app/check-badge/page.tsx", TODAY],
  ["guild-app/src/app/auditor-guide/page.tsx", /the percentage, floor and cap are all owner settings/],
  ["guild-app/src/components/tasks/escrow-actions.tsx", /10% of the reward, at least \{ESCROW_CLAIM_BOND_XRD\} XRD today \(an owner setting\)/],
  ["guild-app/src/components/guides/guides.ts", TODAY],
  ["guild-app/public/llms.txt", /bond of 10% of the reward today, with a floor \(the percentage and the floor are owner settings;/],
  ["bot/services/copy.js", /"10% of the reward, at least " \+ CLAIM_BOND_FLOOR_XRD \+ " XRD today \(an owner setting\)"/],
  ["bot/services/faq-matcher.js", /10% of the reward, at least 76\.45 XRD today \(an owner setting\)/],
]

/** The phrases that read as a contract guarantee. None may survive on a swept surface. */
const GUARANTEE_PHRASES: Array<[label: string, re: RegExp]> = [
  ["never less than", /never less\b/i],
  ["capped on-chain", /capped on[- ]chain/i],
]

describe("the claim bond is worded as an owner setting, not a guarantee", () => {
  it.each([...new Set(SWEPT.map(([f]) => f))])("%s carries no 'never less' / 'capped on-chain' bond phrasing", (file) => {
    const text = visibleSource(file)
    for (const [label, re] of GUARANTEE_PHRASES) {
      expect(text, `${file} still says "${label}"`).not.toMatch(re)
    }
  })

  it.each(SWEPT)("%s says 'at least {floor} XRD today (an owner setting)'", (file, mustSay) => {
    expect(visibleSource(file)).toMatch(mustSay)
  })
})
