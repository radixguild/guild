# guild-escrow — DEPRECATED

This blueprint is **deprecated as of 2026-05-23**. Use [`guild-marketplace-escrow`](../guild-marketplace-escrow/) for all new development.

## Why

The 2026-05-23 in-house scrypto scan (reports not published) flagged two high-severity issues in this blueprint:

- **F-001** — the `worker` role uses `allow_all`, so any badge holder (or anonymous caller in some paths) can mark a task as claimed and post the bond. `guild-marketplace-escrow` requires a `worker_badge` resource at instantiate and gates `claim_task` on bucket presentation of that exact resource.
- **F-002** — `resolve_dispute` accepts any badge as the arbiter credential. `guild-marketplace-escrow` requires `arbiter_badge_resource` at instantiate and bucket-burns the badge on resolve.

Cherry-picked design for the replacement lives in [`docs/ESCROW-DESIGN.md`](../../../docs/ESCROW-DESIGN.md).

## Migration

| Legacy (`guild-escrow`) | Replacement (`guild-marketplace-escrow`) |
|--------------------------|-------------------------------------------|
| `instantiate(...)` (no badge args) | `instantiate(worker_badge_resource, arbiter_badge_resource, agent_badge_resource, max_arbiter_fee_pct, ...12 args total)` |
| `claim_task(task_id)` — public | `claim_task(task_id, worker_badge: Proof, claim_bond: Bucket)` — gates on badge + requires XRD bond |
| `resolve_dispute(task_id, ruling)` — open arbiter | `resolve_dispute(task_id, arbiter_badge: Bucket, ruling)` — bucket-burn arbiter badge |
| `Refunded` / `Released` terminal states | Same; plus `Disputed` intermediate, `Open ↔ Claimed` re-claim after `expire_claim` |
| No expiry | `expire_claim(task_id)` (public, time-gated, pays the caller a bounty). ~~`heartbeat`~~ was here too until DB-3 (2026-08-06) removed it from the canonical blueprint — this row is a comparison against that blueprint, so it moves with it. |
| Single token assumed | Multi-token whitelist with per-token min + frozen flag |
| Single insurance pool | Per-task dual vault (reward + insurance) with min_insurance_fraction gate |

## Retention rationale

This crate is kept in-tree as a reference for migrators and to preserve the scan-time snapshot for future review. It is **not** included in `.github/workflows/scrypto.yml`'s build/test matrix — that workflow exists and runs (5 green runs as of 2026-09-27, covering `guild-marketplace-escrow`, `badge-manager/scrypto/radix-badge-manager` and `blueprints/agent-badge-controller`); this deprecated, known-vulnerable crate is deliberately excluded from it, not pending inclusion.

Do not modify this crate. Do not add it as a dependency of new components.

## Removal timeline

Slated for full removal after:
1. `guild-marketplace-escrow` ships to mainnet (TBD)
2. All Guild bot integrations migrate
3. Any in-flight tasks under `guild-escrow` complete (or are explicitly closed)

Tracking issue: TBD.
