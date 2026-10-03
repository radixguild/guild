// nft_swap.qnt — the NftSwap listing lifecycle (P7-02, task 90).
//
// GROUNDED IN THE CODE, NOT THE DOCS.
// Every transition names the method and line it models, read from
// escrow/scrypto/guild-marketplace-escrow/src/nft_swap.rs (779 lines, read in
// full 2026-09-27) and checked against tests/nft_swap.rs. docs/design/nft-swap.md
// is `status: proposal` and was read for the WHY of the rulings only
// (S1a/S2/S3a/S4a/S6a). Where it and the source disagree, the source won — and
// it disagrees in three places this model follows the source on:
//  - expires_at is MANDATORY (the doc's §3/§4 tables still say
//    `Option<Instant>`; its RULED 2026-09-15 block and the source say required);
//  - FilledEvent has no `buyer` field (doc §4 has one; nft_swap.rs:119-124
//    explains why the component cannot honestly populate it);
//  - extend_listing works on an EXPIRED-but-still-Listed listing
//    (max(now, expires_at) + 30d, nft_swap.rs:533) — the doc's ruling block
//    records this as "one refinement".
//
// NOT A TASK ESCROW. No bond, insurance, dispute, arbiter or review window
// exists in this blueprint; a fill is atomic (payment in, asset out, one
// transaction). What is left to get wrong is: which state each method accepts,
// the expiry gate on fill, who can drive the receipt-gated methods, and
// whether the two vaults (asset, proceeds) agree with the state — which is
// exactly what the blueprint's own assert_conservation (nft_swap.rs:699-769)
// checks at runtime after every mutation.
//
// ASSUMPTIONS AND ABSTRACTIONS (read before believing anything below):
//  - ONE listing. Listings live in per-id KVS entries (listings, asset_vaults,
//    proceeds_vaults) and share nothing but next_listing_id, so single-listing
//    safety is the useful unit. Cross-listing interaction is NOT modelled.
//  - The ask list is FIXED (two alternatives, below), not chosen at `list`.
//    list's per-ask validation (non-empty, positive amounts, divisibility,
//    no duplicates — nft_swap.rs:327-349) is out of scope; see GAPS.
//  - Amounts are small ints, not Decimal. Time is an int `now` advanced by
//    `tick`; one tick stands for any positive amount of seconds, and
//    HORIZON stands for both MAX_LISTING_HORIZON_SECS and THIRTY_DAYS_SECS,
//    which the source defines as the SAME constant (nft_swap.rs:778-779).
//  - Crypto/proof checks are idealised: holding the listing receipt == being
//    the Seller. See mayCancel below and GAPS.
module nft_swap {

  // ── Actors ────────────────────────────────────────────────────────────────
  // `Anyone` is a first-class adversary the step relation may always pick. A
  // transition that does not name its caller is reachable by Anyone BY
  // OMISSION — here that is `fill`, deliberately (S6a).
  type Actor = Seller | Buyer | Anyone | Nobody

  // nft_swap.rs:47-52, plus `Unlisted` for "no KVS entry yet" — the state
  // `list` leaves. The source has no such variant; it has no listing at all.
  type LState = Unlisted | Listed | Filled | Cancelled

  // Payment resources. RTok / RNft are the two resources the fixed asks name;
  // RWrong is any other resource a buyer might present.
  type Res = RTok | RNft | RWrong | RNone

  // ── The fixed ask list (S1a: an AnyOf of ≥1 alternatives) ─────────────────
  //   alternative 0: Ask::Fungible    { resource: RTok, amount: PRICE }
  //   alternative 1: Ask::NonFungible { resource: RNft, id: NFT_ID }
  // One of each kind, so fill's two match arms (nft_swap.rs:448-457) are both
  // reachable. Index 2 exists in the step relation to exercise the range guard.
  pure val NUM_ASKS: int = 2
  pure val PRICE: int = 5
  pure val NFT_ID: int = 1
  pure def askIsNft(i: int): bool = i == 1
  pure def askRes(i: int): Res = if (i == 0) RTok else if (i == 1) RNft else RNone
  // For a NonFungible ask the "amount" is the source's hard-coded 1
  // (nft_swap.rs:454 "payment must be exactly the one NFT").
  pure def askAmt(i: int): int = if (i == 0) PRICE else if (i == 1) 1 else 0
  pure def askId(i: int): int = if (i == 1) NFT_ID else 0

