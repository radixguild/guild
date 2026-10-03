import { NextResponse } from "next/server"
import type { AgentStatus } from "@/db/schema"
import { withAuth } from "@/lib/auth"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"
import {
  findOwnedAgent,
  labelHeldByAnotherOwner,
  manifestMayStillLand,
  ownerActions,
  ownerHasAgentNamed,
  toAgentCard,
  updateAgentSettings,
} from "@/db/queries/agents"
import { isValidAgentLabel, normalizeAgentLabel } from "@/lib/agent-label"
import { behindAgentsFlag, agentNotFound, invalidAgentId, parseAgentId, wrongAgentState } from "@/lib/agent-api"
import { agentRulesSchema, FEE_RESERVE_XRD, maxBondWithinFloat, sameRules, type AgentRules } from "@/lib/agent-rules"
import { ESCROW_COMPONENT } from "@/lib/config"
import { readClaimBondParams } from "@/lib/gateway"
import { readNameOnChain } from "@/lib/agent-funding"
import { updateAgentSchema } from "@/lib/validation"
import { addXrd, gteXrd, isPositiveXrd, normalizeXrd } from "@/lib/xrd-decimal"

const patchLimiter = createRateLimiter({ windowMs: 60_000, max: 20 })

/**
 * NAME_LOCKED, in the owner's words: when the hold ends and what to do. It
 * names Retire only with its cost — a retired agent's key never pairs again.
 */
const NAME_LOCKED_MESSAGE =
  "A funding transaction was prepared under this name in the last 24 hours and may still land, so the name is held until then. Check funding to see whether it landed. To use another name sooner, retire this agent and pair a new one — with a new key."

function refuse(status: number, code: string, message: string, detail?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error: { code, message, ...(detail ? { detail } : {}) } }, { status })
}

/** dryRun false on an agent the `start` action does not admit (pending: not funded yet; retired). */
function cannotStart(status: AgentStatus) {
  return status === "pending"
    ? refuse(
        409,
        "AGENT_WRONG_STATE",
        "An agent stays in practice mode until it is funded — fund and activate it, watch it practise, then Start it.",
        { status },
      )
    : wrongAgentState(status, "start")
}

/**
 * PATCH /api/v1/agents/{id} — the owner edits an agent (docs/design/bring-your-agent.md §3.5).
 *
 *  label     only while pending (after funding it is a minted badge). Before the
 *            row leaves its CURRENT name the chain is asked about that name:
 *            already this agent's badge → ALREADY_FUNDED (confirm instead);
 *            unknown → 503; not minted but a funding tx was handed out in the
 *            last PENDING_AGENT_TTL_MS → NAME_LOCKED, since it may still land;
 *            minted to another account → allowed (nothing can land). The NEW
 *            name is checked like a new code — yours, other members', then the
 *            chain — except that a badge already minted to THIS agent's account
 *            is accepted: renaming onto it re-attaches funding that landed after
 *            the row moved off that name (see the comment in the handler). A
 *            case-only rename keeps the badge name and is always fine.
 *  floatXrd  what the agent keeps for bonds + fees. At least the escrow's LIVE
 *            bond floor + FEE_RESERVE_XRD (never the display constant): below
 *            that, the agent can never afford a claim after its first sweep.
 *  rules     the whole v1 document, strict; `maxBondXrd ≤ float − reserve`
 *            (checked against the float this same request leaves in place).
 *            With `baseRules` (the document the edit was based on), the write
 *            lands only if the agent still has exactly those — 409
 *            RULES_CHANGED otherwise — so a page a poll behind cannot restore
 *            rules the owner has since changed.
 *  dryRun    practice mode alone — Start (false) / Pause (true) — set inside
 *            the stored document, every other rule left as the row has it.
 *            Not with `rules`; `baseRules` may go with it (Start sends it, so
 *            an agent is started only on rules its owner has seen). Leaving
 *            practice mode — dryRun false, however it is sent — waits for
 *            funding (`actions.start`): 409 while the agent is pending.
 *            RULES_CHANGED carries the agent's current card, so the page can
 *            show the rules it now has without waiting for a list refresh.
 *
 * DB-only — no signature follows, so it is not gated on a chain halt (a halt is
 * exactly when an owner may want to tighten rules).
 */
