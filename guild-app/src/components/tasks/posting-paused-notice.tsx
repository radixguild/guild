"use client"

import { PauseCircle } from "lucide-react"

// The W3 freeze copy, in ONE place. This renders only after a client fetch
// resolves, so neither launch-check CHECK 4 nor the cold-user SSR sweep can
// see it — the honest-copy gate over these strings is the unit test
// (tests/unit/escrow-posting-freeze.test.tsx), same pattern as
// interaction-copy.test.ts. Add any new freeze-era sentence HERE, never inline
// in a page, or it ships unscanned.

export const POSTING_PAUSED_NOTICE =
  "New-task posting is paused ahead of a planned escrow upgrade — existing tasks are unaffected."

/** Fund-surface addition: why the button is disabled instead of clickable. */
export const POSTING_PAUSED_FUND_DETAIL =
  "The fund step is disabled while the pause is on — its wallet transaction could only fail. Every leg of already-funded tasks (claim, submit, approve, dispute, withdraw) still works."

/** Create-page addition: what drafting now does and does not get you. */
export const POSTING_PAUSED_CREATE_DETAIL =
  "You can still draft and post a task, but the escrow-funding step that makes it claimable is paused, and unfunded tasks drop off the public board after 24 hours."

export function PostingPausedNotice({ detail }: { detail?: string }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
    >
      <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>
        {POSTING_PAUSED_NOTICE}
        {detail ? ` ${detail}` : ""}
      </span>
    </div>
  )
}
