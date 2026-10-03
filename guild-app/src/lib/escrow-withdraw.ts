/**
 * PULL withdraw affordance — the decision, separated from the button.
 *
 * Under pull, settlement CREDITS an entitlement instead of pushing funds, so a
 * released task leaves money sitting in the component until its payee collects
 * it (docs/design/escrow-pull-redesign.md §5c). This module answers the only
 * question the UI actually has to get right:
 *
 *   given the live on-chain TaskInfo and the connected account, should a
 *   "collect" affordance render — and with exactly which proof?
 *
 * It is pure and synchronous on purpose. Every phase-4 chunk that shipped a
 * guard buried in a React component would have had nowhere to plant a mutation;
 * the repo's convention (escrow-drift, escrow-entitlements) is a pure module
 * plus a thin shell, and this follows it.
 *
 * ── Why the decision is STATUS-INDEPENDENT ──────────────────────────────────
 * There is deliberately no `tasks.status` input. Chunk E learned this the
 * expensive way: entitlements outlive the lifecycle, so gating the affordance
 * on a DB status would hide the money on precisely the rows where it is owed.
 * A worker's reward is owed while the task reads `paid`; a poster's refund
 * while it reads `cancelled`; a poster's forfeited bond while it reads `open`
 * again after an expire. The chain says who is owed what — so ask the chain,
 * and let the DB status say nothing at all.
 *
 * ── Why a wrong answer here cannot MISPAY ───────────────────────────────────
 * `withdraw_worker(task_id, proof)` and `withdraw_poster(task_id, proof)` take
 * no amount, and the blueprint deposits into the payee pin from inside. So this
 * module cannot route money anywhere or change how much moves. Its failure mode
 * is narrower and entirely about the user's fee: offer a collection that must
 * revert, or hide one that would have worked.
 */

import { isPositiveDecimal } from "@/lib/escrow-drift"
import { outstandingForParty, type OnChainTaskInfo, type PartyOutstanding } from "@/lib/gateway"

/**
 * Why no affordance renders. Every one of these is a distinct real state, and
 * they are kept apart rather than collapsed to a boolean because two of them
 * (`no-entitlement-fields` and `nothing-owed`) look identical on the wire and
 * mean opposite things — the D trap.
 */
export type WithdrawSuppression =
  /** Escrow off, or the task was never funded on-chain. */
  | "not-on-chain"
  /** TaskInfo unreadable (Gateway hiccup). Unknown, never a state. */
  | "unknown"
  /**
   * This component carries no entitlement fields — it predates pull and settles
   * by PUSH, so there is nothing to collect and never was. Distinct from
   * `nothing-owed`: the amounts read "0" in both cases, and only field presence
   * tells them apart (gateway.ts entitlementsPresent).
   */
  | "no-entitlement-fields"
  /** The viewer is neither pinned payee on this task. */
  | "not-a-payee"
  /** Readable, viewer is a payee, and their lanes are genuinely empty. */
  | "nothing-owed"

/**
 * The affordance to render.
 *
 * `blocked` is NOT a suppression: the viewer IS owed money and we know it, but
 * this client cannot build a manifest that would succeed. It must say so — a
 * silently missing button on a task that owes you money is the worst of the
 * three outcomes, because nothing tells you to go looking.
 */
export type WithdrawAffordance =
  | { kind: "none"; reason: WithdrawSuppression }
  | { kind: "blocked"; party: WithdrawParty; outstanding: PartyOutstanding; reason: WithdrawBlocker }
  /**
   * Collect, poster side. Carries only the receipt RESOURCE: the receipt's
   * local id is the task id, derived inside withdrawPosterManifest and never
   * passed, so there is no id to carry and none to get wrong.
   */
  | { kind: "collect"; party: "poster"; outstanding: PartyOutstanding; receiptResource: string }
  /**
   * Collect, worker side. Both fields are chain-sourced — the resource off
   * `claimer_is_agent`, the local id off `claimer_badge_id` — because the
   * blueprint asserts against exactly those two.
   *
   * Split from the poster variant so the poster case has no badge fields to
   * leave blank: a sentinel empty-string local id would be a value the type
   * permits and the manifest builder rejects, which is the shape chunk F
   * deliberately made unrepresentable rather than merely validated.
   */
  | {
      kind: "collect"
      party: "worker"
      outstanding: PartyOutstanding
      badgeResource: string
      badgeLocalId: string
    }

export type WithdrawParty = "worker" | "poster"

export type WithdrawBlocker =
  /**
   * The task was claimed with an AGENT badge, but this deployment has no agent
   * badge resource configured (NEXT_PUBLIC_AGENT_BADGE_NFT is empty — the
   * resource is dormant by decision, config.ts:29). `withdraw_worker` asserts
   * the presented resource matches the claimer's, so a manifest built with the
   * member badge is a guaranteed revert.
   */
  | "agent-badge-not-configured"
  /**
   * Claimed on-chain, but `claimer_badge_id` is absent — the local id the
   * blueprint matches against. Nothing correct can be built without it.
   */
  | "claimer-badge-unknown"

