<!-- status: proposal
     verified: 2026-05-19 (the doc's own date and its last substantive commit. NOT
     re-verified on 2026-08-15: most of it is industry research (Upwork/Airbnb/Nexus Mutual)
     I cannot check from this repo, and the pooled-insurance model it proposes was never
     built. Deliberately NOT stamped today.)
     supersedes: none (pre-dates the header rule) -->

> ⚠️ **STATUS + SCOPE (added 2026-08-15).** The pooled/mutualised model below does not
> exist. What is live is far simpler: a per-task insurance vault alongside the reward, with
> `min_insurance_fraction` = **0.05 (5%)** on the deployed component — **not the 2% this doc
> uses** in its flow diagrams and pool math. It is a poster-paid premium, refunded to the
> poster when unused: `cancel_task` credits the poster reward **and** insurance, and on
> `auto_resolve_dispute` the insurance returns to the poster whole while only the reward
> splits (mainnet-measured 0.5 / 0.55 on a 1.0 + 0.05 task). Its stated dependency,
> `GuildEscrow`, is the **deprecated** blueprint. Parameter ground truth:
> `ESCROW-PARAMETER-SHEET.md`; live values: `ESCROW-ADDRESSES.md`.

# Guild Insurance Model

> **Version:** 1.0
> **Date:** 2026-05-19
> **Status:** Architecture Design
> **Dependencies:** GuildEscrow blueprint, reputation system, dispute resolution system

---

## 1. Industry Research: Insurance & Protection Models

### 1.1 Upwork Payment Protection

**How it works:**
- **Fixed-price contracts:** Funds held in licensed escrow. Worker protected by 14-day auto-release if client doesn't respond. Client protected because funds aren't released until they approve.
- **Hourly contracts:** "Payment Protection" guarantees payment for hours tracked via Work Diary (screenshot monitoring). Hours with sufficient activity screenshots are protected regardless of client satisfaction.
- **Dispute coverage:** Mediation and arbitration costs are absorbed by the platform (included in 15-20% service fee).
- **No separate insurance product** — protection is built into the escrow and fee structure.

**Funding model:** Platform takes 5% from client + 0-15% from freelancer. Total 15-20% take rate funds all protection mechanisms including dispute mediation.

**Key insight:** Upwork's insurance is invisible — users don't pay a separate premium. It's bundled into platform fees. This reduces friction and ensures universal coverage.

### 1.2 Airbnb Host Guarantee (AirCover)

**How it works:**
- **AirCover for Hosts:** Up to $3M in damage protection per incident, included free with every booking.
- **Coverage includes:** damage to property, deep cleaning costs, income loss during repairs, liability for guest injuries.
- **Claims process:** Host documents damage with photos within 14 days, Airbnb reviews and decides, payout comes from Airbnb's insurance pool.
- **Funded by:** Service fees (3% host fee + 14-16% guest fee) plus Airbnb's commercial insurance policies.

**Key insight:** Insurance pool is funded by a percentage of every transaction, not by individual premiums. High volume subsidizes rare claims.

### 1.3 DeFi Insurance Protocols

#### Nexus Mutual

- **Model:** Mutual insurance pool where members stake NXM tokens to underwrite coverage.
- **Coverage types:** Smart contract bugs, custodial risk, protocol hacks.
- **Pricing:** Dynamic premiums based on risk assessment (2-8% annually for smart contract cover).
- **Claims process:**
  1. Member submits claim with evidence.
  2. Claims assessors (NXM stakers) vote on validity.
  3. If approved, payout from mutual pool.
  4. If denied, member can appeal (Kleros-compatible).
- **Pool size:** Hundreds of millions in cover capacity.
- **Key mechanic:** Risk assessors stake against specific protocols. If a protocol is hacked, assessors lose their stake. This creates a market-based risk pricing mechanism.

**Relevance to Guild:** The risk assessment model (stakers pricing risk per-protocol) maps to Guild's Dispute Prevention Score — higher-risk tasks should cost more to insure.

#### InsurAce

- **Model:** Portfolio-based insurance with diversified risk pools.
- **Coverage:** Smart contract vulnerabilities, stablecoin de-pegging, cross-chain bridge failures.
- **Pricing:** Actuarial-style risk models with dynamic premiums.
- **Investment arm:** Deploys idle capital into DeFi yield protocols to generate returns, reducing premium costs.

**Relevance to Guild:** The concept of deploying idle insurance pool capital into yield protocols is directly applicable. Guild's insurance pool could earn yield on Radix DeFi while waiting for claims.

### 1.4 Kleros Escrow (Escrow-as-Insurance)

**How it works:**
- Kleros Escrow is a smart contract that holds funds between two parties.
- Either party can raise a dispute, which triggers Kleros arbitration.
- The escrow contract automatically executes the arbitration ruling.
- **Insurance element:** The arbitration itself acts as insurance — instead of an insurance pool paying out, the escrow funds are redistributed based on the ruling.
- **Cost:** Arbitration fees (paid by losing party) serve as the "premium."

