"use client";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { TIER_COLORS, XP_THRESHOLDS } from "@/lib/constants";
import type { BadgeInfo } from "@/lib/types";

function xpProgress(xp: number, level: string) {
  const levels = Object.entries(XP_THRESHOLDS);
  const idx = levels.findIndex(([l]) => l === level);
  const current = levels[idx]?.[1] ?? 0;
  const next = levels[idx + 1]?.[1] ?? current + 1;
  const nextLevel = levels[idx + 1]?.[0] ?? level;
  const range = next - current;
  const percent = range > 0 ? Math.min(100, Math.round(((xp - current) / range) * 100)) : 100;
  return { percent, next, nextLevel };
}

export function BadgeCard({ badge }: { badge: BadgeInfo }) {
  const { percent, next, nextLevel } = xpProgress(badge.xp, badge.level);
  const isMax = badge.level === "elder";
  const tierColor = TIER_COLORS[badge.tier] || "var(--muted)";

  return (
    <Card style={{ borderLeft: `3px solid ${tierColor}` }}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          {/* min-w-0: a flex item defaults to min-width:auto and refuses to
              shrink below its content, so a full 66-char address pushed the
              tier pill out of the card instead of truncating. */}
          <div className="min-w-0 truncate">
            <span className="font-mono font-bold text-[15px]">{badge.issued_to}</span>
            <span className="ml-2 text-[11px] text-muted-foreground font-mono">{badge.schema_name}</span>
          </div>
          <Badge style={{ backgroundColor: tierColor, color: "#000" }}>
            {badge.tier.toUpperCase()}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Level", value: badge.level },
            // Labelled "(on-chain)", not bare "XP": this is the guild_member
            // NFT's own xp field, which only the operator's admin badge can
            // write (update_xp) — a task payout never reaches it. It read
            // "(Telegram)" until 2026-09-23, on a belief the Gateway refuted:
            // the only update_xp calls on chain are six in April 2026, all on
            // one badge, none since (read 2026-09-24). The header pill and
            // profile card show a different number, `users.xp`, for exactly
            // that reason (catalogue P4-20, task 88).
            { label: "Badge XP (on-chain)", value: badge.xp.toLocaleString() },
            { label: "Status", value: badge.status },
            { label: "ID", value: badge.id.replace(/[<>]/g, "") },
          ].map((s) => (
            <div key={s.label} className="bg-muted rounded-md px-3 py-2">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{s.label}</div>
              <div className="text-[13px] font-mono font-semibold mt-0.5 truncate">{s.value}</div>
            </div>
          ))}
        </div>

        {/* XP Progress */}
        <div>
          <div className="flex justify-between text-[11px] text-muted-foreground mb-1.5">
            <span>{badge.xp} XP</span>
            <span>{isMax ? "Max Level" : `${next.toLocaleString()} XP \u2192 ${nextLevel}`}</span>
          </div>
          <Progress value={percent} className="h-1.5" />
        </div>
      </CardContent>
    </Card>
  );
}
