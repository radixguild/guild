<!-- status: live
     verified: 2026-08-23 (P3-3a: the arbiter path made operable. §0 below is new and
     chain-verified against the LIVE component this session — Gateway reads for
     arbiter_badge_resource, its holder via /state/non-fungible/location, and every
     instantiate param cited. §1-§3 are UNCHANGED 2026-05-19 design exploration for a
     system that was never built, now clearly marked as such rather than silently
     coexisting with the live section as if both described reality. §4 is rewritten —
     it previously cited the deprecated guild-escrow tree with line numbers that no
     longer exist anywhere.)
     verified: 2026-09-01 — NARROW re-verification, deliberately not a full re-read: only
     the `resolve_dispute` return-shape sentence in §4 was checked against lib.rs and
     corrected (Bucket -> Proof, two buckets -> one, per fa8c15e). Everything else in this
     file still carries its 2026-08-23 date and was NOT re-checked today; the chain reads in
     §0 in particular are older than the mainnet stall.
     verified: 2026-09-17 — SCOPED re-cut of §0 for the WAVE B cutover (2026-09-13), plus the
     STATUS banner and §4's status rows; §1-§3 untouched. Re-checked, in this order: (a) badge
     resource / local id / holder re-derived keylessly via `bun scripts/arbiter-harness.mjs badge`
     at 02:36Z — it reads `arbiter_badge_resource` off the live component `…hp88yly` and asks
     `/state/non-fungible/location` who holds the one non-burned unit; (b) the component's
     config fields and ALL 36 tasks' `state` + `dispute_raised_by` at 02:38Z (state_version
     558507828); (c) task 5's raise + resolve receipts via `/transaction/committed-details`;
     (d) `raise_dispute`, `resolve_dispute`, `auto_resolve_dispute`, `credit_split_for_parties`
     re-read in lib.rs at `e0646d8`; (e) `resolveDisputeManifest` and the harness's `--live`
     refusals re-read in source — they still match what § The tool describes. NOT re-checked:
     §1-§3, and `docs/design/dispute-path-h2h-a2a-h2a.md`'s own lib.rs line-number cites.
     CORRECTED THE SAME DAY (second commit): (f) that pass had NOT read
     `scripts/escrow-drift-watch.mjs` and wrote "no page when a dispute opens" from the
     keeper's header alone. PASS 3 of the drift watcher was then read in source (stage machine
     in `src/lib/escrow-drift.ts`) and confirmed running via `/var/log/guild-drift.log` on the
     box; "What this path does NOT give you" and §4's alert row now say what it does.
     supersedes: none (edited in place; nothing else in docs/ covers this) -->

> ⚠️ **STATUS + SCOPE — corrected 2026-08-23, re-cut 2026-09-17 for Wave B; read this before
> anything else in the file.**
> This doc previously said disputes are BUG-7-blocked and MOCK-ONLY. That was true of the
> retired PUSH blueprint and is **no longer true**: the PULL redesign (cutover 2026-08-17)
> fixed BUG-7 and H1 at the root — `approve_and_release` and `auto_resolve_dispute` return
> `void` and credit entitlements INSIDE the component; nothing is ever handed to a caller to
> misroute — and the **Wave B** component (cutover 2026-09-13,
> `component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly`) carries that
> forward with a Proof-form `resolve_dispute`, an identity-bearing non-transferable arbiter
> badge and the L6(c) self-dealing guard. The PULL component `…cz468e` this banner used to
> name is retired in place. The dispute UI has been compiled **ON** since 2026-08-29
> (`NEXT_PUBLIC_FEATURE_DISPUTES=true`; the deploy gate `scripts/launch-check.sh` now FAILS a
> build with it off — CLAUDE.md has the measurements) — and `raise_dispute` /
> `resolve_dispute` are PUBLIC methods on a LIVE mainnet component either way, reachable by
> anyone who builds the manifest themselves. **§0 is the operator runbook for the one path
> this doc previously described as unbuilt: a human arbiter ruling a real dispute — exercised
> once on the live component (task 5, 2026-09-14; § Verification status).** §1-§3 are kept as
> historical design record (see the banner before §1) — do not read anything past that banner
> as describing what actually shipped.

# Guild Dispute Resolution System

---

## 0. Operator Runbook — Resolving a Live Dispute

**What this is.** The escrow blueprint gives a disputed task exactly two ways out: a human
**arbiter** rules it (this section), or — if nobody does — a **public, permissionless,
time-gated default** fires after 72 hours and rules it instead. This section is the
arbiter path: how to exercise it, with what tool, under what semantics, and what it does
NOT promise. Ground truth throughout is
`escrow/scrypto/guild-marketplace-escrow/src/lib.rs` on the LIVE **Wave B** component
`component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly` (cutover 2026-09-13;
`ESCROW_COMPONENT` in `guild-app/src/lib/config.ts`, which is what the harness reads — never
retyped; registry row in `docs/ESCROW-ADDRESSES.md`). The PULL component `…cz468e` this
section was first written against is retired in place (frozen, empty). Re-derive every
address below with the commands given rather than trusting this page, per this repo's
standing address-discipline rule.

### Why this path exists

`raise_dispute(task_id, party_proof, evidence_hash)` flips a `Submitted` task to `Disputed`.
Either party may raise it — the poster by proving the task receipt, the worker by proving
the claimer badge — and the first raise locks the other out. It **pins** the auto-resolve
window and default onto the task at that moment (a later `set_*` cannot move a dispute in
flight), and it hands nothing back: the worker's claim bond — proportional since Wave B,
`claim_bond_pct` 0.1 of the reward, floor 76.45 XRD, cap 152,894 XRD (chain-read
2026-09-13) — stays in its vault and follows the REWARD ruling at settlement. Nothing stops
a worker from claiming a task, submitting garbage, and immediately disputing — and with the
deployed `dispute_auto_resolve_default = SplitEvenly`, the 72h public auto-resolve then
hands them 50% of the reward for zero real work (forfeiting half their bond to the poster),
with the poster holding no counter-move except this path. A human arbiter is the ONLY way to
overrule that default before it locks in.

