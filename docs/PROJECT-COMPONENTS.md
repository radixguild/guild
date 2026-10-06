<!-- status: live
     verified: 2026-10-06 (one phrase: §3's "Problem it solves" no longer opens "Trustless
     payment" — banned copy (honest-copy.mjs), because a single operator-held arbiter rules
     disputes and the owner badge can change settings. Nothing else re-checked.)
     verified: 2026-10-03 (SCOPED, on top of the 2026-10-02 line below: §3's `lib.rs` line anchors (701,
     2273), the 15-argument `instantiate` signature, the test counts (101 + 30, none ignored), the line
     count and the "NftSwap changed `lib.rs` by one `pub mod` line" claim, re-read in this tree; the
     live address default in `config.ts`. The chain-read parts of §3 (arbiter supply, royalty) were
     NOT re-read.)
     verified: 2026-10-02 (SCOPED: §2 rewritten for the 2026-09-29 bot fold, against bot/ in this
     repository, bot/README.md and the live edge; §3's "How it works" dispute and instantiate
     lines and its status line corrected against lib.rs, tests/ and the live Wave B component on
     the Radix Gateway; a dated note on the reality-check table (disputes, GAGENT supply) and the
     "Two surfaces" bot bullet. Nothing else re-checked this pass.)
     verified: 2026-09-30 (one link only: bot/db-pg.js was never folded into this repo, so it is named, not linked; nothing else re-checked)
     verified: 2026-08-23 (narrow re-check: the dashboard entry's "BUG-7 is open … PULL redesign
     has not cut over" claim against escrow/…/lib.rs post-PULL-cutover — corrected in place. The
     2026-08-15 pass, kept below, checked the "Built today" entries and the §Reality-check table
     against origin/main, radixguild.com's live state and PROJECT-STATE.md; two false claims
     found and corrected — both said the dashboard's on-chain wiring does not work, contradicted
     by a mainnet-proven end-to-end money path. The cooperative-model framing and the
     §"Planned but not built" list were re-read and are still accurate: none of
     GuildRegistry / GuildTreasury / GuildSettings / TaskFundingCurve exists.)
     2026-08-29: narrow re-check of the dispute-state claim ONLY — corrected from "dispute UI compiled OFF / disputes MOCK-ONLY" to LIVE (PR #465, gate inverted). Nothing else in this doc was re-verified.
     2026-09-08: narrow re-check of the Telegram bot entry's relative links ONLY — its "What it
     is"/"How it works" body linked `bot/services/api.js`, `bot/db.js`, `bot/services/xp.js` and
     `bot/db-pg.js` as this repo's own paths; three no longer exist here at all (deleted, PR #496,
     2026-09-03/07) and the fourth (`bot/db.js`) does still exist in this repo but is the
     decommissioned remnant kept only for two operator CLIs, not the live schema the prose
     describes. All four re-pointed to plain-text `guild-public/bot/...` — this entry's own
     heading already said the description is of guild-public's live bot; the links didn't match
     it. Nothing else in this doc was re-verified today.
     supersedes: none (pre-dates the header rule) -->

# Guild — Project Components

> Per-component clarity reference. Read this before starting a new engineering session — it explains *what each thing is*, *how it works*, and *what problem it solves* in a single place, so future sessions don't have to re-derive the picture from twelve different docs.
>
> Maintained by: bigdevxrd. Canonical product vision: [GUILD-VISION-2026.md](./GUILD-VISION-2026.md). Architectural foundations: [decisions/ADR-001-architectural-foundations.md](./decisions/ADR-001-architectural-foundations.md). Deploy gates: [decisions/ADR-002-escrow-deploy-and-integration-gates.md](./decisions/ADR-002-escrow-deploy-and-integration-gates.md).

---

## The umbrella

**Guild is an on-chain developer cooperative on Radix.** Not a bounty board, not a DAO with a token, not a "marketplace" in the gig-economy sense. The mental model is **co-op first**: members co-own the infrastructure they build, earn reputation through contribution, share in revenue when the components they built get used, and collectively govern every parameter that shapes the system.

The marketplace mechanics (post task → claim → ship → get paid) are how members exchange work — but the **cooperative is the model** ([GUILD-VISION-2026.md](./GUILD-VISION-2026.md)):

- **Reputation is the membership currency.** No governance token, ever ([THESIS.md](./THESIS.md), Design Maxim 1).
- **Revenue share over winner-take-all.** Royalties on every component the cooperative ships flow to GuildTreasury, then to contributors proportional to reputation-weighted contribution (Design Maxim 5).
- **Co-ownership of infrastructure.** Members fund tasks through bonding curves and collectively own the components they crowdfund into existence.
- **Agents are members.** Humans and AI agents use the same primitives (badges, escrow, reputation). No special-case agent mode (Design Maxim 6).

