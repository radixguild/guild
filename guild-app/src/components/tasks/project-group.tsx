"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { TaskCard } from "@/components/tasks/task-card"
import { XrdAmount } from "@/components/XrdAmount"
import { firstSentence, doneWhenLine } from "@/lib/project-summary"
import { formatXrdUsdFromString } from "@/lib/format-xrd-usd"
import type { ProjectRollup } from "@/lib/group-tasks-by-project"
import type { Task } from "@/lib/marketplace-types"
import { isOpenAndFunded } from "@/lib/marketplace-utils"
import { PrivateRepoTaskNote } from "@/components/tasks/private-repo-note"
import { FolderKanban, Lock, Coins, ChevronDown, ChevronUp } from "lucide-react"

// Beyond this many tasks, a project's section collapses behind a "Show N
// more" control (task 89 acceptance: "collapsed beyond a handful per
// project"). 3 matches the grid's own sm:grid-cols-2 lg:grid-cols-3 — one
// full row is visible before anyone has to ask for more.
const VISIBLE_TASKS = 3

/** The XRD/USD display context TaskCard needs, threaded through unchanged
 *  from the /tasks page's single useXrdUsd() read — see TaskCard's own doc
 *  for why it can't read the hook itself. */
export interface UsdDisplayMeta {
  usdRate?: number | null
  usdStale?: boolean
  usdAgeSeconds?: number | null
  usdSource?: string | null
}

function FunnelCounts({ project }: { project: ProjectRollup }) {
  const columns = [
    { label: "Open", value: project.openCount },
    { label: "In progress", value: project.inProgressCount },
    { label: "Review", value: project.reviewCount },
    { label: "Paid", value: project.paidCount },
  ]
  return (
    <div className="grid grid-cols-4 gap-2 text-center">
      {columns.map((c) => (
        <div key={c.label} className="rounded-md bg-muted/50 px-1.5 py-1">
          <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{c.label}</div>
          <div className="font-mono text-sm font-semibold">{c.value}</div>
        </div>
      ))}
    </div>
  )
}

/** The collapsed/expandable task grid shared by a project's section and the
 *  Unassigned section — identical layout, the only difference is whether a
 *  project identity is passed down to TaskCard. */
function TaskGrid({
  tasks,
  project,
  usd,
}: {
  tasks: Task[]
  project: { name: string; slug: string } | null
  usd: UsdDisplayMeta
}) {
  const [expanded, setExpanded] = useState(false)

  if (tasks.length === 0) {
    return <p className="px-1 text-xs text-muted-foreground">No tasks filed here yet.</p>
  }

  const shown = expanded ? tasks : tasks.slice(0, VISIBLE_TASKS)
  const remaining = tasks.length - shown.length

  return (
    <div className="space-y-3">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            project={project}
            usdRate={usd.usdRate}
            usdStale={usd.usdStale}
            usdAgeSeconds={usd.usdAgeSeconds}
            usdSource={usd.usdSource}
          />
        ))}
      </div>
      {tasks.length > VISIBLE_TASKS && (
        <Button variant="outline" size="sm" onClick={() => setExpanded((e) => !e)}>
          {expanded ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" /> Show less
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" /> Show {remaining} more
            </>
          )}
        </Button>
      )}
    </div>
  )
}

/**
 * One project's card (name, pitch, definition-of-done, funnel, paid/escrowed
 * XRD — every non-money field read straight off the row `listProjectsWithProgress`
 * returns, per project.ts's own comment: a read-time rollup, never a cached
 * money column) followed by its tasks, collapsed beyond VISIBLE_TASKS.
 */
export function ProjectGroupSection({
  project,
  tasks,
  ...usd
}: { project: ProjectRollup; tasks: Task[] } & UsdDisplayMeta) {
  const pitch = firstSentence(project.description)
  const done = doneWhenLine(project.description)

  return (
    <section className="space-y-3" aria-label={project.name}>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Link href={`/projects/${project.slug}`} className="hover:underline">
                {project.name}
              </Link>
            </CardTitle>
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              {project.taskCount} task{project.taskCount === 1 ? "" : "s"}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {pitch && <p className="text-sm text-muted-foreground">{pitch}</p>}
          {done && <p className="text-xs italic text-muted-foreground">{done}</p>}
          <FunnelCounts project={project} />
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Lock className="h-3 w-3" />
              {formatXrdUsdFromString(project.lockedXrd, usd.usdRate ?? null, { mode: "compact" })} escrowed
            </span>
            <span className="inline-flex items-center gap-1">
              <Coins className="h-3 w-3" />
              {formatXrdUsdFromString(project.paidXrd, usd.usdRate ?? null, { mode: "compact" })} paid
            </span>
          </div>
        </CardContent>
      </Card>
      {/* No project prop here: every card in this grid already sits inside
          this project's own section (the header above links to it), so a
          per-card repeat of the same link would be redundant chrome AND a
          second link with the SAME accessible name in the same region —
          confirmed the hard way (tests/unit/tasks-page-projects-first.test.tsx
          originally failed getByRole('link', {name: project.name}) on
          "multiple elements found" for exactly this reason). TaskCard's
          project strip earns its place in the flat 'All tasks' view and the
          Unassigned group below, where a card has no other project context. */}
      <TaskGrid tasks={tasks} project={null} usd={usd} />
    </section>
  )
}

