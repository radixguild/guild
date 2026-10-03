import { z } from "zod"
import { TaskTermsSchema } from "@/lib/task-terms"
import { PoolCharterSchema } from "@/lib/pool-charter"
import { DECLINE_REASONS } from "@/db/schema/submissions"
import { FUNDING_MIN_DEADLINE_SECS, FUNDING_MAX_DEADLINE_SECS } from "@/lib/funding-config"
import { isAtLeastXrd, isPositiveXrd } from "@/lib/xrd-decimal"
import {
  MIN_REWARD_XRD,
  REWARD_SHAPE_RE,
  TASK_DESCRIPTION_MAX_CHARS,
  TASK_TITLE_MAX_CHARS,
  XRD_MAX_INT_DIGITS,
} from "@/lib/marketplace"

// A task's reward, as the API accepts it — ONE schema for POST (create) and
// PATCH (edit-while-unfunded), because a floor on create alone is a floor with
// a side door: post at "1", PATCH to "0.5", and the row is as unfundable as if
// it had been created that way.
//
// The refusal is the band (0, MIN_REWARD_XRD): a reward the poster means to
// fund (> 0) that the escrow will not take (`create_task` asserts
// `reward_amount >= min_amount`, "reward below per-token minimum"). Until
// 2026-09-17 this was shape-only, so "0.5" got a 201, a task row, and then a
// funding tx that could only revert — the poster stranded with a task nobody
// can ever fund. Refusing here turns that into a 400 before any row exists.
//
// A ZERO REWARD STAYS VALID — RULED by bigdev 2026-09-17 ("keep '0' valid"), not
// an oversight to tidy away. The regex takes every well-formed spelling of zero,
// so this is "0", "00", "0.0" and "0.00000000": a zero-reward row is the unfunded
// off-chain lane (prune-unfunded.ts: "never meant to be funded"; the
// submissions route advances it without escrow), and decision F3
// (docs/FEE-BUSINESS-MODEL.md) exempts free/unfunded tasks from the funded
// minimum. It is never sent to `create_task`, so the chain floor does not
// apply to it. The create FORM still requires >= the minimum — it has no free
// lane — so this exemption is reachable by direct API callers only.
//
// XRD ONLY: nothing in this schema names a reward token, and
// `tasks.reward_resource` has no writer. The on-chain minimum is PER TOKEN;
// when a second reward token becomes postable this must become a per-token
// lookup rather than reusing the XRD number (see MIN_REWARD_XRD's note).
//
// REWARD_SHAPE_RE is imported, not written here: the create form tests the same
// object (see its note in marketplace.ts), so the form cannot let through a
// reward this schema refuses.
const rewardAmountSchema = z
  .string()
  .regex(REWARD_SHAPE_RE, "Invalid XRD amount")
  .refine(
    // The shape re-test keeps this message off malformed input: zod 4 runs
    // refinements even after the regex check fails, and "abc" is not "below
    // the minimum" — it already has its own issue above.
    (v) => !REWARD_SHAPE_RE.test(v) || !isPositiveXrd(v) || isAtLeastXrd(v, MIN_REWARD_XRD),
    `reward_amount must be at least ${MIN_REWARD_XRD} XRD — the escrow's minimum for a funded task; ` +
      `a smaller reward cannot be funded on chain`,
  )
  // A refinement has no JSON-Schema form, so without this the published spec
  // (public/openapi.json, generated from these schemas) would still advertise
  // the bare pattern and an API caller would meet the floor only as a 400.
  // tests/unit/openapi-spec.test.ts is what goes red if this stops reaching
  // the spec.
  .describe(
    `XRD amount, up to ${XRD_MAX_INT_DIGITS} digits before the decimal point and up to 8 after. Must be at ` +
      `least ${MIN_REWARD_XRD} (the live escrow's per-token minimum for XRD; create_task reverts below it), ` +
      `or exactly 0 for an unfunded off-chain task. ` +
      `Values between 0 and ${MIN_REWARD_XRD} are refused with VALIDATION_ERROR.`,
  )

