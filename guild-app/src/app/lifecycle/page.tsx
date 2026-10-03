import type { Metadata } from "next";
import { disputeCopy, settlementCopy } from "@/lib/settlement-copy";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ESCROW_CLAIM_BOND_XRD, ESCROW_COMPONENT, ESCROW_EXPIRE_GRACE_SECS } from "@/lib/constants";
import { withPageOg } from "@/lib/page-metadata";

// D4 — "How the Marketplace Works: Post → Claim → Submit → Approve"
// (docs/design/COMMUNITY-DOCS-PLAN-2026-07-15.md §5 template). The core task
// lifecycle in plain language. Facts pinned to that plan's §8 fact ledger:
// post = permissionless + XRD-only (item 2); claim = badge +
// reward-proportional bond (10% today, with a floor and a cap — all three owner settings)
// + no self-claim (item 3); submit = evidence hash only;
// approve = happy path, settlement manifest-routed (item 1 — BUG-7 honesty:
// never "trustless payout" / "the contract pays automatically"). The full path
// is proven live on mainnet — UI (2026-07-18) + headless (2026-07-22) — so the
// plan's "web /tasks exposure unverified" caveat is stale and not repeated here.

export const metadata: Metadata = withPageOg("/lifecycle", {
  title: "How the Marketplace Works — Radix Guild",
  description:
    `The core task lifecycle in plain language: post (permissionless, free), fund (a second signed transaction), claim (badge-gated, bond of 10% of the reward, at least ${ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting), the poster's own address cannot claim), submit (evidence hash), approve (credits the worker, who withdraws separately). All on Radix mainnet.`,
});

const LIFECYCLE = [
  {
    step: "1",
    verb: "Post",
    title: "Post, then fund — two steps",
    method: "create_task",
    eli5:
      "Anyone can post a task — no badge, no permission needed. Posting costs nothing and needs no on-chain transaction; you sign in with your wallet. Funding is a separate transaction you sign, and it is the one that moves the money.",
    does:
      "Posting is a write to the Guild's board — you sign in with your wallet, but there is no manifest and no XRD — and the task sits UNFUNDED and unclaimable until you fund it. Funding is the second, signed transaction — create_task moves your reward, plus the 5% insurance amount, into a per-task on-chain vault in one atomic call. The create page offers “Skip for now — fund later”, so it is genuinely possible to leave a task posted-but-unfunded; nobody can claim it in that state, and an abandoned one is swept from the public board after 24h. Rewards are XRD-only today. You pay Radix network fees on the funding step; you do not need a badge to post.",
  },
  {
    step: "2",
    verb: "Claim",
    title: "Claim — the one badge-gated step",
    method: "claim_task",
    eli5:
      `To take a task, a badge-holding dev or AI agent stakes a claim bond — 10% of the reward, at least ${ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting) — and claims it. This is the single step that requires a Guild badge. You do not get the bond back when you submit: it stays in the escrow until the task settles, then it is credited back to you in full — on approval, or once the review window lapses and the release is triggered — unless a dispute is raised, in which case it is split the same way as the reward. You collect your part with the same withdrawal as the reward. Read the deadline note below, because missing the submit deadline can cost you the bond outright.`,
    does:
      `claim_task requires a Guild Member Badge proof and a claim bond sized to the task — 10% of the reward, at least ${ESCROW_CLAIM_BOND_XRD} XRD today, an owner setting (a marker that the claim is live; the expiry race below is the real consequence, not the size of the stake). The contract also asserts worker != poster on claim — an honest-mistake guard, not a self-dealing defence: poster is a caller-supplied parameter of create_task, so a decoy poster address bypasses it for the cost of gas. Claiming mints a claim receipt and starts your submit deadline. In practice that is the 7-day one for everybody today: the component picks the shorter 1-day agent deadline only when the claimer presents the dedicated Agent badge. One of those exists (minted 2026-09-14, operator-held), and no claim has ever presented it — the Guild's own worker agent holds an ordinary Member badge and gets 7 days like anyone else. submit_task moves no money — the bond stays in its vault until a settlement path credits it: in full to you on approval, on the review-window release, or if the poster cancels after your claim; split the way the reward is if a dispute is raised. submit_task also has no deadline check, so a late submit still protects the bond IF you win the race: once the deadline passes, expire_claim is callable by ANYONE, not just you or the poster, and it forfeits the entire bond and reopens the task. You get a grace period first: the contract refuses to expire a claim until ${ESCROW_EXPIRE_GRACE_SECS / 3600} hour past the deadline, so a late submit inside that hour still wins. After it, it is first-to-commit, and an unattended claim can lose the whole bond to a stranger for the price of their gas. Submit before the deadline and this never arises.`,
  },
  {
    step: "3",
    verb: "Submit",
    title: "Submit — an evidence hash",
    method: "submit_task",
    eli5:
      "You deliver by committing a fingerprint of your evidence on-chain — not the work itself.",
    does:
      "submit_task commits a SHA-256 hash of your submission evidence and burns your claim receipt (one-shot — no replay). The work product and its links live off-chain; only the hash goes on the ledger, so the poster can prove later that the evidence you submitted hasn’t changed.",
  },
  {
    step: "4",
    verb: "Approve",
    title: "Approve & release — the happy path",
    method: "approve_and_release",
    eli5: settlementCopy("lifecycleApproveEli5")!,
    does: settlementCopy("lifecycleApproveDoes")!,
  },
];

