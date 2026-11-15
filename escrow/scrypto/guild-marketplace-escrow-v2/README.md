# guild-marketplace-escrow-v2

Source for the next version of the Guild task escrow and NFT swap blueprints.
It fixes the findings from the 13 October 2026 review (F-001 to F-005, N-1,
L-2, I-1) in a NEW package directory. The live package's source,
`../guild-marketplace-escrow/`, is unchanged.

**Status: source only. Not published, not instantiated, not deployed.** The
components running on mainnet today were built from the v1 source and still
carry these findings. Whether and when v2 replaces them is a separate decision
(a migration), not part of this package.

The first commit of this directory is a verbatim copy of the v1 source (only
the crate name differs), so `git diff` against that commit shows every v2
change.

## What changed, finding by finding

| Finding | v1 behaviour | v2 change | Test |
|---|---|---|---|
| F-001 | `resolve_dispute` checked only `state == Disputed`. One transaction signed by the arbiter could claim (naming a second account as worker), submit, raise and rule. | A minimum wait between `raise_dispute` and `resolve_dispute` (`dispute_min_resolve_wait_secs`, a new last `instantiate` argument, 1 hour to 7 days, shorter than the auto-resolve window). `DisputeRaisedEvent.resolvable_from` shows the earliest ruling time. Claim-badge checks: an account holding an arbiter badge cannot be named as a worker, and the arbiter's assigned account may not hold the badge the task was claimed with. | `test_u2a_*` (4 tests) |
| F-002 | `set_dispute_auto_resolve_secs` checked only `> 0`; the value was cast `as i64`, so ≥ 2^63 turned negative. | Bounded to 1–90 days in `instantiate` and the setter (one shared validator), and kept longer than the arbiter's wait. All four `u64 → i64` conversions use `i64::try_from`. | `test_u2b_*`, `test_v2_no_unchecked_cast_to_i64_in_source` |
| F-003 | `set_expire_grace_secs` had no check, and `expire_claim` read the grace live, so one call could make every claim in flight expirable. | Bounded to 0–24 h in both places. The grace is pinned onto the task at `claim_task` (`TaskInfo.claim_expire_grace_secs`, also in `TaskClaimedEvent`); `expire_claim` reads the pin. | `test_f003_*`, `test_u2b_*` |
| N-1 | Both submit-deadline setters checked only `> 0`, with the same cast. | Bounded to 1 hour – 90 days in both places. | `test_u2b_*` |
| L-2 | `set_max_arbiter_fee_pct` allowed up to 1.0; `instantiate` capped at 0.5. | Both use the same 0.5 cap. | `test_l2_*` |
| F-004 | Code comments said the auto-resolve ruling governs "the reward only". The code also splits the worker's claim bond by that ruling. | Comments corrected; behaviour unchanged (it was already documented in the auditor guide). | — |
| F-005 | NftSwap `fill` returned whatever the asset vault held. After an issuer recalled the listed NFT, a buyer could pay for an empty bucket. | `fill` asserts the listed NFT is in the vault before taking any payment, then takes that NFT by id. `list` records whether the asset's recall and burn roles are locked to `deny_all` (`Listing.asset_recallable`, `asset_burnable`, also in `ListedEvent`). Conservation checks the listed id, and runs after `extend_listing` too. | `test_u2c_recall_then_fill_is_refused`, `test_v2_list_records_recall_and_burn_roles` |
| I-1 | `extend_listing` added 30 days per call with no cap. | An extension sets the expiry to `now + 30 days`, the same ceiling `list` enforces, and refuses when that would not move it. | `test_extend_listing_resets_to_the_30_day_ceiling_and_no_further` |

Comments the v1 source got wrong are corrected where they stand, each marked
"CORRECTED in v2" with the v1 wording quoted.

## What v2 does not close

- **An arbiter with a second account.** The ledger cannot tell that two
  accounts share an owner. An arbiter who claims through an account that
  holds no arbiter badge and no claim badge of theirs can still rule for it.
  v2 makes that route take at least the minimum wait and puts the dispute on
  the ledger for that long before any ruling. It remains a trust placed in
  the arbiter.
- **An arbiter who is also the poster** can rule `RefundPoster`. Settlement
  still credits only the accounts pinned at create and claim.
- **NFT payments in a swap.** If a buyer pays with a recallable NFT, its
  issuer could recall it from the proceeds vault before the seller withdraws.
  v2 records the listed asset's roles, not the payment's.

## Values that are not decided here

- `dispute_min_resolve_wait_secs` has no default in the blueprint: it is an
  `instantiate` argument. `DISPUTE_MIN_RESOLVE_WAIT_SECS_PLACEHOLDER`
  (24 hours) is what the tests use. It is a placeholder, not a decision.
- The bound values (1 hour – 90 days for submit deadlines, 1–90 days for the
  auto-resolve window, 0–24 hours for the grace, 1 hour – 7 days for the
  wait) are engineering choices that contain the values used so far.

## Build and test

Same toolchain as the v1 package (Rust 1.92.0, `scrypto` / `scrypto-test`
1.3.1, see `rust-toolchain.toml` and `Cargo.lock`). The ledger-simulator tests
need Linux (CI runs them on `ubuntu-latest`):

```bash
cargo build --locked --release --target wasm32-unknown-unknown
cargo test --locked
```

## Licence

Apache-2.0, as the v1 package (see `LICENSE`).