export const createTaskSchema = z.object({
  // Shared with the create form's step-1 blocker via marketplace.ts, so the
  // form cannot pass a title or description this schema would then refuse.
  title: z.string().min(1).max(TASK_TITLE_MAX_CHARS),
  description: z.string().min(1).max(TASK_DESCRIPTION_MAX_CHARS),
  reward_amount: rewardAmountSchema,
  requirements: z.string().max(5000).optional(),
  deadline: z.string().datetime().optional(),
  // Structured committed terms — hashed into the v2 work-brief at funding
  // (docs/TASK-TERMS-DESIGN.md). Strict schema: unknown keys are rejected so
  // nothing reaches the DB that the canonical block wouldn't commit.
  terms: TaskTermsSchema.optional(),
  // Optional project grouping — app-layer metadata, never part of the brief
  // hash (a task can move projects without breaking its on-chain commitment).
  project_id: z.number().int().positive().optional(),
  // Optional working-group routing (Model A, step 4). Same stance as
  // project_id and for the same reason: app-layer metadata, deliberately NOT
  // part of the work-brief hash, so a task can be re-routed between groups
  // without breaking its on-chain commitment. The group only decides who is
  // shown the task in their feed (push notifications are designed, not wired);
  // it confers no permission and gates no money.
  working_group_id: z.number().int().positive().optional(),
})

// Community-funded tasks (threshold crowdfund). `reward_amount`'s regex is
// max-8dp — ⚠️ NOT, as this comment claimed until 2026-09-18, "because that is
// what the ESCROW manifest builder accepts": that builder (lib/manifests.ts,
// `decimalArg`) accepts up to **18** places, the chain's own `Decimal`
// precision. The 8 is what keeps sendDepositTx's float insurance multiply safe
// — see REWARD_MAX_DECIMALS in marketplace.ts, where that is measured out. A
// pool's own target has no such external constraint yet, so this allows the
// full 18dp the DB column and src/lib/xrd-decimal.ts both support — tightened
// later if/when the real FundingPool blueprint imposes a narrower one.
//
// The INTEGER half is capped, and shares XRD_MAX_INT_DIGITS with
// REWARD_SHAPE_RE because it is the same number for the same reason: both land
// in a numeric(38,18) column, which holds 38 - 18 = 20 integer digits. This
// regex was `^\d+(...)` — unbounded — with the same consequence measured on the
// reward path 2026-09-18: a 21-digit `target_xrd` clears this schema, reaches
// createFundingPool's INSERT, and Postgres raises `22003 numeric field
// overflow`, which `fromError` cannot map to anything but a 500. Pledges'
// `amount_xrd` is the same column and is covered by the same cap DIRECTLY, not
// transitively: `pledgeFundingPoolSchema.amount_xrd` is this very schema
// object, so the bound below applies to it verbatim. (applyPledge's over-target
// guard would also reject an oversize pledge against a now-capped target, but
// that is a guard about economics, not about column width, and it is not what
// this relies on.)
const xrdAmountSchema = z
  .string()
  .regex(new RegExp(`^\\d{1,${XRD_MAX_INT_DIGITS}}(\\.\\d{1,18})?$`), "Invalid XRD amount")

export const createFundingPoolSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  // Guarded HERE, at the funding-pool creation boundary — not by tightening
  // the shared `xrdAmountSchema` regex — because that schema is also
  // `pledgeFundingPoolSchema.amount_xrd`'s, and a pledge of "0" is already
  // caught downstream by `applyPledge`'s own `isPositiveXrd` check
  // (funding-state-machine.ts), with a typed AMOUNT_NOT_POSITIVE refusal
  // that carries pledge-specific context (min-contribution, over-target,
  // gap-guard) a bare regex can't express. `target_xrd="0"` has no such
  // downstream guard: `pooledXrd === targetXrd` immediately on creation, so
  // `applyPledge`'s over-target check rejects every future pledge and the
  // pool can never reach `funded` — a permanently-stuck pool, not caught
  // anywhere else in the pipeline. `isPositiveXrd` (not `Number(...) > 0`)
  // so a value at the schema's full 18dp precision is judged exactly, the
  // same reasoning as the insurance-figure fix beside this file's other
  // money paths.
  target_xrd: xrdAmountSchema.refine(isPositiveXrd, "target_xrd must be positive"),
  // The charter — what this pool agrees BEFORE anyone pledges into it.
  // Accepted PARTIAL at creation (`.deepPartial()` would also relax `terms`,
  // which is what we want: a draft is something you come back to). The
  // completeness bar is charterReadiness(), applied at PUBLISH, not here —
  // so an unfinished charter can be saved and a half-written one can never
  // open for pledges. See src/lib/pool-charter.ts.
  charter: PoolCharterSchema.partial().optional(),
  // Seconds until the deadline, poster-chosen within [§4b D3 — ruled] bounds.
  // Omitted = FUNDING_DEFAULT_DEADLINE_SECS (the route applies that default).
  // Stored as a LENGTH; the wall-clock deadline is derived at publish.
  deadline_secs: z
    .number()
    .int()
    .min(FUNDING_MIN_DEADLINE_SECS)
    .max(FUNDING_MAX_DEADLINE_SECS)
    .optional(),
})

