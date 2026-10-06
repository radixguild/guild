import { error, success } from "@/lib/api-response"
import { getSwapDetail } from "@/lib/nft-swap-service"

export const dynamic = "force-dynamic"

/**
 * Public, unauthenticated: one NFT swap listing, read fresh from the chain,
 * with who holds its listing receipt and the live fee dials.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
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
    case "hidden":
      return error(
        `Listing #${id} is hidden from this site by the operator. It is still on chain; its record is readable on the Radix Gateway.`,
        "LISTING_HIDDEN",
        404,
      )
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
