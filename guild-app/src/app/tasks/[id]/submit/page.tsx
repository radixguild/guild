"use client"

import { useState, use, useEffect } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty-state"
import { apiFetch } from "@/lib/api-fetch"
import { useWallet } from "@/hooks/useWallet"
import type { Task } from "@/lib/marketplace-types"
import { getStatusColor } from "@/lib/marketplace-utils"
import { formatXrdUsdFromString } from "@/lib/format-xrd-usd"
import { useXrdUsd } from "@/lib/use-xrd-usd"
import { AlertCircle, ArrowLeft, Send } from "lucide-react"
import { AppShell } from "@/components/app-shell"

interface SubmitPageProps {
  params: Promise<{ id: string }>
}

export default function SubmitPage({ params }: SubmitPageProps) {
  const { id } = use(params)
  // key={id} forces remount when the route param changes, so the inner
  // component's state resets to initial without setState-in-effect.
  return <AppShell><SubmitView id={id} key={id} /></AppShell>
}

function SubmitView({ id }: { id: string }) {
  const router = useRouter()
  const { rate: usdRate } = useXrdUsd()
  const { ensureSession, badge, badgeLoading } = useWallet()
  const [task, setTask] = useState<Task | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const [content, setContent] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    apiFetch(`/api/v1/tasks/${id}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (res.status === 404) {
          if (!cancelled) setMissing(true)
          return null
        }
        if (!res.ok || !body.ok) {
          throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
        }
        return body.data as Task
      })
      .then((data) => {
        if (cancelled || !data) return
        setTask(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? "Failed to load task")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [id])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!content.trim() || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      if (!(await ensureSession())) {
        setSubmitError("Approve the wallet signature to submit your work.")
        setSubmitting(false)
        return
      }
      const res = await apiFetch(`/api/v1/tasks/${id}/submissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: content.trim() }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.ok) {
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
      }
      router.push(`/tasks/${id}`)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Submission failed")
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-24 rounded bg-muted/30" />
        <Skeleton className="h-10 w-1/3 rounded bg-muted/30" />
        <Skeleton className="h-32 rounded-lg bg-muted/30" />
        <Skeleton className="h-64 rounded-lg bg-muted/30" />
      </div>
    )
  }

  if (missing) {
    return (
      <EmptyState
        icon={<AlertCircle />}
        title="Task not found"
        description={`No task with id ${id} exists.`}
        action={
          <Link href="/tasks">
            <Button variant="outline">Back to Tasks</Button>
          </Link>
        }
      />
    )
  }

  if (error || !task) {
    return (
      <EmptyState
        icon={<AlertCircle />}
        title="Failed to load task"
        description={error ?? "Unknown error"}
      />
    )
  }

  // Unfunded tasks are not claimable (Rule one: never claimable unless funded).
  // Guard the direct /submit URL the same way the detail page gates the button,
  // so the funding gate can't be bypassed by navigating here directly.
  if (task.onChainTaskId == null) {
    return (
      <EmptyState
        icon={<AlertCircle />}
        title="Not claimable yet"
        description="This task's on-chain escrow isn't funded, so it can't be claimed or submitted to. It becomes available once the poster funds the reward."
        action={
          <Link href={`/tasks/${task.id}`}>
            <Button variant="outline">Back to Task</Button>
          </Link>
        }
      />
    )
  }

  // Server enforces this too (fail-closed); the client gate is UX so a badgeless
  // wallet sees why submit is blocked instead of hitting a 403.
  const needsBadge = !badgeLoading && !badge

  return (
    <div className="space-y-6">
      <Link
        href={`/tasks/${task.id}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Task
      </Link>

      <div>
        <h1 className="text-2xl font-bold">Submit Work</h1>
        <p className="text-muted-foreground">
          Submit your deliverables for review.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">{task.title}</CardTitle>
            <Badge
              variant="secondary"
              className={getStatusColor(task.status)}
            >
              {task.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground line-clamp-2">
            {task.description}
          </p>
          <p className="mt-2 text-sm font-mono font-medium">
            Reward: {formatXrdUsdFromString(task.rewardXrd, usdRate, { unit: task.rewardResource ?? "XRD" })} &middot; +{task.xpReward} XP
          </p>
        </CardContent>
      </Card>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
              Your Submission
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="content">Description of work</Label>
              <Textarea
                id="content"
                placeholder="Describe what you completed and link to your PRs, commits, or docs…"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={8}
                required
              />
            </div>
            <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              Link to your deliverables in the description above — GitHub PRs,
              commits, deployed URLs, docs, or Figma. Reviewers open the links
              directly; that&apos;s everything they need to assess the work.
            </div>
            {submitError && (
              <p className="text-xs text-red-500" role="alert">
                {submitError}
              </p>
            )}
          </CardContent>
        </Card>

        {needsBadge && (
          <div
            className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
            role="alert"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>
              A Guild member badge is required to submit work.{" "}
              <Link href="/mint" className="font-medium underline">
                Mint one
              </Link>
              .
            </span>
          </div>
        )}

        <div className="flex justify-end gap-3">
          <Link href={`/tasks/${task.id}`}>
            <Button variant="outline" disabled={submitting}>
              Cancel
            </Button>
          </Link>
          <Button type="submit" disabled={!content.trim() || submitting || needsBadge}>
            <Send className="mr-2 h-4 w-4" />
            {submitting ? "Submitting…" : "Submit"}
          </Button>
        </div>
      </form>
    </div>
  )
}
