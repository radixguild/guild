<!-- status: live
     verified: 2026-09-23 (§2 and its status-table row ONLY: the guild_role manager re-read on the
     Gateway — owner Require(…alkvwmfw), updater None, total_minted 0, mint_badge royalty 1 XRD — and
     /admin's role-mint action removed. Nothing else re-checked.)
     verified: 2026-08-15 (§1 re-checked against guild-app/scripts/honest-copy.mjs and
     lib/schemas.ts — two claims about voting were FALSE and are corrected below; the
     2026-08-14 ASSET-REGISTRY cross-check of guild_member/guild_role still stands)
     supersedes: none (folded from guild-public 2026-08-14 — BEST-PRACTICES.md already cited docs/BADGE-SCHEMAS.md, dangling here until this fold) -->
# Radix Guild — Badge Schemas

> ⚠️ Where this doc disagrees with `ASSET-REGISTRY.md` (chain-verified), the
> registry wins. Known drift: the `guild_role` manager is deployed but DORMANT (total_minted=0,
> chain-read 2026-07-17), not operationally "LIVE"; the member badge's on-chain `xp`/`tier`
> fields have never been written since mint. Schemas 3-6 below are proposals, never deployed.
>
> ⚠️ **ADDED 2026-08-15 — §1's two voting claims were FALSE and the caveat above did not
> cover them.** (a) "**Required to vote**": the member badge is an unlimited public mint that
> **gates nothing**, and the live Telegram bot dedupes votes on the **Telegram account**
> (`votes` PK is `(proposal_id, tg_id)`, and `users.radix_address` is not unique) — so one
> badge under two TG accounts votes twice and one account holding five badges votes once.
> The claim is false in both directions. (b) The "**Voting weight 1x→10x**" ladder is not
> implemented anywhere; `badge-weighted vot…` is a **banned string** in
> `guild-app/scripts/honest-copy.mjs` (rule "badge-per-vote"), which reddens the deploy if
> it reaches a page. Both are corrected in place in §1. The badge is also **TRANSFERABLE**
> (`withdrawer=AllowAll`, `withdrawer_updater=DenyAll`), so it cannot be an identity or a
> sybil defence, and neither word belongs in any copy generated from this file.

Badges are on-chain NFTs that represent identity, contribution, and authority within the governance system. Each schema is a separate BadgeManager created from the shared BadgeFactory.

## Active Schemas

### 1. Guild Member (`guild_member`) — LIVE
**Purpose:** Records Guild membership. It is **not** an identity and gates **nothing**.
~~Core governance identity. Required to vote.~~ *(false — corrected 2026-08-15, see banner)*
**Tiers:** member → contributor → builder → steward → elder
**Voting weight:** none — the bot is one vote per **Telegram account**, badge-independent.
~~1x → 2x → 3x → 5x → 10x~~ *(never implemented — corrected 2026-08-15, see banner)*
**Mint:** Free public mint, unlimited, no proof presented, and the result is transferable
**Progression:** XP-based in the **database**. ⚠️ The badge's own on-chain `xp`/`tier` fields
have never been written since mint; the only writer is the operator-only `update_xp`
manifest on `/admin`, and there is no batch signer. *(corrected 2026-08-15)*

### 2. Guild Role (`guild_role`) — DORMANT (0 minted ever; no app surface since 2026-09-23)
**Purpose:** Operational roles within the Guild. Never used.
**Tiers:** contributor → moderator → admin
**Mint:** Admin-only, on-chain only. `mint_badge` needs a proof of "Guild Role Badge Admin"
(`resource_rdx1th2dhtapy7jegr4p6ff2xgvnnvlwamqhh23kqgyr7xu7wmalkvwmfw`, fungible, supply 1), NOT the
/admin operator badge, and pays the manager a 1 XRD royalty. `/admin`'s "Mint Role Badge" action was
removed 2026-09-23; it had never worked (its admin badge was blank). *(corrected 2026-09-23)*
**Use:** ~~Access control for admin functions~~. Nothing checks a role badge: `/admin` gates on the
fungible operator badge `ADMIN_BADGE`. *(corrected 2026-09-23)*

## Proposed Schemas (community can create via factory)

### 3. Contributor (`guild_contributor`)
**Purpose:** Recognizes code, docs, and content contributions.
**Tiers:** helper → contributor → core contributor → maintainer
**Earned by:** Merged PRs, completed bounties, documentation
**Auto-mint trigger:** First bounty paid → helper badge auto-minted
**XP source:** Bounty XP + roll bonuses

### 4. Voter (`guild_voter`)
**Purpose:** Recognizes governance participation.
**Tiers:** casual → engaged → dedicated → delegate
**Earned by:** Voting on proposals consistently
**Auto-mint trigger:** 10th vote → casual badge auto-minted
**XP source:** Vote XP + streak bonuses

### 5. Steward (`guild_steward`)
**Purpose:** Trusted community members who verify work and manage operations.
**Tiers:** reviewer → verifier → steward → council
**Earned by:** Verifying bounties, reviewing PRs, moderating
**Mint:** Admin nominates, community votes to confirm
**Authority:** Can verify bounties, moderate proposals

### 6. Builder (`guild_builder`)
**Purpose:** Technical contributors who build infrastructure.
**Tiers:** learner → builder → architect → lead
**Earned by:** Scrypto deployments, tool creation, infrastructure work
**Mint:** Peer-nominated, admin-confirmed

## How Badges Work Together

```
User Profile (one wallet):
├── guild_member    → member (1x vote) — everyone starts here
├── guild_voter     → dedicated — earned through consistent voting
├── guild_contributor → core contributor — earned through bounties
└── guild_builder   → architect — earned through code contributions

Combined voting weight: base tier × role multipliers
Dashboard shows: all badges stacked on profile
Bot /badge shows: primary badge + earned badges list
```

## Badge Lifecycle

```
Action taken → Check thresholds → Auto-mint if earned → Announce in TG
  vote ────→ 10 votes? ────→ guild_voter (casual)
  bounty ──→ 1st bounty? ──→ guild_contributor (helper)
  PR ──────→ 1st merge? ───→ guild_builder (learner)
```

## Creating a New Schema

Anyone can create a schema via the BadgeFactory (costs 5 XRD royalty):

```
CALL_METHOD Address("<factory>") "create_manager"
  "my_dao_badges"
  Array<String>("bronze", "silver", "gold", "platinum")
  "bronze"
  true
  "My DAO Badge"
  "Description"
  Address("<dapp_def>")
```

The factory is permissionless — any Radix dApp can use it.

## Implementation Status

| Schema | Status | Manager | Auto-mint |
|--------|--------|---------|-----------|
| guild_member | LIVE | v4 mainnet | On mint page |
| guild_role | DORMANT (0 minted) | v4 mainnet | None: on-chain admin only, no app action |
| guild_contributor | PLANNED | — | On first bounty paid |
| guild_voter | PLANNED | — | On 10th vote |
| guild_steward | PLANNED | — | Admin + community vote |
| guild_builder | PLANNED | — | Peer nomination |

## Auto-Mint Thresholds (for bot implementation)

```javascript
const AUTO_MINT_THRESHOLDS = {
  guild_voter: { action: "vote", count: 10, tier: "casual" },
  guild_contributor: { action: "bounty_paid", count: 1, tier: "helper" },
  guild_builder: { action: "pr_merged", count: 1, tier: "learner" },
};
```

When a user crosses a threshold, the bot announces:
"Congratulations! You earned a Voter badge (casual tier)! Check /badges"
