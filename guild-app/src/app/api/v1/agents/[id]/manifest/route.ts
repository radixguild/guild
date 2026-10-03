import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { chainWriteGate } from "@/lib/chain-halt-gate"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"
import { findOwnedAgent, isStalePending, markManifestIssued, trimDecimal } from "@/db/queries/agents"
import { agentBadgeLocalId } from "@/lib/agent-label"
import { behindAgentsFlag, agentNotFound, invalidAgentId, parseAgentId, wrongAgentState } from "@/lib/agent-api"
import { MANAGER } from "@/lib/config"
import { readNameOnChain } from "@/lib/agent-funding"
import { pairAgentManifest } from "@/lib/manifests"

const manifestLimiter = createRateLimiter({ windowMs: 60_000, max: 20 })

/**
 * POST /api/v1/agents/{id}/manifest — the ONE transaction that funds and
 * activates this agent (docs/design/bring-your-agent.md §3.4), built for THIS
 * row's agent account and badge name, to be signed by the owner's wallet.
 *
 * Gated on the chain halt: its next step is a signature the chain must accept.
 * The name is checked again here, right before the wallet opens — `public_mint`
 * is permissionless, so the check at code issue cannot hold it:
 *   minted into this agent's account → 409 ALREADY_FUNDED (confirm instead)
 *   minted anywhere else             → 409 LABEL_TAKEN (rename the agent)
 *   unreadable                       → 503, no manifest
 */
export const POST = behindAgentsFlag(withAuth(async (_req, { params, user }) => {
  const halted = await chainWriteGate()
  if (halted) return halted

  const limit = manifestLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const id = parseAgentId((await params).id)
  if (id === null) return invalidAgentId()
  const row = await findOwnedAgent(id, user.userId)
  if (!row) return agentNotFound()
  if (row.status !== "pending") return wrongAgentState(row.status, "fund")
  if (isStalePending(row)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "PAIRING_EXPIRED",
          // Never "retire it and pair again": a retired agent's key can never
          // pair again (one key, one owner — design §3.1).
          message:
            "This pairing is more than 24 hours old, so a new funding transaction can't be prepared. Once the Guild releases it, pair the agent again with a new code — retiring it instead would stop this key from ever pairing again.",
        },
      },
      { status: 410 },
    )
  }

  const badgeId = agentBadgeLocalId(row.labelNorm)
  const name = await readNameOnChain(row.labelNorm, row.agentId)
  if (name === "unknown") {
    // Fails CLOSED: an unreadable chain — or a minted id the Gateway will not
    // name a holder for (typically just after this agent's own funding landed)
    // — is never read as "taken by someone else".
    return NextResponse.json(
      { ok: false, error: { code: "GATEWAY_UNAVAILABLE", message: "Could not check the name on-chain; try again in a moment." } },
      { status: 503 },
    )
  }
  if (name === "this_agent") {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "ALREADY_FUNDED",
          message: "This agent's badge is already in its account — confirm the funding instead of signing again.",
        },
      },
      { status: 409 },
    )
  }
  if (name === "elsewhere") {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "LABEL_TAKEN", message: `The badge name "${row.labelNorm}" was minted by someone else. Rename the agent, then fund it.` },
      },
      { status: 409 },
    )
  }

  // From here a signed transaction may land at any time, so the name is frozen
  // (PATCH refuses a rename). Recorded BEFORE the manifest leaves the server.
  if (!(await markManifestIssued(row.id, user.userId, row.labelNorm))) {
    const now = await findOwnedAgent(id, user.userId)
    if (!now) return agentNotFound()
    if (now.status === "pending") {
      // Renamed while this request was checking the chain: this manifest would mint the old name.
      return NextResponse.json(
        { ok: false, error: { code: "AGENT_CHANGED", message: "This agent was renamed meanwhile — reload and fund it again." } },
        { status: 409 },
      )
    }
    return wrongAgentState(now.status, "fund")
  }

  const floatXrd = trimDecimal(row.floatXrd)
  return NextResponse.json({
    ok: true,
    data: {
      manifest: pairAgentManifest(MANAGER, row.ownerId, row.agentId, row.labelNorm, floatXrd),
      agentAccount: row.agentId,
      labelNorm: row.labelNorm,
      badgeId,
      floatXrd,
    },
  })
}))
