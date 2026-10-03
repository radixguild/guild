"use client"

import { use, useState, useEffect } from "react"
import Link from "next/link"
import { firstSentence, doneWhenLine } from "@/lib/project-summary"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty-state"
import { apiFetch } from "@/lib/api-fetch"
import { formatXrdUsd, formatXrdUsdFromString } from "@/lib/format-xrd-usd"
import { useXrdUsd } from "@/lib/use-xrd-usd"
import type { Task } from "@/lib/marketplace-types"
import { AppShell } from "@/components/app-shell"
import { ArrowLeft, Plus, AlertCircle, Lock, Coins } from "lucide-react"

// API tasks arrive JSON-serialized (timestamps as strings).
type ApiTask = Omit<Task, "createdAt" | "updatedAt" | "deadline"> & {
  createdAt: string
  updatedAt: string
  deadline: string | null
}

interface ProjectDetail {
  id: number
  name: string
  slug: string
  description: string
  commissionerId: string
  createdAt: string
  tasks: ApiTask[]
}

// The Dework-style delivery funnel (TASK-TERMS-DESIGN §5). Disputed tasks sit
// in the Submitted column with a flag — they're still awaiting resolution, not
// a separate stage. Cancelled/refunded fall out of the funnel (footnote below).
const COLUMNS = [
  { key: "open", title: "Open", statuses: ["open"] },
  { key: "claimed", title: "Claimed", statuses: ["assigned"] },
  { key: "submitted", title: "Submitted", statuses: ["submitted", "disputed"] },
  { key: "paid", title: "Paid", statuses: ["paid"] },
] as const

function FunnelCard({ task, usdRate }: { task: ApiTask; usdRate: number | null }) {
  return (
    <Link href={`/tasks/${task.id}`} className="no-underline">
      <div className="rounded-md border bg-card p-2.5 space-y-1.5 transition-colors hover:border-primary/60">
        <p className="text-xs font-medium leading-snug line-clamp-2">{task.title}</p>
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* A reward is actionable money, so it renders EXACT here exactly as it
              does on the task card and the task page. The local formatter this
              replaced abbreviated it (1500.5 -> "1.5k"), so the same reward read
              differently depending on which page you were looking at. */}
          <span className="font-mono text-[11px] text-primary">
            {formatXrdUsdFromString(task.rewardXrd, usdRate, { unit: task.rewardResource ?? "XRD" })}
          </span>
          {task.terms?.deliverableType && (
            <Badge variant="secondary" className="px-1 py-0 text-[9px] capitalize">
              {task.terms.deliverableType}
            </Badge>
          )}
          {task.status === "disputed" && (
            <Badge variant="secondary" className="bg-red-500/10 px-1 py-0 text-[9px] text-red-500">
              disputed
            </Badge>
          )}
        </div>
      </div>
    </Link>
  )
}

function ProjectContent({ slug }: { slug: string }) {
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Same rate source as the projects LIST page — this page previously had none,
  // so identical amounts carried a USD label there and not here.
  const { rate: usdRate } = useXrdUsd()

  useEffect(() => {
    let cancelled = false
    apiFetch(`/api/v1/projects/${slug}`)
      .then(async (res) => {
        const body = await res.json()
        if (!res.ok || !body.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
        return body.data as ProjectDetail
      })
      .then((data) => {
        if (!cancelled) setProject(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? "Failed to load project")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [slug])

  if (loading) {
    return <Skeleton className="h-64 rounded-lg border border-border/40 bg-muted/30" />
  }
  if (error || !project) {
    return (
      <EmptyState
        icon={<AlertCircle />}
        title="Failed to load project"
        description={error ?? "Project not found"}
      />
    )
  }

  const funnel = project.tasks.filter((t) => !["cancelled", "refunded"].includes(t.status))
  const closed = project.tasks.length - funnel.length
  const paidXrd = project.tasks
    .filter((t) => t.status === "paid")
    .reduce((sum, t) => sum + Number(t.rewardXrd), 0)
  const lockedXrd = project.tasks
    .filter((t) => t.onChainTaskId !== null && !["paid", "cancelled", "refunded"].includes(t.status))
    .reduce((sum, t) => sum + Number(t.rewardXrd), 0)

  return (
    <div className="space-y-6">
      <Link href="/projects" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> All projects
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">{project.name}</h1>
          {/* Same split as the card and the /tasks board: the pitch, then the
              definition of done if the description carries one. Never the raw
              description — its "Catalogue: N tasks · X XRD in rewards" clause
              is unfunded backlog, and this page renders the REAL locked/paid
              figures directly beneath it. */}
          {firstSentence(project.description) && (
            <p className="text-muted-foreground">{firstSentence(project.description)}</p>
          )}
          {doneWhenLine(project.description) && (
            <p className="text-sm text-muted-foreground">{doneWhenLine(project.description)}</p>
          )}
          <div className="flex gap-4 pt-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Lock className="h-3 w-3" /> {formatXrdUsd(lockedXrd, usdRate, { mode: "compact" })} locked
            </span>
            <span className="inline-flex items-center gap-1">
              <Coins className="h-3 w-3" /> {formatXrdUsd(paidXrd, usdRate, { mode: "compact" })} paid
            </span>
            <span className="font-mono">
              by {project.commissionerId.slice(0, 14)}…{project.commissionerId.slice(-4)}
            </span>
          </div>
        </div>
        <Link href={`/tasks/create?project=${project.id}`}>
          <Button size="sm">
            <Plus className="mr-1.5 h-4 w-4" /> Task
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {COLUMNS.map((col) => {
          const items = funnel.filter((t) =>
            (col.statuses as readonly string[]).includes(t.status),
          )
          return (
            <div key={col.key} className="space-y-2 rounded-lg border border-border/40 bg-muted/20 p-2.5">
              <div className="flex items-center justify-between px-0.5">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {col.title}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{items.length}</span>
              </div>
              {items.length === 0 ? (
                <p className="px-0.5 py-3 text-center text-[11px] text-muted-foreground/60">—</p>
              ) : (
                items.map((t) => <FunnelCard key={t.id} task={t} usdRate={usdRate} />)
              )}
            </div>
          )
        })}
      </div>

      {closed > 0 && (
        <p className="text-xs text-muted-foreground">
          {closed} closed task{closed === 1 ? "" : "s"} (cancelled or refunded) not shown in the funnel.
        </p>
      )}
    </div>
  )
}

export default function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params)
  return (
    <AppShell>
      <ProjectContent slug={slug} />
    </AppShell>
  )
}