  // MAX_LISTING_HORIZON_SECS == THIRTY_DAYS_SECS (nft_swap.rs:778-779).
  pure val HORIZON: int = 3

  // ── Listing fields (nft_swap.rs:55-76) ────────────────────────────────────
  var state: LState
  var expiresAt: int
  var filledWith: int          // -1 == None; `Some` iff Filled (nft_swap.rs:72-74)
  var proceedsWithdrawn: bool
  var receiptBurned: bool      // burn_listing_receipt ran (the credential is gone)

  // ── Vaults and value that has left the component ──────────────────────────
  var assetVault: int          // asset_vaults[id] amount: 1 while held, else 0
  var assetReleases: int       // times the asset bucket was handed OUT (fill/cancel)
  var assetOutTo: Actor        // who received it (the filler, or the receipt holder)
  var proceedsVault: int       // proceeds_vaults[id] amount (created lazily AT fill)
  var proceedsRes: Res         // …its resource (RNone until fill)
  var proceedsId: int          // …the NFT id, for a NonFungible fill (0 otherwise)
  var sellerPaid: int          // deposited to the PINNED `seller` account

  // ── Clock ─────────────────────────────────────────────────────────────────
  var now: int

  // ── Ghosts. Not state the blueprint has — state the PROPERTIES need. ───────
  // An authority guard is only checkable if something records who passed it,
  // and ONE ghost cannot record three call sites. The split, and why:
  //  - cancelledBy: cancel is the only method that makes Cancelled, so this is
  //    the "settledBy" of that terminal state;
  //  - extendedBy / withdrawnBy: extend_listing and withdraw_proceeds DON'T
  //    change `state` at all (extend stays Listed, withdraw stays Filled), so
  //    no terminal-state ghost can ever observe them. Each gets its own.
  //  - burnedBy: burn_listing_receipt changes no `state` either (it only
  //    sets receiptBurned), so it too needs its own ghost for mayBurn.
  //  - fill has NO authority ghost, because it has no authority (S6a, below).
  var cancelledBy: Actor
  var extendedBy: Actor
  var withdrawnBy: Actor
  var burnedBy: Actor
  var assetIn: int             // assets ever escrowed (1 after list)
  var paidIn: int              // payment units ever moved into proceeds
  var fillCount: int           // fills that committed
  var withdrawCount: int       // withdraw_proceeds calls that committed
  var nowAtFill: int           // `now` when fill committed
  var expiryAtFill: int        // `expires_at` fill compared against
  var listedAt: int            // `now` at list
  var listedExpiry: int        // `expires_at` as accepted by list

