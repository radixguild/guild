/**
 * Era-keyed settlement copy — every user-visible sentence that is TRUE in
 * exactly one escrow world lives here, in both its forms.
 *
 * WHY A MODULE AND NOT A CEREMONY SWEEP
 * -------------------------------------
 * The cutover plan (RUNBOOK-8B-CUTOVER.md Phase 2) budgeted ~40 minutes of
 * mid-ceremony copywriting: flip NEXT_PUBLIC_ESCROW_PULL, watch launch-check
 * CHECK 4 go red on every page still describing push settlement, rewrite copy
 * under time pressure until green. This module moves that work to a reviewed
 * PR: each site carries its push AND pull form, pages pick via the SAME
 * build-time flag that arms the copy gate, so the prose flips in the same
 * rebuild that flips the manifests. The ceremony's copy step becomes: nothing.
 *
 * WHY EVERY VARIANT STRING MUST LIVE HERE (the CI blind spot)
 * -----------------------------------------------------------
 * CHECK 4 and the cold-user e2e both scan the BAKED artifact, so they gate
 * whichever era the build compiled — and CI builds with the flag off until the
 * cutover, meaning the pull branch of any inline `flag ? … : …` in a page would
 * reach the ceremony ungated. settlement-copy.test.ts closes that: it runs the
 * FULL rule tables over BOTH eras' strings statically — push strings must clear
 * BANNED, pull strings must clear BANNED + PULL_BANNED, and (the teeth) the
 * push strings that exist to be era-specific must TRIP PULL_BANNED. An
 * era-varying sentence written inline in a page instead of here is invisible
 * to that test; the completeness check in the test pins the known sites.
 *
 * THE COPY RULES STILL APPLY TO BOTH FORMS. honest-copy.mjs is the authority;
 * nothing here may overclaim in either world. The pull forms state the two
 * honest limits pull introduces: approval CREDITS rather than pays (money sits
 * in the component until the payee collects it), and collection is its own
 * signed transaction.
 *
 * Chain facts the pull forms rest on (all mainnet-proven on the P1-5 rehearsal
 * component, 2026-08-09 → 08-15): approve_and_release takes the receipt as a
 * PROOF, returns nothing, credits reward→worker / insurance→poster as
 * entitlements; withdraw_worker/withdraw_poster deposit to the payee pinned at
 * claim/create from INSIDE the component (the caller cannot redirect); the
 * claim bond returned whole at submit on THAT component — ⚠️ NOT on Wave B
 * (live since 2026-09-13): submit_task now moves no money, the bond stays in
 * its vault until a settlement path credits it to the pinned worker account
 * (E1/E2), and withdraw_worker pays reward + bond together. The
 * `bond-returned-on-submit` rule in honest-copy.mjs gates this; an expired
 * claim forfeits the bond — a small caller bounty (min 1 XRD) pays whoever
 * calls the public expire, the remainder goes to the operator vault.
 */


import { isEnabled } from "@/lib/features";
import { ESCROW_CLAIM_BOND_XRD, ESCROW_EXPIRE_BOUNTY_PCT } from "@/lib/config";

/** The forfeit split as whole percentages, from the display mirror of the
 *  component's expire_bounty_pct (config.ts). */
const BOUNTY_PCT = Math.round(ESCROW_EXPIRE_BOUNTY_PCT * 100);

export type SettlementEra = "push" | "pull";

/** A site whose copy differs by era. `null` = the site renders nothing in
 *  that era (e.g. the heartbeat cost row once the leg does not exist). */
export interface EraCopy {
  push: string | null;
  pull: string | null;
}

/**
 * THE SECOND ERA AXIS — dispute posture (added 2026-08-27, P3-3/DB-5).
 *
 * The push→pull cutover was the first time a build-time flag flipped which
 * sentences were true; NEXT_PUBLIC_FEATURE_DISPUTES is the second. Same
 * mechanism, same rule: every user-visible sentence whose truth depends on
 * whether the dispute UI compiled ON or OFF lives HERE in both its forms, and
 * the page picks via the SAME build-time flag that mounts the Raise-Dispute
 * button — so the prose cannot drift from the affordance. The 2026-08-27 copy
 * audit found the drift this prevents already latent: /disputes asserted
 * "turning it on for real is … not a config toggle" while the flag alone would
 * have mounted the button beside that sentence.
 *
 * Two tables carry it:
 *   • DISPUTE_ON_OVERLAY — for existing SETTLEMENT_COPY keys whose PULL form
 *     is only true while disputes are off. The stored `pull` string stays the
 *     off form (CI builds with the flag unset and must keep gating exactly
 *     what it renders); the overlay is the on form, applied by
 *     settlementCopy() when the flag says so.
 *   • DISPUTE_COPY — for sites with no push/pull dimension at all, keyed
 *     {off, on} directly and read via disputeCopy().
 * settlement-copy.test.ts runs the full rule tables over every form in BOTH
 * tables, plus direction teeth: an `on` form claiming the surface is off (or
 * vice versa) fails the build.
 */
export type DisputeEra = "off" | "on";

export interface DisputeEraCopy {
  off: string | null;
  on: string | null;
}

