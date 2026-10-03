import { z } from "zod"
import { formatXrdUsd } from "./format-xrd-usd"

/**
 * Structured task terms — the "committed" layer of the two-layer contract
 * model (docs/TASK-TERMS-DESIGN.md). These are NOT machine-enforced by the
 * escrow blueprint; they are canonicalized into the v2 work-brief that
 * create_task sha256-commits on-chain, which makes them immutable and
 * provable in any dispute. The enforced layer (token, amounts, deadlines,
 * bond, resolution rule) lives in the blueprint + existing task columns.
 *
 * They are also the agent API: agents parse acceptance criteria, repo links
 * and due dates from `GET /api/v1/tasks/[id]` instead of scraping prose.
 */

export const DELIVERABLE_TYPES = ["code", "design", "content", "research", "ops"] as const
export type DeliverableType = (typeof DELIVERABLE_TYPES)[number]

export const DONE_CHECKS = [
  "tests-pass",
  "ci-green",
  "code-reviewed",
  "deployed",
  "docs-updated",
] as const
export type DoneCheck = (typeof DONE_CHECKS)[number]

export const LICENSES = ["mit", "apache-2.0", "cc0", "assigned-on-payment", "custom"] as const

const httpsUrl = z
  .string()
  .trim()
  .url("Must be a valid URL")
  .max(300)
  .refine((u) => u.startsWith("https://"), "Link must be https://")

/**
 * `.strict()` matters: unknown keys would survive into the DB but not into
 * the fixed-order canonical block below, silently weakening the commitment.
 */
export const TaskTermsSchema = z
  .object({
    /** Drives the wizard's prefilled defaults — see DELIVERABLE_DEFAULTS. */
    deliverableType: z.enum(DELIVERABLE_TYPES).optional(),
    /** Poster promises to review within N days of submission (committed, not enforced). */
    reviewWindowDays: z.number().int().min(1).max(30).optional(),
    /** Re-work rounds included before either side should reach for a dispute. */
    revisionsIncluded: z.number().int().min(0).max(3).optional(),
    repoUrl: httpsUrl.optional(),
    /** Issue / spec / design doc the work answers to. */
    specUrl: httpsUrl.optional(),
    /** 1–7 short, testable statements — the single biggest dispute killer. */
    acceptanceCriteria: z
      .array(z.string().trim().min(3).max(200))
      .min(1)
      .max(7)
      .optional(),
    definitionOfDone: z.array(z.enum(DONE_CHECKS)).min(1).max(DONE_CHECKS.length).optional(),
    license: z.enum(LICENSES).optional(),
    licenseNote: z.string().trim().min(3).max(200).optional(),
    /** Where to talk while the work runs (TG handle, GH issue thread…). */
    commChannel: z.string().trim().min(2).max(120).optional(),
    /** App-gated today; the agent badge enforces it after the re-instantiation. */
    claimEligibility: z.enum(["humans", "agents", "both"]).optional(),
    /**
     * A poster's STATED PREFERENCE for claimer experience. NOT a gate.
     * ⚠️ 2026-08-29: this was app-enforced at the claim button and presented as
     * access control. That enforcement is GONE — `claim_task` is PUBLIC and
     * asserts nothing about trust, so the check only ever stopped people using
     * the UI. The key REMAINS in the schema and in canonicalTermsBlock because
     * that block is hashed and committed on-chain and its format is FROZEN;
     * dropping it would change the hash of every existing task. It is no longer
     * offered in the create form. Do not re-add a client-side gate for it.
     */
    minTrustTier: z.enum(["established", "top_rated"]).optional(),
  })
  .strict()

export type TaskTerms = z.infer<typeof TaskTermsSchema>

/** True when the object carries at least one set term (null/{} → v1 brief). */
export function hasTerms(terms: TaskTerms | null | undefined): terms is TaskTerms {
  return !!terms && Object.values(terms).some((v) => v !== undefined && v !== null)
}

/**
 * Per-deliverable-type prefills — the soul of the removed #143 template
 * gallery. Picking a type fills the terms form; the user edits freely.
 */
