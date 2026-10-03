import Link from "next/link"
import { notFound } from "next/navigation"
import { AppShell } from "@/components/app-shell"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { getSessionUser } from "@/lib/auth"
import {
  getWorkingGroupBySlug,
  listGroupsFeed,
  type WorkingGroupSummary,
} from "@/db/queries/working-groups"
import { ArrowLeft, Users, ListTodo, ListChecks } from "lucide-react"

// /groups/[slug] — the detail route the catalog page (`/groups/page.tsx`) never
// had: that page lists every group as a card and previews a *selection* of
// groups' feeds inline, but there was no stable, linkable URL for ONE group.
// Minimal by design (scaled-MVP item 2, Rulings Board N2): a real React Server
// Component reading Postgres directly through the SAME query helpers the
// catalog and browse routes already use (`getWorkingGroupBySlug`,
// `listGroupsFeed`) — no new API route, no client fetch, styled like
// /projects/[slug] and /ledger (dark shadcn density, Card + Badge, funnel-style
// stat row up top).
//
// `getWorkingGroupBySlug` resolves ARCHIVED groups too (see its own docblock:
// "their existing feed is still worth previewing"), so an archived group's
// page still renders here — just carrying an "Archived" badge — rather than
// 404ing. 404 is reserved for a slug that resolves to no group at all, the
// same distinction `/projects/[slug]`'s API route draws.
//
// Deliberately NOT reimplementing join/leave/level-cycling here: that
// mutation UI already lives on `/groups` and duplicating it risks the two
// copies drifting (this repo's own documented failure mode — see
// src/lib/agent-lane.ts). This page links back there to manage membership.

type FeedTask = Awaited<ReturnType<typeof listGroupsFeed>>["data"][number]

function TaskRow({ task }: { task: FeedTask }) {
  return (
    <Link
      href={`/tasks/${task.id}`}
      className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-xs transition-colors hover:border-primary/60"
    >
      {/* truncate alone does nothing here — overflow:hidden cannot ellipsize a
          flex item that will not shrink. min-w-0 is what makes it work. */}
      <span className="min-w-0 truncate">{task.title}</span>
      <span className="shrink-0 font-mono text-muted-foreground">
        {Number(task.rewardXrd) > 0 ? `${Number(task.rewardXrd)} XRD` : task.status}
      </span>
    </Link>
  )
}

function GroupDetailView({ group, tasks }: { group: WorkingGroupSummary; tasks: FeedTask[] }) {
  return (
    <div className="space-y-6">
      <Link
        href="/groups"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> All groups
      </Link>

      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold">{group.name}</h1>
          {!group.isActive && (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              Archived
            </Badge>
          )}
        </div>
        {group.description && <p className="text-muted-foreground">{group.description}</p>}
        <div className="flex flex-wrap gap-4 pt-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Users className="h-3 w-3" /> {group.memberCount} member{group.memberCount === 1 ? "" : "s"}
          </span>
          <span className="inline-flex items-center gap-1">
            <ListTodo className="h-3 w-3" /> {group.openTaskCount} open
          </span>
          {group.viewerLevel !== null && (
            <span className="capitalize">You: {group.viewerLevel}</span>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="space-y-2 pb-4 pt-4">
          <div className="flex items-center justify-between px-0.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Recent work
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">{tasks.length}</span>
          </div>
          {tasks.length === 0 ? (
            <EmptyState
              icon={<ListChecks />}
              title="No tasks yet"
              description="Nothing has been routed to this group so far."
            />
          ) : (
            <div className="space-y-1.5">
              {tasks.map((t) => (
                <TaskRow key={t.id} task={t} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Manage your membership and notification level on{" "}
        <Link href="/groups" className="text-primary hover:underline">
          Working Groups
        </Link>
        .
      </p>
    </div>
  )
}

export default async function GroupPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const viewer = await getSessionUser()
  const group = await getWorkingGroupBySlug(slug, viewer?.userId)
  if (!group) notFound()

  const { data: tasks } = await listGroupsFeed([group.id], { limit: 30 })

  return (
    <AppShell>
      <GroupDetailView group={group} tasks={tasks} />
    </AppShell>
  )
}