export const pledgeFundingPoolSchema = z.object({
  amount_xrd: xrdAmountSchema,
})

export const createProjectSchema = z.object({
  name: z.string().min(3).max(80),
  description: z.string().max(2000).optional(),
})

// Propose-queue submission (Model A §5c / build step 6): "never auto-create
// from user input" — this creates a PROPOSAL row, not a working group. Same
// name/description shape as createProjectSchema deliberately: it is the same
// kind of ask ("we need a category for X"), just routed to admin curation
// instead of a straight insert.
export const proposeWorkingGroupSchema = z.object({
  name: z.string().min(3).max(80),
  description: z.string().max(2000).optional(),
})

// Project edit. Same field shapes as createProjectSchema, both optional, and at
// least one required — a PATCH that changes nothing is a client bug, not a no-op
// worth a 200. `slug` is deliberately NOT editable: it is the project's URL
// identity (/projects/[slug]) and stable-after-create by design, so renaming a
// project must not silently break every link to it.
export const updateProjectSchema = z
  .object({
    name: z.string().min(3).max(80).optional(),
    description: z.string().max(2000).optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: "Provide at least one of: name, description",
  })

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(TASK_TITLE_MAX_CHARS).optional(),
  description: z.string().min(1).max(TASK_DESCRIPTION_MAX_CHARS).optional(),
  // Same floor as create — see rewardAmountSchema. PATCH only reaches an
  // UNFUNDED open task (the route 409s once onChainTaskId is set), which is
  // exactly the row a sub-minimum edit would strand.
  reward_amount: rewardAmountSchema.optional(),
  requirements: z.string().max(5000).optional(),
  deadline: z.string().datetime().optional(),
})

export const createSubmissionSchema = z.object({
  content: z.string().min(1).max(10000),
})

export const reviewSubmissionSchema = z.object({
  status: z.enum(["approved", "rejected", "revision_requested"]),
  reviewer_notes: z.string().max(5000).optional(),
  // Structured reason, rejections only (stored alongside the freeform note so
  // decline patterns are queryable). Server accepts it now; the reviewer UI
  // dropdown ships with the P3 display pass.
  decline_reason: z.enum(DECLINE_REASONS).optional(),
})

// POST /api/v1/tasks/[id]/escrow body — the call that links an on-chain escrow
// transaction to its DB task. The route parses this by hand (its own error codes
// predate this schema), so this exists for ONE reason: until 2026-09-20 the public
// /openapi.json had no request body for this operation at all, and pointed at a
// private README instead — the crux of the claim → submit → paid loop was
// undocumented to every outside agent. tests/unit/escrow-confirm-schema.test.ts
// pins `kind` to escrow-confirm.ts's ROUTE_KINDS so the two cannot drift.
export const escrowConfirmSchema = z.object({
  // The intent hash of a transaction that is ALREADY committed on mainnet.
  intentHash: z.string().regex(/^txid_(rdx|tdx)/),
  // Worker side: claim, submit. Poster side: create, approve, cancel. Either:
  // dispute. Timeout fallback: resolve. Arbiter ruling: arbitrate.
  kind: z.enum(["create", "claim", "submit", "approve", "dispute", "resolve", "arbitrate", "cancel"]),
})

