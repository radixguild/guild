// task-stage.ts — where a task is in its lifecycle, and what YOU do next.
//
// WHY THIS EXISTS
// ---------------
// Field evidence from the first real two-party settlement on the live PULL
// component (task 1, 2026-08-20): the poster completed the walk but did not
// notice the Collect affordance, because every action on the task page lives in
// the sidebar with nothing saying which one is yours or that a step remains.
// The button was rendered and correct — it simply was not where attention was.
//
// Under PUSH that was survivable: approving paid the worker, so a missed
// affordance cost nobody anything. Under PULL an entitlement is a bearer claim
// that sits uncollected until someone acts. `push_entitlement` (live since the
// Wave B cutover, 2026-09-13) lets ANYONE deliver it to the pinned account —
// but only once someone notices it is owed. So "the payee didn't notice" is
// still a way for money to sit indefinitely. That is what this fixes.
//
// THE CHAIN DECIDES, NOT THE DB
// -----------------------------
// Stage comes from the on-chain TaskState and the entitlement lanes, with the
// DB status used only as a fallback label before the escrow read resolves.
// The DB is a mirror and can lag or drift; the money follows the chain.
//
// UNKNOWN IS NOT A STAGE
// ----------------------
// While the chain read is in flight, `resolveTaskStage` returns `null`. Callers
// render nothing (or a placeholder) rather than guessing — the same discipline
// `resolveWithdrawAffordance` applies, and the reason it distinguishes
// `unknown` from `nothing-owed`.

import { isPositiveDecimal } from "@/lib/escrow-drift"
import { outstandingForParty, type OnChainTaskInfo } from "@/lib/gateway"

/** The PULL lifecycle, in order. `Collected` is the step PUSH never had. */
export const TASK_STAGES = [
  "Funded",
  "Claimed",
  "Submitted",
  "Approved",
  "Collected",
] as const

export type TaskStage = (typeof TASK_STAGES)[number]

/** Which side of the task the viewer is on, decided by the CHAIN pins. */
export type Viewer = "worker" | "poster" | "observer"

export interface NextAction {
  /** Imperative, second person: what this viewer does now. */
  label: string
  /** Why it matters, one short clause. Omitted when the label says enough. */
  detail?: string
  /** True when money is sitting unclaimed for this viewer. */
  isMoney: boolean
}

export interface TaskStageView {
  stages: readonly TaskStage[]
  /** Index into TASK_STAGES the task has REACHED. */
  reached: number
  /** Terminal states that leave the happy path. */
  offPath: "Disputed" | "Refunded" | null
  viewer: Viewer
  /** Null when this viewer has nothing to do right now. */
  nextAction: NextAction | null
}

/**
 * Who the viewer is, from the on-chain payee pins rather than the DB's
 * creatorId/assigneeId. The pins are where the money actually goes, so they are
 * the only definition of "your task" that agrees with the settlement.
 */
export function viewerFor(info: OnChainTaskInfo, account: string | null): Viewer {
  if (!account) return "observer"
  if (account === info.workerAccount) return "worker"
  if (account === info.posterAccount) return "poster"
  return "observer"
}

/** How far along the happy path the chain says this task is. */
function reachedFor(info: OnChainTaskInfo, anyOwed: boolean, everOwed: boolean): number {
  switch (info.state) {
    case "Open":
      return 0
    case "Claimed":
      return 1
    case "Submitted":
      return 2
    case "Disputed":
      return 2
    case "Released":
    case "Refunded":
      // Approved is reached; Collected only once nothing is owed to anyone.
      // `everOwed` guards the pre-pull case, where the lanes do not exist and
      // "nothing owed" would otherwise read as "fully collected".
      return everOwed && !anyOwed ? 4 : 3
  }
}

/**
 * The stage view for one viewer, or null while the chain read is unresolved.
 *
 * Takes no DB status on purpose. Stage is a chain fact, and accepting a second
 * source would invite a fallback that disagrees with where the money is.
 */
export function resolveTaskStage(
  info: OnChainTaskInfo | null,
  account: string | null,
): TaskStageView | null {
  if (!info) return null

  const viewer = viewerFor(info, account)
  const mine = viewer === "observer" ? null : outstandingForParty(info, viewer)
  const owedToMe = mine
    ? isPositiveDecimal(mine.reward) || isPositiveDecimal(mine.bondXrd)
    : false

  // "Is anyone still owed" decides whether Collected has been reached. Checked
  // across BOTH parties: a task where only the worker collected is not done.
  const w = outstandingForParty(info, "worker")
  const p = outstandingForParty(info, "poster")
  const anyOwed = [w, p].some(
    (o) => o !== null && (isPositiveDecimal(o.reward) || isPositiveDecimal(o.bondXrd)),
  )

  const reached = reachedFor(info, anyOwed, info.entitlementsPresent)
  const offPath =
    info.state === "Disputed" ? "Disputed" : info.state === "Refunded" ? "Refunded" : null

  return { stages: TASK_STAGES, reached, offPath, viewer, nextAction: nextActionFor(info, viewer, owedToMe, mine) }
}

/**
 * What this viewer does next.
 *
 * Money first, always. If something is owed to you it outranks every other
 * prompt, because it is the only one whose omission costs you.
 */
function nextActionFor(
  info: OnChainTaskInfo,
  viewer: Viewer,
  owedToMe: boolean,
  mine: { reward: string; bondXrd: string } | null,
): NextAction | null {
  if (viewer === "observer") return null

  if (owedToMe && mine) {
    const lanes: string[] = []
    if (isPositiveDecimal(mine.reward)) lanes.push(`${mine.reward} XRD`)
    if (isPositiveDecimal(mine.bondXrd)) lanes.push(`${mine.bondXrd} XRD claim bond`)
    return {
      label: `Collect ${lanes.join(" + ")}`,
      detail: "settled and waiting for you — the escrow holds it until you collect",
      isMoney: true,
    }
  }

  if (info.state === "Claimed" && viewer === "worker") {
    return { label: "Submit your work", detail: "starts the review window — your claim bond stays in escrow until the task settles", isMoney: false }
  }
  if (info.state === "Submitted" && viewer === "poster") {
    return { label: "Review and approve", detail: "credits the worker so they can collect", isMoney: false }
  }
  if (info.state === "Disputed") {
    return { label: "Dispute in progress", isMoney: false }
  }
  return null
}
