/**
 * Shared shapes for the agent routes (/api/v1/agents/…): the feature gate every
 * one of them sits behind, the id, and the three refusals the owner's routes give.
 */
import { NextResponse } from "next/server"
import type { AgentStatus } from "@/db/schema"
import { toAgentCard, type LifecycleResult } from "@/db/queries/agents"
import { withAuth } from "@/lib/auth"
import { isEnabled } from "@/lib/features"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"

/**
 * Every /api/v1/agents/* handler is wrapped in this. While the `agentsAdd` flag
 * is off, the whole surface answers 503 FEATURE_DISABLED before the session is
 * read, so it says nothing about who is signed in or which rows exist: the same
 * posture as game / crowdfund / notifications (HIGH-003). Until 2026-10-03 only
 * the "Add an agent" button was gated, and the routes still answered with the
 * flag off: a pairing code was issued from a browser console that day. Ruled the
 * same day: this surface stays hidden, and is deleted after the beta.
 * tests/unit/agents-api-flag-gate.test.ts calls every route file's handlers.
 */
export function behindAgentsFlag<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
  whenOff: () => NextResponse = agentsFeatureDisabled,
): (...args: Args) => Promise<NextResponse> {
  return async (...args) => (isEnabled("agentsAdd") ? handler(...args) : whenOff())
}

export function agentsFeatureDisabled() {
  return NextResponse.json(
    { ok: false, error: { code: "FEATURE_DISABLED", message: "Adding agents is not available" } },
    { status: 503 },
  )
}

/**
 * GET /agents/me's answer while the flag is off. The kit asks that route before
 * every live badge mint (packages/agent-client/src/mint.ts askGuildPairing, used
 * by `guild-worker mint-badge --live` and `onboard --live`) and proceeds ONLY on
 * AGENT_NOT_PAIRED; a 503 makes it refuse the mint. With pairing off nobody is
 * paired, so this is true, and it is the same answer for every caller.
 */
export function agentsOffNotPaired() {
  return NextResponse.json(
    { ok: false, error: { code: "AGENT_NOT_PAIRED", message: "Agent pairing is off; no account is paired." } },
    { status: 404 },
  )
}

/** Route ids are positive integers (agents.id is an identity column); "12abc" is not 12. */
export function parseAgentId(raw: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null
  const n = Number(raw)
  return n <= 2_147_483_647 ? n : null
}

export function invalidAgentId() {
  return NextResponse.json({ ok: false, error: { code: "INVALID_ID", message: "Invalid agent id" } }, { status: 400 })
}

/** Someone else's agent reads exactly like one that does not exist. */
export function agentNotFound() {
  return NextResponse.json({ ok: false, error: { code: "AGENT_NOT_FOUND", message: "No such agent on your account." } }, { status: 404 })
}

export function wrongAgentState(status: AgentStatus | null, action: string) {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "AGENT_WRONG_STATE",
        message: `Cannot ${action} an agent that is ${status ?? "gone"}.`,
        detail: { status },
      },
    },
    { status: 409 },
  )
}

/**
 * The three owner lifecycle actions (suspend / resume / retire) share one
 * shape: parse the id, run the transition, answer with the card. DB-only —
 * none is gated on a chain halt: a halt is exactly when an owner may want to
 * stop an agent.
 */
export function agentLifecycleRoute(
  action: "suspend" | "resume" | "retire",
  run: (id: number, ownerId: string) => Promise<LifecycleResult>,
) {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 20 })
  return behindAgentsFlag(withAuth(async (_req, { params, user }) => {
    const limit = limiter(user.userId)
    if (!limit.ok) return rateLimitResponse(limit.retryAfter!)
    const id = parseAgentId((await params).id)
    if (id === null) return invalidAgentId()
    const result = await run(id, user.userId)
    if (!result.ok) return result.code === "NOT_FOUND" ? agentNotFound() : wrongAgentState(result.status, action)
    return NextResponse.json({ ok: true, data: toAgentCard(result.agent) })
  }))
}
