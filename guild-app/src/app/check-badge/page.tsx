import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BADGE_NFT, ESCROW_CLAIM_BOND_XRD, TG_BOT_URL } from "@/lib/constants";
import { withPageOg } from "@/lib/page-metadata";

// Accompanies the check-badge wizard step (/badge, /wallet, /trust in the bot;
// /profile/<account> on the web). D3 in docs/design/COMMUNITY-DOCS-PLAN-2026-07-15.md,
// written to the §5 template.
//
// ⚠️ Load-bearing fact, CORRECTED 2026-08-02 — the earlier version of this note
// said the badge NFT is "the ONLY on-chain object" and instructed "never call
// tier/XP on-chain". That is wrong about the SCHEMA and right about the DATA,
// and the distinction is the whole point of this page:
//   • The badge NFT genuinely CARRIES `tier`, `xp` and `level` fields
//     (gateway.ts parseBadgeFields, indices 3/6/7). They exist on chain.
//   • Almost nothing has written them — CORRECTED 2026-09-20. This page said
//     "Nothing has ever written them. Every badge still reads xp = 0", and a
//     Gateway read of all 11 badges refuted it: <guild_member_bigdevxrd> carries
//     xp = 70 with last_updated ≈ 1.6 days after issued_at.
//     CORRECTED AGAIN 2026-09-24, from the badge manager's own transaction
//     stream: it was not one write "by hand". There are exactly six `update_xp`
//     calls, all on <guild_member_bigdevxrd>, 2026-04-04 → 04-06 (20 → 70, +10
//     each; the last three at 12:00:03, 18:00:03 and 00:00:04Z, a six-hourly
//     cadence), all signed by RX-01 (…7fkmd8cx, the old bot hot signer). No
//     `update_xp` since. The other ten badges are untouched. Chain-read 2026-08-02 on
//     <guild_member_pilotworker0>: xp = 0, tier = "member", and `last_updated`
//     still equals `issued_at` — untouched since mint, against ~1000 XP earned
//     off-chain in the internal wave.
// So the numbers a user sees ARE the Guild database's. The on-chain fields are
// a schema, not a live process. Say that; do not say the fields do not exist.

export const metadata: Metadata = withPageOg("/check-badge", {
  title: "Check Your Badge, Tier & XP — Radix Guild",
  description:
    "Your Guild badge is an on-chain NFT. It carries tier, XP and level fields. The tier you see is read from it; your XP and trust record are the Guild's own account records, and none of them gates a claim.",
});

const OFF_CHAIN = [
  {
    label: "Tier",
    body: "member → contributor → builder → steward → elder. The tier you see is read from your badge's own on-chain field: it is set at mint, only the operator can change it, completing tasks does not advance it, and it gates nothing.",
  },
  {
    label: "XP",
    body: "One running total, credited when a task you completed settles. Completed work is the only source — the Telegram bot's vote and poll points are kept separately, and XP is never bought.",
  },
  {
    label: "Trust score",
    // Was "…decides who can claim … Only the second one gates work" until
    // 2026-09-24. The claim-time trust gate was removed 2026-08-29
    // (escrow-actions.tsx, at the min-trust note) and claim_task checks only the
    // badge resource — nothing gates on either record.
    body: "Two records share this name. In Telegram, /trust shows the bot's participation score — Bronze (0+), Silver (50+), Gold (200+). On the dashboard, a separate record is derived from the escrow ledger: New, Established (5 paid tasks, no disputes), Top Rated (15 paid, 95% on-time). Neither gates work: any badge holder can claim.",
  },
];

