<!-- status: live
     verified: 2026-10-02 (SCOPED: the three guild-public references only — the bot's SQLite
     line in §"What's Built vs What's Needed", the agent-badge-controller path, and the Related
     Projects row — re-checked against this repository's bot/ and blueprints/ trees. Nothing
     else re-checked.)
     verified: 2026-08-15 (the §"What's Built vs What's Needed" and §"Tier System" sections
     checked against origin/main and the live app; both were stale and are annotated in place.
     The 2026-07-31 transferable-badge warning further down was re-read and STANDS — do not
     remove it. The vision proper — the co-op model, the flywheel, the maxims — is aspiration by
     design and is not the kind of claim a freshness pass can verify; it is unchanged.)
     supersedes: none (pre-dates the header rule) -->

# The Guild — Product Vision

> North star document. Captures the complete Guild design as of 2026-05-25/26.
> All future sessions should reference this as the canonical product vision.
>
> ⚠️ **Read as a NORTH STAR, not a status report (marked 2026-08-15).** Most of what follows is
> designed, not shipped: of the six core primitives, **two are live** (the badge and the
> marketplace escrow) and four — TaskFundingCurve, GuildRegistry, GuildTreasury, GuildSettings —
> **do not exist**. The revenue-share flywheel that the co-op model rests on therefore has no
> implementation. `FEATURE-MAP.md` §"Cross-doc contradictions" #4 records the resulting live
> tension (co-op revenue-share economy vs the shipped "DAOs decide, the Guild builds" execution
> layer) as an open call, not a settled one.

---

## What The Guild Is

An on-chain developer cooperative on Radix.

Not a bounty board. Not a DAO with a token. A place where builders earn reputation, fund work collectively, share revenue, and publish reusable infrastructure for the Radix ecosystem.

The Guild exists because open-source contributors deserve ongoing compensation — not one-time payouts — and because the Radix ecosystem needs shared infrastructure that no single developer will build alone.

---

## Core Primitives (all Radix-native)

Every primitive is a Scrypto component deployed on Radix mainnet. No off-chain workarounds, no wrapped tokens, no bridges.

| # | Primitive | Purpose | Status |
|---|-----------|---------|--------|
| 1 | **Guild Badge NFT** | Public-mint membership NFT with on-badge reputation metadata (tier, XP) — transferable; soulbound would need a new resource | **Live on mainnet** |
| 2 | **GuildMarketplaceEscrow** | Task execution with insurance, disputes, multi-token support | **Built** — 1502 lines, 45 tests |
| 3 | **TaskFundingCurve** | Bonding curve crowdfunding for tasks (early funders rewarded) | Spec complete |
| 4 | **GuildRegistry** | Member registration, tier management, reputation tracking | Spec complete |
| 5 | **GuildTreasury** | On-chain revenue collection and distribution | Spec complete |
| 6 | **GuildSettings** | All parameters configurable, governance-controlled | Spec complete |

---

## The Flywheel

```
Join free
  → earn reputation through tasks
    → reputation unlocks revenue share
      → royalties on shipped components
        → fund new tasks via bonding curves
          → attract more builders
            → more components shipped
              → more royalties
                → cycle continues
```

The key insight: reputation is the currency that connects contribution to compensation. No governance token needed — reputation *is* the token, earned through work rather than sold or distributed as supply.

> ⚠️ **Non-transferability is a design goal, not a shipped property.** Reputation rides on the badge NFT as mutable `tier`/`xp` data (see *Incentive Layers* below), and the live badge resource `resource_rdx1ntr6ye…65e` has `withdrawer = AllowAll` with `withdrawer_updater = DenyAll` (verified on mainnet 2026-07-31). A badge — and the reputation recorded on it — can therefore be transferred, and that rule can never be tightened on this resource. Enforcing non-transferability requires minting a NEW badge resource that sets `withdraw_roles`, as `blueprints/agent-badge-controller/src/lib.rs:102` (folded into this repository from guild-public on 2026-08-14) already does. Until then it holds by guild policy only, which is how the live `/about` page states it.

---

## Incentive Layers

### Reputation
- Stored on-badge as NFT metadata (not in a separate ledger)
- Decays with inactivity — you must keep contributing
- Unlocks tier progression: **Apprentice → Journeyman → Master → GuildMaster**
- Each tier unlocks new capabilities (voting, revenue share, governance)

### Revenue Share
- Proportional to reputation-weighted contribution
- Distributed from GuildTreasury on a configurable schedule
- Higher tiers receive proportionally more per reputation point

