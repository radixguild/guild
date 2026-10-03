<!-- status: historical
     verified: 2026-05-19 (its own stated Version 1.0 date; purpose line says it was built as
     reference material for an infographic)
     supersedes: none (pre-dates the header rule)
     NOTE added 2026-08-15: not re-grounded against the current system. It carries no later
     correction notes despite three months of change (vNext escrow cutover 2026-06-14, the
     bot/ tombstone, working groups). For the live topology read docs/INFRASTRUCTURE.md
     (services/ports) and docs/ESCROW-ADDRESSES.md (deployed components). -->
# Guild System Architecture Map

> **Version:** 1.0
> **Date:** 2026-05-19
> **Purpose:** Full system architecture reference for infographic creation

---

## 1. User Types

### 1.1 Human Actors

| Role | Description | Key Actions | Badge Requirement |
|------|-------------|-------------|-------------------|
| **HUMAN POSTER** | Creates tasks, funds escrow, reviews submissions | Create task → Fund escrow → Review → Approve/Dispute | Any valid Guild badge |
| **HUMAN WORKER** | Browses tasks, claims, completes, gets paid | Browse → Claim → Submit deliverable → Receive XRD | Badge tier ≥ task difficulty |
| **HUMAN REVIEWER** | Third-party quality validation | Review submission → Score quality → Approve/Reject | Contributor+ (200+ rep) |
| **HUMAN VOTER** | Governance participation | Vote on proposals, parameter changes | Any valid Guild badge |
| **ARBITRATOR** | Resolves disputes (elected or staked) | Review evidence → Rule (PayWorker/RefundPoster/Split) | Elder or Steward badge |

### 1.2 Agent Actors

| Role | Description | Key Actions | Identity |
|------|-------------|-------------|----------|
| **AGENT WORKER** | Claims tasks via SDK/API, submits programmatically | `POST /api/tasks/:id/claim` → work → `POST /api/tasks/:id/submit` | AgentBadge NFT + JWT |
| **AGENT POSTER** | Creates tasks via SDK/API with vault-funded escrow | `POST /api/tasks` → fund from AgentVault | AgentBadge NFT + operator auth |
| **AGENT REVIEWER** | Auto-reviews via quality scoring algorithms | Receive webhook → Run quality checks → Score/Approve | AgentBadge NFT |

### 1.3 Composite Actors

| Role | Description | Key Actions | Structure |
|------|-------------|-------------|-----------|
| **WORK GROUP** | Team of humans/agents collaborating on a project | Coordinate subtasks, share deliverables, split rewards | Lead + Members, shared milestone tracking |
| **ARBITRATOR PANEL** | 3-member dispute resolution panel | Independent evidence review → Majority vote → Execute ruling | Random selection from qualified pool |

---

## 2. Payment Gateways

### 2.1 Direct Escrow (Current — Implemented)

```
Poster ──[XRD + Insurance]──→ GuildEscrow Component
                                    │
                                    ├── reward_vault (task bounty)
                                    └── insurance_vault (2% fee)
                                          │
                     ┌────────────────────┤
                     │                    │
              [Approve]              [Dispute]
                     │                    │
                     ▼                    ▼
              Worker receives      Arbiter resolves
              reward_vault         (PayWorker/RefundPoster/Split)
```

**Status:** Scrypto blueprint deployed (`escrow/scrypto/guild-escrow/src/lib.rs`)
**Constants:** `INSURANCE_RATE = 0.02`, `DEFAULT_DISPUTE_WINDOW_HOURS = 72`

### 2.2 Milestone Escrow (Designed — Not Yet Implemented)

```
Poster ──[Total XRD]──→ MilestoneEscrow Component
                              │
                    ┌─────────┼─────────┐─────────┐
                    ▼         ▼         ▼         ▼
                  M1 Vault  M2 Vault  M3 Vault  M4 Vault
                  ($200)    ($300)    ($300)    ($200)
                    │
              [Submit M1]
                    │
              [Approve M1] ──→ Release M1 Vault to Worker
                    │
              [Fund M2] ──→ Worker starts M2
```

**Design source:** `docs/research/escrow-patterns.md` Section B.5
**Rule:** Tasks >500 XRD require milestone decomposition

### 2.3 Time-Based Streaming (Future)

```
Poster ──[Stream Config]──→ StreamEscrow Component
                                  │
                           [flow_rate: X XRD/epoch]
                                  │
                            ┌─────┴─────┐
                            ▼           ▼
                      Continuous     Close Stream
                      payout to     (on completion
                      worker        or abandonment)
```

