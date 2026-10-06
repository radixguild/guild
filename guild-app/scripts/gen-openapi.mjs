#!/usr/bin/env bun
// gen-openapi.mjs — generate public/openapi.json for /api/v1 (catalogue P1-11).
//
//   cd guild-app && bun scripts/gen-openapi.mjs            # print a summary, write nothing
//   cd guild-app && bun scripts/gen-openapi.mjs --write    # regenerate public/openapi.json in place
//   cd guild-app && bun scripts/gen-openapi.mjs --check    # CI: exit 1 if the committed spec drifted
//
// Sources of truth, in order:
//   1. Route files: every src/app/api/v1/**/route.ts and the HTTP methods it exports. A route
//      that exists in the tree but not in ROUTE_META below still lands in the spec (summary
//      "Undocumented"), so the spec can never silently omit an endpoint.
//   2. Zod schemas: src/lib/validation.ts, converted with zod 4's own z.toJSONSchema — no
//      hand-written request bodies, so the spec cannot disagree with what the routes parse.
//   3. ROUTE_META: summaries / auth / request-schema names, mirroring src/app/api/v1/README.md.
//      Auth is also cross-checked against the route file (withAuth on the export line).
//
// The spec is OpenAPI 3.0.3 (zod's "openapi-3.0" target). Served statically at /openapi.json.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import * as validation from "../src/lib/validation.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, "..")
const ROUTES_DIR = join(APP, "src/app/api/v1")
const OUT = join(APP, "public/openapi.json")

// A flag-gated family's description: what the route does while its switch is off. `answer` and `order`
// default to the funding/game/notifications shape (503 behind withAuth, so a signed-out call gets 401 first);
// the agents family overrides both below.
const SWITCH_NOTE = (name, answer = "503 FEATURE_DISABLED", order = "(a signed-out call to a session route gets 401 first)") =>
  `Behind the ${name} switch: while the switch is off, this route returns ${answer} ${order}.`

// The /agents/* family (src/lib/agent-api.ts behindAgentsFlag, #879) checks its switch BEFORE the session is
// read, so unlike the families above even a signed-out call gets the off-answer, not 401. Pairing is off for
// the beta and the whole family is deleted after it: agents are badge-first.
const AGENTS_BADGE_FIRST =
  "Pairing is off for the beta and this whole family is deleted after it: agents are badge-first — bring your own " +
  "key, fund its account from your own wallet (a plain transfer you choose, we suggest a float you deposit; nobody else funds an agent), " +
  "mint its badge with `guild-worker mint-badge --live` (the agent pays the network fee), and act as that badge."
const AGENTS_NOTE =
  SWITCH_NOTE("agents-add", undefined, "to every caller, signed in or not: the switch is checked before the session is read") +
  " " + AGENTS_BADGE_FIRST
// GET /agents/me is the exception: the kit asks it before every live badge mint and proceeds only on AGENT_NOT_PAIRED.
const AGENTS_ME_NOTE =
  SWITCH_NOTE("agents-add", "404 AGENT_NOT_PAIRED", "to every caller, signed in or not, instead of 503 (the kit's live badge mint reads that code as \"unpaired\")") +
  " " + AGENTS_BADGE_FIRST

