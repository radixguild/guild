<!-- status: live
     verified: 2026-10-06 (wording only: §9's 2026-10-02 note now says "no percentage bound of
     the Guild's own on the ledger", the same fact, phrased so the honest-copy fee-cap rule that
     now scans this doc reads it as the denial it is. Nothing re-checked.)
     verified: 2026-10-02 (SCOPED: the deployed fee instrument only — the top note, the 08-15
     note's fee-dial bullet, §2.2, §3 and §9's F1/F2/F4 — against escrow/…/lib.rs's royalty
     block, both PULL-era components' royalty config on the Radix Gateway, and the live /docs
     and /money pages. The economic argument itself was not re-derived.)
     verified: 2026-09-07 (§1 cost base only — re-measured from ccusage, git activity and the
     VPS/domain/CI lines; the public mirror is /docs#transparency. Everything else stands at the
     2026-08-15 check below.)
     previously: 2026-08-15 (§9's F1-F6 decision rows re-checked against DECISION-PACKET.md, the
     live component config in PROJECT-STATE.md and the 08-04 Launch Shape B ruling; §11's
     PROPOSED marker re-checked against the 08-01 pricing decision. The economic argument and
     the research base in §0-§8 were not re-derived and stand as written on 2026-06-12 — this
     is the doc the fee shape is argued in, and that argument has not been revisited.)
     supersedes: none (pre-dates the header rule) -->

# Fee & Business Model — evidence-based design

> ⚠️ **What was built — read this before §2, §3 and §9 (2026-10-02).** The fee instrument on
> the live component is a **flat XRD royalty on `create_task`**, the call that funds a task
> on-chain, and it is **set to 0 XRD**. It is not a percentage of the reward: there is **no
> percentage fee and no percentage bound**, and nothing in the contract caps the dial below the
> Radix network's per-call royalty maximum (about 166.67 XRD). Every other method, the
> worker's legs included, is free and locked at instantiation. Only the royalty-admin badge can
> move the dial, and the site says any change goes through a published RFC first. The dial has
> been on the production component since the PULL cutover (2026-08-17); the live Wave B
> component carries the same one. So the percentages below — the 2.5% cap (F1), the 0% → ~1%
> beta dial (F2), the lifetime 1% cohort (F4) and the §3 phase table — are the 2026-06 design,
> not what runs; the live /docs and /money pages state the deployed model. And the beta is not
> closed: signing in, minting the badge and claiming need nobody's approval.

> ⚠️ **Freshness note 2026-08-15 — the model stands; three pointers have moved.**
> - **`PRODUCTION-SCHEDULE.md`, cited as the companion below and in §9's landing map, is
>   ARCHIVED** (2026-08-06 → `archive/PRODUCTION-SCHEDULE-2026-06-12.md`, in the private
>   repository this one was exported from). The governing plan is `EXTERNAL-V1-FRAMEWORK.md`,
>   kept in the private operations repository.
> - 🔴 **No fee dial exists on the production component.** F1/F2's numbers are *decided*, not
>   *deployed*: the royalty instrument rides the **PULL cutover (P2)**, which has not happened.
>   Today the fee is 0% by **structural absence**, not by a dial set to zero — which is why
>   launch copy must strip fee claims entirely rather than describe a 0% rate. Launch Shape B
>   (2026-08-04) reconfirmed the shape: **worker 0% forever, poster-side only, under a published
>   on-ledger cap.** *(Superseded 2026-08-17: the PULL cutover attached the dial, a flat XRD
>   royalty set to 0 with no Guild-specific cap — see the note at the top.)*
> - **§11's `PROPOSED` marker is out of date.** The agent-lane pricing question was **decided
>   2026-08-01**: the *testing* rate is **AI cost + 20%**, benchmarked against **external API
>   cost** (never the internal near-zero Max-subscription cost), and **live rewards are PARKED**.
>   The 5×/3× reward-to-cost benchmark below was not what was adopted — read §11 as the analysis
>   that fed that call, not as the call.

