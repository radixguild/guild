"use client";
import { disputeCopy, settlementCopy } from "@/lib/settlement-copy";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TG_BOT_URL, MANAGER, BADGE_NFT, ESCROW_COMPONENT, CV2_COMPONENT, ESCROW_CLAIM_BOND_XRD } from "@/lib/constants";
import { isGiftPageLive } from "@/lib/gift";
import Link from "next/link";

// This answer tracks the SAME truth condition as /gift itself (lib/gift.ts):
// one condition, both surfaces, so the docs cannot drift from reality in
// either direction — claiming gifts exist while the page is dark is as wrong
// as the "No donations" line this replaces was once a rail went live.
// Fees are unchanged and still the plan (D2) — gifts are what covers beta,
// not a replacement for the roadmap.
const FUNDING_ANSWER = isGiftPageLive()
  ? "Today, bigdev self-funds and the guild accepts gifts — the platform fee is 0% and fee revenue to date is $0. A gift buys nothing: no token, no equity, no priority, no vote. Fees are still the plan, not gifts forever: a poster-side royalty on funded tasks (see 'What are the fees?') and on-chain component royalties. There is no token, and none is planned. See Costs & Transparency section below."
  : "Today, bigdev self-funds — the platform fee is 0% and fee revenue to date is $0. The plan: a poster-side royalty on funded tasks (see 'What are the fees?') and on-chain component royalties. There is no token, and none is planned. See Costs & Transparency section below.";




// Mirrors the LIVE bot (guild-public's, deployed at /opt/radix-guild). Re-read
// 2026-09-23 against guild-public main `ec1ebd6` (#169/#170, the 2026-09-20 human
// front door): the menu it registers (bot/services/menu.js COMMANDS), its /help
// text (bot/services/copy.js) and the handlers in bot/index.js. /tasks (and the
// older alias /bounty) is ONE notice pointing at the web app — Telegram cannot
// sign transactions. Two things changed from the 2026-09-07 list:
//   • /game and /leaderboard are gone: menu.js excludes them as dark ("meme-grid
//     surface is dark"), and the web game API 503s.
//   • The "(+25 XP)" / "(+10 XP)" labels are gone: the bot keeps those points in
//     its own SQLite table and they never reach Guild XP, which comes only from
//     task settlement (users.ts awardTaskCompletion).
// Re-read 2026-09-24 against guild-public #171 (fix/bot-badge-card-and-command-log):
// the quick `/propose <title>` handler was removed (it could never run behind the
// wizard) and /help lists only the main commands, so "/help — Full command list"
// came off; /dispute, /arbiter, /game, /leaderboard, /groups, /group, /wg,
// /project, /milestone and /cv3 are retired there and are not listed here.
const BOT_COMMANDS = [
  { section: "Getting Started", cmds: [
    { cmd: "/start", desc: "What Radix Guild is + setup" },
    { cmd: "/register <address>", desc: "Link your Radix wallet" },
    { cmd: "/mint", desc: "Your free on-chain Guild badge" },
    { cmd: "/badge", desc: "Your badge and its on-chain fields" },
    { cmd: "/wallet", desc: "Wallet address + badge info" },
    { cmd: "/trust", desc: "The bot's participation tally (Bronze/Silver/Gold)" },
  ]},
  { section: "Tasks", cmds: [
    { cmd: "/tasks", desc: "Opens the task board. Posting, funding, claiming and submitting are wallet-signed, so they happen on the web app" },
  ]},
  { section: "Community votes (optional, off-ledger, free)", cmds: [
    { cmd: "/proposals", desc: "Open proposals" },
    { cmd: "/temps", desc: "Active temperature checks" },
    { cmd: "/vote <id>", desc: "Vote on a proposal (buttons)" },
    { cmd: "/results <id>", desc: "Vote results" },
    { cmd: "/new", desc: "Start a proposal (guided)" },
    { cmd: "/poll <q> | opt1 | opt2", desc: "Multi-choice poll" },
    { cmd: "/temp <question>", desc: "24h temperature check, non-binding" },
    { cmd: "/history", desc: "Recent proposals + outcomes" },
    { cmd: "/stats", desc: "Proposal and voter counts" },
    { cmd: "/cv2", desc: "On-chain consultations (CV2) — read-only, parked" },
  ]},
  // /feedback and /mystatus came off this list 2026-09-24: the bot stores a
  // ticket and replies "We'll review it soon", but nothing alerts anyone to a
  // new one, so listing them promised a queue nobody reads. Problems go where
  // /trust#if-something-goes-wrong says: a DM to the operator for money or
  // security, the Guild group for everything else.
  { section: "Support", cmds: [
    { cmd: "/support", desc: "Help links + contact" },
    { cmd: "/faq", desc: "Frequently asked questions" },
    { cmd: "/readme", desc: "Project overview + links" },
    { cmd: "/source", desc: "Source status" },
  ]},
];

