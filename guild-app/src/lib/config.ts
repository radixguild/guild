// Radix network addresses and API configuration

import { isEnabled } from "./features"

export const DAPP_DEF =
  process.env.NEXT_PUBLIC_DAPP_DEF ||
  "account_rdx12yepj6wme9ehcnmffk9fvelhumrfskzqyxdy6zde8ltn5zxy42mrcz";

export const GATEWAY = "https://mainnet.radixdlt.com";

export const MANAGER =
  process.env.NEXT_PUBLIC_MANAGER ||
  "component_rdx1czexylvvm0q4uhwpjaqmlznj9sd3y2jnmmah6qug9lm9sfm3tyrtva";

export const BADGE_NFT =
  process.env.NEXT_PUBLIC_BADGE_NFT ||
  "resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl";

// Owner badge of MANAGER ("Radix Guild Badge Admin"). FUNGIBLE: supply 1,
// divisibility 0. Check who holds it with holdsFungibleBadgeResult (gateway.ts);
// the NFT lookups there cannot see it.
export const ADMIN_BADGE =
  process.env.NEXT_PUBLIC_ADMIN_BADGE ||
  "resource_rdx1tkkzwrttvsqrsylyf4nqt2fxq6h27eva4lr4ffwad63x3f2cl43xwe";

// Dedicated agent badge resource — the on-chain identity for autonomous agents
// (operator-minted, recall-revocable; see docs/design/agent-auth-design.md).
// DORMANT by decision: agents transact on the Guild Member badge (BADGE_NFT),
// which is what proved the loop in Gate-1. When/if set, this resource is accepted
// as an ADDITIONAL builder-gate badge (submissions route) — it does not gate the
// lane being live.
export const AGENT_BADGE_NFT = process.env.NEXT_PUBLIC_AGENT_BADGE_NFT || "";

// The agent lane is LIVE by default: Gate-1 (2026-06-30) had a programmatic
// agent claim, submit on-chain, and collect their reward from escrow (after the
// poster approves, via their own signed withdrawal) on the Guild Member
// badge, with chain↔DB parity. Activation does NOT depend on the dormant
// dedicated agent badge — flipping this off the resource diverged its truth
// condition (GAGENT deployed) from its meaning (agents can earn).
//
// KILL SWITCH (2026-07-31 triage: "agents off" had no mechanism — this is it).
// `AGENT_LANE_LIVE=false` + restart turns the lane OFF, enforced SERVER-SIDE
// via agentLaneGate() (src/lib/agent-lane.ts) in the routes the lane earns
// through — see that module for the exact surface. Only the literal string
// "false" disarms; unset or anything else = LIVE (preserves current behavior).
//
// Deliberately NOT NEXT_PUBLIC_: a NEXT_PUBLIC_ var bakes into the build (the
// launch-check lesson — unsetting one changes nothing until a rebuild), and a
// kill switch must flip on env change + pm2 restart alone. Read at CALL TIME,
// not module init, so nothing can cache the armed state.
//
// ⚠ Client bundles do NOT inline non-NEXT_PUBLIC_ env, so client-side callers
// always compute the default (true). That is by design: the client value is
// display-only and must NEVER be the enforcement — any UI that needs to show
// the off state must derive it from a server response (e.g. the 503
// AGENT_LANE_OFF envelope), not from calling this in the browser.
//
// Scope honesty: this gates THIS APP's lane only. The deployed blueprint's
// methods remain PUBLIC on-chain (claim/submit/dispute need no app) — the
// chain-side gate is the PULL redesign (docs/design/escrow-pull-redesign.md).
export const isAgentLaneLive = (): boolean =>
  process.env.AGENT_LANE_LIVE !== "false";

// Defaults to the CANONICAL host, not the legacy sslip one. The sslip form
// encodes the VPS IP by construction, and that host has 301'd to
// radixguild.com since the :3002 dashboard was decommissioned 2026-07-03 —
// so the old default was both a needless IP disclosure and a redirect hop.
// Caddy routes radixguild.com/api/* to the bot on :3003, so this is the same
// endpoint by a name that does not embed the address.
export const BOT_API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  "https://radixguild.com/api";

// TWO different Telegram things, and until 2026-09-20 this file had one constant for both —
// pointed at the wrong one. @radix_guild is the community GROUP; the bot is @radix_guild_bot
// (both checked on t.me). Every "Telegram Bot" / "/register" / "/mint" link on the site sent
// people to the group.
//   TG_BOT_URL   — do something with the bot: /register, /badge, vote. Opens a DM with it.
//   TG_GROUP_URL — talk to people: questions, feedback, "say it on Telegram".
export const TG_BOT_URL = "https://t.me/radix_guild_bot";
export const TG_BOT_HANDLE = "@radix_guild_bot";
export const TG_GROUP_URL = "https://t.me/radix_guild";
export const TG_GROUP_HANDLE = "@radix_guild";

