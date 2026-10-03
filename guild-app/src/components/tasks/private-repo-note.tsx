// Open board tasks that an outsider can CLAIM but cannot FINISH (2026-09-24).
//
// WHY THIS EXISTS. Each task below is delivered as a pull request to the
// Guild's code repository, and that repository is private: #70's brief says
// "Prerequisites: repo access", #92 and #93 name files inside the repo. The
// escrow cannot know that — claim_task is PUBLIC and checks only the badge —
// so a stranger can claim one, lock the bond (640 XRD on #70), and then have
// no way to deliver. A claim not submitted by its deadline can be ended by
// anyone an hour later, and the bond is forfeited. /trust's Known Issues says
// this in prose; this list puts the same warning where the claim happens:
// the "Claimable now" strip on /tasks and the task page, above the Claim area.
//
// Funded briefs are hash-locked on-chain (work_brief_hash, committed at
// funding), so the warning cannot go into the task descriptions themselves.
//
// WHEN TO REMOVE AN ID: when that task leaves the board (paid, cancelled or
// refunded), or when the repository it needs is public. Remove the matching
// words from /trust's Known Issues ("Three open tasks can't be finished from
// outside yet") in the same change — tests/unit/private-repo-note.test.tsx
// fails while the two disagree.
//
// These are BOARD ids (the /tasks/<id> number), not on-chain task ids.

/** Board task ids whose delivery needs access to the Guild's private repository. */
export const PRIVATE_REPO_TASK_IDS: readonly number[] = [70, 92, 93]

export const PRIVATE_REPO_TASK_NOTE =
  "Finishing this task needs access to the Guild's private code repository — ask @bigdev_xrd before claiming."

export function needsPrivateRepoAccess(taskId: number): boolean {
  return PRIVATE_REPO_TASK_IDS.includes(taskId)
}

/** The warning, for a task that needs it; nothing for any other task. Plain
 *  text on purpose: the strip renders it inside a row that is already a link. */
export function PrivateRepoTaskNote({ taskId, className = "" }: { taskId: number; className?: string }) {
  if (!needsPrivateRepoAccess(taskId)) return null
  return (
    <span
      role="note"
      data-testid="private-repo-note"
      className={`block text-[11px] text-amber-700 dark:text-amber-400 ${className}`}
    >
      {PRIVATE_REPO_TASK_NOTE}
    </span>
  )
}