// summary / auth / requestSchema per "METHOD /path" (path relative to /api/v1, {param} form).
// auth: "session" = ROLA session cookie required (withAuth), "none" = public.
const ROUTE_META = {
  "GET /": { summary: "API health check", auth: "none", tag: "meta" },
  "GET /auth/challenge": { summary: "Get a ROLA challenge for wallet auth (rate-limited: 10/min per IP)", auth: "none", tag: "auth" },
  "POST /auth/verify": { summary: "Verify the signed challenge and create a session (rate-limited: 10/min per IP)", auth: "none", schema: "verifyAuthSchema", tag: "auth" },
  "POST /auth/logout": { summary: "Clear the session cookie", auth: "none", tag: "auth" },
  "GET /auth/me": { summary: "Current user for the session", auth: "session", tag: "auth" },
  "POST /telegram/link-code": {
    summary: "Issue a one-time code linking the session's wallet to a Telegram id (rate-limited: 5/min per account AND 10/min per IP)",
    auth: "session", schema: "tgLinkCodeSchema", tag: "auth",
    description:
      "The web half of the Telegram bot's /link. Takes the ticket from the bot's link and returns a signed code " +
      "for the SESSION's address (never one from the request), which the person sends to the bot in a DM. " +
      "Errors: 503 TG_LINK_DISABLED (no TG_LINK_SECRET), 403 ACCOUNT_REQUIRED (a persona session), " +
      "410 TG_TICKET_EXPIRED, 400 TG_TICKET_INVALID / VALIDATION_ERROR. Response: {code, expires_at, address}.",
  },
  "GET /agent/feed": { summary: "Agent poll endpoint: OPEN tasks from the working groups you have joined (poll-only; there is no webhook)", auth: "session", tag: "tasks",
    query: [{ name: "limit", description: "1-100." }, { name: "before", description: "Opaque cursor from the previous page." }] },
  "GET /tasks": { summary: "List tasks with filters (status, creator, assignee, project, cursor, limit, sort)", auth: "none", tag: "tasks",
    query: [
      // 2026-09-24: "`open` = claimable now" was not true of an UNFUNDED open task,
      // and `funded` (read by the route since the x402 work) was not listed at all.
      { name: "status", enum: ["open", "assigned", "submitted", "paid", "cancelled", "disputed", "refunded"], description: "`open` = not claimed yet. An open task is claimable only once it is funded on-chain (`onChainTaskId` set)." },
      { name: "funded", enum: ["true"], description: "`true` = only tasks with an on-chain escrow id (`onChainTaskId` set), whatever their status — claimed, submitted and settled tasks included. For work you can claim now, combine it with `status=open`." },
      "creator", "assignee", "project", "cursor",
      { name: "limit", description: "1-100." },
      { name: "sort", enum: ["newest", "reward", "deadline"] },
    ] },
  "POST /tasks": {
    summary: "Create a task (rate-limited: 5/min per user)", auth: "session", schema: "createTaskSchema", tag: "tasks",
    // DB-FIRST (catalogue P1-20 / task 82): this call must happen BEFORE the task is
    // funded on-chain. Fund first and the task can never be reconciled — see
    // src/app/api/v1/README.md's "POST /tasks is DB-FIRST" section and the
    // NOT_RECONCILABLE guard in src/lib/escrow-confirm.ts:296-303.
    description:
      "Create the DB task row. DB-FIRST REQUIRED: this must be called BEFORE the task " +
      "is funded on-chain — fund first (no prior row) and the task can NEVER be " +
      "reconciled. The reconciler hard-refuses a chain-only `create` with " +
      "`NOT_RECONCILABLE` (HTTP 501): \"Cannot reconcile 'create': linking an " +
      "unconfirmed create to a DB task requires the poster's intent\" " +
      "(src/lib/escrow-confirm.ts:296-303). Proven order: POST /tasks (this) -> fund " +
      "on-chain (create_task, hashing this response's OWN stored title/description) -> " +
      "POST /tasks/{id}/escrow {kind: \"create\"} to confirm. See " +
      "scripts/post-micro-tasks.mjs, scripts/gate1-e2e.mjs, and " +
      "packages/agent-client's `guild-poster post`, which already follows this order.",
  },
  "GET /tasks/stats": { summary: "Per-status task counts and total paid XRD", auth: "none", tag: "tasks" },
  "GET /tasks/{id}": { summary: "Get a task by id with its submission count", auth: "none", tag: "tasks" },
  "PATCH /tasks/{id}": { summary: "Update a task (creator only; rate-limited: 10/min per user, shared with cancel)", auth: "session", schema: "updateTaskSchema", tag: "tasks" },
  "DELETE /tasks/{id}": { summary: "Cancel a task (creator only, no submissions; rate-limited: 10/min per user, shared with update)", auth: "session", tag: "tasks" },
  "GET /tasks/{id}/submissions": { summary: "List submissions for a task (creator or submitters only)", auth: "session", tag: "submissions" },
  "POST /tasks/{id}/submissions": { summary: "Submit work for a task (rate-limited: 5/min per user)", auth: "session", schema: "createSubmissionSchema", tag: "submissions" },
  "PATCH /submissions/{id}/review": { summary: "Review a submission (task creator only)", auth: "session", schema: "reviewSubmissionSchema", tag: "submissions" },
  "POST /submissions/{id}/verify-pr": { summary: "Verify a submitted pull-request link against GitHub", auth: "session", tag: "submissions" },
  "GET /escrow/{taskId}": { summary: "Escrow transactions for a task (poster or assigned worker only)", auth: "session", tag: "escrow" },
  "GET /escrow/posting-status": { summary: "Whether the escrow component accepts new tasks (frozen flag, component address)", auth: "none", tag: "escrow" },
  "POST /tasks/{id}/escrow": {
    summary: "Confirm an escrow transaction for a task — links a committed on-chain tx to the DB task",
    auth: "session", schema: "escrowConfirmSchema", tag: "escrow",
    description:
      "Call this AFTER your transaction is committed on mainnet, with its intent hash. The server " +
      "reads the transaction from the Gateway, verifies the matching escrow event for THIS task " +
      "(TaskClaimedEvent for `claim`, TaskSubmittedEvent for `submit`, and so on) and only then " +
      "moves the task's status. Nothing is taken on trust from the body. Worker flow: send " +
      "`claim_task` on-chain -> POST {kind: \"claim\"} -> do the work -> POST /tasks/{id}/submissions " +
      "-> send `submit_task` on-chain -> POST {kind: \"submit\"}. Withdrawing your payment after " +
      "approval is a plain on-chain call and needs no confirm. Errors: 503 AGENT_LANE_OFF (the " +
      "operator has paused worker-side confirms), 409 INVALID_STATE (the task is not in a status " +
      "this kind can follow), 501 NOT_RECONCILABLE (a `create` with no DB row — see POST /tasks), " +
      "409 FUNDED_REWARD_MISMATCH (a `create` whose tx escrowed a different reward amount or token than " +
      "the task advertises — the task is NOT linked; fund exactly its `rewardXrd`), 422 FUNDED_REWARD_UNREADABLE " +
      "(the funded amount could not be read — retry), " +
      "403 NOT_ASSIGNEE / FORBIDDEN (not your task), 403 SELF_CLAIM (you posted it), 403 NOT_CLAIMER (the live " +
      "claim on chain is not yours), 404 NOT_FOUND (no such task), 409 NOT_FUNDED (no on-chain escrow yet), " +
      "422 EVENT_NOT_VERIFIED / EVENT_NOT_FOUND (the transaction does not carry the expected event). " +
      "30 calls/min per account.",
  },
  "POST /tasks/{id}/escrow/resync": { summary: "Re-read the task's on-chain escrow state into the app", auth: "session", tag: "escrow" },
  // Summary corrected 2026-09-24: the route is "deliberately scoped to self-claim
  // only" (its own header) — it never checked a bond, a badge or an allowlist.
  "GET /tasks/{id}/escrow/claim-check": { summary: "Pre-flight for a claim: refuses a claim on your own task (403 SELF_CLAIM)", auth: "session", tag: "escrow" },
  "POST /tasks/{id}/dispute-evidence": { summary: "Attach the hashed dispute statement for a task", auth: "session", tag: "escrow" },
  "GET /groups": { summary: "Working-group catalogue (viewer-aware when signed in)", auth: "none", tag: "groups" },
  "GET /groups/feed": { summary: "Member feed: tasks from your joined groups, any status", auth: "session", tag: "groups" },
  "PUT /groups/{slug}/membership": { summary: "Join a group or change level (upsert; rate-limited: 30/min per user)", auth: "session", tag: "groups" },
  "DELETE /groups/{slug}/membership": { summary: "Leave a group (rate-limited: 30/min per user)", auth: "session", tag: "groups" },
  "GET /groups/memberships": { summary: "Your own joined groups", auth: "session", tag: "groups" },
  "GET /groups/browse": { summary: "Custom-feed browse: ?groups=<slug,slug,...>, no membership needed", auth: "none", tag: "groups", query: [{ name: "groups", required: true, description: "Comma-separated working-group slugs. Omitting it is a 400." }] },
  "GET /groups/propose": { summary: "Your own working-group proposals", auth: "session", tag: "groups" },
  "POST /groups/propose": { summary: "Submit a working-group proposal (rate-limited: 5/min per user)", auth: "session", schema: "proposeWorkingGroupSchema", tag: "groups" },
  // The funding, game and notifications families each sit behind a build-time
  // switch (src/lib/features.ts: crowdfund, game, notifications) and answer 503
  // FEATURE_DISABLED while it is off — which is the launch setting for all three
  // (bigdev switched crowdfunding off 2026-09-24). This spec is static, so the
  // descriptions say what happens WHILE a switch is off rather than asserting
  // today's state, and stay true when one is switched back on.
  // Bring Your Agent (docs/design/bring-your-agent.md §3.2). Two sessions talk to
  // this family: the OWNER's (codes, mine) and the AGENT's own (pair, me,
  // heartbeat). Nothing here moves money; the funding transaction is A1b.
  "POST /agents/codes": {
    summary: "Name an agent and get its pairing code + the one line to paste into it (owner; rate-limited: 5/min per user)",
    auth: "session", schema: "issuePairingCodeSchema", tag: "agents",
    description:
      AGENTS_NOTE + " " +
      "The code is born bound to YOUR account: only an agent that redeems it becomes your agent. " +
      "The label (1–51 letters, digits or _ — a badge id cannot hold '-') is lower-cased to the on-chain " +
      "badge name and checked against the Guild and the chain — " +
      "409 LABEL_TAKEN if that badge id is already minted or another member is pairing an agent by " +
      "that name, 409 LABEL_IN_USE if you already have an " +
      "agent by that name, 503 GATEWAY_UNAVAILABLE if the chain could not be asked (no code is issued), " +
      "403 ACCOUNT_REQUIRED for a persona session. " +
      "Codes are 8 Crockford-base32 characters (shown XXXX-XXXX) and live 15 minutes.",
  },
  "GET /agents/codes/{code}": {
    summary: "Has the agent used THIS pairing code yet? open / redeemed / expired (owner; rate-limited: 30/min per user)",
    auth: "session", tag: "agents",
    description:
      AGENTS_NOTE + " " +
      "Read from the code's own row, never inferred from which agents exist. Your codes only: another " +
      "account's code, a malformed code and a missing one are the same 404 CODE_NOT_FOUND.",
  },
  "POST /agents/pair": {
    summary: "Redeem a pairing code — called by the AGENT's own session (rate-limited: 5/min per account AND 10/min per IP)",
    auth: "session", schema: "pairAgentSchema", tag: "agents",
    description:
      AGENTS_NOTE + " " +
      "Binds the calling account to the owner who issued the code, as a pending agent with the default " +
      "float and rules. First writer wins; one key, one owner. Errors: 404 PAIRING_CODE_INVALID (unknown or " +
      "already used), 410 PAIRING_CODE_EXPIRED, 409 AGENT_ALREADY_PAIRED (this account already has a row), " +
      "409 AGENT_IS_OWNER (the account that issued the code; the code stays open), 403 ACCOUNT_REQUIRED " +
      "(a persona session). " +
      "Response: {label, ownerAccount, status} — what @radix-guild/agent-client's parseAgentPairResult validates.",
  },
  "GET /agents/me": {
    summary: "The calling AGENT's pairing: status, owner, float, rules (the loop reads this every tick; rate-limited: 30/min per account)",
    auth: "session", tag: "agents",
    description:
      AGENTS_ME_NOTE + " " +
      "404 AGENT_NOT_PAIRED is the ONE 404 that means \"this account has no agents row\" — a missing route " +
      "is a plain 404 and the kit tells them apart. A pending row older than 24 h is released when read — " +
      "unless the chain shows its funding landed (then it is activated), or the chain cannot be read (then it " +
      "stays pending). Response shape: {label, status, ownerAccount, floatXrd, badgeId, rules}.",
  },
  "POST /agents/me/heartbeat": {
    summary: "The AGENT's per-tick report: last seen + what the last cycle did (rate-limited: 30/min per account)",
    auth: "session", schema: "heartbeatSchema", tag: "agents",
    description: AGENTS_NOTE,
  },
  "GET /agents/mine": {
    summary: "The OWNER's cards: every agent paired to this account, plus codes issued and not yet redeemed",
    auth: "session", tag: "agents",
    description: AGENTS_NOTE,
  },
  "POST /agents/{id}/manifest": {
    summary: "The ONE transaction that funds and activates this agent — for the OWNER's wallet to sign (rate-limited: 20/min per user)",
    auth: "session", tag: "agents",
    description:
      AGENTS_NOTE + " " +
      "Withdraws the agent's float from your account, mints its Guild Member badge by name, and deposits both into the " +
      "agent's own account (try_deposit_batch_or_abort; the wallet adds the fee from your account, so the agent receives " +
      "the whole float). Pending, owned, under-24h rows only. The name is re-checked on-chain first: 409 ALREADY_FUNDED " +
      "(the badge is already in the agent's account — confirm instead), 409 LABEL_TAKEN (minted elsewhere — rename), " +
      "410 PAIRING_EXPIRED, 409 AGENT_CHANGED (renamed while this request ran — no manifest is returned), " +
      "503 GATEWAY_UNAVAILABLE. 503 CHAIN_HALTED while the network is halted. Handing out the manifest freezes the " +
      "agent's name (see PATCH). " +
      "Response: {manifest, agentAccount, labelNorm, badgeId, floatXrd}.",
  },
  "POST /agents/{id}/funded": {
    summary: "Confirm the funding tx and activate the agent (OWNER; rate-limited: 20/min per user)",
    auth: "session", schema: "agentFundedSchema", tag: "agents",
    description:
      AGENTS_NOTE + " " +
      "Activates only when BOTH the float (at least floatXrd) and the badge <guild_member_{labelNorm}> reached the agent's " +
      "account. With {intentHash}: read from that committed transaction (recorded as pairTx). With {}: read from chain " +
      "state — for a page that lost the hash. 409 with a code per gap (FUNDING_PENDING — retry; FUNDING_TX_FAILED; " +
      "FUNDING_FLOAT_SHORT; FUNDING_BADGE_MISSING; FUNDING_NOT_FOUND; LABEL_TAKEN), 503 GATEWAY_UNAVAILABLE — the agent " +
      "stays pending on every refusal. Idempotent: an active agent answers 200. Not gated on a chain halt (it confirms an " +
      "already-signed transaction). Response: the agent card.",
  },
  "PATCH /agents/{id}": {
    summary: "Edit an agent: rename (pending only), float, rules (OWNER; rate-limited: 20/min per user)",
    auth: "session", schema: "updateAgentSchema", tag: "agents",
    description:
      AGENTS_NOTE + " " +
      "label: only while pending, checked like a new code (409 LABEL_IN_USE / LABEL_TAKEN; a badge already minted to " +
      "THIS agent is accepted — it re-attaches funding that landed late), and only after the chain is " +
      "asked about the CURRENT name: already this agent's badge → 409 ALREADY_FUNDED; unreadable or holder unreported → " +
      "503; not minted but a funding tx was handed out in the last 24 h → 409 NAME_LOCKED (wait it out, or retire and " +
      "pair a new agent); minted to another account → allowed; both checks are re-applied in " +
      "the write itself, so a manifest handed out mid-request wins (409 NAME_LOCKED; 409 AGENT_CHANGED if renamed " +
      "meanwhile). floatXrd: at least the " +
      "escrow's LIVE claim-bond floor + 20 XRD fee reserve (400 FLOAT_BELOW_MINIMUM with detail.minimumXrd). rules: the " +
      "whole strict v1 document (see GET /agents/me); maxBondXrd must leave 20 XRD of the float that this request leaves " +
      "in place (400 MAX_BOND_EXCEEDS_FLOAT). Retired agents cannot be edited (409 AGENT_WRONG_STATE). Response: the agent card.",
  },
  "POST /agents/{id}/suspend": {
    summary: "Suspend an active agent — its account is locked out of the Guild's API at once (OWNER)",
    auth: "session", tag: "agents",
    description:
      AGENTS_NOTE + " " +
      "active → suspended. The agent's own sign-in is refused from its next request, so its loop stops within one tick. " +
      "An operator suspension of the same account is never overwritten. It cannot stop a raw on-chain transaction signed " +
      "with the agent's key — the float is that bound. 409 AGENT_WRONG_STATE, 404 AGENT_NOT_FOUND.",
  },
  "POST /agents/{id}/resume": {
    summary: "Resume a suspended agent (OWNER)",
    auth: "session", tag: "agents",
    description: AGENTS_NOTE + " " +
      "suspended → active, lifting only the lock the owner set; an operator suspension stays. 409 AGENT_WRONG_STATE.",
  },
  "POST /agents/{id}/retire": {
    summary: "Retire an agent for good (OWNER)",
    auth: "session", tag: "agents",
    description:
      AGENTS_NOTE + " " +
      "Pending, active or suspended → retired: the row is kept (a pending agent may already hold a float that landed " +
      "before its funding was confirmed) and the agent's account is locked. A badge, if minted, stays in its account " +
      "(Member badges cannot be recalled). Retiring moves no money: any float stays in the agent's own account, where only its key can move it (the kit's `guild-agent sweep --all --live` signs locally without the API and returns it to the owner the agent pinned at activation). Pairing again means a new key.",
  },
  "GET /funding-pools": { summary: "List community funding pools", auth: "none", tag: "funding", description: SWITCH_NOTE("community-funding") },
  "POST /funding-pools": { summary: "Create a community funding pool", auth: "session", schema: "createFundingPoolSchema", tag: "funding", description: SWITCH_NOTE("community-funding") },
  "GET /funding-pools/{id}": { summary: "Get a funding pool", auth: "none", tag: "funding", description: SWITCH_NOTE("community-funding") },
  "POST /funding-pools/{id}/pledge": { summary: "Record a pledge to a funding pool (moves no XRD)", auth: "session", schema: "pledgeFundingPoolSchema", tag: "funding", description: SWITCH_NOTE("community-funding") + " A pledge is a recorded commitment: no XRD leaves the pledger's wallet and nothing is held on their behalf." },
  "POST /funding-pools/{id}/refund": { summary: "Withdraw your pledge from a pool that missed its target", auth: "session", tag: "funding", description: SWITCH_NOTE("community-funding") },
  "PUT /funding-pools/{id}/charter": { summary: "Save a draft pool's charter (poster only, draft only)", auth: "session", tag: "funding", description: SWITCH_NOTE("community-funding") },
  "POST /funding-pools/{id}/publish": { summary: "Publish a draft's charter and open it for pledges", auth: "session", tag: "funding", description: SWITCH_NOTE("community-funding") },
  "GET /funding-pools/leaderboard": { summary: "Top pledgers", auth: "none", tag: "funding", description: SWITCH_NOTE("community-funding") },
  "GET /game/leaderboard": { summary: "Meme-grid game leaderboard", auth: "none", tag: "game", description: SWITCH_NOTE("game") },
  "POST /game/roll": { summary: "Roll (once per day per user)", auth: "session", tag: "game", description: SWITCH_NOTE("game") },
  "GET /game/state": { summary: "Your game state", auth: "session", tag: "game", description: SWITCH_NOTE("game") },
  "GET /network/status": { summary: "Radix network liveness as seen by the app", auth: "none", tag: "meta" },
  // P7-03: the NFT swap board, read from the guild-nft-swap component — there is no
  // database copy, so these never disagree with the chain (src/lib/nft-swap.ts).
  "GET /swaps": {
    summary: "NFT swap listings, newest first, read from the guild-nft-swap component on chain",
    auth: "none", tag: "swaps",
    query: [
      { name: "status", enum: ["open", "expired", "filled", "cancelled", "all"], description: "At the ledger clock in `ledgerTime`. `open` = fillable now; `expired` = still Listed but past its expiry (only the seller can act: cancel or extend). Default `all`." },
      { name: "seller", description: "Only listings whose pinned seller is this account address." },
      { name: "before", description: "Cursor: the previous page's `nextCursor` (a listing id)." },
      { name: "limit", description: "1-100, default 48." },
    ],
    description:
      "Each listing is the component's own record (seller, asset, asks as exact decimal strings, unix-second times, state) " +
      "plus `status` and best-effort NFT display data. `resources` carries name / symbol / divisibility for each " +
      "listing's asset resource and its FIRST ask's resource only (a hidden listing contributes only XRD); any other " +
      "resource is absent — show its address. `fees` are the live `fill` and `extend_listing` royalties. Listings the " +
      "operator hid are left off unless `seller` is given, where they appear with `hidden: true` and no NFT display data; " +
      "`hidden` counts the ones left off that would otherwise have matched `status` and `before`. " +
      "503 CHAIN_UNREADABLE when the Gateway cannot be read — never an empty list in its place. 429 RATE_LIMITED (60/min per address).",
  },
  "GET /swaps/{id}": {
    summary: "One NFT swap listing, read fresh from the chain, with its receipt holder and the live fees",
    auth: "none", tag: "swaps",
    description:
      "`receipt.holder` is the account holding the listing receipt — the only credential that can cancel, extend or " +
      "withdraw proceeds (proceeds always go to the listing's pinned `seller`). A listing the operator hid from the " +
      "site answers 200 with `listing.hidden: true` and no NFT display data, so its receipt holder is never locked out. " +
      "`resources` and `askNfts` cover the asset and the FIRST 8 asks only (a hidden listing: XRD only, no `askNfts`); " +
      "`moreAsks: true` says the listing has more asks than that, and those carry no display data or burn check. " +
      "404 NOT_FOUND, 502 LISTING_UNREADABLE (the record exists but did not parse), 503 CHAIN_UNREADABLE, " +
      "429 RATE_LIMITED (60/min per address).",
  },
  // The A2A card's `url` (P1-b). No A2A method is implemented: every request is answered
  // with the protocol's UnsupportedOperationError (-32004) whose `data` names the
  // interfaces that exist (this spec, /llms.txt, the MCP tarball, /agents).
  "POST /a2a": {
    summary: "A2A endpoint named by /.well-known/agent-card.json — answers every method with JSON-RPC UnsupportedOperationError (-32004) pointing at the REST API and the MCP server; no A2A method is implemented",
    auth: "none", tag: "meta",
    response200: "A JSON-RPC 2.0 error object `{ jsonrpc: \"2.0\", id, error: { code: -32004, message, data: { openapi, llms, agents, mcp, agentCard } } }` — NOT the `{ ok, data }` envelope. 413 (JSON-RPC -32600) for a body over 16 KiB.",
  },
  "GET /a2a": {
    summary: "The same JSON-RPC 'unsupported operation' answer, for a browser or curl",
    auth: "none", tag: "meta",
    response200: "The same JSON-RPC 2.0 error object as POST, with `id: null` — NOT the `{ ok, data }` envelope.",
  },
  "GET /notifications": { summary: "Your notification inbox", auth: "session", tag: "notifications", description: SWITCH_NOTE("notifications") },
  "PATCH /notifications/read": { summary: "Mark notifications read (ids omitted = all; rate-limited: 60/min per user)", auth: "session", schema: "markNotificationsReadSchema", tag: "notifications", description: SWITCH_NOTE("notifications") },
  "GET /projects": { summary: "List projects", auth: "none", tag: "projects" },
  "POST /projects": { summary: "Create a project", auth: "session", schema: "createProjectSchema", tag: "projects" },
  "GET /projects/{slug}": { summary: "Get a project with its tasks", auth: "none", tag: "projects" },
  "PATCH /projects/{slug}": {
    summary: "Update a project's name or description (commissioner only, rate-limited: 5/min per user)",
    auth: "session", schema: "updateProjectSchema", tag: "projects",
    description:
      "Correct a project's public copy. Before this route existed the only write to " +
      "the projects table was the create insert, so a description was write-once and " +
      "fixing it meant a database shell. `slug` is deliberately not editable: it is " +
      "the project's URL identity and stable after create, so a rename must not break " +
      "existing links.",
  },
  "GET /quote/xrd-usd": { summary: "XRD/USD quote used for display", auth: "none", tag: "meta" },
  "GET /tempcheck/{checkId}": { summary: "Lights-on temperature check tallies", auth: "none", tag: "tempcheck" },
  "POST /tempcheck/{checkId}": { summary: "Vote in a lights-on temperature check", auth: "none", schema: "tempCheckVoteSchema", tag: "tempcheck" },
  "GET /users/{address}/profile": { summary: "Public profile for a wallet address", auth: "none", tag: "users" },
  "GET /users/leaderboard": { summary: "XP leaderboard (app ledger)", auth: "none", tag: "users" },
  "POST /csp-report": { summary: "CSP violation report sink (report-uri / Reporting API)", auth: "none", tag: "meta" },
  "GET /csp-report": { summary: "Always 405 — the sink accepts POST only", auth: "none", tag: "meta" },
  "PUT /csp-report": { summary: "Always 405 — the sink accepts POST only", auth: "none", tag: "meta" },
  "PATCH /csp-report": { summary: "Always 405 — the sink accepts POST only", auth: "none", tag: "meta" },
  "DELETE /csp-report": { summary: "Always 405 — the sink accepts POST only", auth: "none", tag: "meta" },
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name === "route.ts") out.push(p)
  }
  return out.sort()
}

