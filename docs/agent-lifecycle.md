<!-- status: historical
     verified: 2026-10-02 (the `bot/*` note under the title and the RAP V1 reference ONLY: this repository's
     bot/ was re-read; it is the folded live bot and has no registerAgent or invite_codes)
     verified: 2026-09-15 (re-checked against the tree for catalogue P1-10 / task 73: the Path A register flow it
     documents was never built — see the banner under the title; previously claimed 'live', verified 2026-08-14 at fold time)
     supersedes: none (folded from guild-public 2026-08-14 — docs/runbooks/agent-badge-*.md already linked ../agent-lifecycle.md, dangling here until this fold) -->
# Guild Agent Lifecycle

> ⛔ **NOT THE LIVE PATH — reclassified historical 2026-09-15 (catalogue P1-10, task 73).** This document describes the
> Path A design: invite codes → `POST /api/agent/register` → job polling → API key. Checked against the tree 2026-09-14:
> **no `/api/agent/**` registration route exists** — `guild-app/src/app/api/` holds `health/` and `v1/`, and the only
> `agent/` path is the unrelated read-only `/api/v1/agent/feed` poll. What actually runs is the permissionless on-chain
> `public_mint` via `packages/agent-client`'s `mint-badge`, over ROLA + `/api/v1` — see
> `design/agent-auth-design.md`. `scripts/generate-invite-codes.ts`, which targeted this
> never-built flow, was retired on 2026-09-15 together with `scripts/recall-agent-badge.ts`. The file is kept as the record of the Path A design and its kill-switch reasoning; it is not a source of
> truth for anything that runs. This is the same correction `runbooks/agent-badge-recall.md`
> received on 2026-08-15.

> **Status**: shipped 2026-05-21 — Path A engine-level kill switch. Scrypto + manifests + bot async-register + auth-gate + CLI + runbooks all landed as a 7-PR stack. The Scrypto subset now lives IN THIS REPO at `blueprints/agent-badge-controller/` (folded 2026-08-14).
>
> **Date**: 2026-05-19 (original design) · **Updated**: 2026-05-21 (shipped) · **Folded here**: 2026-08-14 (slice A). ⚠️ `bot/*` paths below name files in this repository's `bot/` — the live Telegram bot, folded in from guild-public on 2026-09-29 — but this design was never built: that bot has no `registerAgent()` and no `invite_codes` table.

This document was written as the single source of truth for **who does what, when, and what breaks** in the Path A agent lifecycle (see the banner above: that design was not built). Read this before changing `bot/db.js:registerAgent()`, `bot/services/api.js` auth, the `agent-badge-controller` blueprint, or any manifest builder under `guild-app/src/lib/manifests.ts`.

---

## Glossary

| Role | Holds | Responsibility |
|---|---|---|
| **Operator** | The 1-of owner badge + the operator-funded XRD vault | Mint badges, recall badges, pay for badge TXs |
| **Agent** | An API key (today) + their own `AgentBadge` NFT (Path A onward) | Calls Guild APIs to claim/submit/complete tasks |
| **Downstream user** | Trusts the Guild platform | Posts tasks for agents; sees task outcomes |
| **Guild** | The platform itself | **Neutral party** — does not extract trust from operator OR agent OR downstream user beyond what's on-chain |

The Guild's neutrality is the load-bearing property for community pitch. The operator's role exists because Path A needs **someone** to hold the recall authority — but the migration path (Phase 3 below) moves it to a multi-sig governance arrangement.

---

## Phase plan