The flywheel:
```
Join free → earn reputation through tasks → reputation unlocks revenue share
  → royalties on shipped components → fund new tasks via bonding curves
  → attract more builders → more components shipped → more royalties → cycle
```

The seven design maxims ([GUILD-VISION-2026.md:238](./GUILD-VISION-2026.md)) — reputation over tokens, on-ledger over off-chain, templates over integrations, unbundle over batch, **cooperative over competitive**, agents are members, settings over hardcoding — hold across every component below.

---

## Built today

### 1. Dashboard — `guild-app/`

**What it is.** Next.js 16 (App Router, React 19, Tailwind v4, shadcn/ui) web app at radixguild.com. The primary surface for members to mint a badge, post and claim tasks, see the leaderboard, and inspect their profile. Backed by Postgres + Drizzle for off-chain task state. Wallet integration via Radix dApp Toolkit (ROLA).

**How it works.** User connects wallet → API routes at `/api/v1/*` mediate between UI and Postgres → manifest builders in [lib/manifests.ts](../guild-app/src/lib/manifests.ts) construct on-chain transactions that the user signs in their wallet. Per ADR-002, the DB is *downstream* of chain state: every status change that affects funds (claim, submit, approve, dispute) must originate from an on-chain transaction; the DB is a cache, never the source of truth.

**Problem it solves.** A human-friendly surface for the cooperative's day-to-day work. Without it, every interaction is a hand-written transaction manifest. With it, members can browse work, post bounties, and ship without leaving the browser.

⛔ **Corrected 2026-08-15 — the status sentence here was FALSE.** It read: *"Current status: ~10% functional — the UI exists but the on-chain wires don't connect yet. DPSK is fixing this as Sprint 1.5; ~85% functional after S1.5 + M-Deploy."* The wires connect. **radixguild.com is live and the human-to-human money path is mainnet-proven end-to-end** — connect (verified dApp, Dev Mode OFF) → mint → post → fund → claim → submit → approve → release, chain-verified with value conserved, DB `paid` matching chain `Released`, drift 0. Sprint 1.5 and M-Deploy are long done. Honest residue, so this doesn't over-correct in the other direction: the **dispute UI is compiled OFF** in production and gated off by `scripts/launch-check.sh` (the deploy gate, kept in the private operations repository). ⚠️ *Corrected 2026-08-23:* this sentence used to also say "BUG-7 is open (settlement returns funds via the caller's manifest…)" and "the PULL redesign has not cut over" — both were true 2026-08-15 and are not now. **The PULL cutover happened 2026-08-17** (`component_rdx1cz468e…`); settlement no longer routes through the caller at all, and BUG-7's mechanism is closed structurally (see `AUDITOR-GUIDE.md` §6). ⚠️ *Corrected again 2026-08-29:* "the dispute UI is compiled OFF in production and gated off by `scripts/launch-check.sh`" is now FALSE in both halves. **Disputes shipped LIVE 2026-08-29** (PR #465) and the gate was **INVERTED** — a disputes-OFF build now fails the deploy. There is no dispute-UI residue left to report.

### 2. Telegram bot — `bot/`

⚠️ **Rewritten 2026-10-02.** From 2026-08-09 this entry said that this repository's `bot/` was a
vestigial fork that deployed nowhere, and it described the bot in the separate `guild-public`
repository instead. The fold ended that: the live bot was copied into this repository's `bot/`
on 2026-09-29 (a tree snapshot, no history), and production has run it from here since the
2026-09-30 cutover. The old description (bonus-XP dice on every governance action, agent
registration, a Postgres reader) did not match that bot. [`bot/README.md`](../bot/README.md) is
the maintained description.

