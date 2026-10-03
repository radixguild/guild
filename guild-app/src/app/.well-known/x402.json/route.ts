import { NextResponse } from "next/server"
import { getX402Config } from "@/lib/x402/config"

// GET /.well-known/x402.json — x402 payment discovery manifest.
//
// ⚠️ THERE ARE NO PAID RESOURCES TODAY, BY RULING (2026-09-02, operator), so this
// always 404s. That is this file's own long-standing principle applied rather
// than weakened: "the guild never advertises an unbacked payment surface."
//
// WHAT WAS REMOVED AND WHY. This advertised `GET /api/v1/x402/tasks/funded` at
// 0.05 XRD — funded tasks ranked by reward. `tests/unit/x402-paid-tier-boundary`
// carried an `it.fails` proving the free route reproduced that query exactly, so
// the price was unbacked in the plainest sense: identical data was free next door.
//
// The ruling did NOT close the gap by degrading the free tier, and the reason is
// the part worth keeping: THE BUYER WOULD HAVE BEEN THE WORKER. An agent hunting
// funded work to claim is the worker side, and worker legs are free and locked
// ("worker 0% forever"; the fee is a poster-side dial). A discovery paywall is a
// worker-side fee under another name, charged BEFORE any earnings exist, to
// exactly the participant the A2A-first priority exists to attract. Selling
// "freshness" or live TaskState instead would have been worse, not better: in a
// first-to-claim market that sells a CLAIM ADVANTAGE, and posters want the best
// worker, not the one who paid for a head start.
//
// THE RAIL SURVIVES. The facilitator, the settlement table and the structural
// screen stay built and hardened. x402's legitimate home is the POSTER side,
// where the fee dial already lives by ruling. When such a surface exists, add it
// to a `resources` array here — and do not re-add a worker-side one without
// reopening the ruling above.

export function GET() {
  const cfg = getX402Config()
  if (!cfg) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }
  // Enabled but nothing to sell: still 404. An empty `resources` array would be
  // a payment manifest advertising no payments — which a crawler, and the Bazaar
  // listing this manifest exists to feed, would treat as a live surface.
  return NextResponse.json({ error: "not_found" }, { status: 404 })
}
