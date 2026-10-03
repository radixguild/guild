import { NextRequest, NextResponse } from "next/server"
import { getSessionUser, withAuth } from "@/lib/auth"
import { findProjectBySlug, updateProject } from "@/db/queries/projects"
import { listTasks } from "@/db/queries/tasks"
import { fromError } from "@/lib/api-response"
import { updateProjectSchema } from "@/lib/validation"
import { bannedClaimIn, bannedClaimError } from "@/lib/project-copy-gate"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"
import { publicTaskView, isCancelledTaskVisibleTo } from "@/lib/public-task-text"

// One payload for the project page: the project row + every task in it (the
// kanban funnel needs all statuses at once; 100 is the listTasks ceiling and
// far beyond a v1 project — revisit pagination with milestone splits).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params
    const project = await findProjectBySlug(slug)
    if (!project) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "Project not found" } },
        { status: 404 },
      )
    }

    // Same unauthenticated-but-optional session read as GET /api/v1/tasks and
    // GET /api/v1/tasks/[id] — this route is public (a cold visitor must be
    // able to load a project page), so the public-text gate (2026-09-10
    // operator ruling) has to run here too: see src/lib/public-task-text.ts.
    // Read BEFORE listTasks (not after) so the ONE session read feeds both
    // the query-layer viewerId below and the text gate further down — two
    // separate reads for one request is what let them drift apart before.
    const sessionUser = await getSessionUser().catch(() => null)
    const { data: tasks } = await listTasks({
      projectId: project.id,
      limit: 100,
      viewerId: sessionUser?.userId,
    })
    // 2026-09-14 hardening, third pass (PR #580 review finding): listTasks()
    // now applies the creator-or-assignee rule to cancelled rows AT THE QUERY
    // LAYER for a project-scoped view too (see `isProjectScopedView` in
    // db/queries/tasks.ts) — passing viewerId above is what makes that
    // enforceable. The PREVIOUS shape called listTasks with no viewerId at
    // all, so that query's own `sql`false`` default silently dropped EVERY
    // cancelled row for EVERY caller, including a row's own creator/assignee
    // — an over-hiding regression this comment used to describe as intended
    // behaviour. The per-row filter below is now redundant (tasks already
    // comes back pre-filtered) — kept as belt-and-braces: a future call site
    // that forgets to pass viewerId fails CLOSED (over-hides) rather than
    // leaking, and filtering an already-filtered array costs nothing.
    const visibleTasks = tasks.filter((t) => isCancelledTaskVisibleTo(t, sessionUser?.userId))
    return NextResponse.json({
      ok: true,
      data: { ...project, tasks: visibleTasks.map((t) => publicTaskView(t, sessionUser?.userId)) },
    })
  } catch (err) {
    return fromError(err)
  }
}

// Same shape and limit as POST /api/v1/projects — an edit is no cheaper to serve
// than a create, and this one is reachable by anyone holding a session.
const editLimiter = createRateLimiter({ windowMs: 60_000, max: 5 })

// PATCH — the project's commissioner may correct its name or description.
//
// WHY THIS EXISTS. Until this route, the only write to the projects table was
// createProject's insert: a project's public description was WRITE-ONCE, and
// fixing a wrong one meant opening a database shell on the box. That is not a
// theoretical gap — it is how /projects/p5-operations-ci-and-observability came
// to state "Catalogue: 9 tasks · 8,000 XRD in rewards" directly above its own
// funnel reading 0 / 0 / 0 / 0, with no way to correct the copy short of SQL.
// Public copy that cannot be corrected by an operator will eventually be wrong
// in public, and it was.
//
// Authorization is the commissioner, matching the task rule (creator-only) one
// level up. There is no admin/role concept anywhere in this app's session layer
// — see the note in public-task-text.ts — so "the account that created it" is
// the only ownership predicate available, and inventing a second one here would
// be the drift that comment warns about.
export const PATCH = withAuth(async (req, { params, user }) => {
  try {
    const { slug } = await params
    const project = await findProjectBySlug(slug)
    if (!project) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "Project not found" } },
        { status: 404 },
      )
    }
    if (project.commissionerId !== user.userId) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: "FORBIDDEN", message: "Only the project's commissioner can update it" },
        },
        { status: 403 },
      )
    }

    const limit = editLimiter(user.userId)
    if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

    const body = await req.json().catch(() => null)
    if (!body) {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_BODY", message: "Invalid JSON" } },
        { status: 400 },
      )
    }
    const parsed = updateProjectSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
        { status: 400 },
      )
    }

    // §22: only the fields this PATCH carries are scanned — bannedClaimIn skips
    // an absent field, so a name-only edit is never refused over a stored
    // description it did not touch. See src/lib/project-copy-gate.ts.
    const banned = bannedClaimIn(parsed.data)
    if (banned) return NextResponse.json(bannedClaimError(banned), { status: 400 })

    const updated = await updateProject(project.id, parsed.data)
    return NextResponse.json({ ok: true, data: updated })
  } catch (err) {
    return fromError(err)
  }
})