  // ── Authority, stated rather than implied ─────────────────────────────────
  // Every gated method takes `receipt: Proof` of the listing-receipt NFT and
  // checks only its resource address + local id (listing_id_from_receipt,
  // nft_swap.rs:667-678). It never compares the caller to Listing.seller.
  // The receipt is a TRANSFERABLE BEARER instrument (minted to the caller of
  // `list`, nft_swap.rs:399-408, no withdraw/deposit restrictions), so
  // collapsing "presents the receipt" to the Seller actor is the same
  // idealisation escrow_task.qnt makes for mayApprove/mayCancel/maySubmit —
  // and it HIDES the same thing: a receipt that was sold, lent or stolen.
  // That scenario is out of scope and named in GAPS, not assumed away.
  pure def mayCancel(a: Actor): bool   = a == Seller   // Proof of listing_receipt
  pure def mayExtend(a: Actor): bool   = a == Seller   // Proof of listing_receipt
  pure def mayWithdraw(a: Actor): bool = a == Seller   // Proof of listing_receipt
  pure def mayBurn(a: Actor): bool     = a == Seller   // Bucket of listing_receipt
  // NO mayFill. `fill(listing_id, alternative, payment)` takes no Proof and
  // no identity of any kind (nft_swap.rs:433), so there is no guard to model,
  // to delete, or to expose — S6a ("self-fill allowed") is the ABSENCE of a
  // guard, not a guard set to permissive. That is also why this file has no
  // twin analogous to escrow_arbiter_is_poster: that twin exists because the
  // escrow checks the arbiter badge on the worker side and deliberately NOT on
  // the poster side, so there is a real open side to keep visible. Here there
  // was never a credential to check on either side. The step relation lets
  // Seller, Buyer and Anyone all fill, which IS the ruling.

  pure def isTerminal(s: LState): bool = s == Filled or s == Cancelled

  action init = all {
    state' = Unlisted,
    expiresAt' = 0, filledWith' = -1, proceedsWithdrawn' = false, receiptBurned' = false,
    assetVault' = 0, assetReleases' = 0, assetOutTo' = Nobody,
    proceedsVault' = 0, proceedsRes' = RNone, proceedsId' = 0, sellerPaid' = 0,
    now' = 0,
    cancelledBy' = Nobody, extendedBy' = Nobody, withdrawnBy' = Nobody, burnedBy' = Nobody,
    assetIn' = 0, paidIn' = 0, fillCount' = 0, withdrawCount' = 0,
    nowAtFill' = -1, expiryAtFill' = -1, listedAt' = -1, listedExpiry' = -1,
  }

  // ── Frames. Quint has no "unchanged except"; spell them out. ──────────────
  action assetUnchanged = all {
    assetVault' = assetVault, assetReleases' = assetReleases, assetOutTo' = assetOutTo,
    assetIn' = assetIn,
  }
  action proceedsUnchanged = all {
    proceedsVault' = proceedsVault, proceedsRes' = proceedsRes, proceedsId' = proceedsId,
    sellerPaid' = sellerPaid, paidIn' = paidIn,
  }
  action authGhostsUnchanged = all {
    cancelledBy' = cancelledBy, extendedBy' = extendedBy, withdrawnBy' = withdrawnBy,
    burnedBy' = burnedBy,
  }
  action fillGhostsUnchanged = all {
    fillCount' = fillCount, nowAtFill' = nowAtFill, expiryAtFill' = expiryAtFill,
  }
  action listGhostsUnchanged = all {
    listedAt' = listedAt, listedExpiry' = listedExpiry,
  }

  // ── Transitions ───────────────────────────────────────────────────────────

  // list — nft_swap.rs:320-422. PUBLIC; the caller's own asset is consumed in
  // the same call, and the receipt is minted back to that caller — the Seller.
  // `e` is the caller-chosen expires_at; the step relation offers values in
  // the past, now, inside the horizon and beyond it, so both S2 guards bite.
  action list(e: int): bool = all {
    state == Unlisted,
    e > now,                  // G-LIST-FUTURE   nft_swap.rs:363-366 "expires_at must be in the future"
    e <= now + HORIZON,       // G-LIST-HORIZON  nft_swap.rs:367-374 "at most 30 days out"
    state' = Listed,
    expiresAt' = e,
    assetVault' = 1, assetIn' = assetIn + 1,
    assetReleases' = assetReleases, assetOutTo' = assetOutTo,
    listedAt' = now, listedExpiry' = e,
    filledWith' = filledWith, proceedsWithdrawn' = proceedsWithdrawn, receiptBurned' = receiptBurned,
    proceedsUnchanged, authGhostsUnchanged, fillGhostsUnchanged,
    withdrawCount' = withdrawCount,
    now' = now,
  }

