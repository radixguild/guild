"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TierProgression } from "@/components/tier-progression";
import { TaskHistoryCard } from "@/components/tasks/task-history-card";
import { SignInPrompt } from "@/components/wallet/sign-in-prompt";
import { loadAllBadgesStrict, type StrictBadgeLookup } from "@/lib/gateway";
import { apiFetch } from "@/lib/api-fetch";
import { useWallet } from "@/hooks/useWallet";
import { resolveOwnerViewScope, type OwnerViewScope } from "@/lib/owner-view";
import { TIER_COLORS } from "@/lib/constants";
import type { Task } from "@/lib/marketplace-types";
import {
  TRUST_TIER_LABELS,
  TRUST_TIER_BADGE_CLASS,
  type TrustTier,
} from "@/lib/trust";
import { XrdAmount } from "@/components/XrdAmount";
import { useXrdUsd } from "@/lib/use-xrd-usd";
import { formatAddress } from "@/lib/marketplace-utils";

interface TrustInfo {
  tier: TrustTier;
  stats: {
    completed: number;
    claimed: number;
    failed: number;
    disputesRaised: number;
    disputesAgainst: number;
    deadlineSubmits: number;
    onTimeSubmits: number;
    avgDeliveryDays: number | null;
    completionRate: number | null;
    onTimeRate: number | null;
  };
}

interface ProfileSummary {
  address: string;
  displayName: string | null;
  badgeTier: string | null;
  xp: number;
  reputation: number;
  isAgent: boolean;
  tasksCreated: number;
  tasksAssigned: number;
  tasksCompleted: number;
  submissionsTotal: number;
  submissionsApproved: number;
  submissionsRejected: number;
  xrdEarned: string;
  xrdEarnedThisMonth: string;
  xrdSpent: string;
  createdAt: string;
  updatedAt: string;
  trust?: TrustInfo;
}

const pct = (rate: number | null) =>
  rate === null ? "—" : `${Math.round(rate * 100)}%`;