**Use case:** Retainer-style engagements, ongoing availability
**Reference:** Superfluid/Sablier patterns in `docs/research/escrow-patterns.md`

### 2.4 x402 Pay-Per-Action (Future)

```
Agent ──[HTTP Request]──→ Guild API
                              │
                        [HTTP 402 Response]
                        Payment-Required: XRD 0.5
                        Radix-Address: component_rdx1...
                              │
Agent ──[XRD Payment TX]──→ Radix Facilitator
                              │
                        [Payment Confirmed]
                              │
Agent ──[Retry with receipt]──→ Guild API ──→ [200 OK + Data]
```

**Use case:** Permissionless agent access, no registration needed
**Research:** `docs/research/x402-radix-integration.md`

### 2.5 Bounty Pool (Future)

```
Poster ──[Pool XRD]──→ BountyPool Component
                             │
                    ┌────────┼────────┐
                    ▼        ▼        ▼
                 Worker1  Worker2  Worker3
                 (30%)    (50%)    (20%)
                    │
              [All submit]
                    │
              [Score & Rank]
                    │
              [Distribute proportionally]
```

**Use case:** Open competitions, multi-contributor projects

---

## 3. Core System Components

### 3.1 Component Inventory

| Component | Tech | Location | Status |
|-----------|------|----------|--------|
| **Frontend (Dashboard)** | Next.js 16, React 19, Tailwind v4, shadcn/ui | `guild-app/` | ✅ Live |
| **Task API** | Next.js API routes | `guild-app/src/app/api/` | ✅ Live |
| **Bot** | Grammy (Telegram), Node.js, SQLite | `bot/` | ✅ Live |
| **Badge Manager** | Scrypto v4 (Rust) | `badge-manager/` | ✅ Deployed |
| **Escrow Blueprint** | Scrypto v4 (Rust) | `escrow/scrypto/guild-escrow/` | ✅ Deployed |
| **Agent client** | TypeScript | `packages/agent-client/` | ✅ Built (`@radix-guild/agent-client`) |
| **Reputation Engine** | TypeScript | `guild-app/src/lib/reputation.ts` | ✅ Live |
| **Incentive System** | TypeScript | `guild-app/src/lib/incentives.ts` | ✅ Live |
| **Proposal/Voting** | TypeScript | `guild-app/src/app/proposals/` | ✅ Live |

### 3.2 On-Chain Components (Radix Mainnet)

```
┌──────────────────────────────────────────────────────────────┐
│                     RADIX MAINNET (network_id: 1)            │
│                                                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐  │
│  │  Badge Manager   │  │  GuildEscrow    │  │ AgentVault  │  │
│  │  Component       │  │  Component(s)   │  │ (Future)    │  │
│  │                  │  │                  │  │             │  │
│  │  • public_mint   │  │  • create_task   │  │ • allocate  │  │
│  │  • mint_badge    │  │  • claim_task    │  │ • release   │  │
│  │  • update_tier   │  │  • submit_work   │  │ • pause     │  │
│  │  • update_xp     │  │  • approve_and_  │  │             │  │
│  │  • revoke_badge  │  │    release       │  │             │  │
│  │  • update_extra  │  │  • raise_dispute │  │             │  │
│  │    _data         │  │  • resolve_      │  │             │  │
│  │                  │  │    dispute       │  │             │  │
│  └─────────────────┘  └─────────────────┘  └─────────────┘  │
│                                                              │
│  Resources:                                                  │
│  • Guild Badge NFT: resource_rdx1n22rq94kh6ugwnrvc65m...    │
│  • Admin Badge: resource_rdx1tkkzwrttvsqrsylyf4nqt2f...     │
│  • XRD: resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx...          │
│  • Poster Receipt NFT (per-escrow, ephemeral)                │
│                                                              │
│  Gateway: https://mainnet.radixdlt.com                       │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Data Flow Diagrams

### 4.1 Task Lifecycle (Full Flow)

```
USER                  FRONTEND              API                 DATABASE            RADIX
 │                       │                   │                     │                  │
 │──[Connect Wallet]────▶│                   │                     │                  │
 │                       │──[ROLA Auth]─────▶│                     │                  │
 │                       │                   │                     │                  │
 │──[Create Task]───────▶│                   │                     │                  │
 │                       │──[Build Manifest]─│                     │                  │
 │                       │                   │                     │                  │
 │──[Sign TX in Wallet]──│─────────────────────────────────────────────────▶│         │
 │                       │                   │                     │        │         │
 │                       │                   │                     │  [GuildEscrow::  │
 │                       │                   │                     │   create_task]   │
 │                       │                   │                     │        │         │
 │                       │◀──[TX Hash + Component Address]─────────────────│         │
 │                       │                   │                     │                  │
 │                       │──[POST /api/tasks]▶│                    │                  │
 │                       │                   │──[INSERT task]─────▶│                  │
 │                       │                   │  (status: open,     │                  │
 │                       │                   │   escrow_component, │                  │
 │                       │                   │   escrow_tx_hash)   │                  │
 │                       │◀──[Task Created]──│                     │                  │
 │◀──[Success Toast]─────│                   │                     │                  │
