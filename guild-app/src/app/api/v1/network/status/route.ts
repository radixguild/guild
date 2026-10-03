import { success } from "@/lib/api-response"
import { evaluateNetworkHalt } from "@/lib/alerts"
import {
  NETWORK_HALT_AFTER_SECONDS,
  operatorHaltEngaged,
  readLedgerTip,
} from "@/lib/gateway"

// Must render per-request. A statically-optimized GET would bake one answer at
// build time, which defeats the entire purpose: this endpoint exists so the
// site can react to a network halt (or an operator pulling GUILD_HALT) WITHOUT
// a rebuild and restart. Freshness is bounded by LEDGER_TIP_CACHE_MS in the
// gateway reader, not by Next.
export const dynamic = "force-dynamic"

/**
 * Public network-liveness probe.
 *
 * `halted: true`  — the operator lever is on, OR the ledger tip has not moved
 *                   for longer than NETWORK_HALT_AFTER_SECONDS.
 * `halted: false` — tip is advancing normally.
 * `halted: null`  — UNKNOWN. No tip has ever been read successfully, so we do
 *                   not know. Clients fail OPEN on null (render nothing): a
 *                   cold-start Gateway hiccup must not fabricate a sitewide
 *                   "the network is stopped" claim.
 *
 * `stale: true` means the tip figures are a remembered last-known value being
 * re-served because the live read failed — reported rather than hidden, so a
 * reader can tell "the chain stopped" from "we cannot see the chain".
 *
 * Unauthenticated by design: every cold-user surface needs this answer, and the
 * short-TTL server cache means bursts do not fan out to the Gateway.
 */
export async function GET() {
  const operatorHalt = operatorHaltEngaged()
  const tip = await readLedgerTip()
  // The same read that drives the site banner drives the operator's
  // network-halt incident: one 🔴 when the tip stops, silent reminders while
  // it stays stopped, one 🟢 when it moves. Every cold page loads this route,
  // so the incident tracks reality without a cron. Fire-and-forget.
  void evaluateNetworkHalt(tip, operatorHalt).catch(() => {})

  if (!tip) {
    // No chain read, ever. The operator lever still stands on its own — it is
    // the one signal that does not depend on reaching the Gateway, and losing
    // it here would make the manual stop button fail exactly when the Gateway
    // is also down.
    return success({
      halted: operatorHalt ? true : null,
      operatorHalt,
      stale: false,
      ageSeconds: null,
      stateVersion: null,
      tipIso: null,
      haltAfterSeconds: NETWORK_HALT_AFTER_SECONDS,
    })
  }

  return success({
    halted: operatorHalt || tip.ageSeconds > NETWORK_HALT_AFTER_SECONDS,
    operatorHalt,
    stale: tip.stale,
    ageSeconds: tip.ageSeconds,
    stateVersion: tip.stateVersion,
    tipIso: tip.tipIso,
    haltAfterSeconds: NETWORK_HALT_AFTER_SECONDS,
  })
}