export const SETTLEMENT_COPY = {
  // ── /guide ────────────────────────────────────────────────────────────────
  guideSettleBody: {
    push:
      "Approve and the escrow releases in that one signed transaction — reward to the worker, insurance back to you. Partial disagreement has no on-chain mechanism yet: settle it with a revision round, or cancel before anyone claims. Signed, expiring split offers and arbiter-resolved disputes are vNext2 designs, not live buttons — the dispute UI is off today, and the deployed component charges no arbiter fee at all.",
    pull:
      "Approve and the contract assigns the money inside the escrow — the reward to the worker, the insurance back to you — and each of you collects with a withdrawal you sign yourself. Approval is not the payment: nothing lands in anyone's wallet until they withdraw, and the contract pays only the accounts it pinned at claim and funding time, so no settlement transaction can redirect it. Partial disagreement has no on-chain mechanism yet: settle it with a revision round, or cancel before anyone claims. Arbiter-resolved disputes are designed, not live buttons — the dispute UI is off today.",
  },
  guideClaimBody: {
    push:
      "A badge-holding dev or agent stakes a 10 XRD claim bond (the chain asserts that exact amount — but at today's XRD price it is worth about a US cent, so treat it as a marker that a claim is live, not as a deterrent) and claims. Workers see the funded on-chain balance and your committed terms before they commit. The bond returns on submit, minus 5 XRD for each deadline extension used — and after the deadline passes, anyone can call the public expire method and forfeit the whole bond, so late submission is a race a worker can lose. There is no per-task dispute setting to see: the dispute path is switched off for every task while it is hardened.",
    pull:
      `A badge-holding dev or agent stakes a claim bond sized to the task — 10% of the reward, at least ${ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting) — and claims. Workers see the funded on-chain balance and your committed terms before they commit. Submitting moves no money: the bond stays in the escrow until the task settles. When the work is approved — or the review window lapses and the release is triggered — it is credited back to you in full and you collect it with the same withdrawal as the reward; if a dispute is raised, the bond splits the way the reward does. The claim deadline is fixed the moment you claim — an hour after it passes, anyone can call the public expire method and forfeit the whole bond, so late submission is a race a worker can lose. There is no per-task dispute setting to see: the dispute path is switched off for every task while it is hardened.`,
  },
  guideKeysBody: {
    push:
      "The platform holds no signing power over a task's reward or insurance — finalization methods are public on-chain and winners settle from their own wallets. One exception, stated plainly: forfeited claim bonds and heartbeat fees collect in a vault only the component owner can withdraw. Our watcher alerts; it cannot act.",
    pull:
      "Settlement credits each party inside the contract, and everyone collects from their own wallet. The operator is the only arbiter, so on a disputed task the operator's ruling decides the split. One more exception, stated plainly: forfeited claim bonds collect in a vault only the component owner can withdraw (minus the small bounty paid to whoever calls the public expire). Our watcher alerts; it cannot act.",
  },

  // ── /docs ─────────────────────────────────────────────────────────────────
  docsAgentPayoutStep: {
    push: "Escrow releases XRD to your wallet — 100% of the reward, no platform fee",
    pull: "Withdraw your reward from escrow — one signed transaction, 100% of the reward, no platform fee",
  },
  // 2026-09-07: both docs answers dropped their Telegram clauses ("badge
  // required only for /bounty create", "verify with /bounty fund"). The live
  // bot's whole /bounty tree is gated off — it answers with one notice pointing
  // at the web app — so both clauses described commands nobody can run.
  docsBountiesAnswer: {
    push:
      "Anyone with a connected wallet can post a task from the dashboard — no badge is needed to post, and a badge is needed to claim. Posting is free and does nothing on-chain — the task must be funded in a second, signed transaction (reward + 5% insurance) before anyone can claim it. Workers then claim against a 10 XRD bond, submit their work, and the poster approves to release payment from on-chain escrow. Live today with XRD; multi-token (xUSDC/xUSDT) is designed but not yet registered on-chain.",
    pull:
      `Anyone with a connected wallet can post a task from the dashboard — no badge is needed to post, and a badge is needed to claim. Posting is free and does nothing on-chain — the task must be funded in a second, signed transaction (reward + 5% insurance) before anyone can claim it. Workers then claim against a bond of 10% of the reward, at least ${ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting), submit their work, and the poster's approval assigns the reward to the worker inside the escrow — the worker collects it with their own signed withdrawal. Live today with XRD; multi-token (xUSDC/xUSDT) is designed but not yet registered on-chain.`,
  },
  // The sharp case honest-copy.test.ts pins: a becomes-FALSE clause ("that
  // same transaction pays") in the push form. That form is unreachable dead
  // code (settlementEra() is hardcoded "pull" — see below) kept only to anchor
  // PULL_BANNED; its old trailing clause ("no automatic release yet") was true
  // of the RETIRED push blueprint, which never had a review window at all, but
  // read as a claim about the current component and had to go once the
  // BANNED rule below started scanning it too. The pull form's clause was a
  // claim about TODAY's component and was flatly false after Wave B
  // (2026-09-13) added review_window_secs / release_after_review_timeout.
  docsFundingAnswer: {
    push:
      "Posting a task and funding it are two separate steps. Posting costs nothing and needs no on-chain transaction — you sign in with your wallet, it creates the listing, and the task is not claimable. Funding is a second, signed transaction: click Fund on the task and your Radix Wallet shows a manifest that locks the reward plus 5% insurance into the escrow component's vault. No admin wallet can withdraw the reward or the insurance (the one exception is forfeited claim bonds — see 'What are the fees?'). When the poster approves, that same transaction pays the worker out of escrow. If the task page has not caught up with your deposit, click 'Resync from chain' on it.",
    pull:
      "Posting a task and funding it are two separate steps. Posting costs nothing and needs no on-chain transaction — you sign in with your wallet, it creates the listing, and the task is not claimable. Funding is a second, signed transaction: click Fund on the task and your Radix Wallet shows a manifest that locks the reward plus 5% insurance into the escrow component's vault. No admin wallet can withdraw the reward or the insurance (the one exception is forfeited claim bonds — see 'What are the fees?'). When the poster approves, the contract assigns the reward to the worker, who collects it with their own signed withdrawal; if the poster never acts, anyone can trigger the escrow's review-window release once the window lapses, which credits that same reward, and the worker collects it the same way. If the task page has not caught up with your deposit, click 'Resync from chain' on it.",
  },
  // The fee tail of both forms was rewritten 2026-08-16. It used to promise "a
  // poster-side settlement fee with an on-ledger cap of 2.5%" — there is no
  // such thing in any blueprint. The instrument that ships at the cutover
  // (lib.rs `enable_component_royalties`, DB-2) is a FLAT XRD royalty on
  // `create_task` — poster-side, 0 at launch, movable only by the royalty-admin
  // badge — bounded by nothing but the protocol's MAX_PER_FUNCTION_ROYALTY
  // (~166.67 XRD per call); every worker leg is `Free, locked`. Not a
  // percentage, not charged on release, and no on-chain percentage bound of
  // any kind. honest-copy.mjs now bans the cap claim family; this is the
  // honest form that must stay legal.
  docsFeesAnswer: {
    push:
      "Zero today. The deployed escrow charges no platform fee — workers receive 100% of the reward, and unused insurance is refunded to the poster. Verify it on-ledger: the component config has no platform-fee parameter. Workers pay no percentage of the reward, ever. The one worker-side cost is the claim bond: exactly 10 XRD locked when you claim and returned when you submit — each deadline extension spends 5 XRD of it, and an expired claim forfeits the rest into a vault only the operator can drain. The decided plan before anything changes: a poster-side royalty charged when a task is funded — a flat XRD amount per funded post, not a percentage of the reward — starting at 0, movable only by the operator's royalty-admin badge, and bounded only by the network's per-call royalty maximum (about 166 XRD). Worker-side methods are locked free on-chain. There is no percentage fee, and the contract enforces no percentage bound. Any change goes through a published RFC first.",
    pull:
      `Zero today. The deployed escrow charges no platform fee — workers receive 100% of the reward, and unused insurance is refunded to the poster. Verify it on-ledger: the component config has no platform-fee parameter. Workers pay no percentage of the reward, ever. The one worker-side cost is the claim bond: 10% of the reward, at least ${ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting) — locked when you claim and held in the escrow until the task settles — credited back to you in full when the work is approved or released after the review window, split the way the reward is if a dispute is raised, and collected with the same withdrawal as the reward — an expired claim forfeits it, with a small bounty to whoever calls the public expire and the remainder in a vault only the operator can drain. The decided plan before anything changes: a poster-side royalty charged when a task is funded — a flat XRD amount per funded post, not a percentage of the reward — starting at 0, movable only by the operator's royalty-admin badge, and bounded only by the network's per-call royalty maximum (about 166 XRD). Worker-side methods are locked free on-chain. There is no percentage fee, and the contract enforces no percentage bound. Any change goes through a published RFC first.`,
  },

  // ── Help → "Page walkthrough" (components/guides/guides.ts) ───────────────
  // The tasks tour's worker-side last step. Interaction-gated copy: neither
  // artifact gate sees it, so its era split lives here (both forms scanned by
  // settlement-copy.test.ts) rather than inline in guides.ts. The push form is
  // written to TRIP PULL_BANNED on purpose — that is what puts it in TEETH and
  // makes the cutover unable to leave the tour describing push.
  tourSubmitBody: {
    push:
      "Submit with a description of what you did and where it is (a PR link, if the task has one). The poster reviews and approves; in that same signed transaction the reward is released to you from escrow and your claim bond has already come back.",
    pull:
      "Submit with a description of what you did and where it is (a PR link, if the task has one). The poster reviews and approves; approval assigns the reward to you inside the escrow, and you collect it with a withdrawal you sign yourself — nothing lands in your wallet until you do. If the poster stays quiet, you are not stuck waiting on them: once the review window lapses, anyone can trigger that same release for you.",
  },

  // ── /money ────────────────────────────────────────────────────────────────
  moneyRewardDetail: {
    push:
      "The full bounty. Posting a task is free and moves no money; funding is a SECOND, signed transaction, and that one locks the reward and the insurance into the task's escrow vault together, atomically, in the one signature. Until you send it the task sits unfunded and nobody can claim it. Released to the worker on approval.",
    pull:
      "The full bounty. Posting a task is free and moves no money; funding is a SECOND, signed transaction, and that one locks the reward and the insurance into the task's escrow vault together, atomically, in the one signature. Until you send it the task sits unfunded and nobody can claim it. On approval the contract assigns it to the worker, who withdraws it with their own signed transaction.",
  },
  // The push form of this paragraph is the BUG-7 honest-limit disclosure. Under
  // pull the limit it disclosed is GONE — the contract routes by itself — and
  // the honest thing to state flips to the new limit: credited is not
  // collected. Same candor, opposite mechanism.
  moneyHonestLimit: {
    push:
      "Release hands the funds back to whoever submits the settlement transaction, and the web app builds that transaction to route the reward to the worker. Payout integrity rests on an honest settlement manifest, not on the contract enforcing the split.",
    pull:
      "Approval does not put money in the worker's wallet. It credits them inside the contract, and the contract pays out only to the account pinned when the task was claimed — a dishonest settlement transaction cannot redirect it. The flip side, stated plainly: the money sits in the escrow until each party signs their own withdrawal, so a credited reward is not yet a collected one.",
  },
  moneyHeartbeatRow: {
    push:
      "Charged when you extend a claim's deadline, and drawn from your posted bond rather than your account — which is exactly why it is dangerous to treat as free. At live parameters the fee is 5 XRD against a 10 XRD bond: ONE extension costs half the bond, TWO burn it outright, and a third reverts with \"claim_bond depleted\" — after which submitting returns you an empty bucket and the whole 10 XRD is gone. Because nothing leaves your account, an unattended worker never sees it happen. Neither this dashboard nor the Guild agent client can build a heartbeat any more — both legs were removed with the blueprint's, so reaching this cost now takes a hand-built manifest against the deployed component. The leg is gone outright in the next blueprint, which is not yet deployed.",
    pull: null, // the method does not exist — there is no cost to disclose
  },
  moneyNetworkFeeDetail: {
    push: "The ledger transaction fee on each action you sign (claim, submit, heartbeat). Paid to the network.",
    pull: "The ledger transaction fee on each action you sign (claim, submit, withdraw). Paid to the network.",
  },
  moneyForfeitVaultSentence: {
    push:
      "Forfeited bonds and heartbeat fees accumulate in a separate vault that only the component owner can drain.",
    pull:
      // 2026-09-24: the split stated exactly — expire_claim pays expire_bounty_pct
      // (0.1 on the live component) to its caller and puts the rest in
      // forfeited_claim_bonds_vaults, which only the OWNER badge can empty.
      `${100 - BOUNTY_PCT}% of it goes to a vault only the operator can withdraw, and ${BOUNTY_PCT}% to whoever closes the expired claim.`,
  },
  // The page interpolates the bond amount before this fragment:
  // "…you always pay Radix network fees, the {N} XRD " + this.
  moneyFreeToUseQualifier: {
    push: "claim bond, the 5 XRD heartbeat, and the poster insurance.",
    pull: "claim bond and the poster insurance.",
  },

  // ── /lifecycle ────────────────────────────────────────────────────────────
  lifecycleIntroSteps: {
    push:
      "Four steps, each a wallet transaction — money never passes through a platform account. Here is exactly what happens at each one.",
    pull:
      "Five signed transactions — fund, claim, submit, approve, and the payee's own withdrawal — and money never passes through a platform account. Here is exactly what happens at each one.",
  },
  lifecycleApproveEli5: {
    push: "The poster reviews the evidence, approves, and the reward is released to the worker.",
    pull: "The poster reviews the evidence and approves — the contract assigns the reward to the worker, who withdraws it in a final signed transaction.",
  },
  lifecycleApproveDoes: {
    push:
      "approve_and_release burns the poster’s task receipt and returns the reward (and the poster’s unused arbiter stake) as buckets to the settlement transaction. The web app builds the manifest that routes the reward to the worker’s wallet, and the poster signs it. This is the happy path: no dispute, no arbiter — those live in a separate, dormant flow.",
    pull:
      "approve_and_release checks the poster’s task receipt as a proof and credits the settlement inside the component — the reward to the worker, the unused insurance to the poster. Nothing returns to the transaction that called it: each party collects with withdraw_worker or withdraw_poster, and the component deposits straight to the accounts it pinned at claim and funding time. This is the happy path: no dispute, no arbiter — those live in a separate, dormant flow.",
  },

  // ── /about ────────────────────────────────────────────────────────────────
  aboutEscrowDisclosure: {
    push:
      "Task escrow is on-chain. Reward and insurance XRD are deposited directly into a Scrypto smart contract vault, and no admin wallet can withdraw them. One exception, stated plainly: a worker's 10 XRD claim bond is spent down 5 XRD per deadline extension and forfeited in full if the claim expires — that XRD moves to a separate forfeited-bonds vault which only the operator badge can drain. Funding is verified on-chain before tasks become claimable. The escrow component is deployed on Radix mainnet and verifiable on the Radix Dashboard.",
    pull:
      `Task escrow is on-chain. Reward and insurance XRD are deposited directly into a Scrypto smart contract vault, and no admin wallet can withdraw them. One exception, stated plainly: a worker's claim bond — 10% of the reward, at least ${ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting) — is forfeited if the claim expires — a small bounty pays whoever calls the public expire method, and the rest moves to a forfeited-bonds vault which only the operator badge can drain. Funding is verified on-chain before tasks become claimable. The escrow component is deployed on Radix mainnet and verifiable on the Radix Dashboard.`,
  },

  // ── /auditor-guide ────────────────────────────────────────────────────────
  // A deployed-component claim with a cutover expiry, flagged as such the day
  // it was written. The pull form is its resolution, not its negation.
  auditorHeartbeatStatus: {
    push: "None of this is live yet — the deployed component still has the heartbeat leg until the cutover.",
    pull: "This is now the deployed reality — the live component has no heartbeat leg.",
  },

  // ── components/tasks/escrow-truth.tsx ─────────────────────────────────────
  escrowTruthCountdownCaveat: {
    push: "if you extended the deadline or already submitted",
    pull: "if you already submitted",
  },

  // ── components/user-journey-widget.tsx ────────────────────────────────────
  // The widget documents the DEPLOYED component's methods, so its table is
  // era-keyed: the heartbeat row exists only in push, the three pull methods
  // (withdraw_worker / withdraw_poster / burn_task_receipt) only in pull.
  // ── Added 2026-08-18. These six shipped INLINE in /money and /disputes and
  //    were therefore invisible to this module's tests — the exact failure this
  //    file's header warns about. All six were SERVING push-era claims on the
  //    live PULL component for ~23h after the cutover. Their push forms are kept
  //    (not deleted) because PULL_BANNED's new rules anchor on them: a rule with
  //    no push string to match is decoration, and settlement-copy.test.ts fails
  //    the build for it.
  // Round 2, same commit: CHECK 4 with the new rules caught FOUR more served
  // sites the first pass missed — including page <head> metadata, which no
  // body-text grep would ever surface. The first pass's "0 push-era occurrences"
  // check was case-SENSITIVE while the rules are not; "manifest-routed" in lower
  // case survived it. The gate caught the incomplete fix, which is the whole
  // argument for the gate matching claims rather than sentences.
  // ── Round 3, 2026-08-18: components/tasks/escrow-actions.tsx ───────────────
  // The money-action UI. It had ZERO settlementCopy() uses against SIX
  // isEnabled("escrowPull") branches — the logic was era-aware and every
  // user-visible string was not. CHECK 4 never saw it: the gate reads the 20
  // prerendered COLD routes, and this is a client component behind auth. It is
  // also the copy a poster reads at the exact moment they sign.
  //
  // The cancel strings were the worst: they promised money "returns to your
  // account" and the worker's bond "returned to them in full in the same
  // transaction". lib.rs's `cancel_task_by_poster_after_claim` doc comment
  // says the opposite — "PULL:
  // returns nothing. Reward + insurance are credited to the POSTER and the claim
  // bond back to the WORKER" — each collected later via withdraw_*. A poster who
  // cancelled and then checked their balance would have found nothing there.
  fundInsuranceNote: {
    push: "The insurance comes back to you when you release payment; the escrow releases only on your approval.",
    pull: "The escrow releases the reward on your approval — or, if you neither approve nor dispute within 3 days of a submission, anyone can release the full reward. On release the contract credits the reward to the worker and the insurance back to you — each of you then collects with your own signed withdrawal.",
  },
  approveWindowNote: {
    push: "Release is fine now — the contract releases on poster approval.",
    pull: "Approving is fine now — the contract credits the worker on your approval, and they collect it themselves.",
  },
  approveSyncErrorLead: {
    push: "Released on-chain",
    pull: "Approved on-chain",
  },
  approveSuccessLabel: {
    push: "Payment released.",
    pull: "Approved — the reward is credited to the worker and your insurance back to you. Each is collected with a separate withdrawal.",
  },
  approveButtonIdle: {
    push: "Approve & Release Payment",
    pull: "Approve & Credit Payment",
  },
  approveButtonLoading: {
    push: "Releasing...",
    pull: "Approving...",
  },
  cancelSuccessLabel: {
    push: "Task cancelled — escrow refunded.",
    pull: "Task cancelled — your reward and insurance are credited back to you. Collect them to finish.",
  },
  cancelButtonOpen: {
    push: "Cancel Task (refund escrow)",
    pull: "Cancel Task (credit refund)",
  },
  cancelButtonClaimed: {
    push: "Cancel Claimed Task (refund escrow)",
    pull: "Cancel Claimed Task (credit refund)",
  },
  cancelDescriptionOpen: {
    push: "Burns your Task Receipt and returns the escrowed reward + insurance to your account.",
    pull: "Credits the escrowed reward + insurance back to you. Your Task Receipt stays in your wallet — it is the key you collect with, so do not burn it until the balance is withdrawn.",
  },
  cancelDescriptionClaimed: {
    push: "Voids the worker's claim before they submit: your escrowed reward + insurance return to you, and the worker's claim bond is returned to them in full in the same transaction.",
    pull: "Voids the worker's claim before they submit. The contract credits your reward + insurance back to you, and credits the worker's claim bond back to them in full — the worker did nothing wrong here. Neither side is paid by this transaction; each collects their own balance with a signed withdrawal.",
  },
  // Pull-only: the collect affordance does not exist under push, so `push` is
  // null and the surrounding block does not render in that era.
  collectWorkerNote: {
    push: null,
    pull: "The poster's approval assigned it to you — collecting is the step that puts it in your account.",
  },
  moneyMetaDescription: {
    push: "Exactly what leaves your wallet, where it is held, and the honest limit of the word escrow: settlement is manifest-routed, insurance is the poster's own stake, and there is no platform fee.",
    pull: "Exactly what leaves your wallet, where it is held, and the honest limit of the word escrow: approval credits each party inside the contract, insurance is the poster's own stake, and there is no platform fee.",
  },
  moneySettlementBadge: {
    push: "Settlement: manifest-routed, not contract-enforced",
    pull: "Settlement: contract-credited, self-collected",
  },
  moneyFeeBadge: {
    push: "Platform fee: 0% (dialable fee = Wave B, COMING)",
    pull: "Platform fee: 0% (component royalties deployed, set to 0)",
  },
  lifecycleSettlementNote: {
    push: "Settlement is manifest-routed: the app builds the payout and your wallet signs it.",
    pull: "Settlement is contract-credited: approval assigns each party their share inside the component, and each collects it with their own signed withdrawal.",
  },
  trustKeeperSettlementNote: {
    push: "What that does not mean: the contract does not itself pay the worker — approve_and_release hands the funds to whoever submits the transaction, and our app builds that manifest to route them to the worker. Read the manifest your wallet shows you before you sign. That is the real guarantee, and it is yours to check rather than ours to assert.",
    pull: "What that does mean: the contract itself decides who is owed what — approve_and_release credits the worker and the poster inside the component, payable only to the accounts pinned when the task was claimed, so the settlement transaction cannot redirect either share. Read the manifest your wallet shows you before you sign anyway. The limit that remains is that a credited share is not a collected one until you sign your own withdrawal.",
  },
  moneyTrustPostureLabel: {
    push: "settlement is manifest-routed",
    pull: "approval credits; the payee collects",
  },
  moneyTrustPostureBody: {
    push:
      "The release method hands the escrowed buckets back to whoever calls the settlement transaction; it does not force the split on-chain. The web app constructs that manifest to send the reward to the worker — so on the happy path, the worker is paid. But the guarantee is the honesty of the manifest, not the contract. This is a known, monitored limitation (BUG-7); the fix lands with the next blueprint (Wave B).",
    pull:
      "Approval settles the split inside the contract: it credits the worker's reward and returns the poster's insurance as entitlements the component holds, payable only to the accounts pinned when the task was claimed. A settlement transaction cannot redirect either one, so payout no longer rests on an honest manifest. The limit that replaces it is smaller but real — money stays in the component until each party signs their own withdrawal, so a credited reward is not a collected one, and an abandoned account leaves funds sitting.",
  },
  moneyStatusRoutingRow: {
    push:
      "Manifest-routed (not contract-enforced) — settlement returns funds to the caller's manifest; a known, monitored limitation (BUG-7).",
    pull:
      "Contract-settled, self-collected — approval credits each party inside the component, and each withdraws with their own signed transaction.",
  },
  moneyStatusFeeRow: {
    push: "COMING — the dialable platform fee is designed for Wave B, not deployed.",
    pull:
      "DEPLOYED AT ZERO — the platform fee is 0%. It is implemented as on-chain component royalties, attached at instantiation and currently set to 0 XRD on every method.",
  },
  disputesAutoResolveBody: {
    push:
      "After the 72h window, this settles the task with the component's configured default ruling — SplitEvenly (50/50) — and takes no arbiter fee. It is PUBLIC and carries no auth: anyone can call it, and like every settlement path it returns the funds to the caller's manifest (BUG-7), not by direct deposit.",
    pull:
      "After the 72h window, this settles the task with the component's configured default ruling — SplitEvenly (50/50) — and takes no arbiter fee. It is PUBLIC and carries no auth, so anyone can trigger it once the window passes; what they cannot do is take the money. Settlement credits the poster and the worker inside the component, payable only to the accounts pinned at claim and funding time, and each collects with their own signed transaction.",
  },
  // Renamed 2026-08-27 from disputesDormantMechanism at the P3-3/DB-5 flip:
  // the pull form still describes why the surface WAS dormant (that is the
  // flag-off truth, and CI still builds it), but the key now names what the
  // site is — the mechanism a dispute resolves by — because the on form in
  // DISPUTE_ON_OVERLAY describes the same mechanism live.
  disputesResolutionMechanism: {
    push:
      "auto_resolve_dispute is public and has no auth: once the 72h window passes, any account can call it. And like every settlement path in the current blueprint, it returns the funds to the caller's manifest rather than depositing directly to the poster and worker (this is the known limitation we track as BUG-7). Put together, a third party could call it after the window and route both the reward and the insurance to themselves.",
    pull:
      "auto_resolve_dispute is public and has no auth: once the 72h window passes, any account can call it. Under the deployed blueprint that is a nuisance rather than a theft — settlement credits the poster and the worker as entitlements payable only to their pinned accounts, so a stranger who calls it pays the network fee and moves no money to themselves. The surface stays dormant on the remaining ground: the default ruling is a fixed 50/50 SplitEvenly with no arbiter fee, which is a policy choice we have not asked anyone to rely on, and arbitration is an operator ceremony rather than a service you can call on — there is a written runbook, but no arbiter corps and no response time we are promising.",
  },
  // ── Round 4, 2026-08-21: the LANDING HERO ─────────────────────────────────
  // The first sentence a stranger reads, and it shipped inline in
  // src/app/page.tsx — so nothing here could see it and it served the push
  // claim ("you release the payment on-chain when you approve the work") on the
  // live pull component. Measured before the fix: the armed gate cleared it,
  // because every approval-pays branch pinned a THIRD-person form while the
  // homepage addresses the poster directly. The rule now carries a
  // second-person branch, which is why this key sits in the test's TEETH set.
  // ── Round 5, 2026-08-21: the two sites the 08-18 round left serving ───────
  // Both were named as open in PROJECT-STATE and both shipped INLINE, so no
  // test here could see them. /auditor-guide's is the sharper one: it is the
  // page written FOR auditors, and its auth-pattern paragraph asserted the
  // exact negation of what `deposit_both_lanes` does. The pull forms are
  // written from lib.rs, not from the push copy.
  auditorAuthPatternNote: {
    push:
      "Auth pattern worth auditing: every irreversible act consumes a one-shot receipt (bucket-burn — no replay); recurring acts use Proofs; safety releases are PUBLIC and time-gated. No method deposits into stored addresses — funds return to the caller's manifest for routing, which is what makes component-held roles (pools) possible later.",
    pull:
      "Auth pattern worth auditing, and settlement is the part to read twice — it is two-phase. approve_and_release, auto_resolve_dispute and the cancel paths move no money outward: they drain the escrow vaults into per-party entitlements held inside the component. Three methods do return a Bucket to their caller, and none of them can reach a task's reward: resolve_dispute returns the arbiter's fee (taken from the insurance, capped per task by max_arbiter_fee_pct, callable only with the arbiter badge), expire_claim returns a bounty of expire_bounty_pct of the forfeited claim bond to whoever calls it once the claim deadline and its grace window (expire_grace_secs) have passed, and the OWNER-only withdraw_forfeited_bonds returns the rest of forfeited bonds. Entitlements leave only through withdraw_worker / withdraw_poster and the public push_entitlement, and each deposits from inside the component into an account pinned earlier — the worker's at claim_task, the poster's at create_task — because deposit_both_lanes calls try_deposit_or_abort on that stored address. The caller never names that destination, so those three being callable by the payee or by anyone moves no value to whoever calls them. That pin is the property worth attacking: the worker badge and the task receipt are both transferable bearer instruments (neither resource calls withdraw_roles!, so both inherit the SDK default withdrawer=AllowAll), so stealing one lets you CALL the withdrawal — and the money still lands in the pinned account. Public-mint governs forging a credential, transferability governs stealing one, and the payee pin is what makes the second one not pay. On receipts, the two differ: the claim receipt is one-shot and burned at submit_task, but the task receipt is NOT burned at approval — under pull it is a persistent entitlement key presented as a Proof, retired explicitly via burn_task_receipt once both poster lanes read zero and the task is terminal. Recurring acts use Proofs; safety releases (expire_claim, auto_resolve_dispute, release_after_review_timeout) are PUBLIC and time-gated. push_entitlement takes no Proof and no destination: anyone may call it to deliver a settled entitlement to its pin, so a lost or unnoticed credential does not strand the money (it still aborts if the pinned account refuses the deposit), and a hostile caller only pays the network fee to pay a stranger their own funds. One consequence worth auditing: deposit_both_lanes coerces the payee to an Account on every path that pays out, push_entitlement included, so a component (a funding pool, say) cannot yet be a payee.",
  },
  agentsSettlementNote: {
    push:
      "Settlement is routed by the app's transaction manifest (see the auditor's guide for the honest limit of that), not enforced by the contract.",
    pull:
      "Settlement is enforced by the contract, not by the manifest your agent builds: approval credits an entitlement inside the component, and withdraw_worker deposits to the account pinned at claim. A third party calling a public method pays the network fee and moves nothing to themselves.",
  },
  // ── Round 6, 2026-08-21: three more inline sites, found by the UX audit ───
  // Every one of these is the same shape as every round before it: a sentence
  // about what approval does, written inline in a page, invisible to this
  // module's tests, and true only in the era it was written in.
  guideInsuranceTodayNote: {
    push:
      "Today: funding a task charges a flat 5% insurance amount alongside the reward, in the same transaction. It is not optional, and it pays no arbiter — the app sets the arbiter fee to zero on every task it creates. On approval it comes straight back to the poster.",
    pull:
      "Today: funding a task charges a flat 5% insurance amount alongside the reward, in the same transaction. It is not optional, and it pays no arbiter — the app sets the arbiter fee to zero on every task it creates. Approving credits it back to the poster inside the escrow, who then collects it with their own signed withdrawal.",
  },
  docsIsItFreeAnswer: {
    push:
      "Mostly. Badge minting is free (network transaction fee only). Off-chain voting in Telegram is free; casting an on-chain CV2 vote is not enabled yet. Posting a task costs nothing and needs no on-chain transaction (you sign in with your wallet) — funding it costs the reward plus 5% insurance (the insurance comes back when you approve), and claiming one locks a 10 XRD bond. See 'What are the fees?' below.",
    pull:
      `Mostly. Badge minting is free (network transaction fee only). Off-chain voting in Telegram is free; on-chain CV2 voting is switched off while CV2 is parked. Posting a task costs nothing and needs no on-chain transaction (you sign in with your wallet) — funding it costs the reward plus 5% insurance (approving credits the insurance back to you, and you collect it with one more signed transaction), and claiming one locks a bond of 10% of the reward, at least ${ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting). See 'What are the fees?' below.`,
  },
  // Shown to the WORKER on every submitted task. The push form is not merely
  // stale — it tells the person owed the money that the poster's signature is
  // what moves it, which under pull is the one thing it does not do.
  taskSubmittedWaitingNote: {
    push:
      "Waiting on the poster. The funds move only when the poster signs the release, so a poster who goes quiet leaves this task submitted indefinitely. Any review window in the terms is a promise, not an escrow rule.",
    pull:
      "Waiting on the poster. The escrow does not wait forever: once the review window lapses, anyone can trigger the same release without the poster acting, crediting the reward to you the same as an approval would — it does not land in your wallet until you collect it with your own signed transaction. Any review window you and the poster agreed to in the terms is a separate promise, not this escrow rule.",
  },
  landingHeroBody: {
    push:
      "Radix Guild is a task marketplace for the Radix community. Post a task and fund it in escrow, a badge-holding developer or AI agent delivers, and you release the payment on-chain when you approve the work. Connect your wallet to post work or start earning.",
    pull:
      "Radix Guild is a task marketplace for the Radix community. Post a task and fund it in escrow, a badge-holding developer or AI agent delivers, and your approval assigns the reward on-chain — the worker collects it with their own signed withdrawal. Connect your wallet to post work or start earning.",
  },
} as const satisfies Record<string, EraCopy>;

