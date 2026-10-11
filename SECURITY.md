# Security policy

This repository is the Guild marketplace: an escrow blueprint deployed on Radix **mainnet** that
holds real funds, plus the dashboard and bot that sit in front of it. A security finding here can
mean real money is at risk, and this file says what to do when you find one.

## What counts as a finding here

Anything that could let someone move money out of escrow they don't own or aren't
entitled to, bypass a role or access-control check, forge or replay authorization
for an on-chain method call, or otherwise get the deployed component to do
something its published rules don't allow — in the escrow blueprints (`escrow/`),
the badge/agent-badge blueprints (`badge-manager/`, `blueprints/`), or any code that
builds, signs or submits a transaction against them, or decides who is paid: the
dashboard (`guild-app/`), the agent kit (`packages/agent-client/`, which builds and,
with `--live`, signs claim, withdraw and swap transactions with the agent's own key),
the MCP server (`packages/agent-mcp/`, read-only, whose answers an agent may act on),
and the Telegram bot (`bot/`, which links Telegram accounts to wallets and contains a
transaction-signing service). A flaw in one of these is a security finding even when
no blueprint is at fault, for example a manifest that pays the wrong account.

## Supported versions

Fixes land on `main` and ship from there. Only what is deployed today is supported, and nothing is
backported. [`STATE.md`](./STATE.md) names the current component addresses and kit versions.

| Part | Supported |
|---|---|
| Escrow and NFT-swap components | The live Wave B escrow and the live `NftSwap` component. Earlier escrow components are retired in place and are not supported |
| Dashboard and bot | `main`, as deployed to radixguild.com |
| Agent kit and MCP server | The current versions served from `radixguild.com/kit/`. Older versioned tarballs that stay served so pinned configs keep resolving are superseded and get no fixes |

A flaw in the deployed blueprint cannot be patched in place: the contract is immutable once
deployed, so a fix is a new component and a migration. That takes longer than a code fix, and the
maintainer will say so in the reply rather than promise a date.

## Reporting a security issue

**Do not open a public GitHub issue, and do not describe the finding in a
commit message, PR description, or anywhere else visible outside a private
channel.** A vulnerability that is exploitable on-chain is a coordinated
disclosure to the maintainer, made privately, before it is written up anywhere
public. Use GitHub's private vulnerability-reporting flow on this repository
(Security tab → Report a vulnerability), or message the maintainer privately on
Telegram: @bigdev_xrd (the same contact `security.txt` publishes).

Include what you found, the affected file(s) or blueprint method, and, if you
have one, a reproduction — a testnet or simulator repro is strongly preferred
over anything demonstrated against mainnet.

If you are not sure whether something rises to this level, treat it as if it does
until it's been looked at. Coordinated disclosure costs nothing if the finding
turns out to be benign; the reverse mistake — a live exploit discussed in public
before it's fixed — is not recoverable, and this project is single-operator with
no dedicated security team, so there is no fast fallback if that happens.

## What to expect

The target is to acknowledge a report within 7 days. This is one maintainer, so that is a target,
not a guarantee; if a week passes with no reply, send a short nudge on the other channel. The
maintainer works a fix before any public discussion and will tell you when it is safe to write
the finding up. There is no funded bug-bounty program; reports are still welcome and handled the
same way regardless of whether a reward is on offer.

## What this policy does not cover

General usage questions, feature requests, and non-security bugs in the app, the
kit, the bot, the CI, or the docs are fine as a public issue — see `.github/ISSUE_TEMPLATE/`. A
governance or business-model disagreement (see `GOVERNANCE.md`) is not a security
finding either, however strongly held.
