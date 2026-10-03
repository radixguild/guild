<!-- status: historical
     verified: 2026-08-15 (the ⛔ correction banner below re-checked against
     escrow/scrypto/guild-marketplace-escrow/src/lib.rs: `pub fn instantiate` takes 11 args
     including expire_grace_secs and no heartbeat pair, and returns a 3-tuple — the banner
     is right and row 1 of the table is still the 2026-05-28 snapshot it says it is.
     `pub fn heartbeat` does not exist; row 5 is dead.) The rest of the table is a
     2026-05-28 generated snapshot and was NOT re-verified method-by-method.
     supersedes: none (pre-dates the header rule)
     NB: status is historical because this is a snapshot of a migration that has since
     happened. Per the docs rule that means docs/archive/ — but archiving is a human call
     and this file is still cited by name from ESCROW-METHOD-INVENTORY.md's history note. -->

# Escrow Migration S1 — Method Map

> `guild-escrow` (old, deprecated) → `guild-marketplace-escrow` (new)
> Generated 2026-05-28 from source on `origin/main`
>
> ⛔ **HISTORICAL — DO NOT BUILD OR DEPLOY FROM THE `instantiate` ROW.** This is a
> 2026-05-28 snapshot of a migration that has since happened, kept as the record of it.
> Row 1 lists **12 args including the heartbeat pair and no `expire_grace_secs`**, and a
> two-tuple return. Current reality: **11 args** (DB-3 removed heartbeat, D-P3 added
> `expire_grace_secs`) and a **three**-tuple (DB-2's royalty-admin badge). The only
> deploy-authoritative source is `ESCROW-PARAMETER-SHEET.md` §"PULL cutover", and the
> manifest is GENERATED from it — `cd guild-app && bun scripts/gen-instantiate-manifest.mjs` — never typed.

| # | Old Method | Old Params | New Method | New Params | Return Change | Key Differences |
|---|-----------|-----------|-----------|-----------|--------------|----------------|
| 1 | — | — | `instantiate` | `worker_badge_resource, arbiter_badge_resource, agent_badge_resource?, max_arbiter_fee_pct, human_submit_deadline_secs, agent_submit_deadline_secs, dispute_auto_resolve_secs, dispute_auto_resolve_default, min_insurance_fraction, claim_bond_xrd, heartbeat_fee_xrd, heartbeat_extension_secs` | `(Global<Escrow>, Bucket)` | NEW. Singleton deployment (old was 1-component-per-task). Returns owner badge. |
| 2 | `create_task` (constructor) | `reward: Bucket, insurance: Bucket, task_id: String, dispute_window_hours: u64, poster_address: ComponentAddress, badge_resource: ResourceAddress` | `create_task` (instance method) | `poster: ComponentAddress, reward: Bucket, insurance: Bucket, arbiter_fee_pct: Decimal, work_brief_hash: Hash` | `(Global<GuildEscrow>, Bucket)` → `Bucket` | Constructor→method. task_id auto-incr u64. Token whitelist enforced. Per-task arbiter fee. |
| 3 | — | — | `cancel_task` | `receipt: Bucket` | `(Bucket, Bucket)` | NEW. Burns receipt, returns reward + insurance. Open tasks only. |
| 4 | `claim_task` | `worker_proof: Proof, worker_address: ComponentAddress` | `claim_task` | `task_id: u64, worker: ComponentAddress, worker_badge: Proof, claim_bond: Bucket` | `()` → `Bucket` | Adds task_id + XRD claim_bond. Returns claim_receipt NFT. Agent badge support. Deadline enforced. |
| 5 | — | — | `heartbeat` | `task_id: u64, claim_receipt: Proof` | `()` | NEW. Extends claim deadline. Deducts heartbeat_fee from bond. |
| 6 | — | — | `expire_claim` | `task_id: u64` | `()` | NEW. Public, time-gated. Forfeits bond, resets task to Open. |
| 7 | — | — | `cancel_task_by_poster_after_claim` | `task_id: u64, receipt: Bucket` | `(Bucket, Bucket, Bucket)` | NEW. Poster cancels after claim. Returns reward, insurance, bond. |
| 8 | `submit_work` | `deliverable_hash: String` | `submit_task` | `task_id: u64, claim_receipt: Bucket, evidence_hash: Hash` | `()` → `Bucket` | Renamed. Burns claim_receipt. Returns bond. Hash: String→Hash. |
| 9 | `approve_and_release` | (none) | `approve_and_release` | `receipt: Bucket` | `Bucket` → `(Bucket, Bucket)` | Burns poster receipt. Returns (reward, insurance) separately. |
| 10 | `raise_dispute` | (none) | `raise_dispute` | `task_id: u64, party_proof: Proof, evidence_hash: Option<Hash>` | same `()` | Proof-based identity. Evidence hash added. Records raiser + timestamp. |
| 11 | `resolve_dispute` | `arbiter_proof: Proof, ruling: DisputeRuling` | `resolve_dispute` | `task_id: u64, arbiter_badge: Bucket, ruling: DisputeRuling` | `(Bucket, Option<Bucket>)` → `(Bucket, Bucket, Option<Bucket>, Option<Bucket>)` | Proof→Bucket (returned). 4-tuple: badge, fee, worker, poster. Split: tuple→named fields. No in-blueprint deposits. |
| 12 | — | — | `auto_resolve_dispute` | `task_id: u64` | `(Option<Bucket>, Option<Bucket>)` | NEW. Public, time-gated. Configurable default ruling. No arbiter fee. |
| 13 | — | — | `add_accepted_token` | `resource: ResourceAddress, min_amount: Decimal` | `()` | NEW. Owner-only token whitelist. |
| 14 | — | — | `remove_accepted_token` | `resource: ResourceAddress` | `()` | NEW. Owner-only. |
| 15 | — | — | `freeze_token` | `resource: ResourceAddress` | `()` | NEW. Blocks new tasks for token. |
| 16 | — | — | `unfreeze_token` | `resource: ResourceAddress` | `()` | NEW. |
| 17 | — | — | `withdraw_forfeited_bonds` | (none) | `Bucket` | NEW. Owner drains forfeited bonds + heartbeat fees. |
| 18 | `get_status` | (none) | — | — | — | REMOVED. Use `get_task_info(id).state`. |
| 19 | `get_task_info` | (none) | `get_task_info` | `task_id: u64` | `7-tuple` → `Option<TaskInfo>` | Typed struct (17 fields). Requires task_id. |
| 20 | — | — | `get_task_balances` | `task_id: u64` | `(Decimal, Decimal, Decimal)` | NEW. Per-task (reward, insurance, bond). |
| 21 | — | — | `get_accepted_tokens` | (none) | `Vec<(ResourceAddress, AcceptedTokenConfig)>` | NEW. |
| 22 | — | — | `get_config` | (none) | `EscrowConfig` | NEW. All component-level config. |
| 23 | — | — | `get_forfeited_bond_amount` | (none) | `Decimal` | NEW. |

**Architecture delta:** 1-component-per-task → singleton with KVStore | XRD-only → whitelisted tokens | role-based auth → bucket-burn receipts + proof identity | no agent support → agent badges + separate deadlines | no bonds → claim bond + heartbeat | manual disputes only → auto-resolve timeout | no cancellation → cancel (Open) + cancel-after-claim (Claimed) | in-blueprint deposits → F-003 manifest routing
