import { canonicalTermsBlock, hasTerms, type TaskTerms } from "./task-terms"

// Server-side companion to work-brief.ts. It lives apart on purpose: work-brief.ts
// must stay dependency-free, because escrow-utils (a "use client" module) re-exports
// it and the agent kit's parity test imports escrow-utils straight from the sibling
// checkout, where guild-app's node_modules are not installed — task-terms.ts pulls
// in zod, so importing it from work-brief.ts broke that test in CI (radixguild/guild#28).

/**
 * The terms block for a STORED task row, exactly as the task page hands it to
 * the fund and submit buttons (tasks/[id]/page.tsx): the canonical block when a
 * term or a deadline is set, otherwise "". `deadline` is the row's own column —
 * a Date from the DB, or the ISO string the API serves.
 */
export function storedTermsBlock(
  terms: TaskTerms | null | undefined,
  deadline: Date | string | null | undefined,
): string {
  if (!hasTerms(terms) && !deadline) return ""
  const dueIso = deadline ? (deadline instanceof Date ? deadline.toISOString() : deadline) : null
  return canonicalTermsBlock(terms, { dueIso })
}