  // fill — nft_swap.rs:433-487. PUBLIC, NO auth (S6a): `caller` is only where
  // the returned asset bucket lands (the manifest deposits it), never checked.
  // proceeds_vaults.insert(...) is modelled as the OVERWRITE it is
  // (nft_swap.rs:467): its comment says it "cannot collide" BECAUSE Listed ->
  // Filled is one-way — i.e. only fill's own Listed guard makes that true, and
  // DOUBLE-FILL is the mutation that proves the guard is load-bearing.
  action fill(caller: Actor, alt: int, payRes: Res, payAmt: int, payId: int): bool = all {
    state == Listed,          // G-FILL-LISTED   nft_swap.rs:436 "listing is not Listed"
    now < expiresAt,          // G-FILL-EXPIRY   nft_swap.rs:437-441 "listing has expired"
    alt < NUM_ASKS,           // nft_swap.rs:443 "alternative index out of range"
    payRes == askRes(alt),    // G-FILL-RES      nft_swap.rs:449,453 "payment resource does not match"
    payAmt == askAmt(alt),    // G-FILL-AMT      nft_swap.rs:450,454 amount / "exactly the one NFT"
    askIsNft(alt) implies payId == askId(alt), // G-FILL-ID nft_swap.rs:455-456 "NFT id does not match"
    state' = Filled,
    filledWith' = alt,
    proceedsVault' = payAmt,
    proceedsRes' = payRes,
    proceedsId' = if (askIsNft(alt)) payId else 0,
    paidIn' = paidIn + payAmt,
    assetVault' = assetVault - 1,          // asset_vaults[id].take_all()
    assetReleases' = assetReleases + 1,
    assetOutTo' = caller,
    fillCount' = fillCount + 1,
    nowAtFill' = now, expiryAtFill' = expiresAt,
    expiresAt' = expiresAt, proceedsWithdrawn' = proceedsWithdrawn, receiptBurned' = receiptBurned,
    sellerPaid' = sellerPaid, assetIn' = assetIn,
    authGhostsUnchanged, listGhostsUnchanged,
    withdrawCount' = withdrawCount,
    now' = now,
  }

  // cancel — nft_swap.rs:494-514. Listed only, at ANY time: there is
  // deliberately no expiry guard (test_cancel_after_expiry_still_succeeds —
  // an expired listing is unfillable but its asset is never stranded).
  // The asset goes to WHOEVER PRESENTS THE RECEIPT (the returned bucket), not
  // to the pinned Listing.seller — unlike withdraw_proceeds. Under the
  // credential idealisation that is the Seller; see GAPS.
  action cancel(caller: Actor): bool = all {
    state == Listed,          // G-CANCEL-LISTED nft_swap.rs:499
    mayCancel(caller),
    not(receiptBurned), // redundant given monotonic state (a burn needs a non-Listed state), kept to document intent
    state' = Cancelled,
    assetVault' = assetVault - 1,
    assetReleases' = assetReleases + 1,
    assetOutTo' = caller,
    cancelledBy' = caller,
    extendedBy' = extendedBy, withdrawnBy' = withdrawnBy, burnedBy' = burnedBy,
    assetIn' = assetIn,
    expiresAt' = expiresAt, filledWith' = filledWith,
    proceedsWithdrawn' = proceedsWithdrawn, receiptBurned' = receiptBurned,
    proceedsUnchanged, fillGhostsUnchanged, listGhostsUnchanged,
    withdrawCount' = withdrawCount,
    now' = now,
  }

