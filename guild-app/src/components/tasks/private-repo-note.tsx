// Open board tasks an outsider could CLAIM but not deliver from the public
// repository alone (2026-09-24; reworded at the open-source flip, 2026-10-02).
//
// THE LIST IS EMPTY, SO THE NOTE RENDERS FOR NOBODY. It held tasks 70, 92 and 93,
// whose committed briefs pointed at the Guild's earlier repository
// (bigdevxrd/guild-saas) and named files the public tree leaves out. All three
// were cancelled and refunded on-chain on 2026-10-03, so /trust's Known Issues
// and /agents no longer mention them either.
//
// The component and needsPrivateRepoAccess stay, so the two call sites (the
// "Claimable now" strip on /tasks, and the task page above the Claim area) need
// no change. Should a funded task ever need this warning again: claim_task is
// PUBLIC and checks only the badge, and a funded brief is hash-locked on-chain
// (work_brief_hash, committed at funding), so this list is where the warning
// goes. Add the id, reword PRIVATE_REPO_TASK_NOTE for that task, and say the
// same in /trust's Known Issues in the same change.
//
// These are BOARD ids (the /tasks/<id> number), not on-chain task ids.

/** Board task ids whose committed brief cannot be delivered from the public
 *  repository. Empty since 2026-10-03 (70, 92 and 93 were cancelled). */
export const PRIVATE_REPO_TASK_IDS: readonly number[] = []

export const PRIVATE_REPO_TASK_NOTE =
  "This task was briefed against the Guild's earlier repository (bigdevxrd/guild-saas), and its brief names files that are not in the public repository. Ask @bigdev_xrd how to deliver it before you claim."

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