const FAQ = [
  { q: "Is it free?", a: settlementCopy("docsIsItFreeAnswer")! },
  { q: "What is my badge?", a: "An on-chain NFT on the Radix ledger. It records your username and tier at mint — your handle in the guild for voting and tasks. It is not an identity check: anyone can mint one for the network fee, and one person can hold several. The NFT also carries an XP field. Only the operator can write it, with an admin badge — it was written six times in April 2026, never since — and a task payout never reaches it, so the on-chain XP value is not your score. The XP you see in the app is your account's record; the tier you see is the badge's own tier field, set at mint. The NFT itself is transferable. Your XP and trust record belong to your account in the Guild's records, not to the badge, so moving the badge does not move them." },
  { q: "How do I earn XP?", a: "By completing tasks. Each task pays XP by reward tier — 10, 25, 50 or 100 — credited when the task settles. That is the only source of the XP shown on the dashboard. The Telegram bot keeps its own points for votes and polls; they are not added to your Guild XP. Your badge NFT also carries an XP field on-chain, but only the operator can write it, so it is not your score. XP cannot be bought." },
  { q: "What is Consultation v2?", a: "Our own deployment of the Radix Foundation's consultation_v2 blueprint. The Foundation wrote the blueprint but never deployed it; bigdev forked it and deployed this component in April 2026 — the Foundation does not run it and does not endorse it. CV2 records formal, non-binding temperature checks on the Radix ledger, weighted by XRD holdings. It is PARKED as of 2026-07-31 — we are not developing it further. The component stays on mainnet and its checks can still be read through the Telegram bot (/cv2). Casting a vote is off, and no vote has ever been cast through it." },
  { q: "Who runs this?", a: "bigdev built Radix Guild and runs it today, and holds its admin badge — anyone can check that on the ledger. The aim is a Guild its members steer: ideas and issues are raised in the open and turned into funded Guild tasks, and the Guild is handed to the Radix DAO once the DAO is formed. The source is public at github.com/radixguild/guild, under Apache-2.0. The money path — escrow, task funds and badges — already runs on Radix mainnet, where anyone can verify it. See Costs & Transparency below." },
  { q: "How do bounties work?", a: settlementCopy("docsBountiesAnswer")! },
  { q: "What are the fees?", a: settlementCopy("docsFeesAnswer")! },
  // Added 2026-09-01. "Is there a token?" is the first question anyone in this
  // space asks and the site had never answered it anywhere — not in the FAQ,
  // not on /money, not on the landing page. The answer is a genuine structural
  // difference and it was going unstated purely because nobody thought to write
  // down an absence. Keep it factual: this states what exists, not what other
  // projects do.
  { q: "Is there a Guild token?", a: "No. There is no Guild token, no sale, no airdrop and nothing to buy — and no plan for one. Three things carry value here and none of them is a tradeable Guild asset: the membership badge is an NFT that anyone can mint for the network fee and it is not sold by us; XP and trust are account records and cannot be bought or transferred, and the badge tier is a field on the NFT; and rewards are paid in XRD, the Radix network's own token, which we do not issue. The marketplace earns from the flat royalty on funded tasks described above, or it does not earn. If that ever changes it will be a decision announced in advance, not something you discover in a chart." },
  { q: "Can I create bounties from the dashboard?", a: "Yes. Connect your wallet, open Tasks, and click Create Task. You pick a deliverable type and fill in title, description, reward, deadline, and acceptance criteria. Posting costs nothing and needs no on-chain transaction (you sign in with your wallet) — and the task is not claimable until you fund it in a separate, signed transaction (reward + 5% insurance). Posting is dashboard-only — the Telegram bot's /bounty just links here, because posting and funding are wallet-signed." },
  { q: "Do higher badge tiers give more voting weight?", a: "No. Votes in the Telegram bot are one per Telegram account, and a higher tier adds no weight; CV2's on-chain weighting is XRD-based, not tier-based. It could not safely be tier-based either: the badge is an unlimited public mint, so counting tiers differently would just count how many badges someone chose to mint. A tier carries no permissions." },
  { q: "How is the guild funded?", a: FUNDING_ANSWER },
  // ⚠️ Rewritten 2026-08-29. This described the RETIRED Telegram "Model B"
  // working groups — five hardcoded groups that do not exist, a Telegram-only
  // join, per-group leads, and charters/budgets/biweekly reports. Model A
  // shipped 2026-08-16 and is what actually runs: operator-curated groups you
  // join in the dashboard, carrying no lead, no budget and no vote. The same
  // stale five-group list was already found and fixed in the card below (see
  // the ⚠️ there); this FAQ entry was missed in that pass.
  { q: "What are working groups?", a: "Lightweight channels that route tasks by the problem they address, so you see work you care about instead of the whole board. Join or leave one in the dashboard on the Groups page. You can set a notification level, but nothing sends notifications yet. That is the whole feature: a group has no lead, no budget, no vote and no permissions — it decides nothing, it routes. Groups are created by the operator; you can propose a new one, and a group with no new task for a long stretch is archived automatically. Unrelated to the Radix DAO's proposed Working Group framework, which is a different thing with the same name — those are DAO-chartered bodies with elected stewards and treasury budgets." },
  { q: "How does task funding work?", a: settlementCopy("docsFundingAnswer")! },
  { q: "Where do I do things — dashboard or Telegram?", a: "Both, but they do different things. The dashboard is for wallet-signed actions: minting a badge, posting and funding tasks, claiming, submitting, approving, and your profile with trust record. Telegram is for setup help, badge checks, support and the optional community votes: proposals, polls and temperature checks. Working groups are dashboard-only — you join them on the Groups page. See the Dashboard vs Telegram guide above." },
  { q: "What is the trust score?", a: "Two different things share the name. In Telegram, /trust shows a participation score computed from the bot's own records — account age, votes cast, proposals created, tasks completed, groups joined, feedback filed — with tiers Bronze (0+), Silver (50+), Gold (200+). On the dashboard, a separate record is derived from the escrow ledger: New, Established (5 paid tasks, no disputes), or Top Rated (15 paid, 95% on-time). Neither gates a claim: any badge holder can claim. Both are earned by participating; a badge is the minimum to take part." },
  // "How does auto-verification work?" was REMOVED 2026-09-07. It described
  // a "--approval pr_merged --repo" flag on the bot's /bounty create and a
  // verifier-clicks-verify flow. Neither exists: pr_merged appeared nowhere in
  // this app but this page, and the bot's task tree is gated off. Approval is
  // the poster's own signed transaction (see /lifecycle) — nothing automatic.
  { q: "Can I fund tasks from the dashboard?", a: "Yes. On any unfunded task page, click the 'Fund' button. Your Radix Wallet opens with the TX manifest pre-built. One click to deposit XRD into the on-chain escrow vault. The task reconciles with the chain when you next act on it, or click 'Resync from chain' on the task page to confirm your deposit immediately." },
];