  // extend_listing — nft_swap.rs:526-541. Listed only (expired or not);
  // new expiry = max(now, expires_at) + 30 days. Moves no value. Extensions
  // STACK without bound: the S2 ceiling bounds `list` only, and the ledger
  // test says so (test_extend_listing_pushes_expiry_by_30_days, second call).
  action extendListing(caller: Actor): bool = all {
    state == Listed,          // G-EXTEND-LISTED nft_swap.rs:530
    mayExtend(caller),
    not(receiptBurned), // redundant given monotonic state (a burn needs a non-Listed state), kept to document intent
    expiresAt' = (if (now > expiresAt) now else expiresAt) + HORIZON,
    extendedBy' = caller,
    cancelledBy' = cancelledBy, withdrawnBy' = withdrawnBy, burnedBy' = burnedBy,
    state' = state, filledWith' = filledWith,
    proceedsWithdrawn' = proceedsWithdrawn, receiptBurned' = receiptBurned,
    assetUnchanged, proceedsUnchanged, fillGhostsUnchanged, listGhostsUnchanged,
    withdrawCount' = withdrawCount,
    now' = now,
  }

  // withdraw_proceeds — nft_swap.rs:550-581. Filled and not yet withdrawn.
  // ONE transition, not a credit-then-pull pair like escrow_task's
  // workerEntitled/withdrawWorker: the proceeds vault already IS the
  // entitlement, and this PUSHES take_all() straight into the pinned seller
  // account (try_deposit_or_abort — a refused deposit reverts the whole call,
  // test_withdraw_proceeds_deposit_refusal_then_retry_after_rule_lifted; a
  // reverted call is simply a step that did not happen here).
  action withdrawProceeds(caller: Actor): bool = all {
    state == Filled,          // G-WITHDRAW-FILLED nft_swap.rs:555
    not(proceedsWithdrawn),   // G-WITHDRAW-ONCE   nft_swap.rs:556 "proceeds already withdrawn"
    mayWithdraw(caller),
    not(receiptBurned), // redundant given monotonic state (a burn needs proceeds withdrawn), kept to document intent
    sellerPaid' = sellerPaid + proceedsVault,   // PAYOUT: take_all() of the vault
    proceedsVault' = 0,
    proceedsWithdrawn' = true,
    withdrawCount' = withdrawCount + 1,
    withdrawnBy' = caller,
    cancelledBy' = cancelledBy, extendedBy' = extendedBy, burnedBy' = burnedBy,
    proceedsRes' = proceedsRes, proceedsId' = proceedsId, paidIn' = paidIn,
    state' = state, expiresAt' = expiresAt, filledWith' = filledWith,
    receiptBurned' = receiptBurned,
    assetUnchanged, fillGhostsUnchanged, listGhostsUnchanged,
    now' = now,
  }

  // burn_listing_receipt — nft_swap.rs:589-620. MODELLED (escrow_task.qnt
  // puts its analogue burn_task_receipt out of scope; see GAPS for why this
  // one is in). The receipt is the ONLY credential for cancel / extend /
  // withdraw, so a burn that the state guard lets through too early strands
  // the asset (Listed) or the proceeds (Filled, unwithdrawn) permanently.
  action burnReceipt(caller: Actor): bool = all {
    state != Unlisted,        // no receipt exists before list
    mayBurn(caller),
    not(receiptBurned),
    state != Listed,          // G-BURN-LISTED nft_swap.rs:605-608 "still Listed — cancel first"
    state == Filled implies proceedsWithdrawn, // G-BURN-OWED nft_swap.rs:609-612 "proceeds are still owed"
    receiptBurned' = true,
    burnedBy' = caller,
    cancelledBy' = cancelledBy, extendedBy' = extendedBy, withdrawnBy' = withdrawnBy,
    state' = state, expiresAt' = expiresAt, filledWith' = filledWith,
    proceedsWithdrawn' = proceedsWithdrawn,
    assetUnchanged, proceedsUnchanged,
    fillGhostsUnchanged, listGhostsUnchanged,
    withdrawCount' = withdrawCount,
    now' = now,
  }

