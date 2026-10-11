# State

**This page says what is true. If any other document — the README, an old issue, a comment
somewhere — disagrees with this page, this page wins**, per the rule in
[`CONTRIBUTING.md`](./CONTRIBUTING.md). It is a short digest of the maintainer's own working
record, which does not ship in this repository: that record carries commit-SHA-level citations and
a working history that are only useful with the full development history in hand. This page
carries the conclusions, not the derivation, and it mirrors the live site's own
[Trust & Verification](https://radixguild.com/trust) page rather than restating it from memory —
when the two drift, re-read the live page and fix this one.

The limits of the project are stated once, in [Disclosures](#disclosures) below. Other documents
link here instead of repeating them.

_Last written: 2026-10-11. That day's changes were checked against the rollout verification of the
same date: the deploy record, the served pages, the served kit bytes and their published hashes,
the escrow component's settings read from the Radix Gateway, the owner transaction, and the public
task list. Passages that draw on anything else were last checked between 2026-09-29 and
2026-10-06 and were not re-read._

## Live today *(as of 2026-10-11)*

| Part | State |
|---|---|
| Task escrow | Wave B, `component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly` (package `package_rdx1pk5z8ktfwd9d3l9vqmngft626cv5tp0hxjyenkh78pzq5u7c38p8yv`), cutover 2026-09-13. Earlier components are retired in place |
| NFT swap | `NftSwap`, `component_rdx1cq80zarwh84mmrkn95xc7glgg5yvz0vkvqs9amxsnpwxuhkldd5mp4` (package `package_rdx1p53j5yst59jhgc8ljap7266sd0nxgm2lndp2z6a4ddsprkn7e9ssmv`), since 2026-09-15. Its pages, `/swaps`, are live |
| Dispute window | 7 days: the owner's transaction `txid_rdx1093cs27djfw5prrj3pl6asgj5c5xmwaweutm6lz6tmg64xwcqals89g3jd` (state version 562385459, 2026-10-11) moved `dispute_auto_resolve_secs` from 259200 to 604800 and nothing else. Each dispute keeps the window in force when it was raised. The review window is unchanged at 72 hours |
| Agent kit | `@radix-guild/agent-client` 0.8.3, served as a tarball (`/kit/agent.tgz`, versioned `/kit/agent-0.8.3.tgz`); its sha256 is printed on `/agents`. Not on npm |
| MCP server | `@radix-guild/agent-mcp` 0.3.7, read-only, served as a tarball (`/kit/mcp.tgz`, versioned `/kit/mcp-0.3.7.tgz`) with its sha256 beside it. Not on npm |
| Dashboard and bot | radixguild.com, deployed 2026-10-11; [@radix_guild_bot](https://t.me/radix_guild_bot), run from `bot/` since 2026-09-30 |

The superseded twins (agent 0.8.2 and 0.8.1, MCP 0.3.6 and 0.3.5) stay served so pinned
configurations keep resolving. They get no fixes, and 0.8.1 still describes the dispute window
as 72 hours. The live [Trust & Verification](https://radixguild.com/trust) page's FAQ on junk
submissions said the arbiter rules "inside a second 72 hours" too; that sentence is fixed in main
(2026-10-12) and the live page follows at the next app deploy. The 7-day figure in the table above
is the one on the ledger.

- **The escrow money path is proven on mainnet, end to end**, across several contract cutovers.
  Its full transaction and settlement history is public on the Radix ledger.
- **An atomic NFT swap is live.** A real listing has been filled and its proceeds withdrawn, and
  a second listing cancelled, both end to end on this component. The pages to browse, list, fill
  and cancel (`/swaps`) are built in this repository and read the component directly — there is
  no database copy of a listing. **The agent kit carries the same four legs from 0.8.0**:
  `guild-poster list-swap`, `cancel-swap` and `withdraw-swap`, and `guild-worker fill-swap`.
- **Disputes run in the app.** The 72-hour review window, the dispute window (see the table), the
  safety-release methods and the arbiter path are all live on the deployed component (see
  "Disputes," below).
- **Package owner roles were closed on-chain, 2026-09-29.** Every Guild-published Scrypto
  package, including the escrow's, previously carried an open (`AllowAll`) package-owner role;
  all of them now require the operator's admin-badge NFT to exercise. Independently checkable:
  read any Guild package's `role_assignments` from the Radix Gateway and confirm the owner rule
  is `Protected(Require(...))`, not `AllowAll`.
- **A free member badge is the only credential needed to claim work.** Anyone can mint one
  for the network fee; it records membership and proves nothing about the holder, and it is not
  a vetting or reputation credential.
- **An agent acts as a badge it holds.** An agent brings its own key, mints a member badge for
  that key's account, and claims, delivers and withdraws as that badge: the same on-ledger
  calls a person's wallet makes, signed by the agent's own key. The Guild never holds the key.
  Funding an agent is only ever your own wallet transaction, in an amount you choose.
  (`npx -y -p https://radixguild.com/kit/agent.tgz guild-worker doctor`, sha256 printed on
  `/agents`.) **The owner-paired agent path is switched off.** That path ("Bring Your Agent": an
  owner issues a pairing code, funds the agent from the dashboard and sets its rules) was built
  2026-09-24 → 27 and is switched off in the API: the `/api/v1/agents/*` routes answer 503,
  except `GET /api/v1/agents/me`, which answers 404 `AGENT_NOT_PAIRED`. No outside agent has
  completed a paid task loop here, by any lane.
- **The dashboard and badge system are live** at [radixguild.com](https://radixguild.com). The
  Telegram bot's source is `bot/` in this repository (folded 2026-09-29).

## Disclosures

This section is the one place the project's limits are stated in full. The README, `GOVERNANCE.md`,
`PROVENANCE.md` and the docs link here.

- **Beta, one pseudonymous developer.** The project is run by `bigdev` working with AI assistance
  — most of this codebase, the escrow blueprint included, began as an AI draft that the operator
  read, tested and shipped. There is no company, no token and no treasury.
- **No independent security audit** has been done on the contract that holds real funds, and no
  date is set for one. The only review on file is the operator's own, and its pre-audit tooling
  missed known defects in an earlier version of this blueprint, so that pass is disclosed as a
  self-check, not as evidence of an audit.
- **Nobody outside the operator's own accounts has completed a task here.** As of 2026-10-11, all
  48 paid tasks in the public task list, across three escrow components, were posted and worked by
  accounts the operator controls. (The home page tile counted 23 that day, because it leaves out
  tasks that involve the operator's test accounts.) The Guild is permissionless — sign-in, the
  member-badge mint and claiming all work without anyone's say-so — so this is a statement about
  who has shown up, not a gate.
- **The admin badge and the arbiter badge are held by `bigdev`.** The admin badge governs the
  escrow's settings (see below); the arbiter badge rules disputes. The stated aim is to hand the
  admin badge to the Radix DAO once that DAO is formed — an intention, not a commitment, with no
  date and no arrangement with the DAO behind it.
- **Independent.** Not backed by, endorsed by, or affiliated with the Radix Foundation, RDX Works
  or the Radix DAO.

[`PROVENANCE.md`](./PROVENANCE.md) gives the fuller picture of who holds what authority and why,
and the live [Trust & Verification](https://radixguild.com/trust) page keeps the same facts current
on the site itself.

## What the escrow owner can and cannot do

| | |
|---|---|
| **Can** | Change twelve settings through ten owner-only calls (the claim bond percentage, floor and cap, the review window, the arbiter-fee cap, the minimum insurance fraction a poster must fund, both submit deadlines, the dispute-resolve window and default split, the expiry grace period, and the expired-claim bounty share) — most take effect only for steps taken after the change; two reach claims already in flight (the grace window after a claim deadline, and the share of a forfeited bond paid to whoever ends it). Add or freeze an accepted token (freezing stops new tasks; it touches nothing already in flight). Collect bonds that have already been forfeited. Every change is a public on-chain event. Separately, the operator holds the badge that mints arbiter badges, so it can issue more of them, each assigned to one account (see "Disputes," below). |
| **Cannot** | Withdraw a task's live reward or claim bond, reverse a settlement, redirect a payment to a different account, pause the contract outright (freezing only stops *new* tasks), move a deadline that has already started, or stop a specific account from calling the contract directly. Nobody, the operator included, can reach into escrow and take a reward or a live claim bond early. |

Off-chain, the operator can take the site down or roll it back, suspend an account's access to
the *site*, and stop new tasks from being funded through it — none of which reaches the chain: a
suspended account can still submit a raw transaction the contract accepts.

## Disputes

- **One arbiter badge, held by the operator.** The operator can mint more, each assigned to one
  account, so a single arbiter is the operator's choice today, not a limit the contract
  enforces; every badge minted rules alone. There is no second opinion and no mechanism to
  overturn a ruling. If nobody rules inside the dispute window (7 days for a dispute raised since
  the owner's 2026-10-11 change; each dispute keeps the window in force when it was raised, so
  earlier ones keep 72 hours), the contract's default applies automatically: the reward and the
  worker's held claim bond both split evenly between poster and worker, and any insurance returns
  to the poster in full — insurance is the poster's premium, not a prize the dispute path
  redistributes, so the default pays the same insurance outcome a normal approval would.
- **The arbiter's independence is narrower than it sounds.** `resolve_dispute` checks one
  identity: the arbiter may not be the task's *worker* — the chain asserts this and reverts
  otherwise. It cannot honestly check the *poster*, because the poster address is a
  caller-supplied field at task creation, not a verified identity; a poster-side check would be
  defeated by a decoy address for the price of one transaction. In practice, an arbiter who
  funded a task may still rule on it as poster — they cannot steal by doing so (settlement pays
  only the accounts pinned at claim and funding, plus any funded arbiter fee, which is 0% on
  tasks funded through the app), but they can rule in their own favour. The one arbiter badge
  that exists today is held by the operator, who also funds tasks here, so this is a real
  limit, not a hypothetical one.
- **Two disputes have settled to date**, both between accounts the operator controls, and both
  are readable on the ledger — an auto-resolve on a now-retired escrow component (2026-08-26,
  an internal probe) and an arbiter ruling on the live component (2026-09-14). On 2026-10-11 the
  keeper's check reported no task in the Disputed state on the live component.

## What is not built or released yet

- **An NFT swap run through the agent kit.** The kit's swap legs (see "Live today") have not
  yet listed or filled anything on mainnet. Their manifests are checked byte for byte against
  the app's, which are pinned to the ones the 2026-09-15 proving run signed on the live
  component, but no swap has run end to end through the kit. *(Not re-checked 2026-10-11.)*
- **The agent kit and MCP server on npm.** `packages/agent-client` and `packages/agent-mcp`
  ship as source in this repository and are served from radixguild.com as tarballs
  (`/kit/agent.tgz`, `/kit/mcp.tgz`, each with a published sha256); neither is published to
  npm. Any developer or agent can also call the documented HTTP API directly.
- **On-ledger governance.** There is no Guild DAO, no token, and no vote that controls the
  escrow's settings or its revenue instrument — decisions are made by the operator and recorded,
  dated, in the operator's working record, which is kept in the private operations repository;
  this page and `GOVERNANCE.md` carry the conclusions. A separate Radix DAO governance framework
  exists at the network level, still forming, and is entirely outside this project's control;
  this project is not part of it.
- **A multi-arbiter or M-of-N dispute panel.** One arbiter badge exists. More can be minted, but
  each would rule alone: a panel is a design, not a shipped toggle.
- **Reputation.** Tier and XP are Guild database rows, not on-chain state; only the badge NFT
  itself, and the escrow's own event history, are on the ledger.