export const DELIVERABLE_DEFAULTS: Record<DeliverableType, TaskTerms> = {
  code: {
    deliverableType: "code",
    reviewWindowDays: 3,
    revisionsIncluded: 1,
    acceptanceCriteria: ["PR opened against the linked repo", "All existing tests stay green"],
    definitionOfDone: ["tests-pass", "ci-green", "code-reviewed"],
    license: "assigned-on-payment",
    claimEligibility: "both",
  },
  design: {
    deliverableType: "design",
    reviewWindowDays: 3,
    revisionsIncluded: 2,
    acceptanceCriteria: ["Source files delivered (e.g. Figma link)", "Exports in the agreed formats"],
    license: "assigned-on-payment",
    claimEligibility: "both",
  },
  content: {
    deliverableType: "content",
    reviewWindowDays: 2,
    revisionsIncluded: 2,
    acceptanceCriteria: ["Draft delivered in editable form", "Factual claims sourced"],
    license: "assigned-on-payment",
    claimEligibility: "both",
  },
  research: {
    deliverableType: "research",
    reviewWindowDays: 3,
    revisionsIncluded: 1,
    acceptanceCriteria: ["Findings written up with sources", "Open questions listed"],
    license: "cc0",
    claimEligibility: "both",
  },
  ops: {
    deliverableType: "ops",
    reviewWindowDays: 2,
    revisionsIncluded: 0,
    acceptanceCriteria: ["Change executed and verified", "Runbook/notes updated"],
    definitionOfDone: ["deployed", "docs-updated"],
    claimEligibility: "humans",
  },
}

/** Legacy #143 `?template=` deep-link ids → deliverable type (links keep working). */
export const LEGACY_TEMPLATE_TYPES: Record<string, DeliverableType> = {
  "xian-migration": "code",
  "testnet-validation": "research",
  "wallet-integration": "code",
  "docs-content": "content",
  blank: "code",
}

// ── Canonicalization (v2 terms block — FROZEN once shipped) ───────────────────
//
// Same contract as canonicalWorkBrief v1 (escrow-utils.ts): the block must be
// re-derivable byte-for-byte years later, so the key ORDER below is fixed and
// independent of object/JSON key order, values are trimmed, and absent fields
// are omitted entirely. Never reorder or rename keys — add new ones at the
// END behind a presence check, or bump the brief version.

const oneLine = (s: string) => s.trim().replace(/\s+/g, " ")

/**
 * Deterministic key-ordered rendering of the terms (+ the task's existing
 * deadline column, passed in so there is exactly one source of truth for the
 * due date). Returns "" when nothing is set — callers then commit a v1 brief.
 */
export function canonicalTermsBlock(
  terms: TaskTerms | null | undefined,
  opts: { dueIso?: string | null } = {},
): string {
  const t = terms ?? {}
  const lines: string[] = []
  if (opts.dueIso) lines.push(`due: ${opts.dueIso.slice(0, 10)}`)
  if (t.deliverableType) lines.push(`type: ${t.deliverableType}`)
  if (t.repoUrl) lines.push(`repo: ${oneLine(t.repoUrl)}`)
  if (t.specUrl) lines.push(`spec: ${oneLine(t.specUrl)}`)
  if (t.acceptanceCriteria?.length) {
    lines.push("criteria:")
    for (const c of t.acceptanceCriteria) lines.push(`- ${oneLine(c)}`)
  }
  if (t.definitionOfDone?.length) {
    lines.push(`done: ${[...t.definitionOfDone].sort().join(", ")}`)
  }
  if (t.revisionsIncluded !== undefined) lines.push(`revisions: ${t.revisionsIncluded}`)
  if (t.reviewWindowDays !== undefined) lines.push(`review-window-days: ${t.reviewWindowDays}`)
  if (t.license) lines.push(`license: ${t.license}`)
  if (t.licenseNote) lines.push(`license-note: ${oneLine(t.licenseNote)}`)
  if (t.commChannel) lines.push(`contact: ${oneLine(t.commChannel)}`)
  if (t.claimEligibility) lines.push(`claim: ${t.claimEligibility}`)
  // Added with PR C — new keys go at the END (frozen-format rule above).
  if (t.minTrustTier) lines.push(`min-trust: ${t.minTrustTier}`)
  return lines.join("\n")
}

// ── Human rendering (review step, task detail, dispute evidence) ──────────────

export const DONE_LABELS: Record<DoneCheck, string> = {
  "tests-pass": "tests pass",
  "ci-green": "CI green",
  "code-reviewed": "code reviewed",
  deployed: "deployed",
  "docs-updated": "docs updated",
}

export const LICENSE_LABELS: Record<(typeof LICENSES)[number], string> = {
  mit: "MIT",
  "apache-2.0": "Apache-2.0",
  cc0: "CC0 (public domain)",
  "assigned-on-payment": "IP assigned to poster on payment",
  custom: "Custom (see note)",
}

