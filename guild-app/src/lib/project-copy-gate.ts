/**
 * Write-time honest-copy gate for project text (DESIGN-REVIEW-2027.md §22,
 * option A — ruled in 2026-09-18).
 *
 * WHY THIS EXISTS. scripts/honest-copy.mjs is the project's CI copy gate, and it
 * scans SOURCE FILES. Project names and descriptions live in POSTGRES, so it
 * cannot see them — nor can launch-check.sh (it reads the built artifact) or
 * the e2e cold-user spec (it runs against an empty CI database). That blind
 * spot is how /projects came to advertise 195,200 XRD of "rewards" beside
 * 22,900 XRD actually paid+locked, on the same screen as the real figures,
 * and it stayed live until the 2026-09-18 content sweep found it.
 *
 * So the rules are applied where this copy is WRITTEN instead: POST
 * /api/v1/projects and PATCH /api/v1/projects/[slug] refuse a banned claim with
 * a 400 before it becomes public. That is prevention, which is the only shape
 * that shortens how long false copy is live — a read-time watcher (§22 option B)
 * would only detect it, after the fact.
 *
 * THE SHAPE, as §22.4 specified it:
 *  - scan ONLY the fields present in the request, so a name-only PATCH is never
 *    refused over a description already stored;
 *  - `BANNED` only, not `PULL_BANNED` — launch-check arms PULL_BANNED per build
 *    and a server route has no equivalent switch;
 *  - report the field and the matched fragment, in the SCRUB_UNSTABLE_TEXT shape
 *    POST /api/v1/tasks already uses, so the author sees exactly what to change.
 *
 * ⚠️ THIS BINDS STRANGERS' PROJECTS TOO. withAuth checks only for a session, not a
 * badge, and several BANNED labels are written about the Guild itself. That is
 * intended — a stranger's "trustless" is exactly as false as ours — but it means
 * a refusal message must explain the rule, not just name it.
 *
 * TASKS AND WORKING GROUPS use the same rules since 2026-09-19 — see the second half
 * of this file for the one deliberate difference (a quoted mention in a task spec).
 *
 * WHAT IT DOES NOT COVER: rows written by SQL on the box, and rows already live
 * before this shipped. Those are closed by process: corrections go through
 * `guild-poster project update`, and the §22.4 interim check reads every live row.
 */

import { BANNED, violation } from "../../scripts/honest-copy.mjs"

export type ProjectCopyFields = { name?: unknown; description?: unknown }

export type BannedClaim = {
  /** Which request field carried it. */
  field: "name" | "description"
  /** The exact substring that matched, so the author can find it. */
  fragment: string
  /** The rule's own label — why the claim is refused. */
  label: string
}

const FIELDS = ["name", "description"] as const

/**
 * The first banned claim in the fields PRESENT in `body`, or null.
 *
 * A field that is absent, null, or not a string is skipped rather than
 * refused: schema validation owns shape, this owns honesty, and a missing field
 * is not a claim. That is also what keeps a name-only PATCH from being refused
 * over a stored description it never touched.
 */
export function bannedClaimIn(body: ProjectCopyFields): BannedClaim | null {
  for (const field of FIELDS) {
    const text = body[field]
    if (typeof text !== "string" || text.length === 0) continue
    for (const rule of BANNED as Array<{ label: string; re: RegExp; allow?: RegExp[] }>) {
      const fragment = violation(text, rule)
      if (fragment) return { field, fragment, label: rule.label }
    }
  }
  return null
}

/** The 400 body both routes return — one shape, so a client handles it once. */
export function bannedClaimError(hit: BannedClaim) {
  return {
    ok: false as const,
    error: {
      code: "BANNED_CLAIM" as const,
      field: hit.field,
      fragment: hit.fragment,
      message:
        `The project ${hit.field} makes a claim this site does not make about itself ` +
        `(near: "${hit.fragment}"). Rule: ${hit.label}. Rewrite it without that claim — ` +
        `project copy is public, and the same rules apply to it as to every page here.`,
    },
  }
}