function ProfileContent() {
  const params = useParams();
  const address = params.address as string;
  const { rate, stale: usdStale, ageSeconds: usdAgeSeconds, source: usdSource } = useXrdUsd();

  // Strict badge state: `null` while loading. Once loaded, `badges` lists
  // only Gateway-CONFIRMED on-chain badges (never a DB row); `complete`
  // says whether every schema in SCHEMAS was actually readable — a false
  // "no badge" claim is worse than a slow one, so the render logic below
  // never asserts absence while any schema is uncertain. See
  // loadAllBadgesStrict (src/lib/gateway.ts).
  const [badgeLookup, setBadgeLookup] = useState<StrictBadgeLookup | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [postedTasks, setPostedTasks] = useState<Task[]>([]);
  // Did the SERVER treat the two task-list reads below as the owner's view?
  // GET /api/v1/tasks answers per response via `ownerView` (see the route and
  // src/lib/owner-view.ts). This is deliberately read off the responses that
  // populated `tasks`/`postedTasks`, not off useWallet(): the client's `authed`
  // is hydrated once from /api/v1/auth/me and cannot see an httpOnly cookie
  // expire afterwards, and a still-hydrating `user` is null in exactly the
  // same way a lapsed one is. The server's answer for the very request whose
  // rows we render is the only signal without a race or a guess.
  const [archiveScope, setArchiveScope] = useState<OwnerViewScope>("unknown");
  // Bumped by a successful sign-in from the Archived section so the lists are
  // re-read under the new session (same shape as /tasks/[id]'s refreshKey).
  const [refreshKey, setRefreshKey] = useState(0);
  const [summary, setSummary] = useState<ProfileSummary | null>(null);
  const [loading, setLoading] = useState(true);

  // Joined-group chips (Model A step 4). Self-only by design: the endpoint
  // returns the CALLER's memberships and takes no user parameter, because a
  // membership list is a subscription list — see the route's docblock. So the
  // chips render on your own profile and nowhere else.
  const { account } = useWallet();
  const isOwnProfile = !!account && account === address;
  const [myGroups, setMyGroups] = useState<{ workingGroupId: number; slug: string; name: string }[]>([]);

  useEffect(() => {
    // No clear-on-exit needed: the chips render behind `isOwnProfile &&`, so a
    // stale list from a previous account can never paint on someone else's
    // page. (An earlier version called setMyGroups([]) here — that is
    // setState-directly-in-an-effect, which the lint rule correctly rejects,
    // and it was guarding a case the render gate already covers.)
    if (!isOwnProfile) return;
    let cancelled = false;
    apiFetch("/api/v1/groups/memberships")
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled && body?.ok) setMyGroups(body.data);
      })
      .catch(() => {}); // chips are additive — a failed load just hides them
    return () => {
      cancelled = true;
    };
  }, [isOwnProfile]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      // Four independent reads — run in parallel, settle independently
      // so a slow / failing one doesn't block the others.
      const [badgeResult, tasksResult, postedResult, summaryResult] = await Promise.allSettled([
        loadAllBadgesStrict(address),
        apiFetch(
          `/api/v1/tasks?assignee=${encodeURIComponent(address)}&limit=100`,
        ).then((res) => res.json()),
        // Poster-side history — same route, `creator` instead of `assignee`
        // (src/app/api/v1/tasks/route.ts already supports both filters).
        apiFetch(
          `/api/v1/tasks?creator=${encodeURIComponent(address)}&limit=100`,
        ).then((res) => res.json()),
        apiFetch(`/api/v1/users/${encodeURIComponent(address)}/profile`).then(
          async (res) => ({ status: res.status, body: await res.json() }),
        ),
      ]);

      if (cancelled) return;

      if (badgeResult.status === "fulfilled") {
        setBadgeLookup(badgeResult.value);
      } else {
        // The lookup itself threw (shouldn't happen — loadAllBadgesStrict
        // fails closed internally), but treat it the same as "nothing
        // readable" rather than crash the page.
        console.error("Failed to load badges:", badgeResult.reason);
        setBadgeLookup({ badges: [], complete: false });
      }

      if (tasksResult.status === "fulfilled") {
        const data = tasksResult.value;
        if (data?.ok && data.data) setTasks(data.data);
      } else {
        console.error("Failed to load assigned tasks:", tasksResult.reason);
      }

      if (postedResult.status === "fulfilled") {
        const data = postedResult.value;
        if (data?.ok && data.data) setPostedTasks(data.data);
      } else {
        console.error("Failed to load posted tasks:", postedResult.reason);
      }

      // One decision from BOTH list bodies (a rejected fetch contributes null
      // = no information): "denied" only when the server explicitly said the
      // session did not match this address, "granted" only when both did.
      setArchiveScope(
        resolveOwnerViewScope([
          tasksResult.status === "fulfilled" ? tasksResult.value : null,
          postedResult.status === "fulfilled" ? postedResult.value : null,
        ]),
      );

      if (summaryResult.status === "fulfilled") {
        const { status, body } = summaryResult.value;
        if (status === 200 && body?.ok) {
          setSummary(body.data as ProfileSummary);
        }
        // 404 (user not in local DB) is fine — leave summary null
      } else {
        console.error("Failed to load profile summary:", summaryResult.reason);
      }

      setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [address, refreshKey]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="p-5 space-y-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-2 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  // The detailed Badge card below (tier/level/XP/status + TierProgression)
  // is scoped to the guild_member schema specifically — its "level"/XP
  // ladder is that schema's, not guild_role's. `badgeLookup.badges` still
  // lists every schema's confirmed badge for the identity chips below.
  const primaryBadge =
    badgeLookup?.badges.find((b) => b.schema === "guild_member")?.badge ?? null;
  // Only assert "no badge" once every schema actually came back readable —
  // see loadAllBadgesStrict. While any schema is still unreadable, the
  // honest state is neither "has one" nor "has none".
  const confirmedNoBadge = !primaryBadge && badgeLookup?.complete === true;

  return (
    <div className="space-y-5">
      {/* Identity header — address/handle, member-since (both always
          knowable: the address is the URL param, member-since is a real DB
          timestamp), badges actually held (Gateway-confirmed, never a DB
          guess), and — own profile only — the working groups you've joined.
          Any field this session could not source is omitted, not guessed. */}
      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-lg font-semibold truncate">
                {summary?.displayName || formatAddress(address)}
              </div>
              {summary?.displayName && (
                <div className="text-xs text-muted-foreground font-mono break-all">
                  {formatAddress(address)}
                </div>
              )}
            </div>
            {summary?.createdAt && (
              <div className="text-xs text-muted-foreground whitespace-nowrap">
                Member since {new Date(summary.createdAt).toLocaleDateString()}
              </div>
            )}
          </div>

          {badgeLookup && badgeLookup.badges.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {badgeLookup.badges.map(({ schema, badge: b }) => (
                <Badge
                  key={schema}
                  className="capitalize"
                  style={{
                    backgroundColor: `${TIER_COLORS[b.tier] ?? "var(--muted)"}20`,
                    color: TIER_COLORS[b.tier] ?? undefined,
                    border: "none",
                  }}
                >
                  {b.tier} · {schema.replace(/_/g, " ")}
                </Badge>
              ))}
            </div>
          )}

          {/* Joined-group chips — self-only by design (see the memberships
              route docblock): a membership list is a subscription list, not
              a public fact. */}
          {isOwnProfile && myGroups.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                {myGroups.map((g) => (
                  <Link key={g.workingGroupId} href={`/groups#${g.slug}`}>
                    <Badge variant="secondary" className="hover:bg-secondary/80">
                      {g.name}
                    </Badge>
                  </Link>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Tasks routed to these groups appear in{" "}
                <Link href="/groups" className="text-primary hover:underline">your feed</Link>. Only
                you can see this list.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Badge Info — the guild_member badge specifically; see primaryBadge above. */}
      {primaryBadge ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
              Badge
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <div className="text-[10px] text-muted-foreground uppercase">
                  Badge tier
                </div>
                <div className="font-semibold capitalize">{primaryBadge.tier}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground uppercase">
                  Level
                </div>
                <div className="font-semibold capitalize">{primaryBadge.level}</div>
              </div>
              <div>
                {/* This is the guild_member NFT's OWN xp field, read live off
                    the Gateway — never written by a task payout, and labelled
                    so it never reads as the same number as the Activity card's
                    "XP" stat below, which is `users.xp` — the column task
                    settlement actually credits (catalogue P4-20, task 88,
                    2026-09-15). ⚠️ The label read "(Telegram)" until 2026-09-23,
                    on the belief that the bot's XP queue wrote this field for
                    task work. It does not: the only update_xp calls on chain are
                    six, all on one badge, 2026-04-04 → 04-06, signed by the old
                    bot key RX-01, none since (badge-manager transaction stream,
                    read 2026-09-24). Only the operator's admin badge can write it. */}
                <div className="text-[10px] text-muted-foreground uppercase">
                  Badge XP (on-chain)
                </div>
                <div className="font-mono font-bold text-primary">
                  {primaryBadge.xp}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground uppercase">
                  Status
                </div>
                <div className="capitalize">{primaryBadge.status}</div>
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              <span className="font-semibold">Issued to:</span>{" "}
              <span className="font-mono break-all">{primaryBadge.issued_to}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              The tier, level and XP in this card are the badge&apos;s own on-chain fields, which only
              the operator can write. Your Guild XP and trust record are off-chain and shown separately.{" "}
              <Link href="/check-badge" className="text-primary hover:underline">How this works</Link>
            </div>
            <TierProgression currentLevel={primaryBadge.level} />
          </CardContent>
        </Card>
      ) : confirmedNoBadge ? (
        <Card>
          <CardContent className="p-5 text-center space-y-3">
            <p className="text-muted-foreground">No badge found for this address.</p>
            {/* Gated on isOwnProfile. /mint mints to the CONNECTED wallet, so on
                someone else's profile this button read as "fix their missing
                badge" and actually minted your own — an action about a stranger
                that silently operates on you. `isOwnProfile` was already
                computed above (L102) and simply never reached this branch. */}
            {isOwnProfile && (
              <Link href="/mint">
                <Button variant="default" size="sm">
                  Mint a Badge
                </Button>
              </Link>
            )}
          </CardContent>
        </Card>
      ) : (
        // The Gateway read was incomplete (badgeLookup.complete === false):
        // neither "has a badge" nor "confirmed no badge" is true yet, so
        // rendering nothing here reads to a viewer as "definitely no badge" —
        // indistinguishable from confirmedNoBadge above during an outage.
        // Say the honest thing instead: unknown, not none. (LOW defect,
        // 2026-08-26 adversarial screen on PR #459.)
        <Card>
          <CardContent className="p-5 text-center space-y-1">
            <p className="text-sm text-muted-foreground">
              Couldn&apos;t verify badges right now.
            </p>
            <p className="text-xs text-muted-foreground">
              The Gateway read didn&apos;t complete for every badge schema — this is
              not proof no badge exists. Try again shortly.
            </p>
          </CardContent>
        </Card>
      )}

      {/* XP Breakdown — two real numbers from two different writers, shown
          side by side on purpose so neither reads as the whole story.
          ⚠️ The "From Tasks / Other" split that used to live here was
          REMOVED 2026-08-21, not recalculated: it read
          `completedTasks.length * 50`, and a flat 50 has never been what a
          task pays (completion XP is per-task, set at create from
          getTierForReward() and awarded by escrow-confirm.ts). Both halves of
          that split were fabricated — the second by subtraction from the
          first — and the caveat that used to sit here said so ("wrong in the
          meantime"). It is gone now because there is nothing left to
          apologise for: Guild XP below is `summary.xp` (`users.xp`), the real
          column task settlement credits, and Badge XP is the badge's own
          field, both read from their actual sources rather than invented
          (catalogue P4-20, task 88, 2026-09-15). */}
      {primaryBadge && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
              XP Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              <div className="text-sm">
                <div className="text-[10px] text-muted-foreground uppercase">Guild XP</div>
                <div className="font-mono">{summary?.xp ?? 0} XP</div>
              </div>
              <div className="text-sm">
                <div className="text-[10px] text-muted-foreground uppercase">Badge XP (on-chain)</div>
                <div className="font-mono">{primaryBadge.xp} XP</div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Guild XP is credited when a task pays out — it is the number shown in
              the header. Badge XP (on-chain) is a
              separate field on the badge NFT itself, which only the operator can
              write; a task payout never reaches it, and the two never sync.
            </p>
            {/* The leaderboard left the nav chrome in the MVP-5 trim; the
                profile surface is its home now. */}
            <p className="text-xs text-muted-foreground mt-3">
              See where this ranks:{" "}
              <Link href="/leaderboard" className="text-primary hover:underline">
                leaderboard
              </Link>
            </p>
          </CardContent>
        </Card>
      )}

      {/* Trust record — ledger-derived (TASK-TERMS-DESIGN §4); same record
          for humans and agents. */}
      {summary?.trust && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground flex items-center gap-2">
              Trust tier
              <Badge className={`text-[10px] px-1.5 py-0 h-4 ${TRUST_TIER_BADGE_CLASS[summary.trust.tier]}`}>
                {TRUST_TIER_LABELS[summary.trust.tier]}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <Stat label="Completion" value={pct(summary.trust.stats.completionRate)} />
              <Stat label="On-time" value={pct(summary.trust.stats.onTimeRate)} />
              <Stat
                label="Disputes against"
                value={summary.trust.stats.disputesAgainst}
                accent={summary.trust.stats.disputesAgainst > 0 ? "negative" : undefined}
              />
              <Stat label="Disputes raised" value={summary.trust.stats.disputesRaised} />
              <Stat
                label="Avg delivery"
                value={
                  summary.trust.stats.avgDeliveryDays == null
                    ? "—"
                    : `${summary.trust.stats.avgDeliveryDays.toFixed(1)} days`
                }
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Derived from the escrow ledger — paid releases, dispute markers, and
              on-time submissions. Agents earn the same record as humans.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Activity Summary (from local DB) */}
      {summary && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
                Activity {summary.isAgent && <Badge variant="secondary" className="ml-2 text-[10px]">Agent</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <Stat label="Posted" value={summary.tasksCreated} />
                <Stat label="Claimed" value={summary.tasksAssigned} />
                <Stat label="Completed" value={summary.tasksCompleted} />
                {/* `users.xp` — the column task settlement actually credits,
                    not the badge NFT's own field (see the XP Breakdown card
                    below). Shown here regardless of whether a badge is
                    minted, same as Reputation beside it — the header pill
                    reads this same value (catalogue P4-20, task 88). */}
                <Stat label="XP" value={summary.xp} />
                <Stat label="Reputation" value={summary.reputation} />
                <Stat label="Submissions" value={summary.submissionsTotal} />
                <Stat label="Approved" value={summary.submissionsApproved} accent="positive" />
                <Stat label="Rejected" value={summary.submissionsRejected} accent="negative" />
                <Stat
                  label="Approval rate"
                  value={
                    summary.submissionsTotal === 0
                      ? "—"
                      : `${Math.round((summary.submissionsApproved / summary.submissionsTotal) * 100)}%`
                  }
                />
              </div>
              {/* Posted/Claimed above are all-time counts; the task lists below
                  leave out cancelled tasks (they sit in the owner-only Archived
                  section), so a visitor saw "Posted 30" beside "Tasks Posted
                  (25)" with nothing to reconcile them. Say which is which. */}
              <p className="mt-3 text-[11px] text-muted-foreground">
                Counts are all-time. The task lists below leave out cancelled tasks.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
                XRD
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                <Stat
                  label="Earned (lifetime)"
                  value={
                    <XrdAmount
                      amountXrd={summary.xrdEarned}
                      usdRate={rate}
                      stale={usdStale}
                      ageSeconds={usdAgeSeconds}
                      source={usdSource}
                      mode="compact"
                    />
                  }
                />
                <Stat
                  label="Earned (this month)"
                  value={
                    <XrdAmount
                      amountXrd={summary.xrdEarnedThisMonth}
                      usdRate={rate}
                      stale={usdStale}
                      ageSeconds={usdAgeSeconds}
                      source={usdSource}
                      mode="compact"
                    />
                  }
                />
                <Stat
                  label="Funded into tasks"
                  value={
                    <XrdAmount
                      amountXrd={summary.xrdSpent}
                      usdRate={rate}
                      stale={usdStale}
                      ageSeconds={usdAgeSeconds}
                      source={usdSource}
                      mode="compact"
                    />
                  }
                />
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Task history — worker side (claimed) and poster side (posted).
          Both read straight off the DB status/onChainTaskId columns
          (reconciler/drift-watcher keep those in step with chain truth), so
          neither list ever shows a state more advanced than what's recorded.
          Cancelled rows move to the Archived section below (own profile
          only) instead of appearing here, so a claimed/posted count isn't
          padded with dead tasks — see the split just below. */}
      <TaskHistoryCard
        title="Tasks Claimed"
        tasks={tasks.filter((t) => t.status !== "cancelled")}
        emptyLabel="No claimed tasks yet."
      />
      <TaskHistoryCard
        title="Tasks Posted"
        tasks={postedTasks.filter((t) => t.status !== "cancelled")}
        emptyLabel="No posted tasks yet."
      />

      {/* Archived (cancelled) tasks — own profile only, same gate as the
          joined-group chips above: `tasks`/`postedTasks` already come back
          empty of cancelled rows for anyone but the session-verified
          creator/assignee (GET /api/v1/tasks' includeHiddenStale check), so
          this is never a privacy leak for a stranger's profile — it's
          gated on isOwnProfile purely so the section isn't dead weight on
          every profile page. Findable home for what GET /api/v1/tasks/[id]
          now calls the Archived state (2026-09-14).

          isOwnProfile is a CLIENT belief (wallet shares this address). The
          server decides separately, per request, from the httpOnly
          guild_session cookie — and the two disagree exactly when that
          cookie has lapsed or belongs to another account (the 2026-09-14
          incident shape: wallet badge still says "you", session gone). In
          that state the lists above arrived filtered to the public view, so
          rendering the two cards would show "No archived … tasks." to an
          owner who may well have some — the same misleading empty state the
          task page's ARCHIVED_SIGN_IN_REQUIRED fix closed. So: when the
          server explicitly reported the public view (archiveScope ===
          "denied"), show a sign-in instead of the cards; a successful sign-in
          bumps refreshKey and the lists reload under the new session. The
          "Tasks Claimed"/"Tasks Posted" cards above are affected the same way
          (soft-hidden stale rows are gated by the same check), and the reload
          fixes them too. "unknown" (a fetch failed outright) keeps the cards:
          a network failure is not a session failure, and the prompt must not
          claim otherwise. */}
      {isOwnProfile &&
        (archiveScope === "denied" ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
                Archived
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SignInPrompt
                title="Sign in to see your archived tasks"
                description="Your wallet is connected, but this browser has no Guild session for it. Archived (cancelled) tasks are only shown to their signed-in poster or worker, so this page can't tell whether you have any until you sign in."
                onSignedIn={() => setRefreshKey((k) => k + 1)}
              />
            </CardContent>
          </Card>
        ) : (
          <>
            <TaskHistoryCard
              title="Archived — Claimed"
              tasks={tasks.filter((t) => t.status === "cancelled")}
              emptyLabel="No archived claimed tasks."
            />
            <TaskHistoryCard
              title="Archived — Posted"
              tasks={postedTasks.filter((t) => t.status === "cancelled")}
              emptyLabel="No archived posted tasks."
            />
          </>
        ))}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  // ReactNode (not just number | string) since 2026-09-03: the XRD stats
  // below pass <XrdAmount>, which renders the dual XRD/USD label with its
  // own stale-aware tooltip rather than a pre-formatted string.
  value: React.ReactNode;
  accent?: "positive" | "negative";
}) {
  const tone =
    accent === "positive"
      ? "text-emerald-600 dark:text-emerald-400"
      : accent === "negative"
        ? "text-rose-600 dark:text-rose-400"
        : "text-foreground";
  return (
    <div>
      <div className="text-[10px] text-muted-foreground uppercase">{label}</div>
      <div className={`font-mono font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

export default function ProfilePage() {
  // Same omission as /mint, same reason: ProfileContent returns a different
  // tree per load state. The heading is generic on purpose — the profile's
  // subject (a display name or a truncated address) is rendered inside the
  // content once it is known, and a title that changes shape mid-load is worse
  // than one that does not.
  return (
    <AppShell>
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">Profile</h1>
        <ProfileContent />
      </div>
    </AppShell>
  );
}
