import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { behindAgentsFlag } from "@/lib/agent-api"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"
import { issuePairingCode, labelHeldByAnotherOwner, ownerHasAgentNamed } from "@/db/queries/agents"
import { agentBadgeLocalId, formatPairingCode, isValidAgentLabel, normalizeAgentLabel, pairingOneLiner } from "@/lib/agent-label"
import { isBadgeLocalIdMinted } from "@/lib/gateway"
import { KIT_TARBALL_URL } from "@/lib/config"
import { isAccountAddress } from "@/lib/agent-rules"
import { issuePairingCodeSchema } from "@/lib/validation"

// A code is cheap to mint and lives 15 minutes; 5/min per owner is plenty for
// a person and starves a loop.
const createLimiter = createRateLimiter({ windowMs: 60_000, max: 5 })

/**
 * POST /api/v1/agents/codes — the owner names an agent and gets the one line
 * to paste into it (docs/design/bring-your-agent.md §1a step 1, §3.2).
 *
 * The code is born bound to THIS session's account; only an agent that
 * redeems it (POST /agents/pair) becomes this owner's agent. The name is
 * checked against the Guild's other live agents and open codes, then against
 * the chain: the badge id is global and permanent, so a taken name would fail
 * the funding transaction later, at the worst moment. Neither check can hold
 * the name — `public_mint` is permissionless — so the manifest route checks
 * the chain again right before the wallet opens, and a pending agent can be
 * renamed.
 */
export const POST = behindAgentsFlag(withAuth(async (req, { user }) => {
  const limit = createLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  if (!isAccountAddress(user.userId)) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "ACCOUNT_REQUIRED", message: "Sign in with an account (account_rdx1…) — it is the wallet that funds the agent." },
      },
      { status: 403 },
    )
  }

  const body = await req.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ ok: false, error: { code: "INVALID_BODY", message: "Invalid JSON" } }, { status: 400 })
  }
  const parsed = issuePairingCodeSchema.safeParse(body)
  if (!parsed.success || !isValidAgentLabel(parsed.data.label)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "label must be 1–51 letters, digits or _ (it becomes the agent's badge name, which cannot hold a '-')",
        },
      },
      { status: 400 },
    )
  }
  const label = parsed.data.label
  const labelNorm = normalizeAgentLabel(label)

  if (await ownerHasAgentNamed(user.userId, labelNorm)) {
    return NextResponse.json(
      { ok: false, error: { code: "LABEL_IN_USE", message: `You already have an agent called "${labelNorm}".` } },
      { status: 409 },
    )
  }

  if (await labelHeldByAnotherOwner(user.userId, labelNorm)) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "LABEL_TAKEN", message: `Another Guild member is already pairing an agent called "${labelNorm}". Pick another.` },
      },
      { status: 409 },
    )
  }

  // Fail closed on the chain read: a code issued for a name we could not check
  // is a funding transaction that may abort with the person's wallet open.
  const localId = agentBadgeLocalId(labelNorm)
  const minted = await isBadgeLocalIdMinted(localId)
  if (minted === null) {
    return NextResponse.json(
      { ok: false, error: { code: "GATEWAY_UNAVAILABLE", message: "Could not check the name on-chain; try again in a moment." } },
      { status: 503 },
    )
  }
  if (minted) {
    return NextResponse.json(
      { ok: false, error: { code: "LABEL_TAKEN", message: `The badge name "${labelNorm}" is already minted. Pick another.` } },
      { status: 409 },
    )
  }

  const issued = await issuePairingCode({ ownerId: user.userId, label, labelNorm })
  return NextResponse.json(
    {
      ok: true,
      data: {
        code: formatPairingCode(issued.code),
        label,
        labelNorm,
        badgeId: localId,
        expiresAt: issued.expiresAt.toISOString(),
        oneLiner: pairingOneLiner(KIT_TARBALL_URL, issued.code),
      },
    },
    { status: 201 },
  )
}))
