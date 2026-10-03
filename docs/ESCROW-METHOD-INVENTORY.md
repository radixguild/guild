<!-- status: live
     verified: 2026-09-21 (HAND-MAINTAINED SECTIONS, ALL OF THEM — State Machine, Auth
     Model, Method Catalog, Events, Enums, Key Data Structures were each re-read against
     escrow/scrypto/guild-marketplace-escrow/src/lib.rs at 812453d and rewritten where
     wrong. Found: the Method Catalog listed 21 of 39 methods, every Line was stale, and
     13 rows carried a signature or return type the code no longer has — incl.
     `submit_task → Bucket — claim bond returned`,
     false since the Wave B cutover (it returns `()`; the bond stays vaulted until a
     settlement path credits it); three Auth Model rows said "bucket-burn" for methods
     that take a `Proof`; the Events table had 17 of 29 events; Enums lacked
     `FavorNonRaiser`, `EntitledParty`, `EntitlementLane`. These sections now restate NO
     signature and NO line number, and `checkHandTables` — run by
     `gen-method-inventory.mjs --check` and `method-inventory-hand-tables.test.ts` — gates
     their coverage, access class, return type, credential shape and enum variant order.
     NOT gated by anything: the prose in the "what it does" cells, the State Machine
     table's transitions, and which method emits which event. Those were read against
     the source today and can rot between re-reads. The NftSwap block was not re-read.) ·
     2026-09-15 (NFTSWAP BLOCK ADDED — P7-02, task 90: the standalone
     `NftSwap` blueprint (src/nft_swap.rs) gets its OWN generated table, spliced at
     its own NFT_SWAP_BEGIN/END markers by the SAME generator
     (`gen-method-inventory.mjs`, now scraping two files); `--check`/`--write` and
     the vitest gate (`method-inventory-gate.test.ts`) both cover it. The escrow's
     own table's Line column shifted (+6, a `pub mod nft_swap;` declaration) —
     mechanical, regenerated, not independently re-verified beyond that.) ·
     2026-08-30 (AUTH MODEL TABLE ONLY — added the two stage-6 rows,
     `set_review_window_secs` OWNER and `release_after_review_timeout` PUBLIC time-gated,
     matching enable_method_auth! in lib.rs; the gating test
     test_every_method_appears_in_the_auth_model_table passes. NOTHING else re-verified
     today.) ·
     2026-08-15 (GENERATED SIGNATURE TABLE ONLY — spot-checked against
     escrow/scrypto/guild-marketplace-escrow/src/lib.rs: instantiate :461 with its 11 args
     and 3-tuple return, withdraw_forfeited_bonds :722, get_forfeited_bond_amount :2446 all
     match, and the pull surface withdraw_worker/withdraw_poster/get_entitlements/
     get_bond_entitlements/get_settlement_balances is present in source as listed. That
     stamp also said the hand-maintained tables were "STILL UNVERIFIED … kept for auth
     commentary only" — true, and it stayed true for five more weeks; see 2026-09-21.)
     A green CI check means no row is missing, extra, or contradicts a signature; it does
     not mean this document is correct.
     supersedes: none (pre-dates the header rule) -->

# Escrow Blueprint — Method Inventory

> Method index for `escrow/scrypto/guild-marketplace-escrow/src/lib.rs`.
>
> ✅ **The signature table is now GENERATED and CI-checked** (2026-08-09). The generator,
> `gen-method-inventory.mjs` (`--write` regenerates, `--check` verifies), is kept in the
> private operations repository. In this repository `tests/unit/method-inventory-gate.test.ts`
> makes the same comparison through the same shipped functions
> (`guild-app/scripts/lib/blueprint-methods.mjs`), in `test.yml`'s unit job on every PR, which
> is **unfiltered** — `scrypto.yml` is path-filtered to `escrow/scrypto/**`
> and so would miss an edit to *this file*, while a `lib.rs` edit needs catching too. Only an
> unfiltered job sees both sides.
>
> ⚠️ **What a green check proves here, and what it does not.** The generated blocks are
> byte-checked: name, line, receiver, arguments, return type. The hand-maintained sections
> below them — **Auth Model**, **Method Catalog**, **Events Emitted**, **Enums**, **Key Data
> Structures** — are checked by `checkHandTables` (the same `--check`, plus
> `tests/unit/method-inventory-hand-tables.test.ts`) for exactly this: every method, event,
> enum and struct in `lib.rs` has one row and no row names something that is gone; each Auth
> Model row opens with the access class `enable_method_auth!` declares and its credential
> note agrees with the parameter types (`Proof` vs bucket-burn); each Method Catalog row
> opens with the return type the code has; enum variants are listed in source order; no hand
> table carries a `Line` or parameter column. **Nothing reads the prose.** The "what it does"
> sentences, the State Machine transitions and the event emitters were read against the
> source on the `verified:` date and can rot between re-reads. A green check means "no row
> is missing, extra, or contradicts a signature", **not** "this document is correct". Do not
> upgrade that into a broader guarantee; over-claiming what a check proves is how this file
> became untrustworthy in the first place.
>
> **The history, because it is the argument for generating it.** The banner here once read
> "DO NOT EDIT — regenerated by deepseek-tui" while **no regenerator existed in this repo** —
> so nobody edited it, and nothing regenerated it. Four ABI changes landed without this file
> moving. By 2026-08-09 the `Line` column was off by **120–940 lines** (instantiate 330→451,
> create_task 520→727, submit_task 976→1292) and the params column described calls that would
> not compile: `Bucket` where the code takes `Proof`, a `claim_task` arg that no longer exists,
> a `create_task` arg added later, and `expire_claim` shown returning `()` when it returns the
> DB-4 caller bounty `Bucket`.
>
> **It then happened again, one section further down.** The hand-written tables were left
> under the generated block "for their auth commentary only", behind a banner calling them
> unverified. Nobody re-read them, because a banner is not a check. By 2026-09-21 they listed
> 21 of the blueprint's 39 methods and still said `submit_task` returns the claim bond —
> false since the Wave B cutover, and the same claim the site was found making in seventeen
> places that week. They now restate no signature at all: one fact, one place, and a gate on
> the rest.

## Public ABI — generated from `lib.rs`

<!-- BEGIN GENERATED METHOD TABLE — do not edit by hand -->

<!-- Regenerate: cd guild-app && bun scripts/gen-method-inventory.mjs --write -->
<!-- Verified in CI: bun scripts/gen-method-inventory.mjs --check -->

| Method | Line | Receiver | Arguments | Returns |
|---|---|---|---|---|
| `instantiate` | 701 | — | `worker_badge_resource: ResourceAddress`, `arbiter_badge_resource: ResourceAddress`, `agent_badge_resource: Option<ResourceAddress>`, `max_arbiter_fee_pct: Decimal`, `human_submit_deadline_secs: u64`, `agent_submit_deadline_secs: u64`, `dispute_auto_resolve_secs: u64`, `expire_grace_secs: u64`, `dispute_auto_resolve_default: AutoResolveDefault`, `min_insurance_fraction: Decimal`, `claim_bond_pct: Decimal`, `claim_bond_floor: Decimal`, `claim_bond_cap: Decimal`, `expire_bounty_pct: Decimal`, `review_window_secs: u64` | `(Global<Escrow>, Bucket, Bucket)` |
| `add_accepted_token` | 1037 | `&mut self` | `resource: ResourceAddress`, `min_amount: Decimal` | `()` |
| `remove_accepted_token` | 1051 | `&mut self` | `resource: ResourceAddress` | `()` |
| `freeze_token` | 1059 | `&mut self` | `resource: ResourceAddress` | `()` |
| `unfreeze_token` | 1065 | `&mut self` | `resource: ResourceAddress` | `()` |
| `set_claim_bond_params` | 1151 | `&mut self` | `claim_bond_pct: Decimal`, `claim_bond_floor: Decimal`, `claim_bond_cap: Decimal` | `()` |
| `set_expire_bounty_pct` | 1176 | `&mut self` | `pct: Decimal` | `()` |
| `set_review_window_secs` | 1188 | `&mut self` | `secs: u64` | `()` |
| `set_dispute_auto_resolve_default` | 1205 | `&mut self` | `default: AutoResolveDefault` | `()` |
| `set_dispute_auto_resolve_secs` | 1210 | `&mut self` | `secs: u64` | `()` |
| `set_human_submit_deadline_secs` | 1223 | `&mut self` | `secs: u64` | `()` |
| `set_agent_submit_deadline_secs` | 1229 | `&mut self` | `secs: u64` | `()` |
| `set_min_insurance_fraction` | 1235 | `&mut self` | `fraction: Decimal` | `()` |
| `set_max_arbiter_fee_pct` | 1244 | `&mut self` | `pct: Decimal` | `()` |
| `set_expire_grace_secs` | 1253 | `&mut self` | `secs: u64` | `()` |
| `withdraw_forfeited_bonds` | 1258 | `&mut self` | `resource: ResourceAddress` | `Bucket` |
| `create_task` | 1278 | `&mut self` | `poster: ComponentAddress`, `reward: Bucket`, `insurance: Bucket`, `arbiter_fee_pct: Decimal`, `work_brief_hash: Hash` | `Bucket` |
| `cancel_task` | 1450 | `&mut self` | `receipt: Proof` | `()` |
| `claim_task` | 1494 | `&mut self` | `task_id: u64`, `worker: ComponentAddress`, `worker_badge: Proof`, `claim_bond: Bucket` | `Bucket` |
| `expire_claim` | 1725 | `&mut self` | `task_id: u64` | `Bucket` |
| `cancel_task_by_poster_after_claim` | 1810 | `&mut self` | `task_id: u64`, `receipt: Proof` | `()` |
| `submit_task` | 1890 | `&mut self` | `task_id: u64`, `claim_receipt: Bucket`, `evidence_hash: Hash`, `brief_hash: Hash` | `()` |
| `approve_and_release` | 2020 | `&mut self` | `receipt: Proof` | `()` |
| `release_after_review_timeout` | 2103 | `&mut self` | `task_id: u64` | `()` |
| `raise_dispute` | 2156 | `&mut self` | `task_id: u64`, `party_proof: Proof`, `evidence_hash: Option<Hash>` | `()` |
| `resolve_dispute` | 2273 | `&mut self` | `task_id: u64`, `arbiter_badge: Proof`, `ruling: DisputeRuling` | `Bucket` |
| `auto_resolve_dispute` | 2475 | `&mut self` | `task_id: u64` | `()` |
| `withdraw_worker` | 2861 | `&mut self` | `task_id: u64`, `badge: Proof` | `()` |
| `withdraw_poster` | 2914 | `&mut self` | `task_id: u64`, `receipt: Proof` | `()` |
| `push_entitlement` | 2974 | `&mut self` | `task_id: u64`, `party: EntitledParty` | `()` |
| `burn_task_receipt` | 3026 | `&mut self` | `receipt: Bucket` | `()` |
| `get_entitlements` | 3400 | `&self` | `task_id: u64` | `(Decimal, Decimal)` |
| `get_bond_entitlements` | 3416 | `&self` | `task_id: u64` | `(Decimal, Decimal)` |
| `get_settlement_balances` | 3428 | `&self` | `task_id: u64` | `(Decimal, Decimal)` |
| `get_accepted_tokens` | 3442 | `&self` | — | `Vec<(ResourceAddress, AcceptedTokenConfig)>` |
| `get_config` | 3449 | `&self` | — | `EscrowConfig` |
| `get_task_info` | 3469 | `&self` | `task_id: u64` | `Option<TaskInfo>` |
| `get_task_balances` | 3475 | `&self` | `task_id: u64` | `(Decimal, Decimal, Decimal)` |
| `get_forfeited_bond_amount` | 3502 | `&self` | `resource: ResourceAddress` | `Decimal` |

<!-- END GENERATED METHOD TABLE -->

## Public ABI — `NftSwap`, generated from `nft_swap.rs`

> P7-02 (task 90): a STANDALONE blueprint in the same Scrypto package
> (`escrow/scrypto/guild-marketplace-escrow`), own module
> (`src/nft_swap.rs`). Design: `docs/design/nft-swap.md` (kept in the private operations
> repository). It shares the
> receipt-NFT + internal-minter + royalty-dial PATTERNS with
> `guild_marketplace_escrow` by copy, not by refactor — none of the escrow's
> own behaviour changed to make room for this. Same generation contract as
> the block above: signatures only, byte-checked in CI
> (`method-inventory-gate.test.ts` here, `gen-method-inventory.mjs --check` in the
> private operations repository); this method's own prose (state
> machine, invariants, royalty dials) lives in `nft_swap.rs`'s doc comments,
> not restated here to avoid a second copy that can drift.

