import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { findSubmissionById, setSubmissionPrVerification } from "@/db/queries/submissions"
import { findTaskById } from "@/db/queries/tasks"
import { extractPrUrl, prMatchesRepo, fetchPrVerification } from "@/lib/pr-verify"
import { fromError } from "@/lib/api-response"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"

// GitHub round-trips are the expensive part; 10/min per user is plenty for a
// human clicking re-verify and stingy enough for an agent loop gone wrong.
const verifyLimiter = createRateLimiter({ windowMs: 60_000, max: 10 })

// POST /api/v1/submissions/[id]/verify-pr — check the submission's linked PR
// against the task's committed terms and store the verdict on the row.
// v1 is on-demand (button / agent call); the keeper-cron variant that watches
// merge events is deferred to the signing-custody decision.
export const POST = withAuth(async (_req, { params, user }) => {
  try {
    const { id } = await params
    const submissionId = parseInt(id)
    if (isNaN(submissionId)) {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_ID", message: "Invalid submission ID" } },
        { status: 400 },
      )
    }

    const submission = await findSubmissionById(submissionId)
    if (!submission) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "Submission not found" } },
        { status: 404 },
      )
    }

    const task = await findTaskById(submission.taskId)
    if (!task) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "Task not found" } },
        { status: 404 },
      )
    }

    // Same privacy boundary as the submissions list: poster + submitter.
    if (user.userId !== task.creatorId && user.userId !== submission.submitterId) {
      return NextResponse.json(
        { ok: false, error: { code: "FORBIDDEN", message: "Only the task creator or submitter can verify" } },
        { status: 403 },
      )
    }

    const limit = verifyLimiter(user.userId)
    if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

    const ref = extractPrUrl(submission.content)
    if (!ref) {
      return NextResponse.json(
        { ok: false, error: { code: "NO_PR_URL", message: "No GitHub PR link found in the submission" } },
        { status: 422 },
      )
    }

    // The repo pin: a PR outside the repo the brief committed to proves
    // nothing about this task's work.
    if (task.terms?.repoUrl && !prMatchesRepo(ref, task.terms.repoUrl)) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "PR_REPO_MISMATCH",
            message: `PR is not in the task's committed repository (${task.terms.repoUrl})`,
          },
        },
        { status: 422 },
      )
    }

    let verification
    try {
      verification = await fetchPrVerification(ref, task.terms?.definitionOfDone)
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "GITHUB_UNREACHABLE",
            message: err instanceof Error ? err.message : "GitHub API request failed",
          },
        },
        { status: 502 },
      )
    }

    const updated = await setSubmissionPrVerification(submissionId, verification)
    return NextResponse.json({ ok: true, data: updated })
  } catch (err) {
    return fromError(err)
  }
})
