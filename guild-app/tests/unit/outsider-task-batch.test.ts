/**
 * The outsider task batches — drafts/outsider-tasks/batch.json (Wave A, "no
 * repository access needed"), drafts/outsider-tasks/batch-wave-b.json
 * (Wave B, a pull request against the public Guild repository, posted only
 * after the open-source flip) and drafts/outsider-tasks/batch-agent.json (the
 * agent batch A1–A8, no repository access either, five of its rows at a reward
 * where the claim-bond floor applies) — against the REAL gates.
 *
 * WHY THIS IS A TEST AND NOT A ONE-OFF CHECK. Each batch is drafted on one day
 * and posted by the operator on another. The rule tables move in between (six
 * affiliation rules landed on 2026-09-19, one more on 2026-09-21), and task text is
 * hashed on-chain at funding: a row the write gate would refuse, or the public
 * scrub would rewrite, has to be found BEFORE the operator is holding a key — not
 * by a 400 halfway through a batch. `POST /api/v1/tasks` runs the same two
 * functions this file does.
 *
 * It also pins the things a reviewer cannot see by reading: that each terms file
 * is byte-for-byte the terms in its batch, that no description carries a dollar
 * figure that will go stale while the task sits open, that every row states
 * the bond its own reward really carries, that no row promises the bond back
 * without saying a dispute splits it the way the reward splits, and that every
 * row says the bond is forfeited only when the deadline is missed AND the claim
 * is ended (one exact clause, since 2026-10-02). Wave A and Wave B go further and keep
 * the bond at a clean 10% (below 764.5 XRD the 76.45 floor takes over and a
 * first-time claimer stakes a quarter of the reward, or more). The agent batch
 * keeps its draft's 500 XRD rows, so for those five the copy must say the floor
 * applies, and must not say a flat 10%.
 *
 * THE AGENT BATCH, three checks of its own. Its README section carries the exact
 * posting commands and the escrow totals for each wave, and the 2026-09-28 draft
 * it came from got its own total wrong (a 5,060 XRD header over rows that summed
 * to 4,795 in rewards), so this file recomputes every figure that README states
 * and parses every command it gives. It also pins which drafted row ids (A1–A8)
 * are present, and which rows wait on something before they may be posted.
 *
 * WAVE A vs WAVE B, the one deliberate difference. Wave A's whole point is that a
 * claimer needs no repository access at all — every row promises that, in words,
 * and carries no `terms.repoUrl`. Wave B is the opposite by design (2026-09-30
 * ruling): its deliverable IS a pull request, against a public repository that
 * does not exist yet at the time this file was written (K3: its name is not
 * ruled) — so its rows instead name "the public Guild repository linked from the
 * site's Docs page" and must never guess a URL (no `github.com` literal, no
 * `terms.repoUrl`, since there is nothing real yet to point it at). Every other
 * gate — scrub, the task write gate, both BANNED/PULL_BANNED rule tables, the
 * length caps, the no-dollar-figure guard, the bond-copy guard, the bond-dispute
 * guard, the bond-forfeit guard, terms parsing, and batch↔terms identity — applies
 * to every batch identically.
 */
import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { scrubWouldChange } from "@/lib/public-task-text"
import { bannedTaskClaimIn } from "@/lib/project-copy-gate"
import { TaskTermsSchema } from "@/lib/task-terms"
import { ESCROW_CLAIM_BOND_XRD } from "@/lib/config"
import { INSURANCE_RATE, TASK_DESCRIPTION_MAX_CHARS } from "@/lib/marketplace"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"
import { privateInputs } from "../support/private-input"

type Row = {
  key: string
  title: string
  description: string
  reward_xrd: string
  terms: Record<string, unknown>
  /** Agent batch only: the 2026-09-28 draft's row id (A1–A8), so the operator's cross-reference holds. */
  ref?: string
  /** Agent batch only: null when the row may be posted now, otherwise what has to happen first. */
  post_after?: string | null
}
type Rule = { label: string; re: RegExp; allow?: RegExp[] }