export const PATCH = behindAgentsFlag(withAuth(async (req, { params, user }) => {
  const limit = patchLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const id = parseAgentId((await params).id)
  if (id === null) return invalidAgentId()
  const body = await req.json().catch(() => null)
  const parsed = updateAgentSchema.safeParse(body)
  if (!parsed.success) {
    return refuse(
      400,
      "VALIDATION_ERROR",
      "Send one or more of label, floatXrd, rules or dryRun (rules or dryRun, not both; baseRules only with one of them).",
    )
  }

  const row = await findOwnedAgent(id, user.userId)
  if (!row) return agentNotFound()
  if (!ownerActions(row.status).edit) return wrongAgentState(row.status, "edit")
  const now = new Date()

  // ── label ──
  let label: { label: string; labelNorm: string; from: string; oldNameUnusable: boolean } | undefined
  if (parsed.data.label !== undefined) {
    if (!ownerActions(row.status).rename) return wrongAgentState(row.status, "rename")
    if (!isValidAgentLabel(parsed.data.label)) {
      return refuse(400, "VALIDATION_ERROR", "label must be 1–51 letters, digits or _ (it becomes the agent's badge name)")
    }
    const labelNorm = normalizeAgentLabel(parsed.data.label)
    let oldNameUnusable = false
    if (labelNorm !== row.labelNorm) {
      // ALWAYS ask the chain about the CURRENT name before moving the row off it —
      // not only when this app handed out a manifest. The badge can reach the agent
      // without one: public_mint is permissionless, so the agent's key can self-mint
      // it, and the float is a plain transfer. So "no manifest here" is not "not funded".
      //
      // What no check here can see is such a mint still IN FLIGHT: the Gateway
      // cannot list an account's pending txs. The row may then move off a name
      // whose badge lands a moment later. That is recoverable, not lost — the badge
      // and float sit in the owner's own agent account, and renaming back onto that
      // name re-attaches them (the new-name check below accepts a badge minted to
      // THIS agent). The in-product path is closed: the kit's `guild-worker
      // mint-badge` refuses a paired agent (K2-A — on its local pairing record, and
      // before signing on GET /agents/me; design doc §3.3). A modified client, or a
      // raw public_mint signed with the agent's key, still can — so this check stays.
      const current = await readNameOnChain(row.labelNorm, row.agentId)
      if (current === "unknown") {
        return refuse(503, "GATEWAY_UNAVAILABLE", "Could not check the name on-chain; try again in a moment.")
      }
      if (current === "this_agent") {
        return refuse(409, "ALREADY_FUNDED", "This agent's badge is already in its account under its current name — confirm the funding instead of renaming.")
      }
      if (current === "free" && manifestMayStillLand(row, now)) {
        return refuse(
          409,
          "NAME_LOCKED",
          NAME_LOCKED_MESSAGE,
        )
      }
      // "elsewhere": minted to another account — no funding tx for it can ever land here, so
      // the rename is safe even after a manifest was handed out.
      oldNameUnusable = current === "elsewhere"
    }
    if (labelNorm !== row.labelNorm) {
      if (await ownerHasAgentNamed(user.userId, labelNorm)) {
        return refuse(409, "LABEL_IN_USE", `You already have an agent called "${labelNorm}".`)
      }
      if (await labelHeldByAnotherOwner(user.userId, labelNorm)) {
        return refuse(409, "LABEL_TAKEN", `Another Guild member is already pairing an agent called "${labelNorm}". Pick another.`)
      }
      // "this_agent" is not taken — it is this agent's own badge, e.g. one that
      // landed after the row moved off that name. Accepting it re-attaches the
      // funding; the funded check then activates the row.
      const target = await readNameOnChain(labelNorm, row.agentId)
      if (target === "unknown") return refuse(503, "GATEWAY_UNAVAILABLE", "Could not check the name on-chain; try again in a moment.")
      if (target === "elsewhere") return refuse(409, "LABEL_TAKEN", `The badge name "${labelNorm}" is already minted. Pick another.`)
    }
    // The write re-checks in SQL (updateAgentSettings): the row must still carry
    // `from`, and unless the old name is proven unusable, no manifest may have
    // been handed out since this request read the row.
    label = { label: parsed.data.label, labelNorm, from: row.labelNorm, oldNameUnusable }
  }

  // ── float ──
  let floatXrd: string | undefined
  if (parsed.data.floatXrd !== undefined) {
    if (!isPositiveXrd(parsed.data.floatXrd)) {
      return refuse(400, "VALIDATION_ERROR", "floatXrd must be a positive decimal amount (at most 18 decimal places)")
    }
    const bond = await readClaimBondParams(ESCROW_COMPONENT)
    if (!bond) return refuse(503, "GATEWAY_UNAVAILABLE", "Could not read the escrow's live bond floor; try again in a moment.")
    const minimum = addXrd(bond.floor, String(FEE_RESERVE_XRD))
    if (!gteXrd(parsed.data.floatXrd, minimum)) {
      return refuse(400, "FLOAT_BELOW_MINIMUM", `The float must be at least ${minimum} XRD: one claim bond (${bond.floor}) plus ${FEE_RESERVE_XRD} for fees.`, {
        minimumXrd: minimum,
      })
    }
    floatXrd = normalizeXrd(parsed.data.floatXrd)
  }

  // ── rules ──
  let rules: AgentRules | undefined
  if (parsed.data.rules !== undefined) {
    const r = agentRulesSchema.safeParse(parsed.data.rules)
    if (!r.success) {
      return refuse(400, "VALIDATION_ERROR", "rules must be the v1 rules document", {
        issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      })
    }
    rules = r.data as AgentRules
  }
  let baseRules: AgentRules | undefined
  if (parsed.data.baseRules !== undefined) {
    const b = agentRulesSchema.safeParse(parsed.data.baseRules)
    if (!b.success) return refuse(400, "VALIDATION_ERROR", "baseRules must be the v1 rules document this edit was based on")
    baseRules = b.data as AgentRules
  }

  // Leaving practice mode waits for funding: a pending agent practises first.
  const startsIt = parsed.data.dryRun === false || rules?.dryRun === false
  if (startsIt && !ownerActions(row.status).start) return cannotStart(row.status)

  // The invariant holds for the float and rules this request leaves in place.
  const effectiveFloat = floatXrd ?? row.floatXrd
  const effectiveMaxBond = (rules ?? row.rules).maxBondXrd
  if ((floatXrd !== undefined || rules !== undefined) && !maxBondWithinFloat(effectiveMaxBond, effectiveFloat)) {
    return refuse(
      400,
      "MAX_BOND_EXCEEDS_FLOAT",
      `The largest bond (${effectiveMaxBond} XRD) must leave ${FEE_RESERVE_XRD} XRD of the float for fees. Lower maxBondXrd or raise the float.`,
    )
  }

  const dryRun = parsed.data.dryRun
  const updated = await updateAgentSettings({ id, ownerId: user.userId, label, rules, baseRules, dryRun, floatXrd, now })
  if (!updated) {
    const latest = await findOwnedAgent(id, user.userId)
    if (!latest) return agentNotFound()
    if (label && latest.status === "pending" && latest.labelNorm === label.from && manifestMayStillLand(latest, now)) {
      // A funding tx was handed out while this rename was being checked: it wins.
      return refuse(
        409,
        "NAME_LOCKED",
        NAME_LOCKED_MESSAGE,
      )
    }
    if (label && latest.status === "pending" && latest.labelNorm !== label.from) {
      return refuse(409, "AGENT_CHANGED", "This agent was renamed meanwhile — reload and try again.")
    }
    if (baseRules && ownerActions(latest.status).edit && !sameRules(latest.rules, baseRules)) {
      return refuse(
        409,
        "RULES_CHANGED",
        "These rules were changed meanwhile (another tab or device). They are shown as they are now — check them, then try again.",
        { card: toAgentCard(latest) },
      )
    }
    if (startsIt && !ownerActions(latest.status).start) return cannotStart(latest.status)
    return wrongAgentState(latest.status, label ? "rename" : "edit")
  }
  return NextResponse.json({ ok: true, data: toAgentCard(updated) })
}))
