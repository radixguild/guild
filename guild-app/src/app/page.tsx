"use client";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { BadgeCard } from "@/components/badge-card";
import { TierProgression } from "@/components/tier-progression";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadFailed } from "@/components/ui/load-failed";
import { useWallet } from "@/hooks/useWallet";
import { apiFetch } from "@/lib/api-fetch";
import { RESOURCES, TG_BOT_URL } from "@/lib/constants";
import { settlementCopy } from "@/lib/settlement-copy";
import { BUG_BOUNTY_CALLOUT } from "@/content/bug-bounty-callout";
import { POSTER_PATH } from "@/content/poster-path";
import { INSURANCE_RATE } from "@/lib/marketplace";
import { DisputeActionRequired } from "@/components/tasks/dispute-alerts";
import Link from "next/link";

// Only the app's OWN task data now. The bot-fed Proposals and progress cards
// were cut 2026-08-21 (bigdev: "less is more rn"), and with them the
// homepage's last runtime dependency on the legacy Telegram bot's API. The
// programme behind the progress card was deleted outright 2026-09-07
// (operator ruling: the Guild runs no governance programme of its own).
// Governance had lived in exactly one honestly-labelled place, /decisions —
// removed 2026-09-04 on bigdev's instruction. CV2 stays on mainnet; reads
// continue only via the Telegram bot.
interface DashboardData {
  // App-internal task data (/api/v1) — replaced the live bot's 503-gated
  // /bounties surface in R1. `verified` is retired app-side; Review = submitted.
  tasks: {
    stats: { counts: Record<string, number>; totalPaidXrd: string };
    recent: { id: number; title: string; rewardXrd: string; status: string; projectId: number | null }[];
  } | null;
}

// task.projectId -> {name, slug}, so a recent-task row can link into its
// project (task 89: "the home page's bounty board links into projects").
// Shape matches the GET /api/v1/projects rollup row — only the two fields a
// link needs are kept.
type ProjectLookup = Map<number, { name: string; slug: string }>;