const DIR = join(process.cwd(), "..", "drafts", "outsider-tasks")
const RULES = [...BANNED, ...PULL_BANNED] as Rule[]
const textOf = (r: Row) => [r.title, r.description, ...((r.terms.acceptanceCriteria as string[]) ?? [])].join("\n")

// The bond is clamp(reward × claim_bond_pct, claim_bond_floor, claim_bond_cap) — escrow
// lib.rs `required_bond`. claim_bond_pct is 0.1 on the live component (docs/ESCROW-ADDRESSES.md,
// Wave B sheet row 11; read back on the Gateway 2026-10-01 at state version 560527018); the
// floor is ESCROW_CLAIM_BOND_XRD. Each row's money paragraph says one of these two things,
// and which one is decided by its reward, not by the batch it sits in.
const CLAIM_BOND_PCT = 0.1
const BOND_CLEAN = "Claiming stakes a bond of 10% of the reward;"
const BOND_FLOOR = "at this reward the floor applies"

/** null when the row states the bond its own reward carries; otherwise what is wrong. */
function bondCopyProblem(r: Row): string | null {
  const floorApplies = Number(r.reward_xrd) * CLAIM_BOND_PCT < ESCROW_CLAIM_BOND_XRD
  const [want, wrong] = floorApplies ? [BOND_FLOOR, BOND_CLEAN] : [BOND_CLEAN, BOND_FLOOR]
  if (!r.description.includes(want)) return `${r.key}: reward ${r.reward_xrd} needs "${want}"`
  if (r.description.includes(wrong)) return `${r.key}: reward ${r.reward_xrd} must not say "${wrong}"`
  return null
}

// The bond's dispute branch. Approval, the review-window release and a poster's cancel credit the
// bond back whole, but a dispute splits it the same way as the reward: escrow lib.rs
// `credit_split_for_parties`, the one helper `resolve_dispute` and `auto_resolve_dispute` both
// route through ("The REWARD ruling governs the bond"), so the arbiter's ruling and the default
// applied after the window split it alike (the live default, SplitEvenly, credits half of it to the
// poster). Until 2026-10-02 every row of every batch promised the bond back with no word of that
// branch, and nothing here could see it: the checks above pin the bond's SIZE, not where it goes.
//
// "raised", not "ruled": the task page's own dispute panel tells "a ruling" apart from "the
// default" and calls a dispute nobody rules "unruled", while that default still splits the bond
// 50/50 — so "unless a dispute is ruled" would read as a full refund on the very branch the live
// default takes. Every way out of Disputed (lib.rs has two) splits the bond like the reward.
const BOND_DISPUTE_SPLIT = "unless a dispute is raised, in which case it is split the same way as the reward"
/** A promise that the bond comes back to the claimer, in any of the ways copy here has said it. */
const BOND_BACK =
  /\b(?:credited|comes?|handed|given|paid)\s+back\b|\bback\s+to\s+you\b|\b(?:returned|refunded|repaid)\s+(?:in\s+full\s+)?to\s+you\b|\bgets?\s+(?:it|(?:the|your)\s+bond)\s+back\b/i

/**
 * null when every sentence that promises the bond back also says a dispute splits it; otherwise
 * what is wrong. A sentence counts as being about the bond when its paragraph names the bond: the
 * rows say "It stays in the escrow…" one sentence after "Claiming stakes a bond…".
 */
function bondDisputeProblem(r: Row): string | null {
  for (const paragraph of r.description.split(/\n\s*\n/)) {
    if (!/\bbond\b/i.test(paragraph)) continue
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      if (BOND_BACK.test(sentence) && !sentence.includes(BOND_DISPUTE_SPLIT)) {
        return `${r.key}: promises the bond back without "${BOND_DISPUTE_SPLIT}": ${sentence}`
      }
    }
  }
  return null
}

