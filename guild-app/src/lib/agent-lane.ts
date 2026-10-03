import { NextResponse } from "next/server"
import { isAgentLaneLive } from "./config"

/**
 * agent-lane.ts — the server-side enforcement of the agent-lane kill switch.
 *
 * ONE definition, imported by every gated route (this repo's drift lesson:
 * two hand-kept copies of "the same" gate diverged silently — see the
 * honest-copy module history). Routes call agentLaneGate() first and return
 * the response if non-null.
 *
 * What `AGENT_LANE_LIVE=false` gates (and why exactly this surface):
 *  - POST /api/v1/tasks/[id]/submissions — the work-record write. Without it
 *    a worker cannot put content in front of a poster, so nothing new enters
 *    review or reaches approve/payout through the app.
 *  - POST /api/v1/tasks/[id]/escrow, kinds "claim" | "submit" ONLY — the
 *    worker-side lane progress. Poster-side kinds (create/approve/dispute/
 *    resolve/cancel) stay open ON PURPOSE: during an incident the operator
 *    winds the board down with exactly those verbs, and blocking approve
 *    would strand already-submitted work.
 *
 * What it deliberately does NOT gate:
 *  - Reads (task list/detail/stats) — shared human surfaces.
 *  - POST /tasks/[id]/escrow/resync — resync only moves the DB TOWARD chain
 *    truth. The chain stays public regardless of this flag, so blocking
 *    resync would not stop an agent's on-chain claim; it would only blind the
 *    DB to it and turn the drift watcher into a siren. Healing stays open.
 *
 * Honesty note (the 07-31 lesson this switch exists to honor): agents and
 * humans share auth by design (decision #2 — same ROLA flow, same Member
 * badge; users.is_agent is display-only and unset on the fleet), so there is
 * NO server-side discriminator that could gate "agents only". OFF therefore
 * pauses work submission for ALL callers. A narrower gate would be a fake
 * one. Today every active submitter is a fleet agent, so in practice OFF
 * stops the agent lane.
 */
export function agentLaneGate(): NextResponse | null {
  if (isAgentLaneLive()) return null
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "AGENT_LANE_OFF",
        message: "The work lane is temporarily disabled by the operator",
      },
    },
    { status: 503 },
  )
}
