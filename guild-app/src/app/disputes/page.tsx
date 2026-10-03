import { disputeCopy, disputeEra, settlementCopy } from "@/lib/settlement-copy";
import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ESCROW_COMPONENT, TG_GROUP_URL } from "@/lib/constants";
import { withPageOg } from "@/lib/page-metadata";

// D6 — "Disputes & Arbitration". ERA-KEYED 2026-08-27 for P3-3/DB-5.
// Follows the §5 per-doc template (docs/design/COMMUNITY-DOCS-PLAN-2026-07-15.md).
//
// This page's premise flips with NEXT_PUBLIC_FEATURE_DISPUTES — the same
// build-time flag that mounts the Raise-Dispute button — so every sentence
// whose truth depends on that flag lives in DISPUTE_COPY (settlement-copy.ts)
// in BOTH forms, and this file renders whichever era the build compiled. The
// 2026-08-27 audit found the alternative already latent: this page asserted
// "turning it on for real is … not a config toggle" while the flag alone
// would have mounted the button beside that sentence. Never write an
// era-varying sentence inline here again.
//
// The honest point of the page, in either era: what the dispute path pays is
// a fixed 50/50 of the REWARD with the insurance returning whole to the
// poster (auto-resolve), stated plainly — never "fair automatic dispute
// resolution" or "neutral arbitration". Live default is SplitEvenly,
// re-verified via Gateway (NOT FavorDisputeRaiser, which older drafts copied)
// and proven on the task-3 mainnet settlement (see SETTLEMENT_TXIDS below).
//
// ⚠️ DO NOT REINTRODUCE "the guild posts no disputable tasks", in any wording.
// It describes a mechanism that does not exist: there is no per-task
// disputability anywhere. TaskInfo has no such field, create_task takes no such
// parameter, and raise_dispute (escrow/.../lib.rs) asserts only state ==
// Submitted plus a poster-receipt OR claimer-badge proof. EVERY funded task
// that reaches Submitted is disputable. The phrase is banned at source
// (docs/design/COMMUNITY-DOCS-PLAN-2026-07-15.md) and is now caught
// mechanically by scripts/launch-check.sh CHECK 4.
//
// What bounds the worst case once a task is Disputed, in the order it bites:
//   1. the fallback ruling is a fixed 50/50 of the reward, not a judged
//      outcome, and the insurance is hardcoded back to the poster — so under
//      that default a worker can only lose by it (half the reward and half
//      the bond), and an unruled dispute recovers half of each for the
//      poster. An ARBITER's ruling is different: one split, applied to the
//      reward, the insurance and the bond alike, so a ruling for the worker
//      pays more than an approval would;
//   2. an arbiter can overrule before the 72h window closes — an operator
//      ceremony (docs/architecture/dispute-resolution.md §0), never dressed
//      up as self-service, with no committed turnaround;
//   3. watchers read the escrow every 30 minutes. The task pager
//      (scripts/task-activity-watch.mjs, #761, cron */30 since 2026-09-23)
//      pages the operator on EVERY claim, submission, dispute and settlement,
//      with review reminders at 24h and 2h left — it has no value threshold,
//      so the old "small disputes are logged rather than paged" (true only of
//      the drift watcher's PASS 3, GUILD_DISPUTE_ALERT_MIN_XRD) came out of the
//      copy on 2026-09-24. The 2026-09-04 wind-down paused the older crons;
//      they were re-enabled 2026-09-13 ≈00:45Z (docs/PROJECT-STATE.md, the
//      "Deploy 2026-09-12/13" entry). See settlement-copy.ts's
//      disputesHonestyLimit / disputesResolutionPara3 for the copy this drives.
// None of that is a promise nothing goes wrong.

export const metadata: Metadata = withPageOg("/disputes", {
  title: "Disputes & Arbitration — Radix Guild",
  description: disputeCopy("disputesMetaDescription")!,
});

// Ground truth: docs/PROJECT-STATE.md:595 + docs/ESCROW-ADDRESSES.md — the
// dedicated Guild Arbiter Badge, minted supply 1, distinct from the worker
// badge. Not a shared constant (it's used nowhere on the money path today, by
// design), so it's pinned here with its source.
// Wave B (2026-09-13 cutover): the identity-bearing arbiter badge, NF #1#, minted by
// the ceremony generator and pinned write-once as instantiate arg 2 of the live
// component …hp88yly (docs/ESCROW-ADDRESSES.md). The previous value here was the
// PULL-era supply-1 badge …nvakn3, retired with that component.
const ARBITER_BADGE =
  "resource_rdx1ngmygm4ph44hjwry6pkzv5qx62qy8p7hzu96829tp4wxrmenp8ve9x";

