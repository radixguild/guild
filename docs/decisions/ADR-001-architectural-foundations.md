<!-- status: historical
     verified: 2026-05-29 (the sitting date these decisions were made and last grounded.
     NOT re-verified as a whole on 2026-08-15 — most of what it decides, GuildRegistry and
     GuildTreasury, was never built, so there is nothing to check it against. Only the two
     parameter claims called out below were checked. Deliberately NOT stamped today.)
     supersedes: none (the doc says "Supersedes: nothing")
     NB: historical because it is a dated record of a decision sitting whose implementation
     diverged — an ADR stays true as a record of what was decided, not as a description of
     what is. Archiving is a human call; it is the only record of the reasoning behind the
     badge-as-source-of-truth tier model. -->

> ⚠️ **Two numbers in here are NOT live (noted 2026-08-15) — do not build to them.**
> Decision 2 routes an **"escrow platform fee (1%)"** to a GuildTreasury: there is **no
> protocol fee on the live escrow**, launch runs **0%** by decision D2, and the fee
> instrument that was actually signed is a *native per-call royalty dial* (DB-2) — `Xrd(0)`
> and updatable on `create_task`, `Free` and **locked** on `claim_task`/`submit_task`/
> `withdraw_worker` ("workers pay 0, forever", on-ledger). Decision 3's MVP setting
> **`insurance_rate_pct` (default 2%)** is also not live: the deployed component enforces
> `min_insurance_fraction` = **0.05**. `GuildRegistry` and `GuildTreasury` do not exist.
> Parameter ground truth is `ESCROW-PARAMETER-SHEET.md`; live values `ESCROW-ADDRESSES.md`.

# ADR-001 — Architectural Foundations

**Status**: Accepted
**Date**: 2026-05-29
**Authors**: bigdev (decisions), Claude Opus (synthesis)
**Supersedes**: nothing
**Companion**: `~/Projects/ARCHON-CHARTER-20260529.md` (binding context)

## Context

After research into the unmerged `archon/harvest-2026-05-19` design docs and a full map of the current built state on `main`, the next architectural work depends on five decisions. This ADR locks four of them now; the fifth (milestone escrow) is deferred until a real >500 XRD task forces the choice.

The decisions are binding for all subsequent PRs. Archon, sub-agents, and future Claude sessions must align work to these — see ARCHON-CHARTER §8 "alignment test" (the four-question check every PR body must answer).

## Decision 1 — GuildRegistry: Hybrid (tier on badge, Registry as thin index)

**Choice: Option C — Hybrid.**