  action tick: bool = all {
    now' = now + 1,
    state' = state, expiresAt' = expiresAt, filledWith' = filledWith,
    proceedsWithdrawn' = proceedsWithdrawn, receiptBurned' = receiptBurned,
    assetUnchanged, proceedsUnchanged, authGhostsUnchanged,
    fillGhostsUnchanged, listGhostsUnchanged,
    withdrawCount' = withdrawCount,
  }

  pure val CALLERS: Set[Actor] = Set(Seller, Buyer, Anyone)

  // The adversary picks the caller every time, Anyone included, and every
  // payment: right and wrong resource, right and wrong amount, right and
  // wrong NFT id, in-range and out-of-range alternative.
  action step = any {
    nondet d = oneOf((-1).to(HORIZON + 1)) list(now + d),
    nondet a = oneOf(CALLERS)
      nondet i = oneOf(0.to(NUM_ASKS))
      nondet r = oneOf(Set(RTok, RNft, RWrong))
      nondet m = oneOf(Set(0, 1, PRICE))
      nondet d = oneOf(Set(1, 2))
      fill(a, i, r, m, d),
    nondet a = oneOf(CALLERS) cancel(a),
    nondet a = oneOf(CALLERS) extendListing(a),
    nondet a = oneOf(CALLERS) withdrawProceeds(a),
    nondet a = oneOf(CALLERS) burnReceipt(a),
    tick,
  }

  // ══ SAFETY PROPERTIES ═════════════════════════════════════════════════════
  //
  // 1-3 are assert_conservation's three documented clauses
  // (nft_swap.rs:693-698), one invariant each so each is independently
  // mutation-testable — the same reason escrow_task.qnt split
  // invNoBondLeftBehindAtSettlement out of invConservation.

  // 1. ASSET HELD IFF LISTED (clause 1, nft_swap.rs:694, :713-718/:725-730/:761-766).
  val invAssetHeldIffListed: bool =
    ((state == Listed) iff (assetVault == 1))
      and ((state != Listed) implies (assetVault == 0))

  // 2. PROCEEDS HELD IFF FILLED-AND-UNWITHDRAWN (clause 2, nft_swap.rs:695-696,
  //    :719-723/:731-741). Non-empty, not merely "present": a zero-amount
  //    fill would satisfy a presence check and still leave the seller unpaid.
  val invProceedsHeldIffOwed: bool =
    (proceedsVault > 0) iff (state == Filled and not(proceedsWithdrawn))

  // 3. PROCEEDS MATCH THE FILLED ALTERNATIVE'S RESOURCE (clause 3,
  //    nft_swap.rs:697-698, :742-758). Like the source, only while unwithdrawn;
  //    the filledWith-is-Some half is the `.expect()` at :742-745.
  val invProceedsMatchAlternative: bool =
    (state == Filled and not(proceedsWithdrawn)) implies
      (filledWith >= 0 and filledWith < NUM_ASKS and proceedsRes == askRes(filledWith))

  // 3b. …AND ITS AMOUNT / ID. STRONGER than the source's runtime assert, which
  //     checks the resource only: this is what the seller was promised. It
  //     makes fill's amount and id guards checkable, which clause 3 cannot.
  val invProceedsEqualAsk: bool =
    (state == Filled and not(proceedsWithdrawn)) implies
      (proceedsVault == askAmt(filledWith) and proceedsId == askId(filledWith))

  // 4. VALUE CONSERVATION — the asset and the payment, each accounted for.
  //    Nothing appears, nothing vanishes; the asset leaves at most once.
  val invAssetConserved: bool =
    assetVault >= 0 and assetVault + assetReleases == assetIn and assetReleases <= 1
  val invProceedsConserved: bool =
    proceedsVault >= 0 and proceedsVault + sellerPaid == paidIn

  // 5. filled_with IS Some IFF Filled (nft_swap.rs:72-74).
  val invFilledWithIffFilled: bool =
    (filledWith >= 0) iff (state == Filled)