### Component Royalties
- Perpetual percentage on every transaction using Guild-built components
- Flows to GuildTreasury, then distributed to contributors
- Creates long-term passive income for builders

### Bonding Curve Funding
- Anyone can fund tasks via TaskFundingCurve
- Early funders get better price (bonding curve mechanics)
- Market signals demand — popular tasks attract more funding naturally
- Refund model for tasks that don't reach funding threshold

### Tier System

⚠️ **Not the live vocabulary (noted 2026-08-15).** The shipped on-chain ladder is
**member → elder**; the metals ladder was killed in #129/#130 and the newcomer→master score
engine is vestigial. Trust tiers (`TASK-TERMS-DESIGN.md` §4) are the user-facing axis today.
The four names below are aspirational and appear in no code. See `FEATURE-MAP.md`
§"Cross-doc contradictions" #3.

| Tier | Unlock | Capabilities |
|------|--------|-------------|
| Apprentice | Join (free) | Take tasks, earn reputation |
| Journeyman | Reputation threshold | Revenue share, propose tasks |
| Master | Higher threshold | Vote on governance, review work |
| GuildMaster | Highest threshold | Set parameters, manage disputes |

---

## Manifest Template Architecture

This is the interaction model for how dApps (including Guild) expose functionality to wallets and agents.

- **dApps publish manifest templates in their dApp definition metadata** — not embedded in wallet code
- **Templates are external to wallets** — lightweight, discoverable, versioned
- **AI agents search dApp metadata to find and use templates** — no hardcoded integration needed
- **Guild publishes escrow/registry/treasury templates** as a template service
- **No embedded `manifests.ts`** — publish as discoverable template service instead

This architecture means any agent or wallet can interact with Guild without needing Guild-specific code. They discover templates from on-ledger metadata and construct transactions from them.

---

## Xi'an Architecture Principles

Xi'an (Radix's sharded execution layer) changes how you design transactions. Guild is designed for Xi'an from day one.

1. **UNBUNDLE EVERYTHING** — smallest atomic unit per transaction
2. **Shard locality over fee bidding** — keep related state on one shard
3. **Fees follow emissions, not demand** — no gas wars
4. **Each payment/transfer = separate tx** — never batch independent operations
5. **AgentAccount concept** — badge-owned accounts with agent-to-agent interaction and single-shard affinity

### Why this matters

On Xi'an, batching unrelated operations into one transaction forces cross-shard coordination, which is slower and more expensive. The Guild's atomic transaction design means each operation settles on its local shard without waiting for unrelated state.

---

## Agent Economy

AI agents are first-class Guild participants, not second-class API consumers.

### How agents interact with Guild
- **Discovery**: Agents find Guild tasks via dApp metadata (manifest templates)
- **Payments**: x402 Subintent flows via `rdx-cli@0.2.0` — HTTP 402 responses trigger payment
- **Identity**: Agent reputation tracked via Guild Badge metadata (same as humans)
- **Spam cost is per-action, not per-identity**: a 10 XRD claim bond (returned at `submit_task`, forfeited if the claim expires) prices claim-squatting. It does **not** bound identities — the Guild Badge is an unlimited public mint that presents no proof, so a second identity costs only the network fee. A personhood/rate-limit control is an open design item, not a shipped one (see the `claim_task` comment in `escrow/scrypto/guild-marketplace-escrow/src/lib.rs`).
- **No API keys**: x402 makes the Guild marketplace permissionless — any agent with XRD can participate

### Agent roles
| Role | Function |
|------|----------|
| **Risk Taker** | Accepts tasks, stakes reputation |
| **Fee Payer** | Sponsors transactions for other agents |
| **Facilitator** | Matches tasks to workers, earns commission |

### Design principles
- Agents and humans use the same primitives (badges, escrow, reputation)
- No special "agent mode" — the protocol doesn't distinguish
- Badge recall (Radix native) serves as agent kill switch if needed

---

## Settings (all configurable)

Every parameter in the Guild is a flexible setting stored in the **GuildSettings** component. All settings are governance-controlled — changes require proposals and voting.

### Escrow Settings
- Platform fee percentage
- Bond requirements (poster and worker)
- Minimum/maximum task values
- Dispute resolution timeouts
- Allowed payment tokens

### Bonding Curve Settings
- Curve type (linear, polynomial, sigmoid)
- Slope and intercept parameters
- Funding deadlines
- Refund model (full, partial, none)
- Minimum/maximum contribution limits

