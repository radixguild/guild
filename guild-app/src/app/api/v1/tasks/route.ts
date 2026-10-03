import { NextRequest, NextResponse } from "next/server"
import { withAuth, getSessionUser } from "@/lib/auth"
import { listTasks, createTask } from "@/db/queries/tasks"
import { findProjectById } from "@/db/queries/projects"
import { findRoutableWorkingGroupById } from "@/db/queries/working-groups"
import { getTierForReward } from "@/lib/incentives"
import { createTaskSchema } from "@/lib/validation"
import { bannedTaskClaimIn, copyClaimError } from "@/lib/project-copy-gate"
import { fromError } from "@/lib/api-response"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"
import type { TaskStatus } from "@/lib/types"
import { chainWriteGate } from "@/lib/chain-halt-gate"
import { publicTaskView, scrubWouldChange } from "@/lib/public-task-text"

const createLimiter = createRateLimiter({ windowMs: 60_000, max: 5 })

const VALID_STATUSES: TaskStatus[] = [
  "open",
  "assigned",
  "submitted",
  "paid",
  "cancelled",
  "disputed",
  "refunded",
]

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)

    const status = searchParams.get("status") as TaskStatus | null
    if (status && !VALID_STATUSES.includes(status)) {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_STATUS", message: "Invalid status filter" } },
        { status: 400 },
      )
    }

    const projectParam = searchParams.get("project")
    const projectId = projectParam ? parseInt(projectParam) : undefined
    if (projectParam && isNaN(projectId!)) {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_PROJECT", message: "Invalid project filter" } },
        { status: 400 },
      )
    }

    const creatorId = searchParams.get("creator") ?? undefined
    const assigneeId = searchParams.get("assignee") ?? undefined

    // This route is deliberately unauthenticated (the public board must load
    // for a cold visitor), so a session is read but never required. Its ONLY
    // job here is deciding whether THIS caller may see their own soft-hidden,
    // stale/abandoned rows (see listTasks' includeHiddenStale doc) — `?creator=`
    // / `?assignee=` alone proves nothing, since anyone can put anyone else's
    // address in a query string. Only a verified session whose userId matches
    // the requested identity counts; `?creator=<other poster>` from a logged-out
    // (or logged-in-as-someone-else) visitor gets the same filtered view as the
    // public board. See db/queries/tasks.ts for what this gates.
    const sessionUser = await getSessionUser().catch(() => null)
    const includeHiddenStale =
      !!sessionUser && (sessionUser.userId === creatorId || sessionUser.userId === assigneeId)

    const result = await listTasks({
      status: status ?? undefined,
      creatorId,
      assigneeId,
      projectId,
      // Funded-on-chain filter (free): the same predicate the x402 paid endpoint
      // uses — onChainTaskId set, WHATEVER the status (claimed, submitted and
      // settled tasks included). Claimable-now work is `?status=open&funded=true`;
      // the OpenAPI description says so (2026-09-24). Semantics deliberately
      // unchanged: x402 and the board's "Funded only" rely on different sets.
      fundedOnly: searchParams.get("funded") === "true",
      cursor: searchParams.get("cursor") ?? undefined,
      limit: searchParams.has("limit") ? parseInt(searchParams.get("limit")!) : undefined,
      sort: (searchParams.get("sort") as "newest" | "reward" | "deadline") ?? undefined,
      // `|| undefined` rather than the bare boolean: listTasks treats
      // undefined and false identically (both keep the hide filter), and
      // omitting the false case keeps a session-less/non-owner call's filter
      // set identical in shape to one that never mentions this flag at all —
      // e.g. tests/unit/x402-paid-tier-boundary.test.ts diffs this route's
      // emitted filters against the paid x402 route's, which has no concept
      // of includeHiddenStale.
      includeHiddenStale: includeHiddenStale || undefined,
      // 2026-09-14 hardening: gates cancelled-row visibility, both under an
      // explicit `status=cancelled` filter on the default view AND
      // unconditionally on a `?project=` view (same param, same session
      // read — see the two conditions in listTasks). Reuses the SAME
      // sessionUser read as includeHiddenStale above, never a second lookup.
      viewerId: sessionUser?.userId,
    })

    return NextResponse.json({
      ok: true,
      // Public-text gate (2026-09-10 operator ruling): every row here may be
      // read by a viewer who isn't its poster (this route is unauthenticated
      // by design), so scrub deployment-internal text per row rather than
      // trusting the stored description — see src/lib/public-task-text.ts.
      // sessionUser is already read above for includeHiddenStale; reused
      // here as the SAME "who is asking" signal, never a second lookup.
      data: result.data.map((t) => publicTaskView(t, sessionUser?.userId)),
      cursor: result.cursor,
      hasMore: result.hasMore,
      // 2026-09-14, profile Archived-section follow-up to the archived-task
      // fix: say whether THIS response is the owner's view — i.e. whether the
      // includeHiddenStale check above actually matched a verified session to
      // the requested `?creator=` / `?assignee=` identity, so the rows include
      // that identity's own archived (cancelled) and soft-hidden stale rows.
      // False for an anonymous caller, a session for a different identity, a
      // session read that failed, AND for any call with no creator/assignee
      // filter at all (nothing to be the owner OF). Without it, a client that
      // believes it is the owner (wallet connected, address matches) but whose
      // httpOnly guild_session has lapsed gets the public, filtered view — and
      // an empty archive indistinguishable from genuinely having none. This is
      // the list-route twin of GET /api/v1/tasks/[id]'s ARCHIVED_SIGN_IN_REQUIRED.
      // Not an enumeration surface: it reports only whether the CALLER's own
      // session matched an identity the caller itself put in the query string,
      // both of which the caller already knows (GET /api/v1/auth/me). Read on
      // the client via resolveOwnerViewScope (src/lib/owner-view.ts).
      ownerView: includeHiddenStale,
    })
  } catch (err) {
    return fromError(err)
  }
}

