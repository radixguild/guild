"use client";
import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "@/hooks/useWallet";
import { TIER_COLORS } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Home, ListTodo, Award, Users, Plus, HelpCircle, FolderKanban, BookOpen, Compass, Sparkles, MessageCircle, MoreHorizontal, HandCoins, Bot } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useGuide, guideForPath, GUIDES } from "@/components/guides";
import { TG_GROUP_URL } from "@/lib/config";
import { isGiftPageLive } from "@/lib/gift";
import { isEnabled } from "@/lib/features";
import { NetworkHaltNotice } from "@/components/network-halt-notice";
import { NotificationsMenu } from "@/components/notifications-menu";
import { useMounted } from "@/hooks/useMounted";

// Primary nav, trimmed to the MVP-5 surface (community-funded tasks, projects,
// working groups, profiles): Build (the task marketplace + working groups).
// Home, Mint and Docs flank it. Leaderboard left the chrome (the route stays
// live, linked from the profile surface); Groups is promoted in — it is MVP
// #3 and had no chrome entry at all. Admin + deploy are intentionally not in
// the nav — operator-only, reachable by URL and flag-gated (FLAGS.admin).
//
// The "Govern" group (a labelled uppercase heading + separator around a single
// link to on-chain CV2 temperature checks, `/decisions`) is GONE, not just
// ungrouped — the page and the route were both removed 2026-09-04 on bigdev's
// direct instruction ("pull the decisions page from the guild"). CV2 stays on
// mainnet and its reads continue only via the Telegram bot (`/cv2`); nothing
// in-app links to it any more. See docs/FEATURE-MAP.md and
// docs/PROJECT-STATE.md ("Known cleanups") for the removal record.
type NavItem = { path: string; label: string; icon: typeof Home };
const NAV_GROUPS: { label?: string; items: NavItem[] }[] = [
  { items: [{ path: "/", label: "Home", icon: Home }] },
  {
    label: "Build",
    items: [
      { path: "/tasks", label: "Tasks", icon: ListTodo },
      { path: "/projects", label: "Projects", icon: FolderKanban },
      { path: "/groups", label: "Groups", icon: Users },
      // Agents (S1, 2026-09-28): the page an agent — or the person deploying one —
      // reads first, and since A2 the owner's "My agents" surface. It had no chrome
      // entry while its only readers arrived by link (/llms.txt, the README); now
      // that the kit is served from the site, the way in must be visible on it.
      { path: "/agents", label: "Agents", icon: Bot },
      // Community funding sits inside Build, between browsing work and posting
      // it, because that is where it belongs in the user's head: a pool is a
      // task nobody can afford alone yet. Flag-gated at MODULE level rather
      // than per-render — `isEnabled("crowdfund")` reads an inlined
      // NEXT_PUBLIC_* constant, so with the flag off the entry is gone from
      // the bundle entirely, matching how /admin and /deploy-escrow stay out
      // of the chrome. The /fund pages themselves notFound() behind the same
      // flag, so the nav and the routes can never disagree.
      ...(isEnabled("crowdfund")
        ? [{ path: "/fund", label: "Fund", icon: HandCoins }]
        : []),
      { path: "/tasks/create", label: "Create", icon: Plus },
    ],
  },
  { items: [{ path: "/mint", label: "Mint", icon: Award }] },
  { items: [{ path: "/docs", label: "Docs", icon: BookOpen }] },
];

// Mobile bottom nav: a hard 5-slot ceiling. Four one-tap destinations cover the
// two core jobs — browse (Tasks) and post (Create) — plus Home and Mint
// (onboarding); the fifth slot is a "More" menu holding everything else
// (Projects, Groups, Docs) so nothing is unreachable on mobile.
const MOBILE_BAR_PATHS = ["/", "/tasks", "/tasks/create", "/mint"];
const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);
const MOBILE_BAR = MOBILE_BAR_PATHS
  .map((p) => ALL_NAV_ITEMS.find((i) => i.path === p))
  .filter((i): i is NavItem => i !== undefined);
