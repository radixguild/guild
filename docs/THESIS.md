<!-- status: proposal
     verified: 2026-10-06 (the banner's first bullet ONLY: it said BUG-7 was still open. The PULL
     cutover of 2026-08-17 closed it; the bullet now says so, and says why "trustless" stays
     banned regardless. Nothing else re-checked.)
     verified: 2026-08-23 (ONE addition: "The Ladder" section, the operator's 2026-08-23 positioning
     frame, recorded with its evidence. Measured this pass: Xi'an's undated status in the current
     primary roadmap page; Radix TVL ~$1.1-1.2M via a live DefiLlama query (matches this repo's
     figure); radixdlt-scrypto and babylon-node last-push dates read directly from the GitHub API
     (which FALSIFIED an agent claim that the node repo had been quiet over a year); and the
     honest-copy rule set, which has no rule capable of catching an engine-scope claim. The rung-3
     correction (Radix DAO engine custody, Foxie's Xi'an engine) is OPERATOR-ASSERTED and was NOT
     publicly verifiable — flagged inline as needing a citation before it becomes copy. Nothing
     else in this doc was re-derived; the 2026-08-15 corrections below still stand.
     Prior: 2026-08-15 (checked against origin/main, the live app copy rules and
     PROJECT-STATE.md. Reclassified live → proposal on this date, deliberately: the strategic
     argument holds, but three concrete tables here are FALSE against shipped reality and one is
     BANNED copy, so this doc must never be treated as an instruction or as source material for
     public copy. It is not `historical` — it is not a snapshot of an event, and the positioning
     argument is still the operating one. Corrections listed below; the body is left as written.)
     supersedes: none (pre-dates the header rule) -->

# The Guild Thesis

> ⚠️ **STRATEGY DOC — NOT A STATUS REPORT, AND NOT COPY SOURCE (marked 2026-08-15).**
> The argument (why coordination is the bottleneck, why Radix, why agents) is intact and still
> the operating thesis. These specifics are not:
> - 🔴 **"Trustless payment — Yes (escrow)"** in the comparison table, and **"trustless
>   payments"** in the bottom line, are **banned copy and factually false.** When this banner
>   was written, settlement returned funds via the *caller's* manifest (BUG-7), so payout
>   integrity depended on the app building an honest manifest. The PULL cutover of 2026-08-17
>   closed that: settlement now credits only the accounts pinned at claim and funding. The word
>   stays false all the same, because one operator-held arbiter rules every dispute and the
>   escrow's owner badge can change its settings. The live product says "on-chain escrow" and
>   is enforced by `guild-app/scripts/honest-copy.mjs`. **Do not lift a line from this doc into anything
>   public.**
> - 🔴 **The Newcomer → Master "Reputation Levels" table is the vestigial ladder.** The shipped
>   on-chain one is **member → elder**, and the point-gated task bands here exist nowhere in
>   code. `FEATURE-MAP.md` §"Cross-doc contradictions" #3 names fixing this framing as an
>   outstanding item — this note is that fix, in place.
> - ⚠️ **"Layer 3: Guild REST API (any language)"** describes the 44-endpoint bot API that was
>   **decided retiring**. The real agent path is `packages/agent-client`.
> - ⚠️ **The Flywheel phases and the 3-month success metrics did not happen on that timeline**
>   (Phase 1 "Bootstrap" is roughly where things stand: the loop is proven, the board is not yet
>   seeded, and seeding is **P5**, behind the PULL cutover). Nothing here is a commitment.

## Core Loop

Xi'an upgrade needs work → Work needs coordination →
Guild coordinates work → Guild earns trust →
Community adopts Guild → More work flows through →
Agents join → Scale beyond human capacity →
Radix grows faster than any chain with traditional dev coordination

## The Problem

Every blockchain faces the same bottleneck: coordinating development across a decentralized community. Discord threads get lost. Forum posts die. GitHub issues lack incentives. Nobody tracks who did what, or rewards consistent contributors.

Radix is approaching its most significant upgrade — Xi'an, bringing a new Radix Engine. This requires massive coordinated effort: testing, migration, documentation, tooling updates, security audits, and dApp compatibility. Without coordination infrastructure, this work happens slowly, unevenly, and invisibly.

## The Solution

The Guild is Radix's development coordination engine — a transparent, incentivized task marketplace where:

- **Ideas become proposals** (community governance with typed thresholds)
- **Proposals become tasks** (structured, scoped, bounty-attached)
- **Tasks become work** (claimed by qualified humans and agents)
- **Work becomes reputation** (on-chain badges, portable trust)
- **Reputation unlocks opportunity** (higher-value tasks, more trust)

## Why Now

1. Xi'an is coming — the work is real and urgent
2. AI agents are production-ready — they can do routine dev work today
3. Radix's asset-oriented architecture uniquely enables agent-safe operations
4. No other Radix project is building development coordination tooling
5. The community is actively discussing governance and agentic workflows

## Why Guild, Not GitHub/Notion/Discord

| Feature | GitHub Issues | Discord | Notion | Guild |
|---|---|---|---|---|
| On-chain reputation | No | No | No | Yes (badges) |
| Trustless payment | No | No | No | Yes (escrow) |
| Agent-native | No | No | No | Yes (SDK) |
| Governance voting | No | No | No | Yes (thresholds) |
| Wallet-based identity | No | No | No | Yes (ROLA) |
| Radix-native | No | No | No | Yes |

## The Ladder — where a user is headed (operator, 2026-08-23)

> **What this is.** The positioning record already said who the audience is (developers and AI
> agents, not retail) and what the promise is. It never said **where a user is headed**. This is
> that trajectory, stated by bigdev on 2026-08-23 and refined against the evidence the same day.
>
> ⚠️ **This doc is `status: proposal` and explicitly NOT COPY SOURCE.** The ladder is strategy.
> Before any rung becomes site copy it must clear `honest-copy.mjs` — and §"the gap in the gate"
> below records why that gate cannot currently catch the one rung most likely to overclaim.

**It is a proof ladder, not a marketing funnel.** Each rung is the evidence that earns the next.
You cannot credibly sell *"post the task, let's build it"* until you have done it to yourself.
Self-building is rung one not because it is easy, but because it is the only rung that needs
nobody's permission.

| # | Rung | Status |
|---|---|---|
| 1 | **The Guild builds itself** | Already the decided plan — `THESIS.md` Phase 1 (*"Post Guild development tasks ON the Guild"*) and **P5-1** (bigdev 2026-08-04: *"the first 50 tasks we plan are building the Guild"*). The ladder gives it a reason, not a new plan. |
| 2 | **The Guild dApp** | Live — radixguild.com. |
| 3 | **Radix Engine / Scrypto layer** | ⚠️ See the correction below — this rung changed on 2026-08-23. |
| 4 | **Grows with the network** | Deliberately NOT "Xi'an by date" — see the dependency note. |
| 5 | **Community + business projects** | Taxonomy already fixed (§9 task+project; `HOW-IT-WORKS.md` big engagements). |

### 🔄 Rung 3 — corrected by the operator, 2026-08-23

An earlier pass argued rung 3 was wrong on two grounds: that Radix Engine is core protocol built by
RDX Works and not a community surface, and that `THESIS.md:44` calls Xi'an *"bringing a new Radix
Engine"* — so engine-then-Xi'an double-counts one event as two rungs.

**The operator corrected this with ecosystem knowledge not present in this repo:**
- **The new Radix DAO will be the custodians of the engine, soon.**
- **Xi'an has a whole new engine, being built by Foxie** (already referenced in this doc's Phase 1
  as *"Foxie's proposal"*), **also Radix-DAO-managed when it launches.**

