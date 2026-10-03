import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { createProposal, listProposalsByUser } from "@/db/queries/working-groups"
import { proposeWorkingGroupSchema } from "@/lib/validation"
import { bannedGroupClaimIn, copyClaimError } from "@/lib/project-copy-gate"
import { fromError } from "@/lib/api-response"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"

// The propose-queue (Model A §5c / build step 6): "add a 'propose a group'
// submission → admin queue; never auto-create from user input." This route is
// the ONLY write path here — it inserts a `pending` row in
// working_group_proposals, never a working_groups row. Curation (approve →
// create the real group; reject) is an operator script,
// scripts/review-group-proposals.mjs, not an HTTP route: there is no
// admin-authenticated surface anywhere in this app (verified — see the schema
// comment on workingGroupProposals), and adding an unguarded "approve" route
// would let any signed-in caller create their own group, which is exactly the
// fragmentation failure mode §5c exists to prevent.
//
// 🔒 GET is self-only, mirroring /api/v1/groups/memberships' own stance: "my
// proposals" is a legitimate thing to show a user (did mine get approved?),
// the full queue is not something this route serves to anyone.

const proposeLimiter = createRateLimiter({ windowMs: 60_000, max: 5 })

export const GET = withAuth(async (_req, { user }) => {
  try {
    const data = await listProposalsByUser(user.userId)
    return NextResponse.json({ ok: true, data })
  } catch (err) {
    return fromError(err)
  }
})

export const POST = withAuth(async (req, { user }) => {
  const limit = proposeLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const body = await req.json().catch(() => null)
  if (!body) {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_BODY", message: "Invalid JSON" } },
      { status: 400 },
    )
  }

  const parsed = proposeWorkingGroupSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
      { status: 400 },
    )
  }

  // §22, extended to working groups 2026-09-19 — a group name and blurb are pitch
  // copy like a project's, so no quoted-mention exemption here.
  const bannedClaim = bannedGroupClaimIn(parsed.data)
  if (bannedClaim) return NextResponse.json(copyClaimError(bannedClaim), { status: 400 })

  try {
    const proposal = await createProposal(user.userId, parsed.data.name, parsed.data.description ?? "")
    return NextResponse.json({ ok: true, data: proposal }, { status: 201 })
  } catch (err) {
    return fromError(err)
  }
})
