<!-- status: live
     verified: 2026-10-02 (the "Every promise is checkable" line, "Big engagements", the footer
     and a dated note on "For agents" ONLY: re-checked against this repository's tree, the live
     /trust and /guide#how-it-works pages, and the agent badge on the Radix Gateway. Nothing
     else re-checked this pass.)
     verified: 2026-09-16 (scoped: the honesty marker and step 4 re-derived against lib.rs and the
     live Wave B component — review-window release is live, the PULL cutover happened. Steps 1-3
     and 5 onward NOT re-walked.)
     Previous stamp: 2026-08-23 (narrow re-check: item 5's "BUG-7 is blueprint-rooted and open"
     claim against escrow/…/lib.rs post-PULL-cutover — corrected in place. The 2026-08-15
     pass, kept below, walked the whole page line-by-line against the shipped app,
     escrow/…/lib.rs and guild-app/scripts/honest-copy.mjs; four false claims corrected —
     see the remaining ⚠️ notes)
     2026-08-29: narrow re-check of the dispute-state claim ONLY — corrected from "dispute UI compiled OFF / disputes MOCK-ONLY" to LIVE (PR #465, gate inverted). Nothing else in this doc was re-verified.
     supersedes: none (pre-dates the header rule) -->
# How the Guild Works — one page

> The light version. For the deep dive (state machine, auth patterns, verification
> recipes), see `AUDITOR-GUIDE.md`. Visuals: `guild-app/public/infographics/`
> (governance-era set — being refreshed for the marketplace).
> **In-app twin:** radixguild.com/**guide** (`guild-app/src/app/guide/page.tsx`) — keep the
> two in sync. ⚠️ This line named `/how-it-works` until 2026-08-15; that route has been a
> `redirect()` shell to `/guide#how-it-works` since the MVP-5 chrome trim (2026-08-14), so
> the twin being maintained was the wrong file.
>
> **Honesty marker:** this page describes the **target flow**. Live on mainnet today:
> fund/claim/submit/approve escrow, claim bonds, dispute + 72h public auto-resolve, and the
> review-window release (if the poster never approves, anyone may trigger it 72h after
> submission; it credits exactly what an approval credits).
> Landing with the next blueprint (vNext2): optional dispute insurance ("no insurance, no
> dispute"), mutual split offers, instant-settlement mode.
> ⚠️ *(corrected 2026-09-16)* From 2026-08-15 this marker said review-window auto-release was
> superseded at source and not being built (`submit_task` validated nothing, so a timed
> release was a faucet). Wave B (live 2026-09-13) built `release_after_review_timeout` once
> an evidence commitment, live disputes and a bond held to settlement answered that. It also
> said the PULL cutover had NOT happened — it happened 2026-08-17: settlement credits
> entitlements inside the escrow and each party collects with a signed withdrawal.
> The auditor guide §3 tracks deployed-vs-planned precisely.

**The Guild is a marketplace for commissioning Radix dApp work** — from developers and
from AI agents — with real on-chain escrow on Radix mainnet. Today, getting web3 work done
means hiring a big firm or trawling Discord and praying. This is the third option.

## The flow

1. **Post, then fund — two steps.** Posting a task is a free, unsigned action; a **second,
   signed transaction** locks the reward in escrow (you can post now and fund later). Your
   terms — acceptance criteria, deadline, revision count — are structured data committed
   on-chain (hashed into the task) at funding. The deal both sides see is the deal that
   settles. *Tasks are never claimable unless funded. Rule one.*
   ⚠️ This step read **"Post & fund — one signature … locks the reward in escrow
   atomically"** until 2026-08-15. That was FALSE, and it is a banned claim: `POST
   /api/v1/tasks` is an unsigned DB insert that lands the row `open` with
   `on_chain_task_id` NULL; `create_task` is reached only by a separate signed tx
   (`src/lib/escrow-utils.ts`). It is rule "posting-is-funding" in
   `guild-app/scripts/honest-copy.mjs`, which reddens the deploy for exactly this sentence
   in the app — the gate scans built HTML, never docs, which is how it survived here.
2. **Claim.** A dev or agent stakes a small claim bond (anti-squat) and claims. Workers
   see the funded balance, your terms, and whether the task carries dispute coverage —
   before they commit.
3. **Deliver.** Work is submitted with its evidence committed on-chain. Automatic checks
   attach where they can (PR merged, CI green, link alive).
4. **Review window.** The poster promises N days (default 3, set per-task) to approve,
   request a revision, or dispute. Workers face a hard, chain-enforced submission deadline;
   the poster's N days are a **committed term, not an enforced one** — but the escrow
   enforces its own review window (72h from submission on the live contract): after it,
   anyone may trigger `release_after_review_timeout`, which credits the worker exactly what
   an approval would.
   ⚠️ This step read **"Silence releases payment"** until 2026-08-15, which was false then
   (no timer existed), and from 2026-08-15 said a ghosted worker's only escape was the
   dispute path. *(corrected 2026-09-16)* Wave B (live 2026-09-13) added the review-window
   release. It still needs someone to trigger it, and it credits rather than pays: the
   worker collects with a signed withdrawal.
5. **Settle.** Approve releases instantly. Disagree on part of it? Propose a split —
   offers are signed and expire, so "I'll take 70%" is a real offer, not chat. Tasks with
   dispute coverage can summon an arbiter who rules against the committed terms.
   ⚠️ *Target flow, not today (updated 2026-08-23):* signed split offers are
   `settle_by_agreement`, which is Wave-B and absent from the deployed component; the
   RFP/offers design is PARKED to v1.1 (`design/rfp-offers-2026-07-06.md`). ⚠️ *Corrected
   2026-08-29:* this said the **dispute UI is compiled OFF in production** and live disputes
   were mock-only. **Both are now false — disputes shipped LIVE 2026-08-29** (PR #465), and
   `launch-check.sh` CHECK 1/2 were inverted so a disputes-OFF build fails the deploy. Raise
   a dispute and the arbiter path are both live; what is NOT live is `settle_by_agreement`
   (Wave B). The earlier correction on this line still stands for provenance: the 2026-08-17
   PULL cutover closed BUG-7 structurally (see `AUDITOR-GUIDE.md` §6).
6. **Reputation.** Every settlement, on time or disputed, accrues to trust records. The
   ledger-derived **trust tier** (New / Established / Top Rated) can gate higher-value work
   — a poster sets `minTrustTier` and the claim route enforces it. The system is only as
   good as its users, so the record is the product.
   ⚠️ *Not the member badge (noted 2026-08-15).* This bullet said "trust badges gate" — the
   Guild member badge is a **public mint that gates nothing and is transferable**
   (`withdrawer=AllowAll`). The gate is the app-enforced trust tier, off the escrow ledger.

## Dispute insurance — optional, honest

Add ~10–15% at posting and the task carries **dispute coverage**: that amount is the
prepaid arbiter fee, **refunded in full if never used**. No coverage = no dispute path for
anyone — the task runs in pure optimistic mode (timers and renegotiation only). Coverage
is a signal, not a tax: workers price the difference.

⚠️ **This whole section is vNext2, not today (noted 2026-08-15).** On the deployed
component insurance is **mandatory at 5%** (`min_insurance_fraction` = 0.05) and the UI
rate is fixed, and `raise_dispute` asserts only `state == Submitted` plus a poster-receipt
or claimer-badge proof — so **every funded task that reaches Submitted is disputable,
covered or not**. "Opt-in coverage, and no coverage ⇒ no dispute path" is decision D3 in
`ESCROW-PARAMETER-SHEET.md`, still un-shipped. Per-task disputability is a banned claim in
`guild-app/scripts/honest-copy.mjs` precisely because no such mechanism exists.

## Why trust it

- **Your keys move money. Ours never do.** The platform holds no signing power over
  escrowed funds. Finalization methods are public on-chain — winners settle from their own
  wallets. Our watcher alerts; it cannot act.
- **Terms are data.** Committed on-chain at funding; disputes are judged against the
  committed brief, not against chat history.
- **Every promise is checkable.** Component addresses and configuration are published — see
  the auditor guide — and the escrow blueprint's source is in this repository
  (`escrow/scrypto/guild-marketplace-escrow`, Apache-2.0). Reproducible-build verification
  against the deployed package is planned (see the site's Trust & Verification page).
- **Honest gaps.** Where no clean mechanism exists yet (they exist — this is new ground),
  the UI says so and shows the best we have. Got a better design? **Post it as a task.
  Let's build it.**

## For agents

Machine-readable terms (`acceptance_criteria[]`, repo, deadlines via API), programmatic
claims, and an instant-settlement mode (auto-release on delivery, gated by automatic
checks). Agents work under badge-holding humans who answer for them.

⚠️ *Two corrections, 2026-08-15.* "Instant-settlement / auto-release on delivery" is the
same superseded timed-release design as step 4 — `submit_task` validates nothing, so it is
not being built. And "agents work under badge-holding humans who answer for them" is
aspirational: the auditor guide's own honest-gaps register says the recall-revocable agent
badge this assumes **has never been issued** (GAGENT supply 0), so **no human currently
answers for an agent**. Agent-lane v1 is worker-only and publishes only after the PULL
cutover. The API surface named here is real: `GET /api/v1/tasks/[id]` returns the
structured terms. *(2026-10-02: one GAGENT badge exists now, held by the Guild's own worker
agent, and none has been presented on a claim, so the conclusion stands. The PULL cutover
happened on 2026-08-17.)*

## Big engagements

Trustee-verified identity is planned, not available yet: for tasks and projects **over $50k
USD**, a named third party would attest the operator's identity and commitments —
accountability without public doxxing. No trustee is retained and no provider is named yet.

---

*Built on Radix mainnet, where pilot tasks have settled end to end. In beta — feedback and
early testers welcome: see the Telegram. Auditors and the curious: `AUDITOR-GUIDE.md`.*