- **Tier + reputation live on the badge NFT metadata.** This is where they already live in the deployed BadgeManager. The badge IS the source of truth for what tier a member is.
- **`GuildRegistry` is a thin Scrypto component.** Its job is:
  - Gate writes to badge metadata via governance + admin rules (so a worker can't self-promote)
  - Maintain a cached read index for cheap lookups by other components (so `GuildEscrow.claim_task()` doesn't have to fetch NFT data every time)
  - Emit events when tier changes for off-chain indexers (bot, dashboard)
- **Read path**: `Escrow.claim_task` → `Registry.get_tier(badge_proof)` returns cached value, falls back to badge metadata read on cache miss.
- **Write path**: only `Registry.update_tier(admin_proof | governance_proof)` can write. The cache and the badge metadata get updated atomically.

**Why this matches charter maxim 1** ("reputation over tokens"): reputation never leaves the badge; the Registry is a router, not a duplicate ledger. No second source of truth to drift.

**Implications**:
- Schema: add `members` table to Drizzle (mirror of registry index — for fast dashboard reads).
- Bot: read tier from Registry events, not direct badge fetches.
- Existing `BadgeManager` stays as-is (it owns the NFT lifecycle).

## Decision 2 — GuildTreasury: Vault-only in Phase 1

**Choice: Option B — vault-only now, distribution math in Phase 2.**

Phase 1 has no real revenue (we're funding bounties with bigdev's XRD, not earning royalties yet). Distribution code in Phase 1 would be performative.

- **Scrypto component**: `GuildTreasury` with `deposit(bucket)`, `get_balance(token) → Decimal`, `get_total_collected() → Decimal`. NO `distribute()` method yet.
- **Escrow platform fee (1%)** routes here on `approve_and_release` (currently it routes to platform-fee-vault in escrow; reroute the destination).
- **Dashboard `/treasury` page**: shows honest empty state — "Total collected: X XRD across N tasks. Distributions begin Phase 2."
- **Phase 2 work** (separate ADR when we get there): reputation-weighted distribution function + governance-controlled distribution cadence.

**Why this matches charter maxim 5** ("cooperative over competitive"): the cooperative model needs revenue to share. Building the distribution side before revenue exists is the wrong order. The vault is real infrastructure; distribution is wishful thinking until tasks generate fees.

**Implications**:
- Schema: add `treasury_deposits` table (mirror of on-chain events).
- Escrow doesn't change shape — just the destination address for the platform fee.
- `/treasury` page is shippable in Sprint 3.

## Decision 3 — GuildSettings: MVP core, flag extras for users

**Choice: ship the MVP set of settings the platform actually needs, flag the rest as future features for users to propose.**

Per bigdev: *"I don't want to decide the whole platform — I want the core to work then the extras and tweaking can be made by the users."*

- **MVP settings (Sprint 2)** — the parameters the existing primitives already read:
  - `platform_fee_pct` (default 1%)
  - `insurance_rate_pct` (default 2%)
  - `dispute_window_hours` (default 72)
  - `claim_bond_pct` (default 5%)
  - `min_task_value_xrd` (default 1)
  - `max_task_value_xrd` (default 500 — Phase 1 cap until milestone escrow exists)
  - `tier_thresholds` (per-tier XP requirements)
  - `accepted_payment_tokens` (whitelist)
- **Each MVP setting has a default + an admin write + a vote-override path.** Admin can change for fast iteration; any quorum-passing governance vote calls `lock_setting(key)` to make further changes vote-only.
- **Per-setting threshold (option C)**: different settings get different override thresholds — fees use treasury/budget threshold (≥50%), reputation thresholds use governance-process (≥60%), constitutional things (the lock mechanism itself) use ≥66%.
- **Extras get flagged, not built**: a `settings_proposals` table where users can propose new parameters to add. Bot command `/propose_setting <name> <description>`. If it passes governance, it gets added to GuildSettings in the next deploy.

**Why this matches charter maxim 7** ("settings over hardcoding"): every parameter the platform reads is in GuildSettings from day one. Hardcoded values get replaced; nothing new gets hardcoded. New settings come from users, not from us guessing what they'll want.

**Implications**:
- Scrypto: `GuildSettings` component with `get(key) → Value`, `set_admin(admin_proof, key, value)`, `set_governance(proof, key, value, threshold_met)`, `lock(governance_proof, key)`, `propose_new_setting(any_member_proof, key, default, threshold)`.
- Schema: `settings`, `settings_locks`, `settings_proposals` tables.
- Escrow + Registry read from Settings on every operation that uses a parameter.
- Dashboard `/settings` page lists current values + lock status + open proposals.

## Decision 4 — Bot: separate codebase, shared Drizzle schema

**Choice: Option A — keep bot separate, migrate to Postgres + Drizzle.**

- **Bot stays Grammy on Node.js** — different runtime requirements (long-polling, no Next.js render path).
- **Drizzle schema is the shared contract** — bot reads/writes via `import { db } from '../guild-app/src/db'` (or copy the schema files into bot/ and keep them in lockstep via CI check).
- **SQLite → Postgres migration**:
  - Step 1 (Sprint 1): bot adds Drizzle as a parallel reader (still writes to SQLite, reads from Postgres for `users`, `badges`).
  - Step 2 (Sprint 2): full cutover — bot writes to Postgres, SQLite removed.
- **Watcher rewrite** (Sprint 2): replaces poll-based badge checks with either:
  - Postgres `LISTEN/NOTIFY` (if the trigger is dashboard-side state change), OR
  - Radix Gateway event stream (if the trigger is on-chain).

**Why this matches charter §5 repo topology**: bot is its own deploy target with its own SLOs (always-on Telegram listener). Coupling it into Next.js would force a co-deploy.

**Implications**:
- Schema: `users`, `badges`, `proposals`, `votes`, `xp_queue` tables are shared.
- CI: bot CI runs `drizzle-kit check` against the shared schema.
- Deploys: bot deploys to its own VPS (guild VPS), independent of guild-app.

## Decision 5 — Milestone Escrow: deferred

**Choice: Option C — defer until a real >500 XRD task forces the decision.**

- Phase 1 task value is capped at 500 XRD via the `max_task_value_xrd` setting (see Decision 3).
- When the first >500 XRD task appears, write ADR-002 with the choice between extending GuildMarketplaceEscrow vs. building GuildMilestoneEscrow.
- Until then: dispute design's milestone language is aspirational, not load-bearing.

## Decisions deferred / not yet asked

- **Yield strategy for treasury idle capital**: which Radix DeFi protocols, what allocation. Wait until treasury has balance worth deploying.
- **Arbitrator selection automation**: dispute design has rep-weighted selection; the automation engine to do it. Wait until first Tier-3 dispute (almost certainly Phase 2).
- **x402 endpoints in API**: spec says "agents pay via x402"; concrete `POST /api/...` shape needs writing. Couple with Agent SDK design when we get there.
- **AgentVault component**: agents need funded vault to post tasks. Wait until first agent member is active (auto-trader, defi-farmer).

## Sprint sequence (locked by these decisions)

### Sprint 1 — no decisions block these
- Cherry-pick `docs/architecture/` from `archon/harvest-2026-05-19` onto main (system-map, custom-contracts, dispute-resolution, insurance-model)
- doc-sync 20260529 P0 fixes (license, URL, TG handle, addresses, escrow pause notice)
- `/leaderboard` page (uses existing `users.xp`)
- `/profile` expansion (task history + dispute history)
- `manifest-marketplace.ts` first cut, publish first 3 manifest templates to dApp metadata
- Bot read-only Postgres mirror (Drizzle parallel reader, SQLite writes stay)

### Sprint 2 — Registry + Settings unblock
- `GuildRegistry` Scrypto component (per D1)
- `GuildSettings` Scrypto component with 8 MVP settings (per D3)
- Drizzle schema: `members`, `settings`, `settings_locks`, `settings_proposals` tables
- `/join` page (Registry exists)
- `/settings` page (Settings exists)
- Bot full Postgres cutover + event-driven watcher

### Sprint 3 — Treasury + dogfood
- `GuildTreasury` vault-only Scrypto component (per D2)
- Reroute escrow platform fee → Treasury
- `/treasury` page with honest empty state
- First Phase 1 task posted ON Guild via dashboard
- First non-bigdev dev claims the task (dogfood milestone)

## Acceptance test for every Sprint-1+ PR

Per ARCHON-CHARTER §8, every PR body answers:

1. Which charter maxim does this serve?
2. Which missing primitive from charter §6 does this build, or which built thing does it harden?
3. Which Phase 1 outcome (post first task / first dev claims / Foxie's vote) does it move closer?
4. What does it break? Which tests, interfaces, doc claims?

A PR that can't answer all four is scope creep — close it.