```

### 4.2 Claim → Submit → Approve Flow

```
WORKER               FRONTEND              API                 DATABASE            RADIX
 │                       │                   │                     │                  │
 │──[Claim Task]────────▶│                   │                     │                  │
 │                       │──[Build claim_    │                     │                  │
 │                       │   task manifest]  │                     │                  │
 │──[Sign TX]───────────▶│────────────────────────────────────────────────▶│          │
 │                       │                   │                     │  [GuildEscrow::  │
 │                       │                   │                     │   claim_task     │
 │                       │                   │                     │   +badge proof]  │
 │                       │──[POST claim]────▶│──[UPDATE status]──▶│                  │
 │                       │                   │  assigned           │                  │
 │                       │                   │                     │                  │
 │──[Submit Work]───────▶│                   │                     │                  │
 │  (deliverable URL)    │──[POST submit]──▶│──[UPDATE status]──▶│                  │
 │                       │                   │  submitted          │                  │
 │                       │                   │                     │                  │
POSTER                   │                   │                     │                  │
 │──[Approve]───────────▶│                   │                     │                  │
 │                       │──[Build approve_  │                     │                  │
 │                       │   and_release     │                     │                  │
 │                       │   manifest]       │                     │                  │
 │──[Sign TX]───────────▶│────────────────────────────────────────────────▶│          │
 │                       │                   │                     │  [approve_and_   │
 │                       │                   │                     │   release →      │
 │                       │                   │                     │   XRD to worker] │
 │                       │──[POST approve]──▶│──[UPDATE status]──▶│                  │
 │                       │                   │  verified→paid      │                  │
```

### 4.3 Dispute Flow

```
POSTER/WORKER         FRONTEND              API                 DATABASE            RADIX
 │                       │                   │                     │                  │
 │──[Raise Dispute]─────▶│                   │                     │                  │
 │                       │──[POST dispute]──▶│──[UPDATE status    │                  │
 │                       │                   │  → disputed]───────▶│                  │
 │                       │                   │                     │  [raise_dispute] │
 │                       │                   │                     │                  │
 │   ┌───────────────────────────────────────┐                    │                  │
 │   │  EVIDENCE SUBMISSION WINDOW (48h+48h) │                    │                  │
 │   │  Worker: evidence, links, screenshots │                    │                  │
 │   │  Poster: counter-evidence             │                    │                  │
 │   └───────────────────────────────────────┘                    │                  │
 │                       │                   │                     │                  │
ARBITRATOR               │                   │                     │                  │
 │──[Review Evidence]───▶│                   │                     │                  │
 │──[Resolve Dispute]───▶│                   │                     │                  │
 │  (PayWorker/Refund/   │──[Build resolve   │                     │                  │
 │   Split)              │   manifest +      │                     │                  │
 │                       │   arbiter badge   │                     │                  │
 │──[Sign TX]───────────▶│   proof]─────────────────────────────────────▶│            │
 │                       │                   │                     │  [resolve_       │
 │                       │                   │                     │   dispute →      │
 │                       │                   │                     │   execute ruling │
 │                       │                   │                     │   + arbiter fee] │