<!-- BEGIN GENERATED METHOD TABLE (NftSwap) — do not edit by hand -->

<!-- Regenerate: cd guild-app && bun scripts/gen-method-inventory.mjs --write -->
<!-- Verified in CI: bun scripts/gen-method-inventory.mjs --check -->

| Method | Line | Receiver | Arguments | Returns |
|---|---|---|---|---|
| `instantiate` | 203 | — | — | `(Global<NftSwap>, Bucket, Bucket)` |
| `list` | 320 | `&mut self` | `seller: ComponentAddress`, `asset: NonFungibleBucket`, `asks: Vec<Ask>`, `expires_at: Instant` | `Bucket` |
| `fill` | 433 | `&mut self` | `listing_id: u64`, `alternative: u8`, `payment: Bucket` | `NonFungibleBucket` |
| `cancel` | 494 | `&mut self` | `receipt: Proof` | `NonFungibleBucket` |
| `extend_listing` | 526 | `&mut self` | `receipt: Proof` | `()` |
| `withdraw_proceeds` | 550 | `&mut self` | `receipt: Proof` | `()` |
| `burn_listing_receipt` | 589 | `&mut self` | `receipt: Bucket` | `()` |
| `get_listing` | 624 | `&self` | `listing_id: u64` | `Option<Listing>` |
| `get_config` | 628 | `&self` | — | `NftSwapConfig` |
| `get_proceeds` | 644 | `&self` | `listing_id: u64` | `Option<(ResourceAddress, Decimal)>` |