export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  "https://radixguild.com";

// Whether the code is public yet (published as a fresh repository in the radixguild
// org; its name is not ruled yet). False until the open-source flip actually happens — bump this in
// the SAME change that flips GitHub's visibility, never ahead of it.
//
// Every surface below reads this instead of hardcoding "the repo is private", the
// same way src/components/tasks/private-repo-note.tsx derives its own claim from
// PRIVATE_REPO_TASK_IDS rather than restating it in prose per call site (finding,
// 2026-09-30 — no flip-day tripwire existed before this for the repo-visibility
// claim, unlike that one). tests/unit/agents-selfserve-honesty.test.ts's "the
// 'repository is private' claim moves with REPO_IS_PUBLIC" block fails if any of
// them stop importing it, or if flipping it to `true` here is not matched by the
// hand-written public draft that also asserts "is private" in plain prose
// (publish/STATE.public.md) — that can't branch on a TS constant, so the test is
// the tripwire for it.
export const REPO_IS_PUBLIC = false;

// Bring Your Agent: where the kit tarball is served (design §2.4, ruling D1
// 2026-09-24 — tarball on this domain now, npm later). The one-liner the app
// shows an owner embeds it; the kit's CI proves the `npx -y -p <url>` shape.
export const KIT_TARBALL_URL =
  process.env.NEXT_PUBLIC_KIT_TARBALL_URL ||
  `${SITE_URL}/kit/agent.tgz`;
// The read-only MCP server's tarball (P1): a sibling of the agent kit in the same
// directory, so a moved KIT_TARBALL_URL moves this too. Derived by replacing the
// LAST PATH SEGMENT, never by matching the literal "agent.tgz" — a versioned or
// renamed agent tarball must not silently turn this into the agent kit's URL.
export const MCP_TARBALL_URL = KIT_TARBALL_URL.replace(/\/[^/]*$/, "/mcp.tgz");

// ── Sprint 1.5: Escrow Marketplace (ADR-002) ─────────────────────────────
// All escrow functionality is gated behind NEXT_PUBLIC_FEATURE_ESCROW.
// Code lands inert (returns null / shows nothing) until the escrow package
// is published on mainnet and this flag is set.

export const FEATURE_ESCROW = isEnabled("escrow");

// Mainnet escrow addresses — WAVE B (cutover LIVE 2026-09-13), see
// docs/ESCROW-ADDRESSES.md for the full, chain-verified registry. Wired as
// defaults so a clean checkout targets the LIVE escrow; env vars still
// override for staging/rollback. Everything stays inert until
// NEXT_PUBLIC_FEATURE_ESCROW is flipped on — isEscrowDeployed() gates on
// FEATURE_ESCROW.
//
// ⚠️ Every retired escrow is DEAD for transacting — never fall back to one:
// v1 `…cz9mh49…796s7` (superseded 2026-06-14), push `…cr690h…335r2`
// (superseded 2026-08-17), PULL `…cz468e…akd82f` (retired IN PLACE 2026-09-13,
// XRD whitelist frozen forever). They are listed in ./escrow-history, which app
// runtime code must never import (see the note below ESCROW_COMPONENT).
//
// ⚠️ These four defaults have lagged a cutover TWICE. The package default was
// the retired push package until 2026-08-22 (never updated at the P2 cutover);
// then ALL FOUR sat on the retired PULL addresses from the Wave B cutover
// (2026-09-13) until 2026-09-14. Production noticed neither, because the box
// bakes NEXT_PUBLIC_ESCROW_* from .env.local — the defaults only bite a local
// dev, test or staging run with no env set, which then silently targets a
// frozen component. tests/unit/escrow-address-drift.test.ts now pins all four
// against docs/ESCROW-ADDRESSES.md's LIVE rows, so a third repeat fails CI in
// the PR rather than in someone's shell.
//
// ESCROW_PACKAGE is functionally inert (nothing reads it but the is-non-empty
// check in isEscrowDeployed(); no manifest builder touches it) — which is
// exactly why it could survive a cutover unnoticed, and why a stale value here
// is still worth fixing: a later reader trusts it.
// NOTE for launch-check CHECK 7: since 2026-08-17 it no longer anchors on
// source order (it collects every component literal in the built .js and lets
// the chain classify them), but keep ESCROW_PACKAGE declared ABOVE
// ESCROW_COMPONENT anyway — launch-check.sh's retired-anchor notes still
// describe this order.
export const ESCROW_PACKAGE =
  process.env.NEXT_PUBLIC_ESCROW_PACKAGE ||
  "package_rdx1pk5z8ktfwd9d3l9vqmngft626cv5tp0hxjyenkh78pzq5u7c38p8yv";

