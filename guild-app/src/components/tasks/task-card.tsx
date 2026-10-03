import Link from "next/link"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CountdownChip } from "@/components/tasks/countdown-chip"
import type { Task } from "@/lib/marketplace-types"
import { formatAddress, getStatusColor, isOpenAndFunded } from "@/lib/marketplace-utils"
import { XrdAmount } from "@/components/XrdAmount"
import { Calendar, Coins, User, ShieldCheck, AlertCircle, FolderKanban } from "lucide-react"

/** The minimal project identity a card needs to show and link its project —
 *  looked up by the caller (task.projectId -> this) from whatever project
 *  list it already has in scope, e.g. the /tasks board's rollup fetch. Not
 *  the full ProjectRollup: a card has no use for funnel/money fields. */
interface TaskCardProject {
  name: string
  slug: string
}

interface TaskCardProps {
  task: Task
  /**
   * XRD→USD rate for the dual-label, plus the staleness fields <XrdAmount>
   * needs to decide whether to show it at all. TaskCard renders without
   * "use client", so all of these must be passed in by the parent (the tasks
   * list reads useXrdUsd() and passes them down) — never read the hook here.
   * Null/omitted fails open to the XRD-only label.
   */
  usdRate?: number | null
  usdStale?: boolean
  usdAgeSeconds?: number | null
  usdSource?: string | null
  /** task.projectId resolved to a name/slug, when the task has a project —
   *  omitted/null renders the card exactly as before (no project strip). */
  project?: TaskCardProject | null
}

export function TaskCard({ task, usdRate, usdStale, usdAgeSeconds, usdSource, project }: TaskCardProps) {
  return (
    // Two SIBLING links, not a nested one: the project strip below is its own
    // <Link> to /projects/[slug], and nesting an <a> inside the card's own
    // <a href="/tasks/[id]"> would be invalid HTML (and unclickable in most
    // browsers). Grouped in one div so the pair still reads as one card.
    <div>
      <Link href={`/tasks/${task.id}`} className="block no-underline">
        <Card className={`transition-colors hover:bg-muted/50 ${project ? "rounded-b-none" : ""}`}>
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="line-clamp-1 text-sm font-semibold">
                <span className="mr-1.5 font-mono font-normal text-muted-foreground">#{task.id}</span>
                {task.title}
              </CardTitle>
              <Badge
                variant="secondary"
                className={getStatusColor(task.status)}
              >
                {task.status}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {task.description}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Coins className="h-3.5 w-3.5" />
                <XrdAmount
                  amountXrd={task.rewardXrd}
                  unit={task.rewardResource ?? "XRD"}
                  usdRate={usdRate}
                  stale={usdStale}
                  ageSeconds={usdAgeSeconds}
                  source={usdSource}
                />
              </span>
              <span className="flex items-center gap-1">
                <User className="h-3.5 w-3.5" />
                {formatAddress(task.creatorId)}
              </span>
              {task.deadline && (
                <span className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" />
                  {task.deadline.toLocaleDateString()}
                </span>
              )}
            </div>
          </CardContent>
          <CardFooter className="flex-wrap gap-2">
            {/* Funding signal — Rule one: a task is only claimable once its
                on-chain escrow is funded (onChainTaskId set). OPEN tasks only
                (2026-09-24): "Funded" is the /tasks intro's promise that the
                reward is in escrow AND the task can be claimed. onChainTaskId
                stays set for the task's whole life, so a paid or submitted card
                also read "Funded" — money long gone, or claimed by someone
                else. The status badge above already says where those stand. */}
            {task.status === "open" &&
              (isOpenAndFunded(task) ? (
                <Badge variant="outline" className="gap-1 border-emerald-500/40 text-[10px] text-emerald-600 dark:text-emerald-500">
                  <ShieldCheck className="h-3 w-3" /> Funded
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-500">
                  <AlertCircle className="h-3 w-3" /> Unfunded
                </Badge>
              ))}
            <CountdownChip
              status={task.status}
              deadline={task.deadline}
              disputedAt={task.disputedAt}
              updatedAt={task.updatedAt}
              className="text-[10px]"
            />
            {/* No tier chip. `tasks.required_tier` is a column DEFAULT ('member'), not in
                createTaskSchema, and read by nothing on claim — so "member+ tier" sat on
                every card (53 of 53 live rows, 2026-09-19) implying a tier ladder that gates
                claiming. Nothing does; the only tier gate is the ledger-derived trust tier a
                poster sets in terms. See the tier-gating rule in scripts/honest-copy.mjs. */}
            <span className="text-[10px] text-muted-foreground">
              +{task.xpReward} XP
            </span>
          </CardFooter>
        </Card>
      </Link>
      {project && (
        <Link
          href={`/projects/${project.slug}`}
          className="flex items-center gap-1.5 rounded-b-xl border border-t-0 border-border/40 bg-muted/20 px-4 py-1.5 text-[11px] text-muted-foreground no-underline transition-colors hover:bg-muted/50 hover:text-primary"
        >
          <FolderKanban className="h-3 w-3" />
          {project.name}
        </Link>
      )}
    </div>
  )
}