const MOBILE_MORE = ALL_NAV_ITEMS.filter((i) => !MOBILE_BAR_PATHS.includes(i.path));

// Tasks stays highlighted across its sub-routes (detail, submit) but not on the
// sibling Create tab; everything else is exact / prefix match.
function isActive(pathname: string, path: string): boolean {
  if (path === "/") return pathname === "/";
  if (path === "/tasks")
    return pathname === "/tasks" || (pathname.startsWith("/tasks/") && pathname !== "/tasks/create");
  return pathname === path || pathname.startsWith(path + "/");
}

/**
 * Pure formatter for the header identity pill. Pulled out and exported so it
 * is unit-tested without mounting the rest of AppShell's chrome
 * (NotificationsMenu, NetworkHaltNotice, the guide/dropdown menus) — same
 * reasoning as `decideSession` in useWallet.tsx.
 *
 * `xp` MUST be the caller's own `users.xp` (useWallet's session `user.xp`),
 * never the connected wallet's `badge.xp`: `badge.xp` is the guild_member
 * NFT's own on-chain field, written only by the Telegram bot's XP queue
 * (votes/polls/dice) — a task settlement never reaches it, which is exactly
 * why a worker who had just been paid used to see "MEMBER | 0 XP" here
 * (catalogue P4-20, task 88, 2026-09-15). The XP segment is omitted (not
 * shown as 0) when `xp` is unknown — e.g. a connected wallet with no active
 * Guild session — rather than fabricate a number.
 */
export function formatHeaderBadgePill(tier: string, xp: number | undefined): string {
  const base = tier.toUpperCase();
  return typeof xp === "number" ? `${base} | ${xp} XP` : base;
}

/**
 * Decide whether the header's "Get your badge" nudge should show. Pure and
 * exported so it is unit-tested without mounting the rest of AppShell's
 * chrome — same reasoning as formatHeaderBadgePill above.
 *
 * True only for a CONFIRMED badge-less connected wallet — mirroring the
 * `confirmedNoBadge` discipline the profile page and mint/page.tsx already
 * apply: `badge === null` is ALSO the shape of "still loading" and "the
 * Gateway lookup failed" (useWallet's badgeError doc), so either of those
 * must suppress the nudge rather than have it read a blip as "you have no
 * badge". A disconnected wallet gets nothing either — there is no address to
 * check yet, and the connect button is the nudge at that point.
 */
