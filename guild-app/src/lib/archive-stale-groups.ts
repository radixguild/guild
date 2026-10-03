// Pure decision logic for the working-group auto-archive sweep (Model A §5c /
// build step 6), extracted so the candidate predicate is unit-testable without
// the DB (mirrors the src/lib/prune-unfunded.ts precedent this sweep otherwise
// copies wholesale). The sweep script (scripts/archive-stale-groups.mjs) does
// the I/O — select candidates via findStaleActiveWorkingGroups, re-check each
// under a race-safe CAS, set is_active=false — and delegates the WHAT/whether
// here.
//
// WHY: "too many categories in a small community is the #1 documented failure
// of this pattern — users give up, channels sit empty" (design spec §5c). A
// group nobody has posted into for a long stretch should stop cluttering
// /groups' browse grid, without losing its history or its members' existing
// routing (soft-archive only, never delete — see the schema comment).

/** Default staleness window: no task routed to the group in this long. 30 days
 *  — long enough that a normal lull between tasks in an active lane never
 *  trips it (the catalog is 5-8 seeded groups mapped to ongoing work areas,
 *  not project-scoped channels that naturally go quiet), short enough that a
 *  genuinely dead group is caught within a month rather than sitting forever. */
export const STALE_GROUP_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface StaleGroupCheck {
  createdAt: Date
  /** Newest task ever routed to the group, or null if it has never had one. */
  lastTaskAt: Date | null
}

/**
 * True when a group's last activity is old enough to auto-archive. Pure +
 * total, mirroring isPrunableUnfunded's shape:
 *   • baseline = lastTaskAt, or createdAt when the group has never had a task
 *     — a freshly seeded group is not stale on day one for having nothing
 *     posted into it yet.
 *   • age test is STRICT (age > ttl), matching findStaleActiveWorkingGroups'
 *     SQL cutoff exactly so this belt-and-suspenders re-check can never
 *     diverge from the candidate query at the boundary.
 */
export function isStaleWorkingGroup(
  group: StaleGroupCheck,
  now: Date,
  ttlMs: number = STALE_GROUP_TTL_MS,
): boolean {
  const baseline = group.lastTaskAt ?? group.createdAt
  return now.getTime() - baseline.getTime() > ttlMs
}

/** The activity cutoff for the candidate query: a group whose last activity
 *  predates this instant is old enough to flag. */
export function staleCutoff(now: Date, ttlMs: number = STALE_GROUP_TTL_MS): Date {
  return new Date(now.getTime() - ttlMs)
}
