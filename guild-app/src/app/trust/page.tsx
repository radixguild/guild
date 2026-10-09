import { disputeCopy, settlementCopy } from "@/lib/settlement-copy";
import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ESCROW_CLAIM_BOND_XRD,
  ESCROW_COMPONENT,
  NFT_SWAP_COMPONENT,
  NFT_SWAP_PACKAGE,
  TG_BOT_HANDLE,
  TG_BOT_URL,
  TG_GROUP_HANDLE,
  TG_GROUP_URL,
} from "@/lib/constants";
import { withPageOg } from "@/lib/page-metadata";

// Trust-page skeleton (Track B wave 1). Status rows fill in as TRUST-BACKING-PLAN
// steps execute (C1–C3 in DECISION-PACKET.md). P9: deployed-vs-planned markers,
// no claims ahead of reality.

export const metadata: Metadata = withPageOg("/trust", {
  title: "Trust & Verification — Radix Guild",
  description:
    "Verify, don't vouch: the known issues first, what is checkable on-chain today, and the status of each backing step — source publication, reproducible builds, the bug bounty and the trustee option for large engagements.",
});

// The questions a sceptic — or a troll — asks first (added 2026-09-20, before the
// site was shared on the Radix channels). Same rule as KNOWN_ISSUES: every answer
// was checked against the blueprint, the ledger or the live API the day it was
// written, and an answer that stops being true is deleted or rewritten in the
// change that makes it untrue. None of these is a defence. They are what is so.
//   - "cents": XRD/USD read from /api/v1/quote/xrd-usd AND CoinGecko, 2026-09-20.
//   - "check the code": rewritten at the open-source flip (2026-10-02). The source is
//     public (radixguild/guild); the package on-ledger is WASM, and no reproducible
//     build ties the two yet (BACKING_PLAN's second row, Planned). The live package
//     (Wave B, 2026-09-13) predates nft_swap in the crate, so a build of today's tree
//     does not reproduce its hash; the answer says so (F21 review, 2026-10-03).
//   - "owner powers": lib.rs enable_method_auth — the OWNER list is token admin,
//     freeze/unfreeze, withdraw_forfeited_bonds and ten setters. No owner method
//     touches a task's reward vault or a live bond. freeze_token only trips
//     create_task's "reward token is frozen; no new tasks" assert.
//   - "griefing": bond floor from ESCROW_CLAIM_BOND_XRD. lib.rs has NO reject method —
//     the poster-side calls after a submit are approve_and_release and raise_dispute;
//     release_after_review_timeout and auto_resolve_dispute (SplitEvenly) are public.
//     A first draft of this answer said junk "can be rejected"; it cannot.
const HARD_QUESTIONS = [
  {
    q: "The rewards are cents. Is this a joke?",
    a: `At today's XRD price the tasks on this board pay cents, not wages — every task page shows the dollar figure beside the XRD one, so you can see it before you click. Nothing here is compensation yet. What a task does give you is a real escrow settlement on mainnet that you can verify end to end, and a say in whether this is worth building further.`,
  },
  {
    q: "You say \"verify, don't vouch\" — can I check the code?",
    a: "Yes, you can read it: the source is public at github.com/radixguild/guild, under Apache-2.0, the escrow's Scrypto source included. What is not done yet is proving that the package on the ledger, which is compiled code, was built from that source: the reproducible build that would show it is still planned (the backing plan, below). Until it is done, verify behaviour as well as reading the code — every transaction, the component's state, and each public method and who may call it (the auditor's guide lists them). The live escrow package was built before the NftSwap blueprint joined this crate, so a build of today's tree will not reproduce its hash.",
  },
  {
    q: "Can the operator take the money in escrow?",
    a: "Not by reaching in. No owner-gated method on the escrow withdraws a task's reward or a live claim bond; the owner's powers are the settings listed above, adding and freezing reward tokens (freezing stops new tasks and touches nothing in flight), and collecting bonds that were already forfeited. Two real powers over funds remain, and you should weigh them: the operator is the only arbiter, deciding the split on a disputed task and able to take an arbiter fee (0 on tasks funded through this app) up to a limit that the same operator, as owner, sets; and the operator can change settings, two of which reach claims already in flight (Known Issues, above).",
  },
  {
    q: "Claiming costs almost nothing. Can't someone just squat or spam the tasks?",
    a: `Yes. The claim bond is 10% of the reward with a floor of ${ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting) — a few cents at today's price — so locking up a task is cheap. An hour after a squatted claim's deadline, anyone can end it, which forfeits the bond and reopens the task. Junk is harder: the contract cannot judge quality and has no reject method — the Reject button on a task page records the poster's decision but moves no money. A poster's only on-chain answer to a junk submission is to raise a dispute inside the 72-hour review window, and the arbiter then has to rule inside a second 72 hours — if he does not, the default even split pays the submitter half the reward, and half of their claim bond goes to the poster. If the poster does nothing at all, the contract releases the full reward. So a poster's attention is the real defence, and tasks with an objectively checkable deliverable are the safe ones. That is a real weakness at this price, not a solved problem.`,
  },
  {
    q: "Isn't every task here just the operator paying himself?",
    a: "Today, yes — it is the first item in the list above. It stops being true the day one person outside the operator completes a task, and that line will be deleted the same day.",
  },
];

