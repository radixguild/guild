import type { Metadata } from "next";
import { disputeCopy, settlementCopy } from "@/lib/settlement-copy";
import { AUTO_RESOLVE_DEFAULT, autoResolveCredits } from "@/lib/dispute-outcome";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ESCROW_COMPONENT,
  ESCROW_CLAIM_BOND_XRD,
  ESCROW_EXPIRE_GRACE_SECS,
  INSURANCE_RATE,
  ESCROW_MIN_INSURANCE_FRACTION,
} from "@/lib/constants";
import { withPageOg } from "@/lib/page-metadata";

// The highest-stakes trust doc (D5, COMMUNITY-DOCS-PLAN §5 template + fact
// ledger §8). Written wrong it creates liability; written right it is the trust
// product. Every money-path number here is load-bearing — change one only against
// the deployed component's get_config, never against a hope. The one word this
// page must never say is "trustless": under pull the contract does pin the
// payees, but approval still rests on a human poster and arbitration on a
// human operator — name the humans, never launder them out.

export const metadata: Metadata = withPageOg("/money", {
  title: "Money, Bonds & Trust — Radix Guild",
  description:
    settlementCopy("moneyMetaDescription")!,
});

const INSURANCE_PCT = Math.round(INSURANCE_RATE * 100);
const DASHBOARD_COMPONENT = `https://dashboard.radixdlt.com/component/${ESCROW_COMPONENT}`;

// The worked example, COMPUTED. It shipped twice as prose ("~52 XRD", "around
// 52") and was wrong both times by exactly the same error — halving the
// combined bucket instead of the reward. A number nobody can keep true should
// not be a number anyone has to write.
const EG = { reward: 100, get credits() { return autoResolveCredits(this.reward) } };

const POSTER_COSTS = [
  {
    label: "Reward",
    detail:
      settlementCopy("moneyRewardDetail")!,
  },
  {
    label: `Insurance — your own stake (${INSURANCE_PCT}% of the reward, rounded up to a whole XRD)`,
    detail:
      `Staked alongside the reward, in the same token. Returned to you whole on the happy path. This is your money held in the vault — not third-party underwriting and not platform-covered. Price your downside off the DISPUTE case, not off the arbiter fee: the app sets the arbiter fee to zero on every task it creates, so the insurance funds no arbiter. On an auto-resolved dispute the live ${AUTO_RESOLVE_DEFAULT} default governs the REWARD only — your insurance premium comes back to you whole, whoever raised it. An arbiter's ruling is different: it splits the insurance the same way as the reward. On a disputed ${EG.reward} XRD task with ${EG.credits.insurance} XRD insurance, the worker is credited ${EG.credits.worker} XRD of the reward and you are credited ${EG.credits.poster} XRD (the other half plus your premium), not ${EG.credits.funded / 2} each. The worker's claim bond is split the same way as the reward, so half of it is credited to you as well.`,
  },
  {
    label: "Radix network fees",
    detail:
      "The ordinary ledger transaction fee on the FUNDING transaction. Posting itself is not a ledger transaction and costs nothing. Paid to the network, not to the Guild.",
  },
];

const WORKER_COSTS = [
  {
    label: `Claim bond — 10% of the reward, floored at ${ESCROW_CLAIM_BOND_XRD} XRD, forfeitable`,
    detail:
      `A stake you post to claim a task, marking the claim as live: 10% of the task's reward, at least ${ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting). What can cost you is the expiry race, not the size of the stake. It is not handed back when you submit: it stays in the escrow until the task settles, is credited back to you in full when the work is approved or released after the review window, splits the way the reward does if a dispute is raised, and is collected with the same withdrawal as the reward. Submit has no deadline check, so even a late submission protects it. The catch is the race: once your deadline passes, expire_claim can be called by ANYONE, not only you or the poster, and it forfeits the whole bond and reopens the task. Not instantly, though: the contract refuses to expire a claim until ${ESCROW_EXPIRE_GRACE_SECS / 3600} hour past the deadline, so a late submit inside that hour still saves your bond from forfeiture. After that it is first-to-commit, and a claim left unattended can lose the whole bond to a stranger for the cost of their gas.`,
  },
  // The heartbeat cost row exists only while the deployed component has the
  // leg — under pull there is no such method and no cost to disclose.
  ...(settlementCopy("moneyHeartbeatRow")
    ? [{ label: "5 XRD heartbeat fee", detail: settlementCopy("moneyHeartbeatRow")! }]
    : []),
  {
    label: "Radix network fees",
    detail:
      settlementCopy("moneyNetworkFeeDetail")!,
  },
];