/**
 * The contract, in sentences — rendered on the review step (what the poster
 * agrees to publish) and the task detail (what the claimer agrees to do).
 */
export function renderContractSummary(args: {
  rewardXrd: number
  insuranceXrd: number
  terms: TaskTerms | null | undefined
  dueIso?: string | null
  /**
   * Optional XRD→USD rate for dual-labeling the reward + insurance amounts.
   * Omitted/null → byte-for-byte identical XRD-only output (fail open), so
   * every existing rateless caller is unchanged. USD is purely additive.
   */
  usdRate?: number | null
  /**
   * Reward-resource flip prep. Pass the task's `rewardResource` column when
   * available (e.g. task detail, which has the row); omit for a not-yet-created
   * task (the create flow, which is XRD-only until the escrow component swap
   * lands). Defaults to "XRD".
   */
  rewardResource?: string | null
}): string[] {
  const { rewardXrd, insuranceXrd, terms, dueIso, usdRate, rewardResource } = args
  const t = terms ?? {}
  const unit = rewardResource ?? "XRD"
  // With a rate → "$X (N XRD)"; without one → the exact legacy "N XRD" string.
  const rewardLabel =
    usdRate != null ? formatXrdUsd(rewardXrd, usdRate, { unit }) : `${rewardXrd.toLocaleString()} ${unit}`
  const insuranceLabel =
    usdRate != null ? formatXrdUsd(insuranceXrd, usdRate, { unit }) : `${insuranceXrd.toLocaleString()} ${unit}`
  const lines: string[] = [
    // Display-only: the committed brief hashes canonicalTermsBlock, never this line.
    `${rewardLabel} reward + ${insuranceLabel} insurance are locked in escrow by the funding transaction — a second, signed step after posting. The poster's approval, or the review-window release anyone can trigger if the poster never acts, credits the reward to the worker and the insurance back to the poster; each collects with their own signed withdrawal.`,
  ]
  // timeZone UTC is required, not cosmetic. `dueIso` comes from an
  // <input type="date">, which parses as UTC midnight — so rendering it in the
  // viewer's local zone shows the PREVIOUS day for everyone west of UTC. This
  // string is committed into the on-chain brief, so "due the 17th" must mean
  // the same date to the poster in Sydney and the worker in California.
  if (dueIso)
    lines.push(`Work is due ${new Date(dueIso).toLocaleDateString(undefined, { timeZone: "UTC" })}.`)
  if (t.reviewWindowDays !== undefined) {
    lines.push(`Poster commits to reviewing submissions within ${t.reviewWindowDays} day${t.reviewWindowDays === 1 ? "" : "s"}.`)
  }
  if (t.revisionsIncluded !== undefined) {
    lines.push(
      t.revisionsIncluded === 0
        ? "No revision rounds included — the first delivery is judged as-is."
        : `${t.revisionsIncluded} revision round${t.revisionsIncluded === 1 ? "" : "s"} included before disputes.`,
    )
  }
  if (t.definitionOfDone?.length) {
    lines.push(`Done means: ${t.definitionOfDone.map((d) => DONE_LABELS[d]).join(", ")}.`)
  }
  if (t.license) {
    lines.push(`License: ${LICENSE_LABELS[t.license]}${t.licenseNote ? ` — ${t.licenseNote}` : ""}.`)
  }
  if (t.claimEligibility && t.claimEligibility !== "both") {
    lines.push(t.claimEligibility === "humans" ? "Human builders only." : "Agent builders only.")
  }
  // ⚠️ Reworded 2026-08-29. These lines read "Open to Top Rated builders ONLY"
  // and "Open to Established+ builders ONLY" — which asserted a gate. There was
  // never a gate: `claim_task` is PUBLIC and asserts nothing about trust, and
  // the app-side check that backed this wording has been removed. Stating a
  // preference is honest; stating exclusivity was not.
  if (t.minTrustTier) {
    lines.push(
      t.minTrustTier === "top_rated"
        ? "The poster asks for Top Rated builders. This is a stated preference, not enforced — anyone can claim."
        : "The poster asks for Established+ builders. This is a stated preference, not enforced — anyone can claim.",
    )
  }
  lines.push("These terms are hashed and committed on-chain when the escrow is funded — they are the dispute evidence.")
  return lines
}
