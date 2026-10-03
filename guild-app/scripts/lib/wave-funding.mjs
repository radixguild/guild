// wave-funding.mjs — the ONE definition of what a wave of tasks costs the poster,
// and the one XRD balance read. Imported by post-micro-tasks.mjs (which spends it)
// and fleet-recycle.mjs (which tops it up).
//
// WHY THIS IS SHARED: the funding formula lived inline in post-micro-tasks.mjs.
// A recycle tool that computed the poster's shortfall with its own copy would
// eventually disagree by a rounding rule or a headroom constant, and the failure
// mode is ugly and asymmetric — sweep too little and the batch fails closed at
// task 1 having already moved money; sweep from a stale formula and the number
// looks authoritative while being wrong. The reconciler carried a hand-typed
// duplicate of EVENT_TO_KIND for exactly this reason and silently dropped an
// event for weeks. Same class, same remedy: derive, never re-type.

import { XRD_ADDRESS } from "../../src/lib/radix"

// Sourced from the one canonical definition (../../src/lib/radix.ts), not a
// local literal — consolidated so a future reward-resource flip (XRD → USD
// stablecoin) only ever needs to change one file's value.
export const XRD = XRD_ADDRESS

/**
 * The escrow charges insurance on top of the reward at the component's
 * min_insurance_fraction (0.05, chain-verified on the live component).
 */
export const INSURANCE_MULTIPLIER = 1.05

/**
 * Per-task XRD kept back for the fund transaction's own fee. Deliberately
 * generous: a real full cycle burns ~3.3 XRD across FOUR txs (post+claim+
 * submit+release), of which the poster pays roughly half, so 3 XRD/task of
 * poster-side headroom is ~2x the observed cost. Being wrong in this direction
 * costs nothing; being wrong the other way strands a batch mid-wave.
 */
export const FEE_HEADROOM_PER_TASK = 3

/**
 * Worst-case XRD the poster must hold to fund a whole batch.
 *
 * Worst-case, not expected-case, and the batch check is all-or-nothing on
 * purpose: post-micro-tasks funds tasks in sequence, so a shortfall discovered
 * at task 7 of 10 has already spent real money and left the board half-built.
 *
 * @param {number[]} rewards one reward (in XRD) per task in the batch
 * @returns {number} XRD required to fund all of them
 */
export function waveFundingNeed(rewards) {
  if (!Array.isArray(rewards)) throw new TypeError("waveFundingNeed expects an array of rewards")
  return rewards.reduce((total, reward) => {
    const r = Number(reward)
    if (!Number.isFinite(r) || r <= 0) throw new RangeError(`reward must be a positive number (got ${reward})`)
    return total + r * INSURANCE_MULTIPLIER + FEE_HEADROOM_PER_TASK
  }, 0)
}

/** Live XRD balance of an account, read from the Gateway. 0 if the account holds none. */
export async function xrdBalance(account, gateway = "https://mainnet.radixdlt.com") {
  const res = await fetch(`${gateway}/state/entity/details`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ addresses: [account] }),
  })
  if (!res.ok) throw new Error(`Gateway /state/entity/details → HTTP ${res.status}`)
  const d = await res.json()
  const f = d.items?.[0]?.fungible_resources?.items?.find((x) => x.resource_address === XRD)
  return f ? Number(f.amount) : 0
}