### The tool: `guild-app/scripts/arbiter-harness.mjs`

```bash
# Read-only. No key needed. Confirms who can currently sign as arbiter.
cd guild-app && bun scripts/arbiter-harness.mjs badge

# Keyless preview (the DEFAULT — nothing is signed or submitted):
bun scripts/arbiter-harness.mjs resolve --task <onChainTaskId> \
  --ruling pay-worker|refund-poster|split \
  [--worker-pct 0.6 --poster-pct 0.4]

# Actually resolve it (adds --live; refuses unless the preview above was PROVEN):
bun scripts/arbiter-harness.mjs resolve --task <onChainTaskId> \
  --ruling pay-worker|refund-poster|split \
  [--worker-pct 0.6 --poster-pct 0.4] --live
```

Both the badge resource and the account that presents it are **read from the chain on every
run** — never hardcoded in the script, never typed into this doc as the thing to trust.
`resolve` additionally refuses outright unless the target task reads `Disputed` on the
Gateway **right now**, and (in `--live` mode) unless the keyless preview it just ran came
back `PROVEN` — it will not submit a transaction it has not just watched succeed in
simulation against the current ledger state.

### The badge — full address, and where it lives today

Re-derived keylessly on **2026-09-17 02:36Z** with
`cd guild-app && bun scripts/arbiter-harness.mjs badge` — the harness reads
`arbiter_badge_resource` off the live component's own state, then asks
`/state/non-fungible/{ids,location}` who holds the one non-burned unit. It printed:

    arbiter_badge_resource = resource_rdx1ngmygm4ph44hjwry6pkzv5qx62qy8p7hzu96829tp4wxrmenp8ve9x
    live badge             = #1#
    held by                = account_rdx12y6ch4m8wjcgu7hrnwfqjeqt70w4kh7qy7k3gs2j9wyx3596fgt3fm

- **Resource:** `resource_rdx1ngmygm4ph44hjwry6pkzv5qx62qy8p7hzu96829tp4wxrmenp8ve9x` — the
  Wave B arbiter badge: **non-fungible, identity-bearing, non-transferable.** One unit, local
  id `#1#`, minted 2026-09-13 02:33:54Z by the `gen_arbiter_badge_manifest` generator
  (`txid_rdx18suqg7drx3qs4zpzcf2yk67ajprey0dtnw2tyzxsf2wcafr6g4ns57mk4n`); NF data
  `ArbiterBadgeData { assigned_account }` = the holder below, read back before AND after
  instantiate. `withdrawer` is **DenyAll, forever** — the unit can never leave the account it
  was minted into, which is WHY `resolve_dispute` takes it as a `Proof` (§ Ruling semantics)
  and why nothing can recall or re-assign it (`docs/DESIGN-REVIEW-2027.md` §23). Mint and
  burn require the PULL-era escrow owner badge `…dlphp` (the lost-badge recovery path: mint a
  replacement unit; the registry row has the roles). Instantiate arg 2 of the Wave B
  component, write-once. Distinct from the Guild Member badge (`worker_badge_resource`) —
  see `project_arbiter_badge_is_not_member_badge` in memory for the history of that
  confusion. ⚠️ The badge this page named until 2026-09-17,
  `resource_rdx1nf229dxvw72cqzrrkgqvn6zxxjmjpf3hx0zhulsfz4tka5kgnvakn3` (`<arbiter_bigdev>`,
  transferable, carried no identity the method read), belongs to the RETIRED PULL component
  `…cz468e` and rules nothing on Wave B.
- **Held by:** `account_rdx12y6ch4m8wjcgu7hrnwfqjeqt70w4kh7qy7k3gs2j9wyx3596fgt3fm` — **Guild
  admin 2**, the fresh operator seed of 2026-09-12, = `assigned_account` by the 2026-09-13
  sitting's ruling (that account never claims a task, so the L6(c) guard never sees the
  arbiter as a worker). Per `docs/ESCROW-ADDRESSES.md` it also holds the Wave B escrow owner
  badge and the NFT-swap owner badge. The PULL-era consolidation account
  `account_rdx12xm464txr74x9srzmmy5404lyqv650kkgy8ezrx76tmjpl5djvnnwv` this page used to
  name holds no arbiter authority on the live component. Custody has now moved twice
  (dApp-def → consolidation, 2026-08-10; a NEW resource born into Guild admin 2 at the
  2026-09-13 cutover) — exactly why the harness derives both addresses live and will
  disagree with this page the moment it happens again.
