<!-- status: proposal
     verified: 2026-05-19 (the doc's own date and its last substantive commit. NOT
     re-verified on 2026-08-15 — none of this template system was built, so there is
     nothing to check it against. Deliberately NOT stamped today.)
     supersedes: none (pre-dates the header rule) -->

> ⚠️ **STATUS (added 2026-08-15): none of this is built.** There is no template library, no
> milestone escrow, no streaming escrow and no bounty-pool escrow. The live component
> supports exactly one shape: a single-deliverable task with one reward vault and one
> insurance vault. Its stated dependency, `GuildEscrow`, is the **deprecated** blueprint.
> Nothing here is an instruction.

# Guild Custom Contract Template System

> **Version:** 1.0
> **Date:** 2026-05-19
> **Status:** Architecture Design
> **Dependencies:** GuildEscrow blueprint, dispute resolution system, insurance model

---

## 1. Overview

Custom contracts allow posters and workers to agree on structured terms beyond the standard task model. This system serves high-value, complex, or multi-phase engagements where the default single-escrow model is insufficient.

---

## 2. Template Library

### 2.1 Standard Templates

Pre-built contract templates for common Guild task types:

| Template | Use Case | Default Terms | Escrow Type |
|----------|----------|---------------|-------------|
| **Simple Bounty** | One-shot task, single deliverable | Binary approve/reject, 72h review window | Direct escrow |
| **Code Contribution** | PR-based development work | Automated gates (compile + tests), 14-day review | Direct escrow |
| **Multi-Milestone Project** | Complex multi-phase work | Sequential milestones, per-milestone escrow | Milestone escrow |
| **Security Audit** | Smart contract or code audit | Structured report template, 21-day review | Direct escrow |
| **Design Work** | UI/UX, graphics, branding | Revision rounds (max 3), incremental approval | Milestone escrow |
| **Ongoing Retainer** | Continuous availability/support | Monthly rate, weekly check-ins, 30-day notice | Streaming |
| **Competition/Bounty Pool** | Open competition, best submission wins | Scoring rubric, multiple winners possible | Bounty pool |
| **Agent Task** | Automated agent execution | Automated acceptance criteria only, 24h review | Direct or x402 |

### 2.2 Template Data Structure

```typescript
interface ContractTemplate {
  id: string;
  name: string;
  description: string;
  version: number;
  
  // Default terms (user can customize)
  defaults: {
    escrow_type: "direct" | "milestone" | "streaming" | "bounty_pool" | "x402";
    review_window_hours: number;
    dispute_window_hours: number;
    max_revision_rounds: number;
    auto_gates: AutoGate[];
    insurance_rate: number;
    arbitration_tier: 1 | 2 | 3 | 4;
  };
  
  // Required fields the user must fill
  required_fields: TemplateField[];
  
  // Optional fields
  optional_fields: TemplateField[];
  
  // Conditions library (available if/then triggers)
  available_conditions: ConditionTemplate[];
}

interface TemplateField {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "checklist" | "address";
  description: string;
  validation?: ValidationRule;
}

interface AutoGate {
  type: "compile" | "test" | "coverage" | "lint" | "typecheck" | "custom";
  command?: string;       // For custom gates
  threshold?: number;     // For coverage gates
  description: string;
}
```

---

## 3. Contract Builder Interface

### 3.1 Builder Flow

```
Step 1: Choose Template
    ├── Browse template library
    ├── Preview default terms
    └── Select and customize

Step 2: Define Deliverables
    ├── Add acceptance criteria (checklist)
    ├── Add automated gates (for code tasks)
    ├── Set quality thresholds
    └── Attach reference materials (links, files)

Step 3: Payment Structure
    ├── Choose escrow type
    ├── Define milestones (if applicable)
    ├── Set payment amounts per milestone
    └── Configure insurance rate

Step 4: Conditions & Penalties
    ├── Add if/then conditions from library
    ├── Set deadline penalties
    ├── Define revision limits
    └── Configure escalation path

Step 5: Review & Sign
    ├── Full contract preview (human-readable)
    ├── Terms hash displayed
    ├── Poster signs with Radix wallet
    └── Worker reviews and counter-signs
```