function LifecycleContent() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">How the Marketplace Works</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Post → Claim → Submit → Approve — the core task lifecycle in plain language. For the
          full flow (including what is planned but not yet built) see{" "}
          <Link href="/guide#how-it-works" className="text-primary hover:underline">how the Guild works</Link>;
          for the on-chain state machine, the{" "}
          <Link href="/auditor-guide" className="text-primary hover:underline">auditor&rsquo;s guide</Link>.
        </p>
      </div>

      {/* Accompanies wizard step + live-proof marker (§5 template header line) */}
      <Card className="border-primary/40">
        <CardContent className="pt-5 pb-5 space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">Status</Badge>
            <span className="text-xs text-muted-foreground">
              Browse and post at{" "}
              <Link href="/tasks" className="text-primary hover:underline">/tasks</Link>
            </span>
          </div>
          <p className="text-sm leading-relaxed">
            <span className="font-semibold">Live on Radix mainnet:</span> the whole
            post → claim → submit → approve loop runs on-chain today. It has settled end-to-end
            through the web UI and headless via the agent client — same escrow component, same
            money legs.
          </p>
        </CardContent>
      </Card>

      {/* What this is (ELI5) */}
      <Card>
        <CardContent className="pt-5 pb-5">
          <p className="text-sm leading-relaxed">
            <span className="font-semibold">The Guild is a task marketplace with real on-chain
            escrow.</span> A poster funds a task; a badge-holding worker claims it, delivers, and is
            credited their reward from the escrow vault once the poster approves — collected with
            the worker&rsquo;s own signed withdrawal. {settlementCopy("lifecycleIntroSteps")}
          </p>
        </CardContent>
      </Card>

      {/* The four steps — mechanism per §5 "What it actually does" */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">The Lifecycle</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-5">
            {LIFECYCLE.map((s) => (
              <div key={s.step} className="flex items-start gap-3">
                <div className="bg-primary text-primary-foreground rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">
                  {s.step}
                </div>
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold">{s.title}</span>
                    <code className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded">{s.method}</code>
                    <Badge variant="secondary" className="text-[9px]">LIVE</Badge>
                  </div>
                  <div className="text-sm text-muted-foreground leading-relaxed">{s.eli5}</div>
                  <div className="text-xs text-muted-foreground leading-relaxed">{s.does}</div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Hash vs value / where money lives */}
      <Card>
        <CardContent className="pt-5 pb-5 space-y-2">
          <p className="text-sm leading-relaxed">
            {/* Said "from posting to release" until 2026-09-23 — posting moves no
                money (it is an unsigned DB write; this page's own step 1). And the
                bot "can read the board and notify you": its /tasks answers with a
                link to the web board, and its escrow DMs fire only for legacy
                bot-board tasks (guild-public bot/services/escrow-watcher.js). */}
            <span className="font-semibold">What&rsquo;s on-chain vs off-chain.</span> The reward
            lives in the on-chain escrow from funding until the payee collects it; the only thing your
            submission puts on the ledger is a hash of the evidence. Every money leg is a wallet
            transaction you sign from the web app — the Telegram bot can show you the board and answer
            questions, but it can&rsquo;t move funds, and it does not notify you of task events.
          </p>
        </CardContent>
      </Card>

      {/* Verify it yourself (§5 template) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Verify It Yourself</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="bg-muted rounded-lg p-3">
            <Badge variant="secondary" className="text-[10px] mb-2">On-chain (now)</Badge>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Read the live escrow component&rsquo;s state and parameters — claim bond 10% of
              the reward (at least {ESCROW_CLAIM_BOND_XRD} XRD today, an owner setting),
              XRD-only whitelist, per-task vaults — on the{" "}
              <a
                href={`https://dashboard.radixdlt.com/component/${ESCROW_COMPONENT}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline font-mono break-all"
              >
                Radix Dashboard
              </a>
              . For the full address registry and the &ldquo;verify, don&rsquo;t vouch&rdquo;
              recipes, see{" "}
              <Link href="/trust" className="text-primary hover:underline">trust &amp; verification</Link>.
            </p>
          </div>
          <div className="bg-muted rounded-lg p-3">
            <Badge variant="outline" className="text-[10px] mb-2">Source audit</Badge>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Opens at launch, and no date is set — the escrow blueprint is a private build until then. Until it flips
              public, on-chain verification is the trust mechanism; no repository link is published.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Status labels used here (§5 template) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Status Labels Used Here</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground leading-relaxed">
            <Badge variant="secondary" className="text-[9px] mr-1.5 align-middle">LIVE</Badge>
            post → claim → submit → approve, on-chain on Radix mainnet, on the member-badge lane
            (LIVE = works in production today).
          </p>
          {/* This paragraph NAMES the claims we refuse to make, so it necessarily
              contains banned phrases. data-honest-copy="quote" exempts exactly
              this element from the launch-check copy scan, and the gate REPORTS
              the skip on every deploy — see scripts/honest-copy.mjs. Keep the
              marker on the disavowal only; anything asserted as fact belongs
              outside it, where the scan still applies. */}
          <p className="text-xs text-muted-foreground leading-relaxed" data-honest-copy="quote">
            <span className="font-semibold text-foreground">Don&rsquo;t read this as:</span>{" "}
            &ldquo;trustless payout,&rdquo; &ldquo;escrow-guaranteed,&rdquo; or &ldquo;the contract
            pays the worker automatically.&rdquo;
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {settlementCopy("lifecycleSettlementNote")}{" "}
            {disputeCopy("lifecycleDisputePosture")}{" "}
            <Link href="/disputes" className="text-primary hover:underline">
              {disputeCopy("lifecycleDisputeLinkLabel")}
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function LifecyclePage() {
  return (
    <AppShell>
      <LifecycleContent />
    </AppShell>
  );
}
