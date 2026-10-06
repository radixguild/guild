<!-- status: live
     verified: 2026-10-02 (the "Operational notes from the live test" bullet ONLY, against
     guild-app/src/lib/pr-verify.ts and the lint job's state on main. Nothing else re-checked.)
     verified: 2026-08-15 (§2 landmine, §4 tiers and §6 delivery plan re-checked against the
     shipped tree — PRs A/B/C all landed; one capability row in §0 was FALSE and is fixed)
     2026-08-29: narrow re-check of the dispute-state claim ONLY — corrected from "dispute UI compiled OFF / disputes MOCK-ONLY" to LIVE (PR #465, gate inverted). Nothing else in this doc was re-verified.
     supersedes: none (pre-dates the header rule) -->

> **Shipped status, 2026-08-15.** The §6 delivery plan is DONE: PR A (terms engine +
> canonical brief v2), PR B (`/projects` + `/projects/[slug]`) and PR C (trust tiers) are all
> live, and the §8b re-instantiation executed on 2026-06-14. Verified in tree: `lib/trust.ts`
> exports exactly the `new` / `established` / `top_rated` ladder §4 specifies, with the
> boundary thresholds as written; `db/queries/trust.ts` derives the stats from the escrow
> ledger; setting 18 shipped as `terms.minTrustTier`, enforced at claim
> (`escrow-actions.tsx:358`). §4.1's open verification — "confirm dispute ledger rows let us
> attribute the raiser" — is **resolved**: attribution is chain-derived from
> `DisputeRaisedEvent.raised_by`, not from a ledger sender field. What is still LIVE guidance
> here is **§2's canonical-brief-v2 landmine** and the two-layer enforced/committed model —
> read those before touching the hash.

# Task Terms & Contract Design — "the Radix Fiverr"

_2026-06-11. Decided with bigdev after the wallet re-smoke pass (post-#155). Spec for the
create-flow overhaul (PR A below), the projects tab (PR B), trust tiers (PR C), and the
enforced-terms unlock at the planned component re-instantiation. Supersedes the #143
template gallery (removed by PR A — its soul survives as deliverable-type defaults)._

## 0. The discovery that frames everything

The in-repo blueprint (`escrow/scrypto/guild-marketplace-escrow/src/lib.rs`) is far richer
than the app exposes. Capability inventory:

| Blueprint capability | Method(s) | App exposes today? |
|---|---|---|
| Multi-token rewards (whitelist + per-token min + freeze) | `add/remove_accepted_token`, `freeze/unfreeze_token`, `create_task(reward: Bucket, …)` | ❌ XRD hardcoded |
| Per-task arbiter fee (capped by config) | `create_task(arbiter_fee_pct)`, `resolve_dispute` | ❌ |
| Arbiter resolution path (badge-gated) | `resolve_dispute` | ❌ in the app — but ⚠️ **"no arbiter badge instantiated" is FALSE, corrected 2026-08-15.** The §8b cutover minted one: `arbiter_badge_resource` = `resource_rdx1nf229dxv…kn3`, supply 1, guild-held, and **distinct from the member badge** (`ESCROW-ADDRESSES.md`, kept in the private operations repository; gateway-verified 2026-08-09). ⚠️ *Corrected 2026-08-29:* the trailing "and the dispute UI is compiled OFF in production" is false — **disputes shipped LIVE 2026-08-29** (PR #465), arbiter path included, and the launch gate was inverted to fail a disputes-OFF build |
| Auto-resolve default: FavorDisputeRaiser / SplitEvenly / ReturnToPoster | `instantiate(dispute_auto_resolve_default)` | Deployed = **`SplitEvenly`** (chain-verified, recorded in `ESCROW-ADDRESSES.md` — **not** FavorDisputeRaiser, as this cell said until 2026-08-09) |
| Claim liveness: deadline + public expiry (⚠️ the paid-heartbeat half is REMOVED — DB-3, 2026-08-06) | `expire_claim`, `claim_deadline` | ❌ |
| Human vs agent submit deadlines | `instantiate(human/agent_submit_deadline_secs)`, `claimer_is_agent` | ❌ |
| Configurable insurance fraction + claim bond | `instantiate(min_insurance_fraction, claim_bond_xrd)` | Fixed-rate UI only |
| Forfeited-bond treasury | `withdraw_forfeited_bonds` | ❌ |
| Work-brief commitment | `create_task(work_brief_hash)` | ✅ title+description only |

**Implication: this is not "build a contract-terms engine" — it is "expose the engine we
already wrote, and commit everything else into the brief hash."** The already-planned
re-instantiation (between pilot and open-up: agent badge + self-claim assert + arbiter/Split)
is the migration that turns on the enforced half. ✅ RESOLVED 2026-06-12 (ledger query of
the live component): the deployed package IS this blueprint version — `accepted_tokens`
KeyValueStore present on-chain, so **multi-token = owner call on the live component**, no
re-instantiation needed for it.

## 1. Two-layer terms model (the core idea)

Every term is one of:

1. **Enforced** — the contract physically guarantees it (token, amounts, deadlines, bond,
   resolution rule). The chip in the UI reads `enforced by contract`.
2. **Committed** — structured JSON canonicalized into the on-chain `work_brief_hash`. Not
   machine-enforced, but immutable and provable: in any dispute both parties (and an
   arbiter) can verify exactly what was agreed. Chip reads `committed terms`.

Labeling each term honestly is itself dispute-prevention: nobody can claim they thought the
review window was machine-enforced.

**Committed terms are also the agent API.** Agents stop scraping prose and parse
`acceptance_criteria[]`, `repo`, `due` directly from the structured terms (returned by
`GET /api/v1/tasks/[id]`). Fiverr never had machine-readable scope; we get it for free.

## 2. The settings (create wizard step 2 → "Reward & terms")

| # | Setting | Layer | Availability |
|---|---|---|---|
| 1 | Reward token (XRD / xUSDC / xUSDT) | Enforced | Owner call if deployed pkg has whitelist; else re-instantiation |
| 2 | Reward amount + live USD estimate | Enforced | Now |
| 3 | Insurance % (≥ min fraction) | Enforced | Now (make the fixed rate adjustable) |
| 4 | Arbiter fee % | Enforced | Re-instantiation |
| 5 | Dispute resolution default (raiser / split / return) | Enforced | Re-instantiation (global today) |
| 6 | Submit deadline after claim (human/agent) | Enforced | Global config now; per-task = small blueprint tweak at migration |
| 7 | Claim bond (display to poster) | Enforced | Now |
| 8 | Due date | Committed | Now |
| 9 | Review window promise ("poster reviews within N days") | Committed | Now |
| 10 | Deliverable type (code-PR / design / content / research / deploy) | Committed | Now — **drives defaults for 8–18; replaces templates** |
| 11 | GitHub repo + issue/spec link | Committed | Now |
| 12 | Acceptance criteria checklist (3–7 testable items) | Committed | Now — the single biggest dispute killer |
| 13 | Definition of done (tests pass / CI green / deployed / reviewed) | Committed | Now |
| 14 | Revisions included before dispute (0–3) | Committed | Now |
| 15 | License / IP assignment (MIT / assigned-on-payment / …) | Committed | Now |
| 16 | Communication channel (TG handle / GH issue thread) | Committed | Now |
| 17 | Who may claim: humans / agents / both | App-gated now | Agent badge enforces at migration |
| 18 | Min trust tier to claim | App-enforced | After PR C |
| 19 | Project assignment | App | With PR B |
| 20 | Milestone split (generate N linked tasks) | App | Projects v2 — escrow stays one-task-one-payout; the project is the milestone container |

### Wizard UX (per docs/ux-simplification-research-2026-06-07.md, kept in the private operations repository — still the law)
- **Step 1** What needs doing: title, description, deliverable type (10), repo/links (11).
- **Step 2** Reward & terms: 1–3 + due date (8) visible; "Advanced terms" collapsed with
  the rest, all prefilled from the deliverable-type defaults. One goal per screen; smart
  defaults mean a fast poster touches 3 fields, a careful poster gets 20.
- **Step 3** Review & post: render the FULL contract as readable prose ("You're locking
  500 XRD + 25 insurance. Worker must submit within 7 days of claiming. 2 revisions
  included. Resolution default: split.") — **that exact rendered canonical text is what
  gets hashed.** Stripe-style side-by-side: form left, contract right.
- Templates page/gallery: **removed.** `?template=` deep links keep working by mapping to
  deliverable-type + prefill params (agents already use RAC-shaped briefs from #143).

### ⚠️ Canonical brief v2 (the landmine)
The work-brief hash currently commits `title + description` with a canonical format pinned
by `tests/unit/escrow-canonical.test.ts` and verified server-side. Extending it requires a
**versioned canonical format** (`guild-brief-v2` header + sorted, normalized terms block),
coordinated across: create page hash composition, server-side verify on confirm, and the
resync path. v1 briefs must keep verifying (existing on-chain tasks). Never an ad-hoc
string change.

## 3. Dispute-free mechanics (what Fiverr actually does → our translation)

| Fiverr mechanic | Why it kills disputes | Guild translation |
|---|---|---|
| Requirements gate (clock starts only when buyer provides inputs) | No "I was never told X" | Task not claimable until terms complete + escrow funded (funding half shipped) |
| Packages (pre-scoped tiers) | Scope ambiguity dies before purchase | Deliverable-type defaults + acceptance checklist (10, 12, 13) |
| Delivery clock (⚠️ no extensions) | Stale claims don't rot | Blueprint `expire_claim` + a `claim_deadline` fixed at claim time — surface the countdown in UI (shipped: `escrow-truth.tsx`). **There is no "extend" to build**: DB-3 (2026-08-06) removed the heartbeat leg outright, and `settle_by_agreement` is Wave-B. |
| Auto-complete on buyer silence (3 days) | Ghosting doesn't pay | Review-window term (9); after lapse worker raises dispute; at migration prefer SplitEvenly/arbiter so first-mover-wins stops being the meta (closes smoke finding 8) |
| Seller levels + metrics | Trust priced in before contact | Trust tiers (PR C below) |

## 4. Trust tiers (PR C)

All derivable from the escrow ledger + tasks tables today — no new chain state:

- **completion rate** = released / claimed (per identity)
- **dispute involvement** = disputes ÷ tasks, split raised-vs-against
- **on-time rate** = submitted-before-deadline / submitted

Tiers (Fiverr-style, thresholds to confirm with real pilot data): **New** → **Established**
(≥5 completed, 0 disputes-against) → **Top Rated** (≥15, ≥95% on-time, 0 disputes-against).
Surfaces: profile header, claimer chip on task detail (poster sees who they're trusting),
leaderboard columns next to XP (#153 made XP flow on payout). Same ledger for humans and
agents — an agent earns the same record. On-chain attestation stays the Tier-3 bet
(competitive-research doc #9).

### 4.1 PR C implementation plan (file-level, prepared 2026-06-11)

1. **Derivation — `src/db/queries/trust.ts`.** One aggregate per identity over the
   escrow ledger (`escrow_transactions` is the source of truth — task status churns,
   ledger rows don't) joined to tasks:
   - `completionRate` = release rows ÷ claim rows (per worker address)
   - `disputesAgainst` vs `disputesRaised` from dispute rows + resolution outcome
   - `onTimeRate` = submit rows at-or-before the task deadline ÷ submit rows (no-deadline
     tasks excluded)
   ⚠️ One verification before building: confirm dispute ledger rows let us attribute the
   raiser (actor/sender field) — if not, raiser attribution needs the tx-sender lookup.
2. **Tiers — `src/lib/trust.ts`.** Pure function over those stats; thresholds in an
   exported config object (pilot data will retune them — §7 Q3): New → Established
   (≥5 completed, 0 disputes-against) → Top Rated (≥15, ≥95% on-time, 0
   disputes-against). Unit tests pin the boundaries (4/5, 14/15, 94.9/95).
3. **API.** `GET /users/[address]/profile` gains `trust: { tier, stats }`; leaderboard
   query gains the same columns. Derive-on-read first (indexed aggregates over pilot-scale
   data); add a cache table only if profile p95 demands it.
4. **UI.** Profile header chip; claimer chip on task detail (poster sees who they're
   trusting before approving); leaderboard columns next to XP. Same ledger for humans
   and agents.
5. **Min-tier gate (setting 18).** `TaskTerms` gains optional `minTrustTier`; claim route
   enforces it server-side fail-closed (like the badge gate, #123). NOTE: this extends the
   canonical v2 terms block — additive key, absent-key briefs hash identically, but
   `canonicalTermsBlock` + the pinned vector test must be updated together (§2 landmine
   rules apply).
6. **Out of scope for C:** on-chain attestation (Tier-3 bet), decay, achievement badges.

## 5. Projects (PR B)

- Schema: `projects` (id, name, slug, description, commissionerId, createdAt) +
  `tasks.projectId` (nullable FK). Commissioner = account today, DAO-ref in v2 — matches
  the OVERHAUL-HANDOFF target architecture ("Project: optional grouping; commissioner =
  reference+type").
- `/projects` tab: cards with progress (n of m tasks released, total XRD locked/paid).
- Project page: kanban funnel of its tasks (Open → Claimed → Submitted → Paid) — the
  Dework steal from competitive-research. Example seed: "Wallet Upgrade" project.
- Create-task wizard gets the project picker (19); a "+ task" button on the project page
  pre-selects it.

## 6. Delivery plan

| PR | Scope | When |
|---|---|---|
| **A — terms engine** | Remove template gallery; `terms` jsonb on tasks + shared zod schema (client + API); step-2 redesign per §2; contract render + canonical brief v2; terms in task detail + API | Now (app-only) |
| **B — projects** | Schema + tab + project page kanban + wizard picker | After A |
| **C — trust tiers** | Ledger-derived stats + chips + leaderboard columns + min-tier gate (18) | After A (parallel to B) |
| **Migration window** | Re-instantiate: arbiter badge + SplitEvenly default, token whitelist (xUSDC/xUSDT), agent badge, self-claim assert, per-task submit deadline | Already planned between pilot and open-up |

Form infra: react-hook-form + zod (Phase A of the ux-simplification doc) lands with PR A.

## 7. Open questions for bigdev

1. ✅ ANSWERED 2026-06-11: deployed package has `add_accepted_token` (owner call) —
   but a vNext package ships anyway for the self-claim assert (§8b).
2. ✅ DECIDED 2026-06-11: NO per-task deadline tweak. It would change the
   `create_task` ABI and ripple through every app builder for a speculative need;
   global human/agent deadlines stand. Revisit only if pilot data demands it.
3. Tier thresholds (§4) — tune after pilot data?
4. Insurance % poster-adjustable (within min..1) or keep fixed rate until arbiter exists?
5. Milestone split (20): projects-v2 or cut until demand shows up?

## 8b. Re-instantiation parameters (DECIDED 2026-06-11 — executing)

Exact `instantiate` args for the migration component (current deployed values in
parens where they differ). Values below are final; bigdev approved the draft
verbatim on 2026-06-11.

**Scope correction from the draft**: a vNext PACKAGE is required after all — the
self-claim assert (smoke finding 8) is blueprint code, and an app-only gate can't
protect LEDGER-derived trust stats from on-chain self-dealing. The per-task
deadline tweak is OUT (§7 Q2): `create_task` ABI stays byte-stable, so every app
builder, event parser and the keeper work against vNext unchanged.

**Executable sequence** (wallet steps live on /deploy-escrow as a threaded
console — each step captures its created addresses from the gateway receipt):

0. Publish `guild-marketplace-escrow` vNext + `agent-badge-controller`
   (console.radixdlt.com → Deploy Package; wasm+rpd built on the VPS).
1. Instantiate agent-badge-controller → GAGENT resource + controller owner badge
   (recall kill-switch — vault it).
2. create_manager("arbiter") on the LIVE BadgeFactory — the exact lineage that
   created the member-badge manager (manifest mirrors its 2026-04-04 instantiate
   tx; factory verified unpaused). Returns the manager + a per-collection
   **admin badge** (the mint/revoke authority — deposits to the operator wallet).
   No new package, no resource-creation SBOR. 5 XRD royalty.
3. Mint arbiter badge(s) to the arbiter account(s) with the admin-badge proof
   (1 XRD royalty). Repeatable later; revoke_badge is the kill switch.
4. Instantiate escrow vNext with the table below (agent badge = Some(GAGENT),
   SplitEvenly default). New owner badge + receipt resources → wallet.
5. Register XRD (then xUSDC/xUSDT when wanted) on the NEW component.
6. **Cutover — STRICTLY after task 2 settles** (keeper is watch-only and will
   NOT sign — the worker account finalizes via the task UI any time after the
   window lapses Sat 2026-06-13 22:46Z): event verification pins to the
   configured component (`gateway.ts` emitter check), so swapping early would
   orphan the in-flight dispute. Swap FIVE envs on the VPS:
   `NEXT_PUBLIC_ESCROW_COMPONENT`, `NEXT_PUBLIC_ESCROW_PACKAGE`,
   `NEXT_PUBLIC_ESCROW_RECEIPT_RESOURCE`,
   `NEXT_PUBLIC_ESCROW_CLAIM_RECEIPT_RESOURCE`,
   `NEXT_PUBLIC_AGENT_BADGE_NFT` (un-dormants the agent gate) →
   `npm run build` → `pm2 restart guild-saas-app`.
7. Flip the enforced-terms UI + re-run the money smoke on the new component.

| Param | Draft value | Why |
|---|---|---|
| `worker_badge_resource` | unchanged (member badge) | |
| `arbiter_badge_resource` | NEW operator-minted arbiter badge | the arbiter path finally becomes reachable |
| `agent_badge_resource` | `Some(agent-badge-controller resource)` (now None) | deploy guild-public blueprint first; enables on-chain claim-eligibility |
| `max_arbiter_fee_pct` | `0.10` | caps per-task term 4; 0 keeps auto-resolve-only economics until arbiters onboard |
| `human_submit_deadline_secs` | `604800` (7d) | unchanged |
| `agent_submit_deadline_secs` | `86400` (1d) | agents iterate fast or release the claim |
| `dispute_auto_resolve_secs` | `259200` (72h) | unchanged — UI copy + keeper already assume it |
| `dispute_auto_resolve_default` | `SplitEvenly` — deployed AND signed for the PULL cutover (DB-1). The "(now FavorDisputeRaiser)" note here was wrong | kills first-mover-wins (smoke finding 8) |
| `min_insurance_fraction` | `0.05` | matches the current fixed UI rate; term 3 makes it adjustable upward |
| `claim_bond_xrd` | unchanged | revisit with pilot data |
| ~~`heartbeat_fee_xrd` / `heartbeat_extension_secs`~~ | **REMOVED** | DB-3 (signed 2026-08-06): both args are gone from `instantiate` (13→11). Surface the countdown; there is no extend. |

Token whitelist (xUSDC/xUSDT) is an owner call after instantiation — not a
param. Open: per-task submit-deadline override (§7 Q2) decides whether the
blueprint tweak happens at all; everything above works without it.

## 8. PR auto-verify (PR D — v1 shipped, v2 deferred)

The guild-public `bot/services/github.js` watcher, re-imagined app-canonical
(FEATURE-MAP §E said "natural fit with terms repoUrl + definition-of-done" — it was):

- **v1 (shipped)**: `lib/pr-verify.ts` + `POST /submissions/[id]/verify-pr` +
  verdict panel. The PR link is regex-extracted from submission content (the
  evidence hash binds only `content`, so nothing about the commitment moves);
  the PR must live under the brief's committed `repoUrl` (no borrowing green
  PRs; since 2026-10-06 a task with no `repoUrl` cannot be verified at all,
  `422 NO_REPO_PIN`, and a verdict stored without a pin no longer renders as
  this task's evidence); merged/CI/review are checked against the task's definition-of-done and
  the verdict stored on the submission row. On-demand (poster/submitter
  button or agent API call) — no cron, no custody question.
- **v2 (deferred to the keeper-cron + signing-custody decision)**: scheduled
  watcher verifies on merge events and auto-queues release — the full
  guild-public behavior. The auto-release policy question (Fiverr
  auto-complete analog) belongs to the same decision.
- **Operational notes from the live test** (its pull request is in the
  repository this one was exported from, and that reference does not resolve
  here): (a) verifying a PR in a private repository needs `GITHUB_TOKEN` in the
  server env AND the repository listed in `PR_VERIFY_PRIVATE_REPOS`
  (`owner/repo`, comma-separated; since 2026-10-06 any other private PR answers
  like one GitHub hides, so the route never confirms it exists); for a public
  one the token is optional and only raises the rate limit
  (`guild-app/src/lib/pr-verify.ts`). (b) At the time, the lint job was
  red on every PR, so `ci-green` could never pass. *(Resolved by 2026-10-02:
  the `lint (guild-app)` job passes on `main`.)*
