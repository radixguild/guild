import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { behindAgentsFlag } from "@/lib/agent-api"
import { listAgentsForOwner, listOpenCodesForOwner, toAgentCard } from "@/db/queries/agents"
import { formatPairingCode, pairingOneLiner } from "@/lib/agent-label"
import { KIT_TARBALL_URL } from "@/lib/config"

/**
 * GET /api/v1/agents/mine — the owner's cards: every agent paired to this
 * account, plus codes issued and not yet redeemed (the "waiting for your
 * agent" state). Owner-only by construction: the query is keyed on the
 * session's account.
 */
export const GET = behindAgentsFlag(withAuth(async (_req, { user }) => {
  const [rows, codes] = await Promise.all([listAgentsForOwner(user.userId), listOpenCodesForOwner(user.userId)])
  return NextResponse.json({
    ok: true,
    data: {
      agents: rows.map(toAgentCard),
      pendingCodes: codes.map((c) => ({
        code: formatPairingCode(c.code),
        label: c.label,
        labelNorm: c.labelNorm,
        expiresAt: c.expiresAt.toISOString(),
        oneLiner: pairingOneLiner(KIT_TARBALL_URL, c.code),
      })),
    },
  })
}))
