<!-- status: live
     verified: 2026-10-02 (SCOPED: status-board rows 1, 2 and 4, Step 2's scope line and Step 4's
     heading and offer line ONLY, against the live /trust and /bug-bounty pages and this
     repository's tree. Nothing else re-checked this pass.)
     verified: 2026-08-16 (licence lines only — Step 1's licence status re-checked against
     DECISIONS LOCKED item 3 and PR #385; the 2026-08-15 verification stands for the rest:
     Steps 1-5 and the status board re-checked against PROJECT-STATE.md's 08-14 open-source
     ruling, the 08-04 Launch Shape B ruling and the gitleaks CI state. Step 1 is materially
     superseded and is annotated; Steps 2-4 are unchanged and still un-started; Step 5's
     2026-07-31 soulbound warning was re-read and STANDS — it is chain-verified and must not be
     removed.)
     supersedes: none (pre-dates the header rule) -->

# Trust-Backing Plan — web3-native identity, no doxxing

> 🔴 **Step 1 is SUPERSEDED in scope (marked 2026-08-15).** It is written as *"open-source the
> blueprint, **keep the app closed**"*. The 2026-08-14 sitting decided **open source outright**,
> MVP-then-flip: the flip bar is the 5-feature MVP, **`guild-app` itself goes open**, and
> guild-public — named below as the publication target — **folds and retires**. So the
> destination repo in Step 1 is wrong, and "the moat is execution/UX, not the blueprint" is no
> longer the operating posture. What survives unchanged and still gates the flip: the **scrub**
> (done — gitleaks baseline clean, CI green in both repos), the **licence** (✅ **LOCKED
> 2026-08-15, decision 3: Apache-2.0 everywhere** — `escrow/…/Cargo.toml:11` since `f5687ea`;
> root `LICENSE` + `NOTICE` + `guild-app/package.json` via PR #385, opened 2026-08-16. This
> parenthetical read *"still undecided; `escrow/` has no licence field, so unset defaults to root
> MIT — decide it in the flip sitting"* until 2026-08-16 — both halves were false by then), the
> **reproducible-build procedure**, the **auth-role table**, and the hard rule that **nothing
> publishes before the PULL cutover**.
>
> ⚠️ **Knock-on for Step 3.** The commitment bond's rationale elsewhere in the corpus is "the
> load-bearing interim artifact **while source was closed**". With source opening, that premise
> weakens — treat keep-vs-drop as a live re-decision, not an inherited commitment.

> 2026-06-12 · Track 2 of the production push (track 1 = product + docs).
> Approved by bigdev: steps 1–3 + trustee-KYC offer at >$50k USD. Principle: the builder
> should be more exposed than the users are — verifiably, on-ledger, pseudonymously.

## Step 1 — Open-source the blueprint (the money path), keep the app closed

**What:** publish `escrow/scrypto/guild-marketplace-escrow` source publicly (target:
`guild-public` repo, where the OSS half already lives) together with:
- toolchain pin (Scrypto version, build flags) + build instructions,
- the deployed package address and a reproducible-build procedure so anyone can verify
  published source ⇒ on-ledger package hash,
- the auth-role table (what the owner badge can and cannot do).

**Why it works:** converts "trust me" into "verify the part that holds your money."
The app around it stays closed — the moat is execution/UX, not the blueprint.
**Before publishing:** scrub internal comments; ~~pick license (suggest Apache-2.0, matching the
app's stated license)~~ ✅ **licence PICKED AND APPLIED 2026-08-04** — `Cargo.toml:11` is
`Apache-2.0` (`f5687ea`, #330), with a written rationale rejecting the `MIT OR Apache-2.0` dual
because it would make the patent grant optional. ⚠️ Note the parenthetical was also wrong on its
own terms at the time: the app's licence WAS **MIT**, not Apache — root `LICENSE` was MIT and
GitHub reported `mit`, so the blueprint did *not* "match the app". ✅ **Closed: guild-app's
licence is LOCKED 2026-08-15 (PROJECT-STATE.md, kept in the private operations repository:
DECISIONS LOCKED item 3): Apache-2.0 everywhere —
applied by PR #385** (opened 2026-08-16; open at time of writing): root `LICENSE` → Apache-2.0,
`NOTICE`, `guild-app/package.json`, `README.md:205/212`, `CONTRIBUTING.md:121`. This sentence
read "the question still open for the flip sitting" until 2026-08-16; the reason the sweep could
not wait for that sitting is that "decide nothing" would have shipped the app MIT by default,
plus a README that pre-announced it. Then: decide whether vNext (§8b) or vNext2 source is the first
publication target — publishing the *currently deployed* version is the honest move, then each
migration publishes its source at cutover.
**Cost:** ~zero. **Owner:** bigdev (scrub sign-off; licence done). **When:** before public beta.

## Step 2 — Bug bounty, escrowed through our own escrow

**What:** post the bounty as real on-chain Guild tasks — the Immunefi-vault pattern:
on-chain proof the program is funded, settled by the system under test.
- Scope v1: the escrow blueprint + the confirm path (`escrow-confirm.ts`) + manifest
  builders. Out of scope for v1: the app UI.
- Tiers as committed terms (e.g. critical: vault drain / unauthorized release; high:
  state-machine stranding; medium: griefing/DoS-of-settlement). Amounts **TBD bigdev**.
- Each tier = one funded task with `acceptance_criteria[]` = reproduction requirements
  (PoC required, Immunefi-style).

**Why it works:** strongest possible commitment signal + a live demo + actual security.
**Owner:** bigdev (pot size), then post + announce in TG. **When:** with or right after
step 1 (researchers need source).

## Step 3 — Timelocked commitment bond

**What:** a labeled on-ledger vault holding XRD that bigdev *cannot withdraw* for a fixed
period, publicly pledged against protocol-bug losses up to a cap during pilot/beta.
- Radix-native shape: an AccessController-secured account with **timed recovery only**
  (the delay is the lock and is visible on-ledger), or a minimal bond component with a
  hard `unlock_after` instant. Metadata names it: "Guild commitment bond — pledged
  against protocol loss until <date>".
- Published on the trust page + auditor guide with the address and the pledge terms
  (what it covers, cap, claim process — claims adjudicated like any insured dispute).

**Decisions TBD bigdev:** amount, lock duration (suggest 6–12 months), coverage cap
wording. **When:** announce with the TG post; fund before public beta.

## Step 4 — Trustee-verified identity for big engagements (planned, not available yet)

For tasks/projects **over $50k USD**: a named third party (legal wrapper or escrow agent)
verifies the operator's identity and attests it exists and is reachable — published as an
attestation, identity itself stays private. The docs (`AUDITOR-GUIDE.md` §5,
`HOW-IT-WORKS.md`) and the site's Trust & Verification page describe it as planned, not
available: no trustee is retained and no provider is named. Engage a trustee when the first
such client appears — no standing cost until then.

## Step 5 — The trust-badge ladder (the system is only as good as its users)

Goal: **verifiable trust badges** — reputation earned on-ledger and legible to strangers.

> ⚠️ **Soulbound is NOT reachable on the live resource, and this step is unsequenceable as
> written** (chain-read 2026-07-31). The Member badge is `withdrawer=AllowAll` with **every**
> `*_updater` role `DenyAll` — it is transferable *permanently*. Delivering a soulbound badge
> requires minting a NEW resource, migrating existing holders, and repointing both the escrow's
> `worker_badge_resource` and the app's `BADGE_NFT`. None of that is in any plan or schedule.
> **OPEN DECISION:** new-resource-plus-migration, or drop soulbound and make settled-escrow
> history — not the token — the portable record.

Sequencing:
1. **Seed phase:** invite the few already-trusted Radix devs first; badge them; their
   agents work under their badges (human-accountable agent model). High trust scores at
   the top of the leaderboard make the marketplace legible before volume exists.
2. **Earn phase:** trust accrues only from settled escrow history (completions, on-time
   rate, dispute outcomes, waivers granted/received) — not from purchases or follows.
   App-side trust tiers exist today; the soulbound on-chain badge lands with the
   reputation design (`design/reputation-design.md`, kept in the private operations
   repository) in the vNext2 era — see the ⚠️ above:
   that needs a NEW resource, not a change to the live one.
3. **Retail phase:** open onboarding once the badge ladder carries enough signal that a
   stranger can pick a worker by record alone.

## The trust page (ties it together)

One page (route TBD, content = `AUDITOR-GUIDE.md` §2): the claims, the addresses, the
verification steps, bond + bounty status, and the honest-gaps register. "Don't trust us —
check."

## Status board

| Item | Status | Blocker/decision |
|---|---|---|
| 1. Blueprint open-source + reproducible build | ⚠️ **Scope changed 2026-08-14 — now "open source outright", see the header note.** Scrub ✅ **CLEARED** (gitleaks baseline, CI green both repos). Source: in this repository (`escrow/scrypto/guild-marketplace-escrow`, Apache-2.0). Reproducible-build verification that a reader can run (build it, compare against the deployed package): planned (/trust, 2026-10-02) | ~~Licence still undecided (unset ⇒ root MIT by default)~~ ✅ **licence LOCKED 2026-08-15 (Apache-2.0 everywhere), applied by #385 2026-08-16** · MVP flip bar · **no publish before the PULL cutover** · U3/PII to `main` · VPS-IP scrub |
| 2. Bug bounty via own escrow | Approved, not started (/trust: Planned). Until it starts, the site's beta bug-bounty page pays no cash | Pot + tier amounts (bigdev) |
| 3. Commitment bond | Approved, not started | Amount + duration (bigdev) |
| 4. Trustee KYC >$50k | Planned, not available yet (/trust, 2026-10-02): no trustee retained, no provider named | Engage a trustee on the first client |
| 5. Trust badges | Strategy set; app tiers live | ⚠️ **OPEN (2026-07-31):** soulbound is unreachable on the live resource — needs a NEW resource + holder migration, or drop it (see Step 5) |
