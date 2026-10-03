import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"
import { activateAgent, findOwnedAgent, toAgentCard } from "@/db/queries/agents"
import { behindAgentsFlag, agentNotFound, invalidAgentId, parseAgentId, wrongAgentState } from "@/lib/agent-api"
import { readFundingState, verifyFundingTx, type FundingGap } from "@/lib/agent-funding"
import { agentFundedSchema } from "@/lib/validation"

const fundedLimiter = createRateLimiter({ windowMs: 60_000, max: 20 })

/** What the owner is told for each way the funding can fall short. All 409: the row stays pending. */
const GAPS: Record<FundingGap, { code: string; message: string }> = {
  tx_pending: { code: "FUNDING_PENDING", message: "The transaction has not landed yet. This retries safely — try again in a few seconds." },
  tx_failed: { code: "FUNDING_TX_FAILED", message: "That transaction failed or was rejected on-chain; nothing moved. Fund the agent again." },
  float_short: { code: "FUNDING_FLOAT_SHORT", message: "Less than this agent's float reached its account." },
  badge_missing: { code: "FUNDING_BADGE_MISSING", message: "That transaction did not deliver this agent's badge to its account." },
  badge_elsewhere: { code: "LABEL_TAKEN", message: "This agent's badge name is held by a different account. Rename the agent, then fund it." },
  not_minted: { code: "FUNDING_NOT_FOUND", message: "No funding for this agent is on-chain yet." },
}

/**
 * POST /api/v1/agents/{id}/funded — the owner's page, right after the wallet
 * signed the §3.4 transaction: check the chain, and activate the agent if the
 * float AND the badge reached its account (docs/design/bring-your-agent.md §3.2).
 *
 * `{intentHash}` → the committed tx's balance changes (recorded as `pair_tx`).
 * `{}`           → the chain's current state: where the badge is, and the
 *                  agent's XRD — for a tab that closed after the wallet signed.
 *
 * NOT gated on the chain halt: it confirms a transaction already signed, and
 * gating it would strand a signature made just before a halt (the same reason
 * POST /tasks/{id}/escrow stays open). Idempotent: an active agent answers 200.
 */
export const POST = behindAgentsFlag(withAuth(async (req, { params, user }) => {
  const limit = fundedLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const id = parseAgentId((await params).id)
  if (id === null) return invalidAgentId()
  const raw = await req.json().catch(() => ({}))
  const parsed = agentFundedSchema.safeParse(raw ?? {})
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "VALIDATION_ERROR", message: "intentHash must be a transaction id (txid_rdx1…)" } },
      { status: 400 },
    )
  }

  const row = await findOwnedAgent(id, user.userId)
  if (!row) return agentNotFound()
  if (row.status === "active") return NextResponse.json({ ok: true, data: toAgentCard(row) })
  if (row.status !== "pending") return wrongAgentState(row.status, "fund")

  const args = { agentAccount: row.agentId, labelNorm: row.labelNorm, floatXrd: row.floatXrd }
  const intentHash = parsed.data.intentHash
  const evidence = intentHash ? await verifyFundingTx({ ...args, intentHash }) : await readFundingState(args)
  if (evidence === null) {
    return NextResponse.json(
      { ok: false, error: { code: "GATEWAY_UNAVAILABLE", message: "Could not read the chain; the agent stays pending. Try again in a moment." } },
      { status: 503 },
    )
  }
  if (!evidence.funded) {
    const gap = GAPS[evidence.gap]
    return NextResponse.json({ ok: false, error: { ...gap, detail: { gap: evidence.gap } } }, { status: 409 })
  }

  const activated = await activateAgent({
    id: row.id,
    ownerId: user.userId,
    badgeId: evidence.badgeId,
    pairTx: evidence.via === "tx" ? evidence.intentHash : null,
  })
  if (!activated) {
    // Moved on between the read and the write (retired, or activated with another badge).
    const now = await findOwnedAgent(id, user.userId)
    return now ? wrongAgentState(now.status, "fund") : agentNotFound()
  }
  return NextResponse.json({ ok: true, data: toAgentCard(activated) })
}))