const MECHANISM = [
  {
    method: "raise_dispute",
    body: "Moves a Submitted task to Disputed. The raiser must present a proof — the poster's task receipt or the claimer's badge — so it is not open to strangers, and either party to the task can do it.",
  },
  {
    method: "resolve_dispute",
    body: "An arbiter presenting the Guild Arbiter Badge sets the poster/worker shares — the one path where the ruling governs the insurance as well as the reward. Any arbiter fee (≤10% of insurance, fixed at 0 on every task this app funds) returns to the arbiter. Gated by the badge — supply 1, held by the operator — and no turnaround time is promised before the auto-resolve window closes. The on-chain self-dealing check is narrow: the arbiter may not be the task's worker (asserted, reverts otherwise), but nothing checks the poster — it is a caller-supplied destination, not a verified identity — so an arbiter who funded a task may still rule on it. They cannot redirect the money doing so (settlement pays only the pinned accounts), but they can rule in their own favor as poster.",
  },
  {
    method: "auto_resolve_dispute",
    body: settlementCopy("disputesAutoResolveBody")!,
  },
];

// The three signed legs of the task-3 settlement that closed P3-3's gate —
// every leg through both collections, not just the terminal call. All
// CommittedSuccess, 2026-08-26 13:53:43Z → 13:59:08Z. Cited from
// docs/PROJECT-STATE.md's 2026-08-26 "TASK 3 SETTLED" block. Era-independent
// ledger fact: it renders in both eras.
// ⚠️ PROVENANCE (added 2026-09-20, from a site-wide content audit). These three
// transactions ran on the PREVIOUS escrow component …akd82f, retired in place on
// 2026-09-13 — Gateway-verified: auto_resolve_dispute's affected component is
// …27akd82f. The card sat directly under the LIVE component's address with no
// word of that, so a reader who checked the live component's history found no
// task 3 there at all. The proof is still real and still the only record of the
// TIMEOUT path (nobody ruled; the 72h fallback fired) — it just has to say where
// it happened. LIVE_RULING below is the one dispute on the live component.
const PROOF_COMPONENT =
  "component_rdx1cz468ea52ajvh23h38r97zam7vtx0xre32wmnwu4vv9qhanf27akd82f";

// The only dispute the LIVE component …hp88yly has seen. Gateway-verified
// 2026-09-20: CommittedSuccess 2026-09-14T11:41:33Z, DisputeResolvedEvent
// task_id=5 ruling=Split(0.5,0.5) arbiter_fee=0 worker_amount=262.5
// poster_amount=262.5. Every party was an operator account — /trust says so too.
const LIVE_RULING = {
  method: "resolve_dispute",
  txid: "txid_rdx1zew46jjskng2a9dmq678qggs3g86q45z79s5p86khq03sk0yygrqsq8m8t",
};

const SETTLEMENT_TXIDS = [
  {
    method: "auto_resolve_dispute",
    txid: "txid_rdx1xjcqadt7nz052eps592pdz5mz0dnjv8x9r4ej7vysyz3288zsfzsr9jl3m",
  },
  {
    method: "withdraw_worker",
    txid: "txid_rdx1m9s6e6vkdmt62xr30mn5yya3nge325pdl7ev2xt7peh94087kv4qaq8z49",
  },
  {
    method: "withdraw_poster",
    txid: "txid_rdx1w4rqfen8dyvhhpzd2hmgvd3vww93syl75l3pdhkcxw096vvt44lq4qd8p9",
  },
];

// Rendered in the OFF era only — the ON era has no second label to explain
// (the hero badge says LIVE and the page body carries the terms).
const STATUS_LABELS = [
  {
    label: "DORMANT",
    variant: "outline" as const,
    body: "Our dispute UI is compiled OFF in this build (NEXT_PUBLIC_FEATURE_DISPUTES), so no dispute affordance renders here. This governs OUR software: the on-chain methods stay callable by a hand-built manifest regardless.",
  },
  {
    label: "LIVE",
    variant: "secondary" as const,
    body: "On the ledger: the arbiter badge (supply 1), the three dispute methods, the 72h window, and the SplitEvenly default. Live and verifiable — and reachable by anyone who builds the manifest themselves, not just by us. We have exercised it ourselves end to end: on-chain task 3 was moved into Disputed on 2026-08-23 as a deliberate internal probe, and its 72h auto-resolve settled on 2026-08-26 exactly as predicted. All of it is readable on the ledger.",
  },
];

