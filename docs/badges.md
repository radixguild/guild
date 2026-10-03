<!-- status: proposal
     verified: 2026-08-15 (checked against guild-app/src/lib/schemas.ts and
     docs/ASSET-REGISTRY.md — NONE of this shipped; see the banner)
     supersedes: none (pre-dates the header rule) -->

> ⚠️ **PROPOSAL — nothing in this file exists on chain or in the app (checked 2026-08-15).**
> `SCHEMAS` in `guild-app/src/lib/schemas.ts` holds exactly two collections, `guild_member`
> and `guild_role`. There is no milestone resource, no category-expert resource and no role
> resource; no "First Task" / "Code Expert" / "Arbiter" achievement badge has ever been
> minted, and the Badge-Manager mint flow described in §"Minting Flow" is not wired to any
> criteria detector. `TASK-TERMS-DESIGN.md` §4.1 lists achievement badges as explicitly
> **out of scope**. For what actually exists, read
> [`BADGE-SCHEMAS.md`](BADGE-SCHEMAS.md) and `ASSET-REGISTRY.md`.
>
> Two claims here would be wrong if built as written: the live **Guild Arbiter Badge** is a
> distinct supply-1 resource (`ESCROW-ADDRESSES.md:64`), not an earned "arbitrate 5 disputes"
> role badge; and §"Integration with Reputation" — "badges may unlock governance privileges
> or bounty access" — must not be shipped as fact, since the member badge is a public mint
> that gates nothing and is transferable. The shipped gate is the ledger-derived
> **trust tier** (`lib/trust.ts`), which owes nothing to this design.

# Badge NFT Design

## Badge Types

### Milestone Badges

| Badge | Criteria | Rarity |
|-------|----------|--------|
| First Task | Complete 1 task | Common |
| Ten Tasks | Complete 10 tasks | Uncommon |
| Fifty Tasks | Complete 50 tasks | Rare |
| First Review | Complete 1 peer review | Common |
| Streak Five | Complete 5 tasks consecutively without abandoning | Uncommon |

### Category Expert Badges

| Badge | Criteria | Rarity |
|-------|----------|--------|
| Code Expert | Complete 20 tasks tagged `code` | Rare |
| Design Expert | Complete 20 tasks tagged `design` | Rare |
| Docs Expert | Complete 20 tasks tagged `docs` | Rare |
| Security Expert | Complete 10 tasks tagged `security-audit` | Epic |
| QA Expert | Complete 15 tasks tagged `testing` | Rare |

### Role Badges

| Badge | Criteria | Rarity |
|-------|----------|--------|
| Arbiter | Successfully arbitrate 5 disputes | Epic |
| Mentor | Guide 3 newcomers through welcome task | Uncommon |
| Governor | Cast votes on 10 governance proposals | Uncommon |

---

## Badge Metadata Schema (Radix NFT)

Each badge is a non-fungible resource on Radix with the following metadata fields:

```json
{
  "badge_type": "milestone | category_expert | role",
  "badge_name": "first_task",
  "display_name": "First Task",
  "description": "Awarded for completing your first Guild task",
  "rarity": "common | uncommon | rare | epic | legendary",
  "image_url": "https://guild.radix.wiki/badges/first_task.png",
  "earned_at": 1747000000,
  "earned_by": "account_rdx1...",
  "criteria": {
    "type": "tasks_completed",
    "threshold": 1,
    "category": null
  },
  "version": 1
}
```

### Field Definitions

| Field | Type | Description |
|-------|------|-------------|
| `badge_type` | string | Category of badge |
| `badge_name` | string | Machine-readable identifier |
| `display_name` | string | Human-readable name |
| `description` | string | How the badge was earned |
| `rarity` | string | Rarity tier affecting visual treatment |
| `image_url` | string | Badge artwork URL |
| `earned_at` | number | Unix timestamp when awarded |
| `earned_by` | string | Radix account address of recipient |
| `criteria` | object | Machine-readable earning conditions |
| `version` | number | Schema version for future upgrades |

---

## On-Chain Resource Mapping

Badges are minted as **non-fungible resources** on the Radix network using the Badge Manager component.

### Architecture

```
Badge Manager Component
├── Resource: guild_badge_milestone
│   ├── NFT #1: first_task (account_rdx1abc...)
│   ├── NFT #2: ten_tasks (account_rdx1def...)
│   └── ...
├── Resource: guild_badge_category
│   ├── NFT #1: code_expert (account_rdx1abc...)
│   └── ...
└── Resource: guild_badge_role
    ├── NFT #1: arbiter (account_rdx1ghi...)
    └── ...
```

### Minting Flow

1. User completes criteria (e.g., finishes first task)
2. Bot/API detects milestone reached
3. Badge Manager mints NFT to user's account
4. Badge appears in user's Radix wallet and Guild profile
5. Leaderboard and profile page update to show new badge

### Integration with Reputation

- Badges are **visual proof** of achievements; reputation score is the **numeric measure**
- Badge ownership can be verified on-chain by any dApp
- Future: badges may unlock governance privileges or bounty access beyond reputation level
