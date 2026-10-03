import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { disputeCopy } from "@/lib/settlement-copy";
import { withPageOg } from "@/lib/page-metadata";
import { TG_GROUP_HANDLE } from "@/lib/config";

// Beta bug-bounty page. INTERIM by design: this is an off-ledger, good-faith
// programme — NOT the provably-funded on-chain version. That one (posted as real
// on-chain Guild tasks, "next, now that the source is public" since the
// open-source flip) stays Planned on /trust; this page must not claim to be it.
//
// Honest-copy rules (P9): no "guaranteed", nothing is owed, and the scope
// names exactly what's live (happy-path marketplace) vs off (disputes, agent
// lane).
//
// ⚠️ THE PRICE TABLE IS GONE — read this before putting one back. ⚠️
//
// This page used to carry three tiers with USD figures on them: $5 / $25 /
// $200 "in XRD", discretionary, paid by the operator. Both halves of that
// were wrong, and they were wrong in opposite directions eight weeks apart.
//
//   • Until 2026-08-15 the tiers read "50–100 / 250–500 / 1,000+ XRD". XRD
//     was near $0.00092, so the TOP tier — a critical money-path finding —
//     was worth about ninety cents. Four figures of XRD reads as substantial
//     to anyone who does not check the rate and trivial to anyone who does.
//   • The fix was to quote USD and pay the XRD equivalent. That removed the
//     first asymmetry and created a worse one: a price the Guild cannot pay.
//     Measured 2026-09-16 against the Gateway (state_version 558368198) from
//     the post-sweep roster in `_safety/asset-ledger/asset-ledger-2026-09-12.csv`:
//     32,984 XRD across 28 accounts (~$27), plus 8,377 XRD committed inside
//     the escrow — 41,361 XRD, about $34, and that is EVERYTHING, working
//     capital included. One Medium finding at the posted $25 was 73% of every
//     account balance the Guild has; a High money-path finding at $200 was
//     5.8x the entire estate. The first external reporter sent four valid Low
//     reports in a single message, which came to $20 — most of it.
//
//     ⚠️ Count from the asset ledger CSV, not from a subset of the addresses
//     in docs. A first pass at this number used only the accounts named in
//     ESCROW-ADDRESSES.md and came out at 28,461 XRD, missing Sats admin 2's
//     3,682 XRD among others — a 20% undercount that would have been repeated
//     as fact. The CSV reconciles to the 2026-09-12 sweep total within 312 XRD.
//
// The second failure is the one worth naming, because the page's own comment
// had already diagnosed the first and still walked into it: a bounty page
// that quotes a number it cannot honour is the same asymmetry in a nicer
// font, and the readers are precisely the people who will check.
//
// It also contradicted the site's own ruling. Board note M5 (2026-09-03),
// ruling R1: XRD is the unit of account AND the settlement asset; USD is
// DISPLAY ONLY, never the promise. <XrdAmount> exists to enforce exactly that
// everywhere else on the site. This page promised USD.
//
// So: no prices. Severity now sets PRIORITY, not payment.
//
// ⚠️ 2026-09-24, bigdev: "cut to what's real". Until then this page also
// promised a credit "on the public ledger", XP on your Guild profile, and "a
// dated claim on the reward pool, honoured in severity order once the pool is
// funded". Nothing implements any of them: /ledger lists escrow events only,
// Guild XP has one writer (awardTaskCompletion, on task settlement), and no
// pool or claim record exists. What IS real, and all this page now offers:
// report privately, get a reply and a straight answer, and credit by name or
// handle in the Guild's Telegram group when the fix ships, if the reporter
// wants it. No pool line either: the dormant "the pool is open" branch
// (BOUNTY_FUND) was removed the same day — a pool that exists gets its own
// change, with its address, when it exists.

export const metadata: Metadata = withPageOg("/bug-bounty", {
  title: "Bug Bounty (Beta) — Radix Guild",
  description:
    "Beta bug bounty: report issues in the live escrow marketplace privately and in good faith. You get a reply, a straight answer and, when the fix ships, credit by name or handle if you want it. Cash rewards are paused.",
});

// Severity bands. These set how fast a report is looked at — they are NOT
// prices, and must never carry a currency figure again. See the block comment
// above.
const BANDS = [
  {
    level: "Low",
    priority: "Queued",
    tone: "outline" as const,
    examples:
      "UI/UX defects, broken links, display or copy errors, non-security state desyncs the resync button already heals.",
  },
  {
    level: "Medium",
    priority: "Looked at this week",
    tone: "secondary" as const,
    examples:
      "Auth/session edge cases, badge-gate bypass, API input-validation gaps, denial-of-service on a route.",
  },
  {
    level: "High — money path",
    priority: "Dropped everything",
    tone: "default" as const,
    examples:
      "Anything that lets funds move to the wrong party, a task settle for the wrong amount, or a funded task be edited/cancelled off the escrow path. These come first, always.",
  },
];

// What a report gets you today. Every line here is something the operator
// actually does (bigdev, 2026-09-24). If a line ever becomes untrue, delete
// it; do not soften it.
const EARNS = [
  "A reply, and a straight answer about what we did with it — fixed, deferred or disagreed, with the reasoning.",
  `Credit by name or handle in the ${TG_GROUP_HANDLE} Telegram group when the fix ships, if you want it.`,
];

