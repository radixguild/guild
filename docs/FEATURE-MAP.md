<!-- status: live
     verified: 2026-10-08 (SCOPED: §F's admin-gate, finding-8, P4, multi-replica, xUSDC/xUSDT,
     attachments-stub, CV2 and owner-badge entries, §B's "P1 leftovers" route-gate half, §C's
     paid-arbiter note, and the cross-doc contradictions block ONLY, against guild-app/src, bot/,
     packages/agent-client, the escrow and badge-manager blueprints, STATE.md,
     tests/e2e/admin-gate.spec.ts, Gateway reads taken that day of the live escrow component, its
     owner badge and the badge factory's package (ledger state versions 561618678, 561624973 and
     561629697), and GETs of the live /admin and /deploy-escrow. §F's "/admin + /deploy-escrow
     ungated (nav-only)" was half false: /admin is operator-badge-gated, /deploy-escrow is not
     (it asks only that some wallet be connected), and the `admin` flag over both is on in
     production. Only the /admin half is struck; each other entry named
     here is marked in place with what still holds.
     Contradictions #1 and #3 are recorded as decided; #2 and #4 stay open for an operator
     ruling. §F's keeper, e2e-flake and /guide entries were not re-checked; nor was anything
     else in this file.)
     verified: 2026-10-06 (one phrase in §B's keeper row: "the trustless guarantee" now reads
     "the guarantee that needs no operator signature", which is what that decision meant;
     "trustless" is banned copy. Nothing else re-checked.)
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
- **Keeper = WATCHER, not signer** — bigdev decision 2026-06-11 (supersedes the same-day auto-sign activation): NO platform-initiated signing on the money path; the on-chain PUBLIC auto_resolve is the guarantee that needs no operator signature, and the winner triggers it from their own wallet. Cron runs keeper.mjs (kept in the private operations repository) watch-mode every 30 min (detect + verify events + Telegram alert); no KEEPER_* key in prod env. Alerts dormant until `KEEPER_ALERT_TG_CHAT` is set (same chat id wanted for backup alerts)
- **W2 ops** — fund 2 pilot agents (~15 XRD), mint MEMBER badges, decommission `:3002`
- **Private pilot** — bigdev + 2 worker agents until humming; then 5-user invite + announce
- **Agent client merge** — ✅ DONE and superseded: all legs landed on the fork's `main` (#24/#26/#30/#31), then the whole client was **extracted in-repo 2026-07-18** → `packages/agent-client` (`@radix-guild/agent-client`, 96 tests, CI-gated manifest parity)
- **Component re-instantiation BEFORE open-up** — §8b DECIDED + staged 2026-06-11 (#164): self-claim assert in the vNext blueprint, wallet steps threaded on /deploy-escrow, cutover gated on task-2 settle + task-4 cancel. Per-task deadline OUT (§7 Q2 — create_task ABI stays stable). Remaining: bigdev wallet session → 5-env swap → money smoke
- **Terms engine / projects tab / trust tiers / PR auto-verify** — TASK-TERMS-DESIGN PRs A–D ALL MERGED to main 2026-06-11 (#157, #161 [recreated #158], #159, #160)
- **P4** — bot becomes /api/v1 client, retire bot SQLite store, then third-party agent auth
- **P5** — ROLA nonce → shared store, shared rate limits, request-derived origin, full E2E smoke
- **e2e flake group** — FIXED: stubChainData() pins Gateway/bot-API fetches (rode #157)
- **P1 leftovers** — collapse /guide→/docs; route-gate /admin + /deploy-escrow (needs operator-badge signal in useWallet). ⚠️ *2026-10-08:* the route gate is half done, by another route than this one: /admin checks the operator badge in the page itself (`AdminGate`), not in useWallet; /deploy-escrow asks only that some wallet be connected; it never checks for the operator badge, so any connected wallet sees the tooling. The `admin` flag both pages sit behind is on in production, so it hides neither. Details in §F
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
- **Paid arbiter market** — recallable arbiter badge, dispute-bounty pool earning `arbiter_fee_pct × insurance` `(architecture/dispute-resolution, SPRINT-1.5)` ⚠️ deployed reality is 0%-fee auto-resolve-only. ⚠️ *2026-10-08:* no longer auto-resolve-only. The fee half holds for app-funded tasks (0%); the component allows up to the owner-set 10%. See the contradictions block, #2
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
- Finding 8: self-dealing allowed + FavorDisputeRaiser first-mover-wins → fix at re-instantiation. ⚠️ *2026-10-08:* the re-instantiation has happened (Wave B, cutover 2026-09-13 — `STATE.md`, "Live today"), and it settled one half. **First-mover-wins is no longer the default:** the live component's `dispute_auto_resolve_default` reads `SplitEvenly` (Gateway, 2026-10-08), and `FavorDisputeRaiser` survives only as one of four variants the owner may select through the owner-only `set_dispute_auto_resolve_default` (escrow `lib.rs`, `enum AutoResolveDefault`). **Self-dealing is still open:** `claim_task` refuses a worker account equal to the task's poster (`lib.rs`, the `self-claim not allowed` assert), but the poster is a free parameter of `create_task`, so one person with two accounts passes it. The blueprint's own comment calls that assert an honest-mistake guard and nothing more
- ~~12 Gateway-dependent e2e specs flake as a group~~ fixed via chain-stub (#157) · pre-slice-2 disputes lack marker rows (0 affected)
- ~~/admin +~~ /deploy-escrow ungated (nav-only) ⚠️ *Corrected 2026-10-08: half false — /admin is operator-badge-gated, /deploy-escrow is not.* **/admin** withholds its tooling until the connected wallet holds the operator badge, and fails closed when the Gateway cannot answer (`AdminGate` in `guild-app/src/app/admin/page.tsx`; `guild-app/tests/e2e/admin-gate.spec.ts` pins the disconnected, holder, non-holder and Gateway-failure cases). That is a client-side gate; the on-chain operator badge is the enforcement. **/deploy-escrow** asks only that some wallet be connected (it shows "Connect your wallet first." until one is); it never checks for the operator badge, so any connected wallet sees the tooling, and the page is reachable by URL in production. Both pages call `notFound()` only when the `admin` flag is off (`if (!isEnabled("admin")) notFound()` in each page; `src/lib/features.ts`), and the flag defaults on and is on live: both pages answered 200 on 2026-10-08. Neither is in the nav or the sitemap, so "nav-only" is exact. What guards /deploy-escrow is on-chain. Three of the calls it builds need a badge the signer must already hold: registering a token needs the escrow's owner badge (`add_accepted_token`, owner-only in the escrow `lib.rs`); minting an arbiter badge needs the manager's admin badge (`mint_badge`, `restrict_to: [admin, OWNER]` in the badge-manager `lib.rs`); and creating the arbiter badge collection needs the factory badge as the page builds it. The factory does not ask for that badge (`create_manager` is public on the live package, Gateway 2026-10-08), but the page's manifest opens with a `create_proof_of_amount` of it from the connected account, kept for parity with an earlier transaction (`createArbiterManagerManifest`), and that step fails for an account that does not hold it. Instantiating the agent-badge controller only creates a component whose badges land in the connected account. The escrow-instantiate step builds no transaction at all as wired: the page calls `instantiateEscrowManifest` without its two ceremony arguments, so it throws `no value for instantiate arg 12 (claim_bond_floor)` before anything reaches the wallet (the page already marks that step stale). `NEXT_PUBLIC_FEATURE_ADMIN=false` plus a rebuild removes both pages · /guide duplicates /docs *(not re-checked 2026-10-08)*
- P4 dual stores (bot SQLite ∥ app Postgres; ~~profile reads two stores~~) ⚠️ *2026-10-08:* still two stores — the bot keeps its own SQLite database (`bot/db.js`, better-sqlite3) beside the app's Postgres, and it has not become an `/api/v1` client. The profile half is gone: the profile page reads the app's own `/api/v1` and the Radix Gateway, never the bot (`guild-app/src/app/profile/[address]/page.tsx`), and nothing in the app reads the bot's API (`BOT_API_URL`, `src/lib/config.ts`)
- Multi-replica: in-memory nonces + per-instance rate limits; ROLA origin ~~build-time constant~~ ⚠️ *2026-10-08:* still true for the row; only "build-time" was wrong, as the origin is read from `ROLA_EXPECTED_ORIGIN` once per process, at run time. ROLA challenges live in a process-local `Map` (`const store = new Map` in `guild-app/src/lib/rola.ts`), the auth rate limiter's hits in another (`const hits = new Map` in `createRateLimiter`, `src/lib/rate-limit.ts`), and the expected origin is fixed when `rola.ts` loads, with the canonical origin as default (`getExpectedOrigin()`, passed to `Rola()`), not derived from the request. A second app instance would need a shared store for both
- xUSDC/xUSDT unregistered on live component ⚠️ *2026-10-08:* still true — the live component's `accepted_token_addresses` holds XRD alone (Gateway, 2026-10-08), which is what the site says (`src/lib/settlement-copy.ts`) · ~~lint frozen-red 13~~ (clear since — see §A's lint note, 2026-10-03) · ~~submissions "attachments coming soon" stub~~ ⚠️ *2026-10-08:* gone — no "coming soon" copy and no file input anywhere under `guild-app/src` (grep). Submissions take no attachments, and no page promises them
- CV2 reads only — writes have never been enabled (ABI unverified, audit CRITICAL-1) and CV2 is PARKED 2026-07-31 pending the guild-saas-dao ⚠️ *2026-10-08:* still parked, still no writes. The app has no CV2 write surface left at all (`FEATURE_CV2_WRITES` in `src/lib/config.ts` has no consumer, and /decisions is gone), and the bot's `/cv2` answers "parked" unless the bot runs with `CV2_ENABLED=true` (the `/cv2` command in `bot/index.js`; the `CV2_ENABLED` check in `bot/services/consultation.js`). On the ABI the code disagrees with itself: `src/lib/features.ts` records the vote builder re-checked against the canonical Rust on 2026-07-23, leaving "untested live" as the residual, while the comment above `CV2_COMPONENT` in `src/lib/config.ts` still says unverified · escrow owner badge = single-badge SPOF (no AccessController) ⚠️ *2026-10-08:* still true. The live component's owner rule requires one badge; one unit exists, in one account, and that account is not secured by an AccessController (Gateway, 2026-10-08). The owner role is updatable since Wave B (`OwnerRole::Updatable` in the escrow `lib.rs`), and moving the badge behind an AccessController is a signed transaction, not a re-instantiation

## ⚠️ Cross-doc contradictions (recorded before the repository went public on 2026-10-03; re-checked 2026-10-08: #1 and #3 decided, #2 and #4 open)

1. **Three agent-auth models** coexist: API-key bot API (agent-api.md) vs x402 no-key (GUILD-VISION) vs ROLA-session badges (agent-auth-design.md, **ACCEPTED** — the other docs need deprecation banners).
   ✅ *Decided (re-checked 2026-10-08): the ROLA-session model is the one that ships.* The agent kit signs in with a ROLA challenge against `/api/v1/auth/challenge` and `/api/v1/auth/verify` (`packages/agent-client/src/api.ts`, `rola.ts`) and signs every escrow leg with the agent's own key (`STATE.md`, "An agent acts as a badge it holds"). **x402 is dormant:** the rail in `guild-app/src/lib/x402/` stays off unless the server runs with `X402_ENABLED=true` (`config.ts`), and `/.well-known/x402.json` answers 404 either way, because no paid resource exists (the 2026-09-02 ruling recorded in that route). **The API-key model is legacy:** agent-api.md was archived 2026-09-15 (#622, §E); the bot's key-gated `/api/agent/*` bridge still runs, but only an admin issues keys, in Telegram, and its task-write legs are off behind `FEATURE_LEGACY_BOUNTY` (`bot/services/api.js`, `bot/services/feature-flags.js`); no shipped client calls it. Still owed: `GUILD-VISION-2026.md`'s "Agent Economy" section presents x402 payments and "no API keys" as how agents take part, with no banner.
2. **Arbiter economics**: docs sell a paid arbiter market; deployment is 0%-fee auto-resolve-only. Re-instantiation + TASK-TERMS arbiter fee is the convergence path.
   *Open — operator ruling. Facts as of 2026-10-08:* the re-instantiation has happened (Wave B, 2026-09-13), and the deployment is no longer auto-resolve-only: it carries an arbiter path with one operator-held arbiter badge, and an arbiter ruling has settled on the live component (2026-09-14) (`STATE.md`, "Disputes"). The fee half holds only for app-funded tasks: each task names its arbiter fee at `create_task`, under an owner-set maximum (escrow `lib.rs`; 10% on the live component, Gateway 2026-10-08), and tasks funded through the app set it to 0% (`src/lib/escrow-utils.ts`). Whether a paid arbiter market follows is the question still open.
3. **Two reputation ladders**: on-chain member→elder (canonical) vs newcomer→master score engine (vestigial; THESIS leads with it). Trust tiers (TASK-TERMS §4) are now the user-facing axis — PR C swapped the leaderboard's newcomer→master chip for trust chips; remaining: deprecate the score engine + fix THESIS framing.
   ✅ *Decided (re-checked 2026-10-08): trust tiers are the user-facing axis.* The leaderboard shows New / Established / Top Rated (`guild-app/src/components/Leaderboard.tsx`, labels in `src/lib/trust.ts`), and nothing outside `src/lib/reputation.ts` calls its newcomer→master level or label helpers. THESIS.md now opens with a banner naming that table the vestigial ladder. What is left of the score engine is plumbing, not a ladder: `reputation.ts` still supplies the reputation points credited at payout (`src/lib/escrow-confirm.ts`, `completionAward`) and the leaderboard's badge milestones.
4. **Mission framing**: cooperative revenue-share economy (GUILD-VISION/PROJECT-COMPONENTS — Registry/Treasury/Settings/Curve all unbuilt) vs the live "DAOs decide, the Guild builds" execution layer (UNIFICATION/OVERHAUL). Pick deliberately at open-up.
   *Open — operator ruling (re-checked 2026-10-08).* None of Registry, Treasury, Settings or Curve exists as a blueprint here (`blueprints/`, `escrow/scrypto/`, `badge-manager/scrypto/`), and `GUILD-VISION-2026.md` and `PROJECT-COMPONENTS.md` still present the cooperative economy as the model (GUILD-VISION's banner names this tension).