<!-- END GENERATED METHOD TABLE (NftSwap) -->

## Blueprint: `guild_marketplace_escrow`

### State Machine

`TaskState` has six values; `Released` and `Refunded` are terminal. Every transition is
guarded by a state assert inside the method named, so a call from any other state reverts.
The last column is the one this document had wrong: **no method hands the claim bond back
to the worker as a return value** — it sits in the task's bond vault from `claim_task`
until a settlement path credits it to a pinned account. The only bond money that leaves in
a returned `Bucket` is `expire_claim`'s bounty, and that goes to whoever expired the claim,
not to the worker who posted it.

| From | Method | To | Where the claim bond goes |
|---|---|---|---|
| — | `create_task` | Open | none posted yet |
| Open | `cancel_task` | Refunded | none posted |
| Open | `claim_task` | Claimed | INTO the task's bond vault |
| Claimed | `expire_claim` (only after claim deadline + grace) | Open | forfeited: bounty share to the caller, rest to the house vault |
| Claimed | `cancel_task_by_poster_after_claim` | Refunded | credited to the worker |
| Claimed | `submit_task` | Submitted | **stays in the vault** |
| Submitted | `approve_and_release` | Released | credited to the worker |
| Submitted | `release_after_review_timeout` (only after the review deadline) | Released | credited to the worker |
| Submitted | `raise_dispute` | Disputed | stays in the vault |
| Disputed | `resolve_dispute` | Released (PayWorker, Split) or Refunded (RefundPoster) | split between worker and poster by the ruling |
| Disputed | `auto_resolve_dispute` (only after the pinned window) | Released or Refunded, same mapping | split by the default ruling |