export type SettlementCopyKey = keyof typeof SETTLEMENT_COPY;

// ─────────────────────────────────────────────────────────────────────────────
// DISPUTE-ERA COPY (P3-3/DB-5, 2026-08-27). See the DisputeEra note above.
//
// Facts every `on` form rests on, re-verified against lib.rs and the task-3
// mainnet settlement (docs/PROJECT-STATE.md, 2026-08-26 "TASK 3 SETTLED"):
// raise_dispute needs a poster-receipt OR claimer-badge proof on a Submitted
// task; auto_resolve_dispute is public, no-auth, 72h-gated, applies SplitEvenly
// to the REWARD only and hardcodes RefundPoster for the insurance; the arbiter
// path (resolve_dispute) is the ONE path whose ruling governs both vaults; the
// arbiter fee is ≤10% of insurance on-chain and 0 on every task this app
// funds; settlement credits entitlements payable only to pinned accounts.
// THE ASYMMETRY IS STATED, NEVER SOFTENED: on a lapsed window the worker ends
// with half the reward and the poster with the remainder plus their whole
// premium — better than an honest approval leaves them. A symmetric-loss
// framing shipped twice and was false both times; dispute-outcome.ts exists
// to kill that class, and these strings must agree with it
// (dispute-payout-symmetry.test.ts scans this file, comments included).
// ─────────────────────────────────────────────────────────────────────────────