### 3.2 Condition Builder (Smart Conditions)

Drag-and-drop conditions that trigger automatic actions:

```typescript
interface SmartCondition {
  id: string;
  trigger: ConditionTrigger;
  action: ConditionAction;
  description: string;  // Human-readable
}

type ConditionTrigger =
  | { type: "deadline_passed"; milestone_id?: string }
  | { type: "auto_gate_passed"; gate: string }
  | { type: "all_gates_passed" }
  | { type: "quality_score_above"; threshold: number }
  | { type: "quality_score_below"; threshold: number }
  | { type: "revision_count_exceeded"; max: number }
  | { type: "no_response"; party: "poster" | "worker"; hours: number }
  | { type: "milestone_approved"; milestone_id: string }
  | { type: "dispute_raised" }
  | { type: "mutual_agreement" };

type ConditionAction =
  | { type: "release_escrow"; percentage: number }
  | { type: "release_milestone"; milestone_id: string }
  | { type: "reduce_payment"; percentage: number }
  | { type: "extend_deadline"; hours: number }
  | { type: "escalate_dispute"; tier: number }
  | { type: "cancel_task"; refund_to: "poster" | "split" }
  | { type: "notify"; parties: ("poster" | "worker" | "arbitrator")[] }
  | { type: "auto_approve" }
  | { type: "pause_work" };
```

### 3.3 Example Conditions

| Trigger | Action | Use Case |
|---------|--------|----------|
| All automated gates pass | Release 50% of escrow | Code task: passing tests = partial payment |
| Poster no response for 14 days | Auto-approve and release full escrow | Prevent poster ghosting |
| Quality score ≥ 90 | Auto-approve submission | High-quality work fast-tracked |
| Quality score < 30 | Auto-reject with reasons | Clearly insufficient work |
| Deadline passed by 7 days | Reduce payment by 20% | Late delivery penalty |
| 3rd revision round reached | Freeze further revisions, escalate to arbitration | Prevent infinite revision loops |
| Milestone 2 approved | Release Milestone 2 escrow + fund Milestone 3 | Sequential milestone progression |

---

## 4. Signature Flow

### 4.1 Process

```
POSTER creates contract
    │
    ▼
[Contract serialized to canonical JSON]
    │
    ▼
[SHA-256 hash computed: terms_hash]
    │
    ▼
POSTER signs terms_hash with Radix wallet
    │
    ▼
[Contract + poster signature stored in DB]
    │
    ▼
WORKER receives contract for review
    │
    ├── Accept: Worker signs terms_hash with Radix wallet
    │   └── Both signatures stored, work can begin
    │
    ├── Propose changes: Worker submits counter-terms
    │   └── New version created, poster reviews
    │
    └── Decline: Contract cancelled, no obligations
```

### 4.2 Signature Verification

```typescript
interface ContractSignature {
  party: "poster" | "worker";
  address: string;          // Radix account address
  terms_hash: string;       // SHA-256 of contract terms
  signature: string;        // Radix wallet signature
  signed_at: number;        // Unix timestamp
  version: number;          // Contract version signed
}

// Both parties must sign the SAME version and terms_hash
function isContractActive(contract: CustomContract): boolean {
  return (
    contract.poster_signature !== null &&
    contract.worker_signature !== null &&
    contract.poster_signature.version === contract.worker_signature.version &&
    contract.poster_signature.terms_hash === contract.worker_signature.terms_hash
  );
}
```

---

## 5. On-Chain Immutability

### 5.1 Hash Storage on Radix

Contract terms are stored off-chain (DB) but their hash is committed on-chain for immutability:

```
Contract created and signed by both parties
    │
    ▼
[Compute terms_hash = SHA-256(canonical_json(terms))]
    │
    ▼
[Store hash on Radix via badge metadata or dedicated component]
    │
    ▼
[TX hash stored in contract record as proof of commitment]
```

### 5.2 Why Hash-on-Chain (Not Full Terms)