export const POST = withAuth(async (req, { user }) => {
  // Halt gate FIRST: a task created during a halt can never be funded on-chain,
  // so the honest answer is to refuse rather than strand the poster with an
  // unfundable row. See src/lib/chain-halt-gate.ts for scope.
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

  const parsed = createTaskSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
      { status: 400 },
    )
  }

  // P3-24: refuse a title/description the public-text scrub (src/lib/public-task-text.ts)
  // would rewrite for anyone who isn't yet a party to the task — a claim candidate reads
  // the scrubbed open board, and (pre-#P3-24-fix) even a claimed task's assignee read
  // scrubbed text, so `submit_task` reverted on-chain with a brief-hash mismatch against
  // what the poster actually funded (task 90, 2026-09-15). Checked before any DB/project/
  // working-group lookup — a pure, cheap check that should fail fastest of all of them.
  const unstable = scrubWouldChange(parsed.data.title, parsed.data.description)
  if (unstable) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "SCRUB_UNSTABLE_TEXT",
          message:
            `The task ${unstable.field} contains ops-internal detail the public board would redact ` +
            `before a claim candidate or stranger reads it (near: "${unstable.fragment}"), which would ` +
            `commit an on-chain work-brief hash the scrubbed text can never reproduce — rewrite it without ` +
            `that detail.`,
        },
      },
      { status: 400 },
    )
  }

  // §22, extended to tasks 2026-09-19: refuse a banned claim BEFORE it is public and
  // before it is hashed into a funded work-brief. Runs on the parsed data. A quoted
  // mention is exempt — see src/lib/project-copy-gate.ts for why and what it costs.
  const bannedClaim = bannedTaskClaimIn(parsed.data)
  if (bannedClaim) return NextResponse.json(copyClaimError(bannedClaim), { status: 400 })

  // Any poster may file a task under any project (it's their reward being
  // escrowed) — commissioner-only curation is a projects-v2 question.
  if (parsed.data.project_id !== undefined) {
    const project = await findProjectById(parsed.data.project_id)
    if (!project) {
      return NextResponse.json(
        { ok: false, error: { code: "PROJECT_NOT_FOUND", message: "Project does not exist" } },
        { status: 404 },
      )
    }
  }

  // Working-group routing (Model A step 4). Same open stance as projects, and
  // for a stronger reason: a group decides whose FEED shows the task, nothing else
  // (no push notification is wired — see #382). It
  // confers no permission, gates no money, and does not enter the brief hash —
  // so requiring the poster to be a member would only stop them reaching the
  // people most likely to do the work. Membership is a subscription, not a
  // guild.
  //
  // Existence IS checked, fail-closed: an unknown or archived id would route
  // the task into a feed nobody reads, which looks identical to a task nobody
  // wants. 404 rather than silently dropping the field, so a mistyped id is
  // visible to the caller instead of becoming an invisible routing bug.
  if (parsed.data.working_group_id !== undefined) {
    const group = await findRoutableWorkingGroupById(parsed.data.working_group_id)
    if (!group) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "WORKING_GROUP_NOT_FOUND",
            message: "Working group does not exist or is no longer active",
          },
        },
        { status: 404 },
      )
    }
  }

  const task = await createTask({
    title: parsed.data.title,
    description: parsed.data.description,
    rewardXrd: parsed.data.reward_amount,
    // Platform-derived from the reward tier, never poster-set: the escrow
    // confirm core awards it to the assignee when the release lands.
    xpReward: getTierForReward(Number(parsed.data.reward_amount)).xpReward,
    creatorId: user.userId,
    deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : undefined,
    // Committed terms (validated strict above) — hashed into the v2 brief at
    // funding, so they're immutable once the task goes on-chain.
    terms: parsed.data.terms,
    projectId: parsed.data.project_id,
    workingGroupId: parsed.data.working_group_id,
  })

  return NextResponse.json({ ok: true, data: task }, { status: 201 })
})
