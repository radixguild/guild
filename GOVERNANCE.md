# Governance

**Short version: today, one pseudonymous operator decides. There is no token, no DAO vote, and
nothing on this page is a promise that a community controls the protocol yet.** This document
exists so you can tell the difference between what is decided, what is delegated, and what is
merely aspirational — before you spend time or money here.

Last reviewed: 2026-10-02. §2–§4 and §6 were re-checked against the live escrow component (read
from the Radix Gateway), its source and the live site; §1, §5 and §7 were re-read, not
re-verified.

---

## 1. Who decides, today

| Layer | Who decides | How you can tell |
|---|---|---|
| Protocol (the escrow blueprint) | The operator (`bigdev`) | The deployed package is immutable; changing behaviour means deploying a new component and migrating |
| The app (this repo) | The operator | Ordinary commits and releases |
| Money in escrow | **Nobody with discretion — until a dispute.** The blueprint routes undisputed settlement | Undisputed settlement is executed by the component per its published rules, not by an admin action. A *Disputed* task is ruled by the arbiter-badge holder — today the operator (§4) — who may pay the worker, refund the poster, or split |
| Working groups | Members, by joining and posting | Joining is self-serve; a group is a joinable task category that filters your feed. It binds no vote, treasury, lead or budget. Push notifications are designed, not wired |
| Disputes | An arbiter badge holder | See §4 — this is the honest gap |

`bigdev` is a pseudonym. That is deliberate and is not going to change. It has a cost, and the
cost is yours as much as ours: **you cannot sue a pseudonym.** Weigh that against the fact that
the escrow's rules are published and executable, which is the part that actually holds your money.

## 2. What is NOT governed by a vote

- **There is no governance token.** None is planned as a condition of using the Guild.
- **The member badge is a public, unlimited mint.** It records membership, and it is what an
  account presents to claim a task. It is not a credential — anyone can mint one, and it proves
  nothing about the holder — and holding one confers no vote.
- **No DAO currently controls the escrow, the treasury, or this repo.**

If you read a claim anywhere that contradicts the three lines above, the claim is wrong and we
would like to know about it.

## 3. On-chain facts you can check yourself

These are the parts you do not have to take on trust:

- **The escrow blueprint is Apache-2.0**, patent grant included. Its source is in this repository
  (`escrow/scrypto/guild-marketplace-escrow`), so you can read the rules that move your money,
  and you can build and deploy your own component from it if you would rather not use ours.
  Reproducible-build verification — rebuilding the blueprint yourself and matching the bytes of
  the package deployed on-chain — is planned, not done; see
  [Trust & Verification](https://radixguild.com/trust). Until then, check what the deployed
  component does: its methods, its state and every transaction are on the ledger.
- **The revenue instrument is a poster-side component royalty on `create_task`, enforced by
  the ledger, and it is set to 0 XRD.** The live component has its royalty module switched on:
  `create_task` carries a royalty of 0 XRD, and every other method is free, the worker's legs
  included (the source locks those at instantiation). Only the escrow's royalty-admin badge
  (supply 1, held by an account the operator controls) can move the `create_task` dial. It is
  not a fee the app can decide to charge you.
  Radix caps any per-call royalty at ~166.67 XRD; **there is no Guild-specific on-ledger cap** —
  the intended dial is stated in copy and metadata, not enforced by the chain. A consequence worth
  stating plainly, because it cuts against us: anyone can run their own frontend against our
  component, and anyone can redeploy the blueprint with the dial at zero. We are not relying on
  the licence to prevent that.
- **The worker side pays no platform fee.** Any fee instrument is poster-side.

## 4. The honest gaps

A governance document that only lists strengths is marketing. These are the things we would want
to know if we were you:

- **Disputes.** Disputes run in the app (since 2026-08-29) and on-chain. The single arbiter
  badge (supply 1) is held by an account the operator controls, so the operator rules every
  dispute: there is no second opinion and no appeal. Once a dispute is raised, the worker's
  claim bond splits the same way as the reward, whether the arbiter rules (one split for the
  reward, the insurance and the bond) or nobody does: after 72 hours the contract's fixed
  default splits the reward and the bond evenly between poster and worker and returns the
  poster's insurance in full. `STATE.md` says what has settled so far. Treat dispute
  resolution as immature and size your exposure accordingly.
- **Reputation is off-chain.** XP and the trust record are Guild database records (the trust
  record is derived from the escrow's on-chain history). The badge carries a tier and an XP
  field on-chain, but only the operator can write them, and the badge is transferable.
- **The operator can stop.** This is a solo project. There is no organisation behind it, no
  entity, and no funding round. If it stops, the escrow component keeps executing its published
  rules — that is precisely why the money path is on-ledger and the app is not load-bearing for
  settlement — but nobody will be shipping features.

## 5. What is parked, and what "parked" means

Parked means **decided-not-now**, with the reason recorded, so that picking it up later is a
decision rather than a drift.

- **MUAN (a dedicated governance platform): PARKED until launch.** Nothing has been created
  on-chain. A throwaway prototype dry-run may happen pre-launch, after the escrow cutover; it
  decides nothing. The community decides post-launch whether Guild governance lives there at
  all. The in-app governance surface **assists** that future decision; it does not pre-empt it.
- **Conviction Voting (CV2): PARKED as a candidate rail.** It is our own deployed fork — *not* a
  Radix Foundation component — reads are on, writes are dark by default, and **its voting leg has
  never been exercised on mainnet.** It is a candidate for a future decision surface, not a live
  one. Naming it here is the whole of its current status.
- **Third-party DAO portals.** Where the app links to an external portal, treat the link as a
  link. We do not assert that Guild governance is happening on someone else's site.

## 6. How a decision gets made and recorded

1. Anyone can raise a question — in the Guild Telegram, in a working group, or as an issue
   here.
2. The operator rules on it, in a sitting, with the reasoning written down.
3. The ruling lands in the repository's state document, dated, next to what it supersedes.
4. If a ruling turns out to rest on a wrong fact, **the correction is recorded next to the
   original rather than replacing it silently.** How a thing went stale is usually more useful
   than the corrected value.

This is not a democracy and we are not going to describe it as one. It is a small project whose
money path is on-ledger and whose source is in this repository, so that trust in the operator is
not the load-bearing part.

## 7. When this changes

The intended direction is that the community takes over governance after launch, and that the
Guild's own working groups are the first step toward it. **That is an intention, not a
commitment, and no date is attached to it.** When it changes, this file changes, in the same
commit as whatever made it true.
