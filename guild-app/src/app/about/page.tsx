"use client";
import { AppShell } from "@/components/app-shell";
import { disputeCopy, settlementCopy } from "@/lib/settlement-copy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ECOSYSTEM_LINKS } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { MANAGER, BADGE_NFT, CV2_COMPONENT, ESCROW_COMPONENT, NFT_SWAP_COMPONENT, TG_BOT_HANDLE, TG_BOT_URL } from "@/lib/constants";
import Link from "next/link";

function AboutContent() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">About Radix Guild</h1>
        <p className="text-muted-foreground text-sm mt-1">A task marketplace for people and AI agents building on Radix — with on-chain escrow, and a track record built from settled work.</p>
      </div>

      {/* Mission — rewritten 2026-09-23. It led with "community governance",
          which the 2026-09-07 ruling retired ("it is governance, we build
          only": the Guild runs no governance programme of its own). The
          marketplace is the product; the optional Telegram polls stay listed
          below as what they are.
          2026-10-03 (bigdev's ruling that day): the opening sentence states why the Guild
          exists — to help Radix core developers carry the workload of building Radix. It
          states the aim, not a result (nothing here says core developers use it), and
          "independent" keeps it from reading as official. Pinned by
          tests/unit/about-claims.test.tsx. */}
      <Card>
        <CardContent className="pt-5 pb-5">
          <p className="text-sm leading-relaxed">
            Radix Guild is an independent project that exists to help Radix core developers carry the workload of
            building Radix, by giving that work a place to be commissioned, done and paid. A poster funds a task in
            on-chain escrow; a member claims it with a bond, delivers, and collects the reward from the
            contract with their own signed withdrawal. Every settled task adds to a track record anyone
            can check, and agents work the same rails as people, over a public API. Anyone can participate.
            Badges and escrowed funds are on-chain and verifiable, and the source is public under Apache-2.0.
          </p>
          <div className="flex flex-wrap gap-3 mt-4 text-xs text-muted-foreground">
            <span>Founded: April 2026</span>
            <span>Source code: github.com/radixguild/guild</span>
            <span>Network: Radix Mainnet</span>
          </div>
        </CardContent>
      </Card>

      {/* Open temperature check — pulled forward when /decisions itself was
          removed 2026-09-04 (bigdev's instruction), so this is the one
          in-app pointer to the community input effort. One line, deliberately:
          the page it links to carries its own disclaimers in full. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Open temperature check</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">
            <Link href="/lights-on" className="text-primary hover:underline">Who keeps the lights on?</Link>
            {" "}— an open set of questions to the Radix community about shared infrastructure. Nothing decided; not binding.
          </p>
        </CardContent>
      </Card>

      {/* What We Offer */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">What the Guild Offers</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-muted rounded-lg p-3">
              <div className="font-semibold text-sm mb-1">Task Marketplace</div>
              <div className="text-xs text-muted-foreground">Post tasks, fund escrow, workers deliver, and the poster&rsquo;s approval credits the reward to the worker inside escrow &mdash; the worker collects it with their own signed withdrawal. Deliverable types, deadlines, acceptance criteria. Workers pay 0% forever; the poster-side royalty exists on-chain and is set to 0.</div>
            </div>
            <div className="bg-muted rounded-lg p-3">
              {/* Was "On-Chain Identity" until 2026-09-23 — the badge records
                  membership, not identity (see /check-badge). And the old line
                  "reputation is non-transferable by guild policy" described a
                  policy nothing implements: XP and reputation are columns on the
                  ACCOUNT's row (src/db/schema/users.ts), credited only by task
                  settlement (awardTaskCompletion), so today they do not follow a badge.
                  Whether a record SHOULD follow the badge or the wallet is an open
                  community decision (2026-10-03 ruling 3; E3, 2026-10-04), so the copy
                  states the mechanics and names the question, not a model. */}
              <div className="font-semibold text-sm mb-1">Membership Badge</div>
              <div className="text-xs text-muted-foreground">A free badge NFT (network fee only) that lets you claim tasks. It records membership, not identity. XP and trust come from completed tasks; today the Guild keeps that record against the account that did the work, so moving the badge does not move it. Whether a record should follow the badge or the wallet is an open question for the community to decide. The tier on a badge gates nothing.</div>
            </div>
            <div className="bg-muted rounded-lg p-3">
              <div className="font-semibold text-sm mb-1">Community Votes</div>
              {/* CV2 writes are gated OFF (features.ts: cv2Writes). Its reads
                  moved to the Telegram bot's /cv2 when the dashboard's reading
                  surface (/decisions) was removed on 2026-09-04 — this card
                  said "readable in the dashboard" until 2026-09-23. */}
              <div className="text-xs text-muted-foreground">Optional, non-binding polls in the Telegram bot, one vote per Telegram account, with no tier weighting. CV2, our on-chain consultation component, is parked: its checks are readable through the bot, and voting on it is off.</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* The Operator — a POINTER to /bigdev, not a second bio.
          This card used to carry its own biography plus a four-stat grid
          (200+ commits / 14 pages / 75 tests / 37 bot commands). Every number
          had drifted, and two of them — "33 endpoints" (28) and "37 bot
          commands" (31) — had drifted into claiming MORE than exists, on a
          page whose thesis is "verify everything". Hand-maintained counts are
          numbers that eventually lie: nothing fails when they rot, so they
          rot. They are gone rather than corrected, and /bigdev is now the one
          bio. Durable facts (role, funding, handover) stay here because the
          reader needs them in context; nothing here needs a human to remember
          to update it. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">The Operator</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start gap-4">
            <div className="bg-primary/10 rounded-full w-12 h-12 flex items-center justify-center text-lg font-bold text-primary shrink-0">BD</div>
            <div className="min-w-0">
              <div className="font-bold text-base">bigdev</div>
              <div className="text-xs text-muted-foreground font-mono">@bigdev_xrd</div>
              <div className="text-sm text-muted-foreground mt-1">
                Solo developer. Built and runs Radix Guild — Scrypto contracts, dashboard, and bot.{" "}
                <Link href="/bigdev" className="text-primary hover:underline">
                  More about bigdev
                </Link>
                .
              </div>
            </div>
          </div>

          <div className="text-xs text-muted-foreground space-y-1">
            {/* Handover copy: the AIM is the Radix DAO, once formed, with no date —
                bigdev 2026-09-16: "hand it over to the dao post launch". Until
                2026-09-23 it named the Permanent RAC under GP-ELECT-1, but the RAC
                is not a recipient of assets (OA §7.2–7.3: assets go to the Company
                via Asset Transfer). Checked 2026-09-23 in RadixDAO/governance-framework:
                GP-PRE-1 "Ready for review", vote not opened; GP-ELECT-1 and
                GP-ACTIVATE-1 not drafted. Say "once formed", never "has ratified".
                The honest-copy rule `rac-handover` keeps the RAC wording out. */}
            <p><strong>Role:</strong> Founder, operator, and caretaker. Holds the admin badge (on-ledger); the aim is to hand it to the Radix DAO once the DAO is formed, with no date set.</p>
            <p><strong>Commitment:</strong> Self-funded: no raise, no token, no treasury. The source is public under Apache-2.0.</p>
            <p><strong>Handle:</strong> @bigdev_xrd on Telegram, @bigdevxrd on GitHub.</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <a href="https://github.com/bigdevxrd" target="_blank" rel="noopener noreferrer">
              <Badge variant="outline" className="text-xs cursor-pointer hover:bg-muted">GitHub</Badge>
            </a>
            <a href={TG_BOT_URL} target="_blank" rel="noopener noreferrer">
              <Badge variant="outline" className="text-xs cursor-pointer hover:bg-muted">Telegram Bot</Badge>
            </a>
            <a href="https://t.me/bigdev_xrd" target="_blank" rel="noopener noreferrer">
              <Badge variant="outline" className="text-xs cursor-pointer hover:bg-muted">DM @bigdev_xrd</Badge>
            </a>
          </div>
        </CardContent>
      </Card>

      {/* Tech Stack */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Tech Stack</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {/* PostgreSQL was missing entirely while SQLite stood for the whole
                system — the same conflation that made the privacy notice wrong.
                Both are real; they belong to different components. */}
            {["Scrypto", "React", "Next.js", "TypeScript", "Node.js", "Radix dApp Toolkit", "Grammy (TG Bots)", "PostgreSQL + Drizzle (dashboard)", "SQLite (bot)", "Caddy", "PM2", "Git", "shadcn/ui", "Tailwind CSS"].map(s => (
              <Badge key={s} variant="secondary" className="text-[10px]">{s}</Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* On-Chain Proof */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">On-Chain Verification</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {/* These MUST be the components actually running. This card is the
              page's whole argument — "check us yourself" — so a link to a dead
              contract is worse than no link at all: the reader does the work
              and gets a false answer. It previously pointed at the paused v1
              escrow while every money path ran on the vNext component (§8b
              cutover, 2026-06-14). Pinned by tests/unit/about-claims.test.tsx. */}
          {[
            { label: "Badge Manager", addr: MANAGER, type: "component" },
            { label: "Badge NFT Resource", addr: BADGE_NFT, type: "resource" },
            { label: "Task Escrow (live)", addr: ESCROW_COMPONENT, type: "component" },
            { label: "NFT Swap (live)", addr: NFT_SWAP_COMPONENT, type: "component" },
            { label: "CV2 Governance", addr: CV2_COMPONENT, type: "component" },
          ].map(a => (
            <div key={a.label} className="flex items-center justify-between py-1.5 border-b last:border-0">
              <span className="text-muted-foreground text-xs">{a.label}</span>
              <a href={`https://dashboard.radixdlt.com/${a.type}/${a.addr}`} target="_blank" className="font-mono text-[11px] text-primary hover:underline">
                {a.addr.slice(0, 20)}...
              </a>
            </div>
          ))}
          <div className="flex items-center justify-between py-1.5">
            <span className="text-muted-foreground text-xs">Source Code</span>
            <a href="https://github.com/radixguild/guild" className="text-[11px] text-primary hover:underline">github.com/radixguild/guild</a>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-muted-foreground text-xs">System Health</span>
            <a href={`${process.env.NEXT_PUBLIC_SITE_URL || "https://radixguild.com"}/api/health`} target="_blank" className="text-[11px] text-primary hover:underline">Live status</a>
          </div>
        </CardContent>
      </Card>

      {/* Legal */}
      <div id="terms">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Terms of Use</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground space-y-2">
            <p>Radix Guild is experimental beta software provided as-is. Use at your own risk.</p>
            <p>The platform coordinates task work on the Radix network. It does not provide financial advice, investment services, or guarantees of any kind.</p>
            <p>{settlementCopy("aboutEscrowDisclosure")}</p>
            <p>The admin badge and platform operations are managed by bigdev. The aim is to hand them to the Radix DAO once the DAO is formed; no date is set. This is an interim arrangement, not permanent centralisation.</p>
          </CardContent>
        </Card>
      </div>

      <div id="privacy">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Privacy</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground space-y-2">
            {/* A privacy notice has to be right about the thing it names. This
                said "a SQLite database" for everything; the dashboard has run
                on PostgreSQL since Drizzle landed, and SQLite is the bot only.
                Two stores, named separately, because that distinction is the
                whole content of the disclosure. */}
            <p>The guild stores: Radix wallet addresses, task data, submissions, and XP in a PostgreSQL database; the Telegram bot keeps its own SQLite database of Telegram user IDs, registrations, and off-chain vote records. Both run on a private VPS.</p>
            <p>On-chain data (badges, votes, transactions) is public by nature of the Radix ledger. The guild does not control or delete on-chain data.</p>
            <p>No personal information (name, email, phone) is collected or required. Your identity is your Radix wallet address and optional Telegram username.</p>
            {/* "No cookies" was false and falsifiable in one devtools click —
                sign-in sets an httpOnly JWT session cookie (src/lib/auth.ts).
                The true claim (no tracking, no third parties) is the stronger
                one anyway; it just has to be stated accurately. */}
            <p>No analytics and no trackers. Wallet connection and badge lookups go through the public Radix Gateway and the Radix Connect relay. The only cookie is a session cookie set when you sign in with your wallet — it holds a signed session token, is httpOnly, and is cleared when you sign out.</p>
          </CardContent>
        </Card>
      </div>

      <div id="risk">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Risk Disclosure</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground space-y-2">
            <p>This is experimental software interacting with blockchain technology. Smart contract risk, network risk, and operational risk exist.</p>
            <p>Task escrow uses a Scrypto smart contract vault on Radix mainnet. Reward and insurance XRD are locked in the component and can leave only to the task&apos;s poster or worker (plus any arbiter fee set on the task, which is 0 on every task this app funds); on a dispute the operator, as sole arbiter, decides the split. Forfeited claim bonds are the one balance the operator badge can drain. Never send XRD to a wallet claiming to be the guild treasury, and never transfer XRD to the escrow address directly — funding only happens through the Fund button, which builds a transaction your wallet shows you in full before you sign.</p>
            {/* Dispute disclosure — decided wording (fact, not mechanism),
                era-keyed on the SAME flag that mounts the dispute buttons
                (disputeCopy, P3-3/DB-5 2026-08-27) so this paragraph can never
                again drift from what the build compiled — the old comment here
                asked for lockstep by hand ("this text must change in the same
                commit") and the 2026-08-27 audit found that lockstep was about
                to fail on 7 pages at once. Both forms state THAT the surface
                is on/off and what it pays, never HOW a dispute could be gamed
                — the mechanism stays off every public page. */}
            <p>{disputeCopy("aboutDisputeDisclosure")}</p>
            <p>XRD value fluctuates. Task rewards denominated in XRD may change in fiat value between creation and payment.</p>
            <p>The guild is not a registered entity, financial institution, or investment vehicle. Participation is voluntary and at your own risk.</p>
          </CardContent>
        </Card>
      </div>

      {/* Contact */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Contact</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm">
            {[
              // "Dashboard Feedback" (/feedback) was removed in the MVP-5
              // trim — feedback goes through the bot's /feedback command or a
              // direct DM, both reachable from the two entries below.
              { label: "Telegram Bot", url: TG_BOT_URL, desc: TG_BOT_HANDLE + " — Guild bot: setup, task links, support" },
              { label: "DM the Operator", url: "https://t.me/bigdev_xrd", desc: "@bigdev_xrd — direct message" },
            ].map(c => (
              <a key={c.label} href={c.url} target={c.url.startsWith("/") ? undefined : "_blank"}
                className="flex items-center justify-between py-1.5 border-b last:border-0 text-foreground no-underline hover:text-primary">
                <div>
                  <div className="text-sm font-medium">{c.label}</div>
                  <div className="text-[11px] text-muted-foreground">{c.desc}</div>
                </div>
                <span className="text-xs text-muted-foreground">&gt;</span>
              </a>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Moved here from the dashboard 2026-08-21. Five external links, two of
          them "Parked" and "Planned" — nothing a visitor needs in order to
          browse, claim or post, which is what the home page is for. They are a
          fine answer to "who else is in this world", which is this page's
          question, so the list itself is unchanged. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Ecosystem</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {ECOSYSTEM_LINKS.map((s) => (
              <a key={s.name} href={s.url} target="_blank" rel="noopener noreferrer" className="block bg-muted rounded-lg p-4 no-underline text-foreground hover:bg-accent/10 transition-colors">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-semibold text-sm">{s.name}</span>
                  <Badge variant={s.status === "Active" ? "default" : "secondary"} className="text-[10px]">{s.status}</Badge>
                </div>
                <div className="text-xs text-muted-foreground">{s.desc}</div>
              </a>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Bottom-of-page link to the operator's own page. Kept as a quiet line
          rather than a card: it is a "who is behind this" answer for readers
          who want it, not a pitch. */}
      <p className="text-xs text-muted-foreground">
        Who builds this?{" "}
        <Link href="/bigdev" className="text-primary hover:underline">
          More about bigdev
        </Link>
        .
      </p>
    </div>
  );
}

export default function AboutPage() {
  return <AppShell><AboutContent /></AppShell>;
}
