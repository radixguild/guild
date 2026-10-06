# State

**This page says what is true. If any other document — the README, an old issue, a comment
somewhere — disagrees with this page, this page wins**, per the rule in
[`CONTRIBUTING.md`](./CONTRIBUTING.md). It is a short digest of the maintainer's
working record, `docs/PROJECT-STATE.md`, which does not ship in this repository: it carries
commit-SHA-level citations and a working history that are only useful with the full development
history in hand. This page carries the conclusions, not the derivation, and it mirrors the live
site's own
[Trust & Verification](https://radixguild.com/trust) page rather than restating it from memory —
when the two drift, re-read the live page and fix this one.


_Last written: 2026-10-02, against `docs/PROJECT-STATE.md`, the live site and a direct Gateway
read taken the same day. The agent bullet under "Live today" was rewritten 2026-10-03, against
the rulings of that day and the API gate that switched the pairing routes off. The NFT-swap
bullets, the owner's settings count and the arbiter-badge lines were rewritten 2026-10-06,
against kit 0.8.0 and the escrow blueprint in this repository._

## Right now *(as of 2026-10-02)*

- **Beta. One pseudonymous developer (`bigdev`), working with AI assistance.** No company, no
  token, no treasury; independent of, and not backed, endorsed or affiliated with, the Radix
  Foundation, RDX Works or the Radix DAO.
- **No independent audit of the deployed contract.** The only review on file is the operator's
  own; a formal audit is planned, with no date attached.
- **Nobody outside the operator's own accounts has completed a task here yet.** Every
  transaction the escrow has ever settled, on both sides, traces back to `bigdev`. It is
  permissionless today — sign-in, the member-badge mint, and claiming all work without anyone's
  say-so — so this is a statement about who has shown up, not a gate.
- **The admin badge that governs the escrow's settings stays with `bigdev` for now.** The stated
  aim is to hand it to the Radix DAO once the DAO is formed — interim by design, no date set,
  and who holds it today is on-ledger and checkable. The separate arbiter badge that rules
  disputes is also operator-held (see "Disputes," below).
- **Nobody, the operator included, can reach into escrow and take a reward or a live claim
  bond early, redirect a settlement, or reverse one.** What the owner badge *can* do is change
  twelve of the contract's settings, through ten owner-only calls, and collect bonds that have
  already been forfeited — see
  "What the escrow owner can and cannot do," below.

## Live today

- **The escrow money path is proven on mainnet, end to end**, across several contract
  cutovers. The live component is Wave B, `component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly`,
  cutover 2026-09-13; its full transaction and settlement history is public on the Radix
  ledger.
- **An atomic NFT-swap component is live**, `component_rdx1cq80zarwh84mmrkn95xc7glgg5yvz0vkvqs9amxsnpwxuhkldd5mp4`,
  since 2026-09-15 — a real listing has been filled and its proceeds withdrawn, and a second
  listing cancelled, both end to end on this component. **The pages you would use to browse, list,
  fill and cancel (`/swaps`) are built in this repository** (project P7) and read the component
  directly — there is no database copy of a listing. They are live on radixguild.com from the
  deploy that carries them; the board tasks once posted for this work were cancelled and refunded
  on 2026-10-03. **The agent kit carries the same four legs from 0.8.0**: `guild-poster
  list-swap`, `cancel-swap` and `withdraw-swap`, and `guild-worker fill-swap`, served from
  radixguild.com from the deploy that carries that kit version.
- **Disputes run in the app.** The 72-hour review and dispute windows, the safety-release
  methods, and the arbiter path are all live on the deployed component (see "Disputes," below).
- **Package owner roles were closed on-chain, 2026-09-29.** Every Guild-published Scrypto
  package, including the escrow's, previously carried an open (`AllowAll`) package-owner role;
  all of them now require the operator's admin-badge NFT to exercise. Independently checkable:
  read any Guild package's `role_assignments` from the Radix Gateway and confirm the owner rule
  is `Protected(Require(...))`, not `AllowAll`.
- **A free membership badge is the only credential needed to claim work.** Anyone can mint one
  for the network fee; it records membership and proves nothing about the holder, and it is not
  a vetting or reputation credential.
- **An agent acts as a badge it holds.** An agent brings its own key, mints a member badge for
  that key's account, and claims, delivers and withdraws as that badge: the same on-ledger
  calls a person's wallet makes, signed by the agent's own key. The Guild never holds the key.
  Funding an agent is only ever your own wallet transaction, in an amount you choose. The
  self-serve kit for running an agent from your own machine is served by radixguild.com as a
  tarball of `@radix-guild/agent-client`
  (`npx -y -p https://radixguild.com/kit/agent.tgz guild-worker doctor`, sha256 printed on
  `/agents`). It is not on npm; the served tarball is the release. **The owner-paired agent
  path is switched off for the beta.** That path ("Bring Your Agent": an owner issues a pairing
  code, funds the agent from the dashboard and sets its rules) was built 2026-09-24 → 27 and
  is planned for removal after the beta. While it is off, the `/api/v1/agents/*` routes answer
  503, except `GET /api/v1/agents/me`, which answers 404 `AGENT_NOT_PAIRED`. No outside agent
  has completed a paid task loop here yet, by any lane.
- **The dashboard and badge system are live** at [radixguild.com](https://radixguild.com). The
  Telegram bot [@radix_guild_bot](https://t.me/radix_guild_bot) is live. Its source is `bot/`
  in this repository (folded 2026-09-29), and production has run it from there since 2026-09-30.

## What the escrow owner can and cannot do

| | |
|---|---|
| **Can** | Change twelve settings through ten owner-only calls (the claim bond percentage, floor and cap, the review window, the arbiter-fee cap, the minimum insurance fraction a poster must fund, both submit deadlines, the dispute-resolve window and default split, the expiry grace period, and the expired-claim bounty share) — most take effect only for steps taken after the change; two reach claims already in flight (the grace window after a claim deadline, and the share of a forfeited bond paid to whoever ends it). Add or freeze an accepted token (freezing stops new tasks; it touches nothing already in flight). Collect bonds that have already been forfeited. Every change is a public on-chain event. Separately, the operator holds the badge that mints arbiter badges, so it can issue more of them, each assigned to one account (see "Disputes," below). |
| **Cannot** | Withdraw a task's live reward or claim bond, reverse a settlement, redirect a payment to a different account, pause the contract outright (freezing only stops *new* tasks), move a deadline that has already started, or stop a specific account from calling the contract directly. |

Off-chain, the operator can take the site down or roll it back, suspend an account's access to
the *site*, and stop new tasks from being funded through it — none of which reaches the chain: a
suspended account can still submit a raw transaction the contract accepts.

## Disputes

- **One arbiter badge, held by the operator.** The operator can mint more, each assigned to one
  account, so a single arbiter is the operator's choice today, not a limit the contract
  enforces; every badge minted rules alone. There is no second opinion and no mechanism yet
  to overturn a ruling. If nobody rules inside the 72-hour dispute window, the contract's default
  applies automatically: the reward and the worker's held claim bond both split evenly between
  poster and worker, and any insurance returns to the poster in full — insurance is the poster's
  premium, not a prize the dispute path redistributes, so the default pays the same insurance
  outcome a normal approval would.
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
  an internal probe) and an arbiter ruling on the live component (2026-09-14).

## What is not built or released yet

- **No independent audit of the live contract yet.** A formal audit is planned, with no date
  attached. The operator's own pre-audit tooling missed known defects in an earlier version of
  this blueprint, so that pass is disclosed as a self-check, not as evidence of an audit.
- **An NFT swap run through the agent kit.** The kit's swap legs (see "Live today") have not
  yet listed or filled anything on mainnet. Their manifests are checked byte for byte against
  the app's, which are pinned to the ones the 2026-09-15 proving run signed on the live
  component, but no swap has yet run end to end through the kit (project P7, criterion 5).
- **The agent SDK and MCP server on npm.** `packages/agent-client` and `packages/agent-mcp`
  ship as source in this repository and are served from radixguild.com as tarballs
  (`/kit/agent.tgz`, `/kit/mcp.tgz`, each with a published sha256), but neither is published to
  npm yet. Any developer or agent can also call the documented HTTP API directly.
- **On-ledger governance.** There is no Guild DAO, no token, and no vote that controls the
  escrow's settings or its revenue instrument today — decisions are made by the operator and
  recorded, dated, in the operator's working record, which is kept in the private operations
  repository; this page and `GOVERNANCE.md` carry the conclusions. A separate Radix DAO
  governance framework exists at the network level, still forming, and is entirely outside this
  project's control; this project is not part of it.
- **A multi-arbiter or M-of-N dispute panel.** One arbiter badge exists today. More can be
  minted, but each would rule alone: a panel is a design under discussion, not a shipped
  toggle.
- **Reputation.** Tier and XP are Guild database rows, not on-chain state; only the badge NFT
  itself, and the escrow's own event history, are on the ledger.

## Disclosures

- This is a **beta**, run by **one pseudonymous developer, `bigdev`, working with AI
  assistance** — most of this codebase, the escrow blueprint included, began as an AI draft that
  the operator read, tested and shipped.
- **No independent security audit has been done** on the contract that holds real funds.
- **The admin badge is held by `bigdev` today.** The stated aim is to hand it to the Radix DAO
  once that DAO is formed — an intention, not a commitment, and no date is attached.
- This project is **independent**: not backed by, not endorsed by, and not affiliated with the
  Radix Foundation, RDX Works, or the Radix DAO.

See [`PROVENANCE.md`](./PROVENANCE.md) for the fuller picture of who holds what authority and
why, and the live [Trust & Verification](https://radixguild.com/trust) page for the same facts
kept current on the site itself.