// ── Tasks and working groups (2026-09-19) ────────────────────────────────────
//
// §22 gated project copy only, and PROJECT-STATE recorded the rest as owed: "Task
// and group descriptions are the same class, same fix." They are the same class —
// Postgres rows no source-file gate can see, rendered publicly on /tasks and the
// working-group pages, writable by any signed-in stranger.
//
// They are NOT quite the same fix, and the difference was measured rather than
// assumed. A project description is pitch copy. A task description is a WORK
// SPEC, and this project's own specs are often ABOUT a false claim: "remove the
// word "trustless" from /docs" has to name the word it removes. A spec that
// cannot quote the defect cannot commission its repair. So for TASK text only, a
// match that sits wholly inside double quotes, curly double quotes or backticks
// is a MENTION, not a claim, and is exempt. Single quotes are not honoured — an
// apostrophe would open a "quote" that swallows half the description.
//
// Measured 2026-09-19 over docs/guild-task-board.json (114 rows, every string
// field): ONE row trips the rules — P4-07's scope describes a card showing a
// "required tier", unquoted (tier-gating). That row needs quotes or a rephrase
// before it is posted; the refusal message says how. Working-group text gets NO
// exemption: a group name and blurb are pitch copy, like a project's.
//
// ⚠️ The exemption is a hole by construction: `We are "trustless"` passes. It is
// accepted for task specs because the alternative is a board that cannot
// commission its own copy fixes; it is the reason groups and projects do not get it.

export type TaskCopyFields = { title?: unknown; description?: unknown; requirements?: unknown }
export type GroupCopyFields = { name?: unknown; description?: unknown }

export type CopyClaim = {
  kind: "task" | "working group"
  field: string
  fragment: string
  label: string
}

const TASK_FIELDS = ["title", "description", "requirements"] as const
const GROUP_FIELDS = ["name", "description"] as const

/** Straight double quotes, curly double quotes, backticks. One line, bounded. */
const QUOTED_MENTION = /"[^"\n]{1,300}"|\u201C[^\u201D\n]{1,300}\u201D|`[^`\n]{1,300}`/g

/**
 * `text` with every quoted mention blanked to a character no rule can match,
 * length preserved so a fragment's offset still indexes the original.
 */
export function maskQuotedMentions(text: string): string {
  return text.replace(QUOTED_MENTION, (m) => m[0] + "\u00A7".repeat(m.length - 2) + m[m.length - 1])
}

function firstClaim(
  kind: CopyClaim["kind"],
  body: Record<string, unknown>,
  fields: readonly string[],
  exemptQuoted: boolean,
): CopyClaim | null {
  for (const field of fields) {
    const text = body[field]
    if (typeof text !== "string" || text.length === 0) continue
    const scanned = exemptQuoted ? maskQuotedMentions(text) : text
    for (const rule of BANNED as Array<{ label: string; re: RegExp; allow?: RegExp[] }>) {
      const hit = violation(scanned, rule)
      if (!hit) continue
      // Report the ORIGINAL characters: a rule with a bounded gap can match
      // ACROSS a masked mention, and the author must see their own words.
      const at = scanned.indexOf(hit)
      return { kind, field, fragment: text.slice(at, at + hit.length), label: rule.label }
    }
  }
  return null
}

/** Task title / description / requirements — fields PRESENT only; quoted mentions exempt. */
export function bannedTaskClaimIn(body: TaskCopyFields): CopyClaim | null {
  return firstClaim("task", body, TASK_FIELDS, true)
}

/** Working-group name / description — fields PRESENT only; no exemption. */
export function bannedGroupClaimIn(body: GroupCopyFields): CopyClaim | null {
  return firstClaim("working group", body, GROUP_FIELDS, false)
}

/** Same 400 shape and code as `bannedClaimError`, worded for the kind of copy refused. */
export function copyClaimError(hit: CopyClaim) {
  const escape =
    hit.kind === "task"
      ? ` If the task is ABOUT that wording — fixing or removing it — put the wording in double quotes or backticks; a quoted mention is not a claim.`
      : ""
  return {
    ok: false as const,
    error: {
      code: "BANNED_CLAIM" as const,
      field: hit.field,
      fragment: hit.fragment,
      message:
        `The ${hit.kind} ${hit.field} makes a claim this site does not make about itself ` +
        `(near: "${hit.fragment}"). Rule: ${hit.label}. Rewrite it without that claim — ` +
        `${hit.kind} copy is public, and the same rules apply to it as to every page here.` +
        escape,
    },
  }
}