// The canonical known-issues list (Beta 1, 2026-09-19). It sits ABOVE
// "Checkable Today" on purpose: a tester should read what is not there yet
// before they read what is. Every item was verified against the chain, the
// blueprint or the live API the day it was written — keep it that way. When an
// item is fixed, delete it here in the same change that fixes it; a stale
// known-issue is its own false claim.
const KNOWN_ISSUES = [
  {
    title: "Nobody outside the operator has used it yet",
    body: "Every task ever posted, claimed or paid here traces to an account the operator controls, and every dispute so far has been between the operator's own accounts. The escrow's full transaction history is public on the ledger, but it proves the machinery, not demand. If you use it, you are among the first.",
  },
  {
    title: "No independent audit of the live contract",
    body: "No third party has reviewed the escrow deployed today. The only scan on file checked an older version that has since been retired, and it came from our own pre-audit tool, which is not an audit. Treat any amount you put in accordingly.",
  },
  {
    title: "Built with AI, by one person",
    body: "Built by one pseudonymous developer with AI assistance. That is why this list exists, and why reports of what is wrong are the most useful thing you can send.",
  },
  {
    title: "One arbiter, and it is the operator",
    body: "Disputes are ruled by a single arbiter badge, held by the operator. There is no second opinion, and no mechanism yet to overturn a ruling. If nobody rules within the dispute window, anyone can then settle the task by the contract's default split.",
  },
  {
    title: "A poster can cancel after you claim",
    body: "Before you submit, the poster can cancel a task you have claimed. Your claim bond comes back in full, but the time you spent is not paid. Once you submit, the poster can no longer cancel.",
  },
  {
    // The in-app notifications switch is off on the live build, and the task
    // pager (scripts/task-activity-watch.mjs) pages the OPERATOR only. The bot's
    // escrow DMs cover bounties created through the bot, not tasks posted here.
    // Review window 259200s and expire grace 3600s read from the live component.
    title: "Nothing here tells you when your task moves",
    body: "The site sends no messages to posters or workers. If you posted a task, check it daily while it is claimed: 72 hours after work is submitted, anyone can release the full reward unless you have approved it or raised a dispute. If you claimed one, submit before the deadline on the task: an hour after it passes, anyone can end your claim and the bond is lost.",
  },
  {
    title: "The escrow owner can change its settings",
    body: "Ten owner-only calls change twelve settings — among them the claim bond, the review window and the arbiter-fee cap. Most are pinned into a task at the step that uses them (funding, claim, submission or dispute), so a change reaches only steps taken after it. Two reach claims already in flight: the grace period after a claim deadline before anyone can end the claim (an hour today), and the share of a forfeited bond paid to whoever ends it (10% today; the rest goes to a vault only the operator can withdraw). Every change emits a public on-chain event.",
  },
  {
    title: "The agent SDK is not on npm",
    body: "@radix-guild/agent-client is served only as a tarball from radixguild.com/kit/ (sha256 on /agents); its source is at github.com/radixguild/guild. Any language can use /openapi.json.",
  },
  {
    title: "The member badge verifies nothing",
    body: "Anyone can mint one, it can be transferred, and it does not prove identity or reputation. It is a key to use the board, not a credential.",
  },
];

