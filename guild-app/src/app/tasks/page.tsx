"use client"

import { useState, useMemo, useEffect } from "react"
import Link from "next/link"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { TaskCard } from "@/components/tasks/task-card"
import { TaskFilters } from "@/components/tasks/task-filters"
import { ClaimableNowSection, PlannedProjectsDisclosure, ProjectGroupSection, UnassignedTaskGroup } from "@/components/tasks/project-group"
import { EmptyState } from "@/components/ui/empty-state"
import { apiFetch } from "@/lib/api-fetch"
import { useXrdUsd } from "@/lib/use-xrd-usd"
import { groupTasksByProject, type ProjectRollup } from "@/lib/group-tasks-by-project"
import type { Task } from "@/lib/marketplace-types"
import { isOpenAndFunded } from "@/lib/marketplace-utils"
import type { TaskStatus } from "@/lib/types"
import { Plus, ListTodo, AlertCircle, FolderKanban, LayoutGrid } from "lucide-react"
import { AppShell } from "@/components/app-shell"

// The projects-first board renders more than one project's worth of tasks
// on the page at once (each collapsed to a handful — see project-group.tsx),
// so 20 (the API's default page size, right for the flat "newest 20" view
// this replaced) would silently truncate whichever projects happen to sort
// past it. 100 is listTasks' own ceiling (src/db/queries/tasks.ts) — the
// whole board in one request, no pagination UI to build for a ~50-task
// catalogue.
const TASKS_FETCH_LIMIT = 100

type ViewMode = "projects" | "all"