- 🔑 **THE SIGNING PATH IS THE MOBILE WALLET, NOT `--live`. Confirmed with the operator
  2026-08-23 for the consolidation account, and the same shape for Guild admin 2** — it is a
  wallet-held seed too (the 2026-09-13 badge mint, instantiate and XRD-register transactions
  were all signed from it in the wallet), so bigdev signs from the Radix **mobile** wallet.
  A mobile-wallet account has no exportable ed25519 key sitting in an env file, so
  `ARBITER_PRIVATE_KEY` is not "not provisioned yet" — for this custody it is **never going to
  exist**, and `--live` is therefore dead weight on this path rather than the goal to work
  toward. Do not read the `--live` flag as the intended route and do not go looking for a key
  to make it work.
  **The real ceremony, and it is the one this repo already uses for every operator signature
  (the P2 cutover, all five P3-2 edge transactions and the whole Wave B ceremony were done
  exactly this way):**
  1. `bun scripts/arbiter-harness.mjs resolve --task <id> --ruling <r>` — the dry run. It
     refuses unless the task reads `Disputed` on chain right now, previews keylessly against
     live state, and **prints the manifest**.
  2. Read the verdict. If it is not `PROVEN`, stop — do not sign a manifest the simulator
     would not accept.
  3. Copy the printed manifest into the Radix mobile wallet and sign it there.
  4. Re-run the dry run **immediately before signing**, not from an earlier session: a preview
     taken across a gap is evidence about a chain state that has moved on.
  `--live` remains implemented and safe (it re-previews, refuses anything not `PROVEN`, and
  asserts the key derives the chain-confirmed holder account) so that a future
  key-in-environment custody — a dedicated arbiter seed, a VPS-side resolver — works without a
  rewrite. It is unreachable under today's custody, and that is the correct default: the
  authority to overrule a settlement should be harder to exercise than an env var.

### Ruling semantics

`resolve_dispute(task_id, arbiter_badge: Proof, ruling) -> Bucket` — **Proof, not Bucket,
since `fa8c15e` (Wave B).** The badge never enters the method: the caller proves custody
(`create_proof_of_non_fungibles` on the holder account — what `resolveDisputeManifest`
emits), the method asserts the resource and amount 1, decodes the unit's `ArbiterBadgeData`,
and the ONLY thing it returns is the arbiter fee. `ruling` is one of:

| CLI `--ruling` | On-chain `DisputeRuling` | What moves — all CREDITED inside the component, pulled later via `withdraw_worker` / `withdraw_poster` |
|---|---|---|
| `pay-worker` | `PayWorker` | reward + remaining insurance → worker; whole claim bond → worker |
| `refund-poster` | `RefundPoster` | reward + remaining insurance → poster; whole claim bond → poster |
| `split --worker-pct X --poster-pct Y` (non-negative, must sum to exactly 1) | `Split{worker_pct,poster_pct}` | reward, remaining insurance AND the claim bond each split X/Y |

Three things the pre-Wave-B version of this table did not say:

1. **The claim bond follows the reward ruling** (W5, ruled 2026-08-29 — proportional, not a
   cliff): `credit_split_for_parties` applies `worker_share(reward_ruling)` to the bond vault
   and credits the remainder to the poster. Chain-confirmed on task 5: a 0.5/0.5 split
   credited 38.225 XRD of the 76.45 XRD bond to each side.
2. **The self-dealing guard, L6(c), is worker-side only:** the method asserts
   `assigned_account != task.worker_account` and panics with
   `self-dealing: the arbiter badge is assigned to this task's worker account`. The poster
   side is deliberately NOT compared — `task.poster` is a caller-supplied payout destination
   bound to nothing (M5), so a poster-side check would be a decoy defence. An arbiter-poster
   can rule on a dispute they funded; they still cannot steal, because settlement credits
   only pinned accounts. State this as OPEN in any honesty copy.
3. **The fee is rounded DOWN before it is taken:**
   `arbiter_fee = (insurance_vault_amount × task.arbiter_fee_pct)` rounded `ToZero` to the
   insurance token's divisibility, so an unrepresentable product can never panic the ruling
   (which would have left auto-resolve as the task's only exit). Whatever is shaved off
   stays in `remaining_insurance` and lands with the parties.

`remaining insurance = insurance_vault_amount − arbiter_fee`. **`max_arbiter_fee_pct` is
`0.1` on the live component (Gateway read 2026-09-17) — a ceiling, never a charge** — but
every `create_task` caller in this codebase passes `arbiter_fee_pct = "0"`, INCLUDING the
real dashboard path a poster actually funds a task through — the literal in
`src/lib/escrow-utils.ts`'s `create_task` argument list is annotated
`// arbiter_fee_pct — no arbiter fee at launch (disputes auto-resolve)` — not only
`poster-harness.mjs` and the edge probes. So for every task funded through this app so far,
`arbiter_fee` is 0 and the full insurance premium passes through to whichever party(ies)
the ruling favors — arbitrating today earns the arbiter nothing, by this codebase's own
convention, not by blueprint limitation (task 5's `DisputeResolvedEvent` carries
`arbiter_fee: 0`). The fee bucket deposits straight back to the arbiter's own account
(`deposit_batch` of the worktop); PULL settlement credits the worker/poster shares INSIDE
the component, so nothing here can misroute a counterparty's money (BUG-7's exact root
cause, closed).

There is **no per-unit or per-account pin** on the badge, by design: its mint role is
`require(owner_badge)`, not `deny_all`, so a lost badge is recoverable by minting a
replacement unit, and the guard against misuse is the identity assertion above, not the
unit id. Do not "fix" this into a SCRYPTO-AUTH-CONVENTION Pattern 2 pin — the comment on
the method says the same.

> ⚠️ **Corrected 2026-09-01.** This paragraph read "the arbiter's own badge and fee bucket
> (`resolve_dispute` returns `(Bucket, Bucket)`)". Both halves are false as of `fa8c15e`:
> the badge is passed as a **`Proof`** and is never returned, and the return is one bucket.
> The Wave B arbiter badge is non-transferable by ruling (`withdrawer` DenyAll, forever), so
> a badge that can never leave its account can never be passed as a `Bucket` — the
> bucket-form method would have been permanently uncallable on the component this blueprint
> ships, leaving auto-resolve as the only dispute exit.

`resolve_dispute` carries **no deadline of its own** — an arbiter may rule at any time while
the task reads `Disputed`, not just within the 72h window below.

### The fallback if nobody arbitrates

