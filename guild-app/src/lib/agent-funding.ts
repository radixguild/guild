/**
 * Has this agent been funded? (docs/design/bring-your-agent.md §3.2, §3.3.)
 *
 * The owner's one transaction (pairAgentManifest) withdraws the float, mints
 * the agent's Member badge by name and deposits both into the agent's account.
 * "Funded" therefore means BOTH arrived at `agent_id`: the XRD (at least the
 * float) and the badge `<guild_member_{labelNorm}>`. `public_mint` being
 * permissionless proves nothing about WHO minted, so neither check asks.
 *
 * Two ways to establish it:
 *  - by transaction (`verifyFundingTx`) — the committed tx's balance changes.
 *    This is what the owner's page sends right after the wallet returns, and it
 *    records `pair_tx`.
 *  - by state (`readFundingState`) — where the badge is now, and the agent's
 *    XRD balance. For when the intent hash is lost (the tab closed after the
 *    wallet signed), and for the 24 h expiry, which must never delete the row
 *    of an agent whose float already landed.
 *
 * Every reader returns null when the Gateway could not be asked; callers treat
 * null as "unknown" — never as "not funded" (that would delete a funded row)
 * and never as "funded" (that would activate on a guess).
 */
import { agentBadgeLocalId } from "./agent-label"
import { BADGE_NFT } from "./config"
import { fetchTxBalanceChanges, readFungibleVaultTotal, readNonFungibleHolder, readTxIntentStatus } from "./gateway"
import { XRD_ADDRESS } from "./radix"
import { addXrd, gteXrd } from "./xrd-decimal"

export type FundingGap =
  /** The tx has not committed yet (or the Gateway has not seen it). Retry. */
  | "tx_pending"
  /** The tx committed as a failure or was rejected. */
  | "tx_failed"
  /** Less than the float reached the agent's account. */
  | "float_short"
  /** The badge did not reach the agent's account in this tx. */
  | "badge_missing"
  /** The name is minted, but to a different account. */
  | "badge_elsewhere"
  /** The badge has never been minted. */
  | "not_minted"

export type FundingEvidence =
  | { funded: true; via: "tx"; intentHash: string; badgeId: string }
  | { funded: true; via: "state"; badgeId: string }
  | { funded: false; gap: FundingGap }

interface FundingArgs {
  agentAccount: string
  labelNorm: string
  floatXrd: string
}

// Not yet a verdict. LikelyButNotCertainRejection is the Gateway saying a node
// rejected it but it may still commit, so telling the owner "failed, fund
// again" would be wrong. Only CommittedFailure and PermanentlyRejected are final.
const PENDING_STATUSES = new Set(["Pending", "CommitPendingOutcomeUnknown", "Unknown", "LikelyButNotCertainRejection"])

export async function verifyFundingTx(args: FundingArgs & { intentHash: string }): Promise<FundingEvidence | null> {
  const status = await readTxIntentStatus(args.intentHash)
  if (status === null) return null
  if (PENDING_STATUSES.has(status)) return { funded: false, gap: "tx_pending" }
  if (status !== "CommittedSuccess") return { funded: false, gap: "tx_failed" }

  const tx = await fetchTxBalanceChanges(args.intentHash)
  if (!tx) return null
  // A committed success read back as anything else is a Gateway disagreement,
  // not a verdict on the owner's transaction.
  if (tx.status !== "CommittedSuccess") return null

  const badgeId = agentBadgeLocalId(args.labelNorm)
  let received = "0"
  for (const c of tx.fungible) {
    if (c.entity === args.agentAccount && c.resource === XRD_ADDRESS) {
      try {
        received = addXrd(received, c.change)
      } catch {
        return null // an amount the Gateway sent that is not a decimal: unknown, not zero
      }
    }
  }
  if (!gteXrd(received, args.floatXrd)) return { funded: false, gap: "float_short" }

  const badgeLanded = tx.nonFungible.some(
    (c) => c.entity === args.agentAccount && c.resource === BADGE_NFT && c.added.includes(badgeId),
  )
  if (!badgeLanded) return { funded: false, gap: "badge_missing" }
  return { funded: true, via: "tx", intentHash: args.intentHash, badgeId }
}

/**
 * Where a Member badge NAME stands on-chain, relative to one agent account —
 * the ONE place a Gateway answer about a name is turned into a verdict, so
 * every caller (funding, the manifest route, a rename) reads it the same way:
 *
 *   free        never minted
 *   this_agent  minted and held by this agent's account
 *   elsewhere   minted and held by some OTHER account (or burned — which the
 *               badge manager never does: its burner is its own internal badge)
 *   unknown     the Gateway could not be asked, OR it reported the id as minted
 *               without saying who holds it. Unknown is never "elsewhere":
 *               "elsewhere" lets a row be renamed away from, or released from,
 *               a badge that may be this agent's own.
 */
export type NameOnChain = "free" | "this_agent" | "elsewhere" | "unknown"

export async function readNameOnChain(labelNorm: string, agentAccount: string): Promise<NameOnChain> {
  const where = await readNonFungibleHolder(BADGE_NFT, agentBadgeLocalId(labelNorm))
  if (where === null) return "unknown"
  if (!where.minted) return "free"
  if (where.burned) return "elsewhere"
  if (where.holder === null) return "unknown"
  return where.holder === agentAccount ? "this_agent" : "elsewhere"
}

export async function readFundingState(args: FundingArgs): Promise<FundingEvidence | null> {
  const badgeId = agentBadgeLocalId(args.labelNorm)
  const name = await readNameOnChain(args.labelNorm, args.agentAccount)
  if (name === "unknown") return null
  if (name === "free") return { funded: false, gap: "not_minted" }
  if (name === "elsewhere") return { funded: false, gap: "badge_elsewhere" }

  const xrd = await readFungibleVaultTotal(args.agentAccount, XRD_ADDRESS)
  if (xrd === null) return null
  if (gteXrd(xrd.total, args.floatXrd)) return { funded: true, via: "state", badgeId }
  // An incomplete vault list is a lower bound: below the float on page one is not a confirmed "short".
  if (!xrd.complete) return null
  return { funded: false, gap: "float_short" }
}
