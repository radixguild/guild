"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Progress } from "@/components/ui/progress"
import { EmptyState } from "@/components/ui/empty-state"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { apiFetch } from "@/lib/api-fetch"
import { useWallet } from "@/hooks/useWallet"
import { firstSentence } from "@/lib/project-summary"
import { formatXrdUsdFromString } from "@/lib/format-xrd-usd"
import { useXrdUsd } from "@/lib/use-xrd-usd"
import { AppShell } from "@/components/app-shell"
import { FolderKanban, Plus, AlertCircle, Lock, Coins } from "lucide-react"

// Shape returned by GET /api/v1/projects (project row + funnel rollup).
interface ProjectSummary {
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
}

function NewProjectDialog({ onCreated }: { onCreated: (slug: string) => void }) {
  const { ensureSession } = useWallet()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = async () => {
    setSubmitting(true)
    setError(null)
    try {
      if (!(await ensureSession())) {
        setError("Approve the wallet signature to create a project.")
        return
      }
      const res = await apiFetch("/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: description || undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
      setOpen(false)
      onCreated(data.data.slug)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Reset on CLOSE, not on open: a dialog that reopens holding the last
        // attempt's name, description and error reads as if the app had saved
        // a draft it has not saved. Nothing here survives a close.
        if (!next) {
          setName("")
          setDescription("")
          setError(null)
        }
      }}
    >
      <DialogTrigger render={<Button />}>
        <Plus className="mr-2 h-4 w-4" />
        New Project
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="project-name">Name</Label>
            <Input id="project-name" placeholder="e.g. Wallet Upgrade" value={name}
              onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-description">Description (optional)</Label>
            <Textarea id="project-description" rows={3}
              placeholder="What this project delivers, in a sentence or two."
              value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          <Button className="w-full" onClick={handleCreate}
            disabled={submitting || name.trim().length < 3}>
            {submitting ? "Creating…" : "Create project"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ProjectsContent() {
  const router = useRouter()
  const { rate: usdRate } = useXrdUsd()
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    apiFetch("/api/v1/projects")
      .then(async (res) => {
        const body = await res.json()
        if (!res.ok || !body.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
        return body.data as ProjectSummary[]
      })
      .then((data) => {
        if (!cancelled) setProjects(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? "Failed to load projects")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-muted-foreground">
            Group related tasks and track delivery end to end.
          </p>
        </div>
        <NewProjectDialog onCreated={(slug) => router.push(`/projects/${slug}`)} />
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-lg border border-border/40 bg-muted/30" />
          ))}
        </div>
      ) : error ? (
        <EmptyState icon={<AlertCircle />} title="Failed to load projects" description={error} />
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban />}
          title="No projects yet"
          description="Projects bundle related tasks — like a milestone board for one bigger goal."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {projects.map((p) => {
            const pct = p.taskCount > 0 ? Math.round((p.paidCount / p.taskCount) * 100) : 0
            return (
              <Link key={p.id} href={`/projects/${p.slug}`} className="no-underline">
                <Card className="h-full transition-colors hover:border-primary/60">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <FolderKanban className="h-4 w-4 text-muted-foreground" />
                      {p.name}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {/* The PITCH only. A live project's description follows the
                        convention "<pitch>. — Catalogue: N tasks · X XRD in
                        rewards (...). — Done when: ..." and that Catalogue
                        clause is UNFUNDED BACKLOG typed at creation — it summed
                        to 195,200 XRD across these cards while 22,900 XRD was
                        actually paid+locked, rendered inches from the real
                        figures below. Two numbers on one card computed on
                        different bases, with nothing saying so. firstSentence
                        drops it; the real money stays. */}
                    {firstSentence(p.description) && (
                      <p className="text-sm text-muted-foreground line-clamp-2">{firstSentence(p.description)}</p>
                    )}
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>
                          {p.paidCount} of {p.taskCount} task{p.taskCount === 1 ? "" : "s"} released
                        </span>
                        <span>{pct}%</span>
                      </div>
                      <Progress
                        value={pct}
                        className="h-1.5"
                        aria-label={`${p.name}: ${pct}% funded`}
                      />
                    </div>
                    <div className="flex gap-4 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Lock className="h-3 w-3" /> {formatXrdUsdFromString(p.lockedXrd, usdRate, { mode: "compact" })} locked
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Coins className="h-3 w-3" /> {formatXrdUsdFromString(p.paidXrd, usdRate, { mode: "compact" })} paid
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function ProjectsPage() {
  return (
    <AppShell>
      <ProjectsContent />
    </AppShell>
  )
}
