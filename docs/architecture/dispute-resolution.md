<!-- status: live
     verified: 2026-09-17 (SCOPED: the STATUS banner and §4's status rows; §1-§3 untouched.)
     verified: 2026-08-23 (§4 rewritten: it had cited the deprecated guild-escrow tree, whose line
     numbers no longer exist anywhere. §1-§3 are the UNCHANGED 2026-05-19 design exploration for a
     system that was never built, marked as such rather than coexisting with the live description
     as if both were true.)
     edited: 2026-10-11 (no re-verification: §0, the operator runbook for ruling a live dispute,
     moved out of this public file; operator procedures are kept privately. The cross-references to
     §0 below were re-pointed.)
     supersedes: none (edited in place; nothing else in docs/ covers this) -->

> ⚠️ **STATUS + SCOPE — corrected 2026-08-23, re-cut 2026-09-17 for Wave B; read this before
> anything else in the file.**
> This doc previously said disputes are BUG-7-blocked and MOCK-ONLY. That was true of the
> retired PUSH blueprint and is **no longer true**: the PULL redesign (cutover 2026-08-17)
> fixed BUG-7 and H1 at the root — `approve_and_release` and `auto_resolve_dispute` return
> `void` and credit entitlements INSIDE the component; nothing is ever handed to a caller to
> misroute — and the **Wave B** component (cutover 2026-09-13,
> `component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly`) carries that
> forward with a Proof-form `resolve_dispute`, an identity-bearing non-transferable arbiter
> badge and the L6(c) self-dealing guard. The PULL component `…cz468e` this banner used to
> name is retired in place. The dispute UI has been compiled **ON** since 2026-08-29
> (`NEXT_PUBLIC_FEATURE_DISPUTES=true`; the deploy gate `scripts/launch-check.sh` now FAILS a
> build with it off) — and `raise_dispute` / `resolve_dispute` are PUBLIC methods on a LIVE
> mainnet component either way, reachable by anyone who builds the manifest themselves. **The
> operator procedure for the one path this doc previously described as unbuilt, a human arbiter
> ruling a real dispute, is kept privately (§0); that path has been exercised once on the live
> component (2026-09-14, per [`STATE.md`](../../STATE.md)).** §1-§3 are kept as historical
> design record (see the banner before §1) — do not read anything past that banner as
> describing what actually shipped.
>
> Operator files this doc cites — the deploy gate (`scripts/launch-check.sh`), the cron scripts
> `scripts/escrow-drift-watch.mjs` and `scripts/keeper.mjs`, and `docs/DESIGN-REVIEW-2027.md` —
> are kept in the private operations repository. They are named so the reasoning can be
> followed; what a reader here can check directly is `guild-app/scripts/arbiter-harness.mjs`,
> the blueprint's `lib.rs`, and the chain itself.

# Guild Dispute Resolution System

---

## 0. Operator runbook

Operator procedures are kept privately.

---

> ⚠️ **NOTHING FROM HERE TO §4 DESCRIBES WHAT SHIPPED.** §1-§3 are the ORIGINAL 2026-05-19
> design exploration, kept verbatim as a historical record (the docs rule: "archiving is not
> tidying — it destroys the sole record"; being old is not being superseded). None of the
> tiered dispute ladder, arbitrator reputation pool, Telegram notification flow, Dispute
> Prevention Score, milestone escrows, or Kleros bridge below was ever built. The actual
> system that shipped is summarised in §4 below: one binary dispute state, one arbiter ruling
> OR one public time-gated default — no tiers, no panels, no scoring. Read on only for the
> design history, never as an instruction.

## 1. Industry Research: How Existing Platforms Handle Disputes

### 1.1 Upwork

**Process:** Structured 5-step escalation ladder.

| Step | Actor | Timeline | Outcome |
|------|-------|----------|---------|
| 1. Filing | Either party | Immediate | Dispute opened |
| 2. Response | Opposing party | 5 calendar days | Agreement or escalation |
| 3. Mediation | Upwork specialist | ~2 business days | Non-binding recommendation |
| 4. Accept/Decline | Both parties | 2 calendar days | Accept or escalate |
| 5. Final Resolution | Upwork binding decision | ~2 business days | Funds disbursed |

**Key mechanics:**
- 14-day auto-release to worker if poster doesn't respond (worker-friendly default)
- Human mediators make non-binding recommendations first
- No separate fee for dispute resolution (included in 15-20% platform take)
- Hourly contracts use Work Diary (screenshot monitoring) as evidence
- Total timeline: 11-15 calendar days

**Takeaways for Guild:**
- Auto-release on poster timeout is essential
- 5-day response windows prevent indefinite delays
- Non-binding mediation resolves most disputes without formal arbitration

### 1.2 Kleros (Decentralized Court)

**Process:** Multi-round Schelling point game with staked jurors.

| Phase | Mechanism | Duration |
|-------|-----------|----------|
| Case creation | Dispute submitted with evidence + question | Immediate |
| Juror drawing | Random PNK token selection, proportional to stake | ~1 day |
| Evidence period | Both parties submit evidence | 3-7 days |
| Voting period | Hidden commit-reveal voting | 2-3 days |
| Reveal period | Votes revealed, majority wins | 1-2 days |
| Appeal period | Losing party can appeal (doubles jurors) | 3 days |

**Key mechanics:**
- 1,900+ disputes processed lifetime, 170+ integration partners
- Jurors stake PNK tokens (min 1,000-1,600 PNK, ~$41-67)
- Jurors voting against majority get slashed; majority voters earn rewards
- Appeals double juror count: 3 → 7 → 15 → 31...
- No platform fee — all fees go to jurors
- ~7.37% staking APY for active jurors
- Final appeal goes to all staked PNK holders (general court)

**Takeaways for Guild:**
- Schelling point works best for binary, specification-based disputes
- Doubling jurors on appeal makes manipulation exponentially expensive
- Guild should structure tasks with clear pass/fail criteria to work with this model
- Can integrate as external Tier 4 escalation

### 1.3 Aragon Court

**Status: Defunct as of late 2024.** Aragon Association dissolved, ANT tokens redeemable for ETH at 0.0025376 per ANT. Not a viable integration target.

**Historical model:**
- Guardians staked ANT tokens, same Schelling point game as Kleros
- "Optimistic governance" — proposals assumed valid unless challenged
- DAO-native, governance-focused disputes

**Takeaway:** The optimistic model (auto-approve unless challenged) is worth adopting for low-risk tasks.

### 1.4 OpenSea / NFT Marketplaces

**Process:** Primarily customer support-driven for off-chain disputes. On-chain trades are atomic (Seaport protocol) — either both sides settle or nothing happens.

**Key mechanics:**
- Atomic settlement eliminates most escrow disputes entirely
- Off-chain disputes (stolen NFTs, counterfeit collections) handled by centralized support team
- OpenSea can freeze/delist assets but cannot reverse on-chain trades
- Seaport is fully decentralized with no owner/upgradeability

**Takeaway:** Atomic settlement doesn't apply to task marketplaces (asynchronous delivery), but the principle of clear on-chain finality is important. Once an escrow ruling is executed, it should be irreversible.

### 1.5 eBay

**Process:** Buyer/seller protection with structured evidence and auto-escalation.

| Step | Timeline | Outcome |
|------|----------|---------|
| 1. Open case | Immediate | Seller notified |
| 2. Seller response | 3 business days | Resolve or escalate |
| 3. eBay review | If unresolved after step 2 | eBay decides |
| 4. Appeal | 30 days after resolution | Re-review possible |

**Key mechanics:**
- **Money Back Guarantee** covers most purchases automatically
- Evidence-based: tracking numbers, delivery confirmation, photos
- Automated resolution for clear-cut cases (e.g., item not received + no tracking)
- Human review for subjective disputes (item not as described)
- Seller ratings directly affected by dispute outcomes
- Repeat offenders face progressive penalties (fee increases, restrictions, suspension)

**Takeaway:** Auto-resolution for clear-cut cases is powerful. Guild should auto-resolve when objective criteria (tests pass, code compiles, deadline met) can determine the outcome.

---

## 2. Guild Dispute System Design

### 2.1 Tier 1: Auto-Resolution (Prevent Disputes Before They Happen)

Auto-resolution eliminates disputes by making outcomes deterministic through objective criteria.

#### 1. Clear Deliverables Requirement

Every task must specify **acceptance criteria** at creation time:

```typescript
interface AcceptanceCriteria {
  checklist: string[];           // "Landing page responsive at 768px"
  automated_gates?: AutoGate[]; // Code compilation, test pass, coverage
  quality_threshold?: number;   // Minimum quality score (0-100)
}
```

Tasks without acceptance criteria receive a lower Dispute Prevention Score (see Section 3).

#### 2. Automated Checks (Code Tasks)

For tasks tagged with `code`, `testing`, or `security-audit`:

| Check | Trigger | Auto-Outcome |
|-------|---------|-------------|
| **Compilation** | `bun run build` succeeds | Pass gate |
| **Test suite** | `bun run test` passes | Pass gate |
| **Coverage threshold** | Coverage ≥ task-specified minimum | Pass gate |
| **Lint/format** | No lint errors | Pass gate |
| **Type check** | `tsc --noEmit` passes | Pass gate |

If all automated gates pass, the submission is **pre-approved** — the poster must provide specific objection to override.

#### 3. Deadline Enforcement

```
Task assigned ──[start_timeout: 7 days]──→ No submission? Auto-release claim
                                           Worker rep: -10 (task_abandoned)
                                           Task returns to "open"

Task submitted ──[review_timeout: varies]──→ No response? Auto-release to worker
                                             (Upwork-style worker-friendly default)
```

**Review timeout by task value:**

| Task Value (XRD) | Review Period | Max Extensions |
|-------------------|--------------|----------------|
| < 50 | 7 days | 1 (+3 days) |
| 50-500 | 14 days | 2 (+7 days each) |
| 500-5,000 | 21 days | 2 (+14 days each) |
| > 5,000 | 30 days | 3 (+14 days each) |

#### 4. Milestone Gates

Each milestone in a milestone escrow is an independent escrow cycle:
- Its own submission, review, auto-release timer, and dispute capability
- A dispute on Milestone 3 does NOT block payment for completed Milestones 1-2
- Remaining unfunded milestones pause until disputes resolve

#### 5. Quality Scoring (AI-Powered)

Agent Reviewers can auto-score submissions:

```typescript
interface QualityScore {
  overall: number;         // 0-100
  completeness: number;    // All deliverables present?
  technical_quality: number; // Code quality, design quality
  specification_match: number; // Does it match acceptance criteria?
  flagged_issues: string[]; // Specific concerns
}
```

- Score ≥ 80: Auto-approve recommendation (poster can still override)
- Score 50-79: Manual review required
- Score < 50: Auto-flag for rejection with specific reasons

#### 6. Double-Blind Review

For tasks with `double_blind: true`:
- Reviewer cannot see who submitted the work
- Poster identity hidden from reviewer
- Reduces bias in quality assessment
- Particularly valuable for Agent Reviewer fairness

### 2.2 Tier 2: Simple Dispute Form (Standard Process)

When the poster rejects a submission, the formal dispute process begins.

#### Process Flow

```
POSTER rejects submission
    │
    ▼
[Dispute Created — status: "disputed"]
    │
    ├── Worker has 48 hours to respond with evidence
    │   └── Fields: counter-argument, evidence links, screenshots, proposed resolution
    │
    ├── Poster has 48 hours to counter-respond
    │   └── Fields: response to worker evidence, additional evidence
    │
    └── System evaluates:
        ├── If worker agrees with rejection → Refund to poster
        ├── If poster agrees with counter → Release to worker
        ├── If both agree on split → Execute split
        └── If no agreement → Escalate to Tier 3
```

#### Evidence Submission Format

```typescript
interface DisputeEvidence {
  party: "poster" | "worker";
  timestamp: number;
  reason: DisputeReason;
  description: string;          // Max 2000 chars
  evidence_links: string[];     // URLs to screenshots, repos, demos
  evidence_hashes: string[];    // IPFS hashes for immutable evidence
  proposed_resolution: ProposedResolution;
}

type DisputeReason =
  | "incomplete_work"
  | "does_not_match_spec"
  | "low_quality"
  | "scope_disagreement"
  | "communication_breakdown"
  | "deadline_missed"
  | "other";

type ProposedResolution =
  | { type: "full_refund" }
  | { type: "full_payment" }
  | { type: "split"; worker_pct: number; poster_pct: number }
  | { type: "rework"; additional_time_hours: number };
```

#### Timelines

| Event | Deadline | If Missed |
|-------|----------|-----------|
| Worker response | 48 hours | Auto-refund to poster |
| Poster counter | 48 hours | Auto-release to worker |
| Mutual agreement | 5 days total | Escalate to Tier 3 |

### 2.3 Tier 3: Mediation (Community Arbitration Panel)

Community-based arbitration using Guild's existing badge and reputation system.

#### Arbitrator Selection

```
Qualified Pool:
  • Reputation ≥ Builder level (201+ points)
  • Badge: "arbiter" milestone (5+ disputes previously arbitrated)
  • Not involved in the task (not poster, worker, or reviewer)
  • No prior disputes with either party in last 90 days

Selection:
  • 3 arbitrators randomly selected from qualified pool
  • Weighted by reputation score (higher rep = higher selection probability)
  • Each arbitrator has 7 days to submit their ruling
  • If an arbitrator doesn't respond, replacement is drawn
```

#### Arbitration Process

```
[Dispute Escalated to Tier 3]
    │
    ▼
[3 Arbitrators Selected — notified via Telegram bot + dashboard]
    │
    ├── Arbitrators receive:
    │   • Original task specification + acceptance criteria
    │   • Worker's submission + deliverable
    │   • All evidence from Tier 2
    │   • Communication history
    │
    ├── Each arbitrator independently submits:
    │   • Ruling: PayWorker / RefundPoster / Split(worker%, poster%)
    │   • Written reasoning (required, min 100 chars)
    │   • Confidence level (1-5)
    │
    └── Majority vote decides outcome
        • 3-0 unanimous: immediate execution
        • 2-1 split: execute majority ruling
        • If all 3 different: re-draw panel (once), then 50/50 split
```

#### On-Chain Execution

The winning ruling maps directly to the existing `DisputeRuling` enum in the Scrypto blueprint:

```rust
pub enum DisputeRuling {
    PayWorker,
    RefundPoster,
    Split(Decimal, Decimal),  // (worker_pct, poster_pct)
}
```

Executed via `resolve_dispute()` with the arbiter's Guild badge proof. Arbiter receives 10% of insurance vault as fee.

#### Arbitrator Incentives

| Action | Reputation | XRD |
|--------|-----------|-----|
| Arbitration completed (voted with majority) | +15 | 10% of insurance pool / 3 |
| Arbitration completed (voted with minority) | +5 | 10% of insurance pool / 3 |
| Arbitration declined/timed out | -10 | None |
| Written reasoning rated helpful by both parties | +25 bonus | None |

### 2.4 Tier 4: Custom Contracts & External Escalation

For complex or high-value tasks that exceed standard dispute resolution.

#### Custom Contract Terms

```typescript
interface CustomContract {
  id: string;
  task_id: number;
  version: number;
  
  // Parties
  poster_address: string;
  worker_address: string;
  
  // Terms
  acceptance_criteria: AcceptanceCriteria[];
  payment_schedule: PaymentMilestone[];
  penalties: Penalty[];
  dispute_escalation: EscalationPath;
  
  // Signatures
  poster_signature: string;    // Radix wallet signature
  worker_signature: string;    // Radix wallet signature
  signed_at: number;
  
  // Immutability
  terms_hash: string;          // SHA-256 of serialized terms
  on_chain_tx: string;         // TX that stored hash on Radix
}

interface Penalty {
  condition: string;           // "deadline_missed_by_7_days"
  action: "reduce_payment" | "increase_payment" | "cancel_task";
  amount_pct?: number;         // Percentage adjustment
}

interface EscalationPath {
  tier_1_auto: boolean;        // Use auto-resolution?
  tier_2_window_hours: number; // Custom dispute window
  tier_3_panel_size: number;   // 3, 5, or 7 arbitrators
  external_arbitration?: "kleros"; // External escalation
}
```

#### Kleros Integration (External Tier 4)

For disputes exceeding Guild's internal resolution capacity:

```
[Tier 3 fails or task value > 5,000 XRD]
    │
    ▼
[Create Kleros case]
    • Submit evidence package to Kleros
    • Specify "Guild Tasks" subcourt
    • Post arbitration fee deposit
    │
    ▼
[Kleros juror selection + voting]
    • 3+ jurors drawn from PNK stakers
    • Standard Kleros commit-reveal voting
    │
    ▼
[Kleros ruling returned to Guild]
    • Execute on-chain via GuildEscrow::resolve_dispute
    • Kleros ruling is final (no further Guild appeals)
```

---

## 3. Dispute Prevention Score

Calculate a task's dispute risk at creation time to inform escrow requirements and user warnings.

### Score Calculation

```typescript
interface DisputePreventionScore {
  score: number;        // 0-100
  risk_level: "low" | "medium" | "high";
  factors: ScoreFactor[];
  recommendations: string[];
}

interface ScoreFactor {
  name: string;
  points: number;
  met: boolean;
}

function calculateDisputePreventionScore(task: TaskCreationData): DisputePreventionScore {
  const factors: ScoreFactor[] = [
    {
      name: "Clear deliverables defined",
      points: 20,
      met: task.acceptance_criteria.length > 0
    },
    {
      name: "Automated acceptance criteria",
      points: 30,
      met: task.automated_gates !== undefined && task.automated_gates.length > 0
    },
    {
      name: "Milestone breakdown",
      points: 20,
      met: task.milestones !== undefined && task.milestones.length > 1
    },
    {
      name: "Deadline specified",
      points: 10,
      met: task.deadline !== undefined
    },
    {
      name: "Poster has good history",
      points: 10,
      met: task.poster_reputation >= 200 && task.poster_dispute_rate < 0.1
    },
    {
      name: "Worker has good history",
      points: 10,
      met: task.worker_reputation >= 200 && task.worker_dispute_rate < 0.1
    },
  ];

  const score = factors.filter(f => f.met).reduce((sum, f) => sum + f.points, 0);
  
  const risk_level = score >= 80 ? "low" : score >= 50 ? "medium" : "high";
  
  const recommendations = factors
    .filter(f => !f.met)
    .map(f => `Add: ${f.name} (+${f.points} safety points)`);

  return { score, risk_level, factors, recommendations };
}
```

### Risk Level Actions

| Risk Level | Score | Badge | Escrow Requirement |
|------------|-------|-------|-------------------|
| **Low** | 80-100 | Green | Standard (reward + 2% insurance) |
| **Medium** | 50-79 | Yellow | Standard + warning displayed |
| **High** | 0-49 | Red | Higher insurance (5%) + milestone required for >500 XRD |

### UI Display

```
┌──────────────────────────────────────┐
│  Dispute Prevention Score: 70/100    │
│  ████████████████░░░░  [MEDIUM RISK] │
│                                      │
│  ✅ Clear deliverables (+20)         │
│  ✅ Automated checks (+30)           │
│  ❌ No milestone breakdown (+20)     │
│  ✅ Deadline set (+10)               │
│  ❌ New poster, no history (+10)     │
│  ── Worker not yet assigned (+10)    │
│                                      │
│  💡 Add milestones to improve score  │
└──────────────────────────────────────┘
```

---

## 4. Existing Implementation Status

> Rewritten 2026-08-23 — the table below previously cited `escrow/scrypto/guild-escrow`,
> which is the **deprecated** blueprint tree; none of those line numbers exist in the live
> `guild-marketplace-escrow` blueprint, and the "Arbiter badge milestone" /
> `dispute_arbitrated` rep-points rows described a reputation-gated badge system that is not
> how the live arbiter badge works — it is a real, operator-held, supply-1, identity-bearing
> and (since Wave B) non-transferable NFT (`arbiter_badge_resource`), not something a user
> earns. Line-number cites below were re-pointed to content
> on 2026-09-17 — the numbers had drifted by ~700 lines since 2026-08-23.

### Live today

Operator scripts and records named in this table (the deploy gate, the drift watcher, the keeper,
`DESIGN-REVIEW-2027.md`) are kept in the private operations repository; see the banner at the top.

| Component | Location | Status |
|-----------|----------|--------|
| `DisputeRuling` enum (`PayWorker`, `RefundPoster`, `Split{worker_pct,poster_pct}`) | `escrow/scrypto/guild-marketplace-escrow/src/lib.rs`, `pub enum DisputeRuling` | ✅ on-chain, ordinal-pinned by `tests/unit/dispute-ruling-ordinal.test.ts` |
| `raise_dispute()` — poster (task receipt) or claiming worker (claimer badge) proves a `Proof`, flips `Submitted` → `Disputed`, pins window + default | `.../src/lib.rs`, `pub fn raise_dispute` | ✅ on-chain, PUBLIC — raised once for real (task 5) |
| `resolve_dispute()` — arbiter-ruled finalize, **Proof-form**, L6(c) worker-side guard | `.../src/lib.rs`, `pub fn resolve_dispute` | ✅ on-chain, PUBLIC (badge-gated) — ruled once for real (task 5) |
| `auto_resolve_dispute()` — permissionless default finalize after the task's pinned window | `.../src/lib.rs`, `pub fn auto_resolve_dispute` | ✅ on-chain, PUBLIC — never called on the live component |
| `raiseDisputeManifest`, `resolveDisputeManifest`, `autoResolveDisputeManifest` builders | `guild-app/src/lib/manifests.ts` | ✅ shape-verified (`manifest-abi-gate.test.ts`) |
| Operator resolver — the caller `resolveDisputeManifest` had none of, until now | `guild-app/scripts/arbiter-harness.mjs` | ✅ (P3-3a); the procedure for using it is kept privately |
| Dispute UI (submit/raise from the dashboard) | `guild-app/src/app/disputes/page.tsx` + task detail | ✅ compiled ON since 2026-08-29 (`NEXT_PUBLIC_FEATURE_DISPUTES=true`; `scripts/launch-check.sh` fails a build with it OFF) — `/disputes` served 200 on 2026-09-17 |
| Arbiter resolution UI / route | — | ⛔ does not exist — the operator harness listed above is the only caller (`DESIGN-REVIEW-2027.md` §23 AR5 is the decide-box) |
| Dispute-raised alert | `scripts/escrow-drift-watch.mjs` PASS 3 (chain-first, four stages raised → half → closing → lapsed); `scripts/keeper.mjs` (lapsed backstop); in-app `dispute_raised` (counterparty only, `escrow-confirm.ts`) | ✅ live since 2026-08-23 and seen running on the box 2026-09-17 — ≤30 min latency, ≥100 XRD to page, and it goes to the OPERATOR chat, not yet the arbiter channel. ⚠️ This row said "partial — only nagged after the window lapses" for a few hours on 2026-09-17; wrong, corrected the same day. |

### Never built (§1-§3's design, superseded by what actually shipped)

| Component | Note |
|-----------|------|
| Evidence submission UI/API, tiered dispute ladder (§2.1-§2.4) | The live blueprint is binary: `Disputed` → arbiter or auto-resolve. No tiers. |
| Arbitrator selection algorithm / reputation-gated pool | The live arbiter is one operator-held badge, not a selectable pool. |
| Dispute Prevention Score (§3) | Not built; no acceptance-criteria or automated-gate scoring exists. |
| Milestone escrow blueprint | Not built; the deployed blueprint is single-settlement per task. |
| Kleros integration bridge | Not built; no external arbitration path exists. |
| Custom contract builder UI | Not built. |
| Double-blind review system | Not built. |
