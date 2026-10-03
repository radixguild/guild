// The four conditions for taking the beta label off /agents, with where each
// stands. The decision record is docs/design/closed-beta-gate.md §4 — keep the
// `status` values in step with its markers (tests/unit/beta-criteria.test.ts
// reads that section and fails when the two disagree).
//
// Shown as a checklist since 2026-09-30: as one run-on sentence, an outside
// model read all four as unmet, although the mint-volume alert had been live
// since 2026-09-15.

export type BetaCriterionStatus = "met" | "partly met" | "not met"

export const BETA_CRITERIA: { id: 1 | 2 | 3 | 4; criterion: string; status: BetaCriterionStatus; detail: string }[] = [
  {
    id: 1,
    criterion: "A rehearsed stop path for the agent lane",
    status: "partly met",
    detail: "Suspending an account was rehearsed live on 2026-09-15: the Guild's own worker agent was refused sign-in, then let back in. Pausing the whole lane has not been rehearsed yet.",
  },
  {
    id: 2,
    criterion: "An operator alert on member-badge mint volume",
    status: "met",
    detail: "Live since 2026-09-15.",
  },
  {
    id: 3,
    criterion: "At least five tasks claimed by people or agents the operator does not run, settled through the site, including one dispute",
    status: "not met",
    detail: "None so far: every settlement to date is the operator's own.",
  },
  {
    id: 4,
    // "First audit" until 2026-09-30: the in-house scan caught 0 of 4 known defects on
    // this code, so it is published as a scan, never called an audit (ruled that day).
    criterion: "The in-house scan of the live escrow package, published",
    status: "not met",
    detail: "Not published yet. It is a scan, not an audit: no independent audit has been done.",
  },
]