function TasksContent() {
  // No auto-opening tour. Until 2026-09-20 `useAutoGuide("tasks")` opened a modal two
  // seconds after load, covering the board before a first-time visitor had read a line
  // of it — on a phone it took the whole screen. The tour is still one tap away, behind
  // the "?" in the header.
  const { rate: usdRate, stale: usdStale, ageSeconds: usdAgeSeconds, source: usdSource } = useXrdUsd()
  const usd = { usdRate, usdStale, usdAgeSeconds, usdSource }

  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [projects, setProjects] = useState<ProjectRollup[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)

  const [view, setView] = useState<ViewMode>("projects")

  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all")
  const [projectFilter, setProjectFilter] = useState<number | "unassigned" | "all">("all")
  const [fundedOnly, setFundedOnly] = useState(false)
  const [sortBy, setSortBy] = useState<"newest" | "reward" | "deadline">(
    "newest"
  )

  useEffect(() => {
    let cancelled = false
    apiFetch(`/api/v1/tasks?limit=${TASKS_FETCH_LIMIT}`)
      .then(async (res) => {
        const body = await res.json()
        if (!res.ok || !body.ok) {
          throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
        }
        return body.data as Task[]
      })
      .then((data) => {
        if (cancelled) return
        setTasks(
          data.map((t) => ({
            ...t,
            deadline: t.deadline ? new Date(t.deadline) : null,
            disputedAt: t.disputedAt ? new Date(t.disputedAt) : null,
            createdAt: new Date(t.createdAt),
            updatedAt: new Date(t.updatedAt),
          }))
        )
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? "Failed to load tasks")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    apiFetch("/api/v1/projects")
      .then(async (res) => {
        const body = await res.json()
        if (!res.ok || !body.ok) {
          throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
        }
        return body.data as ProjectRollup[]
      })
      .then((data) => {
        if (!cancelled) setProjects(data)
      })
      .catch((err) => {
        if (!cancelled) setProjectsError(err.message ?? "Failed to load projects")
      })
      .finally(() => {
        if (!cancelled) setProjectsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // task.projectId -> {name, slug}, for TaskCard's project strip in the flat
  // "All tasks" view (the grouped view already has the project in scope from
  // its own section). Built off the SAME rollup fetch as the project cards —
  // no second network round trip for what is otherwise a plain lookup.
  const projectById = useMemo(() => {
    const m = new Map<number, { name: string; slug: string }>()
    for (const p of projects) m.set(p.id, { name: p.name, slug: p.slug })
    return m
  }, [projects])

  const filteredTasks = useMemo(() => {
    let result = [...tasks]

    if (search) {
      const q = search.toLowerCase()
      result = result.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q)
      )
    }

    if (statusFilter !== "all") {
      result = result.filter((t) => t.status === statusFilter)
    }

    if (projectFilter === "unassigned") {
      result = result.filter((t) => t.projectId == null)
    } else if (projectFilter !== "all") {
      result = result.filter((t) => t.projectId === projectFilter)
    }

    if (fundedOnly) {
      // Open AND funded (2026-09-24): onChainTaskId stays set after a claim or
      // a payout, so the id alone kept paid and submitted tasks in "Funded only".
      result = result.filter(isOpenAndFunded)
    }

    switch (sortBy) {
      case "newest":
        result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        break
      case "reward":
        result.sort((a, b) => Number(b.rewardXrd) - Number(a.rewardXrd))
        break
      case "deadline":
        result.sort((a, b) => {
          if (!a.deadline) return 1
          if (!b.deadline) return -1
          return a.deadline.getTime() - b.deadline.getTime()
        })
        break
    }

    return result
  }, [tasks, search, statusFilter, projectFilter, fundedOnly, sortBy])

  const hasFilters =
    search.trim().length > 0 ||
    statusFilter !== "all" ||
    projectFilter !== "all" ||
    fundedOnly

  const grouped = useMemo(() => groupTasksByProject(tasks, projects), [tasks, projects])

  const projectsViewLoading = loading || projectsLoading
  const projectsViewError = error ?? projectsError
  const projectsViewEmpty =
    !projectsViewLoading && !projectsViewError && projects.length === 0 && grouped.unassigned.length === 0

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Tasks</h1>
          <p className="text-muted-foreground">
            Browse the board, grouped by project. Tasks marked Funded have their reward in escrow and can be claimed on-chain.{" "}
            <Link href="/lifecycle" className="text-primary hover:underline">
              How it works: post &rarr; claim &rarr; submit &rarr; approve
            </Link>
            .
          </p>
        </div>
        <Link href="/tasks/create" data-guide="tasks-create">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Create Task
          </Button>
        </Link>
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant={view === "projects" ? "default" : "outline"}
          onClick={() => setView("projects")}
        >
          <FolderKanban className="mr-1.5 h-3.5 w-3.5" /> Projects
        </Button>
        <Button
          type="button"
          size="sm"
          variant={view === "all" ? "default" : "outline"}
          onClick={() => setView("all")}
        >
          <LayoutGrid className="mr-1.5 h-3.5 w-3.5" /> All tasks
        </Button>
      </div>

      {view === "projects" ? (
        projectsViewLoading ? (
          <div className="space-y-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton
                key={i} className="h-56 rounded-lg border border-border/40 bg-muted/30" />
            ))}
          </div>
        ) : projectsViewError ? (
          <EmptyState
            icon={<AlertCircle />}
            title="Failed to load the board"
            description={projectsViewError}
          />
        ) : projectsViewEmpty ? (
          <EmptyState
            icon={<ListTodo />}
            title="Be the first to post a task"
            description="This board is ready for its first bounty. Post a task, fund it with escrow, and a guild worker can claim it on-chain."
            action={
              <Link href="/tasks/create">
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Post the first task
                </Button>
              </Link>
            }
          />
        ) : (
          <div className="space-y-8">
            {/* What a newcomer can act on comes first; the projects-first board follows
                unchanged, with the empty shells folded under one line at the end. */}
            <ClaimableNowSection tasks={tasks} {...usd} />
            {grouped.groups.filter((g) => g.project.taskCount > 0 || g.tasks.length > 0).map((g) => (
              <ProjectGroupSection key={g.project.id} project={g.project} tasks={g.tasks} {...usd} />
            ))}
            <UnassignedTaskGroup tasks={grouped.unassigned} {...usd} />
            <PlannedProjectsDisclosure
              groups={grouped.groups.filter((g) => g.project.taskCount === 0 && g.tasks.length === 0)}
              {...usd}
            />
          </div>
        )
      ) : (
        <>
          <TaskFilters
            search={search}
            onSearchChange={setSearch}
            statusFilter={statusFilter}
            onStatusChange={setStatusFilter}
            sortBy={sortBy}
            onSortChange={setSortBy}
            projects={projects}
            projectFilter={projectFilter}
            onProjectChange={setProjectFilter}
            fundedOnly={fundedOnly}
            onFundedChange={setFundedOnly}
          />

          {loading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton
                  key={i} className="h-40 rounded-lg border border-border/40 bg-muted/30" />
              ))}
            </div>
          ) : error ? (
            <EmptyState
              icon={<AlertCircle />}
              title="Failed to load tasks"
              description={error}
            />
          ) : filteredTasks.length === 0 ? (
            <EmptyState
              icon={<ListTodo />}
              title={hasFilters ? "No tasks match your filters" : "Be the first to post a task"}
              description={
                hasFilters
                  ? "Try adjusting your search or filters."
                  : "This board is ready for its first bounty. Post a task, fund it with escrow, and a guild worker can claim it on-chain."
              }
              action={
                <Link href="/tasks/create">
                  <Button variant={hasFilters ? "outline" : "default"}>
                    <Plus className="mr-2 h-4 w-4" />
                    {hasFilters ? "Create a task" : "Post the first task"}
                  </Button>
                </Link>
              }
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  project={task.projectId != null ? projectById.get(task.projectId) ?? null : null}
                  {...usd}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default function TasksPage() {
  return <AppShell><TasksContent /></AppShell>
}