"Credited" means recorded as an entitlement and moved to a settlement vault inside the
component. Nothing reaches an account until `withdraw_worker`, `withdraw_poster` or
`push_entitlement` runs, and those deposit only into the account pinned at `claim_task`
(worker) or `create_task` (poster). The withdrawals and `burn_task_receipt` do not change
`TaskState`.

### Auth Model (from `enable_method_auth!`)

> ⚠️ Hand-maintained, and it has been WRONG twice in one day. A parallel session
> found all seven owner-gated setters missing; a conformance test then found six
> MORE — the three PULL withdrawals and three views — absent since before either
> pass. A reader consulting this table would have concluded the component has 5
> owner methods (it has 12) and no PULL surface at all.
> **`test_every_method_appears_in_the_auth_model_table` now gates it.** The
> catalog generator explicitly does not cover this table, which is exactly why
> it drifted: a gate that is green over the part that is wrong is worse than no
> gate, because it reads as assurance.
>
> **Wrong a third time, found 2026-09-21** — and that Rust test could not have
> seen it, because it checks that a method is LISTED, not what its row says.
> `cancel_task`, `cancel_task_by_poster_after_claim` and `approve_and_release`
> still read "bucket-burn auth inside" long after PULL converted all three to
> take a `Proof` and leave the receipt unburned. The Rust test also lives in
> `scrypto.yml`, which is path-filtered to `escrow/scrypto/**` and so never runs
> on an edit to this file. `checkHandTables` (unfiltered `test.yml`) now checks
> both directions of coverage, the access class against `enable_method_auth!`,
> and the credential note against the parameter types. It still cannot read the
> rest of a note — "time-gated", "pays only the pinned payee" are prose.
>
> Row format is load-bearing: the Rust test looks for `| name |` with no
> backticks, after this heading.

