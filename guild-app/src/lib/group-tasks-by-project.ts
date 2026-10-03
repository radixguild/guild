import type { Task } from "./marketplace-types"

/**
 * The shape GET /api/v1/projects returns per row — the read-time
 * money/funnel rollup from `listProjectsWithProgress` (src/db/queries/projects.ts),
 * never a cached column. Declared here (not derived from the Drizzle schema,
 * unlike `Task`) because it is a SELECT projection, not a table.
 */
export interface ProjectRollup {
  id: number
  name: string
  slug: string
  description: string
  commissionerId: string
  createdAt: string
  taskCount: number
  paidCount: number
  paidXrd: string
  lockedXrd: string
  openCount: number
  inProgressCount: number
  reviewCount: number
}

export interface ProjectTaskGroup {
  project: ProjectRollup
  tasks: Task[]
}

export interface GroupedTasks {
  /** One entry per project in `projects`, in the SAME order, whether or not
   *  it has any tasks in `tasks` — a project is a real thing on the board
   *  the moment it exists, not only once work is filed under it. */
  groups: ProjectTaskGroup[]
  /** Tasks whose `projectId` is null — rendered as the trailing 'Unassigned'
   *  group per task 89's acceptance criteria. */
  unassigned: Task[]
}

/**
 * Buckets a flat task list under the projects that own them, for the /tasks
 * projects-first board. Pure and side-effect-free — no fetch, no DB — so the
 * grouping logic is testable independent of both the rollup query and the
 * page's data fetching.
 *
 * A task whose `projectId` does not match ANY row in `projects` (a project
 * deleted after the task was filed under it — the schema allows this today,
 * there is no ON DELETE behavior declared on tasks.project_id) falls back to
 * `unassigned` rather than being silently dropped: an orphaned task must
 * still be reachable somewhere on the board.
 */
export function groupTasksByProject(tasks: Task[], projects: ProjectRollup[]): GroupedTasks {
  const byProjectId = new Map<number, Task[]>()
  const knownProjectIds = new Set(projects.map((p) => p.id))
  const unassigned: Task[] = []

  for (const task of tasks) {
    if (task.projectId == null || !knownProjectIds.has(task.projectId)) {
      unassigned.push(task)
      continue
    }
    const bucket = byProjectId.get(task.projectId)
    if (bucket) bucket.push(task)
    else byProjectId.set(task.projectId, [task])
  }

  const groups: ProjectTaskGroup[] = projects.map((project) => ({
    project,
    tasks: byProjectId.get(project.id) ?? [],
  }))

  return { groups, unassigned }
}
