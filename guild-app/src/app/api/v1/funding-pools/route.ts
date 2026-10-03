import { NextRequest, NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { isEnabled } from "@/lib/features"
import { listFundingPools, createFundingPool } from "@/db/queries/funding-pools"
import { createFundingPoolSchema } from "@/lib/validation"
import { fromError } from "@/lib/api-response"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"
import { FUNDING_DEFAULT_DEADLINE_SECS, FUNDING_INSURANCE_FRACTION } from "@/lib/funding-config"
import type { FundingPoolStatus } from "@/lib/funding-state-machine"
import { ceilXrdMultiple } from "@/lib/xrd-decimal"
import { chainWriteGate } from "@/lib/chain-halt-gate"

// GET/POST /api/v1/funding-pools — the threshold-crowdfund board (community-
// funded tasks). 503 while NEXT_PUBLIC_FEATURE_CROWDFUND is off, the same
// hard-gate pattern /api/v1/game/* uses (audit HIGH-003) — see features.ts.
//
// ⚠️ Nothing this route does moves real XRD. See src/lib/funding-state-
// machine.ts's module doc and src/db/queries/funding-pools.ts's top-of-file
// note: the FundingPool Scrypto blueprint this composes with does not exist
// yet. A pool created here is an app-layer pledging ledger row, exactly the
// way an unfunded `tasks` row exists before anyone calls the real escrow.

const VALID_STATUSES: FundingPoolStatus[] = [
  "pledging",
  "funded",
  "finalized",
  "expired",
  "refunding",
]

const createLimiter = createRateLimiter({ windowMs: 60_000, max: 5 })

function disabledResponse() {
  return NextResponse.json(
    { ok: false, error: { code: "FEATURE_DISABLED", message: "Community funding is not available" } },
    { status: 503 },
  )
}

export async function GET(req: NextRequest) {
  if (!isEnabled("crowdfund")) return disabledResponse()
  try {
    const { searchParams } = new URL(req.url)
    const status = searchParams.get("status") as FundingPoolStatus | null
    if (status && !VALID_STATUSES.includes(status)) {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_STATUS", message: "Invalid status filter" } },
        { status: 400 },
      )
    }
    const cursorParam = searchParams.get("cursor")
    const cursor = cursorParam ? parseInt(cursorParam, 10) : undefined
    if (cursorParam && Number.isNaN(cursor)) {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_CURSOR", message: "Invalid cursor" } },
        { status: 400 },
      )
    }

    const limitParam = searchParams.get("limit")
    const limit = limitParam ? parseInt(limitParam, 10) : undefined
    if (limitParam && (!Number.isFinite(limit) || (limit as number) <= 0)) {
      // Same shape as the cursor check above — a bad limit must not reach
      // listFundingPools' `Math.min(limit, 100)` and `.limit(limit + 1)`.
      // BOTH halves are load-bearing, and the second was missing until now:
      // NaN stays NaN through Math.min and `.limit(NaN)` surfaces as a generic
      // 500; and a NEGATIVE limit is finite, so it sailed past an isFinite-only
      // check into `.limit(-4)`, which Postgres rejects — also a generic 500.
      // The message has always promised "a positive integer"; now it enforces
      // it, matching /api/v1/game/leaderboard, which this claimed parity with.
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_LIMIT", message: "limit must be a positive integer" } },
        { status: 400 },
      )
    }

    const result = await listFundingPools({
      status: status ?? undefined,
      posterId: searchParams.get("poster") ?? undefined,
      cursor,
      limit,
    })
    return NextResponse.json({
      ok: true,
      data: result.data,
      cursor: result.cursor,
      hasMore: result.hasMore,
    })
  } catch (err) {
    return fromError(err)
  }
}

export const POST = withAuth(async (req, { user }) => {
  if (!isEnabled("crowdfund")) return disabledResponse()

  // After the feature flag, before any work: a pledge-able pool created during a
  // halt promises a funding step nobody can sign. See src/lib/chain-halt-gate.ts.
  const halted = await chainWriteGate()
  if (halted) return halted

  const limit = createLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const body = await req.json().catch(() => null)
  if (!body) {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_BODY", message: "Invalid JSON" } },
      { status: 400 },
    )
  }
  const parsed = createFundingPoolSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
      { status: 400 },
    )
  }

  // The pledging window LENGTH is stored; the wall-clock deadline is derived
  // from it when the poster publishes the charter, not now. A pool is born a
  // DRAFT — see publishPool() in src/lib/funding-state-machine.ts for why the
  // clock must not start while the charter is still being written.
  const deadlineSecs = parsed.data.deadline_secs ?? FUNDING_DEFAULT_DEADLINE_SECS
  // Poster pre-pays the insurance (§4b "Insurance") — COMPUTED here, never
  // accepted from the client body, so a poster cannot under-fund their own
  // safety net and the figure can't disagree with FUNDING_INSURANCE_FRACTION
  // at read time either (see the column comment on fundingPools.insuranceXrd
  // for why it is still stored, not just recomputed on every read).
  //
  // CEILING is the only safe rounding direction here: rounding up can only
  // ever make the poster's pre-paid insurance MORE than the floor, never
  // less, so it can never fail the future blueprint's own
  // `insurance >= target * insurance_fraction` assert. Rounds to the nearest
  // whole XRD, same granularity as the existing per-task insurance UI.
  //
  // Computed via ceilXrdMultiple (exact BigInt, src/lib/xrd-decimal.ts), NOT
  // `Math.ceil(Number(target_xrd) * FUNDING_INSURANCE_FRACTION)` the way
  // src/lib/escrow-utils.ts's sendDepositTx does it for `reward_amount`.
  // That float path is safe THERE because reward_amount's schema caps at
  // 8dp (createTaskSchema) — well inside a JS number's ~15-17 significant-
  // digit precision. `target_xrd` is xrdAmountSchema (validation.ts), which
  // allows the DB column's full 18dp, so `Number(target_xrd)` can silently
  // round the input *before* the multiply ever runs, deriving the "safe"
  // ceiling from an already-wrong value — the one place this PR's own
  // "no JS float touches money" architecture was broken.
  try {
    // Inside the try deliberately. `ceilXrdMultiple` throws
    // InvalidXrdAmountError on a fraction string it cannot parse, and the
    // fraction comes from `String(FUNDING_INSURANCE_FRACTION)` — a constant in
    // another file. `(0.05).toString() === "0.05"` today, but Number#toString
    // switches to exponential below 1e-6, which `toFixedPoint` rejects. Left
    // outside the try, editing that unrelated constant would take every
    // pool-creation request down with an unhandled throw instead of this
    // route's typed error shape. `funding-config.test.ts` pins the constant's
    // string form so such an edit fails at test time, not at request time.
    const insuranceXrd = ceilXrdMultiple(
      parsed.data.target_xrd,
      String(FUNDING_INSURANCE_FRACTION),
    )
    const pool = await createFundingPool({
      posterId: user.userId,
      title: parsed.data.title,
      description: parsed.data.description,
      targetXrd: parsed.data.target_xrd,
      deadlineSecs,
      charter: parsed.data.charter,
      insuranceXrd,
    })
    return NextResponse.json({ ok: true, data: pool }, { status: 201 })
  } catch (err) {
    return fromError(err)
  }
})