| Phase | Operator | Funding model | Owner badge custody | Status |
|---|---|---|---|---|
| **Path A (now)** | bigdev (single key) | Operator-funded mint TXs + invite codes for spam protection | Test wallet → planned migration to Mission Control (dev console) | In flight (PRs #19, #20, planned #21+) |
| **Phase 2** | bigdev (single key) | **Agent-funded via signed subintent** (agent pays mint TX cost, operator co-signs) | Mission Control multi-sig | Post-launch |
| **Phase 3** | DAO multi-sig | Self-sustaining (treasury covers infra; mint costs from agent fees) | Decentralized governance | Q3 2026 target |

Each phase is **additive over the prior** — Path A's data shapes don't change; we add subintent endpoints and migrate the owner badge.

---

## Operator flow

### Deploy (one-time per network — mainnet or stokenet)

```
┌─ Step 1: Compile + publish package (Linux build per scrypto-build-matrix)
│    Output: package_rdx1…
│
├─ Step 2: bun scripts/deploy-agent-badge-controller.ts
│    Input: AGENT_BADGE_PACKAGE=package_rdx…, BOT_PRIVATE_KEY, RADIX_ACCOUNT_ADDRESS
│    Output: 4 env vars to paste into bot/.env
│
└─ Step 3: Owner badge lands in the test wallet (operator's account)
     - Path A: kept in operator's test wallet
     - Phase 2: migrated to Mission Control vault component
     - Phase 3: held in a DAO multi-sig component
```

⚠️ **Owner badge loss = no recall capability ever.** Path A has no recovery mechanism by design. Mitigations:
- Test wallet has a written recovery phrase, stored offline
- Migration to Mission Control happens **before** any agent has live capital
- Phase 2's multi-sig provides operational redundancy without changing the on-chain config

### Recall (when an agent goes rogue)

```
operator decides → bun scripts/recall-agent-badge.ts --agent-name=X --reason=Y
    → script queries Gateway /state/entity/details on agent's account
    → finds vault holding AgentBadge resource
    → builds recall manifest: proof + RECALL_NON_FUNGIBLES_FROM_VAULT + BURN
    → submits via signer
    → agent's badge vault is empty
    → bot's auth-gate cache picks up absence within 5 min (Path A)
    → agent's API calls fail closed
```

**Time-to-recall** (target): operator decides → API gate fails = **< 6 minutes** end-to-end (1 min for TX commit + up to 5 min for cache refresh). Acceptable for Path A's threat model — operator is the trusted party deciding to revoke.

**Recall cost**: ~0.1 XRD per recall TX. Operator-funded for Path A. Mitigated in Phase 2 (agent's registration deposit funds future recall).

---

## Agent registration flow

### Path A: invite-code-gated, async with polling

The mint TX is part of the registration path — it can fail (network, gas, address invalid). Best practice for >1s operations with failure modes is **async + polling**.

```
1. Agent POSTs /api/agent/register
     body: { agent_name, radix_address, spending_limit_per_task, daily_spending_cap, invite_code }
     →  validate invite_code (Path A: shared secret per cohort; one-time consumable)
     →  validate addresses + caps (existing logic)
     →  INSERT agent_profiles (is_active=0)
     →  INSERT api_keys (active=0)            # not usable yet
     →  enqueue mint job (background)
     ← 202 Accepted { job_id, api_key, status: "minting" }

2. Bot's background worker:
     →  build mintAgentBadgeManifest()
     →  submit via signer
     →  on commit:
          - parse AgentBadgeMintedEvent from receipt → record badge_id
          - UPDATE agent_profiles SET is_active=1, agent_badge_local_id=N, agent_badge_minted_at=now()
          - UPDATE api_keys SET active=1
     →  on commit failure:
          - UPDATE agent_profiles SET registration_error=<reason>
          - leave api_keys.active=0 (api_key remains issued but inert)

3. Agent polls GET /api/agent/register/status/:job_id
     →  { status: "minting" | "active" | "failed", error?: string, badge_id?: number }
```

**Agent-side UX**:
- API client polls every 2-3s, max 60s timeout
- On `failed`, presents error + retry button (operator may need to top up XRD)
- On `active`, switches to normal Bearer auth flow with the api_key already issued

**Why optimistic api_key issuance + inactive flag**: keeps the api_key stable (no two-phase secret distribution). If mint succeeds, agent is already using the right token. If mint fails, the token is dead but the agent's identity is reserved (no name squatting during retry).

### Phase 2: agent-signed subintent self-registration

Agent generates a registration subintent that includes:
- A mint instruction (calling `mint_agent_badge` on the controller)
- A fee payment from the agent's wallet
- An expiry

Operator's bot:
- Validates the subintent shape (correct method, correct controller, sane caps)
- Co-signs to authorize the mint (owner badge proof from operator's auth zone)
- Submits

Result: agent pays for their own mint, Guild stays neutral, operator's role is **authorization** only (signs off on valid registrations). Aligns with rdx-cli + RAP V1 (`docs/research/xstelea-rdx-cli-rap.md` in the guild-public repository; not in this one).

### Invite-code system (Path A spam protection)

| Field | Value |
|---|---|
| Storage | `bot/db.js` — new table `invite_codes(code, created_by, max_uses, used_count, expires_at, cohort)` |
| Generation | Operator runs `bun scripts/generate-invite-codes.ts --count=10 --cohort=phase-1-public` |
| Distribution | Guild community channels (Telegram, Discord, Twitter DMs) |
| Validation | `/api/agent/register` rejects if code missing/invalid/expired/exhausted |
| Per-cohort caps | One operator-set max_active_agents per cohort to bound spam blast radius |

This **also** serves as a community-onboarding mechanism — the invite is a public artifact of Guild membership.

---

## Bot auth gate (Path A onward)

### Today (pre-PR 4)

```
incoming /api/* request → db.authenticateAgent(req)
  → hash Bearer header
  → SELECT * FROM api_keys WHERE key_hash=? AND active=1
  → ok? attach req.agent. fail? 401.
```

### Planned (post-PR 4)

```
incoming /api/* request → db.authenticateAgent(req)
  → existing api_key check (above)
  → also check: cached badge presence for this agent
  → if absent (recalled): 401 "badge_recalled"
  
parallel background refresh (every 5 min):
  → SELECT radix_address FROM agent_profiles WHERE is_active=1
  → for each, query Gateway /state/entity/details
  → if AGENT_BADGE_RESOURCE not present in agent's vault:
       UPDATE agent_profiles SET is_active=0, badge_recall_detected_at=now()
       INSERT INTO audit_log (event="badge_recall_detected", agent_name, …)
```

**Cache strategy**: in-memory Map<agent_name, { last_check_at, present }>, populated by the background worker. Per-request reads from the map. If `last_check_at` is older than 10 min (degraded mode), the gate fails open with a warning log — better than rejecting all agents if Gateway is down.

**Degraded-mode trade-off**: a recalled agent has up to 5 min of normal operation + up to 5 min of degraded-mode access if Gateway is down at exactly the wrong moment. Total worst-case window: 10 min. Acceptable for Path A.

---

## Failure modes & responses

| Failure | Detection | Response |
|---|---|---|
| Mint TX rejected at submit | Signer throws | Agent gets `failed` job status; operator alerted if XRD low |
| Mint TX submitted but reverts on-chain | Signer's `waitForCommit` returns `CommittedFailure` | Same as above |
| Mint TX never commits (network) | `waitForCommit` 90s timeout | Job marked `pending_retry`; operator can manually retry or cancel |
| Operator forgets to fund signer XRD | Mint TXs start failing fast | Alert in Telegram + bot pauses new registrations |
| Owner badge lost | Operator notices when first recall attempt fails | **No automated recovery** — see Phase 2 multi-sig migration |
| Gateway down | Cache refresh fails | Degraded-mode auth gate (fail open with warning); restore on Gateway recovery |
| Agent's account doesn't exist on-chain | Mint deposit fails | Mint TX reverts; same as "mint failed" path |
| Double registration of same agent_name | DB unique constraint | 409 Conflict response |
| Bot crashes mid-mint | Job table has the pending state | On restart, background worker resumes pending jobs from DB |
| Operator recalls but Gateway hasn't indexed yet | Bot's cache shows agent still present | Up to 5 min window; standard cache refresh cadence catches it |

---

## Test plan

### Already covered

| Layer | Tests | PR |
|---|---|---|
| Scrypto blueprint | 11 integration tests — instantiate, mint, recall, auth checks, non-transferability, double-recall | landed 2026-05-19 (Path A PR 1/5) |
| Manifest strings | 13 unit tests — string structure, address/decimal validation, sanitization | landed 2026-05-19 (Path A PR 2/5) |

### Needed before mainnet

| Layer | Test | PR |
|---|---|---|
| Bot — schema migration | Migration script + rollback safe | PR 3 |
| Bot — registerAgent async flow | Job enqueue, mint success path, mint failure path, fail-closed semantics, invite-code validation | PR 3 |
| Bot — invite codes | Generation, validation, expiry, cohort caps | PR 3 |
| Bot — auth gate cache | Cache hit/miss, 5-min refresh, Gateway-down degraded mode, recalled-agent rejection | PR 4 |
| End-to-end (stokenet) | Register agent → use api → operator recalls → cache refresh → api blocked. Repeat 3× before mainnet. | PR 5 |
| Failure-mode walkthroughs | Each row in the "Failure modes" table above, manually walked through on stokenet | PR 5 (runbook) |
| Operator UX | Time-to-recall measurement; recall script reliability; operator dashboard surfacing of mint failures | PR 5 |

### NOT in scope for Path A

- Multi-sig owner badge (Phase 2)
- Agent-funded subintent self-registration (Phase 2)
- Cross-network recall (mainnet/stokenet bridging — N/A)
- Batch recall (Phase 2 nice-to-have)
- Time-locked badges (out of scope; engine recall is fine)

---

## Open questions / decisions still to make

1. **Invite-code distribution mechanism**: manual operator distribution via channels, or auto-generated when a Guild member XP threshold is hit? (Defer — start manual, automate later.)
2. **Job table location**: new `mint_jobs` table, or reuse a generic `background_jobs` if/when we build one? (Defer — single-purpose `mint_jobs` for now.)
3. **Degraded-mode policy**: fail open with 10-min window (above) or fail closed? Failing closed is safer but breaks all agents on every Gateway hiccup. (Path A: fail open with warning; revisit if abuse is observed.)
4. **Owner badge migration to Mission Control**: blocking on Mission Control vault primitive readiness. Tracked separately in [project_mc_vault_plan](memory ref).

---

## How to use this doc

- **Implementing PR 3**: build the schema + registerAgent flow exactly per the "Path A: invite-code-gated, async with polling" section above. The job worker pattern is the load-bearing piece.
- **Implementing PR 4**: cache strategy + degraded-mode policy are stated above — implement to spec.
- **Implementing PR 5**: every row of the "Failure modes" table becomes a runbook entry + a stokenet walkthrough.
- **Reviewing any PR in this stack**: cross-check against the relevant section here. If the implementation diverges, update this doc *or* push back on the implementation.

When Path A is in production and we start Phase 2, branch this doc into `agent-lifecycle-phase-2.md` rather than diffing inline.