export function shouldShowMintNudge(
  connected: boolean,
  hasBadge: boolean,
  badgeLoading: boolean,
  badgeError: boolean,
): boolean {
  return connected && !badgeLoading && !badgeError && !hasBadge;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  // `badge` still supplies the tier (the guild_member NFT's own on-chain
  // tier field); `user.xp` supplies the number — see formatHeaderBadgePill.
  const { badge, user, connected, badgeLoading, badgeError } = useWallet();
  const pathname = usePathname() || "/";
  const { openGuide } = useGuide();
  const pageGuide = guideForPath(pathname);
  const moreActive = MOBILE_MORE.some((n) => isActive(pathname, n.path));
  // Gate hydration-sensitive UI (theme toggle, <radix-connect-button/>) until
  // after client hydration. useSyncExternalStore's getServerSnapshot returns
  // false on the server, then React switches to the client snapshot post-mount.
  const mounted = useMounted();

  return (
    <>
      {/* Incident banner, ABOVE the sticky header and outside it: a halt is the
          first fact a visitor needs and it must not scroll away under the nav.
          Renders nothing unless we affirmatively know the network is stopped or
          the operator lever is on — see NetworkHaltNotice. */}
      <NetworkHaltNotice />

      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 flex items-center justify-between h-14">
          <div className="flex items-center gap-2 sm:gap-3">
            <Link href="/" className="py-1.5 font-bold text-base text-foreground no-underline">
              Radix Guild
            </Link>
            {badge && (
              <Badge variant="secondary" className="hidden sm:inline-flex font-mono text-[11px]"
                style={{ borderLeft: `3px solid ${TIER_COLORS[badge.tier] || "var(--muted)"}` }}>
                {formatHeaderBadgePill(badge.tier, user?.xp)}
              </Badge>
            )}
            {/* Onboarding nudge (catalogue P4-12): a connected, confirmed
                badge-less wallet saw nothing in this slot at all, and the
                only path to discovering minting was noticing "Mint" among
                equally-weighted nav siblings. Gated on `mounted` like
                <radix-connect-button/> below — `connected`/`badge` come from
                useWallet's client-only wallet state, so rendering this
                before hydration risks a server/client mismatch the same way
                the connect button would. shouldShowMintNudge already keeps
                this off during a badge lookup or a Gateway failure. */}
            {mounted && shouldShowMintNudge(connected, !!badge, badgeLoading, badgeError) && (
              <Badge
                variant="default"
                className="hidden sm:inline-flex text-[11px]"
                render={<Link href="/mint" className="no-underline" />}
              >
                Get your badge
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <NotificationsMenu />
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon" title="Help" aria-label="Help" />}>
                <HelpCircle className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {pageGuide && (
                  <>
                    <DropdownMenuItem onClick={() => openGuide(pageGuide, { force: true })}>
                      <Sparkles className="h-4 w-4" />
                      {GUIDES[pageGuide]?.title ?? "Page walkthrough"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                {/* MVP-5 trim: the menu collapses to three evergreen entries.
                    /start and /how-it-works were merged into /guide; /trust
                    and /about live in the footer (every viewport), so they
                    are no longer duplicated here. */}
                <DropdownMenuItem render={<Link href="/guide" className="no-underline" />}>
                  <Compass className="h-4 w-4" />
                  Getting started
                </DropdownMenuItem>
                <DropdownMenuItem render={<Link href="/docs" className="no-underline" />}>
                  <BookOpen className="h-4 w-4" />
                  Docs &amp; FAQ
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  render={<a href={TG_GROUP_URL} target="_blank" rel="noopener noreferrer" className="no-underline" />}
                >
                  <MessageCircle className="h-4 w-4" />
                  Ask on Telegram
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Badge variant="outline" className="hidden sm:inline-flex font-mono text-xs text-primary">
              Mainnet
            </Badge>
            {mounted && <radix-connect-button />}
          </div>
        </div>
      </header>

      {/* Desktop Nav — grouped Build, ungrouped Mint + Docs */}
      <nav className="hidden sm:flex max-w-4xl mx-auto px-4 sm:px-6 gap-0.5 sm:gap-1 border-b overflow-x-auto">
        {NAV_GROUPS.map((group, gi) => (
          <Fragment key={group.label ?? gi}>
            {gi > 0 && (
              <Separator orientation="vertical" className="self-center h-4 mx-1 sm:mx-2" />
            )}
            {/* A decorative grouping heading, NOT a link — "Build" has never
                been a route and is not becoming one. An external reporter
                filed it on 2026-09-16 as "the Build option is unclickable",
                which is fair: on a tablet there is no hover state to
                distinguish a heading from the real tabs sitting beside it in
                the same row. `select-none` + `cursor-default` stop it
                behaving like something you can interact with, and
                `aria-hidden` keeps a screen reader from announcing a loose
                word inside <nav> — the links themselves carry the meaning.
                Whether this label should exist at all is an IA question, not
                a bug fix; see the PR discussion. */}
            {group.label && (
              <span
                aria-hidden="true"
                className="self-center pr-1 select-none cursor-default text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80"
              >
                {group.label}
              </span>
            )}
            {group.items.map((n) => (
              <Link
                key={n.path}
                href={n.path}
                className={`px-3 sm:px-4 py-3 text-[13px] font-medium no-underline whitespace-nowrap border-b-2 transition-colors ${
                  isActive(pathname, n.path)
                    ? "text-primary border-primary"
                    : "text-muted-foreground border-transparent hover:text-foreground"
                }`}
              >
                {n.label}
              </Link>
            ))}
          </Fragment>
        ))}
      </nav>

      {/* Main. The bottom clearance for the fixed mobile nav lives on the
          FOOTER now (below), because the footer is the last in-flow element on
          every viewport — putting pb-20 here too would just add dead space. */}
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-4 sm:py-6">{children}</main>

      {/* Footer — every viewport.
          It was `hidden sm:flex`, which quietly made /gift unreachable on a
          phone: the footer is the ONLY link to it, so a mobile visitor had no
          path to a donation surface except typing the URL. Since the MVP-5
          trim this is also the sole chrome link to /trust and /about (the
          Help menu no longer duplicates them), so it must stay on every
          viewport. The mobile bottom nav is `fixed`, so the footer carries
          pb-20 to clear its 56px — do not move that padding back to <main>.
          wrap + gap-y keeps the row from overflowing a 320px screen. */}
      <footer className="flex flex-wrap max-w-4xl mx-auto mt-8 sm:mt-12 px-4 sm:px-6 py-6 pb-20 sm:pb-6 border-t text-center items-center justify-center gap-x-4 gap-y-2 text-[13px] text-muted-foreground">
        <Link href="/trust" className="text-primary no-underline hover:underline">
          Trust
        </Link>
        <Separator orientation="vertical" className="h-4 hidden sm:block" />
        <Link href="/ledger" className="text-primary no-underline hover:underline">
          Ledger
        </Link>
        <Separator orientation="vertical" className="h-4 hidden sm:block" />
        <Link href="/about" className="text-primary no-underline hover:underline">
          About
        </Link>
        <Separator orientation="vertical" className="h-4 hidden sm:block" />
        <Link href="/bug-bounty" className="text-primary no-underline hover:underline">
          Bug Bounty
        </Link>
        <Separator orientation="vertical" className="h-4 hidden sm:block" />
        {/* Where to go when something is wrong: private report for money or
            security, the group for everything else (/trust, 2026-09-24). */}
        <Link href="/trust#if-something-goes-wrong" className="text-primary no-underline hover:underline">
          Report a problem
        </Link>
        <Separator orientation="vertical" className="h-4 hidden sm:block" />
        {/* Same truth condition as the route itself (/gift 404s when no gift
            destination is configured), so this can never link to a dead page. */}
        {isGiftPageLive() && (
          <>
            <Link href="/gift" className="text-primary no-underline hover:underline">
              Gifts
            </Link>
            <Separator orientation="vertical" className="h-4 hidden sm:block" />
          </>
        )}
        <span>Built on Radix</span>
      </footer>

      {/* Mobile Bottom Nav — 4 core destinations + a More menu (5-slot ceiling) */}
      <nav className="sm:hidden fixed bottom-0 left-0 right-0 z-50 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center justify-around h-14">
          {MOBILE_BAR.map((n) => {
            const Icon = n.icon;
            const active = isActive(pathname, n.path);
            return (
              <Link
                key={n.path}
                href={n.path}
                className={`flex flex-col items-center gap-0.5 px-2 py-1 no-underline transition-colors ${
                  active ? "text-primary" : "text-muted-foreground"
                }`}
              >
                <Icon className="h-5 w-5" />
                <span className="text-[10px] font-medium">{n.label}</span>
              </Link>
            );
          })}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label="More navigation"
                  className={`flex flex-col items-center gap-0.5 px-2 py-1 transition-colors ${
                    moreActive ? "text-primary" : "text-muted-foreground"
                  }`}
                />
              }
            >
              <MoreHorizontal className="h-5 w-5" />
              <span className="text-[10px] font-medium">More</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" sideOffset={8} className="w-44">
              {MOBILE_MORE.map((n) => {
                const Icon = n.icon;
                return (
                  <DropdownMenuItem
                    key={n.path}
                    render={<Link href={n.path} className="no-underline" />}
                  >
                    <Icon className="h-4 w-4" />
                    {n.label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </nav>
    </>
  );
}
