import { eq, and, count, desc } from "drizzle-orm"
import { db } from "@/db"
import { submissions, tasks } from "@/db/schema"
import type { DeclineReason } from "@/db/schema/submissions"
import type { PrVerification } from "@/lib/pr-verify"

export async function listSubmissionsByTask(taskId: number) {
  return db.select().from(submissions).where(eq(submissions.taskId, taskId))
}

export async function findSubmissionById(id: number) {
  return (await db.query.submissions.findFirst({ where: eq(submissions.id, id) })) ?? null
}

export async function createSubmission(data: typeof submissions.$inferInsert) {
  const [submission] = await db
    .insert(submissions)
    .values(data)
    .returning()
  return submission
}

export type ReviewDecision = {
  status: "approved" | "rejected" | "revision_requested"
  reviewNote?: string
  declineReason?: DeclineReason
}

export type ReviewDecisionResult =
  | { ok: true; submission: typeof submissions.$inferSelect }
  | { ok: false; code: "ALREADY_REVIEWED" | "TASK_NOT_SUBMITTED"; taskStatus?: string }

// The submission decision write, made race-proof in one transaction:
//   1. the task row is re-read FOR UPDATE — an escrow confirm advancing the
//      same task (dispute/approve/cancel) holds that row lock, so the review
//      either sees the pre-transition `submitted` or 409s on the new status,
//      never a stale in-memory snapshot (the R3.3 submit/review race);
//   2. the decision UPDATE carries a `status = 'pending'` predicate — one
//      decision per row, so a second review of an already-decided submission
//      matches 0 rows instead of silently overwriting the first (R3-b). The
//      revision loop re-reviews the NEW row the worker's resubmit created.
// `revision_requested` is stored as itself — the old mapping to `pending`
// made revised-away rows indistinguishable from unreviewed ones.
export async function reviewSubmission(
  id: number,
  taskId: number,
  reviewerId: string,
  decision: ReviewDecision,
): Promise<ReviewDecisionResult> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .for("update")
    if (!task || task.status !== "submitted") {
      return { ok: false, code: "TASK_NOT_SUBMITTED", taskStatus: task?.status }
    }
    const rejected = decision.status === "rejected"
    const [submission] = await tx
      .update(submissions)
      .set({
        status: decision.status,
        reviewerId,
        reviewNote: decision.reviewNote ?? null,
        approvedAt: decision.status === "approved" ? new Date() : null,
        declineReason: rejected ? (decision.declineReason ?? null) : null,
        declinedAt: rejected ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(submissions.id, id), eq(submissions.status, "pending")))
      .returning()
    if (!submission) return { ok: false, code: "ALREADY_REVIEWED" }
    return { ok: true, submission }
  })
}

// Latest attempt by this submitter on this task — the resubmit gate reads it:
// a worker may post a new attempt on a `submitted` task only while their
// previous one sits in `revision_requested`.
export async function findLatestSubmissionByTaskAndUser(taskId: number, submitterId: string) {
  const [row] = await db
    .select()
    .from(submissions)
    .where(and(eq(submissions.taskId, taskId), eq(submissions.submitterId, submitterId)))
    .orderBy(desc(submissions.id))
    .limit(1)
  return row ?? null
}

export async function setSubmissionPrVerification(id: number, verification: PrVerification) {
  const [submission] = await db
    .update(submissions)
    .set({ prVerification: verification, updatedAt: new Date() })
    .where(eq(submissions.id, id))
    .returning()
  return submission
}

export async function countSubmissionsByTask(taskId: number) {
  const [result] = await db
    .select({ count: count() })
    .from(submissions)
    .where(eq(submissions.taskId, taskId))
  return result?.count ?? 0
}