function MoneyContent() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Money, Bonds &amp; Trust</h1>
        <p className="text-muted-foreground text-sm mt-1">
          What leaves your wallet, where it is held, and the limits of the word &ldquo;escrow&rdquo;
          — worth reading before you sign anything on{" "}
          <Link href="/tasks" className="text-primary hover:underline">/tasks</Link>.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">LIVE — funds held on-chain</Badge>
          <Badge variant="outline" className="text-[10px]">{settlementCopy("moneySettlementBadge")}</Badge>
          <Badge variant="outline" className="text-[10px]">{settlementCopy("moneyFeeBadge")}</Badge>
        </div>
      </div>

      {/* What this is (ELI5) */}
      <Card>
        <CardContent className="pt-5 pb-5 space-y-2 text-sm leading-relaxed">
          <p>
            When you fund a task, your reward is locked in an on-chain vault dedicated to that one
            task until the work is approved. When you claim a task, you stake a bond that marks
            the claim as live: 10% of the reward, at least {ESCROW_CLAIM_BOND_XRD} XRD today (an
            owner setting). Reward and insurance sit in a Scrypto component on
            Radix mainnet and <span className="font-semibold">no owner method can touch them</span>.
          </p>
          <p className="text-muted-foreground">
            The bond is the one exception worth knowing:{" "}
            <span className="font-semibold text-foreground">a forfeited bond is not returned to
            you.</span> {settlementCopy("moneyForfeitVaultSentence")} That vault is funded by worker
            money, and its balance is public on the component for anyone to check.
          </p>
          <p>
            The limit worth reading before you approve any signature:{" "}
            {settlementCopy("moneyHonestLimit")} It is spelled out below.
          </p>
        </CardContent>
      </Card>

      {/* No token. Added 2026-09-01: /money is the page that explains our
          economics end to end, and it never said what the unit of account is
          NOT. An absence does not write itself down — someone has to notice it
          is load-bearing and state it. Deliberately placed BEFORE the cost
          breakdown, because "what am I actually paying in" should be settled
          before the numbers start. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
            There is no Guild token
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Every figure on this page is in <span className="font-semibold text-foreground">XRD</span>,
            the Radix network&apos;s own token, which we do not issue and cannot
            print. There is no Guild token, no sale, no airdrop, and no plan for
            one.
          </p>
          <p>
            The three things you hold here are deliberately not tradeable
            claims. Your <span className="font-semibold text-foreground">badge</span> is
            an NFT anyone can mint for the network fee — we do not sell it. Your{" "}
            <span className="font-semibold text-foreground">XP and trust record</span> are
            account records, earned by working and not purchasable; your badge tier is a
            field on the NFT. Your <span className="font-semibold text-foreground">reward</span> is
            XRD that a poster escrowed and you withdraw yourself.
          </p>
          <p>
            This is a design choice and it has a cost we accept: with nothing to
            issue, the marketplace has to earn from the royalty on funded tasks
            or it does not earn at all. That is the trade. If it ever changes it
            will be announced before it happens, not discovered afterwards.
          </p>
        </CardContent>
      </Card>

      {/* What it actually does — what leaves each wallet */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
            What leaves your wallet — poster
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {POSTER_COSTS.map((c) => (
              <div key={c.label} className="bg-muted rounded-lg p-3">
                <div className="font-semibold text-sm mb-1">{c.label}</div>
                <div className="text-xs text-muted-foreground leading-relaxed">{c.detail}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Reward and insurance are locked together, atomically, in one signature — the{" "}
            <span className="font-semibold">funding</span> signature, which is separate from and
            later than posting. XRD only, for now.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
            What leaves your wallet — worker
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {WORKER_COSTS.map((c) => (
              <div key={c.label} className="bg-muted rounded-lg p-3">
                <div className="font-semibold text-sm mb-1">{c.label}</div>
                <div className="text-xs text-muted-foreground leading-relaxed">{c.detail}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Insurance — the poster's own stake */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
            &ldquo;Insurance&rdquo; is the poster&rsquo;s own stake
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm leading-relaxed">
          <p>
            The insurance amount ({INSURANCE_PCT}% of the reward, rounded up to a whole XRD, in the
            same token) is the{" "}
            <span className="font-semibold">poster&rsquo;s own money</span>, held in the task vault.
            On the happy path it is returned whole.
          </p>
          <p>
            <span className="font-semibold">If the task is disputed, it does not fund an arbiter
            fee.</span> The 10% figure quoted elsewhere is <em>max_arbiter_fee_pct</em>, a ceiling on
            a parameter this app never sets — it writes an arbiter fee of{" "}
            <span className="font-mono">0</span> on every task it creates, so the insurance pays
            no arbiter; an arbiter&rsquo;s ruling splits it like the reward. What actually happens on
            an auto-resolved dispute is governed by the live
            component&rsquo;s default ruling —{" "}
            <span className="font-mono">{AUTO_RESOLVE_DEFAULT}</span> — and that ruling governs
            the <em>reward</em> only. The insurance premium is hardcoded back to the poster on
            this path, whoever raised the dispute; the blueprint does this deliberately, so that
            disputing can never out-earn being approved. Price the downside accordingly: on a{" "}
            {EG.reward} XRD task with {EG.credits.insurance} XRD insurance, the worker is credited{" "}
            {EG.credits.worker} XRD and you are credited {EG.credits.poster} XRD, not{" "}
            {EG.credits.funded / 2} each — and the worker&rsquo;s claim bond splits the same way as
            the reward, so half of it comes to you too.
          </p>
          <p>
            It is <span className="font-semibold">not</span> an underwritten policy, not a third-party
            guarantee, and not covered by the platform. A separate opt-in dispute-insurance
            product is designed but not deployed; this stake is not that.
          </p>
        </CardContent>
      </Card>

      {/* No platform fee */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
            There is no platform fee
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm leading-relaxed">
          <p>
            The fee is 0% today. The worker receives 100% of the reward, and that is chain-enforced,
            not a policy choice: every worker-side method — claim, submit, approve, withdraw — is
            locked <span className="font-mono">Free</span> on the deployed component, permanently.
          </p>
          <p>
            The poster-side dial is real, not planned: <span className="font-mono">create_task</span>{" "}
            carries an on-chain component royalty, attached at deployment and currently set to{" "}
            <span className="font-mono">0 XRD</span>. It can only move via the royalty-admin badge,
            and any change goes through a published RFC first. &ldquo;Free to use&rdquo; is still
            qualified: you always pay Radix network fees, the{" "}
            {settlementCopy("moneyFreeToUseQualifier")}
          </p>
        </CardContent>
      </Card>

      {/* Trust posture — BUG-7, stated plainly */}
      <Card className="border-primary/40">
        <CardContent className="pt-5 pb-5 space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">Honest limit</Badge>
            <span className="text-xs text-muted-foreground">{settlementCopy("moneyTrustPostureLabel")}</span>
          </div>
          <p className="text-sm leading-relaxed">
            {settlementCopy("moneyTrustPostureBody")}
          </p>
          {/* Names the phrases we refuse to use, so it necessarily contains
              them. data-honest-copy="quote" exempts this element from the
              launch-check scan, and the gate REPORTS the skip on every deploy
              (scripts/honest-copy.mjs). Marker on the disavowal only — the
              factual paragraphs around it stay scanned. */}
          <p className="text-sm leading-relaxed" data-honest-copy="quote">
            Because of that, this page — and every Guild surface — will never say{" "}
            <span className="font-semibold">&ldquo;trustless payout,&rdquo;</span>{" "}
            <span className="font-semibold">&ldquo;the contract pays the worker automatically,&rdquo;</span>{" "}
            or call disputes &ldquo;automatic/fair resolution.&rdquo;
          </p>
          {/* Both dispute-era paragraphs key on the same build-time flag that
              mounts the Raise-Dispute button — see DISPUTE_COPY. */}
          <p className="text-sm leading-relaxed">{disputeCopy("moneyDisputePosture")}</p>
          <p className="text-sm leading-relaxed">
            And the limit that matters most if you are the worker:{" "}
            <span className="font-semibold">nothing is credited until the poster approves, or the review window lapses and someone triggers the release.</span>{" "}
            {disputeCopy("moneyWorkerEscapeNote")}
          </p>
        </CardContent>
      </Card>

      {/* Verify it yourself */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Verify it yourself</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm leading-relaxed">
          <p>
            <span className="font-semibold">On-chain (now):</span> read the live escrow component and
            its config on the Radix Dashboard — the claim bond (
            <span className="font-mono">claim_bond_pct/floor/cap</span>), the arbiter-fee
            CEILING (0.1), and the{" "}
            <span className="font-mono">create_task</span> royalty are all on-ledger. The
            minimum insurance fraction is not one of them today: the chain&apos;s own floor (
            <span className="font-mono">min_insurance_fraction</span>) is{" "}
            {ESCROW_MIN_INSURANCE_FRACTION}, an owner-settable dial, so the escrow would accept a
            task funded with no insurance at all. The {INSURANCE_PCT}% this app locks on every task
            is its own policy, not a number you can read off the component. Read the
            arbiter-fee ceiling as what it is: a bound, not the fee. The per-task arbiter fee this
            app writes is 0, and the royalty is 0 too, which you can confirm on any task funded
            through this app rather than taking our word for it.
          </p>
          <p>
            <a href={DASHBOARD_COMPONENT} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-primary hover:underline break-all">
              {ESCROW_COMPONENT}
            </a>
          </p>
          <p className="text-muted-foreground">
            <span className="font-semibold text-foreground">Source audit:</span> opens at launch, and no
            date is set — the escrow blueprint is a private build until then, so no repo link is offered yet.
          </p>
        </CardContent>
      </Card>

      {/* Status labels used here */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Status labels used here</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground leading-relaxed">
          <p><span className="font-semibold text-foreground">LIVE</span> — reward, insurance and bonds are held in a Scrypto component on Radix mainnet today.</p>
          <p>{settlementCopy("moneyStatusRoutingRow")}</p>
          <p>{settlementCopy("moneyStatusFeeRow")}</p>
          <p className="pt-1">
            The plain-language marketplace flow lives on{" "}
            <Link href="/guide#how-it-works" className="text-primary hover:underline">how the Guild works</Link>;
            address-by-address verification is on{" "}
            <Link href="/trust" className="text-primary hover:underline">trust &amp; verification</Link>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function MoneyPage() {
  return (
    <AppShell>
      <MoneyContent />
    </AppShell>
  );
}