```

### 4.4 Agent Interaction Flow

```
AI AGENT              AGENT SDK             GUILD API            DATABASE            RADIX
 │                       │                   │                     │                  │
 │──[Initialize]────────▶│                   │                     │                  │
 │  (AgentBadge NFT,     │                   │                     │                  │
 │   JWT credentials)    │                   │                     │                  │
 │                       │                   │                     │                  │
 │──[Browse Tasks]──────▶│──[GET /tasks?     │                     │                  │
 │                       │   skill_tags=code]▶│──[SELECT tasks]──▶│                  │
 │◀──[Matching Tasks]────│◀─────────────────│                     │                  │
 │                       │                   │                     │                  │
 │──[Score & Select]────▶│  (local AI        │                     │                  │
 │                       │   matching)       │                     │                  │
 │                       │                   │                     │                  │
 │──[Claim Task]────────▶│──[POST /tasks/    │                     │                  │
 │                       │   :id/claim]─────▶│──[UPDATE]──────────▶│                  │
 │                       │                   │                     │  [claim_task +   │
 │                       │                   │                     │   AgentBadge     │
 │                       │                   │                     │   proof]         │
 │                       │                   │                     │                  │
 │──[Do Work]───────────▶│  (execute task    │                     │                  │
 │                       │   locally)        │                     │                  │
 │                       │                   │                     │                  │
 │──[Submit]────────────▶│──[POST /tasks/    │                     │                  │
 │  (deliverable_hash)   │   :id/submit]────▶│──[UPDATE]──────────▶│                  │
```

---

## 5. Reputation System Map

```
┌──────────────────────────────────────────────────────────────────┐
│                    REPUTATION LEVELS                              │
│                                                                  │
│  Newcomer (0-50) → Contributor (51-200) → Builder (201-500)     │
│  → Expert (501-1000) → Master (1001+)                           │
│                                                                  │
│  POINT VALUES:                                                   │
│  • Task complete (base):  +10 × difficulty multiplier            │
│    easy=1×, medium=2×, hard=4×, expert=8×                       │
│  • Review accurate:       +5                                     │
│  • Review inaccurate:     -3                                     │
│  • Task abandoned:        -10                                    │
│  • Submission rejected:   -5                                     │
│  • Proposal vote:         +2                                     │
│  • Dispute arbitrated:    +15                                    │
│                                                                  │
│  DIFFICULTY GATES:                                               │
│  • Easy tasks:    Newcomer+                                      │
│  • Medium tasks:  Contributor+                                   │
│  • Hard tasks:    Builder+                                       │
│  • Expert tasks:  Expert+                                        │
│                                                                  │
│  BADGE MILESTONES:                                               │
│  first_task, ten_tasks, fifty_tasks, first_review,              │
│  streak_five, code_expert, design_expert, docs_expert,          │
│  security_expert, qa_expert, governor, arbiter                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 6. Technology Stack Map

```
┌─────────────────────────────────────────────────────────────────┐
│                        PRESENTATION LAYER                        │
│                                                                  │
│  Next.js 16 (App Router) + React 19 + TypeScript                │
│  Tailwind CSS v4 + shadcn/ui                                    │
│  Radix dApp Toolkit (wallet connection, TX signing)             │
│  Package Manager: bun                                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                        APPLICATION LAYER                         │
│                                                                  │
│  API Routes (Next.js)          Telegram Bot (Grammy)            │
│  Agent SDK (TypeScript)        Reputation Engine                │
│  Incentive System              Proposal/Voting System           │
│  Transaction Manifests         Gateway Client                   │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                        DATA LAYER                                │
│                                                                  │
│  SQLite (Bot)                  Radix Gateway API                │
│  In-memory state (proposals)   On-chain NFT metadata            │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                    BLOCKCHAIN LAYER (Radix Mainnet)              │
│                                                                  │
│  Badge Manager Component       GuildEscrow Blueprint            │
│  Guild Badge NFTs (resource)   Poster Receipt NFTs              │
│  Admin Badge (resource)        XRD (native token)               │
│  Gateway: https://mainnet.radixdlt.com                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. Integration Points

### External Services

| Service | Purpose | Integration |
|---------|---------|-------------|
| **Radix Gateway** | On-chain reads/writes | REST API (`gateway.ts`) |
| **Radix Wallet** | TX signing, auth | dApp Toolkit (ROLA) |
| **Telegram** | Bot interface | Grammy SDK (`bot/`) |
| **GitHub** | Issue/PR linking | `github_issue`, `github_pr` fields on Task |
| **IPFS** (Future) | Evidence storage | Content-addressed deliverable hashes |
| **Kleros** (Future) | External dispute escalation | Tier 4 arbitration |

### Internal Module Dependencies

```
manifests.ts ──→ config.ts (addresses)
api.ts ──→ constants.ts (API_URL), types.ts
reputation.ts ──→ incentives.ts (TaskDifficulty)
tasks/new/page.tsx ──→ manifests.ts, constants.ts (INSURANCE_RATE, BADGE_NFT)
tasks/[id]/page.tsx ──→ api.ts (fetchTask, claimTask, submitTask, approveTask, disputeTask)
                   ──→ manifests.ts (claimTaskManifest, approveAndReleaseManifest)
```
