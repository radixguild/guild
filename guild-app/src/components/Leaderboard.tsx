"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BADGE_MILESTONES } from "@/lib/reputation";
import { formatXrdUsd } from "@/lib/format-xrd-usd";
import { useXrdUsd } from "@/lib/use-xrd-usd";
import { formatAddress } from "@/lib/marketplace-utils";
import {
  TRUST_TIER_LABELS,
  TRUST_TIER_BADGE_CLASS,
  type TrustTier,
} from "@/lib/trust";

// ── Types ──

export interface LeaderboardEntry {
  address: string;
  displayName?: string;
  reputationScore: number;
  tasksCompleted: number;
  tasksThisMonth: number;
  xrdEarned: number;
  xrdEarnedThisMonth: number;
  /** Ledger-derived (TASK-TERMS-DESIGN §4) — replaces the retired
   * newcomer→master reputation-label ladder as the user-facing trust axis. */
  trustTier: TrustTier;
  badges: string[];
}

type SortField = "reputation" | "tasks" | "xrd";

// ── Component ──

export function Leaderboard({ entries }: { entries: LeaderboardEntry[] }) {
  const [sortBy, setSortBy] = useState<SortField>("reputation");

  // A Code / Review / Governance filter stood here until 2026-09-26. Nothing
  // records a contributor's category (no field in the leaderboard query or the
  // API), so every one of those buttons showed an empty board. Bring it back
  // with the data, not before.
  const sorted = [...entries].sort((a, b) => {
    switch (sortBy) {
      case "reputation":
        return b.reputationScore - a.reputationScore;
      case "tasks":
        return b.tasksThisMonth - a.tasksThisMonth;
      case "xrd":
        return b.xrdEarnedThisMonth - a.xrdEarnedThisMonth;
    }
  });

  const sortOptions: { key: SortField; label: string }[] = [
    { key: "reputation", label: "Reputation" },
    { key: "tasks", label: "Tasks (month)" },
    { key: "xrd", label: "XRD earned" },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <CardTitle className="text-lg">Leaderboard</CardTitle>
        </div>
        <div className="flex gap-1.5 mt-2">
          {sortOptions.map((opt) => (
            <Button
              key={opt.key}
              variant={sortBy === opt.key ? "secondary" : "ghost"}
              size="sm"
              className="h-6 text-[11px] px-2"
              onClick={() => setSortBy(opt.key)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {sorted.length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-muted-foreground">
            No contributors yet. Complete a task to appear here!
          </div>
        ) : (
          <div className="divide-y">
            {sorted.map((entry, i) => (
              <LeaderboardRow key={entry.address} entry={entry} rank={i + 1} sortBy={sortBy} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LeaderboardRow({
  entry,
  rank,
  sortBy,
}: {
  entry: LeaderboardEntry
  rank: number
  sortBy: SortField
}) {
  const { rate: usdRate } = useXrdUsd();
  const badgeLabels = BADGE_MILESTONES.filter((m) =>
    entry.badges.includes(m.badge),
  );

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors">
      {/* Rank */}
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
          rank <= 3
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground"
        }`}
      >
        {rank}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium truncate">
            {entry.displayName || formatAddress(entry.address)}
          </span>
          <Badge
            className={`text-[10px] px-1.5 py-0 h-4 shrink-0 ${TRUST_TIER_BADGE_CLASS[entry.trustTier]}`}
          >
            {TRUST_TIER_LABELS[entry.trustTier]}
          </Badge>
        </div>
        {badgeLabels.length > 0 && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {badgeLabels.slice(0, 4).map((b) => (
              <span
                key={b.badge}
                className="text-[9px] bg-muted rounded px-1.5 py-0.5 text-muted-foreground"
              >
                {b.label}
              </span>
            ))}
            {badgeLabels.length > 4 && (
              <span className="text-[9px] text-muted-foreground">
                +{badgeLabels.length - 4}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Stats.
          ⚠️ Below 640px this whole block was `hidden` — a phone visitor saw only
          rank and name, while the sort control above still offered to order the
          list by three numbers they could not see. Hiding the data and keeping
          the control that sorts by it is the worst of both. So on mobile we now
          show the ONE metric the list is currently sorted by, which is the
          number that explains the order; the full three-column block returns at
          sm and up, unchanged. */}
      <div className="flex sm:hidden text-right shrink-0">
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">
            {sortBy === "reputation" ? "Rep" : sortBy === "tasks" ? "Tasks" : "XRD"}
          </div>
          <div className="text-sm font-mono font-semibold">
            {sortBy === "reputation"
              ? entry.reputationScore.toLocaleString()
              : sortBy === "tasks"
                ? entry.tasksCompleted
                : formatXrdUsd(entry.xrdEarned, usdRate, { mode: "compact" })}
          </div>
        </div>
      </div>
      <div className="hidden sm:flex gap-4 text-right shrink-0">
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">Rep</div>
          <div className="text-sm font-mono font-semibold">
            {entry.reputationScore.toLocaleString()}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">Tasks</div>
          <div className="text-sm font-mono font-semibold">
            {entry.tasksCompleted}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">XRD</div>
          <div className="text-sm font-mono font-semibold">
            {formatXrdUsd(entry.xrdEarned, usdRate, { mode: "compact" })}
          </div>
        </div>
      </div>
    </div>
  );
}

