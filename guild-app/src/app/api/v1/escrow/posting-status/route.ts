import { success } from "@/lib/api-response"
import { ESCROW_COMPONENT } from "@/lib/config"
import { readXrdPostingFrozen } from "@/lib/gateway"

// Must render per-request: a statically-optimized GET would bake the frozen
// answer at build time, which is exactly what this endpoint exists to avoid
// (the swap-ceremony unfreeze may not require an app deploy). Freshness is
// bounded by POSTING_FROZEN_CACHE_MS in the gateway reader, not by Next.
export const dynamic = "force-dynamic"

/**
 * Public posting-status probe: is XRD frozen on the live escrow?
 * `frozen: null` = unknown (Gateway hiccup) — clients fail open on it.
 * Unauthenticated by design (the create page is a cold-user surface); the
 * short-TTL server cache means bursts don't fan out to the Gateway.
 */
export async function GET() {
  const frozen = await readXrdPostingFrozen(ESCROW_COMPONENT)
  return success({ component: ESCROW_COMPONENT, frozen })
}
