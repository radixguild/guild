import { describe, it, expect } from "vitest"
import { groupTasksByProject, type ProjectRollup } from "@/lib/group-tasks-by-project"
import type { Task } from "@/lib/marketplace-types"

/**
 * groupTasksByProject — the pure bucketing behind the /tasks projects-first
 * board (task 89). Pinned directly against the acceptance line: "a task with
 * no project lands in Unassigned".
 */

function makeProject(over: Partial<ProjectRollup> = {}): ProjectRollup {
  return {
    id: 1,
    name: "P",
    slug: "p",
    description: "",
    commissionerId: "bob",
    createdAt: "2026-09-15T00:00:00Z",
    taskCount: 0,
    paidCount: 0,
    paidXrd: "0",
    lockedXrd: "0",
    openCount: 0,
    inProgressCount: 0,
    reviewCount: 0,
    ...over,
  }
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "t",
    description: "d",
    status: "open",
    rewardXrd: "10",
    creatorId: "bob",
    xpReward: 0,
    requiredTier: null,
    onChainTaskId: null,
    deadline: null,
    disputedAt: null,
    projectId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as unknown as Task
}

describe("groupTasksByProject", () => {
  it("a task with no project (projectId null) lands in unassigned", () => {
    const project = makeProject({ id: 1 })
    const task = makeTask({ id: 10, projectId: null })
    const { groups, unassigned } = groupTasksByProject([task], [project])
    expect(unassigned).toEqual([task])
    expect(groups[0].tasks).toEqual([])
  })

  it("buckets a task under the project matching its projectId", () => {
    const p1 = makeProject({ id: 1, slug: "p1" })
    const p2 = makeProject({ id: 2, slug: "p2" })
    const t1 = makeTask({ id: 10, projectId: 1 })
    const t2 = makeTask({ id: 11, projectId: 2 })
    const { groups } = groupTasksByProject([t1, t2], [p1, p2])
    expect(groups.find((g) => g.project.slug === "p1")!.tasks).toEqual([t1])
    expect(groups.find((g) => g.project.slug === "p2")!.tasks).toEqual([t2])
  })

  it("keeps insertion order of tasks within a project's bucket", () => {
    const p = makeProject({ id: 1 })
    const a = makeTask({ id: 1, projectId: 1 })
    const b = makeTask({ id: 2, projectId: 1 })
    const c = makeTask({ id: 3, projectId: 1 })
    const { groups } = groupTasksByProject([a, b, c], [p])
    expect(groups[0].tasks.map((t) => t.id)).toEqual([1, 2, 3])
  })

  it("includes every project as a group even with zero tasks, in the given order", () => {
    const p1 = makeProject({ id: 1, slug: "p1" })
    const p2 = makeProject({ id: 2, slug: "p2" })
    const { groups } = groupTasksByProject([], [p1, p2])
    expect(groups.map((g) => g.project.slug)).toEqual(["p1", "p2"])
    expect(groups.every((g) => g.tasks.length === 0)).toBe(true)
  })

  it("a task pointing at a project id absent from the rollup falls back to unassigned rather than vanishing", () => {
    const p = makeProject({ id: 1 })
    const orphan = makeTask({ id: 99, projectId: 404 })
    const { groups, unassigned } = groupTasksByProject([orphan], [p])
    expect(unassigned).toEqual([orphan])
    expect(groups[0].tasks).toEqual([])
  })

  it("with no projects at all, every task is unassigned", () => {
    const a = makeTask({ id: 1, projectId: null })
    const b = makeTask({ id: 2, projectId: null })
    const { groups, unassigned } = groupTasksByProject([a, b], [])
    expect(groups).toEqual([])
    expect(unassigned).toEqual([a, b])
  })
})