/** The trailing 'Unassigned' group — tasks with no `projectId`. Renders
 *  nothing when empty, so a fully-organized board doesn't end in a dangling
 *  empty heading. */
export function UnassignedTaskGroup({ tasks, ...usd }: { tasks: Task[] } & UsdDisplayMeta) {
  if (tasks.length === 0) return null
  return (
    <section className="space-y-3" aria-label="Unassigned">
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-base font-medium text-muted-foreground">Unassigned</h2>
        <span className="text-xs text-muted-foreground">
          {tasks.length} task{tasks.length === 1 ? "" : "s"} not filed under a project
        </span>
      </div>
      <TaskGrid tasks={tasks} project={null} usd={usd} />
    </section>
  )
}

/**
 * "Claimable now" — the open, FUNDED tasks, first on the board.
 *
 * Added 2026-09-20 after walking /tasks as a cold visitor. The board is
 * projects-first by ruling, and that stays; but the two tasks written for
 * newcomers (#99, #100) are filed under no project, so they rendered in the
 * trailing "Unassigned" group — below ten project cards, three of them empty.
 * Someone arriving from a shared link saw an empty marketplace and left before
 * reaching the only thing they could act on. This puts what is actionable first
 * and changes nothing below it.
 *
 * "Funded" is `onChainTaskId != null` — the same test the card's Funded badge
 * uses, and the Critical Rule: never present a task as claimable without a
 * funded escrow.
 */
export function ClaimableNowSection({ tasks, ...usd }: { tasks: Task[] } & UsdDisplayMeta) {
  const claimable = tasks.filter(isOpenAndFunded)
  if (claimable.length === 0) return null
  return (
    <section className="space-y-3" aria-label="Claimable now">
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-base font-medium">Claimable now</h2>
        <span className="text-xs text-muted-foreground">
          {claimable.length} open task{claimable.length === 1 ? "" : "s"} with the reward already in escrow
        </span>
      </div>
      {/* Compact rows, not cards: every one of these tasks also appears, as a full card,
          under its project (or Unassigned) below. This strip is a shortcut to them. */}
      <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
        {claimable.map((t) => (
          <li key={t.id}>
            <Link
              href={`/tasks/${t.id}`}
              // Stacked below `sm`: at 375px a single row gave the reward half the width and
              // cut the title to "Break the newcom…" — the one thing a newcomer needs to read.
              // The title wraps to two lines; the reward sits under it on a phone, beside it
              // from `sm` up.
              className="flex flex-col gap-1 px-4 py-2.5 text-sm hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
              data-testid="claimable-now-row"
            >
              <span className="min-w-0">
                <span className="block line-clamp-2 sm:line-clamp-1">
                  <span className="font-mono text-xs text-muted-foreground">#{t.id}</span>{" "}
                  {t.title}
                </span>
                {/* Claimable but not finishable from outside — see private-repo-note.tsx. */}
                <PrivateRepoTaskNote taskId={t.id} className="mt-0.5" />
              </span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {/* The SAME component the task card uses, so a reward reads the same
                    everywhere: XRD headline, muted ≈$ suffix, exact not compact, and no
                    dollar figure at all on a stale quote (R1; usd-pricing.spec.ts and
                    xrd-display-standard.test.ts). A first version used the dollar-first
                    rollup formatter and CI's browser tests caught it. */}
                <XrdAmount
                  amountXrd={t.rewardXrd}
                  unit={t.rewardResource ?? "XRD"}
                  usdRate={usd.usdRate}
                  stale={usd.usdStale}
                  ageSeconds={usd.usdAgeSeconds}
                  source={usd.usdSource}
                />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Projects with no tasks yet, folded away under one line. They are real and stay
 * on the board — a planned project is a commitment — but three empty cards in a
 * row ("0 tasks · US$0.00 escrowed · No tasks filed here yet") were the first
 * thing a newcomer saw.
 */
export function PlannedProjectsDisclosure({ groups, ...usd }: { groups: { project: ProjectRollup; tasks: Task[] }[] } & UsdDisplayMeta) {
  if (groups.length === 0) return null
  return (
    <details className="rounded-lg border border-border/60 px-4 py-3">
      <summary className="cursor-pointer text-sm text-muted-foreground">
        {groups.length} planned project{groups.length === 1 ? "" : "s"} with no tasks filed yet
      </summary>
      <div className="mt-4 space-y-8">
        {groups.map((g) => (
          <ProjectGroupSection key={g.project.id} project={g.project} tasks={g.tasks} {...usd} />
        ))}
      </div>
    </details>
  )
}