| Approach | Cost | Privacy | Verifiability |
|----------|------|---------|---------------|
| Full terms on-chain | High (storage costs) | None (public) | Full |
| **Hash on-chain** (recommended) | Low (32 bytes) | Terms are private | Can verify terms haven't changed |
| Fully off-chain | None | Full | No independent verification |

The hash approach provides immutability proof without exposing contract details publicly. Either party can verify the stored hash matches their copy of the terms.

### 5.3 Verification Flow

```
Dispute arises → Arbitrator requests contract terms
    │
    ▼
Both parties submit their copy of the terms
    │
    ▼
Arbitrator computes SHA-256 of each submission
    │
    ▼
Compare against on-chain hash
    │
    ├── Match: Terms are authentic, proceed with arbitration
    └── Mismatch: Tampered terms, bad-faith party identified
```

---

## 6. Contract Lifecycle

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  DRAFT   │────▶│  SIGNED  │────▶│  ACTIVE  │────▶│ COMPLETE │
│          │     │          │     │          │     │          │
│ Poster   │     │ Both     │     │ Work in  │     │ All      │
│ creates  │     │ parties  │     │ progress │     │ terms    │
│ terms    │     │ signed   │     │          │     │ fulfilled│
└──────────┘     └──────────┘     └──────────┘     └──────────┘
     │                │                │                │
     │                │                │                ▼
     ▼                ▼                ▼          ┌──────────┐
┌──────────┐    ┌──────────┐    ┌──────────┐    │ ARCHIVED │
│ CANCELLED│    │ EXPIRED  │    │ DISPUTED │    └──────────┘
│          │    │          │    │          │
│ Either   │    │ Unsigned │    │ Follows  │
│ party    │    │ for 30   │    │ dispute  │
│ before   │    │ days     │    │ resolution│
│ signing  │    │          │    │ tiers    │
└──────────┘    └──────────┘    └──────────┘
```

---

## 7. Integration with Existing Systems

### 7.1 How Custom Contracts Enhance Current Tasks

```
Standard Task (current):
    • Single escrow deposit
    • Binary approve/reject
    • 72h default dispute window
    • 2% insurance rate

Custom Contract Task:
    • Everything above, PLUS:
    • Structured acceptance criteria
    • Automated gates
    • Custom payment schedule
    • Penalty/bonus conditions
    • Both-party signatures
    • On-chain terms hash
```

### 7.2 Database Schema Extension

```typescript
// Extends existing Task type
interface TaskWithContract extends Task {
  contract_id: string | null;     // FK to custom_contracts table
  contract_version: number | null;
  contract_hash: string | null;   // SHA-256 of terms
  contract_hash_tx: string | null; // Radix TX that stored hash
}

// New table
interface CustomContractRecord {
  id: string;
  task_id: number;
  template_id: string;
  version: number;
  terms_json: string;           // Full contract terms (canonical JSON)
  terms_hash: string;           // SHA-256
  poster_address: string;
  worker_address: string | null;
  poster_signature: string | null;
  worker_signature: string | null;
  status: "draft" | "pending_worker" | "signed" | "active" | "complete" | "disputed" | "cancelled" | "expired";
  created_at: number;
  signed_at: number | null;
  completed_at: number | null;
}
```

---

## 8. Implementation Priority

| Component | Priority | Effort | Dependencies |
|-----------|----------|--------|-------------|
| Template data structures | High | Small | None |
| Simple Bounty template (default) | High | Small | Template structures |
| Code Contribution template | High | Small | Template structures |
| Contract signature flow (wallet signing) | High | Medium | Radix dApp Toolkit |
| On-chain hash storage | Medium | Medium | Scrypto component |
| Multi-Milestone template | Medium | Medium | Milestone escrow blueprint |
| Condition builder UI | Medium | Large | Template structures |
| Smart condition execution engine | Medium | Large | All conditions defined |
| Competition template | Low | Medium | Bounty pool escrow |
| Retainer/streaming template | Low | Large | Streaming escrow |
| Full visual contract builder | Low | Large | All templates stable |
