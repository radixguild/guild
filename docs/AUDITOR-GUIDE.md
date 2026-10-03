<!-- status: live
     verified: 2026-10-02 (§5, §6's source-location line, §2 claim 2's *Check* and §4's agent row
     ONLY: re-checked against the live /trust and /auditor-guide pages, /bug-bounty, the licence
     fields in this repository, lib.rs, and the live Wave B component's transactions and the
     agent badge's supply on the Radix Gateway. Nothing else re-checked this pass.)
     verified: 2026-09-16 (scoped pass against lib.rs + the live Wave B component: §1's transition
     table synced with the in-app twin and its value-leaves line corrected; §2 claim 2 and §3's
     deployed line + auto-release correction re-derived — release_after_review_timeout is live.
     §4 onward NOT re-walked.)
     verified: 2026-09-17 (§2 claim 1 ONLY, re-derived from lib.rs: all 15 OWNER methods, which
     parameters are pinned per task vs read live by expire_claim, and the event each emits.
     Nothing else re-checked this pass.)
     Previous stamp: 2026-08-23 (§1 settlement-routing line and §6 re-checked against
     escrow/…/lib.rs post-PULL-cutover 2026-08-17 — see the ⚠️ notes; rest of the
     doc not re-walked this pass)
     2026-08-29: narrow re-check of the dispute-state claim ONLY — corrected from "dispute UI compiled OFF / disputes MOCK-ONLY" to LIVE (PR #465, gate inverted). Nothing else in this doc was re-verified.
     supersedes: none (pre-dates the header rule) -->
# Guild Auditor's Guide — for nerds, auditors, and the professionally suspicious

> 2026-06-12 · The deep version of `HOW-IT-WORKS.md`. Everything here is checkable;
> where it isn't yet, it says so. Addresses + deployed config: `ESCROW-ADDRESSES.md`.
> Parameters + planned changes: `ESCROW-PARAMETER-SHEET.md`. Design rationale:
> `DESIGN-REVIEW-2027.md` (Parts I–II) and `design/intent-settlement-design.md`.
> **In-app twin:** radixguild.com/auditor-guide
> (`guild-app/src/app/auditor-guide/page.tsx`) — keep the two in sync.

## 1. What is on-chain, exactly

One Scrypto component (`guild-marketplace-escrow`, Radix mainnet) enforces a six-state
task lifecycle. The app (Next.js + Postgres) is a mirror and a convenience — **the ledger
is the source of truth**, and a reconciler heals the database from chain events, never the
reverse.

```
Open ──claim──▶ Claimed ──submit──▶ Submitted ──approve──▶ Released   (terminal)
  │                │                    │
  cancel        expire/cancel        dispute ──resolve/auto──▶ Released | Refunded (terminal)
  ▼                ▼
Refunded (terminal)
```

| Transition | Caller | Auth | Time gate |
|---|---|---|---|
| `create_task` | poster | — (funds reward + insurance atomically) | — |
| `claim_task` | worker | worker badge Proof + claim bond; asserts `worker != task.poster` — an honest-mistake guard, not a self-dealing defence: `poster` is a caller-supplied parameter of `create_task` that nothing binds to the caller, so a decoy poster address bypasses it for the cost of gas (M5) | sets submit deadline (7d human / 1d agent) |
| `cancel_task` | poster | task-receipt Proof (not burned) | Open only; credits reward + insurance to the poster's entitlement |
| `cancel_task_by_poster_after_claim` | poster | task-receipt Proof (not burned) | Claimed only; also credits the claim bond back to the worker's entitlement |
| `expire_claim` | **anyone** | PUBLIC | after submit deadline + grace (1h deployed); reopens the task, returns a bounty (`expire_bounty_pct` of the forfeited bond) to the caller, the rest to the owner's forfeited-bond vault |
| `submit_task` | worker | claim-receipt **burn** (one-shot) + evidence hash committed | pins `review_deadline` = submission + `review_window_secs` |
| `approve_and_release` | poster | task-receipt Proof (not burned — a persistent entitlement key under PULL) | credits reward + bond to the worker, insurance to the poster |
| `release_after_review_timeout` | **anyone** | PUBLIC | Submitted only, after `review_deadline` (72h deployed); credits exactly what `approve_and_release` credits; races `raise_dispute` first-to-commit |
| `raise_dispute` | poster or worker | receipt/badge Proof + evidence hash | — |
| `resolve_dispute` | arbiter | arbiter badge | ruling: PayWorker / RefundPoster / Split |
| `auto_resolve_dispute` | **anyone** | PUBLIC | after dispute window (72h deployed) |
| `withdraw_worker` / `withdraw_poster` | the pinned party | badge / task-receipt Proof | deposit both lanes into the account pinned at claim / create |
| `push_entitlement` | **anyone** | PUBLIC, no Proof, no destination argument | deposits a party's entitlement into that party's pinned account |
| `withdraw_forfeited_bonds` | owner | OWNER badge | returns the forfeited-bond vault for one resource; never touches a task's reward or insurance |
| `burn_task_receipt` | poster | task-receipt Bucket (burned) | both poster lanes zero AND task terminal |

Auth pattern worth auditing: every irreversible act consumes a one-shot receipt
(bucket-burn — no replay, except the task receipt, which under PULL is a persistent
entitlement key retired separately via `burn_task_receipt`); recurring acts use Proofs;
safety releases are PUBLIC and time-gated. ⚠️ *(corrected 2026-08-23, PULL cutover)*
Settlement no longer routes through the caller: `approve_and_release` /
`resolve_dispute` / `auto_resolve_dispute` CREDIT per-party entitlements inside the
component (no bucket returned), and entitlements leave only via `withdraw_worker` /
`withdraw_poster` or the public `push_entitlement`, which deposit directly into the account
pinned at `create_task`/`claim_task` and take no destination argument at all. There is no
"caller receives the funds and routes them" step left to audit. ⚠️ *(corrected 2026-09-16)*
This said "value leaves only via `withdraw_worker` / `withdraw_poster`". Three methods do
return a Bucket to their caller, none reaching a task's reward: `resolve_dispute` (the
arbiter fee, from insurance, capped by `max_arbiter_fee_pct`), `expire_claim` (the bounty)
and the owner-only `withdraw_forfeited_bonds`.

## 2. The trust claims, and how to check each one

1. **"The platform cannot move escrowed funds."** There is no platform key with authority
   over task vaults: the owner badge cannot touch reward or insurance. Everything it can
   do, all fifteen `restrict_to: [OWNER]` methods:
   - **Tokens:** `add_accepted_token`, `remove_accepted_token`, `freeze_token`,
     `unfreeze_token` — the whitelist is read only by `create_task`, so these change what
     NEW tasks may be funded in, never an existing task.
   - **Forfeited bonds:** `withdraw_forfeited_bonds`.
   - **Eight parameters pinned per task** at the step that uses them, so a change reaches
     only tasks that get there afterwards: `set_min_insurance_fraction`,
     `set_max_arbiter_fee_pct` (funding); `set_claim_bond_params`,
     `set_human_submit_deadline_secs`, `set_agent_submit_deadline_secs` (claim);
     `set_review_window_secs` (submission); `set_dispute_auto_resolve_secs`,
     `set_dispute_auto_resolve_default` (dispute raised).
   - **Two parameters read live by `expire_claim`, so a change DOES reach claims already in
     flight:** `set_expire_grace_secs` (no upper bound — the grace after a missed deadline
     could be cut to zero) and `set_expire_bounty_pct` (0–1 of the forfeited bond to the
     caller; the rest to the owner's vault).
   - Every one of these calls emits a public on-chain event.

   ⚠️ *(corrected 2026-09-17)* This claim listed only the whitelist, freeze and
   forfeited-bond powers, omitting the ten parameter setters Wave B added — including the two
   that reach in-flight claims. *Check:* read `enable_method_auth!` (source publication —
   see `TRUST-BACKING-PLAN.md` step 1) and the method table above; watch the component's
   `*Updated` / `Token*` / `ForfeitedBondsWithdrawn` events on the Gateway; read
   `expire_claim` for the live grace and bounty reads.
2. **"Nobody can be stranded."** Claimed tasks expire publicly; disputes auto-resolve
   publicly after the window; and submitted work can be released by anyone once the review
   window lapses, if the poster never acts (`release_after_review_timeout`, 72h deployed,
   crediting exactly what an approval credits). ⚠️ *(corrected 2026-09-16)* From 2026-08-15
   this claim said review-window auto-release was superseded at source and not being built,
   so a silent poster's only remedy was `raise_dispute`. True of the PULL blueprint; Wave B
   (live 2026-09-13) built it, answering the 2026-08-04 faucet objection with what now
   precedes it — a non-zero evidence commitment bound to the brief, live disputes, and the
   claim bond held to settlement. A worker who raises a dispute moves the task out of
   Submitted and gives that release up.
   The winner finalizes from their own wallet — our keeper is **watch-only by
   decision**: it alerts humans and sends no transactions on the money path. *Check:* on the
   ledger — every `approve_and_release` and every withdrawal in the live component's history
   is signed by the poster's or the worker's own account, and its one dispute ruling by the
   arbiter; no keeper account signs on the money path (read from the Radix Gateway
   2026-10-02). Then observe that `auto_resolve_dispute`, `expire_claim` and
   `release_after_review_timeout` carry no badge requirement.
3. **"The terms you saw are the terms that settle."** Title, description, and structured
   terms (acceptance criteria, deadlines, revisions) are canonicalized and SHA-256
   committed into the task at funding (`work_brief_hash`); submission evidence is
   likewise hashed. Disputes are judged against the committed brief — chat doesn't count
   unless it amended the brief. *Check:* recompute the canonical form
   (`guild-app/src/lib/escrow-utils.ts`, frozen v1/v2 formats) against the on-chain hash
   via the Gateway.
4. **"The mirror can't lie for long."** App state is advanced only by verified on-chain
   events (single confirm path), and a keyless reconciler replays chain events on a cron.
   *Check:* `guild-app/src/lib/escrow-confirm.ts` — one writer, event-verified, idempotent
   ledger (`UNIQUE(taskId, txType)`).

## 3. Economics (deployed → planned)

Deployed today (ESCROW-ADDRESSES.md is ground truth; Wave B component, re-read 2026-09-16):
insurance minimum 0 (the app funds 5%); claim bond 10% of the reward, floor 76.45, cap
152,894, in the reward token; review window 72h; dispute window 72h, default
**`SplitEvenly`**; arbiter fee 0 (cap 10%). ⚠️ *(corrected 2026-09-16)* This line read
"insurance min 5% of reward; claim bond 10 XRD" — the PULL component's values.
⚠️ This line read `FavorDisputeRaiser` until 2026-08-09 — that is the **v1/dead**
`…cz9mh49` value. The LIVE component reads `SplitEvenly`, chain-verified and recorded
in `ESCROW-ADDRESSES.md`, which notes it explicitly as "**not**
`FavorDisputeRaiser`". Read it yourself off the component's state rather than trusting
either doc; it is also what DB-1 re-signed for the PULL cutover.

Planned at vNext2 (decided 2026-06-12, see parameter sheet): **insurance becomes optional
dispute coverage** (~10–15% suggested, refunded if unused; no coverage ⇒ no dispute path —
pure optimistic mode); review window with **auto-release on poster silence** (default 3d);
SplitEvenly on dispute abandonment + reputation marks; mutually-signed splits
(`settle_by_agreement`). One migration, everything bundled.

⚠️ **Two corrections to the paragraph above, from the Phase-0 sitting (2026-08-06).** It said
"heartbeat removed in favor of deadline + **mutual extension**" — the second half was never
true and is now measurably not: heartbeat is removed **outright** (DB-3), leaving one claim
deadline fixed at claim time with no paid extensions and no extension method of any kind.
`settle_by_agreement` is Wave-B, not in this cutover. And the **auto-release** line is
**superseded at source** — `submit_task` validates nothing, so a timed release is a faucet
(2026-08-04 review); it is explicitly not being built. What IS signed for the PULL cutover is
`ESCROW-PARAMETER-SHEET.md` §"PULL cutover".
⚠️ *(2026-09-16)* The auto-release half of that correction is itself superseded: Wave B
(live 2026-09-13) shipped `release_after_review_timeout` with `review_window_secs` = 259200
— see §2 claim 2 for what changed the faucet reasoning. `settle_by_agreement` is still not
deployed.

## 4. Honest gaps (the register)

| Element | Status | Best we have |
|---|---|---|
| Per-criterion enforced payouts | No shipped precedent, anywhere | Checklist-as-evidence routes to: full release / revision / mutual split / insured arbitration |
| Co-funder voting on acceptance | Every attempt died or went unused | Curator-pattern pools (named acceptor, self-claim refunds, escrow-level timers protect the worker) |
| Subjective quality judgment | Unsolvable in general | Committed brief + insured human arbiter + (planned) AI advisory opinion |
| Agent work verification | Standards in flux industry-wide | On-demand PR checks against the committed brief, plus the claim bond and escrow deadlines; the claim receipt is burned at submit, and the claiming badge is re-checked at withdraw. But the badge is a public mint that identifies no one, and of the recall-revocable agent badge this model assumes, three have been minted and two burned: the one that exists is held by the Guild's own worker agent, and none has ever been presented on a claim — so no human currently answers for an agent. *(Re-checked 2026-10-02 against `lib.rs` and the ledger; this row said the agent badge had never been issued.)* |

If you have a better mechanism for any of these: **post it as a task.** That is not a
slogan; it is the product working on itself.

## 5. Identity and backing (pseudonymous, with receipts)

The operator is pseudonymous (bigdev / @bigdevxrd) with a verifiable on-chain track record.
In lieu of doxxing, these are the backing steps; their status is kept current on the site's
[Trust & Verification](https://radixguild.com/trust) page, and the plan is
`TRUST-BACKING-PLAN.md`:
- the escrow blueprint's source is in this repository under Apache-2.0; reproducible-build
  verification of it against the deployed package is planned;
- a bug bounty paid through the Guild's own escrow (on-chain, visible) is planned; until then
  the site's beta [bug-bounty page](https://radixguild.com/bug-bounty) pays no cash;
- a timelocked commitment bond is in the plan, not started.

For tasks/projects **over $50k USD**, trustee-verified identity is planned, not available
yet: a named third party would attest the operator's identity and standing without public
disclosure. No trustee is retained.

## 6. Known limits — read before relying

- Blueprint upgrades are migrations (new component + env swap), not in-place — config is
  immutable per instantiation by design. Review the parameter sheet per component address.
- Wallet-side MFA/multisig UX is not yet on Radix mainnet; arbiter-council M-of-N is
  enforced at the method-auth layer when activated.
- The app, the escrow blueprint and the agent kit are all in this repository under
  Apache-2.0. *(Rewritten 2026-10-02 to say where the code is, the same on both sides of the
  open-source flip decided 2026-08-14.)*
- **Settlement is pull, on the production component, since the 2026-08-17 cutover.** ⚠️
  This line previously said "push … the cutover has not happened" — that was true when
  written (2026-08-15) and has been false since. §1's routing description is corrected
  to match. *(re-checked 2026-08-23)*
- **The dispute UI is LIVE in production** — ⚠️ *inverted 2026-08-29, and the inversion is
  the point:* this line read "compiled OFF" for months and was gated that way. PR #465
  shipped disputes ON (`e36e3df`), and **`scripts/launch-check.sh` CHECK 1/2 were INVERTED
  with it — a disputes-OFF build now FAILS the deploy.** The app exposes dispute-raising and
  the arbiter path. What an auditor should check instead: the settled terms are SplitEvenly
  50/50 of the reward only, insurance returns whole to the poster, arbiter fee 0, 72h
  auto-resolve, and the poster-stonewall asymmetry (worker loses, poster ends better off than
  approving) is stated in the product copy rather than hidden. ⚠️ *(2026-08-23 note kept for
  provenance)* This line previously said
  that meant "BUG-7 remains open" — under the now-superseded PUSH blueprint that was the
  live risk this flag was gating; under PULL, BUG-7's mechanism (a caller receiving and
  routing a settlement bucket) is closed structurally, not by this flag — see §1 and
  `guild-app/src/lib/features.ts`. What the flag actually gates now: `raise_dispute` and
  `auto_resolve_dispute` are **PUBLIC on-chain regardless of this build**, reachable by a
  hand-built manifest with the flag off; the real product gap is that a worker can submit
  garbage, raise a dispute, and bank a guaranteed 50% of the reward after the 72h
  `SplitEvenly` auto-resolve window for zero work, with no operable arbiter escape (the
  arbiter manifest builder exists and is byte-correct but has no UI, no route, and no
  runbook). That is a policy gap, not a fund-drain, and it is not mitigated by this flag
  being off — it is merely not offered through our own UI.
- This is experimental software on mainnet. The honest-gaps register above is live, not
  historical.
