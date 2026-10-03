import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { listProjectsWithProgress, createProject } from "@/db/queries/projects"
import { createProjectSchema } from "@/lib/validation"
import { bannedClaimIn, bannedClaimError } from "@/lib/project-copy-gate"
import { fromError } from "@/lib/api-response"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"

const createLimiter = createRateLimiter({ windowMs: 60_000, max: 5 })

export async function GET() {
  try {
    const data = await listProjectsWithProgress()
    return NextResponse.json({ ok: true, data })
  } catch (err) {
    return fromError(err)
  }
}

export const POST = withAuth(async (req, { user }) => {
  const limit = createLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const body = await req.json().catch(() => null)
  if (!body) {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_BODY", message: "Invalid JSON" } },
      { status: 400 },
    )
  }

  const parsed = createProjectSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
      { status: 400 },
    )
  }

  // §22: refuse a banned claim BEFORE it is public. Runs on the parsed data, so
  // it sees exactly what would be stored. See src/lib/project-copy-gate.ts.
  const banned = bannedClaimIn(parsed.data)
  if (banned) return NextResponse.json(bannedClaimError(banned), { status: 400 })

  try {
    const project = await createProject({
      name: parsed.data.name,
      description: parsed.data.description,
      commissionerId: user.userId,
    })
    return NextResponse.json({ ok: true, data: project }, { status: 201 })
  } catch (err) {
    return fromError(err)
  }
})
