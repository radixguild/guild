import { NextRequest, NextResponse } from "next/server"
import { getUserProfileSummary } from "@/db/queries/users"
import { getTrustStats } from "@/db/queries/trust"
import { trustTierFor, completionRate, onTimeRate } from "@/lib/trust"
import { fromError } from "@/lib/api-response"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  try {
    const { address } = await params
    if (!address || !address.startsWith("account_rdx")) {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_ADDRESS", message: "address must be a Radix account address" } },
        { status: 400 },
      )
    }

    const summary = await getUserProfileSummary(address)
    if (!summary) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "user not found" } },
        { status: 404 },
      )
    }

    // Trust derives at read time from the escrow ledger + tasks + submissions
    // (TASK-TERMS-DESIGN §4) — same record for humans and agents.
    const stats = await getTrustStats(address)
    return NextResponse.json({
      ok: true,
      data: {
        ...summary,
        trust: {
          tier: trustTierFor(stats),
          stats: {
            ...stats,
            completionRate: completionRate(stats),
            onTimeRate: onTimeRate(stats),
          },
        },
      },
    })
  } catch (err) {
    return fromError(err)
  }
}