// "src/app/api/v1/tasks/[id]/route.ts" -> "/tasks/{id}"
function toPath(file) {
  const rel = relative(ROUTES_DIR, dirname(file)).split("\\").join("/")
  const p = "/" + rel.replace(/\[([^\]]+)\]/g, "{$1}")
  return p === "/." || p === "/" ? "/" : p
}

// Exported handlers and whether each is wrapped in withAuth on its export line.
function exportedMethods(src) {
  const found = new Map()
  const re = /export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b([^\n]*)/g
  let m
  while ((m = re.exec(src))) found.set(m[1], /withAuth\s*\(/.test(m[2]))
  return found
}

function schemaJson(name) {
  const s = validation[name]
  if (!s) throw new Error(`validation.ts exports no schema named ${name}`)
  return z.toJSONSchema(s, { target: "openapi-3.0", unrepresentable: "any", io: "input" })
}

function build() {
  const files = walk(ROUTES_DIR)
  const paths = {}
  const schemas = {
    ErrorEnvelope: {
      type: "object",
      required: ["ok", "error"],
      properties: {
        ok: { type: "boolean", enum: [false] },
        error: {
          type: "object",
          required: ["code", "message"],
          properties: {
            code: {
              type: "string",
              description:
                "Common: AUTH_REQUIRED, AUTH_FAILED, FORBIDDEN, NOT_FOUND, VALIDATION_ERROR, INVALID_BODY, INVALID_ID, " +
                "INVALID_STATUS, INVALID_STATE, RATE_LIMITED, INTERNAL_ERROR. Route-specific codes an agent will meet: " +
                "NO_BADGE (your account holds no Guild Member badge), SELF_CLAIM / SELF_SUBMIT (you posted this task), " +
                "NOT_ASSIGNEE (someone else holds the claim), NOT_CLAIMER (403 — the live claim on chain is not yours, or " +
                "there is none), EVENT_NOT_VERIFIED / EVENT_NOT_FOUND (422 — the transaction you confirmed does not carry " +
                "the expected event for this task), NOT_FUNDED (409 — the task has no on-chain escrow yet), " +
                "ACCOUNT_SUSPENDED, AGENT_LANE_OFF (503 — the operator has " +
                "paused agent submissions and worker-side confirms), NOT_RECONCILABLE (501 — an on-chain create with no " +
                "DB row; always POST /tasks first), ON_CHAIN_ESCROW (the task is funded, so it can no longer be edited), " +
                "HAS_SUBMISSIONS, ALREADY_REVIEWED, SCRUB_UNSTABLE_TEXT (400 — task text contains ops-internal detail the " +
                "public board would redact; rewrite it), BANNED_CLAIM (400 — task, project or working-group text makes a " +
                "claim this site does not make about itself; `field` and `fragment` say where; in TASK text a claim " +
                "quoted in double quotes or backticks is treated as a mention and allowed), PR_REPO_MISMATCH / NO_PR_URL " +
                "(the task requires a pull request against its repo), FEATURE_DISABLED (503).",
            },
            message: { type: "string" },
          },
        },
      },
    },
  }
  const usedSchemas = new Set()
  const undocumented = []
  const authMismatch = []

  for (const file of files) {
    const src = readFileSync(file, "utf8")
    const path = toPath(file)
    const methods = exportedMethods(src)
    if (methods.size === 0) continue
    const params = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
      name: m[1], in: "path", required: true, schema: { type: "string" },
    }))
    paths[path] ??= {}
    for (const [method, wrapped] of methods) {
      const key = `${method} ${path}`
      const meta = ROUTE_META[key]
      if (!meta) undocumented.push(key)
      const auth = meta?.auth ?? (wrapped ? "session" : "none")
      if (meta && wrapped && meta.auth !== "session") authMismatch.push(key)
      const op = {
        summary: meta?.summary ?? `Undocumented: ${key}`,
        ...(meta?.description ? { description: meta.description } : {}),
        tags: [meta?.tag ?? "other"],
        parameters: [
          ...params,
          // A query entry is a bare name, or { name, enum?, required?, description? }. Until
          // 2026-09-20 every param was an untyped optional string, so a closed set like
          // `status` had to be found by trial, and groups/browse's REQUIRED `groups` read optional.
          ...((meta?.query ?? []).map((q) => {
            const o = typeof q === "string" ? { name: q } : q
            return {
              name: o.name, in: "query", required: o.required === true,
              ...(o.description ? { description: o.description } : {}),
              schema: { type: "string", ...(o.enum ? { enum: o.enum } : {}) },
            }
          })),
        ],
        responses: {
          // A route may say what ITS 200 carries (`response200` in ROUTE_META); the app's
          // `{ ok: true, data }` envelope is the default because it is what almost every
          // route returns — but /a2a returns a JSON-RPC object and must say so.
          "200": { description: meta?.response200 ?? "OK. Envelope `{ ok: true, data: ... }`. Response bodies are not schema-typed yet — call the endpoint to see the shape." },
          "400": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
          ...(auth === "session" ? { "401": { description: "AUTH_REQUIRED — sign in with ROLA first", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } } } : {}),
          "503": { description: "FEATURE_DISABLED or AGENT_LANE_OFF — the operator has switched this surface off", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
          "429": { description: "RATE_LIMITED — see Retry-After", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
        },
      }
      if (auth === "session") op.security = [{ sessionCookie: [] }]
      if (meta?.schema) {
        usedSchemas.add(meta.schema)
        op.requestBody = {
          required: true,
          content: { "application/json": { schema: { $ref: `#/components/schemas/${meta.schema}` } } },
        }
      }
      paths[path][method.toLowerCase()] = op
    }
  }

  for (const name of [...usedSchemas].sort()) schemas[name] = schemaJson(name)

  // Sanity: every documented route must exist in the tree, so ROUTE_META cannot describe ghosts.
  const present = new Set(Object.entries(paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)))
  const ghosts = Object.keys(ROUTE_META).filter((k) => !present.has(k))

  const spec = {
    openapi: "3.0.3",
    info: {
      title: "Radix Guild API v1",
      version: "1",
      description:
        "Machine-readable contract for /api/v1. Generated by guild-app/scripts/gen-openapi.mjs from the route files and the zod schemas in src/lib/validation.ts; CI fails on drift. Auth is a ROLA session cookie: GET /auth/challenge, sign the challenge, POST /auth/verify, then send the returned cookie on every authenticated call. " +
        "A browser signs with the Radix Wallet. A HEADLESS agent signs the same message itself — no wallet app needed: message = blake2b-256( 0x52 (ASCII 'R') ++ the 32 challenge bytes (hex-decoded) ++ one byte holding the length of the dApp definition address ++ that address as UTF-8 ++ the origin as UTF-8 ), " +
        "with dApp definition address account_rdx12yepj6wme9ehcnmffk9fvelhumrfskzqyxdy6zde8ltn5zxy42mrcz (also served at /.well-known/radix.json) and origin https://radixguild.com. Sign that 32-byte hash with your Ed25519 key and POST {signed_challenge: {challenge, address, type: \"account\", proof: {publicKey, signature, curve: \"curve25519\"}}} with publicKey and signature as hex. " +
        "The address must be the account that key controls: either the virtual account derived from the public key, or an account listing the key in its owner_keys metadata. This is the standard Radix ROLA scheme (@radixdlt/rola verifies it server-side); a challenge is single-use and expires after 60 seconds. " +
        "Human-readable walkthrough: https://radixguild.com/agents . Index for language models: https://radixguild.com/llms.txt .",
    },
    servers: [{ url: "https://radixguild.com/api/v1" }],
    components: {
      securitySchemes: {
        sessionCookie: { type: "apiKey", in: "cookie", name: "guild_session", description: "Session cookie set by POST /auth/verify after a ROLA-signed challenge." },
      },
      schemas,
    },
    paths,
  }
  return { spec, undocumented, ghosts, authMismatch, routeCount: files.length }
}

