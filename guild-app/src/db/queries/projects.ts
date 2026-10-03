import { eq, desc, sql } from "drizzle-orm"
import { db } from "@/db"
import { projects, tasks } from "@/db/schema"

// Slug = URL identity for /projects/[slug]. Lowercase kebab, trimmed to 60
// chars; collisions get a numeric suffix at create time (slug-2, slug-3, …).
export function slugifyProjectName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "project"
  )
}

// Funnel + money rollup per project card (TASK-TERMS-DESIGN §5: "n of m tasks
// released, total XRD locked/paid"). "Locked" is honest escrow language: only
// tasks that actually went on-chain (on_chain_task_id set) and aren't settled
// count; "paid" is the released terminal state.
//
// openCount/inProgressCount/reviewCount (added for the /tasks projects-first
// board, task 89): the SAME four-column delivery funnel the /projects/[slug]
// kanban already renders client-side (COLUMNS in
// src/app/projects/[slug]/page.tsx: open, claimed=assigned,
// submitted=submitted+disputed, paid) — computed here instead so the
// /tasks board's project cards can show funnel counts without fetching every
// task in every project. A disputed task counts as "review", not a fifth
// bucket: it is still awaiting resolution at the Submitted stage, not a
// separate stage (same rationale as the kanban's own COLUMNS comment).
// Cancelled/refunded tasks count toward taskCount but no funnel column, same
// as the kanban's "closed, not shown in the funnel" footnote.
const PROGRESS_COLUMNS = {
  taskCount: sql<number>`count(${tasks.id})::int`,
  paidCount: sql<number>`count(${tasks.id}) filter (where ${tasks.status} = 'paid')::int`,
  paidXrd: sql<string>`coalesce(sum(${tasks.rewardXrd}) filter (where ${tasks.status} = 'paid'), 0)::text`,
  lockedXrd: sql<string>`coalesce(sum(${tasks.rewardXrd}) filter (where ${tasks.onChainTaskId} is not null and ${tasks.status} not in ('paid', 'cancelled', 'refunded')), 0)::text`,
  openCount: sql<number>`count(${tasks.id}) filter (where ${tasks.status} = 'open')::int`,
  inProgressCount: sql<number>`count(${tasks.id}) filter (where ${tasks.status} = 'assigned')::int`,
  reviewCount: sql<number>`count(${tasks.id}) filter (where ${tasks.status} in ('submitted', 'disputed'))::int`,
}

export async function listProjectsWithProgress() {
  return db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      description: projects.description,
      commissionerId: projects.commissionerId,
      createdAt: projects.createdAt,
      ...PROGRESS_COLUMNS,
    })
    .from(projects)
    .leftJoin(tasks, eq(tasks.projectId, projects.id))
    .groupBy(projects.id)
    .orderBy(desc(projects.createdAt))
}

export async function findProjectBySlug(slug: string) {
  return (await db.query.projects.findFirst({ where: eq(projects.slug, slug) })) ?? null
}

export async function findProjectById(id: number) {
  return (await db.query.projects.findFirst({ where: eq(projects.id, id) })) ?? null
}

// The first and only UPDATE path on this table. The schema comment on
// `updatedAt` calls this out explicitly: the column's defaultNow() fires on
// INSERT only, so an edit MUST set updatedAt itself or the row will claim it was
// last touched at creation forever. Matches tasks.ts / users.ts.
//
// `slug` is not settable here on purpose — see updateProjectSchema.
export async function updateProject(
  id: number,
  data: { name?: string; description?: string },
) {
  const [project] = await db
    .update(projects)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(projects.id, id))
    .returning()
  return project ?? null
}

export async function createProject(data: {
  name: string
  description?: string
  commissionerId: string
}) {
  const base = slugifyProjectName(data.name)
  // Race-safe enough for a human-paced create flow: the unique index is the
  // real guard, the retry loop just picks the next free suffix.
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`
    try {
      const [project] = await db
        .insert(projects)
        .values({
          name: data.name,
          slug,
          description: data.description ?? "",
          commissionerId: data.commissionerId,
        })
        .returning()
      return project
    } catch (err) {
      // drizzle-orm >=0.44 wraps driver errors in DrizzleQueryError; the
      // `postgres` driver's own error (with `.code`) is one level down at
      // `.cause`, not on the caught error itself — see the same fix in
      // captureEscrowIdIfUnset (src/db/queries/tasks.ts) for the full story.
      const cause = (err as { cause?: unknown })?.cause
      const code = ((cause ?? err) as { code?: string })?.code
      if (code !== "23505") throw err // not a unique violation — surface it
    }
  }
  throw new Error(`Could not find a free slug for project name "${data.name}"`)
}