function DisputesContent() {
  const on = disputeEra() === "on";
  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold">Disputes &amp; Arbitration</h1>
          <Badge variant={on ? "secondary" : "outline"} className="text-[10px]">
            {disputeCopy("disputesPageStatus")}
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          Status:{" "}
          <span className="font-semibold">{disputeCopy("disputesPageStatus")}</span>{" "}
          {disputeCopy("disputesPageStatusDetail")}.
        </p>
        {disputeCopy("disputesArbiterConflictScope") && (
          <p className="text-muted-foreground text-sm mt-2">
            {disputeCopy("disputesArbiterConflictScope")}
          </p>
        )}
      </div>

      {/* The honesty marker — this is the whole point of the page, either era */}
      <Card className="border-primary/40">
        <CardContent className="pt-5 pb-5 space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">In plain terms</Badge>
            <span className="text-xs text-muted-foreground">{disputeCopy("disputesHonestyTagline")}</span>
          </div>
          <p className="text-sm leading-relaxed">{disputeCopy("disputesHonestyLead")}</p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {disputeCopy("disputesHonestyLimit")}
          </p>
        </CardContent>
      </Card>

      {/* What this is (ELI5) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">What This Is</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="leading-relaxed">
            If a poster and worker disagree over delivery, a marketplace needs a way to break the
            tie. The Guild&rsquo;s escrow blueprint ships one: a task can be moved into dispute, an
            arbiter can rule on how the funds split, and if no one rules within a set window the
            contract falls back to a default split.
          </p>
          <p className="leading-relaxed text-muted-foreground">{disputeCopy("disputesEli5Status")}</p>
        </CardContent>
      </Card>

      {/* What it actually does */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">What It Actually Does</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {MECHANISM.map((m) => (
              <div key={m.method} className="bg-muted rounded-lg p-3">
                <code className="text-[11px] font-mono bg-background px-1.5 py-0.5 rounded">{m.method}</code>
                <div className="text-xs text-muted-foreground leading-relaxed mt-2">{m.body}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
            <span className="font-semibold text-foreground">The default ruling is SplitEvenly</span>{" "}
            (a 50/50 split of the reward; the poster&rsquo;s insurance returns to them in full
            either way), re-verified against the live component via the Gateway. The auto-resolve{" "}
            <span className="font-semibold">window is 72 hours</span>.
          </p>
        </CardContent>
      </Card>

      {/* How it resolves / why it's dormant — the mechanism, era-keyed */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
            {disputeCopy("disputesResolutionTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="leading-relaxed">
            {settlementCopy("disputesResolutionMechanism")}
          </p>
          <p className="leading-relaxed text-muted-foreground">{disputeCopy("disputesResolutionPara2")}</p>
          <p className="leading-relaxed text-muted-foreground">{disputeCopy("disputesResolutionPara3")}</p>
          <p className="leading-relaxed text-muted-foreground">{disputeCopy("disputesResolutionPara4")}</p>
        </CardContent>
      </Card>

      {/* Proven on mainnet, end to end — era-independent ledger fact */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Proven End to End on Mainnet — on the Previous Component</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="leading-relaxed text-muted-foreground">
            On task 3, we wrote down the predicted outcome before signing anything — worker
            entitled 10, poster entitled 11, a fixed 50/50 split of the reward, zero arbiter fee,
            the claim bond untouched — and the chain returned exactly that. Worker and poster each
            collected with their own signed withdrawal; the escrow component and both of the
            task&rsquo;s vaults ended at 0, conservation exact to the last decimal. That is the
            property this page asks you to trust: not our word, the ledger.
          </p>
          <div className="space-y-1.5">
            {SETTLEMENT_TXIDS.map((t) => (
              <div key={t.method} className="flex items-center justify-between gap-2 bg-muted rounded px-3 py-2">
                <span className="text-xs text-muted-foreground font-mono">{t.method}</span>
                <a
                  href={`https://dashboard.radixdlt.com/transaction/${t.txid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs text-primary hover:underline break-all text-right"
                >
                  {t.txid.slice(0, 22)}…
                </a>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            <span className="font-semibold text-foreground">Where this ran:</span> on the previous
            escrow component,{" "}
            <a
              href={`https://dashboard.radixdlt.com/component/${PROOF_COMPONENT}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-primary hover:underline"
            >
              {PROOF_COMPONENT.slice(0, 18)}…{PROOF_COMPONENT.slice(-6)}
            </a>
            , retired on 2026-09-13 — not the live one named above, whose own task 3 is a different,
            undisputed task.
            The dispute code is the same crate; this remains the only run of the timeout path,
            where nobody rules and the 72h fallback fires.
          </p>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            All three <span className="font-mono">CommittedSuccess</span>, 2026-08-26 13:53:43Z →
            13:59:08Z. One property worth knowing: the 72h window opened at 00:37:54Z and nobody
            called the public auto-resolve for 13 hours — permissionless and unauthenticated does
            not mean someone will volunteer the fee for zero reward of their own.
          </p>
          <div className="border-t pt-3 space-y-2">
            <p className="leading-relaxed text-muted-foreground">
              <span className="font-semibold text-foreground">On the live component</span> there has
              been one dispute: task 5, ruled on 2026-09-14 by the arbiter —{" "}
              <span className="font-mono text-xs">Split(0.5, 0.5)</span>, arbiter fee 0, worker
              262.5 XRD and poster 262.5 XRD, and the 76.45 XRD claim bond split the same way,
              38.225 XRD to each. Poster, worker and arbiter were all accounts the
              operator controls, so it shows the ruling path works; it is not evidence of a neutral
              ruling between strangers. None has happened yet.
            </p>
            <div className="flex items-center justify-between gap-2 bg-muted rounded px-3 py-2">
              <span className="text-xs text-muted-foreground font-mono">{LIVE_RULING.method}</span>
              <a
                href={`https://dashboard.radixdlt.com/transaction/${LIVE_RULING.txid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs text-primary hover:underline break-all text-right"
              >
                {LIVE_RULING.txid.slice(0, 22)}…
              </a>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Verify it yourself */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Verify It Yourself</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <div className="text-xs font-semibold text-primary mb-1">On-chain (now)</div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2 bg-muted rounded px-3 py-2">
                <span className="text-xs text-muted-foreground">Guild Arbiter Badge (supply 1)</span>
                <a
                  href={`https://dashboard.radixdlt.com/resource/${ARBITER_BADGE}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs text-primary hover:underline break-all"
                >
                  {ARBITER_BADGE.slice(0, 24)}…
                </a>
              </div>
              <div className="flex items-center justify-between gap-2 bg-muted rounded px-3 py-2">
                <span className="text-xs text-muted-foreground">Escrow component (dispute params &amp; default)</span>
                <a
                  href={`https://dashboard.radixdlt.com/component/${ESCROW_COMPONENT}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs text-primary hover:underline break-all"
                >
                  {ESCROW_COMPONENT.slice(0, 24)}…
                </a>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
              On the component you can read the live dispute window and the{" "}
              <span className="font-mono">dispute_auto_resolve_default</span> (SplitEvenly) directly
              — that is ground truth, ahead of any doc.
            </p>
          </div>
          <div>
            <div className="text-xs font-semibold text-primary mb-1">Source audit</div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Opens at launch, and no date is set — the escrow blueprint is private until then. No
              repo link here yet by design.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Status labels (OFF era) / Don't read this as (ON era) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
            {on ? "Don’t Read This As" : "Status Labels Used Here"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!on &&
            STATUS_LABELS.map((s) => (
              <div key={s.label} className="bg-muted rounded-lg p-3">
                <Badge variant={s.variant} className="text-[10px] mb-2">{s.label}</Badge>
                <p className="text-xs text-muted-foreground leading-relaxed">{s.body}</p>
              </div>
            ))}
          <div className="text-xs leading-relaxed">
            {!on && <span className="font-semibold text-primary">Don&rsquo;t claim:</span>}{" "}
            <span className="text-muted-foreground">
              &ldquo;Fair automatic dispute resolution&rdquo; or &ldquo;neutral arbitration.&rdquo;
              Neither is what this is: arbitration is a supply-1 badge held by the guild, run as an
              operator ceremony, not a panel; and the automatic path is a fixed 50/50 default, not
              a judgment on who was right. Both are stated plainly above rather than implied.
            </span>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        Full trust story:{" "}
        <Link href="/trust" className="text-primary hover:underline">verify, don&rsquo;t vouch</Link>{" "}
        and the{" "}
        <Link href="/auditor-guide" className="text-primary hover:underline">auditor&rsquo;s guide</Link>.
        Questions or anything that looks off:{" "}
        <a href={TG_GROUP_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
          say it on Telegram
        </a>
        .
      </p>
    </div>
  );
}

export default function DisputesPage() {
  return (
    <AppShell>
      <DisputesContent />
    </AppShell>
  );
}