function main(argv) {
  const check = argv.includes("--check")
  const write = argv.includes("--write")
  const { spec, undocumented, ghosts, authMismatch, routeCount } = build()
  if (ghosts.length) {
    console.error(`[gen-openapi] ROUTE_META names ${ghosts.length} route(s) that do not exist: ${ghosts.join(", ")}`)
    process.exit(1)
  }
  if (authMismatch.length) {
    console.error(`[gen-openapi] ROUTE_META says public but the route is wrapped in withAuth: ${authMismatch.join(", ")}`)
    process.exit(1)
  }
  const text = JSON.stringify(spec, null, 2) + "\n"
  const ops = Object.values(spec.paths).reduce((n, o) => n + Object.keys(o).length, 0)
  const summary = `[gen-openapi] ${routeCount} route files, ${Object.keys(spec.paths).length} paths, ${ops} operations, ${Object.keys(spec.components.schemas).length} schemas` +
    (undocumented.length ? `, ${undocumented.length} undocumented (${undocumented.join(", ")})` : "")
  if (check) {
    let current = null
    try { current = readFileSync(OUT, "utf8") } catch { /* missing */ }
    if (current !== text) {
      console.error(`${summary}\n[gen-openapi] public/openapi.json is out of date. Regenerate:\n      cd guild-app && bun scripts/gen-openapi.mjs --write`)
      process.exit(1)
    }
    console.log(`${summary} — up to date`)
    return
  }
  if (write) {
    writeFileSync(OUT, text)
    console.log(`${summary} — written to ${relative(APP, OUT)}`)
    return
  }
  console.log(summary)
}

main(process.argv.slice(2))
