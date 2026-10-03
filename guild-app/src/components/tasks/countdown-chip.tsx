"use client"

// Live countdown chip for task timing windows (UX wave 1 · countdown chips).
//
// Hydration-safe ticking via useSyncExternalStore: the server snapshot is null
// (nothing rendered on the server or during hydration), then the wall clock —
// quantized to 30s ticks — drives re-renders. The window→label logic lives in
// lib/countdown (pure, unit-tested).

import { useSyncExternalStore } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { getTaskCountdown } from "@/lib/countdown"
import { Clock } from "lucide-react"

const TICK_MS = 30_000

function subscribeTick(onTick: () => void) {
  const timer = setInterval(onTick, TICK_MS)
  return () => clearInterval(timer)
}

/** Wall-clock "now" quantized to the tick; null on the server / while hydrating. */
function useNowMs(): number | null {
  const tick = useSyncExternalStore<number | null>(
    subscribeTick,
    () => Math.floor(Date.now() / TICK_MS),
    () => null
  )
  return tick === null ? null : tick * TICK_MS
}

// Tones: muted while an open task's deadline ticks (and after it passes),
// orange while the 72h dispute window runs (matches the disputed status
// badge), green once anyone may finalize.
const CHIP_TONE: Record<string, string> = {
  "deadline": "bg-muted text-muted-foreground",
  "deadline-lapsed": "bg-muted text-muted-foreground",
  "dispute": "bg-orange-500/10 text-orange-500",
  "dispute-lapsed": "bg-green-500/10 text-green-500",
}

export function CountdownChip({
  status,
  deadline,
  disputedAt,
  updatedAt,
  className,
}: {
  status: string
  deadline?: Date | null
  /** Persisted on-chain dispute time — what the chain's 72h window keys off. */
  disputedAt?: Date | null
  /** Legacy fallback when disputedAt was never persisted (approximation only). */
  updatedAt?: Date | null
  className?: string
}) {
  const now = useNowMs()

  // Pre-mount (SSR + hydration pass) renders nothing — stable markup.
  if (now === null) return null

  const countdown = getTaskCountdown({ status, deadline, disputedAt, updatedAt }, now)
  if (!countdown) return null

  const tone =
    CHIP_TONE[countdown.lapsed ? `${countdown.kind}-lapsed` : countdown.kind]

  return (
    <Badge variant="secondary" className={cn("font-mono", tone, className)}>
      <Clock />
      {countdown.label}
    </Badge>
  )
}
