"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Bell } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { useWallet } from "@/hooks/useWallet"
import { apiFetch } from "@/lib/api-fetch"
import { isEnabled } from "@/lib/features"
import { timeAgo } from "@/lib/time-ago"

// Minimal header inbox for the in-app notification substrate (#382 — "no push
// notification is wired", src/app/api/v1/tasks/route.ts). Renders nothing when
// the flag is off, no wallet is connected, or (silently, on a fetch failure)
// there's nothing to show — same posture as DisputeActionRequired
// (src/components/tasks/dispute-alerts.tsx): a bell that shows a broken state
// is worse than one that just doesn't appear. Data shape mirrors the GET
// /api/v1/notifications response rather than importing the Drizzle row type,
// same as DisputedTaskRow does for tasks in that file.

interface NotificationRow {
  id: number
  event: "task_claimed" | "work_submitted" | "submission_reviewed" | "dispute_raised"
  taskId: number | null
  payload: { taskTitle?: string } | null
  readAt: string | null
  createdAt: string
}

const EVENT_LABEL: Record<NotificationRow["event"], string> = {
  task_claimed: "was claimed",
  work_submitted: "got a new submission",
  submission_reviewed: "submission was reviewed",
  dispute_raised: "was disputed",
}


// Keeps the badge roughly current for a tab left open. Not real-time (no
// delivery channel exists yet — see src/lib/notifications.ts) — a periodic
// poll is the minimal thing that isn't "only updates on next page load".
const POLL_MS = 60_000

export function NotificationsMenu() {
  const { account } = useWallet()
  // Tagged with the account it was fetched for, rather than cleared on
  // disconnect — same reasoning as DisputeActionRequired's `fetched` state:
  // clearing it would be a setState inside an effect body on every
  // account change, and staleness is cheaper to express as a render-time
  // comparison.
  const [fetched, setFetched] = useState<{
    account: string
    items: NotificationRow[]
    unreadCount: number
  } | null>(null)
  const current = fetched && fetched.account === account ? fetched : null
  const items = current?.items ?? []
  const unreadCount = current?.unreadCount ?? 0

  const load = useCallback(() => {
    if (!account) return
    apiFetch("/api/v1/notifications?limit=10")
      .then((r) => r.json())
      .then((body) => {
        if (!body?.ok || !Array.isArray(body.data)) return
        setFetched({ account, items: body.data, unreadCount: body.unreadCount ?? 0 })
      })
      .catch(() => {
        // Best-effort read, same posture as tg-alert.ts's transport: a failed
        // poll just means the badge is stale until the next one, never a
        // broken header.
      })
  }, [account])

  useEffect(() => {
    load()
    if (!account) return
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [account, load])

  const markRead = useCallback(
    async (ids?: number[]) => {
      try {
        await apiFetch("/api/v1/notifications/read", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ids ? { ids } : {}),
        })
      } catch {
        // Best-effort — a failed mark-read just leaves the badge lit; the
        // next load() reconciles it either way, nothing to surface here.
      }
      load()
    },
    [load],
  )

  if (!isEnabled("notifications")) return null
  if (!account) return null

  return (
    <DropdownMenu
      onOpenChange={(open: boolean) => {
        if (open) load()
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            title="Notifications"
            aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : "Notifications"}
            className="relative"
          />
        }
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <Badge
            variant="destructive"
            className="absolute -right-1 -top-1 h-4 min-w-4 justify-center rounded-full px-1 text-[10px] leading-none"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </Badge>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <div className="flex items-center justify-between px-1.5 py-1">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Notifications
          </span>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={() => markRead()}
              className="text-xs text-primary hover:underline"
            >
              Mark all read
            </button>
          )}
        </div>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <div className="px-1.5 py-3 text-center text-xs text-muted-foreground">Nothing yet</div>
        ) : (
          items.map((n) => (
            <DropdownMenuItem
              key={n.id}
              render={<Link href={n.taskId ? `/tasks/${n.taskId}` : "#"} className="no-underline" />}
              onClick={() => {
                if (!n.readAt) markRead([n.id])
              }}
              className="flex-col items-start gap-0.5 whitespace-normal"
            >
              <span className="flex w-full items-center gap-1.5 text-sm">
                {!n.readAt && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                )}
                <span className="truncate font-medium">{n.payload?.taskTitle ?? "A task"}</span>
                <span className="shrink-0 text-muted-foreground">{EVENT_LABEL[n.event]}</span>
              </span>
              <span className="text-[11px] text-muted-foreground">{timeAgo(n.createdAt)}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