function Dashboard() {
  const { account, connected, badge, badgeLoading, badgeError, refreshBadge } = useWallet();
  const [data, setData] = useState<DashboardData>({ tasks: null });
  const [projectsById, setProjectsById] = useState<ProjectLookup>(new Map());
  const [loading, setLoading] = useState(true);
  // Distinguishing "the board is empty" from "the board didn't load" needs a
  // third state — `data.tasks === null` meant BOTH, and the whole Bounty Board
  // was gated on it, so a failing /tasks/stats made the guild look dead
  // rather than degraded. Same class as the silent-Join bug, in a read path.
  const [statsFailed, setStatsFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    Promise.all([
      apiFetch("/api/v1/tasks/stats").then(r => r.json()).catch(() => null),
      apiFetch("/api/v1/tasks?limit=5").then(r => r.json()).catch(() => null),
      apiFetch("/api/v1/projects").then(r => r.json()).catch(() => null),
    ]).then(([ts, tl, ps]) => {
      const statsOk = !!(ts?.ok && ts.data);
      setStatsFailed(!statsOk);
      setData({ tasks: statsOk ? { stats: ts.data, recent: tl?.ok ? tl.data : [] } : null });
      if (ps?.ok && Array.isArray(ps.data)) {
        setProjectsById(new Map(ps.data.map((p: { id: number; name: string; slug: string }) => [p.id, { name: p.name, slug: p.slug }])));
      }
      setLoading(false);
    });
  }, [reloadKey]);

  return (
    <div className="space-y-5">
      {/* Onboarding / Badge Section */}
      {!connected ? (
        <Card className="bg-gradient-to-br from-card to-muted border-primary/20">
          <CardContent className="px-6 py-12 text-center space-y-6">
            <div className="flex items-center justify-center gap-2">
              <h1 className="text-2xl font-bold">Commission real work on Radix</h1>
              <Badge variant="outline" className="border-primary/30 text-primary">Beta</Badge>
            </div>
            {/* Era-keyed, NOT inline. This sentence shipped inline and served
                its push form ("you release the payment ... when you approve")
                on the live pull component, where approval CREDITS and the
                worker withdraws — invisible to settlement-copy.test.ts for
                exactly as long as it lived here. */}
            <p className="text-muted-foreground text-sm max-w-md mx-auto">
              {settlementCopy("landingHeroBody")}
            </p>

            {/* Onboarding Steps */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-4 text-xs">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold text-[10px]">1</span>
                <span className="font-medium">Connect Wallet</span>
              </div>
              <span className="hidden sm:block text-muted-foreground">&rarr;</span>
              <div className="flex items-center gap-2 opacity-50">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-muted-foreground font-bold text-[10px]">2</span>
                <span>Mint Badge</span>
              </div>
              <span className="hidden sm:block text-muted-foreground">&rarr;</span>
              <div className="flex items-center gap-2 opacity-50">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-muted-foreground font-bold text-[10px]">3</span>
                <span>Browse Tasks</span>
              </div>
            </div>

            {/* The POSTER's path. The strip above is the worker's, under a
                headline that says "Commission real work" — a poster had no
                route off this page (stranger walkthrough 2026-09-17, finding
                4). Copy + the reasoning for every claim in it:
                src/content/poster-path.ts. The insurance rate is read from the
                same constant the create form charges, never typed. */}
            <div data-testid="poster-path" className="space-y-1.5 text-xs text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">{POSTER_PATH.lead}</span>{" "}
                {POSTER_PATH.steps.join(" → ")}.
              </p>
              <p className="text-[11px]">
                {POSTER_PATH.noBadgeNote} Funding locks the reward plus {INSURANCE_RATE * 100}% insurance in escrow.
              </p>
              <Link href={POSTER_PATH.href} className="inline-block text-primary hover:underline">
                {POSTER_PATH.ctaLabel} &rarr;
              </Link>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-lg mx-auto">
              {[
                // ⚠️ The third pillar was "Community Governance — Vote on
                // proposals in Telegram" until 2026-09-01. It survived the
                // 2026-08-26 cull (#460) that retired the programme it pointed
                // at, so the first thing a stranger read about us was a
                // governance surface we had just decided to stop building.
                // Replaced with the one true thing about our economics that
                // was stated NOWHERE on the site: there is no token. That is
                // not a gap to apologise for — it is the cleanest structural
                // difference we have from almost everything else in this
                // space, and a cold visitor should meet it in the first
                // three sentences.
                { title: "Task Marketplace", desc: "Fund work in escrow, delivered on-chain" },
                // Was "Portable reputation in your wallet" until 2026-09-20 — the badge records
                // membership; reputation and XP live in the Guild database (see /check-badge).
                { title: "On-chain Badges", desc: "A free membership NFT — your key to claim tasks" },
                { title: "No Token", desc: "Membership is a badge; work is paid in XRD" },
              ].map((f) => (
                <div key={f.title} className="text-center p-3 rounded-lg bg-muted/50">
                  <div className="text-sm font-semibold mb-1">{f.title}</div>
                  <div className="text-xs text-muted-foreground">{f.desc}</div>
                </div>
              ))}
            </div>

            <Link href="/guide" className="inline-block text-xs text-primary hover:underline">
              New here? Read the getting-started guide &rarr;
            </Link>
          </CardContent>
        </Card>
      ) : badgeLoading ? (
        <Card><CardContent className="p-5 space-y-4">
          <div className="flex justify-between"><Skeleton className="h-5 w-32" /><Skeleton className="h-5 w-20" /></div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">{[1,2,3,4].map(i => <Skeleton key={i} className="h-14" />)}</div>
          <Skeleton className="h-1.5 w-full" />
        </CardContent></Card>
      ) : badge ? (
        <>
          <BadgeCard badge={badge} />
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Badge tiers</CardTitle></CardHeader>
            <CardContent><TierProgression currentLevel={badge.level} /></CardContent>
          </Card>
        </>
      ) : badgeError ? (
        /* Gateway failed — badge state UNKNOWN. Never show the mint flow here:
           a blip must not tell a badge-holder to re-mint (audit Theme C). */
        <LoadFailed what="your badge" onRetry={refreshBadge} />
      ) : (
        <Card className="text-center border-primary/20">
          <CardContent className="py-10 space-y-4">
            {/* Progress indicator */}
            <div className="flex items-center justify-center gap-2 sm:gap-4 text-xs mb-4">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold text-[10px]">&#10003;</span>
                <span className="font-medium text-primary">Wallet Connected</span>
              </div>
              <span className="text-muted-foreground">&rarr;</span>
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold text-[10px]">2</span>
                <span className="font-medium">Mint Badge</span>
              </div>
              <span className="text-muted-foreground">&rarr;</span>
              <div className="flex items-center gap-2 opacity-50">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-muted-foreground font-bold text-[10px]">3</span>
                <span>Browse Tasks</span>
              </div>
            </div>

            <h2 className="text-lg font-bold">Mint Your Free Badge</h2>
            <p className="text-muted-foreground text-sm max-w-sm mx-auto">
              Your on-chain badge is what lets you claim funded tasks, and every task you complete
              builds your XP and track record. It&apos;s free to mint — you pay only the network fee.
            </p>
            <Link href="/mint"><Button size="lg">Mint Your Badge</Button></Link>
            {/* A poster lands on this card too, and minting is the wrong door
                for them: posting needs no badge (src/content/poster-path.ts). */}
            <p data-testid="poster-path-connected" className="text-xs text-muted-foreground">
              {POSTER_PATH.connectedLead}{" "}
              <Link href={POSTER_PATH.href} className="text-primary hover:underline">
                {POSTER_PATH.ctaLabel} &rarr;
              </Link>
            </p>
          </CardContent>
        </Card>
      )}

      {/* The one thing a stranger can actually do today. Deliberately OUTSIDE
          the badge ternary above, so it renders in every state: the signed-out
          visitor and the connected-but-badge-less one both reach a "Browse
          Tasks" step that currently dead-ends, because every open board task
          needs a PR against a repo that 404s to the public. Copy and the
          reasoning behind its wording live in src/content/bug-bounty-callout.ts
          — in particular why it must not imply payment. */}
      <Card className="border-primary/20">
        <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
          <div className="space-y-1">
            <div className="text-sm font-semibold">{BUG_BOUNTY_CALLOUT.title}</div>
            <p className="text-xs text-muted-foreground leading-relaxed">{BUG_BOUNTY_CALLOUT.body}</p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">{BUG_BOUNTY_CALLOUT.fundingNote}</p>
          </div>
          <Link href={BUG_BOUNTY_CALLOUT.href} className="shrink-0 no-underline sm:ml-auto">
            <Button variant="outline" size="sm">{BUG_BOUNTY_CALLOUT.ctaLabel}</Button>
          </Link>
        </CardContent>
      </Card>

      {/* Loading state — one card now, matching the one that arrives */}
      {loading && (
        <Card><CardContent className="p-5 space-y-3">
          <Skeleton className="h-4 w-32" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[1,2,3,4].map(j => <Skeleton key={j} className="h-12" />)}
          </div>
        </CardContent></Card>
      )}

      {/* Disputes the connected wallet is a party to. FIRST, above everything
          the dashboard otherwise shows: this is the only surface with a clock
          on it, and until 2026-09-01 nothing anywhere told a user their task
          had been disputed. See dispute-alerts.tsx for the full account. */}
      <DisputeActionRequired />

      {/* Bounty Board. An outage renders LoadFailed, never silence — see
          statsFailed above and load-failed.tsx's own module doc: "a degraded
          backend must never render as 'nothing here'". */}
      {!loading && statsFailed && (
        <LoadFailed what="the bounty board" onRetry={() => setReloadKey((k) => k + 1)} />
      )}
      {!loading && data.tasks && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Bounty Board</CardTitle>
              {/* Task 89: the board's primary structure is projects now —
                  send a visitor there, not straight to the flat task grid. */}
              <Link href="/projects"><Button variant="ghost" size="sm">View Projects</Button></Link>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: "Open", value: data.tasks.stats.counts.open ?? 0, color: "text-primary" },
                { label: "In Progress", value: data.tasks.stats.counts.assigned ?? 0, color: "text-yellow-500" },
                { label: "Review", value: data.tasks.stats.counts.submitted ?? 0, color: "text-blue-400" },
                { label: "Paid", value: data.tasks.stats.counts.paid ?? 0, color: "text-muted-foreground" },
              ].map(s => (
                <div key={s.label} className="bg-muted rounded-lg px-3 py-2.5">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{s.label}</div>
                  <div className={`text-lg font-bold font-mono ${s.color}`}>{s.value}</div>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between bg-muted rounded-lg px-3 py-2.5">
              <span className="text-xs text-muted-foreground">Total Paid Out</span>
              <span className="font-mono font-bold text-primary">{Number(data.tasks.stats.totalPaidXrd)} XRD</span>
            </div>
            {/* 2026-09-24 (checked against /api/v1/tasks and the chain): all 22
                paid tasks behind these figures ran between operator accounts —
                AG-01→AG-02 (16), AG-01→MW-03 (4), MW-02→MW-03 (2) — and one of
                them (board task 69, chain task 5) settled by a dispute split,
                which the total counts at its full reward. Delete the first
                sentence the day an outside account completes a task; revisit
                the second when another dispute settles. */}
            <p className="text-[11px] text-muted-foreground">
              Every task so far was posted and completed by the operator&rsquo;s own accounts. One
              paid task settled by a dispute split: the total counts its full reward, and its
              worker was credited half.
            </p>
            {data.tasks.recent.length > 0 && (
              <div className="space-y-1.5">
                {data.tasks.recent.slice(0, 5).map(t => {
                  // Task 89: "task rows link to the task's project where one
                  // exists" — only when the lookup actually resolves it (the
                  // project fetch can fail independently of the task fetch).
                  const project = t.projectId != null ? projectsById.get(t.projectId) : undefined;
                  const row = (
                    <div className="flex items-center justify-between gap-2 text-xs py-1.5 border-b last:border-0">
                      {/* min-w-0 + truncate replaces a hand-rolled slice(0,45):
                          a magic number cannot know the viewport, so it cut
                          short titles on desktop and still overflowed on a
                          phone. CSS does know. */}
                      <div className="min-w-0 truncate">
                        <span className="text-muted-foreground font-mono mr-1.5">#{t.id}</span>
                        <span>{t.title}</span>
                        {project && (
                          <span className="ml-1.5 text-muted-foreground">&middot; {project.name}</span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="font-mono text-muted-foreground">{Number(t.rewardXrd)} XRD</span>
                        <Badge variant={t.status === "paid" ? "default" : t.status === "open" ? "secondary" : "outline"} className="text-[9px]">{t.status}</Badge>
                      </div>
                    </div>
                  );
                  return project ? (
                    <Link key={t.id} href={`/projects/${project.slug}`} className="block no-underline text-foreground hover:text-primary transition-colors">
                      {row}
                    </Link>
                  ) : (
                    <div key={t.id}>{row}</div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Quick Actions */}
      {connected && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Quick Actions</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { label: "Browse Tasks", href: "/tasks", desc: "Task marketplace", external: false },
                { label: "Community polls", href: TG_BOT_URL, desc: "Optional and non-binding, in the Telegram bot", external: true },
                // ⚠️ A third tile linking to /admin was REMOVED 2026-08-21. It was
                // the ONLY inbound link to /admin anywhere in the codebase, shown to
                // every connected wallet, and it contradicted app-shell.tsx's own
                // rule ("admin is intentionally not in the nav — operator-only").
                // /admin is the mint/revoke/update-XP transaction builder, not a
                // lookup tool. If a public read-only badge lookup is wanted it wants
                // its own surface; /check-badge already covers most of that need.
              ].map((a) => {
                const inner = (<><div className="font-semibold text-sm mb-1">{a.label}</div><div className="text-xs text-muted-foreground">{a.desc}</div></>);
                return a.external ? (
                  <a key={a.label} href={a.href} target="_blank" rel="noopener noreferrer" className="block bg-muted rounded-lg p-4 no-underline text-foreground hover:bg-accent/10 transition-colors">{inner}</a>
                ) : (
                  <Link key={a.label} href={a.href} className="block bg-muted rounded-lg p-4 no-underline text-foreground hover:bg-accent/10 transition-colors">{inner}</Link>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* The Ecosystem card was REMOVED here 2026-08-21 — five external links,
          two of them labelled "Parked" and "Planned". None of them is something
          a visitor needs to browse, claim or post, which is what this page is
          for; and shipping a not-yet-real thing as dashboard content is the
          same failure as the progress card cut the same week, one tier
          down. The list itself is unchanged and still rendered on /about, which
          is where "who else is in this world" belongs. */}
      {/* Resources */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Resources</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {RESOURCES.map((r) => {
              const cls = "flex items-center gap-2.5 bg-muted rounded-lg px-4 py-3 no-underline text-foreground hover:bg-accent/10 transition-colors";
              const inner = (
                <div>
                  <div className="font-semibold text-[13px]">{r.name}</div>
                  <div className="text-[11px] text-muted-foreground">{r.desc}</div>
                </div>
              );
              return r.url.startsWith("/") ? (
                <Link key={r.name} href={r.url} className={cls}>{inner}</Link>
              ) : (
                <a key={r.name} href={r.url} target="_blank" rel="noopener noreferrer" className={cls}>{inner}</a>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {account && (
        <Link href={`/profile/${account}`} className="block text-xs text-muted-foreground font-mono hover:text-primary transition-colors">
          {account.slice(0, 20)}...{account.slice(-8)}
        </Link>
      )}
    </div>
  );
}

export default function Home() {
  return <AppShell><Dashboard /></AppShell>;
}