  // 6. AUTHORITY — one per receipt-gated method, same shape as
  //    escrow_task.qnt's invSubmitOnlyByWorker.
  //    cancel: the one with a MONEY consequence — the asset is returned to the
  //    caller, so an Anyone-reachable cancel is asset theft (6d pins that).
  val invCancelOnlyBySeller: bool =
    (cancelledBy != Nobody) implies (cancelledBy == Seller)
  //    extend: griefing-shaped, not theft — it moves no value. What an
  //    Anyone-reachable extend buys is keeping someone else's listing fillable
  //    longer than they chose (and paying its royalty).
  val invExtendOnlyBySeller: bool =
    (extendedBy != Nobody) implies (extendedBy == Seller)
  //    withdraw: griefing-shaped, not theft — the payout goes to the PINNED
  //    seller whoever calls (nft_swap.rs:568-569). What it pins is the
  //    model's receipt abstraction on this call site.
  val invWithdrawOnlyBySeller: bool =
    (withdrawnBy != Nobody) implies (withdrawnBy == Seller)
  //    burn: moves no value and changes no state, so only a ghost can see
  //    who passed mayBurn. A stranger burning is strand-shaped only if the
  //    state guards also fail (invNothingStrandedBehindBurnedReceipt); what
  //    this pins is the model's receipt abstraction on this call site.
  val invBurnOnlyBySeller: bool =
    (burnedBy != Nobody) implies (burnedBy == Seller)
  //    6d. A CANCELLED listing's asset went back to the seller.
  val invCancelReturnsAssetToSeller: bool =
    (state == Cancelled) implies (assetOutTo == Seller)

  // 7. NO FILL AT OR AFTER EXPIRY — a temporal safety property: the fill that
  //    committed saw now < expires_at (nft_swap.rs:438-441, strict).
  val invNoFillAfterExpiry: bool =
    (fillCount > 0) implies (nowAtFill < expiryAtFill)

  // 8. NO DOUBLE FILL. ⚠️ VACUOUS BY CONSTRUCTION in the healthy model: fill
  //    requires Listed and leaves Filled, and nothing returns to Listed, so
  //    fillCount cannot reach 2 — this invariant alone checks NOTHING. It is
  //    armed ONLY by the DOUBLE-FILL mutation, which deletes that exact guard
  //    and must then produce a second fill (formal/README.md point 3; the
  //    BUG-7-REGRESSION / ARBITER-AUTH history is this trap twice). Kept
  //    because the mutation needs a named target, not because a green run of
  //    it means anything.
  val invNoDoubleFill: bool = fillCount <= 1

  // 9. WITHDRAW AT MOST ONCE. The idempotent refusal (nft_swap.rs:556),
  //    counted directly. Needed as its OWN invariant because conservation
  //    CANNOT see a guard-less second withdraw against this code: take_all()
  //    drained the vault on the first call, so the second deposits zero and
  //    the sums still balance. See WITHDRAW-IDEMPOTENCY-GUARD-DELETED and
  //    DOUBLE-PAYOUT in the manifest for the two halves of that claim.
  val invWithdrawAtMostOnce: bool = withdrawCount <= 1

  // 10. S2: THE EXPIRY LIST ACCEPTED WAS IN THE FUTURE AND WITHIN THE HORIZON.
  //     Bounds `list` only — extend_listing legitimately stacks past it.
  val invListExpiryWithinHorizon: bool =
    (state != Unlisted) implies
      (listedAt < listedExpiry and listedExpiry <= listedAt + HORIZON)

  // 11. NOTHING IS STRANDED BEHIND A BURNED RECEIPT (burn_listing_receipt's
  //     doc, nft_swap.rs:583-588): once the only credential is gone, neither
  //     vault may still hold anything.
  val invNothingStrandedBehindBurnedReceipt: bool =
    receiptBurned implies (assetVault == 0 and proceedsVault == 0)