/** ON forms for SETTLEMENT_COPY keys whose PULL string is only true while the
 *  dispute UI is compiled off. The stored pull string stays the off form (CI
 *  builds with the flag unset and must keep gating exactly what it renders);
 *  settlementCopy() applies this overlay when the build compiled disputes ON. */
export const DISPUTE_ON_OVERLAY = {
  guideSettleBody:
    "Approve and the contract assigns the money inside the escrow — the reward to the worker, the insurance back to you — and each of you collects with a withdrawal you sign yourself. Approval is not the payment: nothing lands in anyone's wallet until they withdraw, and the contract pays only the accounts it pinned at claim and funding time, so no settlement transaction can redirect it. Partial disagreement can settle with a revision round, a cancel before anyone claims, or a dispute — raise one and, if no arbiter rules it first, the contract's own default fires after 72 hours: a fixed 50/50 split of the reward, with the insurance returning to the poster whole. See Disputes & Arbitration for the honest terms of that path before you rely on it.",
  guideClaimBody:
    `A badge-holding dev or agent stakes a claim bond sized to the task — 10% of the reward, at least ${ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting) — and claims. Workers see the funded on-chain balance and your committed terms before they commit. Submitting moves no money: the bond stays in the escrow until the task settles. When the work is approved — or the review window lapses and the release is triggered — it is credited back to you in full and you collect it with the same withdrawal as the reward; if a dispute is raised, the bond splits the way the reward does. The claim deadline is fixed the moment you claim — an hour after it passes, anyone can call the public expire method and forfeit the whole bond, so late submission is a race a worker can lose. There is no per-task dispute setting to see: raising a dispute is available on every submitted task, not select ones — see Disputes & Arbitration for what that path actually resolves to.`,
  lifecycleApproveDoes:
    "approve_and_release checks the poster’s task receipt as a proof and credits the settlement inside the component — the reward to the worker, the unused insurance to the poster. Nothing returns to the transaction that called it: each party collects with withdraw_worker or withdraw_poster, and the component deposits straight to the accounts it pinned at claim and funding time. This is the happy path: no dispute, no arbiter — see Disputes & Arbitration for what happens when either party raises one instead.",
  disputesResolutionMechanism:
    "Two ways out of a dispute. A human arbiter can rule it — a supply-of-one badge, run by the operator as a ceremony, with no deadline of its own — and their fee is fixed at zero: arbiter_fee_pct is 0 on every task this app funds, so insurance funds no arbiter. If nobody rules first, auto_resolve_dispute is public and has no auth: once the 72h window passes, any account can call it, and it applies the component's fixed default — a 50/50 split of the reward, with the poster's insurance returning to them whole. Calling it is a nuisance, not a theft: settlement credits the poster and the worker as entitlements payable only to their pinned accounts, so a stranger who calls it pays the network fee and moves no money to themselves. We promise no turnaround time for a ruling to land before the default fires — there is no public SLA, only the 72-hour chain-enforced backstop. And priced against an honest approval, the lapse costs only the worker: they end with half the reward instead of all of it, while the poster is credited the other half plus their whole premium — and the worker's claim bond is split the same way as the reward: half back to the worker, half to the poster. A worker weighing an unresponsive poster should know that before counting on a dispute to pressure them.",
} as const satisfies Partial<Record<SettlementCopyKey, string>>;