**Key insight:** Escrow IS the insurance when combined with fair arbitration. The insurance pool is the escrow vault itself. This is exactly Guild's current model — the `insurance_vault` in the GuildEscrow blueprint serves this dual purpose.

---

## 2. Guild Insurance Design

### 2.1 Option A: Platform Insurance Fund

```
Every completed task:
    reward_xrd × INSURANCE_RATE (currently 2%)
    ──→ Platform Insurance Pool (on-chain vault)

Pool covers:
    • Disputed work where arbitration results in split
    • Failed escrow transactions (component bugs)
    • Poster abandonment edge cases
    • Platform-caused failures

Pool governance:
    • DAO vote required for payouts > 500 XRD
    • Emergency payouts by Elder/Steward for < 500 XRD
    • Quarterly reports on pool health
```

**Pros:**
- Simple, universal coverage
- Scales with platform volume
- No individual opt-in needed

**Cons:**
- Small pool initially (2% of low volume = tiny fund)
- Moral hazard: users may be less careful knowing insurance exists
- Pool depletion risk if dispute rate is high

**Financial Model:**

| Monthly GMV (XRD) | Insurance Income (2%) | Sustainable Monthly Claims |
|--------------------|-----------------------|---------------------------|
| 10,000 | 200 | ~1-2 small claims |
| 100,000 | 2,000 | ~5-10 claims |
| 1,000,000 | 20,000 | ~50+ claims |

### 2.2 Option B: Stake-Based Insurance

```
High-value tasks (>100 XRD):
    Poster stakes: 10% of task value (refundable)
    Worker stakes: 5% of task value (refundable)

    If task completes normally:
        Both stakes returned in full

    If dispute resolved:
        Bad-faith party loses stake → goes to other party
        Good-faith party keeps stake + receives other's

    If arbitration inconclusive (split ruling):
        Both stakes returned minus arbitration fee
```

**Pros:**
- Creates skin in the game for both parties
- Self-funding — no platform pool needed
- Strongly discourages bad-faith behavior and frivolous disputes

**Cons:**
- Higher barrier to entry (workers need capital to stake)
- Disproportionately affects newcomers and low-capital workers
- Complex UX (users must understand staking)

### 2.3 Option C: Reputation-Based Coverage

```
Coverage tiers by reputation level:

    Master (1001+ rep):
        • Auto-coverage up to 500 XRD per task
        • If disputed, platform covers worker while investigating
        • Instant access to premium tasks

    Expert (501-1000 rep):
        • Auto-coverage up to 200 XRD per task
        • 24h expedited dispute resolution

    Builder (201-500 rep):
        • Auto-coverage up to 50 XRD per task
        • Standard dispute resolution

    Contributor (51-200 rep):
        • No auto-coverage
        • Standard dispute resolution

    Newcomer (0-50 rep):
        • No coverage
        • Extended review periods
```

**Pros:**
- Rewards experienced, reliable contributors
- No capital requirement from workers
- Builds trust and loyalty

**Cons:**
- No coverage for newcomers (cold start problem)
- Platform bears all risk for covered users
- Could be exploited by high-rep users who turn bad-faith

### 2.4 Recommended: Hybrid Model

Combine all three approaches into a layered insurance system:

```
┌──────────────────────────────────────────────────────┐
│                   LAYER 1: BASE INSURANCE             │
│                                                       │
│  Source: 1% platform fee on every completed task      │
│  Coverage: All tasks, automatic                       │
│  Managed by: DAO governance vote                      │
│  Purpose: Cover platform-caused failures,             │
│           incomplete arbitrations, edge cases          │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│                   LAYER 2: TASK-LEVEL INSURANCE        │
│                                                       │
│  Source: Insurance vault in each GuildEscrow (2%)     │
│  Coverage: Individual task disputes                   │
│  Already built: insurance_vault in Scrypto blueprint  │
│  Purpose: Fund arbitration fees, cover split rulings  │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│              LAYER 3: OPTIONAL STAKE (HIGH VALUE)     │
│                                                       │
│  Trigger: Tasks > 500 XRD                            │
│  Poster stake: 10% of task value                     │
│  Worker stake: 5% of task value (waived for Expert+) │
│  Purpose: Align incentives on large tasks             │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│             LAYER 4: REPUTATION COVERAGE              │
│                                                       │
│  Builder+: Covered up to 50 XRD per task             │
│  Expert+: Covered up to 200 XRD per task             │
│  Master+: Covered up to 500 XRD per task             │
│  Source: Funded from Layer 1 pool                     │
│  Purpose: Protect experienced contributors            │
└──────────────────────────────────────────────────────┘
```

### Fund Flow Diagram

```
Task Completed (100 XRD example):
    │
    ├── Worker receives: 97 XRD (reward minus insurance)
    │
    ├── Insurance vault: 2 XRD (per-task, stays in escrow component)
    │   └── Used for: arbitration fees if disputed
    │       └── Remainder: flows to platform pool after task finalizes
    │
    └── Platform fee: 1 XRD
        └── Flows to: Platform Insurance Pool
            └── Used for: reputation coverage, edge cases, governance-approved payouts
```