// The bond's forfeit condition, one exact form in every batch (2026-10-02). Wave A and Wave B said
// "it is lost if you claim and do not submit before the deadline", which is looser than lib.rs:
// `submit_task` has no deadline check, so a late submit still saves the bond until someone ends
// the claim, and `expire_claim` (the only way a bond is forfeited) needs the claim still Claimed
// and `expire_grace_secs` (an hour, read live) past the deadline. The agent batch already said it
// this way, and the site's own words for expire_claim are "end the claim" (/trust, /llms.txt).
const BOND_FORFEIT = "it is forfeited if you miss the submit deadline the task page shows and the claim is then ended."

/** null when the row states the forfeit condition in the exact form; otherwise what is wrong. */
function bondForfeitProblem(r: Row): string | null {
  if (!r.description.includes(BOND_FORFEIT)) return `${r.key}: missing "${BOND_FORFEIT}"`
  if (/\bis lost if\b|\bbefore the deadline\b/i.test(r.description)) return `${r.key}: still carries the pre-2026-10-02 forfeit wording`
  return null
}

type BatchSpec = {
  /** The batch's own filename, under drafts/outsider-tasks/. */
  file: string
  /**
   * Wave A promises "no repository access is needed" and carries no repoUrl.
   * Wave B is the opposite by design: its deliverable IS a pull request against
   * a repository that does not exist yet, so it names "the public Guild
   * repository" instead and must never guess a URL. Exactly one of these two is
   * true for every batch; the shared gates below don't change either way.
   */
  requiresNoRepoAccess: boolean
  /**
   * Wave A and Wave B are priced so the claim bond is a clean 10% of the reward
   * (≥ 764.5 XRD), and that is enforced. The agent batch keeps its draft's S rows at
   * 500 XRD, where the 76.45 floor applies instead (15.3% of the reward). That is
   * allowed there only because the shared bond-copy test makes each such row say so.
   */
  cleanTenPercentBond: boolean
  /**
   * Agent batch only: the drafted row ids in batch order, and the rows ruled to wait
   * (ref → what its `post_after` must name). Every other row carries `post_after: null`.
   */
  drafted?: { refs: string[]; holds: Record<string, RegExp> }
}

const AGENT_BATCH = "batch-agent.json"

