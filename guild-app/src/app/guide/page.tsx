import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/copy-button";
import { ESCROW_CLAIM_BOND_XRD, ESCROW_COMPONENT, SITE_URL, TG_BOT_HANDLE, TG_BOT_URL, TG_GROUP_URL } from "@/lib/constants";
import { Bug, Eye, Monitor, Smartphone } from "lucide-react";
import { disputeCopy, settlementCopy } from "@/lib/settlement-copy";
import { BotPausedNote } from "@/components/network-halt-notice";
import { BUG_BOUNTY_CALLOUT } from "@/content/bug-bounty-callout";
import { withPageOg } from "@/lib/page-metadata";
import { XRD_NEEDED_LINE } from "@/lib/xrd-needed";

// /guide — the single getting-started surface (MVP-5 trim). It absorbed two
// former pages, both now redirect() shells pointing here:
//   • /start   — the "New to Radix?" onboarding + share page (wallet setup,
//                browse-without-connecting, the 1-2-3 connect flow).
//   • /how-it-works — the in-app twin of docs/HOW-IT-WORKS.md (the flow with
//                honesty markers, dispute insurance, why-trust, agents).
// Copy is folded largely VERBATIM: every sentence below already shipped on a
// gated cold route, so it is known-clean against scripts/honest-copy.mjs —
// reword here only with that rule table open. P9 still applies: every
// user-facing claim carries deployed-vs-planned markers until vNext2 ships.

export const metadata: Metadata = withPageOg("/guide", {
  title: "Getting Started — Radix Guild",
  description:
    "New to Radix? Start here: wallet setup, how the task marketplace works — what is live and what is planned — and your roadmap to joining and earning on Radix Guild.",
});

// Official Radix wallet hub — hosts both the mobile wallet (iOS/Android) and
// the Connector browser extension.
const WALLET_URL = "https://wallet.radixdlt.com";


// The flow — folded verbatim from /how-it-works (in-app twin of
// docs/HOW-IT-WORKS.md).
const FLOW = [
  {
    step: "1",
    title: "Post, then fund — two steps",
    body: "Posting costs nothing and needs no on-chain transaction: you sign in with your wallet, and it lists the task. Funding is a second, signed transaction — that one moves the reward into escrow and commits your terms (acceptance criteria, deadline, revision count) on-chain as a hash of the brief. Until it lands, the task sits unfunded and nobody can claim it. The deal both sides see is the deal that settles. Tasks are never claimable unless funded. Rule one.",
  },
  {
    step: "2",
    title: "Claim",
    body: settlementCopy("guideClaimBody")!,
  },
  {
    step: "3",
    title: "Deliver",
    body: "Work is submitted with its evidence committed on-chain. Where the submission links a GitHub PR, one click checks it against your committed definition of done — merged state, green CI, review approval — and stores the verdict on the submission.",
  },
  {
    step: "4",
    title: "Review window",
    body: "Your terms commit the poster to reviewing within N days (default 3, set per-task) — approve or request a revision. That number is a promise recorded in the committed brief, not a timer tied to it. The deployed escrow enforces its own fixed review window instead (currently 3 days from submission): if the poster stays silent past it, anyone may trigger a release for the full reward, no approval needed. Workers face the claim deadline: an hour after it, anyone can expire the claim and the bond is forfeited. Posters now face a clock too — just the escrow's own, not necessarily the one they set in their terms.",
  },
  {
    step: "5",
    title: "Settle",
    body: settlementCopy("guideSettleBody")!,
  },
  {
    step: "6",
    title: "Reputation",
    body: "Every settlement accrues to a trust record derived from the ledger — completions, on-time rate, disputes — recomputed on read, with no stored score. No applications and no claim gates: any badge holder can claim. Eligibility in the brief is not enforced. The Guild Member badge is a separate thing: a public mint anyone can call for the network fee — it records membership, not identity, and it is not a review or a rating.",
  },
];

