import { canonicalTermsBlock, hasTerms, type TaskTerms } from "./task-terms"

// ── Commitment canonicalization (v1 — FROZEN) ─────────────────────────────────
//
// The escrow blueprint stores 32-byte commitments, not content: create_task
// commits to the work brief (title + description) and submit_task to the
// worker's submission evidence. A commitment is only meaningful if it can be
// re-derived byte-for-byte years later — e.g. in a dispute, to prove the DB
// brief/submission is exactly what the chain bound — so the v1 canonical
// formats below are FROZEN: never change a v1 prefix or layout. If the format
// must ever evolve, introduce a new versioned prefix (guild-task-brief-v2, …)
// and keep v1 derivable; the prefix tells a verifier which layout produced a
// given hash and keeps the two commitment domains collision-free. Note that v1
// frames fields with newlines (not length prefixes): the brief hash commits to
// the combined text, so the exact title/description split is not independently
// provable from the hash alone.
//
// Lives here, not in escrow-utils.ts, so the SERVER can derive the same hash:
// escrow-utils is a "use client" module that pulls in the Radix dApp Toolkit,
// and the create confirm (escrow-confirm.ts) must compare a TaskCreatedEvent's
// work_brief_hash against the row it is about to mark funded. escrow-utils
// re-exports these, so every existing import keeps working and there is still
// exactly one definition.

/** Canonical v1 work-brief string committed on-chain by create_task (FROZEN). */
export function canonicalWorkBrief(title: string, description: string): string {
  return `guild-task-brief-v1\n${title}\n\n${description}`
}

/**
 * Canonical v2 work-brief (FROZEN): v1's layout plus the structured-terms
 * block (task-terms.ts canonicalTermsBlock — itself fixed-order). Only used
 * when at least one term is set, so v1 tasks stay byte-identical forever.
 * A verifier picks the layout by the prefix; the DB picks it by terms
 * presence (tasks.terms IS NULL → v1).
 */
export function canonicalWorkBriefV2(
  title: string,
  description: string,
  termsBlock: string,
): string {
  return `guild-task-brief-v2\n${title}\n\n${description}\n\n-- terms --\n${termsBlock}`
}

/** 32-byte SHA-256 (lowercase hex) of the UTF-8 input — the on-chain commitment hash. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

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

/**
 * The work_brief_hash create_task commits for (title, description, termsBlock):
 * v2 whenever the terms block is non-empty, v1 otherwise. sendDepositTx and
 * sendSubmitTx hash through this, and the create confirm recomputes it from the
 * row — one derivation, so the three can never disagree.
 */
export async function workBriefHashHex(
  title: string,
  description: string,
  termsBlock?: string,
): Promise<string> {
  return sha256Hex(
    termsBlock
      ? canonicalWorkBriefV2(title, description, termsBlock)
      : canonicalWorkBrief(title, description),
  )
}
