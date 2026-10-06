import { NextRequest } from "next/server"
import { error, success } from "@/lib/api-response"
import { getSwapDetail } from "@/lib/nft-swap-service"
import { createRateLimiter, getClientIp, rateLimitResponse } from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

// Every hit is a fresh chain read (3-5 Gateway calls). The page re-reads a few
// times after the viewer's own transaction; 60 a minute per address covers
// that with room to spare.
const limiter = createRateLimiter({ windowMs: 60_000, max: 60 })

/**
 * Public, unauthenticated: one NFT swap listing, read fresh from the chain,
 * with who holds its listing receipt and the live fee dials.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const limit = limiter(`swap:${getClientIp(req)}`)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)
  const raw = (await params).id
  const id = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id < 1) {
    return error("Listing id must be a positive integer", "INVALID_ID", 400)
  }
  const r = await getSwapDetail(id)
  switch (r.kind) {
    case "ok":
      return success(r.view)
    case "not_found":
      return error(`No listing #${id} on the swap component`, "NOT_FOUND", 404)
    case "unreadable":
      return error(
        `Listing #${id} exists on chain but its record did not match the shape this site reads, so nothing is shown rather than a guess.`,
        "LISTING_UNREADABLE",
        502,
      )
    default:
      return error("The swap component could not be read from the Radix Gateway. Try again shortly.", "CHAIN_UNREADABLE", 503)
  }
}