> 2026-06-12 · Status: Direction decided in shape; final numbers go in the decision packet
> (rows in §9, mirrored in `ESCROW-PARAMETER-SHEET.md`, kept in the private operations
> repository). Companion: `PRODUCTION-SCHEDULE.md` Q3/Q4 (archived — see the note above),
> `TRUST-BACKING-PLAN.md`. Research basis: three-lane sweep 2026-06-12 (web3 protocol
> revenue, incentive/bootstrap design, marketplace take rates — the take-rate lane partially
> covered by the others; off-platform-leakage circumvention studies not pulled, directional
> evidence only).

## 0. Verdict — be ENS-shaped, not Upwork-shaped

The platforms that actually cover their costs from fees share four properties: the fee is
taken **where value settles** (not where goodwill permits), it is **small relative to the
value-at-risk it removes**, the flows are **recurring**, and **opex is kept brutally low**.
ENS is the model case: ~$20–29M/yr of registrar-contract fees against ~$7–13M/yr spend, no
token dependence, no drama. Meanwhile **no work platform covers opex from take rates
alone**: Immunefi's 10% fee implies ≤~$11M cumulative against venture-scale burn,
Code4rena abandoned its fee business entirely (June 2025 — now a free talent pipeline for
Zellic's audit consultancy), Juicebox's perfectly-enforceable 2.5% earned $542K lifetime
because volume died, and Kleros routes 100% of fees away from its own builders by design.

Translation for the Guild: our **method royalty on settlement is structurally enforceable**
(the OpenSea-platform-fee class, not the NFT-royalty class that collapsed −95–98% in 18
months) — but at our GMV it funds nothing for a long time. So the fee's early job is
**signaling the permanent deal**, the real early subsidy is founder time (which is normal —
that's every marketplace's seed phase), and sustainability comes from keeping costs at
solo-operator scale until volume arrives.

## 1. Cost base (what "pays for itself" means)

| Cost | Today (measured 2026-09-07) | At public beta |
|---|---|---|
| Infra (VPS, domain, Gateway is free) | **$25.85/mo** — Guild VPS (Hostinger KVM 2) $261.07/yr = $21.76/mo + radixguild.com domain $49.12/yr = $4.09/mo (hPanel invoices, 2026-09-07). The old "~$8/mo" and "~$30–50/mo" figures here were both unmeasured guesses | ~$50–100/mo (+ Composer sidecar) |
| CI (GitHub Actions, private-repo runners) | **~$25–30/mo** (~$1/day; $39.01 spent at 08-30 against a $100 spending limit — operator-reported) | same |
| AI tooling (Claude subscription, shared across bigdev's projects) | **A$170/mo cash today (≈ US$110; was A$350/mo for the heavy build months, plus A$70 of credits — operator-stated 2026-09-07)**; the Guild is ~30% of measured usage (per-project re-pricing of retained transcripts), so **~$40/mo attributable**. API-equivalent of the compute consumed: **$17,486 for 2026-07-08 → 09-06, all projects** (`ccusage monthly`: Jul $3,704 · Aug $10,925 · Sep-to-date $2,854) — a value, not a bill | bigdev's call |
| AI advisory (Tier 1.5 disputes) | ~cents/dispute | ~$10–50/mo at volume |
| Arbiter hours | bigdev | priced from insurance (pass-through, not a cost) |
| Development | bigdev time — **95 active commit days 2026-04-03 → 09-04** across guild-saas + guild-public + scrypto-xrd (14/16/15/22/24/4 by month); guild-saas first→last-commit spans sum to 512 h, so **~600–900 h** is the honest range; unpaid | bigdev time + fee-funded bounties |

Sunk to date (Apr → 7 Sep 2026): **~$1,200 cash** all-in (subscription + credits ≈ A$1,600 ≈ US$1,050, domain $40, VPS ~$35, CI ~$40), of which **~$550 is Guild-attributable**; plus the unpaid labour above and ~$8–10k of Guild-attributable API-equivalent compute. On-chain fees are well under $1; the ~40.9k XRD fleet is working capital (≈ $22 at $0.00055, CoinGecko 2026-09-07), not spend.

Break-even on hard costs (**~$93–118/mo** — infra + CI + the Guild's AI share; recomputed 2026-09-07 with the corrected $25.85/mo infra figure above, up from the previous ~$75–100/mo estimate that assumed ~$8/mo infra) needs **~$3.7–4.7k/mo GMV at 2.5%** (previously stated as ~$3–4k/mo). A modest living
($8k/mo) needs **$320k/mo GMV at 2.5%** — or $80k at a web2-style 10%, which we are
deliberately not charging (§2). Honest math: below ~$50k/mo GMV the fee is a legitimacy
signal and future-rights anchor, not a business.

## 2. The fee architecture — "the deal"

1. **Workers: 0%, forever, in writing.** Supply of trusted devs is the hard side
   (maker-taker logic; Braintrust 0%/10% and Lemon.io devs-keep-100% precedents). This is
   the loudest recruiting message we have and it costs us nothing at current scale.
2. **Posters: settlement fee via component method royalty.** Cap **published on-ledger at
   vNext2 instantiation** (proposed 2.5%); dial **starts at 0% for closed beta**, moves to
   ~1% at public beta, toward the cap only with real volume. *(2026-10-02: not what was
   built — the deployed royalty is a flat XRD amount on `create_task`, at 0, with no
   percentage and no Guild-specific cap; see the note at the top.)* Precedent for capped-dial
   trust framing: Juicebox (2.5% live under a hard 5% in-contract ceiling) and Uniswap v4's
   code-bounded fee switch — "the worst case is on-ledger" converts a trust problem into a
   verification problem, exactly like our escrow does for counterparty risk. Sablier's 2025
   fee flip adds the social rule: **grandfather in-flight escrows on any dial change.**
3. **Flat minimum fee** (proposed ~1 XRD): a % of a dust task is dust; Sablier's
   flat-dollar-at-claim model shows small fixed fees at the settlement path are accepted.
4. **Insurance: pass-through, not profit.** The arbiter fee pays the arbiter (pay-as-you-go
   support). Kleros proves fees-to-jurors works; Kleros also proves taking nothing for the
   platform starves the builder — hence the royalty exists alongside.
5. **Forkability, faced honestly:** anyone can fork a free frontend onto our component —
   **the royalty still collects** (Uniswap-Labs-fee logic inverted in our favor). Anyone
   can redeploy the blueprint with the dial at zero — the defense is non-code moats:
   task liquidity, escrow track record, dispute infrastructure, and reputation that doesn't
   transfer to the fork (SushiSwap's vampire attack failed against exactly these). Low-
   frequency, trust-heavy markets have weak fork gravity; Blur-style fee-war defection
   required a token war chest in a high-frequency market.

## 3. Phased fee schedule

*(2026-10-02: this is the 2026-06 percentage plan, kept as history. What runs is a flat
royalty on `create_task` set to 0 XRD, in an open beta; see the note at the top.)*

| Phase | Poster fee | Why |
|---|---|---|
| Closed beta (the 2026-06 plan's "now") | **0%** + schedule published | Fees can't fund anything yet; the published schedule IS the product promise |
| Public beta (~Oct) | **~1%** + flat min | Legitimacy + first revenue; still far under the "cheaper than the risk" line |
| Scale (post-PMF) | dial toward **2.5% cap** | Only with volume; grandfather in-flight tasks at each change |
| Founding posters | **lifetime 1%** (capped, named cohort — proposed first 20 funded projects) | Status/fairness commitment honorable forever at trivial cost; evidence says expect goodwill, not a liquidity engine |

## 4. Incentive playbook (adopted, ranked by evidence)

1. **Founder-as-concierge** — hand-recruit the first ~20 suppliers from the existing Radix
   trust graph; personally broker the first ~50 transactions (Toptal seeded from the
   founder's own network; A.Team hit 4,000 builders by referral in stealth; every major
   network's first 1,000 users came from direct outreach).
2. **Invite-only founding cohort with a permanent genesis badge** — hard vetting as the
   status product ("top 3%" framing); acceptance is the reward. Aligns with the
   trust-badge seeding strategy already in `TRUST-BACKING-PLAN.md` §5.
3. **Seed demand with our own funded bounties** — Superteam Earn went from exactly this to
   $10.28M paid out, no token, escrow + XP only. Our bug bounty (trust plan step 2) is
   simultaneously the first seeded demand.
4. **Single-player value before liquidity** — portfolio/badge pages, escrowed invoicing,
   verifiable work history useful with zero counterparties (OpenTable doctrine).
5. **Reputation as career capital, deliberately exportable** — on-chain badges + public
   API. The 2024 Electronic Markets finding: imported ratings carry only ~35% of native
   ratings' effect — so exportability is a cheap honesty gesture that barely dents lock-in.
   Design against the Stack Overflow failure mode: tiers grant *capabilities* (priority
   matching, vouching rights, **fee discounts** — Binance-VIP pattern), never gatekeeping
   power over newcomers.
6. **Referrals in-kind only** — fee credits/reputation, both-sided, **gated on completed
   paid work + badge identity** (Dropbox +60% permanent lift vs PayPal's $60–70M mercenary
   burn; crypto sybil farming is the failure mode, and what raises its cost is the
   completed-paid-work half of that gate — a real funded task, F3 $3 minimum — not the badge,
   which is an unlimited public mint and gates nothing).
7. **Fees→commons loop with an open dashboard** — a published % of collected fees funds
   the community bounty pool (Raid Guild's 10% spoils precedent), shown on an open-startup
   style dashboard (GMV, fees, destinations). For a pseudonymous founder, the dashboard
   substitutes identity with verifiable behavior (Buffer's transparency drove +229% job
   applications). Expect legitimacy, not measurable adoption lift — the evidence is honest
   about that.
8. **Time-boxed fee holidays, never permanent-zero beyond the schedule** — Sharetribe's
   small-marketplace guidance; Blur proved fee-bought liquidity is mercenary.

## 5. Other revenue lanes (sequenced, all optional)

- **Trustee-KYC for >$50k engagements** — cost-plus service (already in docs).
- **Agent/Composer API tier** — x402-style infrastructure pricing (free tier, then
  ~$0.001/tx-shaped) once agent volume exists; agent rails charge 0–3% at the
  escrow/evaluation layer (Virtuals ACP evaluator 2–3%) — our royalty already sits there.
- **Pool carry** — small % on Phase-A multi-funder pools, only if pools ship.
- **Radix ecosystem funding** — the Booster pipeline is effectively dead post-RDX-Works;
  the realistic path is a Foundation **RFP** framed as ecosystem infrastructure (Phase 1
  community-signaled allocations, per the Jan 2026 strategy). Pursue; budget $0 base case.

## 6. What we will NOT do (evidence-backed refusals)

- **No token, no points-that-imply-a-token.** OpenSea's XP→SEA delay (Mar 2026) shows
  points-as-implied-token create liabilities, farming, and PR damage; Braintrust's BTRST
  −99.8% while the fee asymmetry survived; Developer DAO's token-gating decayed while
  Superteam's earn-first/no-token model thrived.
- **No cash referrals, no signup rewards** (sybil bait).
- **No web2-scale take rates** (Upwork blended ~18.5%, Fiverr 20%+5.5% — their rake is our
  recruiting pitch; Gurley: under-extract to become the definitive venue).
- **No fees depending on goodwill** (the NFT-royalty lesson — ours sit in the settlement
  path or don't exist).
- **No lifetime-deal blowouts** (AppSumo: 16–17% refunds, deal-hunters not power users) —
  the founding cohort is small, named, and capped instead.

## 7. Leakage (the marketplace killer), addressed structurally

Off-platform circumvention kills work marketplaces; web2 fights it with policies and
penalties. Our defense is product, not policing: **the fee buys escrow + dispute coverage +
reputation accrual that only exist on-platform**, priced far under the risk it removes
(1–2.5% vs Escrow.com's 0.89–3.25% for escrow alone — and we bundle disputes + reputation).
A poster who takes a repeat relationship off-platform loses settlement guarantees and the
worker loses badge history — at 1–2.5% the rational move is to stay. Gap noted honestly:
quantified circumvention-rate studies weren't pulled in this sweep; revisit if leakage
appears in practice.

## 8. How this answers "incentivize users AND pay for itself"

- **Workers** are incentivized by 0% forever + exportable career capital + founding status.
- **Posters** are incentivized by sub-1% beta fees that buy escrow/disputes/reputation
  signal, founding-cohort lifetime rates, and an on-ledger fee cap they can verify.
- **The platform** pays for itself by keeping hard costs near $100/mo (covered at just
  $4k/mo GMV), pricing support as pass-through insurance, and holding the enforceable
  royalty dial for the day volume arrives — with the cap pre-published so growing into
  revenue never requires renegotiating trust.

## 9. Decision rows — DECIDED 2026-06-13

All six settled in the decision-packet sitting (`DECISION-PACKET.md`, kept in the private operations repository).

| # | Parameter | Decision | Status |
|---|---|---|---|
| F1 | Royalty cap (on-ledger, vNext2 instantiation) | **2.5%** | ✅ DECIDED |
| F2 | Beta dial | **0% closed → 1% public**, grandfather in-flight | ✅ DECIDED |
| F3 | Minimum **funded**-task reward | **$3 USD-pegged**; free/unfunded tasks exempt | ✅ DECIDED |
| F4 | Founding-poster cohort | **first 20 funded projects, lifetime 1%** | ✅ DECIDED |
| F5 | Fees→commons % | **20%** → community pool (funds high-value tasks / airdrops) + open dashboard | ✅ DECIDED |
| F6 | Referral credit | 50% credit, both sides, badge-gated | ⏸️ DEFERRED — only if proven to lift engagement/trust; not in MVP |

*(2026-10-02: F1, F2 and F4 were decided as percentages and were not built that way. The
component's royalty is a flat XRD amount per `create_task` call, set to 0, with no percentage
bound of the Guild's own on the ledger. F3 and F5 were not re-checked in this pass.)*

**F3 refinement:** bigdev reframed the "flat minimum fee" as a **minimum funded-task reward
of $3 USD** — dust is killed at the source (no sub-$3 escrow), so no separate minimum fee is
needed. **Free, unfunded "decision-curve" tasks** (governance "do we want this?" signal, zero
escrow — DESIGN-REVIEW §14b) carry no minimum and are an explicit product need. Posting even
a free task still costs XRD gas, which opens the **fee-sponsorship** design — see §10.

**A3 (arbiter fee) refinement** lands in the parameter sheet:
no baked `max_arbiter_fee_pct`; the poster's prepaid insurance bounds the arbiter fee per
task (terms-as-data, worker unharmed). One fewer protocol constant to defend.

Key sources: ENS DAO revenue reports · Juicebox docs/DefiLlama · Uniswap UNIfication +
Labs fee coverage (The Block/Decrypt) · OpenSea/Blur royalty-war coverage (CoinDesk/
Nansen) · Zellic on Code4rena fees · Immunefi fee docs · Sablier fee docs · Virtuals ACP
whitepaper · x402 CDP docs · Gurley "A Rake Too Far" · Sharetribe pricing academy ·
Superteam handbook · Raid Guild handbook · Electronic Markets (2024) on rating portability
· Radix "2026 Strategy" post.

## 10. Fee sponsorship / gasless onboarding (opened 2026-06-13)

**The problem.** Every on-chain action costs XRD gas. A new-to-Radix developer or agent with
zero XRD can't mint the free badge, post a free decision-curve task, or vote — the
chicken-and-egg that kills "no wallet, no problem" before it starts. Free tasks (F3) make it
worse, not better: the lowest-commitment entry point is still gated behind owning XRD.

**The proposal (bigdev 2026-06-13).** Sponsor the **first ~$100 USD of transaction fees per
badge-holder** — thousands of small txs — so onboarding costs the user nothing. This is the
gasless layer under the Q7 onboarding goal and the read-only-first → owns-a-wallet funnel.

**Business-model framing — this is CAC, not opex-for-nothing.** $100 of sponsored fees is a
customer-acquisition cost, justified only if it converts a builder/agent who then posts or
settles *funded* work (the GMV that the 2.5% royalty eventually rides on). Weigh every dollar
against the ~$320k/mo GMV bar: cheap per converted builder, ruinous if farmed. So:

- **Sybil controls are load-bearing — and ⛔ THE BADGE IS NOT ONE OF THEM (corrected 2026-08-01).**
  This bullet previously read "badge-gated (the free non-transferable badge is the identity)". Both
  claims are false: the Member badge is a **public mint anyone can call for the network fee**
  (`public_mint` takes only a username and presents no proof), and it is **TRANSFERABLE**
  (`withdrawer = AllowAll`, chain-verified; every `*_updater = DenyAll`, so it can never be made
  soulbound). It records membership, not identity, and gates nothing.
  **The arithmetic that follows is the point:** a hard per-account cap is a cap per *free* account,
  so the real exposure is `cap × unlimited accounts`, not `cap × humans`. Surviving controls are the
  per-account cap, rate limits, farm detection, and the §10 daily global ceiling with auto-pause —
  with **no identity primitive underneath any of them**, which is the actual gap to close before
  sponsorship ships. ⚠️ **OPEN DECISION (2026-07-31): what supplies personhood instead of the badge
  is undecided.** The badge mint is itself the *first* sponsored tx, so the cap must cover it (true
  zero-XRD start).
- **Agents may warrant a higher cap** (they transact more) — but under the same controls, and note
  none of them is a sybil *gate* in the sense this doc previously assumed.
- **Cap + monthly budget are a TBD** to set before public beta, sized off real tx costs.

**Radix mechanics — researched 2026-06-13, natively shippable.** Full note +
sources in `design/gasless-onboarding.md` (kept in the private operations repository). Summary:

- **Mechanism = subintents / pre-authorizations** (Transaction V2, "Cuttlefish", Dec 2024).
  The user signs a *subintent* (mint badge / post free task / vote) which **cannot lock the
  network fee**; the Guild backend wraps it in a parent transaction that `lock_fee`s from a
  **Guild fee-payer account** and `YIELD_TO_CHILD`s into the user's subintent. **A 0-XRD
  user — even on their very first transaction — is the designed case, not an edge case.**
  This is Radix's documented "delegated fee payment"; its own fee blog cites "issuing badges
  to cover user fees" as an intended use. Tooling is live: RDT `sendPreAuthorizationRequest`,
  Radix Wallet v1.11 (iOS + Android).
- **Our exact blocker, confirmed in-repo:** `guild-app/src/lib/manifests.ts` →
  `publicMintManifest` emits no `lock_fee`, so the Wallet auto-locks from the *user's*
  account — which is why a zero-XRD user is stuck today. The fix routes that same manifest
  body through a subintent. (The escrow tests' `lock_fee_from_faucet` is simulator-only;
  there is **no mainnet fee faucet** — sponsorship needs a funded Guild account.)
- **Cost is rounding error:** XRD ≈ $0.0015; ~5 sponsored actions/user ≈ **~$0.003/user**
  → **~$3/mo for 1,000 onboarded users.** The "$100 of fees" cap is a **circuit breaker,
  not a budget** — a legit user never approaches it. The real risk is keeping the fee-payer
  account funded and its key safe (treat like the keeper key: scoped, capped, monitored).
- **Sybil controls (load-bearing):** ⛔ **not** "the soulbound badge (identity)" — corrected
  2026-08-01. The badge is a transferable public mint (chain-read 2026-07-31), so it gates nobody
  and anchors no identity; true exposure is `cap × unlimited free accounts`, not `cap × humans`.
  ⚠️ **OPEN DECISION: what supplies personhood.** What remains real:
  a per-account on-chain allowance component (defense-in-depth over a DB cap); off-chain
  rate-limit + captcha/personhood; a daily global ceiling with auto-pause + keeper alert.
  **Gating sponsorship on badge-holding is gating on ~1 XRD**, which is the sybil cost, not a gate.
  Only **non-value-moving** actions are sponsored (badge mint, *unfunded* posts, votes) —
  farmed accounts yield nothing extractable. Funded escrow stays unsponsored (poster holds
  XRD already).
- **Honest gaps:** exact per-tx XRD cost is methodology-not-a-number in Radix docs — measure
  a real mint before quoting; no *named* third-party mainnet subintent-paymaster found (we'd
  be an early adopter — warrants a mainnet spike + a Radix-dev question); wallets < v1.11
  need a pre-fund fallback (the RadQuest "Golden Ticket" pattern).

**Sequencing (business-model lens):** this is the gasless layer under Q7 onboarding and the
read-only-first funnel — **MVP-adjacent, not MVP-blocking.** It earns its place the moment
we want new-to-Radix builders/agents to *act* (not just browse), which is the §8b
agent-claims milestone. Slot it right after agent claims go live; it's cheap, on-mission,
and the sybil work is the only real cost.

## 11. Agent unit economics — reward : AI-cost benchmark (PROPOSED 2026-07-24)

**Status: PROPOSED, not decided** — a pricing guideline for the agent-worker lane, banked for
a decision sitting. Not an instruction. Its job is to cut settlement disputes by making "is
this task worth an agent's compute?" answerable *before* the claim.

**The question.** A worker keeps 100% of the reward (§2.1), so its profit is
`reward − AI_cost_to_complete`. If an agent burns more compute than the reward returns it
disputes, abandons (forfeiting the claim bond), or ships junk — all settlement-poisoning. A
published reward-to-cost floor pre-empts that: the poster knows the floor, and the agent knows
*before* claiming that it clears.

**Proposed benchmark: reward ≥ 5× reference AI cost (profit : AI-cost ≈ 4 : 1). Hard floor
3× / 2 : 1 — below it, don't post to the agent lane.**

**Reference AI cost by task class** — grounded in the `dowork-claude` harness ledger (that harness is retired; the sandbox executor now records the same ledger)
(`.claude/dowork-ledger.jsonl`, kept in the private operations repository), priced at Anthropic **API** rates (Opus 4.8 $5/$25, Sonnet 5
$3/$15, Haiku 4.5 $1/$5 per MTok; cache-read 0.1× input, cache-write 1.25×):

| Task class | Ref model (harness auto-tiers) | Ref AI cost | 5× floor | vs. F3 $3 min |
|---|---|---|---|---|
| Docs / config | Haiku / Sonnet | ~$0.04 | — | **$3 binds** (~75×) |
| Small code / tests | Sonnet | ~$0.20 | — | **$3 binds** (~15×) |
| App / blueprint code | Opus 4.8 | ~$1.00–1.50 | ~$6–8 | $3 only ~2× — **too thin** |

Two real runs (2026-07-24): a Haiku docs run (out 1,915 tok, cache-read 195k) ≈ **$0.03**; a
28-turn Opus code run (out 9,642 tok, cache-read 1.36M) ≈ **$1** captured — cache-*writes*
aren't logged, so true cost skews a little higher. Cost is dominated by cache-reads
accumulating across turns, i.e. it scales with task complexity, not output length.

**The one binding number this adds.** Only **app/blueprint-code tasks need their own floor
(~$6–8, ≈ 8–10k XRD @ $0.00082)** — the F3 $3 minimum already returns 15–75× on everything
cheaper. $3 against an Opus task is only ~2×, with no room for cost variance or a failed retry.

**Two AI costs — benchmark the external one.**
- *Internal, now:* **~$0.** The harness runs `claude -p` on the shared Max subscription; the
  binding constraint is rate limits + the 12-runs/day cap (`DOWORK_MAX_RUNS_PER_DAY`), not
  dollars.
- *External agent-operator:* the API rates above — what a third party deploying an agent to
  Guild actually pays. A2A operators are the target market (the priority track), so the
  *published* benchmark uses this cost, not ours.

**Model-cost sensitivity — the ratio improves as inference cheapens.** The denominator is
model-dependent and trending down. Routing the worker lane to a cheaper model (e.g. Kimi
K2/K3-class open weights, roughly an order of magnitude below Opus API rates) drops the
app-code reference toward the Sonnet/Haiku band — the F3 $3 minimum would then clear 5× on its
own and the dedicated app-code floor could fall away. **So the floor is a function of the model
tier, not a constant — re-derive it whenever the default worker model changes.** Cheaper
inference = higher worker margin = more agent supply at the same reward = the flywheel the
0%-worker-fee deal (§2.1) is built to spin.

**Caveats (rough, first pass).** The two runs quoted above are illustrative, one per tier — but the ledger now holds **11 records from the 2026-07-24 wave** (6 Opus, 4 Sonnet, 1 Haiku), un-analysed. Re-derive the floor from all 11 before this leaves PROPOSED; the numbers below are orders of magnitude only. Calibrate the
Opus reference on ≥ 10 real app-code tasks before publishing a hard floor. Ledger under-captures
cache-writes (true cost a touch higher). Excludes retries (the harness retries on failure,
burning more) and the ~$0.01 gas + claim bond (negligible). **Open for the sitting:** the target
multiple (proposed 5× / 4:1) and whether copy standardizes on reward:cost or profit:cost framing.
