import { NextResponse } from "next/server"
import { isEnabled } from "@/lib/features"
import { getSessionUser } from "@/lib/auth"
import { getFundingPoolById, listPoolContributions } from "@/db/queries/funding-pools"
import { fromError, error as apiError } from "@/lib/api-response"
import { subXrd } from "@/lib/xrd-decimal"

// GET /api/v1/funding-pools/[id] — one pool's aggregate state, browsable
// cold (no auth): the pledge board's funding bar must render for a stranger,
// same stance GET /api/v1/tasks/[id] takes toward a task's own poster
// identity. But UNLIKE a task or the escrow it eventually funds, the
// per-contributor ledger here has no on-chain component to justify
// disclosure (no FundingPool blueprint is deployed — see this module's
// top-of-file note) and is database-only PII: a wallet address plus the
// exact pledge amount for every backer. So the response is split by who is
// asking, using the same optional-session idiom GET /api/v1/tasks uses for
// its includeHiddenStale check (read the session, never require it):
//   - anyone, including anonymous: the pool plus aggregate counts only.
//   - a signed-in caller: also their OWN contribution row, if they have one.
//   - the pool's poster (fundingPools.posterId — this repo's existing
//     notion of "pool owner", the same relationship tasks.creatorId has to
//     a task): also the full per-contributor list.
// 503 while the feature is off — see the list route's top-of-file note on
// why, and on what this does and does not promise about real XRD moving.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isEnabled("crowdfund")) {
    return NextResponse.json(
      { ok: false, error: { code: "FEATURE_DISABLED", message: "Community funding is not available" } },
      { status: 503 },
    )
  }
  try {
    const { id } = await params
    const poolId = parseInt(id, 10)
    if (Number.isNaN(poolId)) return apiError("Invalid pool id", "INVALID_ID", 400)

    const pool = await getFundingPoolById(poolId)
    if (!pool) return apiError("Funding pool not found", "NOT_FOUND", 404)

    const contributions = await listPoolContributions(poolId)

    // Optional auth — never a 401 here; a cold visitor still gets the
    // aggregate below. See src/app/api/v1/tasks/route.ts's
    // includeHiddenStale check for the identical idiom.
    const sessionUser = await getSessionUser().catch(() => null)
    const isPoster = !!sessionUser && sessionUser.userId === pool.posterId

    return NextResponse.json({
      ok: true,
      data: {
        pool,
        contributorCount: contributions.length,
        // Exact — derived from the two exact decimal columns, never a float
        // division/subtraction. Zero once funded (pooledXrd === targetXrd by
        // the state machine's own invariant).
        remainingXrd: subXrd(pool.targetXrd, pool.pooledXrd),
        // The caller's own pledge, if any — null for an anonymous caller and
        // for a signed-in one who never pledged into this pool.
        yourContribution: sessionUser
          ? (contributions.find((c) => c.contributorId === sessionUser.userId) ?? null)
          : null,
        // Full per-contributor ledger (wallet address + exact amount) —
        // ONLY for the pool's own poster. Everyone else gets this key
        // omitted entirely rather than a filtered/redacted list, so the
        // response shape itself never hints at who else backed this pool.
        ...(isPoster ? { contributions } : {}),
      },
    })
  } catch (err) {
    return fromError(err)
  }
}
