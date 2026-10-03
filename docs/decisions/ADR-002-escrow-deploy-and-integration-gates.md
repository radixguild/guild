<!-- status: historical
     verified: 2026-05-29 (the sitting date. Its two Findings were re-read on 2026-08-15
     and both are now OUT OF DATE — see the note below — but the gate/milestone decisions
     themselves were not re-verified against what shipped. Deliberately NOT stamped today.)
     supersedes: parts of ADR-001 §6 priority order + ADR-001 §"Sprint sequence" Sprint 3
     milestone (as the doc itself declares; ADR-001 is NOT archived — both are kept as the
     decision record)
     NB: historical because it is a dated decision record whose premises have since been
     resolved. Archiving is a human call. -->

> ⚠️ **Both Findings that motivate this ADR are now resolved (noted 2026-08-15).** Read them
> as of 2026-05-29, not as current. **Finding 1** ("the dashboard ↔ chain plumbing doesn't
> exist" — every lifecycle step DB-only, the PATCH review route writing `status='confirmed'`
> with zero on-chain effect): the plumbing was built and the **human-to-human money path is
> mainnet-proven end-to-end** on radixguild.com. **Finding 2** ("the escrow blueprint is not
> actually deployed", every address `<TBD>`): the blueprint was deployed 2026-06-03 and the
> §8b cutover completed **2026-06-14** onto `component_rdx1cr690h…335r2` — see
> `ESCROW-ADDRESSES.md`, which is no longer a page of TBDs.
> ⛔ **What is NOT resolved:** the **PULL cutover (P2) has not happened** on the production
> component, and the dispute leg is still unfinished — dispute UI compiled OFF in
> production, live disputes MOCK-ONLY, BUG-7 open. *(2026-10-02: all of that is resolved now.
> The PULL cutover happened on 2026-08-17, which closed BUG-7's caller-routed settlement;
> disputes have been live in the app since 2026-08-29; and the live component has been
> Wave B, `…hp88yly`, since 2026-09-13.)*

# ADR-002 — Escrow Deploy + Integration Gates

**Status**: Accepted
**Date**: 2026-05-29
**Authors**: bigdev (decisions), Claude Opus (synthesis)
**Supersedes**: parts of ADR-001 §6 priority order + ADR-001 §"Sprint sequence" Sprint 3 milestone
**Companion**: `~/Projects/ARCHON-CHARTER-20260529.md`

## Context

Two findings during the 2026-05-29 evening session reframe the path to Phase 1:

### Finding 1 — The dashboard ↔ chain plumbing doesn't exist

A full lifecycle audit (UI → API → DB → on-chain) found that the
`GuildMarketplaceEscrow` blueprint is correct and the manifest builders
in `guild-app/src/lib/manifests.ts` are correct, but **the two never meet
in the middle**. For every step that should write to chain:

| Step | API | UI | On-chain method | Reality |
|---|---|---|---|---|
| Post task | ✅ POST `/tasks` | ✅ `/tasks/create` | `create_task` never called | **DB row only — no XRD locked** |
| Claim task | ❌ no endpoint | ❌ no button | `claim_task` exists, never called | **Unreachable** |
| Submit work | ✅ POST `/tasks/[id]/submissions` | ✅ form | `submit_task` never called | DB row only |
| Approve + release | ✅ PATCH `/submissions/[id]/review` | ⚠️ form exists | `approve_and_release` never called | **DB says "released", worker never receives XRD** |

The PATCH review route is the most dangerous: it writes
`status='confirmed'` on approval with **zero on-chain effect**. A user
trusting this surface today would think they paid someone who never
received funds.

### Finding 2 — The escrow blueprint is not actually deployed

`docs/ESCROW-ADDRESSES.md` is the deploy runbook output. Every entity is
marked `<TBD>`:

- Package address: `<TBD>`
- Component address: `<TBD>`
- Owner / Admin / Worker / Arbiter / Agent badge resources: `<TBD>`

The charter, the architect plan, and ADR-001 §6 all said "deployed on
mainnet, 1502 lines, 45 tests." That was wrong. It's "compiled + tested,
not deployed."

## Decision

### 1. New explicit milestone: **M-Deploy**

Deploying the escrow blueprint is now a **named milestone**, not
implicit prerequisite work. It owns its own runbook, address record, and
acceptance test:

- **Operator**: bigdev (owner wallet, mainnet XRD ~20 XRD per
  `docs/INCEPTION.md` cost table).
- **Runbook**: `docs/ESCROW-DEPLOY-RUNBOOK.md`.
- **Outputs**: filled-in `docs/ESCROW-ADDRESSES.md` + `.env.local`
  entries for `guild-app` and `bot`.
- **Acceptance test**: smoke test from `docs/SMOKE-TEST-RUNBOOK.md`
  passes against the live mainnet component (full create → claim →
  submit → release loop with the operator's own wallet on both sides).

Until M-Deploy passes, dogfood is impossible — there is nothing for the
dashboard to write to.

### 2. Sprint 1.5 is the **wire-up sprint** and can land before M-Deploy

Building `/tasks/create` deposit signing, `/tasks/[id]/claim` flow, and
`approve_and_release` wiring against environment-variable addresses is
real, valuable work. The integration code itself is the unblocker; the
escrow address is the configuration that activates it.

Sprint 1.5 PRs must:

- Read addresses from `NEXT_PUBLIC_ESCROW_PACKAGE` and
  `NEXT_PUBLIC_ESCROW_COMPONENT` env vars (with the bot reading
  `ESCROW_PACKAGE` / `ESCROW_COMPONENT`).
- When env vars are unset, fail closed in the UI with a clear
  "Escrow not yet deployed on this environment" message and a link to
  `ESCROW-DEPLOY-RUNBOOK.md`. No silent fallback to DB-only writes —
  that's the bug we're fixing.
- When env vars are set, the UI signs the manifest and waits for chain
  confirmation before writing the DB row. The DB is downstream of chain
  state, never ahead of it.

After M-Deploy + env vars set, the wire-up code activates without any
code change.

### 3. Re-sequenced sprint plan (supersedes ADR-001 §"Sprint sequence")

| Sprint | Work | Gated on |
|---|---|---|
| **S1** (in flight) | doc-sync P0, `/leaderboard`, `/profile` expansion, `manifest-marketplace.ts`, bot Postgres mirror | nothing |
| **S1.5** (new) | Wire `/tasks/create` deposit signing, `/tasks/[id]/claim` flow, `approve_and_release` wiring — all behind env-var gates | nothing (lands inert until M-Deploy) |
| **M-Deploy** (new) | Publish escrow package, instantiate component, register XRD as accepted token, run smoke test | bigdev's time + 20 XRD |
| **S2** | `GuildRegistry` (per ADR-001 D1) + `GuildSettings` (per ADR-001 D3) | nothing — independent Scrypto work |
| **S3** | `GuildTreasury` vault-only + reroute escrow platform fee to it (per ADR-001 D2) | M-Deploy (escrow needs to exist before its fee can route anywhere) |
| **Dogfood** | First Phase 1 task posted ON Guild + first non-bigdev dev claims it | S1.5 + M-Deploy + S2 (at minimum Registry; Settings + Treasury can lag) |

S1 + S1.5 + S2 can proceed in parallel. M-Deploy is the gate that
collapses them into a working product.

### 4. Honest functional-percentage targets

| State | Human % | Agent % | What's needed |
|---|---|---|---|
| Today (2026-05-29) | 5% | 5% | — |
| After S1 closes | 5% | 5% | (Sprint 1 is feature work, not lifecycle) |
| After S1.5 lands (code only, no deploy) | 5% | 5% | inert until M-Deploy |
| After M-Deploy + S1.5 active | ~85% | ~10% | (humans: full loop. Agents: still need API + AgentVault + x402 for autonomous flow) |
| After S2 + S3 | ~90% | ~15% | (Registry + Settings + Treasury exist; agent path still gated by Layer 4) |
| After Layer 4 (Agent SDK + AgentVault + x402) | ~95% | ~85% | Phase 2 |

Phase 1's success criterion is **a real human posting a real task on
mainnet Guild and a different real human claiming + completing it for
real XRD**. That's the ~85% target.

## Consequences

### For Claude / future sessions

- **Don't assume "deployed" means "on mainnet" again.** Verify by
  grepping for the address in config + checking `ESCROW-ADDRESSES.md`.
- **The DB is downstream of chain.** Don't write a `confirmed` status
  row without a matching on-chain TX hash. If the manifest hasn't been
  signed, the DB stays at `pending` or doesn't get written.
- **Env-var-gated features are first-class.** When wiring against a
  TBD on-chain entity, use env vars, show a clear "not deployed yet"
  state in the UI, and don't fall back to lying.

### For archon

- W1 (self-triage `thread-fe484e80`) and W3 (hardening checklist) per
  ARCHON-PROMPT-20260529.md are still valid and unaffected.
- W2 (DeepSeek drafts) is still valid; nothing changes.
- New: archon may also help with **the post-deploy validation pass** —
  once bigdev runs the deploy, fan out checks across the deployed
  state (component metadata, badge resource owner rules, accepted
  token whitelist) to confirm the runbook produced the expected shape.

### For ADR-001

- §6 "Built" list — strike the `GuildMarketplaceEscrow` entry from the
  "Don't rebuild" section; move it to "Ready to deploy, not deployed."
- §"Sprint sequence" — superseded by §3 above.
- Other ADR-001 sections (maxims, design decisions D1–D5) **stand
  unchanged**. The hybrid Registry, vault-only Treasury, MVP-first
  Settings, separate-bot, and milestone-deferred decisions are all
  still correct.

## Gates (concrete acceptance criteria)

Each gate is binary — pass or not pass. No "mostly works."

### G1 — Sprint 1.5 acceptance

- `/tasks/create` calls `rdt.walletApi.sendTransaction()` with
  `depositToEscrowManifest(...)` after POST `/tasks` succeeds.
- Returns the `transactionIntentHash` and stores it in `escrow_transactions.tx_hash`.
- `/tasks/[id]` shows "Awaiting on-chain confirmation" until the gateway
  polls a `CommittedSuccess` status, then shows "Funded".
- POST `/api/v1/tasks/[id]/claim` exists, returns a manifest the worker
  signs. After confirmation, the task's `assigneeId` and a new
  `tasks.escrow_claim_receipt_id` column are populated.
- PATCH `/api/v1/submissions/[id]/review` with `approved` returns an
  `approveAndReleaseManifest(...)` for the poster to sign. DB
  `escrow_transactions` row is `pending` until on-chain confirmation,
  then `confirmed`.
- When `NEXT_PUBLIC_ESCROW_PACKAGE` is unset, all three paths render
  "Escrow not yet deployed" + link to runbook. No silent DB writes.

### G2 — M-Deploy acceptance

- `ESCROW-ADDRESSES.md` has every `<TBD>` replaced with a real address.
- `guild-app/.env.local` and `bot/.env` carry the new addresses.
- Smoke test from `docs/SMOKE-TEST-RUNBOOK.md` passes end-to-end on
  mainnet using bigdev's wallet for both sides.
- A Radix Dashboard link to the live component is added to README's
  on-chain addresses table (replaces "TBD — deployed but pending public
  address publication").

### G3 — Dogfood acceptance

- A real task funded with real XRD is created via `/tasks/create` by a
  non-bigdev wallet (or, for the absolute first one, bigdev's own
  account as a test of the deployed escrow).
- A different real wallet claims it via `/tasks/[id]/claim`.
- The worker submits real work via `/tasks/[id]/submit`.
- The poster approves via the dashboard. XRD lands in the worker's
  wallet within one Radix epoch.
- The DB and the on-chain state agree on `status='paid'` /
  `TaskState::Released` for the same task ID.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| M-Deploy reveals blueprint bugs that didn't show up in 45 tests | medium | high | Smoke test before announcing publicly; pause window for fixes |
| Mac/Linux WASM divergence breaks the deploy artifact | low | high | Build artifact on Linux CI (per CLAUDE.md global rule) |
| ENV var typo causes silent fallback to DB-only writes | medium | high | G1 explicitly forbids silent fallback. Add a runtime assertion. |
| The `escrow_claim_receipt_id` column persists state that's lost if user clears localStorage | medium | medium | Persist in Postgres (where it lives anyway), not browser |
| Dogfood task funder bails on payment | low | high | First task is bigdev → bigdev so the dispute path doesn't fire on the first run |

## What this ADR does NOT decide

- The deploy schedule. Decision-maker: bigdev, based on time + XRD.
- Whether to ship a bridge component that lets the OLD v1 escrow
  (`component_rdx1cp8mwwe...` on guild-public, currently paused) hand
  off in-flight tasks to v2. Decision-maker: bigdev, after observing
  whether v1 has any in-flight state worth preserving.
- The exact spec of `tasks.escrow_claim_receipt_id` (string vs structured).
  Will be locked in the first S1.5 PR that introduces it.

---

*This ADR is read-only once accepted. If a finding changes the picture
again, write ADR-003 referencing this one.*