---

## 3. Insurance Pool Management

### 3.1 On-Chain Pool Component

```rust
// Conceptual design — not yet implemented
struct InsurancePool {
    /// Main insurance vault
    pool_vault: Vault,
    /// Total claims paid out
    total_claims_paid: Decimal,
    /// Total premiums collected
    total_premiums_collected: Decimal,
    /// Current coverage commitments
    active_coverage: HashMap<String, Decimal>,
    /// Governance badge for DAO-controlled payouts
    governance_badge: ResourceAddress,
}
```

### 3.2 Payout Rules

| Scenario | Payout Source | Amount | Approval |
|----------|-------------|--------|----------|
| Arbitration split ruling | Task insurance vault | Difference between split and original amounts | Automatic (on-chain) |
| Poster abandonment (auto-release) | No payout needed | Worker gets full reward via auto-release | Automatic (epoch-based) |
| Platform component bug | Platform pool | Up to full task value | DAO vote |
| Reputation coverage claim | Platform pool | Up to coverage tier limit | Elder/Steward review |
| Mass incident (critical bug) | Platform pool + emergency reserve | Case-by-case | Emergency DAO vote |

### 3.3 Dispute Prevention Score Impact on Insurance

The Dispute Prevention Score (from `dispute-resolution.md`) affects insurance costs:

| Risk Level | Score | Insurance Rate | Stake Required |
|------------|-------|---------------|----------------|
| Low | 80-100 | 1% (discounted) | None |
| Medium | 50-79 | 2% (standard) | None |
| High | 0-49 | 5% (surcharge) | Yes, 10% of task value |

This creates a financial incentive for posters to define clear deliverables and acceptance criteria.

---

## 4. Yield Generation on Idle Insurance Capital

### 4.1 Strategy

Insurance pools hold capital that's rarely used (target: <10% claim rate). Idle capital can generate yield:

```
Platform Insurance Pool
    │
    ├── 70% deployed to Radix DeFi lending (target 5-12% APY)
    │   └── Candidates: CaviarNine, Ociswap, or other Radix DeFi protocols
    │
    ├── 20% liquid reserve (instant claim coverage)
    │
    └── 10% XRD staking (validator staking rewards)
```

### 4.2 Risk Management

- **Maximum deployment:** 70% of pool to yield (30% always liquid)
- **Protocol diversification:** No more than 30% of deployed capital in any single DeFi protocol
- **Withdrawal latency:** Must be able to liquidate deployed capital within 48 hours
- **Yield usage:** 50% compounds back to pool, 50% reduces insurance rates for high-rep users

---

## 5. Price Volatility Protection

### 5.1 The XRD Volatility Problem

XRD has experienced 99.8% decline from ATH. A 30-day task could see 2x price swings.

### 5.2 Mitigation Strategies

| Strategy | Implementation | Status |
|----------|---------------|--------|
| **Stablecoin escrow** | Accept bridged USDC/USDT via Hyperlane | Future |
| **Over-collateralization** | Fund 120-150% of task value in XRD | Future |
| **Price lock** | Record XRD/USD at creation, adjust at release | Future |
| **Volatility buffer** | Auto-add 10-20% buffer for XRD-denominated tasks | Future |
| **Short duration preference** | Recommend tasks < 7 days for XRD-only payment | Current (advisory) |

### 5.3 Recommended Default

```
IF stablecoin available on Radix:
    Default to USDC escrow
    Display prices in USD
    Settle in USDC

ELSE (current state):
    Denominate in XRD
    Recommend short task durations
    Display volatility warning for tasks > 7 days
    Optional: poster adds 15% volatility buffer
```

---

## 6. Existing Implementation Status

### Already Built

| Component | Location | Details |
|-----------|----------|---------|
| `INSURANCE_RATE = 0.02` | `guild-app/src/lib/marketplace.ts:19` | 2% insurance rate constant |
| `insurance_vault` | `escrow/scrypto/guild-escrow/src/lib.rs:143` | On-chain vault for insurance XRD |
| `insurance_fee_xrd` field | `guild-app/src/lib/types.ts:43` | Task type includes insurance amount |
| Insurance display in UI | `guild-app/src/app/tasks/[id]/page.tsx` | Shows insurance fee on task detail |
| Insurance calculation | `guild-app/src/app/tasks/new/page.tsx` | `reward × INSURANCE_RATE` |
| Arbiter fee (10% of insurance) | `escrow/scrypto/guild-escrow/src/lib.rs:356` | Paid from insurance vault on dispute resolution |

### Needs Building

| Component | Priority | Effort |
|-----------|----------|--------|
| Platform Insurance Pool component | High | Large |
| Reputation-based coverage tiers | Medium | Medium |
| Stake requirement for high-value tasks | Medium | Medium |
| Dispute Prevention Score → insurance rate adjustment | Medium | Small |
| Yield deployment strategy | Low | Large |
| Stablecoin escrow support | Low | Large (depends on Radix ecosystem) |
| Insurance pool governance UI | Low | Medium |