const BATCHES: BatchSpec[] = [
  { file: "batch.json", requiresNoRepoAccess: true, cleanTenPercentBond: true },
  { file: "batch-wave-b.json", requiresNoRepoAccess: false, cleanTenPercentBond: true },
  {
    file: AGENT_BATCH,
    requiresNoRepoAccess: true,
    cleanTenPercentBond: false,
    // A2, the end-to-end machine loop, is postable only after #790 ships
    // `guild-agent run` (ruled 2026-10-01).
    drafted: { refs: ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"], holds: { A2: /#790\b/ } },
  },
]

// drafts/outsider-tasks/** stays private at the open-source flip (drafts/** is
// EXCLUDE — publish/MANIFEST.md) — skip in the public export, throw in the
// private tree if it ever goes missing (tests/support/private-input.ts).
const PRIV = privateInputs(
  ...BATCHES.map((b) => join("drafts", "outsider-tasks", b.file)),
  join("drafts", "outsider-tasks", "README.md"),
)

if (PRIV.skip) {
  describe.skip("drafts/outsider-tasks (private input absent in the public export)", () => {
    it("skipped — see tests/support/private-input.ts", () => {})
  })
}

for (const batch of PRIV.skip ? [] : BATCHES) {
  const rows: Row[] = JSON.parse(readFileSync(join(DIR, batch.file), "utf8"))

  describe(`drafts/outsider-tasks/${batch.file}`, () => {
    it("is a real batch (vacuous-pass guard)", () => {
      expect(rows.length).toBeGreaterThanOrEqual(3)
      for (const r of rows) {
        expect(r.key).toMatch(/^[a-z0-9-]+$/)
        expect(r.description.length).toBeGreaterThan(400)
      }
      expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
      expect(new Set(rows.map((r) => r.title)).size).toBe(rows.length)
    })

    it.each(rows.map((r) => [r.key, r] as const))("%s: the public scrub would not rewrite it (brief hash stays reproducible)", (_k, r) => {
      expect(scrubWouldChange(r.title, r.description)).toBeNull()
    })

    it.each(rows.map((r) => [r.key, r] as const))("%s: the task write gate would accept it", (_k, r) => {
      const criteria = ((r.terms.acceptanceCriteria as string[]) ?? []).join("\n")
      expect(bannedTaskClaimIn({ title: r.title, description: r.description, requirements: criteria })).toBeNull()
    })

    it.each(rows.map((r) => [r.key, r] as const))("%s: clears BOTH rule tables with no quoted-mention exemption", (_k, r) => {
      // Stricter than the server on purpose. The write gate exempts text inside double quotes or
      // backticks in TASK copy (a spec that fixes a false claim has to name it). Nothing here needs
      // that, so nothing here gets it — and the text carries no double quotes to hide behind.
      expect(textOf(r)).not.toMatch(/["`]/)
      const hits = RULES.map((rule) => violation(textOf(r), rule) && rule.label.split(" ")[0]).filter(Boolean)
      expect(hits).toEqual([])
    })

    it.each(rows.map((r) => [r.key, r] as const))("%s: terms parse, and the terms file is the batch's terms exactly", (_k, r) => {
      expect(TaskTermsSchema.safeParse(r.terms).success).toBe(true)
      const file = join(DIR, `terms-${r.key}.json`)
      expect(existsSync(file)).toBe(true)
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(r.terms)
    })

    if (batch.requiresNoRepoAccess) {
      it.each(rows.map((r) => [r.key, r] as const))("%s: fits every length cap, and promises no repository", (_k, r) => {
        expect(r.title.length).toBeLessThanOrEqual(120) // post-micro-tasks' cap — tighter than the server's 200
        expect(r.description.length).toBeLessThanOrEqual(TASK_DESCRIPTION_MAX_CHARS)
        expect(r.description).toMatch(/No repository access is needed/)
        expect((r.terms as { repoUrl?: string }).repoUrl).toBeUndefined()
      })
    } else {
      it.each(rows.map((r) => [r.key, r] as const))("%s: fits every length cap, and names the public repository without guessing a URL", (_k, r) => {
        expect(r.title.length).toBeLessThanOrEqual(120)
        expect(r.description.length).toBeLessThanOrEqual(TASK_DESCRIPTION_MAX_CHARS)
        expect(r.description).toMatch(/the public Guild repository/)
        // K3: the public repo's name/URL is not ruled yet — never guess one.
        expect(r.description).not.toMatch(/github\.com/i)
        expect((r.terms as { repoUrl?: string }).repoUrl).toBeUndefined()
      })
    }

    it.each(rows.map((r) => [r.key, r] as const))("%s: states no price-dependent figure", (_k, r) => {
      // A dollar value goes stale while the task sits open (board 99/100 still say the
      // treasury is "about thirty dollars"). The task page shows the live figure instead.
      expect(r.description).not.toMatch(/\$\s?\d|\bUSD\b|\bcents?\b|\bdollars?\b(?! value)/i)
      expect(r.reward_xrd).toMatch(/^\d+(\.\d{1,8})?$/)
    })

    if (batch.cleanTenPercentBond) {
      it.each(rows.map((r) => [r.key, r] as const))("%s: keeps the bond at a clean ten percent of the reward", (_k, r) => {
        expect(Number(r.reward_xrd) * CLAIM_BOND_PCT).toBeGreaterThanOrEqual(ESCROW_CLAIM_BOND_XRD)
      })
    }

    it.each(rows.map((r) => [r.key, r] as const))("%s: states the bond its own reward carries — a clean ten percent, or the floor", (_k, r) => {
      expect(bondCopyProblem(r)).toBeNull()
    })

    it("says the true thing about the bond — never that it comes back on submit", () => {
      for (const r of rows) {
        expect(r.description).toMatch(/stays in the escrow until the task settles/)
      }
    })

    it.each(rows.map((r) => [r.key, r] as const))("%s: never promises the bond back without saying a dispute splits it like the reward", (_k, r) => {
      expect(bondDisputeProblem(r)).toBeNull()
    })

    it.each(rows.map((r) => [r.key, r] as const))("%s: states when the bond is forfeited the way lib.rs does — a missed deadline AND an ended claim", (_k, r) => {
      expect(bondForfeitProblem(r)).toBeNull()
    })

    if (batch.drafted) {
      const { refs, holds } = batch.drafted

      it("carries every drafted row id exactly once, in the draft's order", () => {
        expect(rows.map((r) => r.ref)).toEqual(refs)
      })

      it.each(rows.map((r) => [r.ref ?? r.key, r] as const))("%s: is held exactly when ruled, and names what it waits for", (_k, r) => {
        const hold = holds[r.ref ?? ""]
        if (hold) expect(r.post_after ?? "").toMatch(hold)
        else expect(r.post_after).toBeNull()
      })
    }
  })

  describe(`controls (${batch.file}) — each gate above fires on a planted defect`, () => {
    const base = rows[0]

    it("scrub: a host alias, an ops command and a server path are each refused", () => {
      expect(scrubWouldChange(base.title, base.description + "\nRun it on guild-vps.")).not.toBeNull()
      expect(scrubWouldChange(base.title, base.description + "\nThen ssh box-1.example and look.")).not.toBeNull()
      expect(scrubWouldChange(base.title, base.description + "\nLogs are in /var/log/guild.log")).not.toBeNull()
    })

    it("write gate: a banned claim is refused", () => {
      expect(bannedTaskClaimIn({ title: base.title, description: base.description + " Settlement here is trustless." })).not.toBeNull()
    })

    it("rule tables: a PULL_BANNED claim is caught, so the second table really is in the scan", () => {
      const planted = textOf(base) + "\nThe poster approves and escrow pays you."
      const hit = (PULL_BANNED as Rule[]).filter((rule) => violation(planted, rule)).map((r) => r.label.split(" ")[0])
      expect(hit).toContain("approval-pays")
      // …and the unplanted text does not trip it, so the hit above is the plant, not the batch.
      expect((PULL_BANNED as Rule[]).some((rule) => violation(textOf(base), rule))).toBe(false)
    })

    it("price guard: a planted dollar figure is caught", () => {
      expect("worth about $0.40 today").toMatch(/\$\s?\d|\bUSD\b|\bcents?\b|\bdollars?\b(?! value)/i)
    })

    it("bond-copy guard: the clean-10% sentence on a floor reward, and the floor sentence on a clean one, are both caught", () => {
      expect(bondCopyProblem(base)).toBeNull()
      // Re-price the real row across the 764.5 XRD line, keeping its text: the copy is now wrong.
      const across = { ...base, reward_xrd: Number(base.reward_xrd) * CLAIM_BOND_PCT < ESCROW_CLAIM_BOND_XRD ? "765" : "500" }
      expect(bondCopyProblem(across)).not.toBeNull()
      // And a row that says both things is caught whichever side its reward is on.
      const both = { ...base, description: `${base.description} ${BOND_CLEAN} ${BOND_FLOOR}` }
      expect(bondCopyProblem(both)).not.toBeNull()
    })

    it("bond-dispute guard: the pre-2026-10-02 sentence, and the same promise reworded, are both caught", () => {
      // The real row promises the bond back, so the check runs on real text, not only on plants.
      expect(BOND_BACK.test(base.description)).toBe(true)
      expect(bondDisputeProblem(base)).toBeNull()
      // Put back what every row said until 2026-10-02: credited back to you, and no dispute branch.
      const old = { ...base, description: base.description.replace(`, ${BOND_DISPUTE_SPLIT};`, ", and") }
      expect(old.description).not.toBe(base.description)
      expect(old.description).toMatch(/is then credited back to you, and it is (forfeited|lost) if/)
      expect(bondDisputeProblem(old)).not.toBeNull()
      // The same promise in other words, in a paragraph of its own, is caught too.
      const reworded = { ...base, description: `${base.description}\n\nYou get your bond back when the task settles.` }
      expect(bondDisputeProblem(reworded)).not.toBeNull()
    })

    it("bond-forfeit guard: the pre-2026-10-02 Wave A/B tail is caught", () => {
      expect(bondForfeitProblem(base)).toBeNull()
      const old = { ...base, description: base.description.replace(BOND_FORFEIT, "it is lost if you claim and do not submit before the deadline.") }
      expect(old.description).not.toBe(base.description)
      expect(bondForfeitProblem(old)).not.toBeNull()
      // The exact clause does not launder the old wording left beside it.
      const both = { ...base, description: `${base.description} It is lost if you claim and do not submit before the deadline.` }
      expect(bondForfeitProblem(both)).not.toBeNull()
    })

    if (!batch.requiresNoRepoAccess) {
      it("repo-name guard: a guessed github.com URL is caught, and the real row is not", () => {
        expect(base.description + "\nSee https://github.com/example/example.").toMatch(/github\.com/i)
        expect(base.description).not.toMatch(/github\.com/i)
        expect(base.description).toMatch(/the public Guild repository/)
      })
    }
  })
}

// ── Across batches, and the agent batch's README section ──────────────────────

/** 4233 → "4,233 XRD": a fixed format, with no dependence on the runtime's locale data. */
const xrd = (n: number) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} XRD`
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0)

/**
 * What one post locks in escrow: the reward, plus insurance exactly as guild-poster funds
 * it — computeInsuranceXrd(reward) = Math.ceil(reward × INSURANCE_RATE)
 * (packages/agent-client/src/manifests.ts, parity-pinned to this app's INSURANCE_RATE by
 * its manifests.test.ts). The chain's own floor, min_insurance_fraction, is 0 on the live
 * component, so this app-side rule is the one that binds.
 */
const insuranceOf = (r: Row) => Math.ceil(Number(r.reward_xrd) * INSURANCE_RATE)
const locksOf = (r: Row) => Number(r.reward_xrd) + insuranceOf(r)

/**
 * The README's top-up rule: locks + 2 XRD per post for the network fee (a create_task
 * from AG-01 costs 1.10 XRD), rounded up to the next 50, so funding a wave never draws
 * on the poster's standing reserve.
 */
const TOP_UP_FEE_PER_POST = 2
const topUpFor = (rs: Row[]) => Math.ceil((sum(rs.map(locksOf)) + rs.length * TOP_UP_FEE_PER_POST) / 50) * 50

const AGENT_HEADING = "## Agent batch"
const HELD_COMMANDS_HEADING = "### Commands — wave 2"

/** Every way the section's per-row and per-wave tables disagree with the batch; [] when they agree. */
function figureProblems(rows: Row[], section: string): string[] {
  const lines = section.split("\n")
  const starting = (prefix: string) => lines.filter((l) => l.startsWith(prefix))
  const problems: string[] = []
  for (const r of rows) {
    const key = `| \`${r.key}\` |`
    const amounts = `| ${xrd(Number(r.reward_xrd))} | ${xrd(insuranceOf(r))} | ${xrd(locksOf(r))} |`
    const found = starting(`| ${r.ref} |`).filter((l) => l.includes(amounts))
    if (found.length !== 1 || !found[0].includes(key)) problems.push(`${r.ref}: want one table row with ${key} … ${amounts}`)
  }
  const waves = [
    { label: "| Wave 1", rows: rows.filter((r) => r.post_after === null), listsRefs: true },
    { label: "| Wave 2", rows: rows.filter((r) => r.post_after !== null), listsRefs: true },
    { label: "| Both waves", rows, listsRefs: false },
  ]
  for (const w of waves) {
    const refs = `| ${w.rows.map((r) => r.ref).join(", ")} |`
    const amounts =
      `| ${xrd(sum(w.rows.map((r) => Number(r.reward_xrd))))} | ${xrd(sum(w.rows.map(insuranceOf)))} ` +
      `| ${xrd(sum(w.rows.map(locksOf)))} | **${xrd(topUpFor(w.rows))}** |`
    const found = starting(w.label)
    if (found.length !== 1 || !found[0].includes(amounts) || (w.listsRefs && !found[0].includes(refs))) {
      problems.push(`${w.label.slice(2)}: want one line with ${w.listsRefs ? `${refs} … ` : ""}${amounts}`)
    }
  }
  return problems
}

