"use client"

import { useEffect, useState } from "react"
import { Leaderboard, type LeaderboardEntry } from "@/components/Leaderboard"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/ui/empty-state"
import { apiFetch } from "@/lib/api-fetch"
import { AlertCircle, Trophy } from "lucide-react"
import { AppShell } from "@/components/app-shell"

interface ApiRow {
  id: string
  displayName: string | null
  badgeTier: string | null
  reputation: number
  xp: number
  tasksCompleted: number
  tasksThisMonth: number
  xrdEarned: string
  xrdEarnedThisMonth: string
  trustTier: LeaderboardEntry["trustTier"]
}

function toEntry(row: ApiRow): LeaderboardEntry {
  return {
    address: row.id,
    displayName: row.displayName ?? undefined,
    reputationScore: row.reputation,
    tasksCompleted: row.tasksCompleted,
    tasksThisMonth: row.tasksThisMonth,
    xrdEarned: Number(row.xrdEarned),
    xrdEarnedThisMonth: Number(row.xrdEarnedThisMonth),
    trustTier: row.trustTier,
    badges: [],
  }
}

function LeaderboardContent() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    apiFetch("/api/v1/users/leaderboard")
      .then(async (res) => {
        const body = await res.json()
        if (!res.ok || !body.ok) {
          throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
        }
        return body.data as ApiRow[]
      })
      .then((rows) => {
        if (cancelled) return
        setEntries(rows.map(toEntry))
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? "Failed to load leaderboard")
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
      <div>
        <h1 className="text-2xl font-bold">Leaderboard</h1>
        <p className="text-muted-foreground">
          Contributors ranked by reputation. Earn rep by completing tasks.
        </p>
      </div>

      {loading ? (
        <Skeleton className="h-96 rounded-lg border border-border/40 bg-muted/30" />
      ) : error ? (
        <EmptyState
          icon={<AlertCircle />}
          title="Failed to load leaderboard"
          description={error}
        />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<Trophy />}
          title="No contributors yet"
          description="Complete a task to appear on the leaderboard."
        />
      ) : (
        <Leaderboard entries={entries} />
      )}
    </div>
  )
}

export default function LeaderboardPage() {
  return <AppShell><LeaderboardContent /></AppShell>
}
