import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { agentsOffNotPaired, behindAgentsFlag } from "@/lib/agent-api"
import { toAgentMe } from "@/db/queries/agents"
import { loadAgentForSession } from "@/lib/agent-lifecycle"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"

// The kit's join wait loop polls every 5 s (packages/agent-client join.ts
// DEFAULT_POLL_INTERVAL_MS = 12/min) and `run` reads once per tick; 30/min per
// account is headroom for both and a ceiling on a key hammering the route.
const meLimiter = createRateLimiter({ windowMs: 60_000, max: 30 })

/**
 * GET /api/v1/agents/me — the agent's own pairing: status, owner, float and
 * rules. The loop reads this every tick (docs/design/bring-your-agent.md §2.3);
 * `join` reconciles from it. 404 AGENT_NOT_PAIRED is the ONE 404 that means
 * "no row" — a missing route is a plain 404 and the kit tells them apart.
 * A stale pending row is resolved against the chain first (agent-lifecycle.ts).
 * While `agentsAdd` is off it answers AGENT_NOT_PAIRED to everyone, not 503: the
 * kit's live badge mint needs that answer (agentsOffNotPaired, agent-api.ts).
 */
export const GET = behindAgentsFlag(withAuth(async (_req, { user }) => {
  const limit = meLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const row = await loadAgentForSession(user.userId)
  if (!row) {
    return NextResponse.json(
      { ok: false, error: { code: "AGENT_NOT_PAIRED", message: "This account is not paired with an owner." } },
      { status: 404 },
    )
  }
  return NextResponse.json({ ok: true, data: toAgentMe(row) })
}), agentsOffNotPaired)