| Method | Auth Rule |
|--------|-----------|
| add_accepted_token | OWNER |
| remove_accepted_token | OWNER |
| freeze_token | OWNER |
| unfreeze_token | OWNER |
| withdraw_forfeited_bonds | OWNER |
| set_dispute_auto_resolve_default | OWNER |
| set_dispute_auto_resolve_secs | OWNER |
| set_human_submit_deadline_secs | OWNER |
| set_agent_submit_deadline_secs | OWNER |
| set_min_insurance_fraction | OWNER |
| set_max_arbiter_fee_pct | OWNER |
| set_expire_grace_secs | OWNER |
| set_claim_bond_params | OWNER |
| set_expire_bounty_pct | OWNER |
| set_review_window_secs | OWNER |
| create_task | PUBLIC (no credential — anyone may fund a task; consumes the reward + insurance buckets and pins the `poster` payee account the caller names) |
| cancel_task | PUBLIC (Proof check inside — task receipt, NOT burned: it is still needed for `withdraw_poster`) |
| claim_task | PUBLIC (Proof check inside — worker badge, or agent badge when one is configured) |
| expire_claim | PUBLIC (time-gated, no auth) |
| cancel_task_by_poster_after_claim | PUBLIC (Proof check inside — task receipt, NOT burned) |
| submit_task | PUBLIC (bucket-burn auth inside — the claim receipt; must be the task's ACTIVE receipt id) |
| approve_and_release | PUBLIC (Proof check inside — task receipt, NOT burned) |
| release_after_review_timeout | PUBLIC (time-gated, no auth — settles by credit to pinned accounts) |
| raise_dispute | PUBLIC (Proof check inside — poster: task receipt for this task; worker: the exact badge id they claimed with) |
| resolve_dispute | PUBLIC (Proof check inside — arbiter badge; refused when the badge is assigned to this task's worker account) |
| auto_resolve_dispute | PUBLIC (time-gated, no auth) |
| withdraw_worker | PUBLIC (Proof check inside — pays only the pinned payee) |
| withdraw_poster | PUBLIC (Proof check inside — pays only the pinned payee) |
| burn_task_receipt | PUBLIC (bucket-burn auth inside — the task receipt; refused while the poster is owed anything or the task is not terminal) |
| push_entitlement | PUBLIC (no auth — destination read from state, not the caller) |
| get_accepted_tokens | PUBLIC |
| get_config | PUBLIC |
| get_task_info | PUBLIC |
| get_task_balances | PUBLIC |
| get_forfeited_bond_amount | PUBLIC |
| get_entitlements | PUBLIC |
| get_bond_entitlements | PUBLIC |
| get_settlement_balances | PUBLIC |

---

## Method Catalog

> **What each method gives back, and where the money goes.** Hand-maintained, so read the
> scope: `checkHandTables` guarantees that every `pub fn` has exactly one row here and that
> each row OPENS with the return type the code actually has. It cannot read the sentence
> after the type. Signatures, arguments and line numbers are deliberately absent — they live
> only in the generated **Public ABI** table above; access rules and credentials live only in
> **Auth Model**. One fact, one place.
>
> Two words used throughout. **Credited** = recorded as an entitlement and moved into a
> settlement vault inside the component; no account has received anything yet. **Pinned** =
> fixed onto the task when a party committed (`create_task`, `claim_task`, `submit_task`,
> `raise_dispute`) and never read from live config or from the caller afterwards.

### 1. Instantiation

| Method | Returns | What it does — and where the money goes |
|---|---|---|
| `instantiate` | `(Global<Escrow>, Bucket, Bucket)` — the component, the owner badge, the royalty-admin badge | A function, not a method, so it has no Auth Model row. Fifteen positional arguments: the three badge resources are write-once, the other twelve are starting values an owner setter can change later. Mints the owner, royalty-admin and internal-minter badges and creates the task-receipt and claim-receipt resources. The deploy manifest must route BOTH returned badge buckets — they are separate authorities (DB-2). Argument order is pinned to the signed parameter sheet by `test_instantiate_signature_matches_the_signed_sheet` and by `gen-instantiate-manifest.mjs --check`. |

### 2. Owner-only configuration

Every setter re-applies the validation `instantiate` applies, touches no vault and no task,
and emits its own `…UpdatedEvent`. "FUTURE" below means the value is pinned onto each task
when a party commits, so a later tune cannot change a deal already in flight. The two
exceptions are marked LIVE.

| Method | Returns | What it does — and where the money goes |
|---|---|---|
| `add_accepted_token` | `()` — nothing | Whitelists a reward token with a per-token minimum reward. Refuses a token already listed, and any token with divisibility 0 (a split could not be expressed in it). |
| `remove_accepted_token` | `()` — nothing | Drops a token from the whitelist. It does not check for tasks already funded in that token — freeze first and let them finish. |
| `freeze_token` | `()` — nothing | Stops NEW tasks in that token; `create_task` is the only method that enforces the flag, so tasks already funded run to completion. |
| `unfreeze_token` | `()` — nothing | Reverses `freeze_token`. |
| `set_claim_bond_params` | `()` — nothing | The claim bond for FUTURE claims: `pct` × reward, clamped to `[floor, cap]`. Requires 0 ≤ pct ≤ 1, floor ≥ 0, cap ≥ floor. `claim_task` pins the amount actually posted, and every settlement reads the pin. |
| `set_expire_bounty_pct` | `()` — nothing | The share (0–1) of a forfeited bond paid to whoever calls `expire_claim`. Read LIVE at expiry, on purpose: it only splits caller-vs-house, and the worker forfeits the whole bond at every value of it. |
| `set_review_window_secs` | `()` — nothing | How long a poster has to review FUTURE submissions; 1–30 days. Pinned onto the task at `submit_task`. |
| `set_dispute_auto_resolve_default` | `()` — nothing | The default ruling for FUTURE disputes that nobody judges. Pinned onto the task at `raise_dispute`. |
| `set_dispute_auto_resolve_secs` | `()` — nothing | The auto-resolve window for FUTURE disputes; must be positive. Pinned at `raise_dispute`. |
| `set_human_submit_deadline_secs` | `()` — nothing | The submit deadline for FUTURE claims made with a worker badge; must be positive. The deadline is computed and stored at `claim_task`. |
| `set_agent_submit_deadline_secs` | `()` — nothing | The same, for claims made with an agent badge. |
| `set_min_insurance_fraction` | `()` — nothing | Minimum insurance as a fraction (0–1) of the reward, enforced at `create_task`. |
| `set_max_arbiter_fee_pct` | `()` — nothing | Ceiling (0–1) on the `arbiter_fee_pct` a poster may choose at `create_task`. Each task keeps the fee it was created with. |
| `set_expire_grace_secs` | `()` — nothing | The grace after a claim deadline in which only the worker can act. Read LIVE in `expire_claim` — it moves a deadline, never a payee. No bounds check. |
| `withdraw_forfeited_bonds` | `Bucket` — everything in the house's forfeited-bond vault for that resource | The owner collects the house share of expired claim bonds, one resource per call. Panics if nothing was ever forfeited in that resource. |

### 3. Task lifecycle

| Method | Returns | What it does — and where the money goes |
|---|---|---|
| `create_task` | `Bucket` — the task receipt NFT, local id = task id | Takes reward + insurance into per-task vaults. Both must be the same whitelisted, unfrozen token; reward ≥ the token's minimum; insurance ≥ `min_insurance_fraction` × reward; `arbiter_fee_pct` ≤ the maximum. Pins `poster` — which must be a global account — as the payee for every poster-side payout. State → Open. |
| `cancel_task` | `()` — nothing; the receipt is presented as a Proof and kept | Open tasks only. Credits reward + insurance to the POSTER. State → Refunded. The poster collects with `withdraw_poster`. |
| `claim_task` | `Bucket` — the claim receipt NFT | Open tasks only. The bond must be in the task's reward token and EXACTLY the required amount (pct × reward, clamped, rounded down to the token's divisibility); it goes into the task's bond vault and the amount is pinned. Pins `worker` — a global account that must differ from `poster` — as the payee, and the badge's local id as the worker's credential. Sets the submit deadline. State → Claimed. |
| `expire_claim` | `Bucket` — the CALLER's bounty: `expire_bounty_pct` of the forfeited bond, rounded down | Anyone, once the claim deadline plus `expire_grace_secs` has passed. The whole bond is forfeited: bounty to the caller, the remainder to the house vault, nothing to the poster and nothing back to the worker. Reward + insurance stay escrowed and the task returns to Open for another claim; the old claim receipt is left orphaned and no longer matches. |
| `cancel_task_by_poster_after_claim` | `()` — nothing; the receipt is a Proof and kept | Claimed tasks only. Credits reward + insurance to the POSTER and the bond to the WORKER, whose claim is being cancelled through no fault of theirs. State → Refunded. |
| `submit_task` | `()` — nothing. **The claim bond is NOT returned here** | Claimed tasks only. Burns the task's active claim receipt. Requires a non-zero `evidence_hash` and a `brief_hash` equal to the task's committed `work_brief_hash`. Pins the review deadline. **Moves no money**: the bond stays in its vault until a settlement path credits it to the pinned worker account — before Wave B this method returned the bond to whoever called it, so a stolen claim receipt could take it (E1/E2). State → Submitted. |
| `approve_and_release` | `()` — nothing; the receipt is a Proof and kept | Submitted tasks only. Credits reward + bond to the WORKER and the insurance back to the POSTER. State → Released. |
| `release_after_review_timeout` | `()` — nothing, to anyone | Anyone, once the pinned review deadline has passed and the task is still Submitted. Credits exactly what `approve_and_release` credits. The poster may still `raise_dispute` after the deadline until someone calls this: first to commit wins. State → Released. |

### 4. Disputes

| Method | Returns | What it does — and where the money goes |
|---|---|---|
| `raise_dispute` | `()` — nothing | Submitted tasks only, by the poster or the worker. Pins the auto-resolve window and default ruling in force at that moment. **Moves no money.** The first raise ends the other party's chance to raise. State → Disputed. |
| `resolve_dispute` | `Bucket` — the arbiter's fee: `arbiter_fee_pct` × the insurance, rounded down. The only bucket out | Disputed tasks only. The fee comes out of the insurance; then reward, remaining insurance and bond are all credited by the one ruling — `PayWorker` all to the worker, `RefundPoster` all to the poster, `Split` pro-rata with the worker's share rounded down and the poster taking the remainder. State → Released (`PayWorker`, `Split`) or Refunded (`RefundPoster`). |
| `auto_resolve_dispute` | `()` — nothing, to anyone | Anyone, once the pinned window has elapsed since the dispute was raised. No arbiter fee. The pinned default ruling decides the REWARD and the BOND; the insurance always goes back to the poster whole, because nobody judged. Same state mapping as `resolve_dispute`. |

### 5. Collection

| Method | Returns | What it does — and where the money goes |
|---|---|---|
| `withdraw_worker` | `()` — nothing is returned; the funds are DEPOSITED | Deposits the worker's credited reward lane and bond lane into the worker account pinned at `claim_task`. Reverts if nothing is owed. The badge decides who may trigger this, never where the money goes — a transferred badge can only pay the real worker. |
| `withdraw_poster` | `()` — nothing is returned; the funds are DEPOSITED | The same for the poster, into the account pinned at `create_task`. The task receipt is kept, not burned. |
| `push_entitlement` | `()` — nothing, to anyone | Anyone can push either party's credited funds to THAT PARTY's pinned account; there is no address parameter. Exists so a lost or unnoticed credential cannot strand settled money. It cannot help if the pinned account itself refuses the deposit. |
| `burn_task_receipt` | `()` — nothing | Retires a spent task receipt. Refused while the poster is owed anything in either lane, and until the task is Released or Refunded — the receipt is the only credential that can settle or collect. Moves no money. |

### 6. Views

| Method | Returns | What it does — and where the money goes |
|---|---|---|
| `get_entitlements` | `(Decimal, Decimal)` — (worker, poster) credited in the REWARD lane and not yet collected | Panics on an unknown task id. A Released task can show both non-zero: settled is not collected. |
| `get_bond_entitlements` | `(Decimal, Decimal)` — (worker, poster) credited in the BOND lane and not yet collected | The poster's side is non-zero only after a dispute ruling awarded them part of the bond. An expired claim credits neither side. Panics on an unknown task id. |
| `get_settlement_balances` | `(Decimal, Decimal)` — (reward lane, bond lane) actually HELD in the two settlement vaults | The denominator for the two views above: owed should equal held, lane by lane. Zeros for an unknown task id. |
| `get_accepted_tokens` | `Vec<(ResourceAddress, AcceptedTokenConfig)>` — every whitelisted token with its minimum and frozen flag | Read-only. |
| `get_config` | `EscrowConfig` — all fifteen parameters as they stand now | Live config, not what any particular task was pinned with — read `get_task_info` for that. |
| `get_task_info` | `Option<TaskInfo>` — `None` for an unknown id | The whole task record, including every pinned value and all four entitlement fields. |
| `get_task_balances` | `(Decimal, Decimal, Decimal)` — (reward, insurance, bond) still in the PRE-settlement vaults | These read zero once a task settles; use `get_settlement_balances` for what is held afterwards. Zeros for an unknown task id. |
| `get_forfeited_bond_amount` | `Decimal` — the house's forfeited-bond balance in that resource | Zero for a resource nothing was ever forfeited in. |

---

## Events Emitted

All 29 events registered in the blueprint's `#[events(...)]` attribute. Coverage is gated in
both directions and every emitter named must be a real `pub fn`; WHICH method emits which
event was read from the source on the `verified:` date and is not gated.

| Event | Emitted by |
|---|---|
| `EscrowInstantiatedEvent` | `instantiate` |
| `TokenWhitelistedEvent` | `add_accepted_token` |
| `TokenRemovedEvent` | `remove_accepted_token` |
| `TokenFrozenEvent` | `freeze_token` |
| `TokenUnfrozenEvent` | `unfreeze_token` |
| `ForfeitedBondsWithdrawnEvent` | `withdraw_forfeited_bonds` |
| `TaskCreatedEvent` | `create_task` |
| `TaskCancelledEvent` | `cancel_task` |
| `TaskClaimedEvent` | `claim_task` |
| `ClaimExpiredEvent` | `expire_claim` — carries the forfeited amount and the bounty paid |
| `TaskCancelledAfterClaimEvent` | `cancel_task_by_poster_after_claim` |
| `WorkSubmittedEvent` | `submit_task` — carries the pinned review deadline |
| `TaskReleasedEvent` | `approve_and_release` (ruling `"PayWorker"`), `release_after_review_timeout` (ruling `"ReviewTimeout"`), and `resolve_dispute` / `auto_resolve_dispute` when the ruling is PayWorker or Split. Means "reached a terminal state", NOT "the money moved" |
| `TaskRefundedEvent` | `resolve_dispute` / `auto_resolve_dispute` when the ruling is RefundPoster. NOT emitted by `cancel_task` or `cancel_task_by_poster_after_claim`, although both end in Refunded |
| `DisputeRaisedEvent` | `raise_dispute` — carries the pinned window and default ruling |
| `DisputeResolvedEvent` | `resolve_dispute` |
| `DisputeAutoResolvedEvent` | `auto_resolve_dispute` |
| `SettlementCreditedEvent` | Every path that credits an entitlement: `cancel_task`, `cancel_task_by_poster_after_claim`, `approve_and_release`, `release_after_review_timeout`, `resolve_dispute`, `auto_resolve_dispute`. Reports all four entitlement fields, zeros included. This — not TaskReleased — says what each party is OWED. Deliberately NOT emitted by `expire_claim`, which credits nobody |
| `WithdrawalEvent` | `withdraw_worker`, `withdraw_poster`, `push_entitlement` — one event per non-empty lane, so a single call can emit two that differ only in lane and amount. Carries the pinned destination account |
| `DisputeAutoResolveDefaultUpdatedEvent` | `set_dispute_auto_resolve_default` |
| `DisputeAutoResolveSecsUpdatedEvent` | `set_dispute_auto_resolve_secs` |
| `HumanSubmitDeadlineUpdatedEvent` | `set_human_submit_deadline_secs` |
| `AgentSubmitDeadlineUpdatedEvent` | `set_agent_submit_deadline_secs` |
| `MinInsuranceFractionUpdatedEvent` | `set_min_insurance_fraction` |
| `MaxArbiterFeePctUpdatedEvent` | `set_max_arbiter_fee_pct` |
| `ExpireGraceSecsUpdatedEvent` | `set_expire_grace_secs` |
| `ClaimBondParamsUpdatedEvent` | `set_claim_bond_params` |
| `ExpireBountyPctUpdatedEvent` | `set_expire_bounty_pct` |
| `ReviewWindowSecsUpdatedEvent` | `set_review_window_secs` |

## Enums (Domain Types)

Variants are listed in SOURCE ORDER, and the order is gated. For the three enums that cross
the manifest boundary (`AutoResolveDefault`, `DisputeRuling`, `EntitledParty`) that order is
an on-chain encoding: SBOR encodes a variant by its index, so `SplitEvenly` is `Enum<1u8>`
in every manifest that names it. New variants go at the END.

- `AutoResolveDefault`: FavorDisputeRaiser, SplitEvenly, ReturnToPoster, FavorNonRaiser
- `TaskState`: Open, Claimed, Submitted, Disputed, Released, Refunded
- `DisputeParty`: Poster, Worker
- `DisputeRuling`: PayWorker, RefundPoster, Split { worker_pct, poster_pct }
- `EntitledParty`: Worker, Poster
- `EntitlementLane`: Reward, Bond

`AutoResolveDefault` is what `auto_resolve_dispute` applies to the reward and the bond when
the window lapses unjudged: the raiser wins, 50/50, everything to the poster, or the raiser
loses. `Split`'s two percentages must sum to exactly 1. `EntitledParty` is the argument to
`push_entitlement`; `EntitlementLane` tells the two `WithdrawalEvent`s of one call apart —
since Wave B both lanes hold the task's reward token, so the resource cannot.

## Key Data Structures

Named, not line-numbered: find them by `pub struct <Name>` in `lib.rs`.

- `AcceptedTokenConfig` — per whitelisted token: `min_amount`, `frozen`
- `TaskInfo` — the whole task record: poster and worker payee accounts, reward token and amounts, state, the claimer's badge id, the pinned bond amount, claim and review deadlines, evidence hashes, the pinned dispute terms, and the four entitlement fields (worker/poster × reward/bond lane)
- `TaskReceiptData` — task receipt NFT data: `task_id`, `poster`
- `ClaimReceiptData` — claim receipt NFT data: `task_id`, `worker`, `is_agent`
- `ArbiterBadgeData` — arbiter badge NFT data: `assigned_account`. The badge resource passed to `instantiate` must carry exactly this shape, or `resolve_dispute` cannot decode it
- `EscrowConfig` — the fifteen parameters `get_config` returns