  val allSafety: bool =
    invAssetHeldIffListed and invProceedsHeldIffOwed and invProceedsMatchAlternative
      and invProceedsEqualAsk and invAssetConserved and invProceedsConserved
      and invFilledWithIffFilled
      and invCancelOnlyBySeller and invExtendOnlyBySeller and invWithdrawOnlyBySeller
      and invBurnOnlyBySeller
      and invCancelReturnsAssetToSeller
      and invNoFillAfterExpiry and invNoDoubleFill and invWithdrawAtMostOnce
      and invListExpiryWithinHorizon and invNothingStrandedBehindBurnedReceipt

  // ══ GAPS — stated so a green run cannot be mistaken for coverage ══════════
  //  - ONE listing. Nothing shared between listings is modelled
  //    (next_listing_id's overflow check included).
  //  - The ask list is fixed at two alternatives (one Fungible, one
  //    NonFungible). list's per-ask validation — non-empty, positive amount,
  //    divisibility, no duplicates, `seller` is a global account, exactly one
  //    NFT escrowed (nft_swap.rs:327-360) — is NOT modelled; it is gated by
  //    the ledger tests test_list_rejects_empty_asks / _duplicate_asks /
  //    _zero_amount_ask. invProceedsHeldIffOwed assumes asks are positive,
  //    which is what those asserts license.
  //  - Decimal arithmetic and divisibility rounding are abstracted to ints.
  //    Time is abstract: one tick is "some seconds", HORIZON is 30 days.
  //  - BEARER CREDENTIAL. mayCancel / mayExtend / mayWithdraw / mayBurn
  //    collapse "presents a listing receipt" to the Seller actor. The receipt
  //    is freely transferable, and there is no Actor here for "holds the
  //    receipt but is not the seller". What such a holder can really do: cancel
  //    and RECEIVE THE ASSET (cancel returns it to the caller, not to the
  //    pinned Listing.seller — the one money-shaped consequence); extend
  //    (griefing); withdraw (harmless — pays the pinned seller anyway); burn
  //    (only once nothing is withdrawable, by the guards modelled here). The
  //    authority invariants — one per gated method, burn included
  //    (invBurnOnlyBySeller via the burnedBy ghost, armed by BURN-AUTH) — pin
  //    the MODEL's abstraction, not the receipt's custody, exactly as
  //    escrow_task.qnt's invSubmitOnlyByWorker does.
  //  - burn_listing_receipt IS MODELLED (escrow_task.qnt excludes its
  //    burn_task_receipt). Why here: it is cheap (one boolean, one action,
  //    two guards), and its guards are the ONLY thing between a seller and a
  //    permanent strand of the asset or the proceeds, since the receipt is the
  //    sole credential for every recovery path. The receipt-resource /
  //    amount-1 checks (nft_swap.rs:590-595) and the `if let Some(listing)`
  //    branch for an unknown id are out of scope (one listing, idealised
  //    credential).
  //  - fill's asset DESTINATION and the proceeds DESTINATION are recorded,
  //    not authenticated: fill hands its bucket to the manifest, withdraw
  //    deposits to Listing.seller. Account deposit rules are modelled only as
  //    "a reverted step did not happen".
  //  - Royalties (fill / extend_listing dials, S3a/S4a), the owner and
  //    royalty-admin badges, instantiate, and the views get_listing /
  //    get_config / get_proceeds are out of scope.
  //  - Events are not modelled — including that a guard-less second withdraw
  //    would emit a second ProceedsWithdrawnEvent (amount 0), which is the
  //    off-chain-visible face of the bug invWithdrawAtMostOnce counts.
  //  - Liveness ("an expired listing can always be recovered", "owed proceeds
  //    are always eventually collectable") is not checked; it needs fairness.
  //    The safety half — no guard ever blocks cancel for expiry — is only
  //    visible as reachability, not proved.
  //  - `extend_listing` has no ceiling: repeated calls stack expires_at
  //    arbitrarily far ahead. The model reproduces that faithfully and no
  //    invariant bounds it (the S2 ruling prices it via the royalty dial).
}