// The dispute-flow line lives in DISPUTE_COPY and moves lists with the build's
// dispute flag: OFF puts it out of scope, ON puts it in — exactly one form is
// non-null per era, so neither list can carry a stale entry.
const IN_SCOPE = [
  "radixguild.com — the live dashboard (badge mint, task board, post/claim/submit/approve).",
  "The escrow confirm + settlement path: anything that moves XRD to the wrong place or amount.",
  ...(disputeCopy("bugBountyDisputeInScope") ? [disputeCopy("bugBountyDisputeInScope")!] : []),
  "The v1 API under /api/v1/* (auth, tasks, submissions, escrow confirm).",
  "Badge-gating and session/account-mismatch handling.",
];

const OUT_OF_SCOPE = [
  ...(disputeCopy("bugBountyDisputeOutOfScope") ? [disputeCopy("bugBountyDisputeOutOfScope")!] : []),
  "The dedicated agent-badge (GAGENT) lane — still in pilot. Agents working tasks with a Guild Member badge use the same in-scope escrow paths above, so report those.",
  "The NFT grid game — switched off for now.",
  "Findings that require a compromised wallet, stolen keys, or social engineering of the operator.",
  "The Scrypto blueprint's internal security: no independent audit is scheduled yet. Findings about the on-chain blueprint are still welcome.",
];

const RULES = [
  "Report privately first. DM the operator (link below) — do NOT post exploit details publicly or open a public issue until it's fixed.",
  "Good faith only: no live-funds theft, no attacks on other users, no automated scanning that degrades the service. Use small amounts and your own accounts.",
  "One reporter per issue — first clear, reproducible report. Include steps, expected vs actual, and (for money-path) the on-chain tx or task id.",
  // Task #99 checked 2026-09-24 on /api/v1/tasks/99: open, funded on-chain
  // (chain task 35), 765 XRD, "Find something we say that is not true".
  // Update or delete this sentence when #99 is claimed, paid or cancelled.
  "No report is paid in cash, and nothing here is a contract. What you can count on is a reply and a straight answer — and credit by name or handle when the fix ships, if you want it. If you hold a Guild badge, task #99 (765 XRD) pays through the escrow for finding something this site says that isn't true.",
];

export default function BugBountyPage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-8 py-4">
        <header className="space-y-3">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">Bug Bounty</h1>
            <Badge variant="outline" className="border-primary/30 text-primary">
              Beta
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Radix Guild is in beta. Help find the sharp edges before a wider launch: report an
            issue privately and in good faith, and you get a reply, a straight answer and, when the
            fix ships, credit by name or handle if you want it. What is checkable today, and the
            known issues:{" "}
            <Link href="/trust" className="text-primary hover:underline">
              Trust &amp; Verification
            </Link>
            .
          </p>
        </header>

        {/* The funding state, stated before anything else on the page. A reader
            deciding whether to spend an evening on this deserves to know what
            is behind it in the first paragraph, not in a footnote under the
            rules. */}
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Cash rewards are paused</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs text-muted-foreground leading-relaxed">
            <p>
              This page no longer posts a price per severity, and{" "}
              <span className="text-foreground">no cash reward is promised for anything on this page.</span>{" "}
              What a report does get you is below — and reports are wanted: the queue is real, and
              the fixes ship.
            </p>
          </CardContent>
        </Card>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            What a report gets you
          </h2>
          <ul className="space-y-2 text-xs text-muted-foreground">
            {EARNS.map((e) => (
              <li key={e} className="flex gap-2">
                <span className="text-primary">✓</span>
                <span className="leading-relaxed">{e}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Severity bands
          </h2>
          <p className="text-xs text-muted-foreground">
            These set how fast a report gets looked at. They are not prices.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {BANDS.map((b) => (
              <Card key={b.level}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-sm">
                    <span>{b.level}</span>
                  </CardTitle>
                  <Badge variant={b.tone} className="w-fit font-mono text-xs">
                    {b.priority}
                  </Badge>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground leading-relaxed">{b.examples}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">In scope</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-xs text-muted-foreground">
                {IN_SCOPE.map((s) => (
                  <li key={s} className="flex gap-2">
                    <span className="text-primary">✓</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Out of scope (for now)</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-xs text-muted-foreground">
                {OUT_OF_SCOPE.map((s) => (
                  <li key={s} className="flex gap-2">
                    <span className="text-muted-foreground/60">—</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Rules
          </h2>
          <ol className="space-y-2 text-xs text-muted-foreground">
            {RULES.map((r, i) => (
              <li key={r} className="flex gap-2">
                <span className="font-mono text-primary">{i + 1}.</span>
                <span className="leading-relaxed">{r}</span>
              </li>
            ))}
          </ol>
        </section>

        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="flex flex-col gap-3 py-5 text-center">
            <p className="text-sm font-medium">Found something? Report it privately.</p>
            <p className="text-xs text-muted-foreground">
              DM the operator directly on Telegram. For a money-path issue, include the
              task id and the on-chain transaction so we can verify it fast.
            </p>
            <div className="flex justify-center pt-1">
              {/* Was a link to the /feedback dashboard (public ticket list) —
                  removed with that route in the MVP-5 trim, and a DM is the
                  honest match for "report it privately" anyway. */}
              <a
                href="https://t.me/bigdev_xrd"
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground no-underline hover:opacity-90"
              >
                Report an issue
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
