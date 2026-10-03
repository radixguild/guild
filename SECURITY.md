# Security policy

This repository is the Guild marketplace: an escrow blueprint deployed on Radix
**mainnet** that holds real funds, plus the dashboard and bot that sit in front of
it. That means a security finding here can mean real money is at risk, and this
file says what to do when you find one.

Radix mainnet was halted from 2026-08-31 to 2026-09-11 and has been producing blocks
since; the escrow component is live on it. This policy applies the same way whether
or not the chain is producing blocks — during a halt, funds already in escrow are
static.

## What counts as a finding here

Anything that could let someone move money out of escrow they don't own or aren't
entitled to, bypass a role or access-control check, forge or replay authorization
for an on-chain method call, or otherwise get the deployed component to do
something its published rules don't allow — in the escrow blueprints (`escrow/`),
the badge/agent-badge blueprints (`badge-manager/`, `blueprints/`), or the
application code that constructs and submits transactions against them
(`guild-app/`).

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

The maintainer will acknowledge a report and work a fix before any public
discussion. There is no funded bug-bounty program; reports are still welcome and
handled the same way regardless of whether a reward is on offer.

## What this policy does not cover

General usage questions, feature requests, and non-security bugs in the app, the
CI, or the docs are fine as a public issue — see `.github/ISSUE_TEMPLATE/`. A
governance or business-model disagreement (see `GOVERNANCE.md`) is not a security
finding either, however strongly held.
