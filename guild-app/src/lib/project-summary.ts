/**
 * Pure text helpers for the /tasks projects-first board (P4-21, task 89):
 * a one-line pitch and a definition-of-done line, both derived from a
 * project's free-text `description` rather than a separate structured field
 * (no schema change for this — see docs on `projects.description`).
 *
 * Convention observed on the 7 live projects (verified against
 * https://radixguild.com/api/v1/projects on 2026-09-15): a description reads
 * as "<one-sentence pitch>. — Catalogue: N tasks · X XRD in rewards (...).
 * — Done when[ (a ref)]: <the definition of done>." — segments separated by
 * " — " (an em dash with spaces on both sides). Neither segment is
 * guaranteed: a project created by hand through the New Project dialog has
 * no "Done when" segment at all, and may not end in punctuation. Both
 * helpers degrade to "nothing found" rather than assuming the convention
 * holds, so a hand-written description never renders a truncated or
 * fabricated fragment.
 */

const SEGMENT_SEPARATOR = " — "

/**
 * The first sentence of a description, for the project card's one-line
 * pitch. Deliberately splits on sentence-ending punctuation, NOT on
 * SEGMENT_SEPARATOR — a sentence can itself contain an em dash mid-clause
 * (P7's live description does: "...then — after reading it — as an ATOMIC
 * SWAP...") and splitting on the separator would truncate that sentence
 * mid-clause instead of finding its real end.
 *
 * The lookahead `(?=\s|$)` requires the punctuation to be followed by
 * whitespace or the end of the string, so a period inside a filename or a
 * dotted reference that is NOT followed by a space (e.g. "nft-escrow.md,",
 * "CLAUDE.md's") never ends the match early.
 */
// An operator's filing note at the head of a description — "Shell created
// 2026-09-15 (bigdev):" / "Ruled 2026-09-15 (twice):". These are provenance for
// the operator, written into the row when the project was opened, and until
// 2026-09-20 they were the FIRST words a newcomer read on /tasks: three empty
// projects in a row, each introducing itself as "Shell created…". The row keeps
// the note (it is the project's history, and /projects/[slug] may show it); the
// one-line pitch does not lead with it.
const OPERATOR_NOTE = /^(?:shell created|ruled|opened|filed)\s+\d{4}-\d{2}-\d{2}(?:\s*\([^)]*\))?\s*[:.]\s*/i

/** `description` without a leading operator filing note. */
export function stripOperatorNote(description: string): string {
  return description.trim().replace(OPERATOR_NOTE, "").trim()
}

export function firstSentence(description: string): string {
  const text = stripOperatorNote(description)
  if (!text) return ""
  const match = text.match(/^.*?[.!?](?=\s|$)/)
  const sentence = (match ? match[0] : text).trim()
  // A pitch reads as a sentence; the note's removal can leave a lower-case start.
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

/**
 * The definition-of-done segment, if the description carries one — the
 * " — "-separated segment that starts with "Done when" (case-insensitive),
 * kept verbatim (including a trailing "(docs/...)" reference, when present)
 * so the card shows exactly what the project committed to rather than a
 * paraphrase. Returns null when no segment matches, which the card treats
 * as "nothing to show", never a placeholder claim.
 */
export function doneWhenLine(description: string): string | null {
  const segments = description.split(SEGMENT_SEPARATOR)
  const hit = segments.find((s) => /^done when\b/i.test(s.trim()))
  return hit ? hit.trim() : null
}