// Escrow component — instantiated from the package. Wave B: 15 instantiate
// args, proportional claim bond (pct/floor/cap), 4-arg submit_task,
// review_window_secs, settable params — docs/ESCROW-ADDRESSES.md § Instantiate
// Parameters has the chain-read values.
export const ESCROW_COMPONENT =
  process.env.NEXT_PUBLIC_ESCROW_COMPONENT ||
  "component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly";

// Retired escrow components (ESCROW_COMPONENT_LEGACY, ESCROW_COMPONENT_HISTORY)
// deliberately do NOT live here. They moved to ./escrow-history on 2026-08-18
// because a module-scope Object.freeze kept them in the built artifact, which
// broke launch-check CHECK 7 ("exactly one escrow component is baked") and
// failed the deploy closed. Import them from "@/lib/escrow-history" in scripts
// and tests only — never from app runtime code.

// Poster receipt resource — Task Receipt NFT minted at create_task; required to
// cancel, approve, raise a dispute as poster, or withdraw_poster.
// Receipts are COMPONENT-SCOPED: every redemption path asserts the component's
// own receipt resource, so this and ESCROW_CLAIM_RECEIPT_RESOURCE move WITH
// ESCROW_COMPONENT at every cutover — a partial repoint claims fine and then
// fails at submit/withdraw with a stale-receipt error.
export const ESCROW_RECEIPT_RESOURCE =
  process.env.NEXT_PUBLIC_ESCROW_RECEIPT_RESOURCE ||
  "resource_rdx1n2gxh84q62taekne4d5mys5yk23du7yyvma6zjuh0vvhn4w2vrtkju";

// Worker receipt resource — Claim Receipt NFT minted at claim_task; burned by
// the 4-arg submit_task; required to withdraw_worker.
export const ESCROW_CLAIM_RECEIPT_RESOURCE =
  process.env.NEXT_PUBLIC_ESCROW_CLAIM_RECEIPT_RESOURCE ||
  "resource_rdx1n2z2rpjuwg2fu54qmcga862q7kl0qkp4rl9pvfh20z55utku84u9al";

// XRD floor for a worker's claim bond — DISPLAY COPY ONLY. Wave B (2026-09-13)
// deleted the deployed escrow's flat `claim_bond_xrd` field: the bond is now
// `clamp(reward * claim_bond_pct, claim_bond_floor, claim_bond_cap)`, read live
// off the component (see readClaimBondParams in gateway.ts) — a constant
// cannot express that, so this is never the amount a manifest builds against.
// This mirrors the on-chain `claim_bond_floor` for the "at least {N} XRD
// today (an owner setting)" phrasing used across the site's copy — an owner
// setting, not a guarantee (set_claim_bond_params). Verify against the component's
// get_config before relying on it for anything money-path.
export const ESCROW_CLAIM_BOND_XRD = Number(
  process.env.NEXT_PUBLIC_ESCROW_CLAIM_BOND_XRD || "76.45",
);

// Grace period after a claim deadline before `expire_claim` becomes callable —
// DISPLAY COPY ONLY, same posture as ESCROW_CLAIM_BOND_XRD above. The deployed
// blueprint asserts `now >= deadline + expire_grace_secs` before allowing the
// forfeit, and the live component's value is 3600 (docs/ESCROW-ADDRESSES.md's
// chain-verified instantiate table, param 8).
//
// This exists because /lifecycle and /money both told claimants the forfeit race
// began at "deadline+1s", which is an hour early — an inaccuracy about somebody
// else's money, on the two pages where they go to understand the risk.
// PROJECT-STATE.md had recorded the correction (and proven it live: pre-window,
// expire_claim reverts with "claim deadline + grace window has not passed yet")
// and the copy was never updated. Pinning it to one constant means the next
// change to the parameter has exactly one place to land.
//
// Verify against the component's get_config before relying on it for anything
// money-path — like every display constant here, it is not what a manifest
// builds against.
export const ESCROW_EXPIRE_GRACE_SECS = Number(
  process.env.NEXT_PUBLIC_ESCROW_EXPIRE_GRACE_SECS || "3600",
);

// Human-lane submit deadline — DISPLAY COPY ONLY, same posture as the two
// above. claim_task pins `claim_deadline = now + human_submit_deadline_secs`
// (the agent lane uses agent_submit_deadline_secs) at the moment of the claim.
// Live component value 604800 = 7 days (Gateway read 2026-09-24, state version
// 559475439). It is an owner setting, so it can change for LATER claims.
export const ESCROW_HUMAN_SUBMIT_DEADLINE_SECS = Number(
  process.env.NEXT_PUBLIC_ESCROW_HUMAN_SUBMIT_DEADLINE_SECS || "604800",
);