If that holds, rung 3 is coherent after all — and for a better reason than originally stated. A
DAO-custodied engine has a **real community contribution surface**, which is exactly what the Guild
exists to coordinate. The rung stops being "we help build core protocol" (a claim we cannot back)
and becomes "we coordinate contribution to an engine the community now custodies".

⚠️ **STATUS: OPERATOR-ASSERTED, NOT PUBLICLY VERIFIED.** A same-day search of primary sources found
no public statement of Radix DAO engine custodianship. That is not a contradiction — the operator
tracks this ecosystem closely and the repo does not — but it means **this rung needs a public
citation before it becomes user-facing copy.** Recorded as asserted, not laundered into fact.

### 🔗 THE CONNECTION NOBODY HAD DRAWN: one external event unlocks two things

**R2 — the publish decision — is already gated on "the RAC DAO goes live"** (sitting, 2026-08-22:
*"leave this til the RAC DAO goes live — just keep building for now"*). Rung 3 is now gated on the
Radix DAO taking engine custody. **If those are the same DAO, one external event unlocks both the
publish decision and the positioning story.** Worth confirming they are the same body, because it
turns two separate waits into one watch item — and makes "has the DAO gone live?" the single
highest-value external signal this project tracks.

### 📉 Rung 4 — why it is "grows with the network" and not "Xi'an"

Measured 2026-08-23, and the conclusion is narrower than it first looks:
- **Xi'an carries no date** in the freshest 2026 primary source (radixdlt.com's roadmap page) — the
  same non-committal framing it has had for years. A 2026 statement and a 2022 one are, on this
  point, the same statement.
- The **Dec 2026 Foundation funding cliff** for Gateway / Connect-Relay / Signaling is confirmed on
  both sides (this repo's LOCKED-5 and the Foundation's own April 2026 post).
- Radix chain TVL is **~$1.1–1.2M** (DefiLlama, live query) — which **matches** this repo's recorded
  figure, so that number is current, not stale.
- Public repos are quiet but **alive and not archived**: `radixdlt-scrypto` last pushed 2026-03-27,
  `babylon-node` 2026-06-01. ⚠️ An agent pass claimed the node repo had been quiet *"over a year"* —
  **false, checked directly against the GitHub API.** The dependency argument survives; the
  "repos are dead" framing does not, and would have been an overclaim in our own analysis.
- The January 2026 Radix strategy post reports **300k TPS on the Hyperscale branch** — real, dated
  progress, on a branch, with no ship date.