`auto_resolve_dispute(task_id)` is **PUBLIC** — anyone may call it, no badge or key beyond
gas required — once the auto-resolve window has elapsed since `raise_dispute`. **Since Wave B
the window and the default ruling are PINNED onto the task at `raise_dispute`** (a later
`set_dispute_auto_resolve_*` cannot move a dispute already in flight — "the deal both sides
see is the deal that settles"); the component values they are pinned from read
`dispute_auto_resolve_secs = 259200` (72h) and `dispute_auto_resolve_default = SplitEvenly`
on the live component (Gateway read 2026-09-17 02:38Z — **not** `FavorDisputeRaiser`, which
some older docs and code comments still assume). Three things distinguish it from an
arbiter ruling:

1. **It governs the REWARD (and, with it, the bond) — never the insurance.** The insurance
   premium **always returns to the poster in full**, regardless of the default —
   `SplitEvenly` here means the *reward* splits 50/50 and the claim bond splits 50/50 with
   it (the bond lane follows the reward ruling on both dispute paths — § Ruling semantics),
   not that insurance splits too. No arbiter fee is taken (nobody arbitrated).
2. **It is a race, not a schedule.** Because `resolve_dispute` has no deadline, the arbiter
   can act any time up to the moment SOMEONE — either party, a bystander, or a future cron —
   calls `auto_resolve_dispute` after the window opens. Whichever call lands first on-chain
   decides the task; there is no way to "hold" the dispute open past 72h waiting for a human.
3. **It has never fired on the live component.** The one dispute so far (task 5) was
   arbiter-ruled two and a half minutes after it opened (§ Verification status).

### What this path does NOT give you

**No SLA.** DB-5 (P3-2 sitting) ruled explicitly that there is no committed arbitration
turnaround time. The 72h auto-resolve is a chain-enforced backstop against a dispute
stalling forever — it is not a promise that a human will look at any particular dispute
within any particular window. An operator who wants a ruling to land before the default
fires must notice the dispute and act inside 72h.

**A page when a dispute opens — but within 30 minutes, above 100 XRD, and to the operator
chat.** ⚠️ For a few hours on 2026-09-17 this paragraph read "No page when a dispute OPENS …
the drift watcher checks state parity, not dispute state". That was WRONG: it was written
from `keeper.mjs`'s header and CLAUDE.md's one-line description of the drift watcher, without
reading the watcher — a partial read recorded as a whole one. What exists, read in source
AND seen running in `/var/log/guild-drift.log` on the box the same day:
`scripts/escrow-drift-watch.mjs` **PASS 3** (since 2026-08-23) is chain-first — every 30 min
it enumerates the component's OWN tasks `1..next_task_id−1` (cap 500, so a hand-built
manifest with no DB row is still seen) and, for each one reading `Disputed`, fires a
four-stage Telegram alert, each stage once per `(component, task)`: `raised` → `half` (≤50%
of the window left) → `closing` (≤10%) → `lapsed` (re-fires every run; an unreadable
deadline counts as `lapsed`, never as quiet). The message carries the payout preview under
the pinned default and the exact `arbiter-harness.mjs resolve` command. Its limits:

1. **Latency is the cron interval.** Task 5's dispute (2026-09-14) opened and was ruled inside
   2.5 minutes, between two runs — it never paged, correctly.
2. **XRD disputes under `GUILD_DISPUTE_ALERT_MIN_XRD` (default 100, reward + insurance) are
   logged, not paged.** Non-XRD and unpriceable disputes always page.
3. **It sends to `KEEPER_ALERT_TG_CHAT` — the operator chat — and does not honour
   `KEEPER_ALERT_TG_CHAT_ARBITER`** the way `keeper.mjs` does. Same phone today, because the
   badge sits in the operator's wallet; a routing gap the day an arbiter is a third party
   (`docs/DESIGN-REVIEW-2027.md` §23), and at odds with the 2026-08-29 ruling that
   dispute-lifecycle alerts go to users + arbiter, not admin.

Beside it: `scripts/keeper.mjs` is the DB-driven *lapsed*-dispute backstop (fires when a
window first lapses, then at most daily; arbiter-channel aware), and the app writes an in-app
`dispute_raised` notification to the *counterparty* user (`src/lib/escrow-confirm.ts`,
`recipientId: otherPartyId`) — never to the arbiter.

**No poster-side self-dealing guard.** L6(c) covers the worker side only (§ Ruling
semantics); an arbiter who is also the poster can rule on a dispute they funded. Open by
design and disclosed in the honesty copy — never claim it closed.

**No second arbiter.** One badge, one holder. A second live unit makes the harness refuse
(`findLiveArbiterBadge` throws at more than one non-burned id) until it grows a selector,
and nothing on the live resource can recall or re-assign a unit once minted —
`docs/DESIGN-REVIEW-2027.md` §23 (AR1–AR5) is the open decide-box for distributing this.

### Verification status

**Exercised ONCE for real on the live Wave B component — task 5, 2026-09-14** (Gateway,
read 2026-09-17: tasks 1–36 scanned, exactly one carries `dispute_raised_by`; none reads
`Disputed` today):

| Leg | Signer | Tx | Receipt |
|---|---|---|---|
| `raise_dispute`, 11:39:00Z | Poster 2 `…efl40r2p7u`, proving task receipt `#5#` | `txid_rdx18h6lzeja4uufnenrvxd05sfmg4908v4n4hdaa9qn632w8qx6p7kqqe4df4` | `DisputeRaisedEvent { raised_by: Poster, evidence_hash: Some(…), window + default pinned }` |
| `resolve_dispute`, 11:41:33Z | Guild admin 2 `…3596fgt3fm`, `create_proof_of_non_fungibles` of `#1#` on `…enp8ve9x` | `txid_rdx1zew46jjskng2a9dmq678qggs3g86q45z79s5p86khq03sk0yygrqsq8m8t` | `DisputeResolvedEvent { ruling: Split 0.5/0.5, arbiter_fee: 0, worker 262.5, poster 262.5 }`; `SettlementCreditedEvent` bond 38.225 / 38.225 (of the 76.45 floor bond); task → `Released`; fee 0.956 XRD |

