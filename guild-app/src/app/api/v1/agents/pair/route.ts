import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { behindAgentsFlag } from "@/lib/agent-api"
import { createRateLimiter, getClientIp, rateLimitResponse } from "@/lib/rate-limit"
import { redeemPairingCode } from "@/db/queries/agents"
import { loadAgentForSession } from "@/lib/agent-lifecycle"
import { normalizePairingCode } from "@/lib/agent-label"
import { isAccountAddress } from "@/lib/agent-rules"
import { pairAgentSchema } from "@/lib/validation"

// Two limiters, deliberately. A ROLA session is free to mint (any fresh key
// signs in), so a per-account limit alone lets a guesser rotate accounts. The
// per-IP one is the bound that actually holds against brute force; together
// with 32^8 codes that live 15 minutes it is ample (design §3.2).
const perAccount = createRateLimiter({ windowMs: 60_000, max: 5 })
const perIp = createRateLimiter({ windowMs: 60_000, max: 10 })

/**
 * POST /api/v1/agents/pair — the AGENT redeems the code its owner was shown
 * (docs/design/bring-your-agent.md §3.2, §3.3). Called by the agent's own
 * session; the code's issuer becomes the owner. The response is what
 * packages/agent-client's `parseAgentPairResult` validates.
 */
export const POST = behindAgentsFlag(withAuth(async (req, { user }) => {
  const ip = perIp(getClientIp(req))
  if (!ip.ok) return rateLimitResponse(ip.retryAfter!)
  const acct = perAccount(user.userId)
  if (!acct.ok) return rateLimitResponse(acct.retryAfter!)

  if (!isAccountAddress(user.userId)) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "ACCOUNT_REQUIRED", message: "An agent signs in with an account (account_rdx1…), not a persona." },
      },
      { status: 403 },
    )
  }

  const body = await req.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ ok: false, error: { code: "INVALID_BODY", message: "Invalid JSON" } }, { status: 400 })
  }
  const parsed = pairAgentSchema.safeParse(body)
  const code = parsed.success ? normalizePairingCode(parsed.data.code) : null
  if (!code) {
    return NextResponse.json(
      { ok: false, error: { code: "VALIDATION_ERROR", message: "code must look like XXXX-XXXX" } },
      { status: 400 },
    )
  }

  // Resolve this key's existing row first — a stale pending one is released
  // (or activated, if its funding landed) against the chain, so the redeem's
  // own pre-check sees the truth.
  await loadAgentForSession(user.userId)
  const result = await redeemPairingCode({ code, agentId: user.userId })
  switch (result.outcome) {
    case "paired":
      return NextResponse.json(
        {
          ok: true,
          data: { label: result.agent.label, ownerAccount: result.agent.ownerId, status: result.agent.status },
        },
        { status: 201 },
      )
    case "already_paired":
      return NextResponse.json(
        {
          ok: false,
          error: { code: "AGENT_ALREADY_PAIRED", message: "This account is already paired. Run `guild-agent join` with no code." },
        },
        { status: 409 },
      )
    case "expired":
      return NextResponse.json(
        { ok: false, error: { code: "PAIRING_CODE_EXPIRED", message: "That code has expired — get a new one from the app." } },
        { status: 410 },
      )
    case "self_pair":
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "AGENT_IS_OWNER",
            message: "This account issued the code. An agent needs its own key — run the line on the agent's machine, not with your wallet's key.",
          },
        },
        { status: 409 },
      )
    case "invalid":
      return NextResponse.json(
        { ok: false, error: { code: "PAIRING_CODE_INVALID", message: "The app does not recognise that code." } },
        { status: 404 },
      )
  }
}))