/** A poster command line → the batch row it reads, or why it cannot be told. */
function commandRow(rows: Row[], line: string): { i: number; r: Row } | string {
  const indexes = [...new Set([...line.matchAll(/\.\[(\d+)\]\./g)].map((m) => Number(m[1])))]
  if (indexes.length !== 1) return `not exactly one row index: ${line.slice(0, 120)}`
  const r = rows[indexes[0]]
  return r ? { i: indexes[0], r } : `row index ${indexes[0]} is past the end of the batch`
}

/**
 * Every way the section's poster commands disagree with the batch; [] when they agree. Each
 * row needs exactly one dry-run and one --live command, both reading this batch at that row's
 * index, with that row's reward and its own terms file.
 */
function commandProblems(rows: Row[], section: string): string[] {
  const problems: string[] = []
  const seen = rows.map(() => ({ dry: 0, live: 0 }))
  for (const line of section.split("\n").filter((l) => l.includes("guild-poster.ts post"))) {
    const at = commandRow(rows, line)
    if (typeof at === "string") {
      problems.push(at)
      continue
    }
    const { i, r } = at
    const files = [...new Set([...line.matchAll(/outsider-tasks\/(batch[a-z-]*\.json)/g)].map((m) => m[1]))]
    const reward = /--reward (\S+)/.exec(line)?.[1]
    const termsKey = /\/terms-([a-z0-9-]+)\.json/.exec(line)?.[1]
    if (files.length !== 1 || files[0] !== AGENT_BATCH) problems.push(`${r.ref}: reads ${files.join(", ") || "no batch"}`)
    if (reward !== r.reward_xrd) problems.push(`${r.ref}: --reward ${reward}, the batch says ${r.reward_xrd}`)
    if (termsKey !== r.key) problems.push(`${r.ref}: terms-${termsKey}.json, the batch key is ${r.key}`)
    if (/ --live'?$/.test(line.trim())) seen[i].live++
    else seen[i].dry++
  }
  rows.forEach((r, i) => {
    if (seen[i].dry !== 1 || seen[i].live !== 1) {
      problems.push(`${r.ref}: ${seen[i].dry} dry-run and ${seen[i].live} --live commands (want 1 and 1)`)
    }
  })
  return problems
}

/** A held row's commands may only come after the held heading, and a postable row's only before it. */
function heldOrderProblems(rows: Row[], section: string): string[] {
  const at = section.indexOf(HELD_COMMANDS_HEADING)
  if (at === -1) return [`no "${HELD_COMMANDS_HEADING}" heading`]
  const problems: string[] = []
  for (const [part, wantHeld] of [[section.slice(0, at), false], [section.slice(at), true]] as const) {
    for (const line of part.split("\n").filter((l) => l.includes("guild-poster.ts post"))) {
      const found = commandRow(rows, line)
      if (typeof found === "string") continue // commandProblems reports it
      if ((found.r.post_after !== null) !== wantHeld) {
        problems.push(`${found.r.ref}: its command sits ${wantHeld ? "under" : "above"} the held heading`)
      }
    }
  }
  return problems
}

if (!PRIV.skip) {
  describe("drafts/outsider-tasks — across every batch", () => {
    it("every key is unique across batches (their terms-<key>.json files share one directory)", () => {
      const keys = BATCHES.flatMap((b) => (JSON.parse(readFileSync(join(DIR, b.file), "utf8")) as Row[]).map((r) => r.key))
      expect(keys.length).toBeGreaterThan(0)
      expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([])
    })
  })

  describe("drafts/outsider-tasks/README.md — the agent batch's figures and commands", () => {
    const rows: Row[] = JSON.parse(readFileSync(join(DIR, AGENT_BATCH), "utf8"))
    const readme = readFileSync(join(DIR, "README.md"), "utf8")
    const at = readme.indexOf(AGENT_HEADING)
    // The agent section only, so nothing in Wave A's or Wave B's sections can satisfy a check here.
    const section = at === -1 ? "" : readme.slice(at)

    it("has the section, with two poster commands per row (vacuous-pass guard)", () => {
      expect(at).toBeGreaterThan(-1)
      expect(section.split("\n").filter((l) => l.includes("guild-poster.ts post"))).toHaveLength(rows.length * 2)
    })

    it("every reward, insurance, lock and top-up figure is what the poster's own rule gives", () => {
      expect(figureProblems(rows, section)).toEqual([])
    })

    it("every command posts the row it names: index, reward and terms file agree, one dry-run and one --live each", () => {
      expect(commandProblems(rows, section)).toEqual([])
    })

    it("a held row's commands sit only under the held heading, and a postable row's only above it", () => {
      expect(heldOrderProblems(rows, section)).toEqual([])
    })
  })

  describe("controls (README.md, agent batch) — each check above fires on a planted defect", () => {
    const rows: Row[] = JSON.parse(readFileSync(join(DIR, AGENT_BATCH), "utf8"))
    const readme = readFileSync(join(DIR, "README.md"), "utf8")
    const section = readme.slice(readme.indexOf(AGENT_HEADING))
    const [first, second] = rows
    const firstLive = section.split("\n").find((l) => l.includes(`.[0].title`) && / --live'$/.test(l.trim())) ?? ""

    it("figures: a re-priced row is caught in its own line and in its wave's totals", () => {
      const repriced = rows.map((r, i) => (i === 0 ? { ...r, reward_xrd: "765" } : r))
      const problems = figureProblems(repriced, section)
      expect(problems.some((p) => p.startsWith(`${first.ref}:`))).toBe(true)
      expect(problems.some((p) => p.startsWith("Wave 1"))).toBe(true)
      expect(problems.some((p) => p.startsWith("Both waves"))).toBe(true)
    })

    it("commands: another row's terms file, a wrong reward, the wrong batch, and a lost --live are each caught", () => {
      expect(firstLive).not.toBe("")
      // Function replacers: the command text is full of `$(…)`, and a string replacer reads `$` specially.
      const swap = (from: string, to: string) => section.replace(firstLive, () => firstLive.replace(from, () => to))
      expect(commandProblems(rows, swap(`terms-${first.key}.json`, `terms-${second.key}.json`))).not.toEqual([])
      expect(commandProblems(rows, swap(`--reward ${first.reward_xrd} `, "--reward 5000 "))).not.toEqual([])
      expect(commandProblems(rows, swap(`.[0].description" /opt/guild-saas/drafts/outsider-tasks/${AGENT_BATCH}`, `.[0].description" /opt/guild-saas/drafts/outsider-tasks/batch.json`))).not.toEqual([])
      expect(commandProblems(rows, swap(" --live'", "'"))).not.toEqual([])
    })

    it("held order: a postable row's command moved under the held heading is caught", () => {
      expect(heldOrderProblems(rows, section + "\n" + firstLive)).not.toEqual([])
    })
  })
}