// ── Bring Your Agent (docs/design/bring-your-agent.md §3.2) ────────────────

/** POST /agents/codes — the owner names an agent. The charset is checked again by agent-label.ts. */
export const issuePairingCodeSchema = z.object({
  label: z
    .string()
    .min(1)
    .max(51)
    .describe("The agent's name — also its Guild badge name. 1–51 letters, digits and _ (a badge id cannot hold '-'); lower-cased on-chain."),
})

/** POST /agents/{id}/funded — the owner's funding tx, when the page still has it. */
export const agentFundedSchema = z
  .object({
    intentHash: z
      .string()
      .regex(/^txid_rdx1[a-z0-9]{20,100}$/, "not a transaction id")
      .optional()
      .describe("The funding transaction's intent hash (txid_rdx1…). Omit it and the chain is read for the badge + float instead."),
  })
  .strict()

/** PATCH /agents/{id} — any subset; the route checks each against the row's state. */
export const updateAgentSchema = z
  .object({
    label: z.string().min(1).max(51).optional().describe("New name — only while the agent is pending (the badge is not minted yet)."),
    floatXrd: z.string().max(60).optional().describe("What the agent keeps for bonds + fees; everything above it is swept to you."),
    rules: z.unknown().optional().describe("The whole rules document, v1 (see GET /agents/me)."),
    dryRun: z
      .boolean()
      .optional()
      .describe("Practice mode alone (Start = false, Pause = true), changing nothing else in the rules. Not with rules."),
    baseRules: z
      .unknown()
      .optional()
      .describe(
        "Optional, with rules or dryRun: the rules document this edit was based on. The write lands only if the agent still has exactly these; otherwise 409 RULES_CHANGED.",
      ),
  })
  .strict()
  .refine(
    (v) => v.label !== undefined || v.floatXrd !== undefined || v.rules !== undefined || v.dryRun !== undefined,
    "nothing to change",
  )
  .refine((v) => v.rules === undefined || v.dryRun === undefined, "send rules or dryRun, not both")
  .refine((v) => v.baseRules === undefined || v.rules !== undefined || v.dryRun !== undefined, "baseRules only goes with rules or dryRun")

/** POST /agents/pair — the agent redeems the code its owner was shown. */
export const tgLinkCodeSchema = z.object({
  ticket: z.string().max(512).describe("The ticket from the Telegram bot's /link page URL (?t=…)."),
})

export const pairAgentSchema = z.object({
  code: z.string().max(32).describe("The pairing code from the app, XXXX-XXXX (the dash is optional; case and surrounding whitespace are ignored)."),
})

/** POST /agents/me/heartbeat — the loop's per-tick report. Small by construction. */
export const heartbeatSchema = z.object({
  cycle: z
    .record(z.string(), z.unknown())
    .refine((c) => JSON.stringify(c).length <= 8192, "cycle must serialise to 8 KB or less")
    .describe("What the last cycle did — free-form, shown on the owner's card."),
})

export const verifyAuthSchema = z.object({
  signed_challenge: z.object({
    challenge: z.string(),
    address: z.string(),
    proof: z.object({
      publicKey: z.string(),
      signature: z.string(),
      curve: z.enum(["curve25519", "secp256k1"]),
    }),
    type: z.enum(["persona", "account"]),
  }),
})

// /lights-on temperature checks. `option` is checked against the shape here
// only — whether it is a REAL option key for the given checkId is a lookup
// against src/content/lights-on.ts's TEMP_CHECKS in the route, since that
// depends on which checkId the request names.
export const tempCheckVoteSchema = z.object({
  option: z.string().min(1).max(100),
})

// PATCH /api/v1/notifications/read body. `ids` omitted → mark ALL of the
// caller's unread notifications read (see markNotificationsRead's contract);
// present (even []) → mark exactly those ids, ownership-checked at the query
// layer. Capped at 100 — matches the inbox's own page size, so a client never
// needs to send more than one page's worth in a single mark-read call.
export const markNotificationsReadSchema = z.object({
  ids: z.array(z.number().int().positive()).max(100).optional(),
})
