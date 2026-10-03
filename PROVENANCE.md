# Provenance


See [`GOVERNANCE.md`](./GOVERNANCE.md) for the fuller decision-making picture this page is one
part of, and [`STATE.md`](./STATE.md) for what is disclosed about the operator and the
project's current limits, kept current.

## Where this came from

This codebase is a from-scratch rebuild, written by one operator (`bigdev`, GitHub
[`@bigdevxrd`](https://github.com/bigdevxrd)) using AI coding agents as the primary
implementation tool, of an earlier bounty/escrow surface that shipped under a different
repository name. That earlier surface is paused, not this one.

The repository this file ships in was extracted from a private predecessor
(`guild-saas`) as a **single squashed commit** — not that repository's full development
history. That is a deliberate choice, recorded in the project's private planning notes, not an
attempt to obscure how the code was written: development happened across hundreds of commits,
many of them authored by automated agent tooling rather than a human typing directly (see
`NOTICE` — "Ralph (Archon)", "Copilot" and "vps-claude" among others name that tooling, all of
it operated by the one copyright holder, not third-party contributors), and squashing to one
commit avoids publishing an authorship trail that would misrepresent who is answerable for the
code as a named individual. The single public commit is authored `bigdevxrd
<212289383+bigdevxrd@users.noreply.github.com>` — the GitHub account of the copyright holder named in
[`NOTICE`](./NOTICE) — because everything in it, regardless of which tool produced the diff,
was directed by and is owned by that one person.

The private repository this snapshot came from is not deleted or made unreachable by this — it
is kept, unpublished, by the operator, specifically because this project's own documentation
(design notes, decision records, audit write-ups) cites specific commits by hash from that
history. Keeping it lets a stale citation still be resolved by someone with access to it; it
grants no one else any claim on it, and nothing in it is part of what this repository ships.

## Licence

**The Apache License, Version 2.0, with its patent grant**, applied uniformly across the escrow
blueprint, the agent client, the badge manager, and the dashboard — see [`LICENSE`](./LICENSE)
and [`NOTICE`](./NOTICE) for the full text and the licence's own history (this codebase briefly
carried MIT terms before moving to Apache-2.0, root and all, by 2026-08-16; `NOTICE` records
why and preserves the prior grant in abridged form). The patent grant matters specifically
because this is money-handling infrastructure: Apache-2.0 is not paired with MIT as a dual
licence here, because dual-licensing would make that grant optional, and the grant is the reason
Apache-2.0 was chosen over MIT in the first place.

## Who holds authority over this code, today

There is no ambiguity to soften here: **one person, `bigdev`, holds it all.**

- **This repository's admin access** belongs to `bigdev`. No committed transfer date exists.
- **The escrow's owner badge** — the on-chain authority that can adjust the deployed component's
  settings, where the blueprint exposes that authority at all — is held by an account `bigdev`
  controls. What it can and cannot do is a matter of public chain fact, not description: see
  `escrow/scrypto/*/src/lib.rs` for the authoritative account of what any given badge actually
  authorises, and [`STATE.md`](./STATE.md) for a plain-language summary kept current.
  **On 2026-09-29 the owner role of every Guild-published Scrypto package was moved from a fully
  open (`AllowAll`) rule to one requiring this same admin badge** — independently checkable by
  reading any Guild package's role assignments from the Radix Gateway.
- **The separate arbiter badge that rules disputes** is also held by `bigdev` today, and has a
  supply of one. See `STATE.md`'s "Disputes" section for the limits that follow from that.
- **There is no other legal entity.** No company, no foundation, no DAO, no token. See
  `GOVERNANCE.md` §1–2 for what is, and is not, governed by anything other than this one
  person's decision, today.

This is a plain statement of present fact, not an endorsement of it staying this way — see the
next section.

## Who this is intended for, eventually

**The stated aim is to hand the admin badge to the Radix DAO once that DAO is formed.** Two
things are true about that sentence and both matter:

- **It is a stated intention, not a commitment, and it has no date attached.** Naming an
  intended recipient here does not transfer anything, does not bind the operator to a timeline,
  and is not a representation that any transfer has been arranged, discussed with that DAO, or
  agreed by anyone but the operator.
- **It cannot happen yet, mechanically.** The Radix DAO's own governance is still forming, and
  this project has no arrangement with it of any kind. Until the DAO exists in a form that could
  receive something like this, there is nowhere for an offer to land, and none has been made.

When that changes, this file changes, in the same commit as whatever made it true — the same
rule `GOVERNANCE.md` §7 states for governance changes generally.

## What is provisional in this file

- **The exact account or accounts holding on-chain authority over the deployed escrow
  component**, beyond "an account controlled by `bigdev`," is deliberately not enumerated here
  for operational-security reasons and is not something this document verifies against a live
  chain read. Treat any specific address claim about it as provisional until independently
  confirmed against the Radix Gateway.
- **Whatever the Radix DAO's own governance framework eventually specifies about receiving a
  project like this one** is stated above only as this project's current understanding of a
  framework still forming outside this project's control — not as a fact this repository's own
  history can verify. Check that framework's own materials for the current, authoritative
  version of it.
