import { z } from "zod"
import { TaskTermsSchema, type TaskTerms } from "./task-terms"

/**
 * Pool charter — what a funding pool agrees BEFORE anyone pledges into it.
 *
 * ## Why this exists
 *
 * A pool used to be four fields: title, description, target, deadline. That is
 * enough to collect money and nowhere near enough to agree a piece of work.
 * Someone pledging into a pool is committing to an outcome they cannot yet
 * see, decided by someone they may not know, against a definition of "done"
 * that did not exist when they pledged. Every one of those gaps is where a
 * community-funded project turns into an argument.
 *
 * So a pool is now a project charter first and a fundraiser second: the scope,
 * the non-goals, the acceptance criteria and the person who accepts the work
 * are all settled while the pool is a DRAFT, and pledging only opens once the
 * poster has published that charter. What contributors pledge against is a
 * document, not a paragraph.
 *
 * ## The load-bearing decision: a charter IS the task's terms
 *
 * `terms` below is `TaskTermsSchema` verbatim — not a parallel vocabulary that
 * looks like it, not a subset, the same schema the task wizard writes. That is
 * deliberate and it is the whole point of the design:
 *
 *   A funded pool becomes a task. `canonicalTermsBlock` turns that task's
 *   terms into the v2 work-brief that `create_task` sha256-commits on chain.
 *   If the charter spoke its own dialect, something would have to translate —
 *   and a translation layer between "what people funded" and "what was
 *   committed on chain" is precisely the seam a dispute would open.
 *
 * Because the charter is the terms, what contributors read before pledging is
 * byte-for-byte what ends up inside the on-chain brief hash. No mapping, no
 * drift, no "the pool said one thing and the task committed another".
 *
 * ## What is NOT enforced
 *
 * Everything here is a STATED commitment, exactly like task terms: the escrow
 * blueprint machine-enforces token, amounts, deadlines and bond, and nothing
 * else. In particular `steward` records who the pool says will accept the work
 * — it does not grant them any authority, because the FundingPool blueprint
 * that would hold the task receipt and expose a steward-gated approve path
 * does not exist yet (docs/design/funding-pool-blueprint.md is status:
 * proposal). Any UI rendering `steward` must say so. See
 * docs/design/pool-charter.md §"Not enforced".
 */

/** 1–7 short, checkable statements. Same shape and limits as the task
 *  wizard's acceptance criteria, for the same reason: a list a reviewer can
 *  run down beats a paragraph nobody rereads. */
const shortLines = (max: number) =>
  z.array(z.string().trim().min(3).max(200)).min(1).max(max)

/**
 * Who accepts the work on the funders' behalf.
 *
 * This is the question a community-funded task has and an ordinary task does
 * not: the poster put up none of the money, so "the poster decides" is a
 * choice that needs making out loud rather than a default nobody noticed.
 *
 * ⚠️ STATED, NOT ENFORCED — see the module doc. The blueprint ruling is that
 * the pool retains the task receipt and approve becomes a pool method
 * (funding-pool-blueprint.md §1, "A community task's approve path is
 * therefore not the existing poster flow"). Until that blueprint ships, the
 * live escrow's receipt-holder approves, whatever this field says.
 */
export const STEWARDS = ["poster", "working-group", "operator"] as const
export type Steward = (typeof STEWARDS)[number]

export const STEWARD_LABELS: Record<Steward, string> = {
  poster: "The poster who opened the pool",
  "working-group": "The working group this is routed to",
  operator: "The Guild operator, as arbiter",
}

export const PoolCharterSchema = z
  .object({
    /**
     * Why this is worth funding — the one thing a task brief never has to
     * answer and a funding ask always does. Floor of 40 characters because
     * "we need this" is not a rationale and a pool asking strangers for money
     * should have to write more than three words.
     */
    problem: z.string().trim().min(40).max(600),

    /** What exists at the end that does not exist now. Concrete nouns. */
    deliverables: shortLines(7),

    /**
     * Explicit non-goals. Optional in the schema, prompted hard in the UI:
     * this is the cheapest dispute-prevention on the page, because almost
     * every "that isn't what we funded" argument is about something nobody
     * wrote down as excluded.
     */
    outOfScope: z.array(z.string().trim().min(3).max(200)).max(7).optional(),

    /** What must already be true before this can start — other pools, an
     *  audit, a deployed component, a decision. */
    prerequisites: z.array(z.string().trim().min(3).max(200)).max(5).optional(),

    /** Who accepts the work. Stated, not enforced — see STEWARDS. */
    steward: z.enum(STEWARDS).optional(),

    /**
     * The terms the resulting task will carry, agreed up front. Reused
     * wholesale from the task wizard — see the module doc for why this must
     * never become a bespoke copy.
     */
    terms: TaskTermsSchema,
  })
  .strict()

export type PoolCharter = z.infer<typeof PoolCharterSchema>

/**
 * A charter's readiness, as a list of what is still missing.
 *
 * Returned rather than thrown, and phrased for a human, because this drives
 * the checklist in the create form as the poster types — the same shape the
 * task wizard's own gating uses. `blocking` is what the publish button waits
 * on; `advisory` is what a good charter has and a valid one can go without.
 */
export interface CharterReadiness {
  blocking: string[]
  advisory: string[]
  ready: boolean
}

export function charterReadiness(
  charter: Partial<PoolCharter> | null | undefined,
): CharterReadiness {
  const blocking: string[] = []
  const advisory: string[] = []
  const c = charter ?? {}
  const terms: Partial<TaskTerms> = c.terms ?? {}

  if (!c.problem || c.problem.trim().length < 40) {
    blocking.push("Say what problem this solves — at least a couple of sentences.")
  }
  if (!c.deliverables?.length) {
    blocking.push("List at least one deliverable: what exists at the end that doesn't now.")
  }
  if (!terms.acceptanceCriteria?.length) {
    blocking.push("Add at least one acceptance criterion the reviewer can check.")
  }

  // Advisory: a charter is valid without these and weaker for missing them.
  if (!c.outOfScope?.length) {
    advisory.push("Name what's out of scope — most funding arguments are about an unwritten exclusion.")
  }
  if (!c.steward) {
    advisory.push("Say who accepts the work on the funders' behalf.")
  }
  if (!terms.definitionOfDone?.length) {
    advisory.push("Pick the objective gates the deliverable must clear.")
  }
  if (!terms.claimEligibility) {
    advisory.push("Say whether humans, agents, or both can build this.")
  }
  if (!terms.specUrl && !terms.repoUrl) {
    advisory.push("Link the spec or the repo the work answers to.")
  }

  return { blocking, advisory, ready: blocking.length === 0 }
}

/** True when the object carries a usable charter (mirrors hasTerms). */
export function hasCharter(charter: PoolCharter | null | undefined): charter is PoolCharter {
  return !!charter && charterReadiness(charter).ready
}