🔑 **The distinction that matters: nothing in this product is technically blocked on Xi'an.** The
escrow and app run on the Babylon-era engine today and no planned feature waits on sharding. **The
exposure is purely narrative.** Keep the ladder and the promise decoupled and the risk disappears —
which is why rung 4 is a direction, not a milestone we are visibly waiting on.

### 🔴 THE GAP IN THE GATE — a new overclaim class `honest-copy.mjs` cannot catch

*"The Guild helps build the Radix Engine"* **would not trip any existing rule.** Every rule in that
file was written **reactively**, after a specific false claim shipped. An engine-scope claim is a
class the gate has never seen, so it would pass CHECK 4 clean — the exact *"structurally cannot go
red"* failure mode the file's own header warns about.

**The lesson generalises beyond this rung: a new claim family needs its rule written BEFORE the copy
ships, not after it is caught.** A gate that only ever learns from its own past failures is always
one novel claim behind.

### 🥾 The dogfooding half — right direction, not yet true

The operator's steer that P6 infra should be *"for the guild users to decide, fund and action"* is
the right destination and is **not available today**:
- No binding vote exists. The project's own governance ladder requires **≥3 committed voters**
  before even an informal Telegram temp-check counts as signal.
- **No treasury exists**, and both named funding levers — the royalty dial and
  `forfeited_claim_bonds_vault` — are **owner-claimable only**.
- `honest-copy.mjs:343` **bans** "community controls / governance-controlled / no single operator"
  outright. Claiming users decide would be claiming rung-3 legitimacy on rung-0 machinery.
- ⚠️ A quiet collision worth noticing rather than drifting past: the **P6-2 row was written the same
  day** as this steer and already scopes it **`O+C`** — operator decides.

✅ **What IS honestly available now** is the P9 pattern already in live copy: **"Post the task —
let's build it."** Individual posting and funding is the mechanism that exists. Make P6 items
*visible and discussable* via the live `infra` working group as an explicitly non-binding signal,
while the operator decides and funds — which is what the framework already has scoped.

## The Flywheel

### Phase 1: Bootstrap (Now)
- Post Guild development tasks ON the Guild (dogfooding)
- Invite 5-10 known community devs
- Fund initial bounties with real XRD
- Run first governance vote (Foxie's proposal)

### Phase 2: Xi'an Coordination (Month 2-3)
- Post Xi'an migration tasks as bounties
- Testing tasks, documentation, tooling updates
- Partner with RDX Works for official task pipeline
- 20+ active contributors

### Phase 3: Agent Integration (Month 3-4)
- Publish Agent SDK to npm
- First agent completes a real task
- Agent reputation system live
- Partner with community agent infrastructure project

### Phase 4: Standard Infrastructure (Month 6+)
- All Radix community development flows through Guild
- Agents handle routine maintenance autonomously
- Humans focus on creative and strategic work
- Guild governance directs Radix community priorities

## Agent Evolution Timeline

### 2025: Code Assistance
- Agents review PRs, write tests, generate docs
- Human-in-loop for all decisions
- Guild: simple task marketplace

### 2026: Autonomous Development
- Agents implement features end-to-end
- Agent-to-agent code review
- Guild: full lifecycle with escrow

### 2027: Agent Teams
- Manager agents orchestrate specialists
- Competitive bidding on tasks
- Guild: agent marketplace with reputation economy

### 2028: Self-Improving Protocols
- Agents propose protocol upgrades
- Implement, test, deploy with human governance approval
- Guild: the coordination layer for protocol evolution

## Governance Parameters

| Proposal Type | Approval Threshold |
|---|---|
| Constitutional | ≥ 66% YES |
| Governance Process | ≥ 60% YES |
| Treasury / Budget | ≥ 50% YES |
| Executable | ≥ 50% YES |
| Signaling | ≥ 50% YES |

## Reputation Levels

| Level | Points | Unlocks |
|---|---|---|
| Newcomer | 0-50 | Easy tasks (1-10 XRD) |
| Contributor | 51-200 | Medium tasks (10-50 XRD) |
| Builder | 201-500 | Hard tasks (50-200 XRD) |
| Expert | 501-1000 | Expert tasks (200+ XRD) |
| Master | 1001+ | Governance weight, task creation, agent management |

## Technical Architecture

```
Layer 4: Agent SDK (any agent uses this)
Layer 3: Guild REST API (any language)
Layer 2: Guild Platform (tasks, escrow, reputation, governance)
Layer 1: Radix DLT (settlements, badges, access rules)
```

## Success Metrics (First 3 Months)

- 10+ active human contributors
- 2+ active agent contributors
- 50+ completed tasks
- 5+ governance votes
- 3+ Xi'an migration tasks completed
- Agent SDK published on npm
- Zero security incidents with escrowed funds

## The Bottom Line

The network that coordinates its own development fastest wins. Guild makes Radix the fastest-coordinating network in crypto by combining transparent governance, trustless payments, portable reputation, and agent-native infrastructure.

We are not building a tool. We are building the coordination layer for Radix's evolution.