/** Sites with no push/pull dimension whose truth flips with the dispute flag.
 *  `off` forms are the strings main served before the flip, verbatim (CI and
 *  any deliberate rollback build keep rendering exactly what was gated);
 *  `on` forms are the P3-3/DB-5 copy. */
export const DISPUTE_COPY = {
  // ── /about — the Risk Disclosure paragraph ────────────────────────────────
  aboutDisputeDisclosure: {
    off: "Dispute resolution is switched off in this build — the dispute UI is compiled out, deliberately. Not because funds can be stolen (settlement pays only the accounts pinned when the task was created and claimed), but because the fallback ruling is a fixed 50/50 nobody has been asked to rely on, and arbitration is an operator ceremony rather than a service you can call on — there is a written runbook, but no arbiter corps and no response time we are promising. The on-chain method still exists and anyone can call it. An escrow watcher reads the chain every 30 minutes and pages us when a dispute is raised, and you can also tell us on Telegram if you raise one by hand. Tasks settle when the poster approves — or, if they go quiet, once the review window lapses: anyone can then trigger the escrow's public review-window release, which credits the same full reward with no approval needed. Tell us on Telegram if a task gets stuck and we will chase it.",
    on: "Dispute resolution is live. If a poster and worker disagree after submission, either can raise a dispute; a human arbiter can rule it for no fee — arbiter_fee_pct is 0 on every task this app funds, so insurance funds no arbiter — and if nobody does, the contract applies its own default after 72 hours: a plain 50/50 split of the reward, with the poster's insurance returning to them in full. We promise no turnaround time for a human ruling — there is no public SLA, only that 72-hour backstop — and our pre-deploy check now fails a release that compiles this surface off. Requesting a revision instead of disputing is a normal review step; it is a record we keep, not a chain event, so treat silence as a reason to check in rather than proof nothing was asked. Settlement pays only the accounts pinned when the task was created and claimed, so nobody else can end up holding the reward or the insurance. On review specifically: the escrow's own review-window release already answers a merely silent poster — anyone can trigger it once the window lapses, it credits the full reward, and it needs no dispute. Raising a dispute over that instead is the worse move: it moves the task out of the state the review-window release requires, and if no arbiter rules first the 72-hour default recovers half the reward, not all of it. Save a dispute for a real disagreement about the work. See Disputes & Arbitration for the full terms and the mainnet settlement we ran before turning this on.",
  },
  // ── /money — the dispute-posture paragraph ────────────────────────────────
  moneyDisputePosture: {
    off: "On disputes specifically: you cannot raise one here — the dispute UI is compiled off in this build. That governs our software, not the ledger: the dispute methods stay callable on-chain by anyone who builds the transaction by hand, and there is no per-task setting that makes a task undisputable.",
    on: "On disputes specifically: once a task is submitted, either party to it can raise one here. The pre-deploy gate now fails a release that compiles the dispute UI off. Our UI is still only a front door: the dispute methods are callable on-chain by anyone who builds the transaction by hand, and there is no per-task setting that makes a task undisputable.",
  },
  // ── /money — the worker-limit paragraph after the bolded lead about what
  //    is credited and when. The whole body is era-keyed because "raising a
  //    dispute is the worse move on a silent poster" stops being safe to say
  //    plainly once the dispute UI is off and there is no dispute button to
  //    warn against reaching for. ────────────────────────────────────────
  moneyWorkerEscapeNote: {
    off: "Approval is the fast way to settle, not the only one: the submission time is pinned on-chain as the start of a review window, and once it lapses anyone can trigger the escrow's own release, which credits that same full reward — no approval needed. A poster who simply stops responding leaves a submitted worker waiting out that window, not stranded, and with disputes off there is no second door to weigh against it.",
    on: "Approval is the fast way to get the full reward, not the only one: the submission time is pinned on-chain as the start of a review window, and once it lapses anyone — including you — can trigger the escrow's own release, which credits that same full reward, no approval needed. A poster who simply stops responding used to leave a submitted worker with no on-chain path to payment at all; that gap is what this closes. With disputes on there is a second door too, and it is deliberately the worse one: raising a dispute moves the task out of the state the review-window release requires, forfeiting it, and if no arbiter rules first the 72-hour default recovers only half the reward — while the poster ends up better off than if they had approved. Reach for a dispute over a disagreement about the work, not a poster's silence; the review-window release answers silence in full once the window passes.",
  },
  // ── /guide — the live-vs-off marker (label + body; bold label stays JSX) ──
  guideDisputeLabel: {
    off: " Deliberately switched off:",
    on: " Also live, as a backstop:",
  },
  guideDisputeBody: {
    off: " the dispute path. It exists in the deployed blueprint, but its UI is compiled out of this build — treat disputes as unavailable, not as a remedy you can reach.",
    on: " the dispute path — raise, arbiter ruling, and the 72h auto-resolve default. It does not judge the work: the default is a fixed 50/50 split of the reward and of the worker's claim bond, with the insurance returning to the poster whole, and no arbiter turnaround is promised. Under the 72-hour default, a dispute can only lose a worker money; for the poster, an unruled dispute recovers half the reward and half the worker's bond.",
  },
  // ── /guide — Task Pipeline grid, PAYOUT tail ─────────────────────────────
  // The grid is a SEPARATE array from the era-gated "The Flow" section below
  // it, and it drifted on the dispute axis (2026-09-07 audit): it still said
  // "No timer yet — funds stay locked until they act" while disputes were ON.
  // Keyed here so the two cannot diverge again.
  guidePipelinePayoutTail: {
    off: " There is a timer: if a poster goes quiet after you submit, anyone can trigger the escrow's review-window release once it lapses, crediting you the full reward with no approval needed.",
    on: " If a poster goes quiet after you submit, you do not need a dispute: once the review window lapses, anyone can trigger the escrow's release for the full reward — a dispute left to the 72h default returns only half. See /money.",
  },
  // ── /lifecycle ────────────────────────────────────────────────────────────
  lifecycleDisputePosture: {
    off: "Our dispute controls are switched off in this build. That governs our software, not the ledger — the dispute methods stay callable on-chain by anyone who builds the transaction by hand, and there is no per-task setting that makes a task undisputable.",
    on: "Our dispute controls are switched on, and the pre-deploy gate fails the release if a build ever compiles them off. That gate governs our software, not the ledger — the dispute methods stay callable on-chain by anyone who builds the transaction by hand regardless, and there is no per-task setting that makes a task undisputable.",
  },
  lifecycleDisputeLinkLabel: {
    off: "Why disputes are off",
    on: "How disputes resolve",
  },
  // ── /docs — the Disputes & arbitration card blurb ─────────────────────────
  docsDisputesCardBlurb: {
    off: "Code-complete on-chain but dormant by policy — and why that's the honest call.",
    on: "Live — the honest terms: a fixed 50/50 default, zero arbiter fee, no public SLA, and the mainnet proof.",
  },
  // ── /bug-bounty — the dispute-flow scope line. The PAGE moves it between
  //    OUT_OF_SCOPE (off) and IN_SCOPE (on); exactly one form is non-null per
  //    era so the other list never renders a stale entry. ───────────────────
  bugBountyDisputeOutOfScope: {
    off: "Disputes and the auto-resolve/finalize flow — switched OFF for beta (a known hardening track); reports there are already expected.",
    on: null,
  },
  bugBountyDisputeInScope: {
    off: null,
    on: "The dispute flow — raise, arbiter finalize, and the 72h auto-resolve: anything that misroutes or miscredits a disputed task's funds, or lets anyone other than the pinned poster and worker collect them.",
  },
  // ── /trust — the tail of the "safety releases are public" verify note.
  //    Found by the post-flip adversarial sweep: it shipped inside a plain JS
  //    object literal, invisible to a JSX-prose scan — and its old form ("No
  //    dispute has been settled on this component") had been false in BOTH
  //    eras since task 3's auto-resolve settled 2026-08-26. ─────────────────
  trustDisputeVerify: {
    off: "The dispute path is compiled off in this build's app UI — the on-chain methods stay callable regardless, and the one dispute settled so far (task 3's auto-resolve, 2026-08-26, an internal probe) is readable on the ledger.",
    on: "The dispute path is live in the app. Two disputes have settled, both between accounts the operator controls, and both are readable on the ledger: an auto-resolve on the previous escrow component (task 3, 2026-08-26, an internal probe run before the UI was turned on) and an arbiter ruling on the live one (task 5, 2026-09-14).",
  },
  // ── /disputes — the page whose premise flips ──────────────────────────────
  disputesMetaDescription: {
    off: "The dispute path is code-complete on Radix mainnet, but our dispute UI is compiled off in this build. The fallback ruling is a fixed 50/50 nobody has been asked to rely on, and arbitration is an operator ceremony with no promised response time. The reason it's off is itself the trust signal.",
    on: "The dispute path is live: either party on a submitted task can raise one, a human arbiter can rule it (for no fee on tasks funded through this app), and a public 72-hour default settles it otherwise — a fixed 50/50 split of the reward, with the insurance back to the poster. Proven end to end on mainnet, on the previous component, before we turned it on. Read the honest terms before you rely on them.",
  },
  disputesPageStatus: {
    off: "DORMANT",
    on: "LIVE",
  },
  // ── /disputes — who may arbitrate, stated at its ACTUAL scope ─────────────
  //
  // 🔴 THE COPY THE GUARD OWES. Wave B ships a self-dealing guard on
  // `resolve_dispute`, and L6 ruled it (c): narrowed to the BOUND side only.
  // So it blocks the worker-arbiter case and NOT the poster-arbiter case, and
  // saying "an arbiter cannot rule on their own dispute" would overclaim it in
  // exactly the way this file exists to prevent.
  //
  // The asymmetry is deliberate, not an oversight: the worker is PINNED on the
  // task at claim, so the blueprint can compare against it cheaply; a funder is
  // not a task field at all, so a poster-side check has nothing to compare
  // against without new state. Stating the limit is what makes the guard
  // trustworthy — a reader who assumes symmetric protection and finds otherwise
  // trusts nothing else on the page either.
  disputesArbiterConflictScope: {
    off: "",
    on: "One limit worth stating plainly: the arbiter may not be the task's worker — the blueprint enforces that, because the worker is pinned on the task when they claim it. It does NOT stop an arbiter who funded a task from ruling on it. That side is not enforced on-chain, because a funder is not recorded on the task, so there is nothing for the contract to compare against. Today the operator funds every task and is the only arbiter.",
  },
  // The date is when disputes went live, not when this copy was written: PR #465 merged
  // and deployed 2026-08-29 (docs/PROJECT-STATE.md). It read 2026-08-27 until 2026-10-02.
  disputesPageStatusDetail: {
    off: "(code-complete, policy-disabled)",
    on: "(since 2026-08-29, after the whole path was proven end to end on mainnet, on the previous component)",
  },
  disputesHonestyTagline: {
    off: "why this feature is switched off",
    on: "why this feature is switched on, and what it does not promise",
  },
  disputesHonestyLead: {
    off: "The dispute path exists on-chain and works — and we have switched our own dispute UI off anyway. Not because funds can be stolen: under the deployed blueprint settlement credits the poster and the worker as entitlements payable only to their pinned accounts, so a stranger who calls the public auto-resolve method moves no money to themselves. It is off because the fallback ruling is a fixed 50/50 we have not asked anyone to rely on, and arbiter supply is one — there is a written runbook, but arbitration is an operator ceremony, not a service you can call on, and we promise no response time. Telling you that reason plainly is the point. The reason it's off is itself the trust signal.",
    on: "We turned our own dispute controls on because leaving them off had become the worse option. At the time, the escrow had no auto-release, so if a poster went quiet after a worker submitted, disputing was that worker's only on-chain way out — an off UI just hid the affordance while the methods stayed callable by hand regardless. The live escrow has since added a review-window release that needs no dispute at all and credits the same full reward — the better exit on a merely silent poster now (see Money for its terms). And we did not flip disputes on the day it became technically safe: we flipped it only after proving the whole path end to end on mainnet — prediction written down first, then signed, then matched exactly.",
  },
  disputesHonestyLimit: {
    off: "Being equally plain about the limit of that: switching our UI off governs our software, not the ledger. The dispute methods stay callable on-chain by anyone who builds the transaction by hand. There is no per-task setting that makes a task undisputable — every funded task that reaches Submitted can be disputed by either party to it. What we actually run against that today is a compiled-off UI and a board where both sides of every task are still the guild itself, plus an escrow watcher that reads the chain every 30 minutes and pages a human when a dispute is raised.",
    on: "Being equally plain about what this does not promise: the fallback ruling is a fixed 50/50 split of the reward, not a judged outcome — settle disagreements off-chain first if you can. An arbiter can rule before the window closes, but that is an operator ceremony today, signed from the wallet holding a supply-1 badge, not a button either party clicks — and we promise no turnaround time. Only the 72-hour default caps the loss: half the reward, with the insurance returning to the poster. An arbiter's ruling does not: it applies one split the arbiter chooses to all three — the reward, the insurance and the bond. Watchers read the escrow every 30 minutes and page the operator on every claim, submission, dispute and settlement, with reminders before a review window closes.",
  },
  disputesEli5Status: {
    off: "All of that is deployed on Radix mainnet today, and we have now run it ourselves end-to-end: on-chain task 3 was deliberately moved into Disputed on 2026-08-23, and its 72h auto-resolve settled on 2026-08-26 exactly as predicted. No outside user has ever been in a dispute here — because the fallback method is callable by anyone, so at pilot scale we keep the surface small: our own dispute controls are off, every live task still has the guild on both sides of it, and we cap what any single task is worth.",
    on: "All of that is deployed on Radix mainnet, and we ran it ourselves end to end before turning our UI on: on the previous component, task 3 was deliberately moved into Disputed on 2026-08-23, and its 72h auto-resolve settled on 2026-08-26 — worker and poster both collected, that component ended back at 0, and conservation was exact to the last decimal. See the ledger evidence below. No outside user has been in a dispute here yet; the path was kept to our own accounts until that settlement proved it.",
  },
  disputesResolutionTitle: {
    off: "Why It's Dormant",
    on: "How It Resolves",
  },
  disputesResolutionPara2: {
    off: "The caller-routed drain this page used to warn about is closed on the deployed blueprint — settlement moved to pull at the 2026-08-17 cutover, so no method hands a bucket to its caller. What remains is a policy gap, not a theft one: a worker could submit poor work, dispute, and let the window lapse into the 50/50 default. That is why the surface stays dormant.",
    on: "The caller-routed drain this page used to warn about is closed on the deployed blueprint — settlement moved to pull at the 2026-08-17 cutover, so no settlement method pays the reward or the insurance to whoever calls it. What remains is the policy shape stated above: under the 72-hour default, the worst a poster can lose to a bad-faith dispute is half the reward, and the insurance comes home. The mirror of that is worth stating too: a poster who disputes and lets the 72 hours lapse ends up better off than one who approves, and only the worker carries the loss.",
  },
  disputesResolutionPara3: {
    off: "What stands between the method and a pot is three things, and we would rather name them than overstate them. One, this build: the dispute UI is compiled off, so our software offers no dispute affordance at all. Two, detection: watchers read the escrow every 30 minutes and page the operator on every claim, submission, dispute and settlement, with reminders before a review window closes. Three, scope: every live task still has the guild on both sides, and we cap what a single task is worth so that the worst case stays small.",
    on: "Three things stand behind that, and we would rather name them than overstate them. One, a build gate: the dispute UI can now only be off by a deliberate rebuild — the pre-deploy check fails a release that compiles it off. Two, detection: watchers read the escrow every 30 minutes and page the operator on every claim, submission, dispute and settlement, with reminders before a review window closes. Three, revision first: a poster can request changes before either side reaches for a dispute — that request is a record we keep, not a chain event, so treat a silent one as a reason to check in, not proof it never arrived.",
  },
  disputesResolutionPara4: {
    off: "That is a compiled-off surface plus detection plus a small blast radius. It is not a guarantee that nothing can enter the Disputed state — the on-chain methods do not care what our UI does — and the third item is a fact about today's board rather than something the code enforces.",
    on: "That is a blocking gate plus detection plus, under the 72-hour default, a fixed-loss ceiling. It is not a promise that no task will ever be disputed — the on-chain methods answer to the caller, not to our UI — and it is not a promise an arbiter rules before the 72-hour default fires: we have committed to no turnaround time, on purpose, and the fixed 50/50 default is what makes that honest rather than reckless.",
  },
} as const satisfies Record<string, DisputeEraCopy>;