const WHY_TRUST = [
  {
    title: "The platform never signs for you.",
    body: settlementCopy("guideKeysBody")!,
  },
  {
    title: "Terms are data.",
    body: "Committed on-chain at funding; disputes are judged against the committed brief, not against chat history.",
  },
  {
    title: "Every on-chain claim is checkable.",
    body: "Component addresses and configuration are published — see the auditor’s guide. The source opens at launch, and no date is set.",
  },
  {
    title: "Open problems, in the open.",
    body: "Where no clean mechanism exists yet, the UI says so and shows the best available. Got a better design? Post it as a task — the aim is a Guild that builds itself.",
  },
];

const SHARE_DISPLAY_URL = SITE_URL.replace(/^https?:\/\//, "") + "/guide";

function GuideContent() {
  return (
    <div className="space-y-16 py-4">
      {/* Hero */}
      <header className="text-center space-y-4">
        <Badge variant="outline" className="text-xs tracking-widest text-primary border-primary/30 bg-primary/5">
          GETTING STARTED
        </Badge>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight">
          Welcome to{" "}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#2dd4bf] via-[#a78bfa] to-[#f59e0b]">
            Radix Guild
          </span>
        </h1>
        <p className="text-muted-foreground max-w-xl mx-auto">
          Your roadmap to joining and earning on Radix Guild: a task marketplace on Radix where every settled task adds to a track record anyone can check — plus the optional community votes beside it.
        </p>
      </header>

      {/* New to Radix? — wallet setup + connect flow, folded from /start */}
      <section className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
              New to Radix?
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm leading-relaxed">
              Radix is a layer-1 network built for decentralized apps. Two things
              set it apart: assets are native objects on the ledger itself — not
              balances inside contract code — and every transaction is a
              human-readable manifest, so your wallet shows exactly what will
              move before you sign.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <a
                href={WALLET_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="block bg-muted rounded-lg p-4 no-underline text-foreground hover:bg-accent/10 transition-colors"
              >
                <div className="flex items-center gap-2 mb-1">
                  <Smartphone className="h-4 w-4 text-primary" />
                  <span className="font-semibold text-sm">Radix Wallet</span>
                  <Badge variant="secondary" className="text-[9px]">
                    iOS / Android
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  The official mobile wallet. Free, and your keys stay on your
                  phone.
                </p>
              </a>
              <a
                href={WALLET_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="block bg-muted rounded-lg p-4 no-underline text-foreground hover:bg-accent/10 transition-colors"
              >
                <div className="flex items-center gap-2 mb-1">
                  <Monitor className="h-4 w-4 text-primary" />
                  <span className="font-semibold text-sm">Radix Connector</span>
                  <Badge variant="secondary" className="text-[9px]">
                    Chrome extension
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Links the mobile wallet to dApps in your desktop browser — this
                  site included.
                </p>
              </a>
            </div>
            <p className="text-xs text-muted-foreground">
              Both downloads live at the official page:{" "}
              <a
                href={WALLET_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-primary hover:underline"
              >
                wallet.radixdlt.com
              </a>
              .
            </p>
            {/* Until 2026-10-03 this card ended in a one-line "no XRD" note: true of installing
                and connecting, but it read as "no XRD is needed", and /mint hard-blocks a zero
                balance while a claim locks a bond. The line is shared with /mint and derived
                from the bond-floor and fee constants (lib/xrd-needed.ts), never retyped. */}
            <p className="text-xs text-muted-foreground" data-testid="xrd-needed">
              {XRD_NEEDED_LINE}
            </p>
          </CardContent>
        </Card>

        <Card className="border-primary/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
              Before you install anything
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg bg-primary/5 border border-primary/20 p-4">
              <div className="flex items-center gap-2 mb-1">
                <Eye className="h-4 w-4 text-primary" />
                <span className="font-semibold text-sm">
                  No wallet? Browse anyway.
                </span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                The task board is public and read-only — browse it before you
                install anything. Every task shows whether its escrow is funded
                yet, and don&apos;t take our word for the funded ones: each
                points at an on-chain balance you can check yourself.
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
                <Link href="/tasks" className="text-primary hover:underline">
                  Open the task board &rarr;
                </Link>
                <a
                  href={`https://dashboard.radixdlt.com/component/${ESCROW_COMPONENT}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Inspect the escrow component &rarr;
                </a>
              </div>
            </div>

            {/* /bug-bounty is the one thing on the site a visitor can DO with no
                wallet, badge, bond or repo access. It reached the homepage on
                2026-09-16 (#684); the launch runway put it on /guide as well,
                because this card is where a visitor who has not installed
                anything yet is reading. The copy is the homepage callout's,
                imported rather than retyped, so bug-bounty-callout.test.ts
                (source) and launch-check CHECK 4 (built /guide, a COLD_ROUTE)
                both gate it — including its no-payment-promise assertions. */}
            <div className="rounded-lg bg-primary/5 border border-primary/20 p-4">
              <div className="flex items-center gap-2 mb-1">
                <Bug className="h-4 w-4 text-primary" />
                <span className="font-semibold text-sm">
                  {BUG_BOUNTY_CALLOUT.title}
                </span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {BUG_BOUNTY_CALLOUT.body}
              </p>
              <p className="text-[11px] text-muted-foreground leading-relaxed mt-1">
                {BUG_BOUNTY_CALLOUT.fundingNote}
              </p>
              <div className="mt-2 text-xs">
                <Link href={BUG_BOUNTY_CALLOUT.href} className="text-primary hover:underline">
                  {BUG_BOUNTY_CALLOUT.ctaLabel} &rarr;
                </Link>
              </div>
            </div>

            {/* The 1-2-3 Install / Connect / Browse grid was REMOVED here
                2026-08-21. The "01 Identity & Onboarding" section one scroll
                below covers the same three steps in more detail, so the page
                opened with two different onboarding lists in two different
                visual languages. What stays above is the part section 01 does
                NOT have: you can look before you install anything. */}
          </CardContent>
        </Card>
      </section>

      {/* Step 1: Identity */}
      <section className="relative">
        <div className="absolute -left-2 top-0 text-[120px] font-black text-primary/5 select-none leading-none hidden sm:block">01</div>
        <div className="rounded-2xl border border-primary/20 bg-primary/5 backdrop-blur p-6 sm:p-10 shadow-[0_0_30px_rgba(45,212,191,0.08)]">
          <div className="flex flex-col md:flex-row gap-8 items-center">
            <div className="flex-1 space-y-6">
              <h2 className="text-2xl sm:text-3xl font-bold flex items-center gap-3">
                <span className="w-9 h-9 rounded-lg bg-[#2dd4bf] flex items-center justify-center text-white text-xs font-bold shadow-[0_0_15px_rgba(45,212,191,0.4)]">ID</span>
                Identity &amp; Onboarding
              </h2>
              {[
                { step: "01", title: "Connect Radix Wallet", desc: "Download the official Radix Wallet and connect with one click. Your wallet is your identity.", link: null },
                { step: "02", title: "Mint a Free Badge", desc: "Choose a username and mint your Guild Badge — an on-chain NFT, free but for the network fee, that records your Guild membership. Your XP and trust record are account records; your tier is the badge's own on-chain field, set at mint. The badge's XP field can be written only by the operator, with an admin badge — it was written six times in April 2026, never since — and a task payout never reaches it.", link: "/mint" },
                { step: "03", title: "Register in Telegram", desc: "Open " + TG_BOT_HANDLE + " and type /register with your wallet address. This links your wallet to your Telegram account, so the bot can check your badge and you can take part in the community votes.", link: TG_BOT_URL },
              ].map((s, i) => (
                <div key={s.step} className={`flex gap-4 ${i > 0 ? "border-l-2 border-[#2dd4bf]/20 ml-2 pl-5" : ""}`}>
                  <div className="text-[#2dd4bf] font-mono font-bold pt-0.5 shrink-0">{s.step}</div>
                  <div>
                    <h4 className="font-bold text-sm">{s.title}</h4>
                    <p className="text-muted-foreground text-xs mt-0.5">{s.desc}</p>
                    {s.link && (
                      <Link href={s.link} className="text-xs text-primary hover:underline mt-1 inline-block" target={s.link.startsWith("http") ? "_blank" : undefined}>
                        {s.link.startsWith("http") ? "Open Bot" : "Go to " + s.title} &rarr;
                      </Link>
                    )}
                    {s.step === "03" && <BotPausedNote className="mt-1" />}
                  </div>
                </div>
              ))}
            </div>
            <div className="w-full md:w-64 h-64 bg-gradient-to-br from-[#2dd4bf]/10 to-transparent rounded-2xl border border-[#2dd4bf]/20 flex items-center justify-center">
              <div className="w-36 h-48 rounded-xl border border-[#2dd4bf]/30 bg-card/50 backdrop-blur flex flex-col items-center justify-center p-4 hover:scale-105 transition-transform">
                <div className="w-10 h-10 rounded-full bg-[#2dd4bf]/20 mb-3 animate-pulse" />
                <div className="w-full h-1.5 bg-[#2dd4bf]/20 rounded mb-1.5" />
                <div className="w-2/3 h-1.5 bg-[#2dd4bf]/10 rounded" />
                <div className="mt-6 text-[9px] text-[#2dd4bf] font-mono tracking-wider">GUILD BADGE NFT</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Step 2: Community votes. Was headed "Governance & Decisions" until
          2026-09-23 — the 2026-09-07 ruling: the Guild runs no governance
          programme of its own ("we build only"). The optional Telegram polls
          are real and stay here, named for what they are. */}
      <section className="relative">
        <div className="absolute -right-2 top-0 text-[120px] font-black text-[#a78bfa]/5 select-none leading-none text-right w-full hidden sm:block">02</div>
        <div className="rounded-2xl border border-[#a78bfa]/20 bg-[#a78bfa]/5 backdrop-blur p-6 sm:p-10 shadow-[0_0_30px_rgba(167,139,250,0.08)]">
          <div className="flex flex-col md:flex-row-reverse gap-8 items-center">
            <div className="flex-1 space-y-4">
              <h2 className="text-2xl sm:text-3xl font-bold flex items-center gap-3">
                <span className="w-9 h-9 rounded-lg bg-[#a78bfa] flex items-center justify-center text-white text-xs font-bold shadow-[0_0_15px_rgba(167,139,250,0.4)]">VOTE</span>
                Community Votes
              </h2>
              {[
                // "Nothing here is binding" is true of BOTH voting surfaces
                // (off-chain Telegram and on-chain CV2).
                { title: "Nothing Here Is Binding", desc: "Community votes are an optional layer on the task marketplace: free, off-chain and non-binding, run through the Telegram bot. None of them can move escrowed funds or change a platform parameter.", color: "text-[#a78bfa]" },
                { title: "Two Kinds of Vote", desc: "Free off-chain votes in Telegram, one per Telegram account, plus on-chain CV2 temperature checks readable via the bot. No tier weighting exists or is planned, and CV2's own weighting is XRD-based. CV2 is parked indefinitely: reads stay live, voting is off.", color: "text-[#a78bfa]" },
              ].map(item => (
                <div key={item.title} className="p-3.5 bg-[#a78bfa]/5 rounded-xl border border-[#a78bfa]/10 hover:bg-[#a78bfa]/10 transition-colors">
                  <h4 className={`font-bold text-sm ${item.color} mb-0.5`}>{item.title}</h4>
                  <p className="text-muted-foreground text-xs">{item.desc}</p>
                </div>
              ))}
            </div>
            <div className="w-full md:w-72 space-y-2">
              <div className="grid grid-cols-3 gap-2">
                {["Yes!", "Maybe", "No"].map(opt => (
                  <div key={opt} className="h-16 bg-[#a78bfa]/10 rounded-lg border border-[#a78bfa]/20 flex items-center justify-center text-xs font-bold text-[#a78bfa]">
                    {opt}
                  </div>
                ))}
              </div>
              <div className="h-14 bg-card/50 rounded-lg border border-border p-3">
                <div className="w-full h-full bg-[#a78bfa]/10 rounded relative overflow-hidden">
                  <div className="absolute left-0 top-0 bottom-0 bg-[#a78bfa]/60 w-[65%] rounded" />
                </div>
                <div className="flex justify-between text-[8px] text-muted-foreground font-mono mt-1">
                  {/* Was "CONVICTION: 65%" / "5 DAYS LEFT" — hardcoded numbers that read as a
                      live, ticking vote beside prose saying voting is parked (audit, 2026-09-20). */}
                  <span>ILLUSTRATION</span>
                  <span>NOT A LIVE VOTE</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Step 3: Bounties */}
      <section className="relative">
        <div className="absolute -left-2 top-0 text-[120px] font-black text-[#f59e0b]/5 select-none leading-none hidden sm:block">03</div>
        <div className="rounded-2xl border border-[#f59e0b]/20 bg-[#f59e0b]/5 backdrop-blur p-6 sm:p-10 shadow-[0_0_30px_rgba(245,158,11,0.08)]">
          <div className="text-center mb-8">
            <h2 className="text-2xl sm:text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-[#f59e0b] to-[#f97316]">
              The Task Pipeline
            </h2>
            <p className="text-muted-foreground text-sm mt-1">Earn XRD and XP by completing tasks for the community.</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { step: "1", label: "CLAIM", desc: `Browse funded tasks and claim one that fits. Claiming locks a bond of 10% of the task reward, at least ${ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting), held until the task settles and then credited back to you, unless a dispute is raised, in which case it is split the same way as the reward. It is at risk once your deadline passes.`, color: "text-[#f59e0b]" },
              { step: "2", label: "WORK", desc: "Complete the deliverable. Submit a GitHub PR or proof of work.", color: "text-[#f59e0b]" },
              { step: "3", label: "VERIFY", desc: "The poster reviews and approves. If the task set a PR-merge check, the reviewer clicks verify to confirm the merge — automatic polling is planned, not live.", color: "text-[#f59e0b]" },
              { step: "4", label: "PAYOUT", desc: "The poster approves, which credits your reward inside escrow, plus XP — you collect it with your own signed withdrawal." + (disputeCopy("guidePipelinePayoutTail") ?? ""), color: "text-primary", highlight: true },
            ].map(s => (
              <div key={s.step} className={`p-4 rounded-xl border text-center ${s.highlight ? "bg-[#f59e0b]/10 border-[#f59e0b]/30" : "bg-card/50 border-border"}`}>
                <div className={`w-10 h-10 rounded-full ${s.highlight ? "bg-[#f59e0b]/30" : "bg-[#f59e0b]/10"} flex items-center justify-center mx-auto mb-3 ${s.color} text-sm font-bold`}>
                  {s.step}
                </div>
                <h4 className={`font-bold text-xs mb-1 ${s.highlight ? "text-[#f59e0b]" : ""}`}>{s.label}</h4>
                <p className="text-[10px] text-muted-foreground leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
          <div className="text-center mt-6">
            <Link href="/tasks"><Button size="sm" variant="outline">Browse Tasks &rarr;</Button></Link>
          </div>
        </div>
      </section>

      {/* Step 4: XP & Tiers */}
      <section className="relative">
        <div className="absolute -right-2 top-0 text-[120px] font-black text-[#f472b6]/5 select-none leading-none text-right w-full hidden sm:block">04</div>
        <div className="rounded-2xl border border-[#f472b6]/20 bg-[#f472b6]/5 backdrop-blur p-6 sm:p-10 shadow-[0_0_30px_rgba(244,114,182,0.08)]">
          <h2 className="text-2xl sm:text-3xl font-bold mb-6 flex items-center gap-3">
            <span className="w-9 h-9 rounded-lg bg-[#f472b6] flex items-center justify-center text-white text-xs font-bold shadow-[0_0_15px_rgba(244,114,182,0.4)]">XP</span>
            XP &amp; Tiers
          </h2>
          <div className="grid grid-cols-5 gap-2 sm:gap-3 mb-6">
            {[
              { tier: "Member", xp: "0", color: "#2dd4bf" },
              { tier: "Contributor", xp: "100", color: "#4ea8de" },
              { tier: "Builder", xp: "500", color: "#a78bfa" },
              { tier: "Steward", xp: "2,000", color: "#f59e0b" },
              { tier: "Elder", xp: "10,000", color: "#f472b6" },
            ].map(t => (
              <div key={t.tier} className="text-center p-2 sm:p-3 rounded-xl bg-card/50 border border-border">
                <div className="w-6 h-6 sm:w-8 sm:h-8 rounded-full mx-auto mb-1.5" style={{ backgroundColor: t.color + "30", border: `2px solid ${t.color}` }} />
                <div className="text-[10px] sm:text-xs font-bold">{t.tier}</div>
                <div className="text-[9px] text-muted-foreground font-mono">{t.xp} XP</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            {/* Guild XP (`users.xp`, the number in the header pill) is written
                only by escrow-confirm.ts when a task settles (awardTaskCompletion,
                src/db/queries/users.ts). The TIER shown anywhere in the app is
                the badge NFT's own on-chain `tier`/`level` field (badge-card,
                tier-progression, app-shell, profile) — nothing computes a tier
                from Guild XP, so the ladder above is thresholds, not a live
                progression. Said plainly below the table.

                ⚠️ Rewritten 2026-09-23. This listed four Telegram actions (vote,
                proposal, dice, temperature check) as earning "Badge XP
                (Telegram)". Both halves were false: the badge NFT's xp field is
                written only by the operator's admin badge (update_xp — six calls,
                all on one badge, 2026-04-04 → 04-06, signed by the old bot key
                RX-01; none since — corrected 2026-09-24 from the badge manager's
                transaction stream, which contradicts the earlier "done once, by
                hand" and "the bot's XP queue has never applied a single row").
                The dice game is
                switched off. What is true: the bot keeps its own points, and they
                reach neither the badge nor Guild XP. */}
            {[
              { action: "Complete a task", xp: "10–100 XP", note: "Set by the reward size — the only source of Guild XP", tier: true },
              { action: "Telegram votes & polls", xp: "Bot points", note: "Kept by the bot — not added to your Guild XP", tier: false },
            ].map(a => (
              <div key={a.action} className="flex items-center justify-between bg-card/50 rounded-lg px-3 py-2 border border-border">
                <span className="text-muted-foreground text-[11px]">
                  {a.action}
                  <span className="block text-[9px] opacity-70">{a.note}</span>
                </span>
                <span className="font-mono text-[#f472b6] text-[11px] font-bold">{a.xp}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground mt-4">
            The tier shown on your badge is the badge&rsquo;s own on-chain field, which only the
            operator can set — Guild XP does not move it automatically. A tier carries no
            permissions.
          </p>
        </div>
      </section>

      {/* Step 5: Working Groups */}
      <section className="relative">
        <div className="absolute -left-2 top-0 text-[120px] font-black text-[#00e49f]/5 select-none leading-none hidden sm:block">05</div>
        <div className="rounded-2xl border border-[#00e49f]/20 bg-[#00e49f]/5 backdrop-blur p-6 sm:p-10 shadow-[0_0_30px_rgba(0,228,159,0.08)]">
          <h2 className="text-2xl sm:text-3xl font-bold mb-4 flex items-center gap-3">
            <span className="w-9 h-9 rounded-lg bg-[#00e49f] flex items-center justify-center text-white text-xs font-bold shadow-[0_0_15px_rgba(0,228,159,0.4)]">WG</span>
            Join a Working Group
          </h2>
          {/* ⚠️ Fixed 2026-08-29. This hardcoded FIVE groups that do not exist
              (Guild, DAO, Infrastructure, Biz Dev, Marketing), described leads
              and charters that no group has, and told people to join with a
              "/group join" Telegram command that is not how joining works. The
              same five-group fiction was already found and removed from /docs;
              this page was missed. The six below are the groups actually seeded
              by scripts/seed-working-groups.mjs — keep them in sync with it. */}
          <p className="text-muted-foreground text-sm mb-6">Channels that route tasks to the people who care about them. A group has no lead, no budget and no vote — it decides nothing, it routes. Join one on the Groups page. You can set a notification level, but nothing sends notifications yet.</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              { name: "Scrypto & Blueprints", icon: "⛓️", desc: "Blueprints, manifests, ledger tests" },
              { name: "Frontend & UX", icon: "🖥️", desc: "Pages, wallet flows, copy" },
              { name: "Agents & A2A", icon: "🤖", desc: "Agent client, headless workers, MCP" },
              { name: "Infra & Ops", icon: "🔧", desc: "Deploys, keepers, backups" },
              { name: "Docs & Research", icon: "📚", desc: "Guides, references, write-ups" },
              { name: "Design", icon: "🎨", desc: "Visual and interaction design" },
            ].map(g => (
              <div key={g.name} className="flex items-center gap-2.5 bg-card/50 rounded-xl px-3 py-3 border border-border hover:bg-[#00e49f]/5 transition-colors">
                <span className="text-lg">{g.icon}</span>
                <div>
                  <div className="text-xs font-bold">{g.name}</div>
                  <div className="text-[9px] text-muted-foreground">{g.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="text-center mt-6">
            <Link href="/groups"><Button size="sm" variant="outline">Browse Groups &rarr;</Button></Link>
          </div>
        </div>
      </section>

      {/* How the Guild works — folded from /how-it-works (the in-app twin of
          docs/HOW-IT-WORKS.md). Deployed-vs-planned honesty markers intact. */}
      <section className="space-y-6" id="how-it-works">
        <div>
          <h2 className="text-xl font-bold">How the Guild Works</h2>
          <p className="text-muted-foreground text-sm mt-1">
            The light version. For the deep dive — state machine, auth patterns, verification
            recipes — see the{" "}
            <Link href="/auditor-guide" className="text-primary hover:underline">
              auditor&rsquo;s guide
            </Link>
            .
          </p>
        </div>

        {/* Live vs planned — every section below says which it is */}
        <Card className="border-primary/40">
          <CardContent className="pt-5 pb-5 space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">Live vs planned</Badge>
              <span className="text-xs text-muted-foreground">what runs today, and what is designed next</span>
            </div>
            <p className="text-sm leading-relaxed">
              <span className="font-semibold">Live on mainnet today:</span> fund / claim / submit /
              approve-and-release escrow, the claim bond (10% of the reward, at least{" "}
              {ESCROW_CLAIM_BOND_XRD} XRD today, an owner setting), and the review-window release — if the
              poster never approves, anyone may trigger it once the review window lapses (currently
              3 days from submission), and it credits exactly what an approval credits. That release
              has run on the live component (first on 24 September 2026).
              <span className="font-semibold">{disputeCopy("guideDisputeLabel")}</span>
              {disputeCopy("guideDisputeBody")}
            </p>
            <p className="text-sm leading-relaxed">
              <span className="font-semibold">Designed, not yet scheduled:</span>{" "}
              optional dispute insurance (&ldquo;no insurance, no
              dispute&rdquo;), mutual split offers, instant-settlement mode. The{" "}
              <Link href="/auditor-guide#economics" className="text-primary hover:underline">
                auditor&rsquo;s guide
              </Link>{" "}
              tracks what is deployed and what is planned, method by method.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5 pb-5">
            <p className="text-sm leading-relaxed">
              <span className="font-semibold">The Guild is a marketplace for commissioning Radix
              dApp work</span> — from developers and from AI agents — with real on-chain escrow on
              Radix mainnet. Today, getting web3 work done means hiring a big firm or trawling
              Discord and praying. This is the third option.
            </p>
          </CardContent>
        </Card>

        {/* The flow */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">The Flow</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {FLOW.map((s) => (
                <div key={s.step} className="flex items-start gap-3">
                  <div className="bg-primary text-primary-foreground rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">
                    {s.step}
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{s.title}</div>
                    <div className="text-xs text-muted-foreground leading-relaxed mt-0.5">{s.body}</div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Dispute insurance */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
              Dispute Insurance — Today and Planned <Badge variant="outline" className="ml-2 text-[10px] align-middle">Planned</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed">
              {settlementCopy("guideInsuranceTodayNote")}
              <span className="font-semibold"> Planned, not scheduled:</span> turn that amount into
              opt-in dispute coverage — a prepaid arbiter fee, refunded in full if never used —
              so coverage becomes a signal workers can price. None of that second half is live,
              and no task today can be posted as non-disputable.
            </p>
          </CardContent>
        </Card>

        {/* Why trust it */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Why Trust It</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {WHY_TRUST.map((w) => (
                <div key={w.title} className="bg-muted rounded-lg p-3">
                  <div className="font-semibold text-sm mb-1">{w.title}</div>
                  <div className="text-xs text-muted-foreground leading-relaxed">{w.body}</div>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Full verification recipes, address by address:{" "}
              <Link href="/trust" className="text-primary hover:underline">trust &amp; verification</Link>.
            </p>
          </CardContent>
        </Card>

        {/* Agents + big engagements */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">For Agents</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Machine-readable terms (<code className="font-mono">terms.acceptanceCriteria[]</code>,
                repo, deadlines via API) and programmatic claims — both live today on the member
                badge lane. Terms are there when the poster filled them in; many tasks carry none,
                and then the description is the whole brief. Starting from a bare key:{" "}
                <Link href="/agents#cold-start" className="text-primary hover:underline">/agents</Link>. Instant settlement (auto-release on delivery, gated by automatic
                checks) is a design, not a live mode. Nothing on-chain ties an agent to a
                human: the member badge is a public mint that any key can hold.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Big Engagements</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground leading-relaxed">
                <span className="font-semibold">Planned — not available yet:</span> for tasks
                and projects over $50k USD, a third party would attest the operator&rsquo;s
                identity and commitments — accountability without public doxxing. No trustee is
                retained and no provider is named yet.
              </p>
            </CardContent>
          </Card>
        </div>

        <p className="text-xs text-muted-foreground text-center">
          Built on Radix mainnet, where pilot tasks have settled end to end. In beta — feedback
          and early testers welcome:{" "}
          <a href={TG_GROUP_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            Telegram
          </a>
          . Auditors and the curious:{" "}
          <Link href="/auditor-guide" className="text-primary hover:underline">auditor&rsquo;s guide</Link>.
        </p>
      </section>

      {/* Share this page — folded from /start, repointed at /guide */}
      <Card className="border-dashed">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
            Send someone this page
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground leading-relaxed">
            This page is the link. Everything needed to go from zero — no
            wallet, no XRD, no Radix background — to browsing funded on-chain
            work is right here.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate bg-muted rounded-lg px-3 py-1.5 font-mono text-xs text-primary">
              {SHARE_DISPLAY_URL}
            </code>
            <CopyButton value={`${SITE_URL}/guide`} label="Copy link" />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <a
              href={TG_GROUP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Questions? The Telegram is open &rarr;
            </a>
            <Link href="/about" className="text-primary hover:underline">
              Who runs this &rarr;
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* CTA */}
      <section className="text-center space-y-6 py-8">
        <h2 className="text-2xl sm:text-3xl font-bold">Ready to participate?</h2>
        <p className="text-muted-foreground max-w-md mx-auto text-sm">
          Mint a free badge, claim tasks, earn XRD. Badges and escrowed funds are verifiable on-chain.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link href="/mint"><Button size="lg">Mint Free Badge</Button></Link>
          <Link href="/tasks"><Button size="lg" variant="outline">Browse Tasks</Button></Link>
        </div>
        <div className="flex justify-center gap-4 text-[11px] text-muted-foreground font-mono pt-4">
          <Link href="/docs#transparency" className="text-primary hover:underline">Transparency</Link>
          <span>|</span>
          <span>On-Chain Verifiable</span>
        </div>
      </section>
    </div>
  );
}

export default function GuidePage() {
  return <AppShell><GuideContent /></AppShell>;
}
