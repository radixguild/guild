<!-- status: live
     verified: 2026-10-03 (SCOPED: the two lint lines ONLY — §A's "Green e2e CI" row and §F's
     open-findings row — against `bun run lint` in guild-app, which exits 0 with no problems, and
     test.yml's `lint (guild-app)` job, which runs it on every PR. Nothing else re-checked.
     The same pass marked the pointers to files this repository does not ship as kept in the
     private operations repository; the claims around them were not re-checked.)
     verified: 2026-10-02 (SCOPED: §E's post-fold note and its /game, trust-score, BadgeManager,
     bot-store, PR auto-verify, "rich bot services" and :3002 rows ONLY, against this
     repository's bot/, badge-manager/ and guild-app trees, the operator's records, the
     bot fold commit (#813, 2026-09-29), #622, and GETs of radixguild.com/game and
     memegrid.radixguild.com. Nothing else in this file re-checked.)
     verified: 2026-09-04 (SCOPED: the /decisions rows only — §A and §F CV2/governance lines
     updated to record that the guild-app web page (/decisions, /governance, /proposals*,
     /governance-status) was REMOVED OUTRIGHT this date on bigdev's direct instruction ("pull
     the decisions page from the guild"). The CV2 component stays on mainnet, unchanged;
     reads continue only via the Telegram bot (/cv2). Nothing else in this file re-checked.)
     verified: 2026-08-15 (SCOPED, twice. 2026-07-31: governance rows only — the CV2/CV3 lines
     in §A, §E and §F, re-checked against docs/PROJECT-STATE.md and docs/ASSET-REGISTRY.md.
     2026-08-15: the ROUTE-EXISTENCE claims only — every §C "not built"/"doesn't exist" and
     §E/§F row naming a page or API route was checked against guild-app/src/app/**; four were
     found FALSE and are corrected in place with a dated marker. Everything else is still the
     2026-06-11 compilation and remains UNVERIFIED — read those statuses as aging, exactly as
     the note below says.)
     supersedes: none (index of every feature across the corpus; compiled 2026-06-11 —
     header block backfilled 2026-07-31 with the governance edit) -->

# Feature Map — everything flagged, planned, shipped, or shelved

_2026-06-11. One place for every feature across all docs (root docs/, design/, decisions/,
architecture/, research/) plus the guild-public heritage. Compiled by a full-doc sweep the
day the wallet re-smoke passed. Sibling: [`TASK-TERMS-DESIGN.md`](./TASK-TERMS-DESIGN.md)
(the create-flow/terms/projects/trust plan). Statuses age — this map is the index.
⚠️ **Corrected 2026-08-15: "trust OVERHAUL-HANDOFF.md for the live roadmap" is out of date.**
That doc is a June-2026 overhaul tracker; the governing plan is now
`EXTERNAL-V1-FRAMEWORK.md`, with the narrative in
`PROJECT-STATE.md` (all three docs named here are kept in the private operations repository)._

## A. Live today (shipped in guild-saas)

- **On-chain marketplace escrow** — `guild-marketplace-escrow` singleton (multi-token whitelist, dual reward+insurance vaults, claim bond, heartbeat, expire, receipts), mainnet 2026-06-03, money layer smoke-proven with real XRD 2026-06-11 `(ESCROW-DESIGN, ESCROW-ADDRESSES, OVERHAUL-HANDOFF)`
- **Full escrow lifecycle UI** — create→fund→claim→submit→approve/release, fail-closed event verification, replay/status-regression protection `(OVERHAUL-HANDOFF P0/P3)`
- **Dispute raise + 72h auto-resolve finalize** — auto-resolve-only model (0% arbiter), terms dialog, two-leg payout `(OVERHAUL-HANDOFF P3)`
- **On-chain cancel/refund** — open + after-claim variants (#137)
- **Frozen v1 commitments** — sha256 work-brief/submission canonical formats (#139); v2 terms extension specced in TASK-TERMS-DESIGN
- **Escrow ledger integrity** — confirm route as single writer, real txHash, atomic confirms, unique (task,tx_type) (#122/#132/#134/#138)
- **Reconciler + self-service resync** — `scripts/reconcile-escrow.mjs` (an operator script, kept in the private operations repository; first production `--apply` done) + per-task resync button (#144/#150/#151)
- **ROLA auth folded into connect** — JWT session, lazy sign-in, session↔wallet guard incl. multi-account fix (#155)
- **Guild Member badge NFT** — public mint for the network fee (~1 XRD), on-chain tier/XP metadata, **TRANSFERABLE** (BadgeManager source lives IN THIS REPO since the 2026-08-14 fold: `badge-manager/scrypto/radix-badge-manager/`). The **username IS the NFT id**, so there is one badge per unique username — *not* one per person or account. ⚠️ Corrected 2026-08-01: this line said "free mint … non-transferable" and **both halves were false**. Chain-read 2026-07-31: `withdrawer`/`depositor` = AllowAll and `recaller` = DenyAll, so it is neither soulbound nor recallable; and every `*_updater` = DenyAll, so it can **never** be retrofitted — making it non-transferable needs a new resource plus a holder migration. The badge records membership; **it gates nothing and is not a sybil control.** ⚠️ The on-chain `xp`/`tier` fields exist but have **never been written since mint** (`xp = 0`, `last_updated == issued_at`) — the metadata is a schema, not a live process.
- **Server-side builder-badge gate** — claim/submit fail-closed on on-chain badge (#123)
- **XP/reputation award on payout** — exactly-once on release confirm (#153)
- **Leaderboard** (#120) · **Profile** (badge, XP, history) · **CV2 reads — the `/decisions` web page was REMOVED 2026-09-04** on bigdev's direct instruction ("pull the decisions page from the guild"). CV2 itself is unaffected and still PARKED (bigdev 2026-07-31, until the guild-saas-dao needs it — a **copy-only** park, writes still flagged off via `NEXT_PUBLIC_FEATURE_CV2_WRITES`); the component stays on mainnet and reads continue only via the Telegram bot's `/cv2` command, not through the dashboard. CV3 was never at `/decisions` either — its UI was removed in #216 when CV3 was parked 2026-07-18
- **Unified single app at radixguild.com root** — one shell, Build/Govern nav (Phase-1 cutover)
- **Task wizard + quick-post templates** (#143) — templates being REPLACED by deliverable-type defaults (TASK-TERMS-DESIGN)
- **Agent-badge builder gate (dormant)** — behind `NEXT_PUBLIC_AGENT_BADGE_NFT`, unset for pilot (#142)
- **Postgres+Drizzle canonical store** — tier vocab member→elder, cruft swept (P2)
- **Telegram governance bot** — kept, de-emphasized; community surfaces (/groups /feedback /docs /guide /about) off primary nav
- **API hardening** — withAuth+zod, per-user rate limits, structured logging, one-time ROLA nonces
- **Green e2e CI** (#145); ~~lint frozen 13-problem baseline~~ ⚠️ *Corrected 2026-10-03:* the lint baseline is clear — `bun run lint` in `guild-app/` exits 0 with no problems, and the `lint (guild-app)` CI job runs it on every PR · **Operator surfaces** — /admin, /deploy-escrow, runbooks, run-guild-app skill

## B. In-flight / explicitly next

- **Sat 2026-06-13 ~22:46Z: task-2 dispute window lapses** — after lapse, the winner (worker-raised → the worker account) clicks Finalize in the task UI and signs with their own wallet; collects 27.5 XRD, proves resolve vertical `(OVERHAUL-HANDOFF)`
- **Keeper = WATCHER, not signer** — bigdev decision 2026-06-11 (supersedes the same-day auto-sign activation): NO platform-initiated signing on the money path; the on-chain PUBLIC auto_resolve is the trustless guarantee and the winner triggers it from their own wallet. Cron runs keeper.mjs (kept in the private operations repository) watch-mode every 30 min (detect + verify events + Telegram alert); no KEEPER_* key in prod env. Alerts dormant until `KEEPER_ALERT_TG_CHAT` is set (same chat id wanted for backup alerts)
- **W2 ops** — fund 2 pilot agents (~15 XRD), mint MEMBER badges, decommission `:3002`
- **Private pilot** — bigdev + 2 worker agents until humming; then 5-user invite + announce
- **Agent client merge** — ✅ DONE and superseded: all legs landed on the fork's `main` (#24/#26/#30/#31), then the whole client was **extracted in-repo 2026-07-18** → `packages/agent-client` (`@radix-guild/agent-client`, 96 tests, CI-gated manifest parity)
- **Component re-instantiation BEFORE open-up** — §8b DECIDED + staged 2026-06-11 (#164): self-claim assert in the vNext blueprint, wallet steps threaded on /deploy-escrow, cutover gated on task-2 settle + task-4 cancel. Per-task deadline OUT (§7 Q2 — create_task ABI stays stable). Remaining: bigdev wallet session → 5-env swap → money smoke
- **Terms engine / projects tab / trust tiers / PR auto-verify** — TASK-TERMS-DESIGN PRs A–D ALL MERGED to main 2026-06-11 (#157, #161 [recreated #158], #159, #160)
- **P4** — bot becomes /api/v1 client, retire bot SQLite store, then third-party agent auth
- **P5** — ROLA nonce → shared store, shared rate limits, request-derived origin, full E2E smoke
- **e2e flake group** — FIXED: stubChainData() pins Gateway/bot-API fetches (rode #157)
- **P1 leftovers** — collapse /guide→/docs; route-gate /admin + /deploy-escrow (needs operator-badge signal in useWallet)
- **Bonding-curve design session** — queued after pilot

## C. Designed / specced but NOT built

- **GuildRegistry** — thin write-gate + cached index + events; tier/rep stays on badge `(ADR-001 D1, GUILD-INCENTIVE-SYSTEM §1.1)`
- **GuildTreasury** — vault-only phase 1 (escrow fee routes in), rep-weighted distribution phase 2; /treasury `(ADR-001 D2, PROJECT-COMPONENTS §7)`
- **GuildSettings** — parameters on-ledger, 8 MVP settings, governance lock; /settings `(ADR-001 D3, GUILD-SETTINGS-SPEC)`
- **TaskFundingCurve** — bonding-curve task crowdfunding (linear MVP, cost-basis refund, share tokens, expiry/refund) feeding escrow `(GUILD-BONDING-CURVE-TASKS, PROJECT-COMPONENTS §9)`
- **Revenue share / royalties / reputation decay** — cooperative flywheel layers `(GUILD-VISION-2026)` ⚠️ see contradictions
- **Milestone escrow** (>500 XRD, per-milestone vaults) — deferred until a real >500 XRD task `(ADR-001 D5)`
- **Streaming escrow** (retainer XRD/epoch) · **Bounty-pool competition escrow** (multi-winner) `(architecture/system-map §2.3/2.5)`
- **x402 pay-per-action agent payments** — HTTP 402 + RAP V1; "core roadmap" in vision docs `(research/x402-radix-integration)` ⚠️ see contradictions
- **AgentVault** (agent-funded posting) — deferred until first active agent member `(ADR-001)`
- **agent-badge-controller deploy** — wasm+rpd built on the VPS 2026-06-11; publish + instantiate are §8b steps 0–1 on /deploy-escrow (rides the re-instantiation migration)
- **Paid arbiter market** — recallable arbiter badge, dispute-bounty pool earning `arbiter_fee_pct × insurance` `(architecture/dispute-resolution, SPRINT-1.5)` ⚠️ deployed reality is 0%-fee auto-resolve-only
- **4-tier dispute extras** — evidence UI, 3-arbitrator rep-weighted panels, auto-resolution engine (compile/test gates), AI quality scoring, double-blind review, prevention score, Kleros tier-4 `(architecture/dispute-resolution)`
- **Custom contract template library** — 8 templates (audit, design w/ revisions, retainer, competition, agent task…) `(architecture/custom-contracts)` — partially superseded by TASK-TERMS-DESIGN's terms model
- **Insurance system** — pool component, rep-based coverage tiers, stake-based >500 XRD, yield on idle capital, stablecoin escrow `(architecture/insurance-model)`
- **Guild incentive dashboard suite** — /guild/join w/ specializations, /guild/profile earnings split, /guild/treasury, onboarding modals, 4 cache tables `(GUILD-INCENTIVE-SYSTEM parts 2–3)`
- **Achievement badge catalog** — milestone/category/role badges w/ rarity (First Task, Code Expert, Arbiter, Mentor…) `(badges.md, design/reputation-design §3)`
- **Manifest template service** — templates in dApp-definition metadata for agent/wallet discovery `(GUILD-VISION-2026; S1 cut #89 superseded)`
- **Projects + DAO-as-commissioner v2** — Project entity over tasks; DAO treasuries commission directly `(OVERHAUL-HANDOFF target arch; now PR B in TASK-TERMS-DESIGN)`
- **Game backend port** — `/api/v1/game/*` roll/state/achievements/leaderboard with 7 mandated security gates (session identity, CSPRNG dice, atomic roll budget, idempotent migration, `game` flag) `(dpsk-…game-backend-audit-2026-06-04, MIGRATION-PLAN 3c/5)`. ⚠️ **Corrected 2026-08-15: "routes don't exist yet" is FALSE** — `src/app/api/v1/game/{roll,state,leaderboard}/route.ts` all exist on `main` (the `achievements` route does not). The port is partly done, not un-started; the live-vs-gated status of the surface is the open question, and per PROJECT-STATE the game itself is **DARK** (audit-gated, prize vault outstanding)
- **Form/UX wave** — shared FormWizard (react-hook-form+zod), submission wizard, governance wizard w/ manifest preview, one-click review, progressive onboarding `(ux-simplification-research phases A–D)`
- **Competitive-research backlog** — T1: Cmd+K, manifest preview, tx toast · T2: Kanban/calendar views, tier widget · T3: reputation scoring, proposal simulator, batch actions, price feeds `(competitive-research-2026-06-07)`
- **Multi-token activation** — xUSDC/xUSDT never registered on the live component `(ESCROW-ADDRESSES)`
- **Real-time layer** — WebSockets (notifications, live votes, escrow status) `(architecture/ui-shells)`. ⚠️ **Corrected 2026-08-15: the "missing pages" half is FALSE** — `src/app/agents/page.tsx` and `src/app/disputes/page.tsx` both exist and ship (they landed as the D6/D7 community-docs pages, not as the registry/detail views this row imagined). WebSockets remain unbuilt
- **AccessController custody** — escrow owner badge → 7-day timed recovery `(ESCROW-DESIGN §7)`
- **SaaS multi-tenancy** — per-customer flags, `<tenant>.radixguild.com` open question `(MIGRATION-PLAN Q6)`

## D. Flagged ideas (never scheduled)

- **Agent Arena** (agent-vs-agent w/ escrowed prizes) · **Agent DEX trading challenge** (100 XRD, 7d) `(research/community-ideas)`
- **Subintent giveaways** — pre-signed claims as no-escrow task type; pattern mainnet-validated `(research/subintent-escrow-pattern)`
- **Scrypto CI/CD GitHub Action as first bounty** (50 XRD) `(research/scrypto-cicd)`
- **Agent fee-payment problem** — subintents vs sponsors vs Xi'an component-pays-fees; UNSOLVED `(research/fee-payment-problem)`
- **Badge recall as universal agent kill switch** — partially realized (runbook + recallable badges) `(research/badge-recall-agent-control)`
- **ElizaOS plugin** · **Wallet Agent AI (Linuxx)** · **Radix Codex plugin** integrations `(research/*)`
- **Agent roles economy** — Risk Taker / Fee Payer / Facilitator; Xi'an AgentAccount `(GUILD-VISION-2026)`
- **Welcome task w/ guaranteed reward, streaks, fast-completion multipliers, monthly leaderboard publishing** — strategic-plan W2; WelcomeTask component deleted dead `(strategic-plan)`
- **Kleros bridge** (tier-4 escalation, low priority) · **Treasury yield strategy** `(ADR-001 deferred)`
- **Xi'an coordination flywheel** — RDX Works pipeline partnership, agent teams 2027 `(THESIS)`

## E. Existed in the LAST VERSION (guild-public) — deleted or parked here

> Post-fold note (2026-08-14, slice A): the BadgeManager blueprint, agent-badge-controller and
> badge-admin scripts now live in THIS repo. The rest below (bot, /game, guild-public's
> guild-app) stayed in guild-public at that fold, and these rows refer to that repo.
>
> ⚠️ *Corrected 2026-10-02:* the bot did not stay. It was folded into this repository's `bot/`
> on 2026-09-29 (#813, a tree snapshot of guild-public's bot), and production has run it from
> there since 2026-09-30. The rows below that name guild-public's `bot/` describe that bot as it
> stood before the fold; the same code is this repository's `bot/` now, and its dice game is
> closed. /game and guild-public's own guild-app stay in guild-public.

- **/game dice game** — page + bot dice (weighted d6, bonus XP on governance actions, streaks, jackpots, leaderboard). Was live in guild-public (`guild-app/src/app/game/page.tsx`, `bot/db.js rollDice`); the page was never ported here, /game links removed (dpsk-7). **Port is pre-audited** with the 7 security gates (§C game backend) `(UNIFICATION-PLAN, MIGRATION-PLAN 3c)`. ⚠️ *Corrected 2026-10-02:* it is not live in this form anywhere. guild-public's app no longer serves (decommissioned 2026-07-03, per the operator's records), radixguild.com/game answers 404, and the folded bot's `/game` replies that the dice game is closed. The dice game now runs as its own project, Meme Grid, at memegrid.radixguild.com
- **Bot bounty store + 44-endpoint REST API + agent registration (API keys, caps, probation)** — guild-public `bot/`; decision: retire as parallel store, bot becomes /api/v1 client `(OVERHAUL decision 2)` (agent-api.md, which documented the retiring surface, was archived 2026-09-15, #622)
- **Agent client** (`packages/agent-client`) — `@radix-guild/agent-client`: self-custody ROLA client for the agent lifecycle (claim/submit/expire/dispute), extracted 2026-07-18 from the retired Archon fork; escrow manifests CI-gated byte-parity with guild-app
- **Trust scores Bronze/Silver/Gold** — the bot's own `/trust` participation score; metals vocabulary killed in the dashboard (#129/#130 backfill → member). ⚠️ *2026-10-02:* since the fold that bot is this repository's `bot/` (`bot/db.js`, tiers Bronze 0+ / Silver 50+ / Gold 200+), so the metals live on in Telegram while the dashboard's record says New / Established / Top Rated
- **Off-chain reputation/incentive engine** (`reputation.ts`/`incentives.ts`, newcomer→master ladder) — vestigial here (Leaderboard import only) ⚠️ THESIS still presents it as THE ladder
- **TaskEscrow V2 + V3 components** — guild-public, mainnet, bounty surface PAUSED May 2026; superseded by guild-marketplace-escrow (deprecate-don't-delete)
- **guild-escrow v1 blueprint** — still in this repo, deprecated `(ESCROW-DESIGN §12)`
- **ConvictionVoting CV2/CV3 blueprints** — blueprint sources in guild-public; **both mainnet components are the Guild's OWN.** CV2 is bigdev's April-2026 fork of the Radix Foundation's `consultation_v2` blueprint, which the Foundation itself never shipped to mainnet — package publish *and* instantiate were both fee-paid by the Guild operator master account, which also holds the owner role. Crediting the component to the Foundation, or tagging it third-party, is a banned claim (`guild-app/scripts/honest-copy.mjs`). **Both are now PARKED:** CV3 2026-07-18 (UI removed, #216), CV2 2026-07-31 pending the guild-saas-dao — copy-only. The `/decisions` web page that read CV2 was itself REMOVED 2026-09-04 (bigdev's instruction); reads continue only via the Telegram bot, and writes stay behind `FEATURE_CV2_WRITES`. Unpark from the chain-verified addresses in `ASSET-REGISTRY.md` (kept in the private operations repository), never from git history
- **BadgeManager blueprint** — canonical home is this repository's `badge-manager/` since the 2026-08-14 fold (it was guild-public's before)
- **Working groups** — full create/join/manage + WG budgets in guild-public (Model B: leads, charters, sunset dates). ⚠️ **Corrected 2026-08-15: "read-only /groups list here, de-emphasized" is FALSE as of `89e8d59` (#372).** Model B was ruled **buried, not extended** (2026-08-14, *"Defo A"*); `/groups` is now a native **Model A** surface — `working_groups` + `user_working_groups` (migration `0016`), `tasks.working_group_id` as the routing key, `GET /api/v1/groups`, `PUT|DELETE /api/v1/groups/[slug]/membership`, `GET /api/v1/groups/feed`, and the member feed leading the page. Spec: `design/working-groups-model-a.md` (kept in the private operations repository); steps 1–3 of its 8-step order are landed
- **Legacy bot proposals surface** — RadixTalk integration; stripped from governance here; old proposals = test data to archive. The dashboard's bot-fed Proposals stats and progress cards were cut 2026-08-21 (bigdev: *"less is more rn"*); `/decisions` went 2026-09-04. **The bot's 47-entry decision-tree programme itself was DELETED 2026-09-07 on bigdev's ruling** ("it is governance, we build only") — guild-public PR #143 removes it from the live bot; in this repo the `/guide` card, the `/docs` FAQ entry, `bot/db.js`'s table + seed, `scripts/seed-mvd-proposals.sql` and the two `drafts/` programme docs went with it (see PROJECT-STATE "Known cleanups").
- **PR auto-verify** — GH PR-merge watcher auto-verifying tasks + queueing release (`guild-public/bot/services/github.js`); not ported — natural fit with terms `repoUrl` + definition-of-done later. ⚠️ *2026-10-02:* the watcher's code is in this repository's `bot/` since the fold, for the bot's own legacy bounty rows; the app's tasks use the on-demand Verify PR check instead (`api/v1/submissions/[id]/verify-pr`)
- **Rich bot services** — escrow/conviction watchers, cv2-bridge, arbiter/insurance/tx-signer/content-filter/faq services; streamlined to 6 here (confirm-route + reconciler architecture replaced watchers). ⚠️ *2026-10-02:* since the fold, this repository's `bot/services/` is the folded bot's own set (31 modules)
- **agent-tools (OMX/OmO/Clawhip)** — guild-public only
- **Internal deletions (P1/P2, 2026-06-09)** — /dashboard + sidebar shell, React ConnectButton, WelcomeTask, `lib/api.ts` bot client, mock-data, orphaned members/settings schemas — 0-importer deletes, recoverable pre-#127/#129
- **Old :3002 deployment** — rollback target, decommission queued (W2). ⚠️ *2026-10-02:* decommissioned 2026-07-03, per the operator's records

## F. Open findings / debt (live list — OVERHAUL-HANDOFF is canonical)

- ~~Keeper cron missing (disputed funds rely on a UI click); operator key-custody decision gates it~~ ⚠️ **STALE 2026-08-15** — the keeper cron is **installed** (every 30 min, `/var/log/guild-keeper.log`), alongside the drift watcher (`:00/:30`) and the reconciler (`:15/:45`). The key-custody question was *decided*, not left open: keeper is **watch-only**, no `KEEPER_*` key in prod. "Disputed funds rely on someone clicking Finalize" is still true and is the design, not a gap
- Finding 8: self-dealing allowed + FavorDisputeRaiser first-mover-wins → fix at re-instantiation
- ~~12 Gateway-dependent e2e specs flake as a group~~ fixed via chain-stub (#157) · pre-slice-2 disputes lack marker rows (0 affected)
- /admin + /deploy-escrow ungated (nav-only) · /guide duplicates /docs
- P4 dual stores (bot SQLite ∥ app Postgres; profile reads two stores)
- Multi-replica: in-memory nonces + per-instance rate limits; ROLA origin build-time constant
- xUSDC/xUSDT unregistered on live component · ~~lint frozen-red 13~~ (clear since — see §A's lint note, 2026-10-03) · submissions "attachments coming soon" stub
- CV2 reads only — writes have never been enabled (ABI unverified, audit CRITICAL-1) and CV2 is PARKED 2026-07-31 pending the guild-saas-dao · escrow owner badge = single-badge SPOF (no AccessController)

## ⚠️ Cross-doc contradictions (resolve before open-up)

1. **Three agent-auth models** coexist: API-key bot API (agent-api.md) vs x402 no-key (GUILD-VISION) vs ROLA-session badges (agent-auth-design.md, **ACCEPTED** — the other docs need deprecation banners).
2. **Arbiter economics**: docs sell a paid arbiter market; deployment is 0%-fee auto-resolve-only. Re-instantiation + TASK-TERMS arbiter fee is the convergence path.
3. **Two reputation ladders**: on-chain member→elder (canonical) vs newcomer→master score engine (vestigial; THESIS leads with it). Trust tiers (TASK-TERMS §4) are now the user-facing axis — PR C swapped the leaderboard's newcomer→master chip for trust chips; remaining: deprecate the score engine + fix THESIS framing.
4. **Mission framing**: cooperative revenue-share economy (GUILD-VISION/PROJECT-COMPONENTS — Registry/Treasury/Settings/Curve all unbuilt) vs the live "DAOs decide, the Guild builds" execution layer (UNIFICATION/OVERHAUL). Pick deliberately at open-up.