// Share of a forfeited claim bond paid to whoever calls expire_claim — DISPLAY
// COPY ONLY. The rest lands in forfeited_claim_bonds_vaults, which only the
// OWNER badge can empty (withdraw_forfeited_bonds). Live value 0.1 (same
// read). Read live in expire_claim, so a change reaches claims in flight —
// one of the two such settings /trust's Known Issues names.
export const ESCROW_EXPIRE_BOUNTY_PCT = Number(
  process.env.NEXT_PUBLIC_ESCROW_EXPIRE_BOUNTY_PCT || "0.1",
);

export const isEscrowDeployed = (): boolean =>
  FEATURE_ESCROW && ESCROW_PACKAGE.length > 0 && ESCROW_COMPONENT.length > 0;

// ── NFT swap (guild-nft-swap) ─────────────────────────────────────────
// A SEPARATE blueprint in the same crate as the escrow, published 2026-09-15
// and instantiated the same evening. It shares nothing with the task machinery
// above: no insurance, no claim bond, no review window, no arbiter. Same
// posture as the escrow addresses — env first, chain-verified default second,
// both copied from docs/ESCROW-ADDRESSES.md and pinned by
// tests/unit/escrow-address-drift.test.ts so a cutover cannot silently leave a
// stale literal here (the failure that bit the escrow twice, 2026-08-17 and
// 2026-09-13).
//
// Safe to bake into the bundle: launch-check CHECK 7 collects every component
// literal in the built .js and lets the CHAIN classify them, and a non-escrow
// component matches neither the push nor the pull shape probe — so this one is
// self-excluding from the "exactly one escrow component" candidate set.
export const NFT_SWAP_PACKAGE =
  process.env.NEXT_PUBLIC_NFT_SWAP_PACKAGE ||
  "package_rdx1p53j5yst59jhgc8ljap7266sd0nxgm2lndp2z6a4ddsprkn7e9ssmv";

export const NFT_SWAP_COMPONENT =
  process.env.NEXT_PUBLIC_NFT_SWAP_COMPONENT ||
  "component_rdx1cq80zarwh84mmrkn95xc7glgg5yvz0vkvqs9amxsnpwxuhkldd5mp4";
// ── Governance Components ─────────────────────────────────────────────

// CV2 Governance Component (on-chain) — OURS. Corrected 2026-07-26: this is NOT
// a third-party Foundation deployment, and the old wording here got copied into
// published user-facing copy in PR #265 before it was caught. bigdev forked the
// Foundation's NEVER-DEPLOYED `consultation_v2` and deployed it himself on
// 2026-04-06 — package first tx 00:29:45Z, component instantiation 00:37:44Z,
// both fee-paid by the Guild's own operator master account. Say "our fork of the
// Foundation's consultation_v2 blueprint", never "a Foundation component":
// the second borrows an outside institution's credibility for an operator-run
// component whose owner-only moderation methods we hold.
// READ-ONLY by design (see docs/RADIXTALK-CV2-POST.md). The write path
// (create / vote) is gated behind FEATURE_CV2_WRITES (default OFF) because this
// component's write ABI is unverified against our manifest builders (audit
// CRITICAL-1) — a mismatch makes every vote a CommittedFailure.
export const CV2_COMPONENT =
  process.env.NEXT_PUBLIC_CV2_COMPONENT ||
  "component_rdx1cqj99hx2rdx04mrdvd3am7wcenh6c26m2w5uzv8vkv9pudveqzy7d2";

// Gate for CV2 on-chain writes. Flip NEXT_PUBLIC_FEATURE_CV2_WRITES=true only
// after one real make_temperature_check + vote_on_temperature_check round-trips
// successfully on mainnet (or the canonical consultation-blueprint ABI is
// confirmed). CV2 reads are unaffected by this flag.
export const FEATURE_CV2_WRITES = isEnabled("cv2Writes");

// REMOVED (2026-07-17): ESCROW_V1_COMPONENT (…cp8mwwe2, "v1 TaskEscrow —
// legacy") and ESCROW_V3_COMPONENT (…czcjn322, comment claimed "LIVE" but that
// predates the §8b cutover and nothing ever transacted against it).
//
// They existed only to be rendered on the /about and /docs "On-Chain
// Verification" cards, where they were the ONLY escrow shown — so the pages
// that invite a reader to verify the guild pointed at dead contracts while
// every money path ran on ESCROW_COMPONENT above. Deleted rather than
// re-labelled: a display-only address constant sitting next to the real one is
// a trap for the next person wiring up a verification link, and the superseded
// lineage already lives in docs/ESCROW-ADDRESSES.md. If you need to show
// history, read it from there — do not re-add a plausible-looking constant.