const CHECKABLE_TODAY = [
  {
    title: "The escrow component, live on mainnet",
    body: "Every funded task's reward and insurance sit in the component's vaults — the escrow balances are public. Posting and funding are two separate steps, so a task can be listed before it is funded; those hold nothing on chain and are labelled 'Awaiting escrow funding — not claimable yet'. Inspect state, config, and transaction history directly on the Radix dashboard.",
    verify: "explorer",
  },
  {
    title: "Safety releases are public methods",
    body: `expire_claim, auto_resolve_dispute, and release_after_review_timeout all carry no badge requirement — anyone can call them once their time gate passes, so no absent platform can hold a task hostage. All three are deployed. release_after_review_timeout has run on the live component (once, 24 September 2026, releasing a task whose poster did not review in time); expire_claim and auto_resolve_dispute have not been called there yet. Two limits to know. release_after_review_timeout is callable only once the review window lapses (currently 3 days from submission) — until then a silent poster still leaves a worker waiting, and a worker who raises a dispute gives up that full-reward release for a 50/50 default if nobody rules in time. And because expire_claim is permissionless it cuts both ways — once a claim deadline and its short grace window (an hour on the live contract) have passed, anyone can call it and forfeit the claimer's whole bond — 10% of the reward, at least ${ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting) — racing a late submit that would otherwise still succeed. Submit before your deadline.`,
    // The trailing sentence is era-keyed (DISPUTE_COPY) — and its old form
    // ("No dispute has been settled on this component") was false in BOTH
    // eras once task 3's auto-resolve settled on 2026-08-26.
    verify: `Method table in the auditor's guide §1 — and the deployed package's own method-auth schema on the Radix dashboard, where expire_claim and auto_resolve_dispute both show as PUBLIC. ${disputeCopy("trustDisputeVerify")}`,
  },
  {
    // Was "The platform never signs on the money path" until 2026-09-24. The
    // Guild's own agents sign from keys on its server, and the one dispute
    // ruling on the live component (task 5, 2026-09-14) was signed by the
    // arbiter — the operator. What stays true: nothing signs FOR a user.
    title: "The platform never signs for you",
    body: `Our keeper is watch-only by decision: it alerts humans over Telegram and holds no signing key. Winners finalize from their own wallets. The Guild's own agents, which post and work tasks like any other account, sign from keys on the Guild's server. ${settlementCopy("trustKeeperSettlementNote")}`,
    // The keeper's script is not in the public repository (open-source flip,
    // 2026-10-02), so the recipe points at the ledger, which anyone can read.
    verify: "Auditor's guide §2, claim 2 — on the ledger: every approval and every withdrawal in the component's history is signed by the poster's or the worker's own account, and its one dispute ruling by the arbiter, the operator; no keeper account signs on the money path. You can read the signer off each transaction on the dashboard.",
  },
  {
    title: "Terms are committed at funding",
    body: "Acceptance criteria, deadlines, and revisions are SHA-256 committed into the task (work_brief_hash) at funding. Nothing about the brief can change afterwards without breaking that hash, so tampering is detectable by anyone. Honest scope: the component stores the hash, it does not judge against it — that is what the arbitration path is for, and it is an operator ceremony with no promised turnaround, not an automatic judge.",
    verify: "Auditor's guide §2, claim 3 — recompute the hash via the Gateway.",
  },
  {
    title: "The arbiter's independence is narrower than it sounds",
    body: "resolve_dispute checks one identity: the arbiter may not be the task's worker (the chain asserts it and reverts otherwise). It does not, and cannot honestly, check the poster — the poster field is a caller-supplied destination, not a verified identity, so a poster-side check would defeat itself for the price of a decoy address. In practice: an arbiter who funded a task may still rule on it. They cannot steal doing so — settlement pays only the accounts pinned at claim and funding, never the arbiter, beyond any arbiter fee funded (0 on tasks funded through this app) — but they can rule in their own favor as poster. The arbiter badge has supply 1 today, so this is worth weighing plainly rather than assuming away.",
    verify: "Disputes & Arbitration — resolve_dispute's self-dealing check, and what it deliberately does not cover.",
  },
  {
    // The swap recipe design/nft-swap.md §9 promised beside the escrow ones
    // (added 2026-10-07). Each call was run against the live component that day:
    // entity/details → blueprint NftSwap, the package below, state fields
    // `listings` (an internal_keyvaluestore_), `next_listing_id`,
    // `listing_receipt_manager`; key-value-store/data with a U64 key returns the
    // listing (src/lib/nft-swap-gateway.ts reads it the same way); the events are
    // the ones nft_swap.rs emits. package/page/codes returned 447,882 bytes whose
    // sha256 is the hash below — the bytes of the operator's own build, published
    // 2026-09-15. The crate's src/ at this repository's first commit (b9755c3) is
    // the source of that build (only tests/lib.rs differs); nobody else has
    // rebuilt it. Rewrite the last sentence when someone does, or when a
    // republished package replaces this one.
    title: "The NFT swap component, live on mainnet",
    body: "The /swaps board is read straight from the NftSwap component on the ledger; the site keeps no copy of it. A listing escrows one NFT with fixed asking terms, and a fill pays one of those terms and receives the NFT in the same transaction. There is no dispute path, no insurance and no review window, and a fill cannot be undone. The fee on a fill is a flat XRD royalty paid by the buyer, set by a dial the royalty-admin badge can change; it is 0 XRD today. Creator royalties are not collected, and a listing is not an appraisal.",
    verify: `On the Radix Gateway (mainnet.radixdlt.com): POST /state/entity/details on ${NFT_SWAP_COMPONENT} shows blueprint NftSwap from package ${NFT_SWAP_PACKAGE}, the next listing id, and in the state field "listings" the key-value store that holds every listing (add opt_ins.component_royalty_config to see the fee dials). POST /state/key-value-store/data on that store with the key {"kind": "U64", "value": "<listing id>"} returns one listing: the NFT, the asking terms, the expiry and its state. POST /transaction/committed-details with opt_ins.receipt_events on a swap transaction shows its ListedEvent, FilledEvent, CancelledEvent, ExtendedEvent or ProceedsWithdrawnEvent. POST /state/package/page/codes on the package returns its WASM, whose sha256 is 81ec78e4d0ac6f7a8f249d5f2f13529c4619d69e0530d69da54244fd876a660c: the bytes of our own build of escrow/scrypto/guild-marketplace-escrow, published on 15 September 2026, from the source in this repository's first commit (only the crate's tests have changed since). Nobody else has rebuilt it to confirm that yet.`,
  },
];

