"use client";
import { XP_THRESHOLDS, TIER_COLORS } from "@/lib/constants";

export function TierProgression({ currentLevel }: { currentLevel?: string }) {
  const tiers = Object.entries(XP_THRESHOLDS);

  // The note under the ladder (2026-09-24): the thresholds are the ladder's
  // definition, not a live progression — the tier shown is the badge's own
  // on-chain field, set at mint, and nothing computes a tier from Guild XP.
  return (
    <div>
    <div className="flex gap-1 items-end">
      {tiers.map(([tier, xp], i) => {
        const isActive = tier === currentLevel;
        const isPast = currentLevel && Object.keys(XP_THRESHOLDS).indexOf(currentLevel) >= i;
        const color = TIER_COLORS[tier] || "var(--muted)";

        return (
          <div key={tier} className="flex-1 text-center">
            <div
              className="h-1 rounded-sm mb-1.5"
              style={{ background: isPast ? color : "hsl(var(--muted))" }}
            />
            <div
              className={`text-[10px] uppercase ${isActive ? "font-bold" : "font-normal"}`}
              style={{ color: isActive ? color : undefined }}
            >
              <span className={isActive ? "" : "text-muted-foreground"}>{tier}</span>
            </div>
            <div className="text-[9px] text-muted-foreground font-mono">{xp.toLocaleString()}</div>
          </div>
        );
      })}
    </div>
    <p className="mt-2 text-[11px] text-muted-foreground">
      Your badge tier is set at mint and does not advance automatically.
    </p>
    </div>
  );
}