function DocsContent() {
  return (
    <div className="space-y-8">
      <div>
        {/* ⚠️ This h1 read "Getting Started" until 2026-08-21 — the same title
            /guide sets in its own metadata, and /guide's own comment calls
            itself "the single getting-started surface (MVP-5 trim)". The trim
            merged /start and /how-it-works INTO /guide for exactly that reason
            and never touched this page, which went on shipping FOUR renditions
            of the same 5-step onboarding (the journey widget, the slideshow, a
            Quick Start card, and the deep-dive grid) on top of /guide's two.
            /docs is the reference index and the FAQ; /guide owns "how do I
            start". */}
        <h1 className="text-2xl font-bold">Docs &amp; FAQ</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Reference for how the Guild works, the bot commands, and what everything costs.{" "}
          New here? <Link href="/guide" className="text-primary hover:underline">Start with the guide</Link>.
        </p>
      </div>

      {/* Deep dives — the marketplace trust docs, in-app */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Link href="/lifecycle" className="bg-muted rounded-lg p-3 no-underline hover:bg-muted/70 transition-colors">
          <div className="font-semibold text-sm mb-1 text-foreground">How the marketplace works</div>
          <div className="text-xs text-muted-foreground">Post &rarr; claim &rarr; submit &rarr; approve — the core task lifecycle, step by step.</div>
        </Link>
        <Link href="/guide#how-it-works" className="bg-muted rounded-lg p-3 no-underline hover:bg-muted/70 transition-colors">
          <div className="font-semibold text-sm mb-1 text-foreground">How the Guild works</div>
          <div className="text-xs text-muted-foreground">The marketplace flow, with what is live today and what is planned — on the getting-started guide.</div>
        </Link>
        <Link href="/agents" className="bg-muted rounded-lg p-3 no-underline hover:bg-muted/70 transition-colors">
          <div className="font-semibold text-sm mb-1 text-foreground">Agents on Guild</div>
          <div className="text-xs text-muted-foreground">The agent lane — live on mainnet today via the member badge; dedicated agent badge still inert.</div>
        </Link>
        <Link href="/money" className="bg-muted rounded-lg p-3 no-underline hover:bg-muted/70 transition-colors">
          <div className="font-semibold text-sm mb-1 text-foreground">Money, bonds &amp; trust</div>
          <div className="text-xs text-muted-foreground">Exactly what leaves your wallet, who holds it, and the honest limit of &ldquo;escrow.&rdquo;</div>
        </Link>
        <Link href="/auditor-guide" className="bg-muted rounded-lg p-3 no-underline hover:bg-muted/70 transition-colors">
          <div className="font-semibold text-sm mb-1 text-foreground">Auditor&rsquo;s guide</div>
          <div className="text-xs text-muted-foreground">State machine, trust claims and how to check each one, honest-gaps register.</div>
        </Link>
        <Link href="/trust" className="bg-muted rounded-lg p-3 no-underline hover:bg-muted/70 transition-colors">
          <div className="font-semibold text-sm mb-1 text-foreground">Trust &amp; verification</div>
          <div className="text-xs text-muted-foreground">Known issues first, then what you can check on-chain today and what is still planned.</div>
        </Link>
        <Link href="/disputes" className="bg-muted rounded-lg p-3 no-underline hover:bg-muted/70 transition-colors">
          <div className="font-semibold text-sm mb-1 text-foreground">Disputes &amp; arbitration</div>
          <div className="text-xs text-muted-foreground">{disputeCopy("docsDisputesCardBlurb")}</div>
        </Link>
      </div>

      {/* The UserJourneyWidget was REMOVED here 2026-08-21 and its component
          deleted. 585 lines re-teaching four other pages in carousel form:
          stage 1 duplicated /guide's onboarding, stage 3 duplicated /lifecycle
          almost step for step, stage 4 /check-badge, stage 6 /auditor-guide.
          Its one non-duplicated stage was Architecture — and the slideshow
          below already carries an Architecture infographic, so nothing unique
          was lost. */}

      {/* The "Quick Start (5 minutes)" card was REMOVED 2026-08-21 — the third
          of four onboarding treatments on this one page. /guide owns getting
          started; a link is the whole of what /docs needs to say about it. */}
      <Card>
        <CardContent className="py-4 text-sm">
          New to the Guild?{" "}
          <Link href="/guide" className="text-primary hover:underline">
            The getting-started guide
          </Link>{" "}
          walks you from installing a wallet to claiming your first task.
        </CardContent>
      </Card>

      {/* XP & Tiers — REDUCED 2026-09-07 to a pointer. /guide carries the same
          five-tier table and XP list inside its onboarding narrative, and the
          two copies had already drifted ("Complete task" read differently on
          each). One table, one place; this card only says where it is. */}
      <Card>
        <CardContent className="py-4 text-sm">
          <span className="font-semibold">XP &amp; tiers.</span> Guild XP comes from completed tasks.
          Five tiers, Member to Elder, are defined by XP thresholds; the tier shown on your badge is
          its own on-chain field, which only the operator sets. A tier carries no permissions and no
          vote weight. The table and the XP values are on the{" "}
          <Link href="/guide" className="text-primary hover:underline">getting-started guide</Link>;
          check your own on{" "}
          <Link href="/check-badge" className="text-primary hover:underline">/check-badge</Link>.
        </CardContent>
      </Card>

      {/* Working Groups */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Working Groups</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {/* ⚠️ This card used to hardcode five groups — Guild, DAO, Radix
              Infrastructure, Business Development, Marketing. NONE of them
              exist: the live set is Scrypto & Blueprints, Frontend & UX,
              Agents & A2A, Infra & Ops, Docs & Research and Design, with zero
              overlap. It also said each group "has a lead", which the schema
              explicitly denies — "nothing here binds a group to a vote, a
              treasury, a lead or a budget… the whole feature is ONE join row
              carrying a notification level" (db/schema/working-groups.ts).
              A hardcoded mirror of a database table is guaranteed to rot, so
              this now points at the page that renders the real rows instead of
              listing a new set that will rot the same way. */}
          <p>
            Working groups organize WHO does WHAT: each one is a topic you can join to follow its
            tasks. Joining is a notification preference and nothing more — a group has no lead, no
            budget, no treasury and no vote, and joining one does not gate any task.
          </p>
          <p>
            <Link href="/groups" className="text-primary hover:underline">Browse the groups</Link>{" "}
            to see the current set and join from the dashboard — no Telegram needed.
          </p>
        </CardContent>
      </Card>

      {/* How Escrow & Funding Works */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">How Task Funding Works</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="bg-muted rounded-lg p-3">
              <div className="font-semibold text-xs mb-1">For Task Creators</div>
              <ol className="text-[11px] text-muted-foreground space-y-1 list-decimal pl-3">
                <li>Create the task on the dashboard — free, no on-chain transaction (you sign in with your wallet), not yet claimable</li>
                <li>Click <strong>Fund</strong>: your Radix Wallet signs a deposit of the reward plus 5% insurance</li>
                <li>XRD locked in the Scrypto vault — no admin custody</li>
                <li>Review the submission and approve with your own signed transaction</li>
              </ol>
            </div>
            <div className="bg-muted rounded-lg p-3">
              <div className="font-semibold text-xs mb-1">For Workers</div>
              <ol className="text-[11px] text-muted-foreground space-y-1 list-decimal pl-3">
                <li>Browse funded tasks at <Link href="/tasks" className="text-primary hover:underline">/tasks</Link> (a badge is needed to claim)</li>
                <li>Claim from the task page — a bond of 10% of the reward, at least{" "}
                  {ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting), held until the task settles: credited back in full on approval, on the review-window release or if the poster cancels, split like the reward if a dispute is raised, and forfeited if the claim runs an hour past its deadline and anyone ends it</li>
                <li>Submit your work; the poster reviews it</li>
                <li>{settlementCopy("docsAgentPayoutStep")}</li>
              </ol>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">No applications and no claim gates: any badge holder can claim. Eligibility in the brief is not enforced. Every step above is wallet-signed and runs on the dashboard. The Telegram bot links here; its code holds a guarded signer module, and no signing key is configured in production, so it signs nothing today.</p>
          <p className="text-xs text-muted-foreground mt-1"><strong>The live escrow:</strong> one component on Radix mainnet (<code className="bg-muted px-1 rounded">guild-marketplace-escrow</code>), funding in XRD today; multi-token deposits (xUSDC, xUSDT) are designed but no second token is whitelisted on-chain yet. The pre-June component is retired — no task runs on it. Address on the verification card below.</p>
        </CardContent>
      </Card>

      {/* Where to Do What */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Dashboard vs Telegram</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            {[
              // ⚠️ Re-cut 2026-09-07 against the routes that exist and the
              // live bot. Gone: "Create on-chain vote — Proposals page" (no
              // /proposals route; CV2 writes are parked), "Create bounties /
              // Claim / Fund — Both" (the bot's /bounty tree is gated off, so
              // every money leg is dashboard-only), "Admin: manage tickets"
              // (operator-only, not a reader's action).
              { action: "Mint badge", where: "Dashboard", how: "/mint page with wallet" },
              { action: "Post, fund, claim, submit, approve tasks", where: "Dashboard", how: "Wallet-signed — the bot's /bounty just links here" },
              { action: "View profile & trust", where: "Dashboard", how: "/profile → tabbed view with trust breakdown" },
              { action: "Join working groups", where: "Dashboard", how: "Groups page → join, and set the bell" },
              { action: "Browse tasks", where: "Both", how: "Dashboard to act, bot to read" },
              { action: "Create proposals, polls, temperature checks", where: "Telegram", how: "/new, /propose, /poll, /temp" },
              { action: "Vote on proposals", where: "Telegram", how: "/vote or tap inline buttons" },
              { action: "Report a problem", where: "Telegram", how: "DM the operator for money or security; the Guild group for anything else (/trust#if-something-goes-wrong)" },
            ].map(r => (
              <div key={r.action} className="flex items-center justify-between py-1.5 border-b last:border-0 text-xs">
                <span className="font-medium">{r.action}</span>
                <div className="text-right shrink-0 ml-2">
                  <Badge variant={r.where === "Both" ? "default" : r.where === "Dashboard" ? "secondary" : "outline"} className="text-[8px]">{r.where}</Badge>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground mt-3">
            Wallet-signed actions — minting, posting, funding, claiming, submitting, approving, your profile — live on the dashboard. Telegram is for setup help, support and the optional community votes (proposals, polls, temperature checks).
          </p>
        </CardContent>
      </Card>

      {/* Bot Commands */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Bot Commands</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {BOT_COMMANDS.map(section => (
            <div key={section.section}>
              <div className="text-xs font-semibold text-muted-foreground mb-1.5">{section.section}</div>
              <div className="space-y-1">
                {section.cmds.map(c => (
                  <div key={c.cmd} className="flex items-start gap-2 py-1 border-b last:border-0">
                    <code className="text-[11px] font-mono bg-muted px-1.5 py-0.5 rounded shrink-0">{c.cmd}</code>
                    <span className="text-[11px] text-muted-foreground">{c.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* FAQ */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">FAQ</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {FAQ.map(f => (
              <div key={f.q}>
                <div className="text-sm font-semibold mb-0.5">{f.q}</div>
                <div className="text-xs text-muted-foreground">{f.a}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Resources */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Resources</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm">
            {[
              { label: "Telegram Bot", url: TG_BOT_URL },
              { label: "Dashboard", url: process.env.NEXT_PUBLIC_SITE_URL || "https://radixguild.com" },
              { label: "Source code", url: "https://github.com/radixguild/guild" },
              { label: "Costs & Transparency", url: "#transparency" },
              { label: "System Health", url: `${process.env.NEXT_PUBLIC_SITE_URL || "https://radixguild.com"}/api/health` },
            ].map(r => (
              <a key={r.label} href={r.url} target={r.url.startsWith("/") ? undefined : "_blank"} className="flex items-center justify-between py-1.5 border-b last:border-0 text-foreground no-underline hover:text-primary">
                <span>{r.label}</span>
                <span className="text-xs text-muted-foreground">&gt;</span>
              </a>
            ))}
          </div>
        </CardContent>
      </Card>
      {/* Costs & Transparency */}
      <div id="transparency">
        <h2 className="text-lg font-bold mb-4">Costs & Transparency</h2>

        {/* ⚠️ Rewritten 2026-09-07. This card was headed "Actual Costs
            (Verified)" and read "AI/Dev tools ~$600 … Total invested ~$680" —
            figures written 2026-06-04 and never touched since, on a page whose
            thesis is "verify everything". Measured on the day of the rewrite:
            `ccusage monthly` showed $17,486 of API-equivalent Claude usage for
            2026-07-08 → 09-06 alone (all of bigdev's projects; ~30% of it Guild
            by per-project transcript re-pricing), and `git log` showed 95
            active commit days since April. Wrong by more than an order of
            magnitude, in the direction that flatters — so the card is now
            explicit that these are ESTIMATES with a date, and each row says
            what it was measured from. Hand-maintained numbers rot; the date is
            the reader's warning. To re-measure: `ccusage monthly` (AI, retained
            transcripts only — logs rotate), `git log --format=%ad --date=short
            | sort -u | wc -l` across guild-saas + guild-public + scrypto-xrd
            (active days), the VPS/domain/CI lines from the billing pages. */}
        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">What it has cost so far (estimates, 7 Sep 2026)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                One person, April to September 2026. Two kinds of cost: money actually paid, and things consumed that nobody invoiced for. Both are shown, separately, so neither hides the other.
              </p>
              {[
                { item: "Founder time", cost: "~600–900 h", note: "95 working days with commits since 3 Apr 2026, across the escrow blueprint, dashboard and bot. Unpaid — not drawn, and not owed by anyone." },
                { item: "AI tooling (Claude subscription + credits)", cost: "~A$1,600 paid (≈ $1,050)", note: "A$350/mo for the heavy months, A$170/mo otherwise, plus A$70 of extra credits, since April. Shared with bigdev's other projects — roughly a third of measured usage is Guild work, so call ~$400 of it the Guild's." },
                { item: "AI compute consumed, at API list price", cost: "~$10k (not cash)", note: "What the tokens would have cost pay-as-you-go: $17.5k measured for 8 Jul–6 Sep 2026 across all projects, ~30% Guild; April–early July unmeasured (usage logs rotate). The subscription line above is what was actually paid." },
                { item: "Domain (radixguild.com, 3 yr)", cost: "$40", note: "Hostinger, paid Apr 2026" },
                { item: "VPS hosting", cost: "~$35", note: "Hostinger VPS, ~$7/mo since April" },
                { item: "CI (GitHub Actions)", cost: "~$40", note: "About $1/day of private-repo runners; GitHub's spending limit is set at $100/mo" },
                { item: "On-chain", cost: "under $1 in fees", note: "Radix network fees for publishing the escrow packages, the test task waves and their settlements. Roughly 41,000 XRD of working capital sits in guild-controlled wallets (about $22 at 7 Sep 2026 prices); test rewards recycle inside that fleet and are not spent." },
                { item: "TLS, database, Gateway API, Telegram", cost: "Free", note: "Caddy, PostgreSQL (dashboard) + SQLite (bot), the public Radix Gateway, Telegram bot API" },
              ].map(c => (
                <div key={c.item} className="flex items-start justify-between gap-3 py-1.5 border-b last:border-0">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{c.item}</div>
                    <div className="text-[11px] text-muted-foreground">{c.note}</div>
                  </div>
                  <span className="text-sm font-mono text-primary shrink-0 text-right">{c.cost}</span>
                </div>
              ))}
              <div className="flex items-center justify-between pt-2 font-semibold">
                <span className="text-sm">Cash paid to date</span>
                <span className="text-sm font-mono text-primary">~$1,200</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                About $550 of that is attributable to the Guild once the shared subscription is apportioned; the rest is the same subscription doing other work. Figures are in US dollars; the subscription is billed in Australian dollars. The labour and the API-equivalent compute above are on top, and are the real cost.
              </p>
              {/* "Platform fee revenue", not "revenue": the 0% fee makes this
                  $0 and that stays exactly true, but once gifts are live a bare
                  "revenue: $0" reads as "nothing came in", which would not be.
                  Gift totals are deliberately not stated here — they are not
                  fee revenue, and a hand-maintained number would go stale the
                  first time someone gives. */}
              <div className="flex items-center justify-between">
                <span className="text-sm">Platform fee revenue to date</span>
                <span className="text-sm font-mono text-muted-foreground">$0</span>
              </div>
              {isGiftPageLive() && (
                <p className="pt-1 text-[11px] text-muted-foreground">
                  Gifts are separate and not counted above — they buy nothing and are not
                  revenue.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">What it costs to keep running (per month)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {[
                { item: "VPS (Hostinger)", cost: "~$7", note: "Dashboard, bot, database, watchers and backups all share one box" },
                { item: "Domain", cost: "~$1", note: "$40 over three years" },
                { item: "CI (GitHub Actions)", cost: "~$25–30", note: "Runs on every pull request; capped at $100/mo by GitHub's spending limit" },
                { item: "AI tooling (Claude subscription)", cost: "~$110 (Guild share ~$40)", note: "A$170/mo today, shared with other projects; the Guild's share follows its share of measured usage. Was A$350/mo during the heavy build months." },
                { item: "Gateway API, TLS, database, Telegram", cost: "$0", note: "Public Radix Gateway, Caddy, on-box PostgreSQL + SQLite, Telegram bot API" },
                { item: "Keeper, drift and reconciler watchers", cost: "$0", note: "Read-only cron jobs — they alert, hold no keys, and pay no network fees" },
                { item: "Founder time", cost: "~20 days", note: "Active days per month over July–August 2026; unpaid" },
              ].map(c => (
                <div key={c.item} className="flex items-start justify-between gap-3 py-1.5 border-b last:border-0">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{c.item}</div>
                    <div className="text-[11px] text-muted-foreground">{c.note}</div>
                  </div>
                  <span className="text-sm font-mono text-primary shrink-0 text-right">{c.cost}</span>
                </div>
              ))}
              <div className="flex items-center justify-between pt-2 font-semibold">
                <span className="text-sm">Cash per month</span>
                <span className="text-sm font-mono text-primary">~$150 all-in · ~$75 Guild</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                The hard costs that the fee roadmap below has to clear are the ~$75/mo Guild line. Nothing above is paid by anyone but bigdev.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Revenue Model (Planned)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {/* Rewritten 2026-08-16. This card promised "a poster-side settlement
                fee capped on-ledger at 2.5% … charged on release" and "the
                community controls the economics". None of that exists: the
                instrument in the blueprint (lib.rs enable_component_royalties)
                is a flat XRD royalty on create_task — charged when a task is
                funded, 0 at launch, movable only by the operator's
                royalty-admin badge — with no percentage bound anywhere but the
                protocol's per-call maximum. honest-copy.mjs now bans the cap
                claim family. */}
            <p><strong>Task marketplace fee:</strong> 0% today — the live escrow charges no platform fee. Planned: a poster-side royalty when a task is funded — a flat XRD amount per funded post, not a percentage of the reward — starting at 0 and moved only by the operator&rsquo;s royalty-admin badge, under the network&rsquo;s per-call royalty maximum (about 166 XRD). Never charged on the worker&rsquo;s legs: claim, submit and withdraw are locked free on-chain. Workers pay 0%, forever.</p>
            <p><strong>Component royalties:</strong> the Badge Manager blueprint supports per-method royalties (0.1&ndash;1 XRD). Verify the live setting on the component before relying on this.</p>
            <p><strong>Hosted instances:</strong> other communities running their own instance is an idea, not a scheduled product.</p>
            <p className="text-xs text-muted-foreground mt-2">There is no percentage fee and the contract enforces no percentage bound — the flat royalty is the whole mechanism. Any fee change is published as an RFC before the dial moves; the dial itself is held by the operator, not by a vote.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">The Deal</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><strong>Who pays?</strong> bigdev self-funds. There is no Guild treasury, and no date for one.</p>
            <p><strong>Who controls?</strong> bigdev holds the admin badge, and who holds it is on the ledger for anyone to check. The aim is to hand it to the Radix DAO once the DAO is formed; no date is set.</p>
            {/* Added 2026-10-03. The Deal said who holds the badge and nothing about what it can do,
                and the site's bond phrasing ("never less than {floor} XRD, capped on-chain", until 2026-10-03)
                read as a contract guarantee. It is the escrow owner's setting (lib.rs set_claim_bond_params,
                one signed call, no delay, no vote). Every clause below is read off lib.rs's
                enable_method_auth! block and the setter bodies; /trust and /auditor-guide carry the
                same facts at full length. */}
            <p><strong>What can the owner badge change?</strong> Ten owner-only calls change twelve settings, each call one signed transaction with no delay and no vote: the claim bond&rsquo;s percentage, floor and cap, the review window, both submit deadlines, the minimum insurance, the arbiter-fee cap, the dispute window and default ruling, and the expiry grace and bounty. So the bond figures on this site are today&rsquo;s settings, not guarantees. Most are pinned into a task at the step that uses them, so a change reaches only steps taken after it; the expiry grace and bounty also reach claims already in flight. The owner can also add, remove, freeze and unfreeze reward tokens (this only decides which tokens new tasks can be funded in) and withdraw forfeited claim bonds. What it cannot do: there is no pause method, so funded tasks keep running (freezing a token only stops new ones), and no owner method touches a task&rsquo;s reward, insurance or live claim bond or sends a payout anywhere but the account pinned when the task was posted or claimed. The arbiter badge, held in the same wallet, is separate: on a disputed task its ruling decides the split between poster and worker, and it can pay no one else beyond any arbiter fee set at funding (0 on every task this app funds). The full list, with how to check it, is on <Link href="/trust" className="text-primary hover:underline">/trust</Link> and in the <Link href="/auditor-guide" className="text-primary hover:underline">auditor&rsquo;s guide</Link>.</p>
            <p><strong>What if bigdev disappears?</strong> Badges and escrow vaults live on the Radix ledger — no server required to keep them, and every party collects from the escrow with their own wallet. The source is public, so anyone can read and redeploy the escrow blueprint. Worker manifests are on <Link href="/agents#manifests" className="text-primary hover:underline">/agents#manifests</Link>; anything else means building the transaction yourself, or asking anyone to deliver it to your account.</p>
          </CardContent>
        </Card>

        <Card className="mt-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">On-Chain Verification</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {/* The components actually running. This list previously showed two
                dead escrows and not the live one: "TaskEscrow V2" was really the
                paused v1 component (config.ts calls it legacy, README calls it
                paused) and "Escrow V3" transacts nothing. Neither was the vNext
                component every money path uses since the §8b cutover
                (2026-06-14). Superseded addresses live in docs/ESCROW-ADDRESSES.md,
                not on a card headed "verify this yourself".
                Pinned by tests/unit/about-claims.test.tsx. */}
            {[
              { label: "Badge Manager", addr: MANAGER, type: "component" },
              { label: "Badge NFT", addr: BADGE_NFT, type: "resource" },
              { label: "Task Escrow (live)", addr: ESCROW_COMPONENT, type: "component" },
              { label: "CV2 Governance", addr: CV2_COMPONENT, type: "component" },
            ].map((item, i, arr) => (
              <div key={item.label} className={`flex items-center justify-between py-1.5 ${i < arr.length - 1 ? "border-b" : ""}`}>
                <span className="text-muted-foreground">{item.label}</span>
                <a href={`https://dashboard.radixdlt.com/${item.type}/${item.addr}`} target="_blank" className="font-mono text-xs text-primary hover:underline">{item.addr.slice(0, 20)}...</a>
              </div>
            ))}
            <div className="flex items-center justify-between py-1.5 border-t">
              <span className="text-muted-foreground">Source Code</span>
              <a href="https://github.com/radixguild/guild" className="font-mono text-xs text-primary hover:underline">github.com/radixguild/guild</a>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function DocsPage() {
  return <AppShell><DocsContent /></AppShell>;
}