So the Proof-form call, the `ArbiterBadgeData` decode, the L6(c) assertion (arbiter
`…fgt3fm` ≠ worker `…ratgkqt8`), the bond-follows-ruling lane and the fee rounding (at 0)
have all executed on mainnet against the live component. ⚠️ **That ruling is recorded
nowhere but the chain** — not in `PROJECT-STATE.md`, not in the registry — so which tool
built the manifest (this harness's dry run pasted into the wallet, or something else) is not
known; the on-chain manifest matches `resolveDisputeManifest`'s shape. The Phase-0 rehearsal
on the throwaway `…htg2pe3f` (2026-09-13, generator-minted badge) had exercised the same
method a day earlier, off the live component.

**Not proven by any of that:** a `PayWorker` or `RefundPoster` ruling on the live component
(only `Split` has ever been applied), a non-zero `arbiter_fee`, the self-dealing panic
(never tripped on mainnet), a ruling on a non-XRD reward token, and `auto_resolve_dispute`
on the live component (never called). The evidence this section used to cite — a synthetic
2026-08-23 preview chaining `create_task → … → resolve_dispute` — ran against the retired
PULL component's `Bucket`-form method and says nothing about the live one. Re-run the dry
run immediately before any ruling; a preview taken across a gap is evidence about a chain
that no longer exists. ⚠️ Until 2026-09-17 this subsection read "No task has ever entered
`Disputed` on mainnet … unexercised in production": true of the PULL component, false on
Wave B since 2026-09-14.

---

> ⚠️ **NOTHING FROM HERE TO §4 DESCRIBES WHAT SHIPPED.** §1-§3 are the ORIGINAL 2026-05-19
> design exploration, kept verbatim as a historical record (the docs rule: "archiving is not
> tidying — it destroys the sole record"; being old is not being superseded). None of the
> tiered dispute ladder, arbitrator reputation pool, Telegram notification flow, Dispute
> Prevention Score, milestone escrows, or Kleros bridge below was ever built. The actual
> system that shipped is §0 above: one binary dispute state, one arbiter ruling OR one
> public time-gated default — no tiers, no panels, no scoring. Read on only for the design
> history, never as an instruction.

## 1. Industry Research: How Existing Platforms Handle Disputes

### 1.1 Upwork

**Process:** Structured 5-step escalation ladder.

| Step | Actor | Timeline | Outcome |
|------|-------|----------|---------|
| 1. Filing | Either party | Immediate | Dispute opened |
| 2. Response | Opposing party | 5 calendar days | Agreement or escalation |
| 3. Mediation | Upwork specialist | ~2 business days | Non-binding recommendation |
| 4. Accept/Decline | Both parties | 2 calendar days | Accept or escalate |
| 5. Final Resolution | Upwork binding decision | ~2 business days | Funds disbursed |

**Key mechanics:**
- 14-day auto-release to worker if poster doesn't respond (worker-friendly default)
- Human mediators make non-binding recommendations first
- No separate fee for dispute resolution (included in 15-20% platform take)
- Hourly contracts use Work Diary (screenshot monitoring) as evidence
- Total timeline: 11-15 calendar days

**Takeaways for Guild:**
- Auto-release on poster timeout is essential
- 5-day response windows prevent indefinite delays
- Non-binding mediation resolves most disputes without formal arbitration

### 1.2 Kleros (Decentralized Court)

**Process:** Multi-round Schelling point game with staked jurors.

| Phase | Mechanism | Duration |
|-------|-----------|----------|
| Case creation | Dispute submitted with evidence + question | Immediate |
| Juror drawing | Random PNK token selection, proportional to stake | ~1 day |
| Evidence period | Both parties submit evidence | 3-7 days |
| Voting period | Hidden commit-reveal voting | 2-3 days |
| Reveal period | Votes revealed, majority wins | 1-2 days |
| Appeal period | Losing party can appeal (doubles jurors) | 3 days |

**Key mechanics:**
- 1,900+ disputes processed lifetime, 170+ integration partners
- Jurors stake PNK tokens (min 1,000-1,600 PNK, ~$41-67)
- Jurors voting against majority get slashed; majority voters earn rewards
- Appeals double juror count: 3 → 7 → 15 → 31...
- No platform fee — all fees go to jurors
- ~7.37% staking APY for active jurors
- Final appeal goes to all staked PNK holders (general court)

**Takeaways for Guild:**
- Schelling point works best for binary, specification-based disputes
- Doubling jurors on appeal makes manipulation exponentially expensive
- Guild should structure tasks with clear pass/fail criteria to work with this model
- Can integrate as external Tier 4 escalation

### 1.3 Aragon Court

**Status: Defunct as of late 2024.** Aragon Association dissolved, ANT tokens redeemable for ETH at 0.0025376 per ANT. Not a viable integration target.

**Historical model:**
- Guardians staked ANT tokens, same Schelling point game as Kleros
- "Optimistic governance" — proposals assumed valid unless challenged
- DAO-native, governance-focused disputes

**Takeaway:** The optimistic model (auto-approve unless challenged) is worth adopting for low-risk tasks.

### 1.4 OpenSea / NFT Marketplaces

**Process:** Primarily customer support-driven for off-chain disputes. On-chain trades are atomic (Seaport protocol) — either both sides settle or nothing happens.

**Key mechanics:**
- Atomic settlement eliminates most escrow disputes entirely
- Off-chain disputes (stolen NFTs, counterfeit collections) handled by centralized support team
- OpenSea can freeze/delist assets but cannot reverse on-chain trades
- Seaport is fully decentralized with no owner/upgradeability

**Takeaway:** Atomic settlement doesn't apply to task marketplaces (asynchronous delivery), but the principle of clear on-chain finality is important. Once an escrow ruling is executed, it should be irreversible.

### 1.5 eBay

**Process:** Buyer/seller protection with structured evidence and auto-escalation.

| Step | Timeline | Outcome |
|------|----------|---------|
| 1. Open case | Immediate | Seller notified |
| 2. Seller response | 3 business days | Resolve or escalate |
| 3. eBay review | If unresolved after step 2 | eBay decides |
| 4. Appeal | 30 days after resolution | Re-review possible |

**Key mechanics:**
- **Money Back Guarantee** covers most purchases automatically
- Evidence-based: tracking numbers, delivery confirmation, photos
- Automated resolution for clear-cut cases (e.g., item not received + no tracking)
- Human review for subjective disputes (item not as described)
- Seller ratings directly affected by dispute outcomes
- Repeat offenders face progressive penalties (fee increases, restrictions, suspension)

**Takeaway:** Auto-resolution for clear-cut cases is powerful. Guild should auto-resolve when objective criteria (tests pass, code compiles, deadline met) can determine the outcome.

---

## 2. Guild Dispute System Design

### 2.1 Tier 1: Auto-Resolution (Prevent Disputes Before They Happen)

Auto-resolution eliminates disputes by making outcomes deterministic through objective criteria.

#### 1. Clear Deliverables Requirement

Every task must specify **acceptance criteria** at creation time:

```typescript
interface AcceptanceCriteria {
  checklist: string[];           // "Landing page responsive at 768px"
  automated_gates?: AutoGate[]; // Code compilation, test pass, coverage
  quality_threshold?: number;   // Minimum quality score (0-100)
}
```

Tasks without acceptance criteria receive a lower Dispute Prevention Score (see Section 3).

#### 2. Automated Checks (Code Tasks)

For tasks tagged with `code`, `testing`, or `security-audit`:

| Check | Trigger | Auto-Outcome |
|-------|---------|-------------|
| **Compilation** | `bun run build` succeeds | Pass gate |
| **Test suite** | `bun run test` passes | Pass gate |
| **Coverage threshold** | Coverage ≥ task-specified minimum | Pass gate |
| **Lint/format** | No lint errors | Pass gate |
| **Type check** | `tsc --noEmit` passes | Pass gate |

If all automated gates pass, the submission is **pre-approved** — the poster must provide specific objection to override.

#### 3. Deadline Enforcement

```
Task assigned ──[start_timeout: 7 days]──→ No submission? Auto-release claim
                                           Worker rep: -10 (task_abandoned)
                                           Task returns to "open"

Task submitted ──[review_timeout: varies]──→ No response? Auto-release to worker
                                             (Upwork-style worker-friendly default)
```

**Review timeout by task value:**

| Task Value (XRD) | Review Period | Max Extensions |
|-------------------|--------------|----------------|
| < 50 | 7 days | 1 (+3 days) |
| 50-500 | 14 days | 2 (+7 days each) |
| 500-5,000 | 21 days | 2 (+14 days each) |
| > 5,000 | 30 days | 3 (+14 days each) |

#### 4. Milestone Gates

Each milestone in a milestone escrow is an independent escrow cycle:
- Its own submission, review, auto-release timer, and dispute capability
- A dispute on Milestone 3 does NOT block payment for completed Milestones 1-2
- Remaining unfunded milestones pause until disputes resolve

#### 5. Quality Scoring (AI-Powered)

Agent Reviewers can auto-score submissions:

```typescript
interface QualityScore {
  overall: number;         // 0-100
  completeness: number;    // All deliverables present?
  technical_quality: number; // Code quality, design quality
  specification_match: number; // Does it match acceptance criteria?
  flagged_issues: string[]; // Specific concerns
}
```

- Score ≥ 80: Auto-approve recommendation (poster can still override)
- Score 50-79: Manual review required
- Score < 50: Auto-flag for rejection with specific reasons

#### 6. Double-Blind Review

For tasks with `double_blind: true`:
- Reviewer cannot see who submitted the work
- Poster identity hidden from reviewer
- Reduces bias in quality assessment
- Particularly valuable for Agent Reviewer fairness

### 2.2 Tier 2: Simple Dispute Form (Standard Process)

When the poster rejects a submission, the formal dispute process begins.

#### Process Flow

```
POSTER rejects submission
    │
    ▼
[Dispute Created — status: "disputed"]
    │
    ├── Worker has 48 hours to respond with evidence
    │   └── Fields: counter-argument, evidence links, screenshots, proposed resolution
    │
    ├── Poster has 48 hours to counter-respond
    │   └── Fields: response to worker evidence, additional evidence
    │
    └── System evaluates:
        ├── If worker agrees with rejection → Refund to poster
        ├── If poster agrees with counter → Release to worker
        ├── If both agree on split → Execute split
        └── If no agreement → Escalate to Tier 3
```

#### Evidence Submission Format

```typescript
interface DisputeEvidence {
  party: "poster" | "worker";
  timestamp: number;
  reason: DisputeReason;
  description: string;          // Max 2000 chars
  evidence_links: string[];     // URLs to screenshots, repos, demos
  evidence_hashes: string[];    // IPFS hashes for immutable evidence
  proposed_resolution: ProposedResolution;
}

type DisputeReason =
  | "incomplete_work"
  | "does_not_match_spec"
  | "low_quality"
  | "scope_disagreement"
  | "communication_breakdown"
  | "deadline_missed"
  | "other";

type ProposedResolution =
  | { type: "full_refund" }
  | { type: "full_payment" }
  | { type: "split"; worker_pct: number; poster_pct: number }
  | { type: "rework"; additional_time_hours: number };
```

#### Timelines

| Event | Deadline | If Missed |
|-------|----------|-----------|
| Worker response | 48 hours | Auto-refund to poster |
| Poster counter | 48 hours | Auto-release to worker |
| Mutual agreement | 5 days total | Escalate to Tier 3 |

### 2.3 Tier 3: Mediation (Community Arbitration Panel)

Community-based arbitration using Guild's existing badge and reputation system.

#### Arbitrator Selection

```
Qualified Pool:
  • Reputation ≥ Builder level (201+ points)
  • Badge: "arbiter" milestone (5+ disputes previously arbitrated)
  • Not involved in the task (not poster, worker, or reviewer)
  • No prior disputes with either party in last 90 days

Selection:
  • 3 arbitrators randomly selected from qualified pool
  • Weighted by reputation score (higher rep = higher selection probability)
  • Each arbitrator has 7 days to submit their ruling
  • If an arbitrator doesn't respond, replacement is drawn
```

#### Arbitration Process

```
[Dispute Escalated to Tier 3]
    │
    ▼
[3 Arbitrators Selected — notified via Telegram bot + dashboard]
    │
    ├── Arbitrators receive:
    │   • Original task specification + acceptance criteria
    │   • Worker's submission + deliverable
    │   • All evidence from Tier 2
    │   • Communication history
    │
    ├── Each arbitrator independently submits:
    │   • Ruling: PayWorker / RefundPoster / Split(worker%, poster%)
    │   • Written reasoning (required, min 100 chars)
    │   • Confidence level (1-5)
    │
    └── Majority vote decides outcome
        • 3-0 unanimous: immediate execution
        • 2-1 split: execute majority ruling
        • If all 3 different: re-draw panel (once), then 50/50 split
```

#### On-Chain Execution

The winning ruling maps directly to the existing `DisputeRuling` enum in the Scrypto blueprint:

```rust
pub enum DisputeRuling {
    PayWorker,
    RefundPoster,
    Split(Decimal, Decimal),  // (worker_pct, poster_pct)
}
```

Executed via `resolve_dispute()` with the arbiter's Guild badge proof. Arbiter receives 10% of insurance vault as fee.

#### Arbitrator Incentives

| Action | Reputation | XRD |
|--------|-----------|-----|
| Arbitration completed (voted with majority) | +15 | 10% of insurance pool / 3 |
| Arbitration completed (voted with minority) | +5 | 10% of insurance pool / 3 |
| Arbitration declined/timed out | -10 | None |
| Written reasoning rated helpful by both parties | +25 bonus | None |

### 2.4 Tier 4: Custom Contracts & External Escalation

For complex or high-value tasks that exceed standard dispute resolution.

#### Custom Contract Terms

```typescript
interface CustomContract {
  id: string;
  task_id: number;
  version: number;
  
  // Parties
  poster_address: string;
  worker_address: string;
  
  // Terms
  acceptance_criteria: AcceptanceCriteria[];
  payment_schedule: PaymentMilestone[];
  penalties: Penalty[];
  dispute_escalation: EscalationPath;
  
  // Signatures
  poster_signature: string;    // Radix wallet signature
  worker_signature: string;    // Radix wallet signature
  signed_at: number;
  
  // Immutability
  terms_hash: string;          // SHA-256 of serialized terms
  on_chain_tx: string;         // TX that stored hash on Radix
}

interface Penalty {
  condition: string;           // "deadline_missed_by_7_days"
  action: "reduce_payment" | "increase_payment" | "cancel_task";
  amount_pct?: number;         // Percentage adjustment
}

interface EscalationPath {
  tier_1_auto: boolean;        // Use auto-resolution?
  tier_2_window_hours: number; // Custom dispute window
  tier_3_panel_size: number;   // 3, 5, or 7 arbitrators
  external_arbitration?: "kleros"; // External escalation
}
```

#### Kleros Integration (External Tier 4)

For disputes exceeding Guild's internal resolution capacity:

```
[Tier 3 fails or task value > 5,000 XRD]
    │
    ▼
[Create Kleros case]
    • Submit evidence package to Kleros
    • Specify "Guild Tasks" subcourt
    • Post arbitration fee deposit
    │
    ▼
[Kleros juror selection + voting]
    • 3+ jurors drawn from PNK stakers
    • Standard Kleros commit-reveal voting
    │
    ▼
[Kleros ruling returned to Guild]
    • Execute on-chain via GuildEscrow::resolve_dispute
    • Kleros ruling is final (no further Guild appeals)
```

---

## 3. Dispute Prevention Score

Calculate a task's dispute risk at creation time to inform escrow requirements and user warnings.

### Score Calculation

```typescript
interface DisputePreventionScore {
  score: number;        // 0-100
  risk_level: "low" | "medium" | "high";
  factors: ScoreFactor[];
  recommendations: string[];
}

interface ScoreFactor {
  name: string;
  points: number;
  met: boolean;
}

function calculateDisputePreventionScore(task: TaskCreationData): DisputePreventionScore {
  const factors: ScoreFactor[] = [
    {
      name: "Clear deliverables defined",
      points: 20,
      met: task.acceptance_criteria.length > 0
    },
    {
      name: "Automated acceptance criteria",
      points: 30,
      met: task.automated_gates !== undefined && task.automated_gates.length > 0
    },
    {
      name: "Milestone breakdown",
      points: 20,
      met: task.milestones !== undefined && task.milestones.length > 1
    },
    {
      name: "Deadline specified",
      points: 10,
      met: task.deadline !== undefined
    },
    {
      name: "Poster has good history",
      points: 10,
      met: task.poster_reputation >= 200 && task.poster_dispute_rate < 0.1
    },
    {
      name: "Worker has good history",
      points: 10,
      met: task.worker_reputation >= 200 && task.worker_dispute_rate < 0.1
    },
  ];

  const score = factors.filter(f => f.met).reduce((sum, f) => sum + f.points, 0);
  
  const risk_level = score >= 80 ? "low" : score >= 50 ? "medium" : "high";
  
  const recommendations = factors
    .filter(f => !f.met)
    .map(f => `Add: ${f.name} (+${f.points} safety points)`);

  return { score, risk_level, factors, recommendations };
}
```

### Risk Level Actions

| Risk Level | Score | Badge | Escrow Requirement |
|------------|-------|-------|-------------------|
| **Low** | 80-100 | Green | Standard (reward + 2% insurance) |
| **Medium** | 50-79 | Yellow | Standard + warning displayed |
| **High** | 0-49 | Red | Higher insurance (5%) + milestone required for >500 XRD |

### UI Display

```
┌──────────────────────────────────────┐
│  Dispute Prevention Score: 70/100    │
│  ████████████████░░░░  [MEDIUM RISK] │
│                                      │
│  ✅ Clear deliverables (+20)         │
│  ✅ Automated checks (+30)           │
│  ❌ No milestone breakdown (+20)     │
│  ✅ Deadline set (+10)               │
│  ❌ New poster, no history (+10)     │
│  ── Worker not yet assigned (+10)    │
│                                      │
│  💡 Add milestones to improve score  │
└──────────────────────────────────────┘
```

---

## 4. Existing Implementation Status

> Rewritten 2026-08-23 — the table below previously cited `escrow/scrypto/guild-escrow`,
> which is the **deprecated** blueprint tree; none of those line numbers exist in the live
> `guild-marketplace-escrow` blueprint, and the "Arbiter badge milestone" /
> `dispute_arbitrated` rep-points rows described a reputation-gated badge system that is not
> how the live arbiter badge works — it is a real, operator-held, supply-1, identity-bearing
> and (since Wave B) non-transferable NFT (`arbiter_badge_resource`), not something a user
> earns. See §0 for the corrected model. Line-number cites below were re-pointed to content
> on 2026-09-17 — the numbers had drifted by ~700 lines since 2026-08-23.

### Live today

| Component | Location | Status |
|-----------|----------|--------|
| `DisputeRuling` enum (`PayWorker`, `RefundPoster`, `Split{worker_pct,poster_pct}`) | `escrow/scrypto/guild-marketplace-escrow/src/lib.rs`, `pub enum DisputeRuling` | ✅ on-chain, ordinal-pinned by `tests/unit/dispute-ruling-ordinal.test.ts` |
| `raise_dispute()` — poster (task receipt) or claiming worker (claimer badge) proves a `Proof`, flips `Submitted` → `Disputed`, pins window + default | `.../src/lib.rs`, `pub fn raise_dispute` | ✅ on-chain, PUBLIC — raised once for real (task 5) |
| `resolve_dispute()` — arbiter-ruled finalize, **Proof-form**, L6(c) worker-side guard | `.../src/lib.rs`, `pub fn resolve_dispute` | ✅ on-chain, PUBLIC (badge-gated) — ruled once for real (task 5, §0) |
| `auto_resolve_dispute()` — permissionless default finalize after the task's pinned window | `.../src/lib.rs`, `pub fn auto_resolve_dispute` | ✅ on-chain, PUBLIC — never called on the live component |
| `raiseDisputeManifest`, `resolveDisputeManifest`, `autoResolveDisputeManifest` builders | `guild-app/src/lib/manifests.ts` | ✅ shape-verified (`manifest-abi-gate.test.ts`) |
| Operator resolver — the caller `resolveDisputeManifest` had none of, until now | `guild-app/scripts/arbiter-harness.mjs` | ✅ (P3-3a) — see §0 |
| Dispute UI (submit/raise from the dashboard) | `guild-app/src/app/disputes/page.tsx` + task detail | ✅ compiled ON since 2026-08-29 (`NEXT_PUBLIC_FEATURE_DISPUTES=true`; `scripts/launch-check.sh` fails a build with it OFF) — `/disputes` served 200 on 2026-09-17 |
| Arbiter resolution UI / route | — | ⛔ does not exist — §0's CLI + wallet ceremony is the only caller (`DESIGN-REVIEW-2027.md` §23 AR5 is the decide-box) |
| Dispute-raised alert | `scripts/escrow-drift-watch.mjs` PASS 3 (chain-first, four stages raised → half → closing → lapsed); `scripts/keeper.mjs` (lapsed backstop); in-app `dispute_raised` (counterparty only, `escrow-confirm.ts`) | ✅ live since 2026-08-23 and seen running on the box 2026-09-17 — ≤30 min latency, ≥100 XRD to page, and it goes to the OPERATOR chat, not yet the arbiter channel (§0 "What this path does NOT give you"). ⚠️ This row said "partial — only nagged after the window lapses" for a few hours on 2026-09-17; wrong, corrected the same day. |

### Never built (§1-§3's design, superseded by what actually shipped)

| Component | Note |
|-----------|------|
| Evidence submission UI/API, tiered dispute ladder (§2.1-§2.4) | The live blueprint is binary: `Disputed` → arbiter or auto-resolve. No tiers. |
| Arbitrator selection algorithm / reputation-gated pool | The live arbiter is one operator-held badge, not a selectable pool. |
| Dispute Prevention Score (§3) | Not built; no acceptance-criteria or automated-gate scoring exists. |
| Milestone escrow blueprint | Not built; the deployed blueprint is single-settlement per task. |
| Kleros integration bridge | Not built; no external arbitration path exists. |
| Custom contract builder UI | Not built. |
| Double-blind review system | Not built. |