### Reputation Settings
- Points awarded per action type
- Decay rate and period
- Tier thresholds (Apprentice → GuildMaster)
- Bonus multipliers for high-quality work

### Treasury Settings
- Distribution frequency
- Share model (equal, reputation-weighted, hybrid)
- Reserve percentage
- Emergency withdrawal rules

### Governance Settings
- Proposal creation thresholds
- Voting periods
- Quorum requirements
- Timelock durations for parameter changes

### Membership Settings
- Deposit requirements (if any)
- Maximum member count
- Invite-only toggle
- Probation periods for new members

---

## Strategic Context

### The two races

**Race 1 — Standards/MVP**: Done. Tempo, Stripe, and x402 won. Payment rails are settled. Guild doesn't compete here — it uses what won.

**Race 2 — Production scale for AI traffic**: Wide open. Xi'an's sharding is designed for exactly this. The question is who builds the developer tooling and marketplace infrastructure on top.

### Guild's position

- **Radix has ZERO agent SDK coverage** — first mover opportunity for Guild
- **RWA/regulated finance is the safer wedge** — not competing with Solana on memecoins
- **Technical superiority doesn't guarantee adoption** — distribution matters. Guild must ship usable tools, not just elegant architecture
- **The cooperative model is the moat** — shared revenue creates loyalty that bounty boards can't match

---

## What's Built vs What's Needed

⛔ **Stale as of 2026-08-15 — three entries below are FALSE.** "Dashboard **stub** — Next.js 16
shell with routing" understates by a wide margin: radixguild.com is **live** and its money path
is **mainnet-proven end-to-end**. "Postgres persistence — replace SQLite in bot" is listed as
*needed*; the app has run on **Postgres + Drizzle** since the Phase-1 cutover (the SQLite that
remains is the Telegram bot's, folded into this repository's `bot/` on 2026-09-29). "Dashboard pages: join,
profile, leaderboard, treasury, settings, fund tasks" — profile, leaderboard and task funding all
ship; only `/treasury` and `/settings` are genuinely absent, and both wait on components that do
not exist. The rest of the *Needed* list is accurate: the four Scrypto components are still
unbuilt. Current status lives in `PROJECT-STATE.md`; current plan in `EXTERNAL-V1-FRAMEWORK.md` —
both kept in the private operations repository; [`STATE.md`](../STATE.md) is the public digest
of the first.

### Built
- **GuildMarketplaceEscrow** — 1502 lines, 45 tests, multi-token, disputes, insurance
- **Manifest builders** — transaction construction utilities
- **Discord/Telegram bot** — governance bot with Grammy
- **Dashboard stub** — Next.js 16 shell with routing
- **Auto-trader** — trading agent infrastructure
- **CI pipeline** — build, test, deploy

### Needed
- `manifest-marketplace.ts` — template publishing service
- Bot watcher rewrite — event-driven architecture
- Postgres persistence — replace SQLite in bot
- **GuildRegistry** component — member management on-ledger
- **GuildTreasury** component — revenue collection/distribution
- **TaskFundingCurve** component — bonding curve crowdfunding
- **GuildSettings** component — configurable parameters
- Dashboard pages: join, profile, leaderboard, treasury, settings, fund tasks

---

## Related Projects

| Project | Relevance |
|---------|-----------|
| **auto-trader-xrd** | Trading agents, deviation mode, agentic upgrade path |
| **hyperscale-rs** | Node infrastructure, Xi'an research |
| **defi-farmer** | Yield strategy agents |
| **guild-public** | Bot/watcher infrastructure until 2026-09-29, when its bot was folded into this repository's `bot/` |
| **Wallet Agent AI** (Linuxx) | Programmable wallet for AI agents on Radix |
| **rdx-cli / xStelea repos** | x402 payment flows, Subintent tooling, RAP V1 |
| **xrd-metal** | Gold/silver-backed tokens on Radix, integrates with Guild |

---

## Design Maxims

1. **Reputation over tokens** — no governance token, ever
2. **On-ledger over off-chain** — if it can be a component, it should be
3. **Templates over integrations** — publish manifest templates, don't build custom integrations
4. **Unbundle over batch** — one operation per transaction (Xi'an-ready)
5. **Cooperative over competitive** — shared revenue, not winner-take-all bounties
6. **Agents are members** — same primitives for humans and AI
7. **Settings over hardcoding** — every parameter configurable via governance

---

*Document authored: 2026-05-25/26*
*Maintained by: bigdevxrd*
