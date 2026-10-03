import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { listAgentFeed } from "@/db/queries/working-groups"
import { fromError, error as apiError } from "@/lib/api-response"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"

// ⚠️ MOVED 2026-09-20 from /api/agent/feed. That path was a NAMESPACE COLLISION and had
// never been reachable in production: Caddy sends /api/v1/* to this app and every other
// /api/* to the Telegram bot, and the bot genuinely owns /api/agent/* (guild-public
// bot/services/agent-bridge.js — Bearer api keys, a live surface). So a caller of the old
// path got the BOT's "Authorization: Bearer <api_key> required" error from a different
// credential system entirely. Found by an outside-agent audit; nothing in this repo called
// it. Under /api/v1 it routes here, and scripts/gen-openapi.mjs now documents it.

// GET /api/v1/agent/feed — the agent-facing POLL endpoint (Model A §5a / build
// step 7): "serve agents a poll/webhook feed, not the human push rail." Only
// the poll half ever shipped — POLL-ONLY TODAY. No webhook exists anywhere in
// this system (grep-confirmed), and building one is an open design question,
// not a near-term plan — see packages/agent-client/README.md's "Polling: what
// to watch, how often, and what each endpoint cannot tell you" section for
// the recommended client-side pattern this route doesn't provide on its own
// (there is no "changed since you last looked" signal here), plus the
// webhook's open decide-boxes.
//
// Open tasks from every working group the caller has joined, minus muted ones —
// the same membership rule as /api/v1/groups/feed, narrowed to `status =
// 'open'` because a poller wants claimable work, not the group's whole
// history. Read-only: nothing here joins or leaves a group, so there is no
// write for the agent-groups-joined cap to guard — the cap is enforced once,
// at PUT /api/v1/groups/[slug]/membership (Model A §5a), and this route only
// ever reads whatever membership set that gate already allowed to exist.
//
// Auth is the session cookie every route uses (`withAuth`) — the design doc's
// "(token-auth)" note, not a second credential system. Per src/lib/
// agent-lane.ts's own honesty note, agents and humans share the SAME ROLA/JWT
// flow with no server-side discriminator between them (users.isAgent is
// display-only), so this is deliberately not "agents only": it is simply
// named and shaped for how an agent worker uses it (packages/agent-client
// already holds the session cookie every other call here does).
//
// Deliberately NOT gated by AGENT_LANE_LIVE — see agent-lane.ts: reads are
// explicitly outside that switch's scope, and a poll that goes dark during an
// incident would blind a worker to exactly the state (nothing claimable) it
// most needs to see.
//
// Rate-limited per user, the existing 429 pattern (createRateLimiter +
// rateLimitResponse) used across every other route in this API — generous
// enough for a short poll interval, since this is meant to be hit repeatedly.
const pollLimiter = createRateLimiter({ windowMs: 60_000, max: 30 })

export const GET = withAuth(async (req, { user }) => {
  const limit = pollLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  try {
    const url = new URL(req.url)
    const limitParam = Number(url.searchParams.get("limit"))
    const pageLimit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20

    let before: { createdAt: Date; id: number } | undefined
    const raw = url.searchParams.get("before")
    if (raw) {
      // Same "split on the last underscore" cursor shape as /groups/feed — an
      // ISO timestamp contains none, and pinning the id side makes a malformed
      // cursor detectable rather than silently paging from the top again.
      const idx = raw.lastIndexOf("_")
      const createdAt = new Date(raw.slice(0, idx))
      const id = Number(raw.slice(idx + 1))
      if (idx < 0 || Number.isNaN(createdAt.getTime()) || !Number.isFinite(id)) {
        return apiError("Malformed cursor", "INVALID_CURSOR", 400)
      }
      before = { createdAt, id }
    }

    const { data, hasMore, cursor } = await listAgentFeed(user.userId, { limit: pageLimit, before })
    return NextResponse.json({
      ok: true,
      data,
      hasMore,
      cursor: cursor ? `${cursor.createdAt.toISOString()}_${cursor.id}` : null,
    })
  } catch (err) {
    return fromError(err)
  }
})