**What it is.** Grammy + Node.js + SQLite: [@radix_guild_bot](https://t.me/radix_guild_bot), the
Guild's front door in Telegram. It explains what the Guild is, links a Telegram account to a
Radix wallet, points people at their badge, and routes every task and money action to the web
app, because Telegram cannot sign transactions. It also serves a small HTTP API on
`127.0.0.1:3003`; in production only its Bearer-gated `/api/agent/*` routes are reachable from
the internet.

**How it works.** `bot/index.js` registers the command handlers and runs the long-poll loop;
`bot/db.js` is the SQLite schema; `bot/services/` holds one module per concern — `copy.js` the
user-facing text, `menu.js` the command list, `escrow-watcher.js` the on-chain escrow notices,
`api.js` the HTTP API. The dice game is closed. The bot does not read the dashboard's Postgres:
`db-pg.js`, the parallel reader added in guild-public PR #93, was not part of the fold.

**Problem it solves.** Most Radix community lives in Telegram. The bot meets people there — setup
help, badge checks, support and the optional community votes (proposals, polls and temperature
checks) — and sends them to the dashboard, where money moves.

### 3. Marketplace escrow — `escrow/scrypto/guild-marketplace-escrow/`

**What it is.** ~3,500-line Scrypto blueprint ([lib.rs](../escrow/scrypto/guild-marketplace-escrow/src/lib.rs)); since 2026-09-15 the same crate also carries the NftSwap blueprint (`src/nft_swap.rs`). Singleton component (one deploy, all tasks routed through it). Multi-token, dual-vault (reward + insurance), pluggable arbiter, agent-aware timers, `claim_bond` + expire / cancel-after-claim lifecycle, three dispute rulings, time-gated auto-resolve ([escrow/README.md](../escrow/README.md), [ESCROW-DESIGN.md](./ESCROW-DESIGN.md)).

**How it works.** `instantiate` mints an owner badge and a separate royalty-admin badge, returns both to the deployer, and takes 15 positional arguments: the worker-, arbiter- and optional agent-badge resources plus 12 settings ([lib.rs:701](../escrow/scrypto/guild-marketplace-escrow/src/lib.rs#L701)). Posters call `create_task` with reward + insurance; workers `claim_task` proving guild-badge ownership; either party can `raise_dispute`; the arbiter-badge holder can `resolve_dispute` and take up to `arbiter_fee_pct × insurance` ([lib.rs:2273](../escrow/scrypto/guild-marketplace-escrow/src/lib.rs#L2273)). The arbiter role was designed as a *public bounty market* — third-party members picking up disputes for the insurance fee — and that is not what runs: ⚠️ *(corrected 2026-10-02)* the live arbiter badge has a supply of one, cannot be withdrawn from its account, and is held by an account the operator controls, and the arbiter fee is 0 on every task the app funds. See [architecture/dispute-resolution.md](./architecture/dispute-resolution.md): its §0 is how a dispute is resolved today; the rest is the original four-tier model and the qualified-arbitrator pool design.

**Problem it solves.** Payment between strangers who can't see each other's deliverables until after the money's locked. Without escrow, every task is "ship and pray it pays" or "pay and pray it ships." The insurance vault was also designed to **fund dispute resolution as a market** rather than as a privileged operator role — anyone with the arbiter badge earning fees by resolving disputes well; today there is one arbiter badge, the operator's, and the fee is 0 on app-funded tasks (above). **Current status (re-checked 2026-10-02): live as Wave B, `component_rdx1czka5…hp88yly`, since 2026-09-13.** It was built from this crate before the NftSwap module was added on 2026-09-15, and the escrow's own code is unchanged since (that change added only `pub mod nft_swap;` to `lib.rs`). Earlier components are retired: v1 `…cz9mh49` (2026-06-03), vNext `…cr690h` (2026-06-14) and the first pull-settlement component `…akd82f` (2026-08-17 → 2026-09-13). The suite is **101 `#[test]`s** in `tests/lib.rs` plus 30 in `tests/nft_swap.rs`, none `#[ignore]`d; "passing" is deliberately not asserted here, because ledger tests run in CI. The live addresses are the defaults in `guild-app/src/lib/config.ts`. ⚠️ *(Corrected 2026-10-02: until today this line said vNext was live and that `main` was a pull-settlement rewrite awaiting its cutover. That cutover happened on 2026-08-17, and Wave B replaced its component on 2026-09-13.)*

### 4. Guild badge NFT + badge manager

**What it is.** On-chain membership resource (`resource_rdx1n22rq94kh6ugwnrvc65m...`) minted by the Badge Manager component (`component_rdx1czexylvvm0q4uhwpjaqmlznj9sd3y2jnmmah6qug9lm9sfm3tyrtva`). Free public mint. **Uniqueness is per username, not per account** — `public_mint(username)` takes a username and nothing else, never sees the caller's account, and derives the NFT id as `<schema>_<sanitised username>` ([badge-manager/scrypto/radix-badge-manager/src/lib.rs:195,287](../badge-manager/scrypto/radix-badge-manager/src/lib.rs) — source folded into THIS repo from guild-public 2026-08-14). One account can therefore hold as many badges as it cares to mint. Stores tier (member/contributor/builder/steward/elder) + XP as NFT data ([guild-app/src/lib/schemas.ts](../guild-app/src/lib/schemas.ts)).

**How it works.** User clicks "mint" on the dashboard or types `/mint` in the bot → signs the `public_mint` manifest → badge NFT appears in wallet. Tier and XP update via admin-badge-gated `update_tier` / `update_xp` calls. The marketplace escrow gates `claim_task` on this badge resource ([lib.rs](../escrow/scrypto/guild-marketplace-escrow/src/lib.rs)) — you need a badge to take work, but `public_mint` presents no proof and takes only a username, so anyone can mint one for the network fee and one person can mint many. The badge is **transferable, permanently**. Chain-verified 2026-07-31 on `resource_rdx1n22rq94kh6ugwnrvc65m...`: `withdrawer` and `depositor` are `AllowAll` and `recaller` is `DenyAll`, with **every** `*_updater` role `DenyAll` — so this resource can never be made soulbound, and a badge can never be clawed back either. A steward or elder badge, with its accrued XP, can be sent or sold to any account. Soulbound reputation would need a new resource plus a holder migration.

**Problem it solves.** A portable, on-chain anchor for membership identity. Reputation is the cooperative's currency (per Design Maxim 1); without an on-chain anchor for it, you're back to off-chain follower counts and trust-me-bro. The anchor is weaker than the maxim assumes, though: because the badge is transferable (above), reputation is non-transferable **by guild policy only**, not by the resource's role assignments — the same caveat the dashboard already gives cold users at [about/page.tsx:53](../guild-app/src/app/about/page.tsx). The badge is the same primitive humans and agents use ([THESIS.md](./THESIS.md) "Agents are members").

### 5. Agent client — `packages/agent-client/`

**What it is.** `@radix-guild/agent-client` — the TypeScript client an autonomous agent uses to run the full Guild lifecycle: discover tasks, claim (post the bond), do the work, submit (evidence), and raise/resolve disputes. It is a **self-custody** client — the agent holds its own key and signs the on-chain escrow legs directly ([packages/agent-client/README.md](../packages/agent-client/README.md)). Extracted 2026-07-18 out of a retired fork of coleam00/Archon into this repo; its escrow manifests are held **byte-identical to the app's builders by a CI-gated parity test**.

**How it works.** Headless ROLA auth — the agent signs the server's challenge locally with its ed25519 key (no API key, no Bearer token, no wallet popup) for a JWT session. The on-chain legs (`claimTaskOnChain` / `submitTaskOnChain` / `expireClaimOnChain` / dispute) build real Radix manifests, sign with the agent's derived key, submit to the Gateway, and confirm — keeping the escrow ledger in parity with the chain. HD fleet derivation (`bun run derive`) mints a capped agent account per index from one seed. The agent brings its **own** work function (`GUILD_DOWORK_CMD`) — the client is framework-agnostic and ships no agent.

**Problem it solves.** A first-class, self-custody path for agents into the cooperative — the same escrow + badge primitives humans use, driven programmatically, with the money-path manifests guarded against drift. "Agents are members" made concrete. First-mover positioning: **Radix has near-zero agent-client coverage today** ([GUILD-VISION-2026.md:195](./GUILD-VISION-2026.md)).

---

## Planned but not built (the §6 list)

Four Scrypto components are in the vision but don't exist yet. ADR-001 §Sprint 2 starts them, M-Deploy unblocks the deployment path.

| # | Component | What | How | Problem it solves |
|---|---|---|---|---|
| 6 | **GuildRegistry** | On-chain member registration, tier management, reputation accumulation outside the badge | Members register once; the component stores tier, decay state, and aggregate reputation in keyed storage. Tier transitions emit events the dashboard + bot subscribe to. | Bot's SQLite users table doesn't survive a bot rebuild; reputation needs to live on-ledger to be portable across UIs and resistant to off-chain tampering. |
| 7 | **GuildTreasury** | Vault-only component that collects escrow platform fees + component royalties, distributes proportional to reputation | Distribute called on a configurable schedule; reads reputation from GuildRegistry, splits the vault accordingly, sends to member accounts. | The cooperative revenue-share mechanic in the flywheel needs a vault that isn't a personal wallet. This is the *cooperative-over-competitive* maxim made operational. |
| 8 | **GuildSettings** | Every parameter from VISION-2026 §Settings stored on-ledger; mutable only through governance | Setting changes are timelocked proposals; quorum / threshold / timelock per parameter are themselves settings, all mutable through their own governance loop. | Hardcoded parameters mean every tweak is a redeploy. Insurance fraction, dispute window, tier thresholds, royalty cuts — all need to be governance-mutable for the cooperative to actually self-govern. |
| 9 | **TaskFundingCurve** | Bonding-curve crowdfunding for tasks larger than one funder can absorb | Funders deposit XRD; early funders get a better price; tasks fund only when the threshold is hit; refund flow for tasks that don't reach the bar. | A single-funder model caps task size to what one person will risk. Bonding-curve funding lets the cooperative collectively decide which work is worth doing by **voting with their wallets**. Crucial for funding the >500 XRD work that justifies milestone escrow. |

---

## Reality check — built vs functional

⛔ **Corrected 2026-08-15: the "Functional today" column is from the pre-cutover era and two of
its cells are FALSE.** *"Task post → claim → submit (dashboard): DB-only (lies about on-chain
state)"* — it does not; every money-affecting status change originates from a verified on-chain
event and the full lifecycle is **mainnet-proven**. *"Agent SDK end-to-end: endpoints work, no
real flow"* — an agent ran the **whole money path live on mainnet, headless, 2026-07-22** (Gate-1,
on the member badge; the dedicated GAGENT badge is deployed with supply 0). The "Dispute lifecycle
— unwired" cell is the one that is still broadly right, and for a *different* reason than this
table gives: the UI is deliberately compiled OFF pending the PULL cutover. Read the columns to the
right as the 2026-06 plan, not as a forecast — the sprint frame they name was superseded by the
gate model and then by `EXTERNAL-V1-FRAMEWORK.md` (kept in the private operations repository).
⚠️ *(Corrected 2026-10-02: the dispute
lifecycle is wired now too — disputes have run in the app since 2026-08-29 — and the GAGENT
badge's on-chain supply has been 1 since 2026-09-14.)*

| Layer | Designed | Functional today | After M-Deploy + S1.5 | After Sprint 2 + 3 |
|---|---|---|---|---|
| Badge mint | yes | yes | yes | yes |
| Bot governance loop | yes | yes | yes | yes |
| Task post → claim → submit (dashboard) | yes | DB-only (lies about on-chain state) | real settlement | + reputation gates from Registry |
| Dispute lifecycle | yes | unwired | wired, public arbiter market | + reputation-weighted arbiter selection |
| Agent SDK end-to-end | yes | endpoints work, no real flow | end-to-end with real escrow | + agent vault funding |
| Treasury revenue share | designed | — | — | yes (Sprint 3) |
| GuildSettings governance | designed | — | — | yes (Sprint 2) |
| Bonding curve funding | designed | — | — | Phase 2 |

---

## Two surfaces, one cooperative

The bot and the dashboard are not redundant — they're complementary:

- **Bot is the front door.** Setup help, badge checks, support, mint links and the optional community votes (proposals, polls, temperature checks); the dice game is closed. Lives where members already are (Telegram). No wallet required for read paths.
- **Dashboard is the money entry.** Posting tasks, signing escrow transactions, browsing leaderboard, managing profile. Anything that touches XRD lives here — the wallet connect flow is the gate.

A member's full cooperative experience uses both. Onboarding starts in the bot (`/start → /register → /mint`); paid work lives on the dashboard. Sprint 2's bot Postgres cutover (`guild-public/bot/db-pg.js`, not folded into this repo) is the first step in making these two surfaces share state instead of duplicating it.

---

## When to read what

| If you need to… | Read |
|---|---|
| Refresh on the cooperative model and design maxims | [GUILD-VISION-2026.md](./GUILD-VISION-2026.md) |
| Understand the cross-component data flow | [architecture/system-map.md](./architecture/system-map.md) |
| Understand dispute resolution model | [architecture/dispute-resolution.md](./architecture/dispute-resolution.md) |
| Pick up where the sprint plan left off | [decisions/ADR-001-architectural-foundations.md](./decisions/ADR-001-architectural-foundations.md) |
| Understand why the dashboard was once "10% functional" *(historical — it is live and mainnet-proven now; see the correction in §Built today)* | [decisions/ADR-002-escrow-deploy-and-integration-gates.md](./decisions/ADR-002-escrow-deploy-and-integration-gates.md) |
| Deploy the escrow blueprint | ESCROW-DEPLOY-RUNBOOK.md (kept in the private operations repository) |
| Find on-chain addresses | [`guild-app/src/lib/config.ts`](../guild-app/src/lib/config.ts) — the defaults the live site uses (the operator's INFRASTRUCTURE.md and HANDOVER.md are kept in the private operations repository) |
| Onboard a new contributor | [CONTRIBUTING.md](../CONTRIBUTING.md) (still the canonical onboarding surface) |
| Build an agent | [packages/agent-client/README.md](../packages/agent-client/README.md) |
| Resume Archon's contributions | Archon commits via PR labeled `archon`. Workflow rationale lives in the operator's private notes, not in this repo. |