/** Resource addresses this client can present. */
export interface WithdrawResources {
  /** Guild member badge (NEXT_PUBLIC_BADGE_NFT). */
  memberBadge: string
  /** Dedicated agent badge — "" when dormant/unset. */
  agentBadge: string
  /** Escrow task receipt resource. */
  taskReceipt: string
}

/**
 * Decide the withdraw affordance for one viewer on one task.
 *
 * @param info    Live on-chain TaskInfo, or null when unreadable/unfunded.
 * @param account The connected account, or null when disconnected.
 */
export function resolveWithdrawAffordance(
  info: OnChainTaskInfo | null,
  account: string | null,
  resources: WithdrawResources,
): WithdrawAffordance {
  if (!account) return { kind: "none", reason: "not-on-chain" }
  if (!info) return { kind: "none", reason: "unknown" }

  // The D trap, and the whole reason this is the first branch. Against a
  // PRE-PULL component every entitlement reads "0", which is
  // indistinguishable from a fully-collected task — so field PRESENCE, not
  // value, decides whether this component does pull at all. Getting this
  // backwards would offer a collect button on a component with no
  // withdraw_worker method: a guaranteed revert on every settled task, for
  // every user, from the moment it shipped.
  if (!info.entitlementsPresent) return { kind: "none", reason: "no-entitlement-fields" }

  // Payee identity comes from the CHAIN PINS, never from the DB's creatorId /
  // assigneeId. The pins are what the blueprint deposits into, so they are the
  // only definition of "your money" that agrees with where the money will go.
  const party: WithdrawParty | null =
    account === info.workerAccount
      ? "worker"
      : account === info.posterAccount
        ? "poster"
        : null
  if (party === null) return { kind: "none", reason: "not-a-payee" }

  // Both lanes at once: withdraw_* collects reward AND bond in one call
  // (deposit_both_lanes), so one button collects everything owed to this party.
  const outstanding = outstandingForParty(info, party)
  // Unreachable while entitlementsPresent is true — outstandingForParty returns
  // null on exactly that condition — but treated as "cannot say" rather than
  // assumed, so a future change to either function degrades to hiding the
  // button rather than to offering a reverting one.
  if (outstanding === null) return { kind: "none", reason: "no-entitlement-fields" }
  // Either lane on its own is money owed. They are DIFFERENT RESOURCES and are
  // never added: a cancel-after-claim owes the worker a bond and no reward, and
  // that must still offer a Collect button. `withdraw_*` takes both lanes in one
  // call (deposit_both_lanes), so one button still collects everything.
  const owed =
    isPositiveDecimal(outstanding.reward) || isPositiveDecimal(outstanding.bondXrd)
  if (!owed) return { kind: "none", reason: "nothing-owed" }

  if (party === "poster") {
    return {
      kind: "collect",
      party,
      outstanding,
      receiptResource: resources.taskReceipt,
    }
  }

  if (!info.claimerBadgeId) {
    return { kind: "blocked", party, outstanding, reason: "claimer-badge-unknown" }
  }
  // Which badge resource the worker must present is decided ON CHAIN by
  // claimer_is_agent, not by what this app happens to have configured.
  const badgeResource = info.claimerIsAgent ? resources.agentBadge : resources.memberBadge
  if (!badgeResource) {
    return { kind: "blocked", party, outstanding, reason: "agent-badge-not-configured" }
  }
  return {
    kind: "collect",
    party,
    outstanding,
    badgeResource,
    badgeLocalId: info.claimerBadgeId,
  }
}

/**
 * Which lanes actually owe this party something, in render order.
 *
 * The caller renders one amount per lane and NEVER a total. These are different
 * resources — the reward lane is the task's reward token, the bond lane is
 * always XRD — so a single figure would be either wrong or a coincidence of the
 * app currently pinning the reward token to XRD. Returning the lanes keeps that
 * decision here and the wording in the component, which is chunk G's split.
 *
 * Empty array = nothing owed, which `resolveWithdrawAffordance` has already
 * turned into `{ kind: "none" }` — so a `collect` or `blocked` affordance always
 * yields at least one lane.
 */
export function outstandingLanes(o: PartyOutstanding): ("reward" | "bond")[] {
  const lanes: ("reward" | "bond")[] = []
  if (isPositiveDecimal(o.reward)) lanes.push("reward")
  if (isPositiveDecimal(o.bondXrd)) lanes.push("bond")
  return lanes
}

/**
 * One-line explanation for a `blocked` affordance — shown instead of a button,
 * because the viewer is owed money and silence would strand it.
 */
export function explainWithdrawBlocker(reason: WithdrawBlocker): string {
  switch (reason) {
    // ⚠️ Deliberately does NOT point at the guild-worker CLI. Chunk F added
    // withdrawWorkerManifest to packages/agent-client, but NOTHING calls it —
    // there is no withdraw command, so "collect it with the CLI" would be a
    // false claim of the exact kind honest-copy.mjs exists to catch. If a CLI
    // withdraw ships, change this line in the same commit.
    case "agent-badge-not-configured":
      return "This task was claimed with an agent badge, which this site cannot present. Nothing is lost — the escrow still holds it for you — but collecting it needs an operator. Please get in touch."
    case "claimer-badge-unknown":
      return "The escrow does not record which badge claimed this task, so the collection proof cannot be built here. Nothing is lost — please contact an operator."
  }
}