const BACKING_PLAN: {
  item: string;
  status: string;
  detail: string;
  proves: string;
  link?: { href: string; label: string };
}[] = [
  {
    item: "Escrow blueprint source published",
    status: "Done",
    // Done at the open-source flip (2026-10-02). Licence: Apache-2.0, decided
    // 2026-08-15 (root LICENSE + NOTICE). What ships under escrow/: the
    // guild-marketplace-escrow crate (the task escrow and NftSwap blueprints) and
    // the deprecated guild-escrow package, kept for reference. "proves" stops at
    // "anyone can read": the live escrow's package (Wave B, 2026-09-13) was built
    // before nft_swap joined the crate, so no build of this tree reproduces its
    // bytes as-is — tying source to package is the next row's job.
    detail: "Published at the open-source flip, at github.com/radixguild/guild under Apache-2.0: the app, the bot, the agent kits and the escrow's Scrypto source (the task-escrow and NftSwap blueprints, and a deprecated earlier escrow package kept for reference).",
    proves: "Anyone can read the auth roles and vault rules the auditor's guide describes. That they are exactly the code running on the ledger is what the next row, the reproducible build, will show.",
  },
  {
    item: "Reproducible-build verification",
    status: "Planned",
    detail: "Follows source publication: build the blueprint yourself, compare the hash against the deployed package. The live escrow package was built before the NftSwap blueprint joined this crate, so a build of today's tree will not reproduce its hash.",
    proves: "The published source compiles to exactly the deployed on-chain WASM.",
  },
  {
    item: "Bug bounty through our own escrow",
    status: "Planned",
    detail: "Next, now that the source is public: posted as real on-chain Guild tasks — the pot would be provably funded, and the payout path would be the product itself. Until then the beta bug bounty pays no cash — a report gets a reply and a straight answer (fixed, deferred or disagreed, with the reasoning), and credit by name or handle when the fix ships, if you want it — at ",
    link: { href: "/bug-bounty", label: "/bug-bounty" },
    proves: "Security claims have skin in the game, visible on-ledger.",
  },
  {
    item: "Trustee-verified identity for big engagements",
    // Was "Available on request" until 2026-09-24. No trustee is retained and
    // no provider is named, so nothing is available to request yet.
    status: "Planned — not available yet",
    detail: "Tasks and projects over $50k USD: a third party would attest the operator's identity and standing — accountability without public doxxing. No trustee is retained and no provider is named yet.",
    proves: "Large counterparties get recourse without the operator self-doxxing.",
  },
];