export type DisputeCopyKey = keyof typeof DISPUTE_COPY;

/** The dispute era the running build compiled. Unlike settlementEra() this is
 *  a real flag read: OFF is still a producible build (CI, a deliberate
 *  rollback), so both columns stay reachable — which is exactly why every
 *  era-varying sentence needs both forms here. */
export function disputeEra(): DisputeEra {
  return isEnabled("disputes") ? "on" : "off";
}

/** The current dispute era's copy for a site; null = render nothing. */
export function disputeCopy(key: DisputeCopyKey): string | null {
  return DISPUTE_COPY[key][disputeEra()];
}

/**
 * The era the running build describes. CONSTANT since S3.
 *
 * This used to read `isEnabled("escrowPull")`. That flag is gone: the push-form
 * manifest builders were deleted, so there is no build this function could
 * honestly describe as "push" — the app can no longer produce a push manifest at
 * all. Returning the flag here after deleting the builders would have been the
 * worst of both, because the copy would claim an era the transaction path could
 * not perform. That is the precise failure this module exists to prevent.
 *
 * The `push` column of SETTLEMENT_COPY is now unreachable data. It is left in
 * place deliberately for ONE change only — collapsing 51 entries of multi-line
 * prose is a mechanical rewrite with real odds of mangling a string, and it does
 * not belong in the same commit as a money-path builder deletion. It is inert
 * meanwhile: nothing can select it. `settlement-copy.test.ts` pins the era to
 * "pull" so it cannot come back by accident.
 */
export function settlementEra(): SettlementEra {
  return "pull";
}

/** The current era's copy for a site; null = render nothing for this site.
 *  Resolves BOTH axes: push/pull first, then the dispute overlay — a pull-era
 *  build that compiled disputes ON serves the overlay form, everything else
 *  serves the stored string. */
export function settlementCopy(key: SettlementCopyKey): string | null {
  if (settlementEra() === "pull" && disputeEra() === "on") {
    const on = (DISPUTE_ON_OVERLAY as Partial<Record<SettlementCopyKey, string>>)[key];
    if (on !== undefined) return on;
  }
  return SETTLEMENT_COPY[key][settlementEra()];
}