function CheckBadgeContent() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Check Your Badge, Tier &amp; XP</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Where your badge, tier, XP and trust record live, and how to read each one. Status:{" "}
          <span className="font-semibold">LIVE — the badge is on-chain; your score is off-chain.</span>
        </p>
      </div>

      {/* The on-chain / off-chain split — the whole reason this doc exists */}
      <Card className="border-primary/40">
        <CardContent className="pt-5 pb-5 space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">In plain terms</Badge>
            <span className="text-xs text-muted-foreground">on-chain vs off-chain</span>
          </div>
          <p className="text-sm leading-relaxed">
            Your <span className="font-semibold">badge NFT</span> is on the Radix ledger, and it
            does carry <code className="font-mono text-xs">tier</code>,{" "}
            <code className="font-mono text-xs">xp</code> and{" "}
            <code className="font-mono text-xs">level</code> fields.{" "}
            <span className="font-semibold">They are not your score.</span> Only the operator can write them, with an admin badge, and a task payout never reaches
            them. Your Guild XP and trust record come from the Guild&rsquo;s own records, credited
            when your tasks settle — they are real and live. The tier shown on your badge is its
            on-chain field, so it does not move when you complete tasks.
          </p>
        </CardContent>
      </Card>

      {/* What this is (ELI5) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">What this is</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-relaxed">
            One place to read your standing in the Guild. Your <span className="font-semibold">badge</span>{" "}
            is an on-chain NFT that anyone can mint for the network fee, and holding one is what lets
            you <em>claim</em> work. It records membership, not identity — it does not check who you
            are, and one person can hold several. On top of that, the Guild tracks a{" "}
            <span className="font-semibold">tier</span>,
            an <span className="font-semibold">XP</span> total, and a <span className="font-semibold">trust
            score</span> — a lightweight reputation layer. None of them gates work: any badge
            holder can claim any funded task.
          </p>
        </CardContent>
      </Card>

      {/* What it actually does — the on-chain / off-chain split */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground flex items-center gap-2">
              On-chain
              <Badge variant="secondary" className="text-[9px]">Radix ledger</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="leading-relaxed">
              <span className="font-semibold">Your badge NFT — and nothing else.</span> It records
              your Guild membership and is what the escrow checks when you claim a task — it proves
              you hold a badge, not that you are anyone in particular. The tier you see is its tier
              field; its XP field is <span className="font-semibold">not</span> your score, and it
              holds no trust record.
            </p>
            <p className="text-xs text-muted-foreground font-mono break-all">{BADGE_NFT}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground flex items-center gap-2">
              Off-chain
              <Badge variant="outline" className="text-[9px]">Guild database</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {OFF_CHAIN.map((o) => (
                <div key={o.label}>
                  <div className="text-sm font-semibold">{o.label}</div>
                  <div className="text-xs text-muted-foreground leading-relaxed mt-0.5">{o.body}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Two things people get wrong */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Two things worth being precise about</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {/* Rewritten 2026-09-23. The first item said game XP "never credits
              governance XP" and that XP "comes from voting, proposing, and
              completing work" — the game is switched off, and Guild XP
              (users.xp) is written only by task settlement. The second said a
              minimum tier "can be shown on a task as a label"; task cards and
              the task page no longer show one (task-card.tsx, tasks/[id]).
              2026-09-24: the second item also said a poster "can require a
              minimum trust record, which this app checks before you claim" —
              that gate was removed 2026-08-29 — and the first said Telegram
              points are "not added to your XP or tier — only completed tasks
              are", beside a Tier entry saying tasks do not change the tier. */}
          <p className="leading-relaxed">
            <span className="font-semibold">Telegram points are not Guild XP.</span>{" "}
            The bot keeps its own points for votes and polls. They are a separate counter and are
            not added to your Guild XP — completed tasks are its only source. Nothing you do changes
            your tier.
          </p>
          <p className="leading-relaxed">
            <span className="font-semibold">Claiming is not gated by tier or trust.</span> Claiming a
            task needs a Guild Member badge and a claim bond — 10% of the reward, at least
            {ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting) — and that is the whole gate. A brief
            may say who a task is for or what record it expects, but nothing enforces it: any badge
            holder can claim.
          </p>
        </CardContent>
      </Card>

      {/* Verify it yourself */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Verify it yourself</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="leading-relaxed">
            <span className="font-semibold">On-chain (now):</span>{" "}
            <a
              href={`https://dashboard.radixdlt.com/resource/${BADGE_NFT}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              the badge resource on Radix Dashboard
            </a>
            . Open any badge and confirm what it holds: a username, a membership status, and tier
            and XP fields that are not your score. Your trust record is not on it at all.
          </p>
          <p className="leading-relaxed">
            <span className="font-semibold">Source:</span> public at github.com/radixguild/guild; a
            reproducible build that ties that source to the deployed package is still planned.
          </p>
        </CardContent>
      </Card>

      {/* Status labels */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Status labels used here</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            <Badge variant="secondary" className="text-[9px] mr-2 align-middle">LIVE</Badge>
            The badge NFT is live and on-chain. Your Guild XP and trust record are live too — read
            from the Guild&rsquo;s records, not from the badge&rsquo;s own fields. Only the operator
            can write the badge&rsquo;s tier and XP fields; the XP field was written six times in
            April 2026, never since, and a task payout never reaches either.
          </p>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        Read your standing at{" "}
        <code className="font-mono">/profile/&lt;your-account&gt;</code> or on the{" "}
        <Link href="/leaderboard" className="text-primary hover:underline">leaderboard</Link>.{" "}
        <code className="font-mono">/badge</code> in{" "}
        <a href={TG_BOT_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
          Telegram
        </a>{" "}
        shows the badge&rsquo;s own on-chain fields.
      </p>
    </div>
  );
}

export default function CheckBadgePage() {
  return (
    <AppShell>
      <CheckBadgeContent />
    </AppShell>
  );
}