function TrustContent() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Verify, Don&rsquo;t Vouch</h1>
        <p className="text-muted-foreground text-sm mt-1">
          The Guild&rsquo;s trust story is not a promise — it is a set of artifacts you can check.
          This page tracks each one honestly: live, planned, or not there yet.
        </p>
      </div>

      {/* Known issues — deliberately first */}
      <Card className="border-amber-500/40">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Known Issues — Read This First</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {KNOWN_ISSUES.map((k) => (
              <div key={k.title} className="bg-muted rounded-lg p-3">
                <div className="font-semibold text-sm mb-1">{k.title}</div>
                <div className="text-xs text-muted-foreground leading-relaxed">{k.body}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* If something goes wrong (2026-09-24) — directly under Known Issues, and
          the footer's "Report a problem" lands here. Each "can" and "cannot" was
          checked against escrow/scrypto/guild-marketplace-escrow/src/lib.rs and
          scripts/suspend-account.mjs:
            - freeze_token trips only create_task's frozen assert; no owner method
              touches a task's reward vault or a live bond (withdraw_forfeited_bonds
              takes only bonds already forfeited);
            - review deadline pinned at submit_task, dispute window + default pinned
              at raise_dispute; expire_grace_secs and expire_bounty_pct are the two
              live reads (named in Known Issues);
            - payees pinned at create_task / claim_task; push_entitlement is PUBLIC
              and takes no destination, so anyone can deliver what is owed;
            - suspension is app-level only: the member badge is recaller DenyAll and
              public-mint, and claim_task checks only the badge resource;
            - the task pager runs every 30 minutes (crontab, since 2026-09-23) and pages each claim,
              submission, dispute and settlement to the operator.
          A forfeited bond is released by those rules: 10% to whoever ends the claim,
          the rest to the owner's vault — hence "take them out early" below. */}
      <Card id="if-something-goes-wrong" className="scroll-mt-20">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">If Something Goes Wrong</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-3 text-xs leading-relaxed">
            <div>
              <dt className="font-semibold text-sm">Money or security</dt>
              <dd className="text-muted-foreground">
                Funds in the wrong place, a transaction you didn&rsquo;t expect, a way to take what
                isn&rsquo;t yours: message{" "}
                <a href="https://t.me/bigdev_xrd" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  @bigdev_xrd
                </a>{" "}
                privately on Telegram with the task number and transaction id. Please don&rsquo;t post
                details publicly until it is fixed. These reports come first.
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-sm">Anything else</dt>
              <dd className="text-muted-foreground">
                A stuck task, a confusing page, a broken button: post in the Guild group,{" "}
                <a href={TG_GROUP_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  {TG_GROUP_HANDLE}
                </a>
                . Updates on any incident are posted there too.
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-sm">Watching</dt>
              <dd className="text-muted-foreground">
                The operator is alerted automatically, within about 30 minutes, whenever a task on the
                escrow is claimed, submitted, disputed or settled.
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-sm">Your funds</dt>
              <dd className="text-muted-foreground">
                Rewards and claim bonds stay in the escrow until its own rules release them. Nobody,
                the operator included, can take them out early or send a payment to a different
                account. If this site is down or paused, the contract keeps running and its deadlines
                still apply. If you can&rsquo;t collect what you&rsquo;re owed — because the site is
                down, or you no longer hold the badge you claimed with — ask in the group: anyone,
                the operator included, can deliver it to the account it is owed to.
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-sm">The operator can</dt>
              <dd className="text-muted-foreground">
                Take this site offline or roll it back; suspend an account&rsquo;s access to this
                site; stop new tasks being funded; change escrow settings (a change applies only to
                steps taken after it, except the two Known Issues names, which reach claims already
                in flight); cancel a task the operator posted, until work is submitted; rule
                disputes, as the only arbiter; and mint more arbiter badges, each assigned to one
                account, so one arbiter is a choice today, not a limit the contract enforces.
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-sm">The operator cannot</dt>
              <dd className="text-muted-foreground">
                Withdraw a task&rsquo;s reward or a live claim bond, reverse a settlement, redirect a
                payment, pause the contract (freezing stops only new tasks), move a review or
                dispute deadline once it has started, or stop a particular person from using the
                contract directly — suspending an account here does not reach the chain.
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-sm">Our accounts</dt>
              <dd className="text-muted-foreground">
                radixguild.com,{" "}
                <a href="https://t.me/bigdev_xrd" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  @bigdev_xrd
                </a>
                , the group{" "}
                <a href={TG_GROUP_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  {TG_GROUP_HANDLE}
                </a>{" "}
                and the bot{" "}
                <a href={TG_BOT_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  {TG_BOT_HANDLE}
                </a>
                . Nobody from the Guild will message you asking you to send XRD to an account, share
                your seed phrase, or connect your wallet anywhere else. The agent kit&rsquo;s one line
                comes only from{" "}
                <Link href="/agents#kit" className="text-primary hover:underline">radixguild.com/agents</Link>
                , with its sha256 printed beside it — a line someone sends you is not it.
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Hard questions — asked plainly, answered from what is true today */}
      <Card id="hard-questions">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Hard Questions</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-4 text-sm">
            {HARD_QUESTIONS.map((h) => (
              <div key={h.q} className="space-y-1">
                <dt className="font-semibold">{h.q}</dt>
                <dd className="text-muted-foreground leading-relaxed">{h.a}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      {/* Checkable today */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Checkable Today</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {CHECKABLE_TODAY.map((c) => (
              <div key={c.title} className="bg-muted rounded-lg p-3">
                <div className="font-semibold text-sm mb-1">{c.title}</div>
                <div className="text-xs text-muted-foreground leading-relaxed">{c.body}</div>
                <div className="text-xs leading-relaxed mt-2">
                  <span className="font-semibold text-primary">Verify:</span>{" "}
                  {c.verify === "explorer" ? (
                    <a
                      href={`https://dashboard.radixdlt.com/component/${ESCROW_COMPONENT}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline break-all"
                    >
                      {ESCROW_COMPONENT}
                    </a>
                  ) : (
                    <span className="text-muted-foreground break-words">{c.verify}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Recipes with exact steps:{" "}
            <Link href="/auditor-guide" className="text-primary hover:underline">the auditor&rsquo;s guide</Link>.
          </p>
        </CardContent>
      </Card>

      {/* Backing plan */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">The Backing Plan — Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {BACKING_PLAN.map((b) => (
              <div key={b.item} className="bg-muted rounded-lg p-3">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="font-semibold text-sm">{b.item}</div>
                  <Badge
                    variant={b.status === "Available on request" ? "secondary" : "outline"}
                    className="text-[10px] shrink-0"
                  >
                    {b.status}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground leading-relaxed">
                  {b.detail}
                  {b.link && (
                    <>
                      <Link href={b.link.href} className="text-primary hover:underline">
                        {b.link.label}
                      </Link>
                      .
                    </>
                  )}
                </div>
                <div className="text-xs leading-relaxed mt-2">
                  <span className="font-semibold text-primary">What it proves:</span>{" "}
                  <span className="text-muted-foreground">{b.proves}</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Honest gaps pointer + CTA */}
      <Card>
        <CardContent className="pt-5 pb-5 space-y-2">
          <p className="text-sm leading-relaxed">
            Where no clean mechanism exists yet, we say so:{" "}
            <Link href="/auditor-guide#honest-gaps" className="text-primary hover:underline">
              the honest-gaps register
            </Link>{" "}
            is live, not historical. Got a better mechanism?{" "}
            <span className="font-semibold">Post it as a task. Let&rsquo;s build it.</span>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function TrustPage() {
  return (
    <AppShell>
      <TrustContent />
    </AppShell>
  );
}
