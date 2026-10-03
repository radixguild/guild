/**
 * "What you need" — the XRD a newcomer must hold, worked out and worded in ONE place.
 *
 * /guide said "No XRD is needed to install or connect" and a reader took it as "no XRD is
 * needed" — but /mint hard-blocks a zero balance (the badge's network fee) and a claim locks
 * a bond. Installing the wallet, connecting it and browsing the board really do need no XRD;
 * minting and claiming do. The line below says both, and /guide and /mint render this same
 * string, so the two pages cannot drift from each other or from the constants.
 *
 * Nothing here is a second source of truth for a number the site already has:
 *   • the bond floor is ESCROW_CLAIM_BOND_XRD (config.ts — the display mirror of the escrow's
 *     `claim_bond_floor`, 76.45 today), and the bond is 10% of the reward above it;
 *   • the fee cushion is FEE_HEADROOM_XRD (marketplace.ts — the same hint the mint and claim
 *     balance pre-flights use).
 * The one number with no home elsewhere is the suggested float, a ruling (2026-10-03): about
 * 100 XRD, and always the person's OWN deposit — never Guild or operator funds. It is clamped
 * so it can never read lower than what a claim at the floor needs if the floor is ever raised.
 *
 * These are today's owner settings, not contract guarantees (the escrow owner can change the
 * bond floor — see /trust "The escrow owner can change its settings"), hence "today".
 */
import { ESCROW_CLAIM_BOND_XRD } from "@/lib/config"
import { FEE_HEADROOM_XRD } from "@/lib/marketplace"

/** Round up to the next multiple of this, so the line says "about 80", not "77.45". */
const ROUND_UP_TO_XRD = 10

/** Suggested float, XRD — the 2026-10-03 ruling. The person's own deposit, never Guild funds. */
const SUGGESTED_HOLD_XRD = 100

/** The bond is 10% of the reward, so the floor binds up to a reward ten times the floor. */
const REWARD_PER_BOND = 10

/** About how much XRD covers a claim at the bond floor: the floor plus a fee cushion, rounded up. */
export const XRD_TO_CLAIM =
  Math.ceil((ESCROW_CLAIM_BOND_XRD + FEE_HEADROOM_XRD) / ROUND_UP_TO_XRD) * ROUND_UP_TO_XRD

/** The largest reward (XRD, rounded) whose bond is still the floor — "about 765 XRD" today. */
export const XRD_FLOOR_BINDS_UP_TO_REWARD = Math.round(ESCROW_CLAIM_BOND_XRD * REWARD_PER_BOND)

/** The float we suggest holding. Never below what a claim needs. */
export const XRD_SUGGESTED_HOLD = Math.max(SUGGESTED_HOLD_XRD, XRD_TO_CLAIM)

/** The three costs, in the order a newcomer meets them. Rendered as one line on /guide and /mint. */
export const XRD_NEEDED_LINE =
  `What you need: no XRD to install the wallet, connect it or browse the board. A little XRD for the network fee to mint a badge. ` +
  `To claim a task, about ${XRD_TO_CLAIM} XRD — the claim bond (10% of the reward, at least ${ESCROW_CLAIM_BOND_XRD} XRD today, held until the task settles) ` +
  `plus network fees — covers any task paying up to about ${XRD_FLOOR_BINDS_UP_TO_REWARD} XRD. ` +
  `We suggest holding about ${XRD_SUGGESTED_HOLD} XRD of your own.`
