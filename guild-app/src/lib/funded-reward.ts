import { XRD_ADDRESS } from "./radix"
import { eqXrd, normalizeXrd } from "./xrd-decimal"

// Funding parity: the reward a task row ADVERTISES against the reward its
// escrow actually HOLDS.
//
// WHY (2026-09-23 funding audit): the board's `rewardXrd` is the poster's own
// POST/PATCH value and is never re-derived from chain. Linking a row to its
// on-chain task (create confirm → onChainTaskId) is what turns it "funded" —
// listed under `?funded=true`, shown claimable — and that link was checked for
// the task id and the emitting component only. The funded AMOUNT was recorded
// onto the ledger's `fund` row and never compared, and an unreadable amount
// silently fell back to the row's own figure. So a create_task that escrowed 1
// XRD could be confirmed onto a row advertising 6,400, and the board would list
// a 6,400 XRD claimable task backed by 1 XRD. Nothing downstream catches it:
// under pull the payout is whatever the chain holds (M1's manifest guard went
// with the push branch), and the drift watcher compared STATE, never amount.
//
// The audit found every live row in parity. This makes it a checked invariant
// instead of an observed one. Once a row is linked the reward cannot move on
// either side — PATCH 409s a funded row, and the blueprint only drains a
// task's reward vault on a transition out of Open/Claimed/Submitted/Disputed —
// so parity at the link plus the watcher's per-run re-check is the whole
// guarantee.
//
// Exact decimal comparison, never Number(): "765.000000000000000000" (the
// numeric(38,18) column) must equal "765" (the chain's Decimal), and
// "1.000000000000000001" must NOT equal "1".

/** The on-chain side: TaskCreatedEvent fields, or the task's live TaskInfo. */
export interface FundedRewardOnChain {
  rewardAmount: string | null
  rewardToken: string | null
}

/** The row side: `rewardResource` NULL = XRD (tasks.reward_resource's contract). */
export interface AdvertisedReward {
  rewardXrd: string
  rewardResource?: string | null
}

export type FundedRewardVerdict =
  /** `funded` is the chain's own spelling of the amount (e.g. "765"). */
  | { kind: "match"; funded: string }
  /** The chain side could not be read — nothing can be asserted, in either direction. */
  | { kind: "unreadable" }
  | {
      kind: "mismatch"
      advertised: string
      advertisedToken: string
      funded: string
      fundedToken: string
    }

export function checkFundedReward(
  row: AdvertisedReward,
  chain: FundedRewardOnChain,
): FundedRewardVerdict {
  const { rewardAmount, rewardToken } = chain
  // `typeof`, not `=== null`: a caller that omits a field hands in `undefined`,
  // and that must read as "cannot say", not as a token called "undefined".
  if (typeof rewardAmount !== "string" || typeof rewardToken !== "string") {
    return { kind: "unreadable" }
  }

  // NULL = XRD. A non-NULL value has no writer today (validation.ts, "XRD
  // ONLY"); when the reward-resource flip gives it one, it must hold the
  // resource ADDRESS for this comparison to pass. A symbol will read as a
  // mismatch — loudly, at the first funded confirm — never as a silent pass.
  const advertisedToken = row.rewardResource ?? XRD_ADDRESS

  let sameAmount: boolean
  try {
    sameAmount = eqXrd(row.rewardXrd, rewardAmount)
  } catch {
    // Either side is not an exact decimal. The column is numeric(38,18) and
    // the chain readers shape-check their value, so this is a shape change,
    // not a finding.
    return { kind: "unreadable" }
  }
  if (sameAmount && rewardToken === advertisedToken) return { kind: "match", funded: rewardAmount }
  return {
    kind: "mismatch",
    advertised: row.rewardXrd,
    advertisedToken,
    funded: rewardAmount,
    fundedToken: rewardToken,
  }
}

/** "advertises 6400 XRD but the escrow holds 1 XRD" — for API errors and alerts. */
export function describeFundedRewardMismatch(
  v: Extract<FundedRewardVerdict, { kind: "mismatch" }>,
): string {
  const amount = (value: string) => {
    try {
      return normalizeXrd(value)
    } catch {
      return value
    }
  }
  const unit = (token: string) => (token === XRD_ADDRESS ? "XRD" : token)
  return (
    `advertises ${amount(v.advertised)} ${unit(v.advertisedToken)} ` +
    `but the escrow holds ${amount(v.funded)} ${unit(v.fundedToken)}`
  )
}
